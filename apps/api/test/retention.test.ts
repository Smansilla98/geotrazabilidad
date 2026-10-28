import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetentionService } from '../src/retention/retention.service.js';
import { batch, makeApp, points, registerDevice, registerUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

describe('retención y eliminación de datos', () => {
  it('borra posiciones más antiguas que la retención de la organización y conserva las recientes', async () => {
    const u = await registerUser(ctx);
    await ctx.http().patch(`/v1/orgs/${u.orgId}`).set('Authorization', `Bearer ${u.token}`).send({ retentionDays: 7 }).expect(200);
    const d = await registerDevice(ctx, u.token);
    const old = randomUUID();
    const recent = randomUUID();
    const oldStart = Date.now() - 10 * 86_400_000;
    await ctx.http().post('/v1/ingest/batches').set('Authorization', `Bearer ${d.deviceToken}`).send(batch(old, points(old, 10, { start: oldStart }), { endedAt: new Date(oldStart + 200_000).toISOString() })).expect(200);
    await ctx.http().post('/v1/ingest/batches').set('Authorization', `Bearer ${d.deviceToken}`).send(batch(recent, points(recent, 10))).expect(200);
    await ctx.processor.drain();

    // Otra organización con retención por defecto (90 días) no se ve afectada.
    const other = await registerUser(ctx);
    const d2 = await registerDevice(ctx, other.token);
    const s2 = randomUUID();
    await ctx.http().post('/v1/ingest/batches').set('Authorization', `Bearer ${d2.deviceToken}`).send(batch(s2, points(s2, 5, { start: oldStart }))).expect(200);

    const result = await ctx.app.get(RetentionService).run();
    expect(result.points).toBeGreaterThanOrEqual(10);
    const left = await ctx.db.query<{ session_id: string }>('SELECT session_id FROM location_points WHERE device_id = $1', [d.deviceId]);
    expect(new Set(left.map((r) => r.session_id))).toEqual(new Set([recent]));
    const oldSession = await ctx.db.one('SELECT id FROM tracking_sessions WHERE id = $1', [old]);
    expect(oldSession).toBeNull();
    const kept = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM location_points WHERE device_id = $1', [d2.deviceId]);
    expect(kept!.n).toBe(5);
  });

  it('la tarea diaria no se ejecuta dos veces dentro de 23 h', async () => {
    const svc = ctx.app.get(RetentionService);
    await ctx.db.query(`DELETE FROM job_runs WHERE job = 'retention'`);
    expect(await svc.runIfDue()).toBe(true);
    expect(await svc.runIfDue()).toBe(false);
  });

  it('la exportación de datos propios incluye consentimientos y posiciones del titular', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    await ctx.http().post('/v1/ingest/batches').set('Authorization', `Bearer ${d.deviceToken}`).send(batch(s, points(s, 4))).expect(200);
    const r = await ctx.http().get('/v1/me/export').set('Authorization', `Bearer ${u.token}`).expect(200);
    const body = JSON.parse(r.text);
    expect(body.user.email).toBe(u.email);
    expect(body.consents).toHaveLength(1);
    expect(body.devices[0].points).toHaveLength(4);
  });
});
