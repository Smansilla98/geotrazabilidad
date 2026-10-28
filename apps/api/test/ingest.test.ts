import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, makeApp, points, registerDevice, registerUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

const send = (token: string, body: unknown) => ctx.http().post('/v1/ingest/batches').set('Authorization', `Bearer ${token}`).send(body as object);

describe('ingesta de posiciones', () => {
  it('sin consentimiento vigente rechaza la ingesta', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token, { consent: false });
    const s = randomUUID();
    const r = await send(d.deviceToken, batch(s, points(s, 3))).expect(403);
    expect(r.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('acepta un lote y el reenvío no duplica (idempotencia)', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const body = batch(s, points(s, 50));
    const r1 = await send(d.deviceToken, body).expect(200);
    expect(r1.body.accepted).toHaveLength(50);
    expect(r1.body.duplicates).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      const r = await send(d.deviceToken, { ...body, batchId: randomUUID() }).expect(200);
      expect(r.body.accepted).toHaveLength(0);
      expect(r.body.duplicates).toHaveLength(50);
    }
    const n = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM location_points WHERE device_id = $1', [d.deviceId]);
    expect(n!.n).toBe(50);
  });

  it('conserva la hora de captura y registra la de recepción por separado', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const captured = Date.now() - 6 * 3600_000; // capturado offline hace 6 h
    await send(d.deviceToken, batch(s, points(s, 1, { start: captured }))).expect(200);
    const p = await ctx.db.one<{ captured_at: Date; received_at: Date }>('SELECT captured_at, received_at FROM location_points WHERE device_id = $1', [d.deviceId]);
    expect(p!.captured_at.getTime()).toBe(captured);
    expect(Date.now() - p!.received_at.getTime()).toBeLessThan(60_000);
  });

  it('rechaza por punto: rangos, sesión desconocida, futuro y antes del inicio', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const pts = points(s, 6);
    pts[0]!.lat = 91;
    pts[1]!.lon = -181;
    pts[2]!.sessionId = randomUUID();
    pts[3]!.capturedAt = new Date(Date.now() + 3600_000).toISOString();
    pts[4]!.capturedAt = new Date(Date.parse(pts[5]!.capturedAt) - 3 * 3600_000).toISOString();
    const r = await send(d.deviceToken, batch(s, pts, { startedAt: new Date(Date.parse(pts[5]!.capturedAt) - 3600_000).toISOString() })).expect(200);
    const codes = Object.fromEntries(r.body.rejected.map((x: { id: string; code: string }) => [x.id, x.code]));
    expect(codes[pts[0]!.id]).toBe('LAT_OUT_OF_RANGE');
    expect(codes[pts[1]!.id]).toBe('LON_OUT_OF_RANGE');
    expect(codes[pts[2]!.id]).toBe('UNKNOWN_SESSION');
    expect(codes[pts[3]!.id]).toBe('TOO_FAR_IN_FUTURE');
    expect(codes[pts[4]!.id]).toBe('BEFORE_SESSION_START');
    expect(r.body.accepted).toEqual([pts[5]!.id]);
  });

  it('acepta con marca future_ts si el desfase de reloj del dispositivo lo explica', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const ahead = 20 * 60_000; // reloj del teléfono 20 min adelantado
    const pts = points(s, 1, { start: Date.now() + ahead });
    const body = { ...batch(s, pts), sentAt: new Date(Date.now() + ahead).toISOString() };
    const r = await send(d.deviceToken, body).expect(200);
    expect(r.body.accepted).toHaveLength(1);
    const p = await ctx.db.one<{ quality_flags: string[] }>('SELECT quality_flags FROM location_points WHERE device_id = $1', [d.deviceId]);
    expect(p!.quality_flags).toContain('future_ts');
  });

  it('no permite escribir en sesiones de otro dispositivo', async () => {
    const u = await registerUser(ctx);
    const d1 = await registerDevice(ctx, u.token);
    const d2 = await registerDevice(ctx, u.token);
    const s = randomUUID();
    await send(d1.deviceToken, batch(s, points(s, 2))).expect(200);
    const r = await send(d2.deviceToken, { ...batch(s, points(s, 2, { startSeq: 10 })) }).expect(200);
    expect(r.body.rejected.every((x: { code: string }) => x.code === 'SESSION_OF_OTHER_DEVICE')).toBe(true);
  });

  it('limita el tamaño del lote y del cuerpo', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const r = await send(d.deviceToken, batch(s, points(s, 501))).expect(413);
    expect(r.body.error.code).toBe('BATCH_TOO_LARGE');
    const huge = { ...batch(s, points(s, 1)), padding: 'x'.repeat(1_100_000) };
    await send(d.deviceToken, huge).expect(413);
  });

  it('separa tokens de usuario y de dispositivo', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    await send(u.token, batch(s, points(s, 1))).expect(403);
    await ctx.http().get('/v1/devices').set('Authorization', `Bearer ${d.deviceToken}`).expect(403);
  });

  it('un dispositivo revocado no puede enviar ni renovar su token', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    await ctx.http().post(`/v1/devices/${d.deviceId}/revoke`).set('Authorization', `Bearer ${u.token}`).expect(200);
    const s = randomUUID();
    const r = await send(d.deviceToken, batch(s, points(s, 1))).expect(403);
    expect(r.body.error.code).toBe('DEVICE_REVOKED');
    await ctx.http().post('/v1/devices/token/refresh').send({ deviceId: d.deviceId, refreshToken: d.refresh }).expect(401);
  });

  it('actualiza el estado de sincronización y marca reprocesamiento', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const body = batch(s, points(s, 5));
    body.client.pendingCount = 25;
    await send(d.deviceToken, body).expect(200);
    const sync = await ctx.db.one<{ client_pending_count: number; last_point_received_at: Date }>('SELECT * FROM device_sync_state WHERE device_id = $1', [d.deviceId]);
    expect(sync!.client_pending_count).toBe(20);
    expect(sync!.last_point_received_at).toBeTruthy();
    const ps = await ctx.db.one<{ reprocess_from: Date }>('SELECT reprocess_from FROM device_processing_state WHERE device_id = $1', [d.deviceId]);
    expect(ps!.reprocess_from.toISOString()).toBe(body.points[0]!.capturedAt);
    const list = await ctx.http().get('/v1/devices').set('Authorization', `Bearer ${u.token}`).expect(200);
    expect(list.body[0].connectionState).toBe('online');
    expect(list.body[0].sync.clientPendingCount).toBe(20);
  });

  it('el dispositivo obtiene su configuración de captura y envía latidos', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const cfg = await ctx.http().get(`/v1/devices/${d.deviceId}/config`).set('Authorization', `Bearer ${d.deviceToken}`).expect(200);
    expect(Object.keys(cfg.body.modes).sort()).toEqual(['battery_saver', 'intensive', 'normal', 'trip']);
    const hb = await ctx
      .http()
      .post(`/v1/devices/${d.deviceId}/heartbeat`)
      .set('Authorization', `Bearer ${d.deviceToken}`)
      .send({ pendingCount: 3, permission: 'always', trackingActive: true, batteryLevel: 0.5 })
      .expect(200);
    expect(hb.body.consentActive).toBe(true);
    const r = await ctx.http().post('/v1/devices/token/refresh').send({ deviceId: d.deviceId, refreshToken: d.refresh }).expect(200);
    expect(r.body.deviceToken).toBeTruthy();
  });
});
