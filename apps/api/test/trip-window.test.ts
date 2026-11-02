import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, makeApp, points, registerDevice, registerUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

const send = (token: string, body: unknown) => ctx.http().post('/v1/ingest/batches').set('Authorization', `Bearer ${token}`).send(body as object);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setup(trip: Record<string, unknown> = {}) {
  const u = await registerUser(ctx);
  const d = await registerDevice(ctx, u.token);
  const t = await ctx
    .http()
    .post('/v1/trips')
    .set(auth(u.token))
    .send({ name: 'Reparto', deviceId: d.deviceId, origin: { lon: -58.3816, lat: -34.6037 }, destination: { lon: -58.37, lat: -34.6037 }, ...trip })
    .expect(201);
  return { u, d, tripId: t.body.id as string, trip: t.body };
}

describe('ventana y corte del registro de un viaje', () => {
  it('el viaje se crea con duración máxima y margen por defecto', async () => {
    const { trip } = await setup();
    expect(trip.maxDurationS).toBe(86_400);
    expect(trip.stopGraceS).toBe(600);
    expect(trip.windowEndsAt).toBeNull();
  });

  it('mientras el viaje está en curso la respuesta indica seguir registrando', async () => {
    const { d, tripId } = await setup();
    const s = randomUUID();
    const r = await send(d.deviceToken, batch(s, points(s, 5), { tripId })).expect(200);
    expect(r.body.accepted).toHaveLength(5);
    expect(r.body.tracking).toEqual([{ sessionId: s, tripId, state: 'active', reason: null }]);
  });

  it('pasada la duración máxima indica detenerse y rechaza lo capturado después del corte', async () => {
    const { u, d, tripId } = await setup({ maxDurationS: 600 });
    const s = randomUUID();
    const start = Date.now() - 3600_000;
    // 20 puntos cada 60 s: los primeros 10 min caen dentro de la ventana.
    const pts = points(s, 20, { start, dtS: 60 });
    const r = await send(d.deviceToken, batch(s, pts, { tripId, startedAt: new Date(start).toISOString() })).expect(200);
    const outside = r.body.rejected.filter((x: { code: string }) => x.code === 'OUTSIDE_TRIP_WINDOW');
    expect(r.body.accepted).toHaveLength(11); // de 0 a 600 s inclusive
    expect(outside).toHaveLength(9);
    expect(r.body.tracking).toEqual([{ sessionId: s, tripId, state: 'stop', reason: 'trip_max_duration' }]);
    const t = await ctx.http().get(`/v1/trips/${tripId}`).set(auth(u.token)).expect(200);
    expect(Date.parse(t.body.windowEndsAt)).toBe(start + 600_000);
  });

  it('al completarse respeta el margen y después indica detenerse; acepta puntos atrasados de antes del corte', async () => {
    const { u, d, tripId } = await setup();
    const s = randomUUID();
    const start = Date.now() - 1800_000;
    await send(d.deviceToken, batch(s, points(s, 3, { start }), { tripId, startedAt: new Date(start).toISOString() })).expect(200);
    await ctx.http().patch(`/v1/trips/${tripId}`).set(auth(u.token)).send({ status: 'completed' }).expect(200);

    // Dentro del margen de 10 min: sigue.
    const s2 = await send(d.deviceToken, { ...batch(s, []), client: { activeSessionId: s } }).expect(200);
    expect(s2.body.tracking[0]).toMatchObject({ state: 'active' });

    // Sin margen: se detiene; lo capturado antes del corte se acepta y lo posterior no.
    await ctx.http().patch(`/v1/trips/${tripId}`).set(auth(u.token)).send({ stopGraceS: 0 }).expect(200);
    const late = points(s, 1, { start: start + 60_000, startSeq: 10 });
    const after = points(s, 1, { start: Date.now() + 1000, startSeq: 11 });
    const r = await send(d.deviceToken, batch(s, [...late, ...after], { tripId, startedAt: new Date(start).toISOString() })).expect(200);
    expect(r.body.accepted).toEqual([late[0]!.id]);
    expect(r.body.rejected).toEqual([{ id: after[0]!.id, code: 'OUTSIDE_TRIP_WINDOW' }]);
    expect(r.body.tracking).toEqual([{ sessionId: s, tripId, state: 'stop', reason: 'trip_completed' }]);
  });

  it('un viaje cancelado indica detenerse aunque el lote no traiga puntos', async () => {
    const { u, d, tripId } = await setup();
    const s = randomUUID();
    await send(d.deviceToken, batch(s, points(s, 2), { tripId })).expect(200);
    await ctx.http().patch(`/v1/trips/${tripId}`).set(auth(u.token)).send({ status: 'cancelled' }).expect(200);
    const r = await send(d.deviceToken, { ...batch(s, []), sessions: [], client: { activeSessionId: s } }).expect(200);
    expect(r.body.tracking).toEqual([{ sessionId: s, tripId, state: 'stop', reason: 'trip_cancelled' }]);
  });

  it('las sesiones sin viaje no reciben indicación ni se recortan', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const r = await send(d.deviceToken, batch(s, points(s, 3, { start: Date.now() - 3 * 86_400_000 }))).expect(200);
    expect(r.body.accepted).toHaveLength(3);
    expect(r.body.tracking).toEqual([]);
  });

  it('la sesión activa de otro dispositivo no se informa', async () => {
    const { d, tripId } = await setup();
    const s = randomUUID();
    await send(d.deviceToken, batch(s, points(s, 2), { tripId })).expect(200);
    const u2 = await registerUser(ctx);
    const d2 = await registerDevice(ctx, u2.token);
    const r = await send(d2.deviceToken, { ...batch(randomUUID(), []), sessions: [], client: { activeSessionId: s } }).expect(200);
    expect(r.body.tracking).toEqual([]);
  });
});

