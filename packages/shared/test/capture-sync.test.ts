import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCapture, INITIAL_CAPTURE_STATE, type CaptureFix, type CaptureState } from '../src/capture/strategy.js';
import { DEFAULT_TRACKING_CONFIG } from '../src/contracts/tracking-config.js';
import type { IngestBatchRequest, IngestBatchResponse } from '../src/contracts/api.js';
import { SqliteQueueStore, type SqlDriver } from '../src/sync/queue.js';
import { backoffDelay, SyncEngine, SyncHttpError, type SyncTransport } from '../src/sync/engine.js';
import { offset, ORIGIN } from './helpers.js';

describe('estrategia de captura', () => {
  const normal = DEFAULT_TRACKING_CONFIG.normal;
  const fix = (t: number, east: number, extra: Partial<CaptureFix> = {}): CaptureFix => ({ t, ...offset(ORIGIN, east, 0), accuracy: 10, speed: null, heading: null, ...extra });

  function run(fixes: CaptureFix[], params = normal, ctx = {}) {
    let s: CaptureState = INITIAL_CAPTURE_STATE;
    const kept: string[] = [];
    for (const f of fixes) {
      const d = decideCapture(s, f, params, ctx);
      s = d.state;
      if (d.keep) kept.push(d.reason);
    }
    return { kept, state: s };
  }

  it('en movimiento conserva por distancia, no cada fix', () => {
    const fixes = Array.from({ length: 60 }, (_, i) => fix(i * 1000, i * 10, { speed: 10 }));
    const { kept } = run(fixes);
    // 590 m recorridos con minDistance 40 m → ~15 puntos, no 60.
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(20);
  });

  it('detenido solo emite latidos espaciados', () => {
    const fixes = Array.from({ length: 120 }, (_, i) => fix(i * 30_000, (i % 2) * 3, { speed: 0 })); // 1 h quieto
    const { kept, state } = run(fixes);
    expect(state.motion).toBe('stationary');
    expect(kept.filter((r) => r === 'stationary_heartbeat').length).toBeLessThanOrEqual(4);
    expect(kept.length).toBeLessThan(8);
  });

  it('descarta fixes imprecisos salvo como latido', () => {
    const fixes = [fix(0, 0), ...Array.from({ length: 10 }, (_, i) => fix((i + 1) * 10_000, 0, { accuracy: 500 }))];
    const { kept } = run(fixes);
    expect(kept).toEqual(['first']);
    const later = run([fix(0, 0), fix(normal.stationaryIntervalS * 1000 + 1, 0, { accuracy: 500 })]);
    expect(later.kept).toEqual(['first', 'low_accuracy_heartbeat']);
  });

  it('ignora fixes repetidos o con hora anterior', () => {
    const { kept } = run([fix(10_000, 0), fix(10_000, 100), fix(5_000, 200)]);
    expect(kept).toEqual(['first']);
  });

  it('con batería baja espacia más los puntos', () => {
    const fixes = Array.from({ length: 60 }, (_, i) => fix(i * 1000, i * 10, { speed: 10 }));
    const lowBat = run(fixes, normal, { batteryLevel: 0.05, charging: false });
    const charging = run(fixes, normal, { batteryLevel: 0.05, charging: true });
    expect(lowBat.kept.length).toBeLessThan(charging.kept.length);
  });
});

