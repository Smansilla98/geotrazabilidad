import type { IngestPoint, IngestSession, RejectCode } from '../contracts/api.js';
import type { LocationSource, TrackingMode } from '../contracts/common.js';

/**
 * Driver SQL mínimo. La app usa expo-sqlite; las pruebas y el simulador usan node:sqlite.
 * Así el SQL de la cola se ejecuta y prueba contra SQLite real.
 */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface NewPoint {
  id: string;
  sessionId: string;
  capturedAt: number;
  lat: number;
  lon: number;
  accuracy: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  speed: number | null;
  heading: number | null;
  source: LocationSource;
  mocked: boolean | null;
  battery: number | null;
}

export interface NewSession {
  id: string;
  startedAt: number;
  mode: TrackingMode;
  tripId: string | null;
  configSnapshot: Record<string, unknown>;
}

export interface PendingBatch {
  sessions: IngestSession[];
  points: IngestPoint[];
  /** version de cada sesión incluida, para marcarla limpia solo si no cambió durante el envío. */
  sessionVersions: Record<string, number>;
}

export interface QueueStats {
  pending: number;
  acked: number;
  rejected: number;
  oldestPendingAt: number | null;
  lastAckAt: number | null;
}

export interface QueueStore {
  pendingBatch(limit: number): Promise<PendingBatch>;
  markAcked(pointIds: string[], sessionVersions: Record<string, number>, at: number): Promise<void>;
  markRejected(items: Array<{ id: string; code: RejectCode | string }>): Promise<void>;
  recordAttempt(pointIds: string[]): Promise<void>;
  stats(): Promise<QueueStats>;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS q_sessions (
     id TEXT PRIMARY KEY,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     end_reason TEXT,
     mode TEXT NOT NULL,
     trip_id TEXT,
     config_snapshot TEXT NOT NULL,
     next_seq INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL DEFAULT 1,
     synced_version INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS q_points (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES q_sessions(id),
     seq INTEGER NOT NULL,
     captured_at INTEGER NOT NULL,
     lat REAL NOT NULL, lon REAL NOT NULL,
     accuracy REAL, altitude REAL, altitude_accuracy REAL, speed REAL, heading REAL,
     source TEXT NOT NULL, mocked INTEGER, battery REAL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     reject_code TEXT,
     acked_at INTEGER,
     UNIQUE (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS q_points_status_time ON q_points (status, captured_at)`,
  `CREATE TABLE IF NOT EXISTS q_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const nz = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? null : v);

export class SqliteQueueStore implements QueueStore {
  constructor(private readonly db: SqlDriver) {}

  async migrate(): Promise<void> {
    for (const m of MIGRATIONS) await this.db.exec(m);
  }

  async startSession(s: NewSession): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO q_sessions (id, started_at, mode, trip_id, config_snapshot) VALUES (?, ?, ?, ?, ?)`,
      [s.id, s.startedAt, s.mode, s.tripId, JSON.stringify(s.configSnapshot)],
    );
  }

  async endSession(id: string, endedAt: number, reason: string): Promise<void> {
    await this.db.run(`UPDATE q_sessions SET ended_at = ?, end_reason = ?, version = version + 1 WHERE id = ? AND ended_at IS NULL`, [endedAt, reason, id]);
  }

  async openSession(): Promise<{ id: string; startedAt: number; mode: TrackingMode; tripId: string | null } | null> {
    const rows = await this.db.all<{ id: string; started_at: number; mode: TrackingMode; trip_id: string | null }>(
      `SELECT id, started_at, mode, trip_id FROM q_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    );
    const r = rows[0];
    return r ? { id: r.id, startedAt: r.started_at, mode: r.mode, tripId: r.trip_id } : null;
  }

  /** Inserta un punto asignando seq monotónico por sesión (sobrevive a purgas y reinicios). */
  async enqueuePoint(p: NewPoint): Promise<number> {
    return this.db.transaction(async () => {
      const rows = await this.db.all<{ next_seq: number }>(`SELECT next_seq FROM q_sessions WHERE id = ?`, [p.sessionId]);
      if (!rows[0]) throw new Error(`Sesión local inexistente: ${p.sessionId}`);
      const seq = rows[0].next_seq;
      await this.db.run(
        `INSERT INTO q_points (id, session_id, seq, captured_at, lat, lon, accuracy, altitude, altitude_accuracy, speed, heading, source, mocked, battery)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id, p.sessionId, seq, p.capturedAt, p.lat, p.lon,
          nz(p.accuracy), nz(p.altitude), nz(p.altitudeAccuracy), nz(p.speed), nz(p.heading),
          p.source, p.mocked == null ? null : p.mocked ? 1 : 0, nz(p.battery),
        ],
      );
      await this.db.run(`UPDATE q_sessions SET next_seq = next_seq + 1 WHERE id = ?`, [p.sessionId]);
      return seq;
    });
  }

  async pendingBatch(limit: number): Promise<PendingBatch> {
    const pts = await this.db.all<Record<string, number | string | null>>(
      `SELECT * FROM q_points WHERE status = 'pending' ORDER BY captured_at, session_id, seq LIMIT ?`,
      [limit],
    );
    const sessionIds = new Set(pts.map((r) => r.session_id as string));
    const dirty = await this.db.all<{ id: string }>(`SELECT id FROM q_sessions WHERE version > synced_version LIMIT 50`);
    dirty.forEach((d) => sessionIds.add(d.id));
    const ids = [...sessionIds].slice(0, 50);
    const sessions = ids.length
      ? await this.db.all<Record<string, number | string | null>>(`SELECT * FROM q_sessions WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
      : [];
    const allowed = new Set(sessions.map((s) => s.id as string));
    return {
      sessions: sessions.map((s) => ({
        id: s.id as string,
        startedAt: new Date(s.started_at as number).toISOString(),
        endedAt: s.ended_at == null ? null : new Date(s.ended_at as number).toISOString(),
        endReason: (s.end_reason as string | null) ?? null,
        mode: s.mode as TrackingMode,
        tripId: (s.trip_id as string | null) ?? null,
        configSnapshot: JSON.parse(s.config_snapshot as string) as Record<string, unknown>,
      })),
      sessionVersions: Object.fromEntries(sessions.map((s) => [s.id as string, s.version as number])),
      points: pts
        .filter((r) => allowed.has(r.session_id as string))
        .map((r) => ({
          id: r.id as string,
          sessionId: r.session_id as string,
          seq: r.seq as number,
          capturedAt: new Date(r.captured_at as number).toISOString(),
          lat: r.lat as number,
          lon: r.lon as number,
          accuracy: r.accuracy as number | null,
          altitude: r.altitude as number | null,
          altitudeAccuracy: r.altitude_accuracy as number | null,
          speed: r.speed as number | null,
          heading: r.heading as number | null,
          source: r.source as LocationSource,
          mocked: r.mocked == null ? null : r.mocked === 1,
          battery: r.battery as number | null,
        })),
    };
  }

  async markAcked(pointIds: string[], sessionVersions: Record<string, number>, at: number): Promise<void> {
    await this.db.transaction(async () => {
      for (const chunk of chunks(pointIds, 200)) {
        await this.db.run(`UPDATE q_points SET status = 'acked', acked_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [at, ...chunk]);
      }
      for (const [id, version] of Object.entries(sessionVersions)) {
        await this.db.run(`UPDATE q_sessions SET synced_version = ? WHERE id = ? AND version = ?`, [version, id, version]);
      }
    });
  }

  async markRejected(items: Array<{ id: string; code: string }>): Promise<void> {
    await this.db.transaction(async () => {
      for (const it of items) await this.db.run(`UPDATE q_points SET status = 'rejected', reject_code = ? WHERE id = ?`, [it.code, it.id]);
    });
  }

  async recordAttempt(pointIds: string[]): Promise<void> {
    for (const chunk of chunks(pointIds, 200)) {
      await this.db.run(`UPDATE q_points SET attempts = attempts + 1 WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    }
  }

  async stats(): Promise<QueueStats> {
    const rows = await this.db.all<{ status: string; n: number; oldest: number | null; last_ack: number | null }>(
      `SELECT status, COUNT(*) AS n, MIN(captured_at) AS oldest, MAX(acked_at) AS last_ack FROM q_points GROUP BY status`,
    );
    const by = (s: string) => rows.find((r) => r.status === s);
    return {
      pending: by('pending')?.n ?? 0,
      acked: by('acked')?.n ?? 0,
      rejected: by('rejected')?.n ?? 0,
      oldestPendingAt: by('pending')?.oldest ?? null,
      lastAckAt: by('acked')?.last_ack ?? null,
    };
  }

  /** Purga puntos confirmados por el servidor después de `keepMs` (la copia local deja de ser necesaria). */
  async purgeAcked(olderThan: number): Promise<void> {
    await this.db.run(`DELETE FROM q_points WHERE status = 'acked' AND acked_at < ?`, [olderThan]);
  }

  async recentPoints(sessionId: string, limit: number): Promise<Array<{ lat: number; lon: number; t: number; accuracy: number | null; status: string }>> {
    const rows = await this.db.all<{ lat: number; lon: number; captured_at: number; accuracy: number | null; status: string }>(
      `SELECT lat, lon, captured_at, accuracy, status FROM q_points WHERE session_id = ? ORDER BY captured_at DESC LIMIT ?`,
      [sessionId, limit],
    );
    return rows.reverse().map((r) => ({ lat: r.lat, lon: r.lon, t: r.captured_at, accuracy: r.accuracy, status: r.status }));
  }

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.db.all<{ value: string }>(`SELECT value FROM q_meta WHERE key = ?`, [key]);
    return rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run(`INSERT INTO q_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  }
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