describe('estado de la posición y modo flota', () => {
  it('el permiso informado en el lote se refleja en el estado de la posición', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    let dev = await ctx.http().get(`/v1/devices/${d.deviceId}`).set(auth(u.token)).expect(200);
    expect(dev.body.positionState).toBe('no_data');

    const s = randomUUID();
    await send(d.deviceToken, { ...batch(s, points(s, 2)), client: { permission: 'always' } }).expect(200);
    dev = await ctx.http().get(`/v1/devices/${d.deviceId}`).set(auth(u.token)).expect(200);
    expect(dev.body).toMatchObject({ positionState: 'current', permission: 'always' });

    // Lote vacío que solo informa el permiso revocado.
    await send(d.deviceToken, { ...batch(s, []), client: { permission: 'denied' } }).expect(200);
    dev = await ctx.http().get(`/v1/devices/${d.deviceId}`).set(auth(u.token)).expect(200);
    expect(dev.body).toMatchObject({ positionState: 'no_permission', permission: 'denied' });
  });

  it('sin puntos recientes la posición queda "sin señal" (umbral sobre la hora de recepción)', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    await send(d.deviceToken, batch(s, points(s, 1))).expect(200);
    await ctx.db.query(`UPDATE location_points SET received_at = now() - interval '31 minutes' WHERE device_id = $1`, [d.deviceId]);
    const dev = await ctx.http().get(`/v1/devices/${d.deviceId}`).set(auth(u.token)).expect(200);
    expect(dev.body.positionState).toBe('no_signal');
  });

  it('acepta sesiones en modo flota y sirve su configuración aunque la guardada sea anterior', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const body = batch(s, points(s, 2));
    body.sessions[0]!.mode = 'fleet';
    await send(d.deviceToken, body).expect(200);
    const mode = await ctx.db.one<{ mode: string }>('SELECT mode FROM tracking_sessions WHERE id = $1', [s]);
    expect(mode!.mode).toBe('fleet');

    // Configuración guardada antes de existir el modo flota.
    const legacy = (await ctx.http().get(`/v1/orgs/${u.orgId}/tracking-config`).set(auth(u.token)).expect(200)).body.modes;
    delete legacy.fleet;
    await ctx.db.query(`INSERT INTO tracking_configs (org_id, name, params) VALUES ($1, 'default', $2)`, [u.orgId, JSON.stringify(legacy)]);
    const cfg = await ctx.http().get(`/v1/devices/${d.deviceId}/config`).set(auth(d.deviceToken)).expect(200);
    expect(cfg.body.modes.fleet.syncIntervalS).toBe(300);
  });
});