// ── Cola persistente + sincronización contra SQLite real (node:sqlite) ──
function nodeSqlite(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  return {
    exec: async (sql) => void db.exec(sql),
    run: async (sql, params = []) => void db.prepare(sql).run(...(params as never[])),
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    transaction: async (fn) => {
      db.exec('BEGIN');
      try {
        const r = await fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** Servidor simulado con la misma semántica de idempotencia que la API. */
class FakeServer implements SyncTransport {
  stored = new Map<string, IngestBatchRequest['points'][number]>();
  sessions = new Map<string, IngestBatchRequest['sessions'][number]>();
  calls = 0;
  failNext: Array<'network' | 500 | 401 | 400> = [];
  /** Simula que el servidor guardó el lote pero la respuesta se perdió. */
  dropResponseNext = false;
  rejectLat = 999;

  async sendBatch(req: IngestBatchRequest): Promise<IngestBatchResponse> {
    this.calls++;
    const f = this.failNext.shift();
    if (f === 'network') throw new TypeError('Network request failed');
    if (typeof f === 'number') throw new SyncHttpError(f, f === 401 ? 'UNAUTHORIZED' : null);
    if (req.points.some((p) => p.lat === -999)) throw new SyncHttpError(400, 'VALIDATION');
    req.sessions.forEach((s) => this.sessions.set(s.id, s));
    const accepted: string[] = [];
    const duplicates: string[] = [];
    const rejected: Array<{ id: string; code: 'LAT_OUT_OF_RANGE' }> = [];
    for (const p of req.points) {
      if (Math.abs(p.lat) > 90) rejected.push({ id: p.id, code: 'LAT_OUT_OF_RANGE' });
      else if (this.stored.has(p.id)) duplicates.push(p.id);
      else {
        this.stored.set(p.id, p);
        accepted.push(p.id);
      }
    }
    if (this.dropResponseNext) {
      this.dropResponseNext = false;
      throw new TypeError('timeout');
    }
    return { batchId: req.batchId, serverTime: new Date().toISOString(), accepted, duplicates, rejected, config: { version: 1, changed: false } };
  }
}

async function setup(path = join(mkdtempSync(join(tmpdir(), 'geoq-')), 'q.db')) {
  const store = new SqliteQueueStore(nodeSqlite(path));
  await store.migrate();
  return { store, path };
}

async function fill(store: SqliteQueueStore, sessionId: string, n: number, start = Date.UTC(2026, 9, 27)) {
  for (let i = 0; i < n; i++) {
    const p = offset(ORIGIN, i * 20, 0);
    await store.enqueuePoint({
      id: randomUUID(), sessionId, capturedAt: start + i * 10_000, ...p,
      accuracy: 8, altitude: null, altitudeAccuracy: null, speed: 2, heading: 90, source: 'gps', mocked: false, battery: 0.8,
    });
  }
}

describe('cola persistente y sincronización', () => {
  it('asigna seq monotónico por sesión', async () => {
    const { store } = await setup();
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 5);
    const b = await store.pendingBatch(10);
    expect(b.points.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('sin conexión no pierde nada y al volver sincroniza todo sin duplicados', async () => {
    const { store } = await setup();
    const server = new FakeServer();
    const engine = new SyncEngine(store, server, { uuid: randomUUID, batchSize: 100 });
    await store.startSession({ id: 's1', startedAt: 0, mode: 'trip', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 450);
    server.failNext = ['network', 'network', 500];
    for (let i = 0; i < 3; i++) expect((await engine.syncOnce()).kind).toBe('retry');
    expect((await store.stats()).pending).toBe(450);
    const r = await engine.drain();
    expect(r.kind).toBe('sent');
    expect((await store.stats()).pending).toBe(0);
    expect(server.stored.size).toBe(450);
  });

  it('si se pierde la respuesta, el reenvío se confirma como duplicado (idempotencia)', async () => {
    const { store } = await setup();
    const server = new FakeServer();
    const engine = new SyncEngine(store, server, { uuid: randomUUID, batchSize: 50 });
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 50);
    server.dropResponseNext = true;
    expect((await engine.syncOnce()).kind).toBe('retry');
    const r = await engine.syncOnce();
    expect(r).toMatchObject({ kind: 'sent', accepted: 0, duplicates: 50 });
    expect(server.stored.size).toBe(50);
  });

  it('se recupera tras reiniciar la app con la cola a medio enviar', async () => {
    const { store, path } = await setup();
    const server = new FakeServer();
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 300);
    await new SyncEngine(store, server, { uuid: randomUUID, batchSize: 100 }).syncOnce();
    // "Reinicio": nueva instancia sobre el mismo archivo.
    const { store: reopened } = await setup(path);
    expect((await reopened.stats()).pending).toBe(200);
    await reopened.enqueuePoint({ id: randomUUID(), sessionId: 's1', capturedAt: Date.now(), lat: 0, lon: 0, accuracy: 5, altitude: null, altitudeAccuracy: null, speed: null, heading: null, source: 'gps', mocked: null, battery: null });
    const b = await reopened.pendingBatch(500);
    expect(Math.max(...b.points.map((p) => p.seq))).toBe(300);
    await new SyncEngine(reopened, server, { uuid: randomUUID }).drain();
    expect(server.stored.size).toBe(301);
  });

  it('los rechazos de validación no se reintentan', async () => {
    const { store } = await setup();
    const server = new FakeServer();
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await store.enqueuePoint({ id: randomUUID(), sessionId: 's1', capturedAt: 1, lat: 95, lon: 0, accuracy: 5, altitude: null, altitudeAccuracy: null, speed: null, heading: null, source: 'gps', mocked: null, battery: null });
    await fill(store, 's1', 3);
    const r = await new SyncEngine(store, server, { uuid: randomUUID }).drain();
    expect(r).toMatchObject({ kind: 'sent', accepted: 3, rejected: 1 });
    expect(await store.stats()).toMatchObject({ pending: 0, rejected: 1, acked: 3 });
  });

  it('un registro que invalida el lote entero se aísla y no bloquea la cola', async () => {
    const { store } = await setup();
    const server = new FakeServer();
    const engine = new SyncEngine(store, server, { uuid: randomUUID, batchSize: 8 });
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 4);
    await store.enqueuePoint({ id: randomUUID(), sessionId: 's1', capturedAt: Date.UTC(2026, 9, 27) + 1, lat: -999, lon: 0, accuracy: 5, altitude: null, altitudeAccuracy: null, speed: null, heading: null, source: 'gps', mocked: null, battery: null });
    for (let i = 0; i < 20; i++) {
      const r = await engine.syncOnce();
      if (r.kind === 'idle') break;
    }
    expect(await store.stats()).toMatchObject({ pending: 0, rejected: 1, acked: 4 });
  });

  it('401 detiene la sincronización sin perder datos', async () => {
    const { store } = await setup();
    const server = new FakeServer();
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 3);
    server.failNext = [401];
    const r = await new SyncEngine(store, server, { uuid: randomUUID }).syncOnce();
    expect(r).toMatchObject({ kind: 'blocked', reason: 'auth' });
    expect((await store.stats()).pending).toBe(3);
  });

  it('el cierre de sesión se reenvía aunque no haya puntos nuevos', async () => {
    const { store } = await setup();
    const server = new FakeServer();
    const engine = new SyncEngine(store, server, { uuid: randomUUID });
    await store.startSession({ id: 's1', startedAt: 0, mode: 'normal', tripId: null, configSnapshot: {} });
    await fill(store, 's1', 2);
    await engine.drain();
    await store.endSession('s1', Date.now(), 'user');
    await engine.drain();
    expect(server.sessions.get('s1')!.endReason).toBe('user');
    expect((await engine.syncOnce()).kind).toBe('idle');
  });

  it('backoff exponencial con jitter y tope', () => {
    expect(backoffDelay(0, 2000, 900_000, () => 0)).toBe(1000);
    expect(backoffDelay(3, 2000, 900_000, () => 1)).toBe(16_000);
    expect(backoffDelay(30, 2000, 900_000, () => 1)).toBe(900_000);
  });
});
