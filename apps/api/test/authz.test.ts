import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, makeApp, points, registerDevice, registerUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const range = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

async function deviceWithData(token: string, opts: { share?: boolean; orgId?: string } = {}) {
  const d = await registerDevice(ctx, token, opts);
  const s = randomUUID();
  await ctx.http().post('/v1/ingest/batches').set(auth(d.deviceToken)).send(batch(s, points(s, 20))).expect(200);
  await ctx.processor.drain();
  return d;
}

describe('autorización entre usuarios', () => {
  it('un usuario ajeno recibe 404 en todo dato del dispositivo (no puede manipular ids)', async () => {
    const a = await registerUser(ctx, 'A');
    const b = await registerUser(ctx, 'B');
    const d = await deviceWithData(a.token);
    const r = range();
    const q = new URLSearchParams(r).toString();
    await ctx.http().get(`/v1/devices/${d.deviceId}`).set(auth(b.token)).expect(404);
    await ctx.http().get(`/v1/devices/${d.deviceId}/track?${q}`).set(auth(b.token)).expect(404);
    await ctx.http().get(`/v1/devices/${d.deviceId}/points?${q}`).set(auth(b.token)).expect(404);
    await ctx.http().get(`/v1/devices/${d.deviceId}/sessions`).set(auth(b.token)).expect(404);
    await ctx.http().get(`/v1/events?deviceId=${d.deviceId}`).set(auth(b.token)).expect(404);
    await ctx.http().get(`/v1/exports/track?deviceId=${d.deviceId}&format=csv&${q}`).set(auth(b.token)).expect(404);
    await ctx.http().post(`/v1/devices/${d.deviceId}/revoke`).set(auth(b.token)).expect(404);
    await ctx.http().delete(`/v1/devices/${d.deviceId}`).set(auth(b.token)).expect(404);
    const list = await ctx.http().get('/v1/devices').set(auth(b.token)).expect(200);
    expect(list.body).toHaveLength(0);
    const evs = await ctx.http().get('/v1/events').set(auth(b.token)).expect(200);
    expect(evs.body.items).toHaveLength(0);
    const stats = await ctx.http().get('/v1/stats/overview').set(auth(b.token)).expect(200);
    expect(stats.body.devices.total).toBe(0);
    // Un evento ajeno por id directo también es 404.
    const ev = await ctx.db.one<{ id: string }>('SELECT id FROM tracking_events WHERE device_id = $1 LIMIT 1', [d.deviceId]);
    if (ev) await ctx.http().get(`/v1/events/${ev.id}`).set(auth(b.token)).expect(404);
  });

  it('un viewer de la organización solo ve el dispositivo si el titular lo compartió', async () => {
    const owner = await registerUser(ctx, 'Owner');
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`/v1/orgs/${owner.orgId}/members`).set(auth(owner.token)).send({ email: viewer.email, role: 'viewer' }).expect(201);
    const priv = await deviceWithData(owner.token, { share: false });
    const shared = await deviceWithData(owner.token, { share: true });
    const list = await ctx.http().get('/v1/devices').set(auth(viewer.token)).expect(200);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([shared.deviceId]);
    const q = new URLSearchParams(range()).toString();
    await ctx.http().get(`/v1/devices/${priv.deviceId}/track?${q}`).set(auth(viewer.token)).expect(404);
    const t = await ctx.http().get(`/v1/devices/${shared.deviceId}/track?${q}`).set(auth(viewer.token)).expect(200);
    expect(t.body.stats.observedPoints).toBe(20);
    // El viewer no puede administrar ni revocar.
    await ctx.http().post(`/v1/devices/${shared.deviceId}/revoke`).set(auth(viewer.token)).expect(403);
    await ctx.http().post('/v1/trips').set(auth(viewer.token)).send({ orgId: owner.orgId, name: 'x', origin: { lon: 0, lat: 0 }, destination: { lon: 0.1, lat: 0 } }).expect(403);
    // Revocar el consentimiento compartido oculta el historial al viewer.
    await ctx.http().delete(`/v1/devices/${shared.deviceId}/consent`).set(auth(owner.token)).expect(204);
    await ctx.http().get(`/v1/devices/${shared.deviceId}/track?${q}`).set(auth(viewer.token)).expect(404);
  });

  it('solo el titular otorga el consentimiento, aunque un admin administre el dispositivo', async () => {
    const owner = await registerUser(ctx, 'Owner');
    const member = await registerUser(ctx, 'Empleado');
    await ctx.http().post(`/v1/orgs/${owner.orgId}/members`).set(auth(owner.token)).send({ email: member.email, role: 'viewer' }).expect(201);
    const d = await registerDevice(ctx, member.token, { orgId: owner.orgId, consent: false });
    const r = await ctx.http().post(`/v1/devices/${d.deviceId}/consent`).set(auth(owner.token)).send({ consentVersion: 'x', shareWithOrg: true });
    expect(r.status).toBe(404); // sin consentimiento compartido el owner ni siquiera lo ve
    await ctx.http().post(`/v1/devices/${d.deviceId}/consent`).set(auth(member.token)).send({ consentVersion: 'x', shareWithOrg: true }).expect(200);
    await ctx.http().post(`/v1/devices/${d.deviceId}/consent`).set(auth(owner.token)).send({ consentVersion: 'x', shareWithOrg: false }).expect(403);
    await ctx.http().post(`/v1/devices/${d.deviceId}/revoke`).set(auth(owner.token)).expect(200);
  });

  it('no se puede dejar una organización sin owner', async () => {
    const owner = await registerUser(ctx);
    const r = await ctx.http().patch(`/v1/orgs/${owner.orgId}/members/${owner.userId}`).set(auth(owner.token)).send({ role: 'viewer' }).expect(409);
    expect(r.body.error.code).toBe('LAST_OWNER');
  });

  it('el borrado de un dispositivo elimina su historial y queda auditado', async () => {
    const a = await registerUser(ctx);
    const d = await deviceWithData(a.token);
    await ctx.http().delete(`/v1/devices/${d.deviceId}`).set(auth(a.token)).expect(204);
    const n = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM location_points WHERE device_id = $1', [d.deviceId]);
    expect(n!.n).toBe(0);
    const audit = await ctx.db.one<{ metadata: { deletedPoints: number } }>(`SELECT metadata FROM audit_log WHERE action = 'device.delete' AND target_id = $1`, [d.deviceId]);
    expect(audit!.metadata.deletedPoints).toBe(20);
  });
});
