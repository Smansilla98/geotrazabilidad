import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, makeApp, points, registerDevice, registerUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function events(deviceId: string, status = 'active') {
  return ctx.db.query<{ type: string; confidence: string; dedup_key: string; status: string }>(
    'SELECT type, confidence, dedup_key, status FROM tracking_events WHERE device_id = $1 AND status = $2 ORDER BY occurred_at',
    [deviceId, status],
  );
}

describe('procesamiento de eventos en el servidor', () => {
  it('detecta movimiento y detención, y reprocesar no duplica', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const start = Date.now() - 2 * 3600_000;
    const moving = points(s, 20, { start, dtS: 10, stepM: 100 });
    const lastLon = moving.at(-1)!.lon;
    const stopped = points(s, 15, { start: start + 20 * 10_000, dtS: 60, stepM: 0, startSeq: 20, lon: lastLon });
    const resumed = points(s, 10, { start: start + 20 * 10_000 + 15 * 60_000, dtS: 10, stepM: 100, startSeq: 35, lon: lastLon });
    await ctx.http().post('/v1/ingest/batches').set(auth(d.deviceToken)).send(batch(s, [...moving, ...stopped, ...resumed], { endedAt: new Date(start + 3600_000).toISOString() })).expect(200);
    await ctx.processor.drain();
    const evs = await events(d.deviceId);
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(['movement_started', 'stop', 'movement_resumed']));
    expect(evs.filter((e) => e.type === 'stop')).toHaveLength(1);
    // Forzar reproceso completo: mismos eventos, sin duplicados ni superseded.
    await ctx.db.query(`UPDATE device_processing_state SET reprocess_from = '1970-01-01', pending_version = pending_version + 1 WHERE device_id = $1`, [d.deviceId]);
    await ctx.processor.drain();
    const again = await events(d.deviceId);
    expect(again.map((e) => e.dedup_key)).toEqual(evs.map((e) => e.dedup_key));
    expect(await events(d.deviceId, 'superseded')).toHaveLength(0);
  });

  it('puntos atrasados que rellenan un hueco reemplazan el evento signal_gap', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const all = points(s, 80, { start: Date.now() - 3 * 3600_000, dtS: 10, stepM: 100 });
    const early = all.filter((_, i) => i < 10 || i > 70);
    const late = all.filter((_, i) => i >= 10 && i <= 70);
    await ctx.http().post('/v1/ingest/batches').set(auth(d.deviceToken)).send(batch(s, early)).expect(200);
    await ctx.processor.drain();
    expect((await events(d.deviceId)).map((e) => e.type)).toContain('signal_gap');
    // Llegan después (p. ej. el teléfono estaba sin conexión): se recalcula desde el punto más antiguo.
    await ctx.http().post('/v1/ingest/batches').set(auth(d.deviceToken)).send(batch(s, late)).expect(200);
    await ctx.processor.drain();
    expect((await events(d.deviceId)).map((e) => e.type)).not.toContain('signal_gap');
    const superseded = await events(d.deviceId, 'superseded');
    expect(superseded.map((e) => e.type)).toEqual(expect.arrayContaining(['signal_gap', 'capture_resumed']));
  });

  it('evalúa geocercas configuradas con permanencia', async () => {
    const u = await registerUser(ctx);
    const d = await registerDevice(ctx, u.token);
    const s = randomUUID();
    const start = Date.now() - 2 * 3600_000;
    const approach = points(s, 30, { start, dtS: 10, stepM: 20 }); // 600 m al este
    const destLon = approach.at(-1)!.lon;
    const stay = points(s, 10, { start: start + 300_000, dtS: 30, stepM: 0, startSeq: 30, lon: destLon });
    await ctx.http().post('/v1/ingest/batches').set(auth(d.deviceToken)).send(batch(s, [...approach, ...stay])).expect(200);
    await ctx
      .http()
      .post('/v1/geofences')
      .set(auth(u.token))
      .send({ name: 'Depósito', kind: 'depot', shape: 'circle', center: { lon: destLon, lat: -34.6037 }, radiusM: 80 })
      .expect(201);
    await ctx.processor.drain();
    const evs = await ctx.db.query<{ type: string; geofence_id: string; evidence: { pointCount: number } }>(
      `SELECT type, geofence_id, evidence FROM tracking_events WHERE device_id = $1 AND type::text LIKE 'geofence%' AND status = 'active'`,
      [d.deviceId],
    );
    expect(evs.map((e) => e.type)).toEqual(['geofence_enter']);
    expect(evs[0]!.evidence.pointCount).toBeGreaterThanOrEqual(2);
  });
});
