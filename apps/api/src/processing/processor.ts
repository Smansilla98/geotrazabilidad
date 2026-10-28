import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_RULE_PARAMS,
  DEFAULT_TRACKING_CONFIG,
  evaluateSession,
  TrackingConfigParams,
  type DerivedEvent,
  type GeofenceDef,
  type ObservedPoint,
  type SessionTiming,
  type TrackingMode,
  type TripDef,
} from '@geo/shared';
import type pg from 'pg';
import { ENV } from '../auth/tokens.js';
import type { Env } from '../config/env.js';
import { Db } from '../db/db.js';
import { logger } from '../logger.js';
import { Notifier } from '../stream/notifier.js';

const LOCK_SECONDS = 120;
const MAX_ATTEMPTS_BEFORE_BACKOFF = 5;

export function timingFor(mode: TrackingMode, snapshot: unknown): SessionTiming {
  const parsed = TrackingConfigParams.safeParse(snapshot);
  const p = parsed.success ? parsed.data : DEFAULT_TRACKING_CONFIG[mode] ?? DEFAULT_TRACKING_CONFIG.normal;
  return { maxIntervalMovingS: p.maxIntervalMovingS, stationaryIntervalS: p.stationaryIntervalS };
}

interface PointRow {
  id: number;
  session_id: string;
  seq: number;
  t: number;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  quality_flags: string[];
}

export const toObserved = (r: PointRow): ObservedPoint => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  t: Number(r.t),
  lat: r.lat,
  lon: r.lon,
  accuracy: r.accuracy_m,
  speed: r.speed_mps,
  heading: r.heading_deg,
  // 'jump' lo asigna este mismo procesador: no se realimenta como dato de entrada.
  flags: r.quality_flags.filter((f) => f !== 'jump'),
});

export const pointColumns = (alias?: string) => {
  const a = alias ? `${alias}.` : '';
  return `${a}id, ${a}session_id, ${a}seq, (extract(epoch from ${a}captured_at) * 1000)::float8 AS t, ${a}lat, ${a}lon, ${a}accuracy_m, ${a}speed_mps, ${a}heading_deg, ${a}quality_flags`;
};
export const POINT_COLUMNS = pointColumns();

interface ExistingEvent {
  id: string;
  dedup_key: string;
  type: string;
  occurred_at: Date;
  ended_at: Date | null;
  confidence: string;
  evidence: unknown;
  geofence_id: string | null;
  trip_id: string | null;
  point_id: number | null;
  lat: number | null;
  lon: number | null;
}

/** JSON con claves ordenadas: jsonb no conserva el orden de claves original. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const fingerprint = (r: ExistingEvent) =>
  stableStringify([r.type, r.occurred_at.getTime(), r.ended_at?.getTime() ?? null, r.confidence, r.evidence, r.geofence_id, r.trip_id, r.point_id, r.lat, r.lon]);
const fingerprintDerived = (e: DerivedEvent, geofenceId: string | null) =>
  stableStringify([e.type, e.occurredAt, e.endedAt, e.confidence, JSON.parse(JSON.stringify(e.evidence)), geofenceId, e.tripId ?? null, e.pointId, e.lat, e.lon]);

/**
 * Procesador de reglas (fuente de verdad de los eventos derivados).
 * Trabajo por dispositivo: "reprocesar desde T". Reevalúa completas las sesiones afectadas y
 * reconcilia por dedup_key: igual → se actualiza; nuevo → se inserta; ya no se sostiene → superseded.
 * Seguro con varias réplicas (FOR UPDATE SKIP LOCKED + lock con vencimiento) y sin perder trabajo
 * concurrente (solo limpia si pending_version no cambió mientras procesaba).
 */
@Injectable()
export class Processor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    if (this.env.WORKER_ENABLED) this.start();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  start() {
    logger.info({ intervalMs: this.env.WORKER_INTERVAL_MS }, 'worker.start');
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err: { message: (err as Error).message } }, 'worker.tick_failed');
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.env.WORKER_INTERVAL_MS);
    };
    this.timer = setTimeout(loop, 50);
  }

  /** Procesa hasta `limit` dispositivos pendientes. Devuelve cuántos procesó. */
  async tick(limit = 5): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await this.db.query<{ device_id: string; reprocess_from: Date; pending_version: number }>(
        `UPDATE device_processing_state s SET locked_until = now() + make_interval(secs => $2), attempts = s.attempts + 1
          WHERE s.device_id IN (
            SELECT device_id FROM device_processing_state
             WHERE reprocess_from IS NOT NULL AND (locked_until IS NULL OR locked_until < now())
             ORDER BY reprocess_from LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING s.device_id, s.reprocess_from, s.pending_version`,
        [limit, LOCK_SECONDS],
      );
      for (const c of claimed) {
        try {
          const changed = await this.processDevice(c.device_id, c.reprocess_from);
          await this.db.query(
            `UPDATE device_processing_state SET
               reprocess_from = CASE WHEN pending_version = $2 THEN NULL ELSE reprocess_from END,
               processed_until = now(), locked_until = NULL, attempts = 0, last_error = NULL, rules_version = $3
             WHERE device_id = $1`,
            [c.device_id, c.pending_version, 1],
          );
          if (changed.changed) {
            void this.notifier.publish({ type: 'events', deviceId: c.device_id, orgId: changed.orgId, sessionIds: changed.sessionIds, changed: changed.changed });
          }
        } catch (err) {
          const message = (err as Error).message;
          logger.error({ deviceId: c.device_id, err: { message } }, 'worker.device_failed');
          // Reintento con espera creciente; el trabajo no se descarta.
          await this.db.query(
            `UPDATE device_processing_state SET last_error = $2,
               locked_until = now() + make_interval(secs => LEAST(3600, 10 * power(2, LEAST(attempts, $3))))
             WHERE device_id = $1`,
            [c.device_id, message.slice(0, 500), MAX_ATTEMPTS_BEFORE_BACKOFF + 5],
          );
        }
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  /** Procesa todo lo pendiente (pruebas, demo, CLI). */
  async drain(maxRounds = 100) {
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick(20);
      if (!n) {
        const pending = await this.db.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM device_processing_state WHERE reprocess_from IS NOT NULL AND (locked_until IS NULL OR locked_until < now())`,
        );
        if (!pending?.n) return;
      }
    }
  }

  async processDevice(deviceId: string, from: Date): Promise<{ orgId: string; changed: number; sessionIds: string[] }> {
    const dev = await this.db.one<{ org_id: string; is_demo: boolean }>('SELECT org_id, is_demo FROM devices WHERE id = $1', [deviceId]);
    if (!dev) return { orgId: '', changed: 0, sessionIds: [] };
    const sessions = await this.db.query<{ id: string; mode: TrackingMode; config_snapshot: unknown; ended_at: Date | null; trip_id: string | null }>(
      `SELECT s.id, s.mode, s.config_snapshot, s.ended_at, s.trip_id FROM tracking_sessions s
        WHERE s.device_id = $1 AND (s.ended_at IS NULL OR s.ended_at >= $2
              OR EXISTS (SELECT 1 FROM location_points p WHERE p.session_id = s.id AND p.captured_at >= $2))`,
      [deviceId, from],
    );
    const geofences = await this.loadGeofences(dev.org_id);
    let changed = 0;
    for (const s of sessions) {
      const points = (await this.db.query<PointRow>(`SELECT ${POINT_COLUMNS} FROM location_points WHERE session_id = $1 ORDER BY captured_at, seq`, [s.id])).map(toObserved);
      const trip = s.trip_id ? await this.loadTrip(s.trip_id) : null;
      const derived = evaluateSession({
        sessionId: s.id,
        points,
        sessionEnded: s.ended_at !== null,
        timing: timingFor(s.mode, s.config_snapshot),
        geofences,
        trip,
        params: DEFAULT_RULE_PARAMS,
      });
      changed += await this.reconcile(deviceId, s.id, dev.is_demo, derived);
      if (trip) await this.updateTripStatus(trip.id, s.ended_at !== null, points);
    }
    return { orgId: dev.org_id, changed, sessionIds: sessions.map((s) => s.id) };
  }

  private async loadGeofences(orgId: string): Promise<GeofenceDef[]> {
    const rows = await this.db.query<{ id: string; shape: 'circle' | 'polygon'; center: string | null; radius_m: number | null; polygon: string | null; enter_dwell_s: number; exit_dwell_s: number; hysteresis_m: number }>(
      `SELECT id, shape, ST_AsGeoJSON(center) AS center, radius_m, ST_AsGeoJSON(polygon) AS polygon, enter_dwell_s, exit_dwell_s, hysteresis_m
         FROM geofences WHERE org_id = $1 AND active`,
      [orgId],
    );
    return rows.map((g) => ({
      id: g.id,
      shape: g.shape,
      center: g.center ? (([lon, lat]) => ({ lon, lat }))(JSON.parse(g.center).coordinates as [number, number]) : undefined,
      radiusM: g.radius_m ?? undefined,
      ring: g.polygon ? (JSON.parse(g.polygon).coordinates[0] as [number, number][]).map(([lon, lat]) => ({ lon, lat })) : undefined,
      enterDwellS: g.enter_dwell_s,
      exitDwellS: g.exit_dwell_s,
      hysteresisM: g.hysteresis_m,
    }));
  }

  async loadTrip(tripId: string): Promise<TripDef | null> {
    const t = await this.db.one<{ id: string; origin: string; destination: string; arrival_radius_m: number; route: string | null }>(
      `SELECT t.id, ST_AsGeoJSON(t.origin) AS origin, ST_AsGeoJSON(t.destination) AS destination, t.arrival_radius_m,
              (SELECT ST_AsGeoJSON(geom) FROM planned_routes r WHERE r.trip_id = t.id AND r.is_current) AS route
         FROM trips t WHERE t.id = $1`,
      [tripId],
    );
    if (!t) return null;
    const pt = (s: string) => {
      const [lon, lat] = JSON.parse(s).coordinates as [number, number];
      return { lon, lat };
    };
    return {
      id: t.id,
      origin: pt(t.origin),
      destination: pt(t.destination),
      arrivalRadiusM: t.arrival_radius_m,
      route: t.route ? (JSON.parse(t.route).coordinates as [number, number][]).map(([lon, lat]) => ({ lon, lat })) : null,
    };
  }

  private async reconcile(deviceId: string, sessionId: string, isDemo: boolean, derived: DerivedEvent[]): Promise<number> {
    return this.db.tx(async (c) => {
      const existing = await c.query<ExistingEvent>(
        `SELECT id, dedup_key, type, occurred_at, ended_at, confidence, evidence, geofence_id, trip_id, point_id, lat, lon
           FROM tracking_events WHERE session_id = $1 AND status = 'active' AND source = 'server_rules' FOR UPDATE`,
        [sessionId],
      );
      const byKey = new Map(existing.rows.map((r) => [r.dedup_key, r]));
      const keep = new Set<string>();
      let changed = 0;
      for (const e of derived) {
        keep.add(e.dedupKey);
        const geofenceId = e.geofenceId && !e.geofenceId.startsWith('trip:') ? e.geofenceId : null;
        const prev = byKey.get(e.dedupKey);
        if (prev && fingerprint(prev) === fingerprintDerived(e, geofenceId)) continue;
        const values = [
          e.tripId ?? null, geofenceId, e.type, new Date(e.occurredAt), e.endedAt == null ? null : new Date(e.endedAt),
          e.lat, e.lon, e.pointId, e.confidence, e.ruleId, e.ruleVersion, JSON.stringify(e.ruleParams), JSON.stringify(e.evidence),
        ];
        if (prev) {
          await c.query(
            `UPDATE tracking_events SET trip_id = $2, geofence_id = $3, type = $4, occurred_at = $5, ended_at = $6, lat = $7, lon = $8,
               point_id = $9, confidence = $10, rule_id = $11, rule_version = $12, rule_params = $13, evidence = $14 WHERE id = $1`,
            [prev.id, ...values],
          );
        } else {
          await c.query(
            `INSERT INTO tracking_events (device_id, session_id, dedup_key, is_demo, trip_id, geofence_id, type, occurred_at, ended_at, lat, lon,
               point_id, confidence, rule_id, rule_version, rule_params, evidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [deviceId, sessionId, e.dedupKey, isDemo, ...values],
          );
        }
        changed++;
      }
      const stale = existing.rows.filter((r) => !keep.has(r.dedup_key)).map((r) => r.id);
      if (stale.length) {
        await c.query(`UPDATE tracking_events SET status = 'superseded', superseded_at = now() WHERE id = ANY($1::uuid[])`, [stale]);
        changed += stale.length;
      }
      // Marca de calidad 'jump' en los puntos (metadato derivado, recalculable).
      const outliers = derived.filter((e) => e.type === 'gps_outlier' && e.pointId != null).map((e) => e.pointId!);
      await this.syncJumpFlags(c, sessionId, outliers);
      return changed;
    });
  }

  private async syncJumpFlags(c: pg.PoolClient, sessionId: string, outlierIds: number[]) {
    await c.query(
      `UPDATE location_points SET quality_flags = array_remove(quality_flags, 'jump')
        WHERE session_id = $1 AND 'jump' = ANY(quality_flags) AND NOT (id = ANY($2::bigint[]))`,
      [sessionId, outlierIds],
    );
    if (outlierIds.length) {
      await c.query(
        `UPDATE location_points SET quality_flags = array_append(quality_flags, 'jump')
          WHERE id = ANY($1::bigint[]) AND NOT ('jump' = ANY(quality_flags))`,
        [outlierIds],
      );
    }
  }

  /** Estado del viaje derivado de la evidencia; nunca pisa estados finales elegidos por un usuario. */
  private async updateTripStatus(tripId: string, sessionEnded: boolean, points: ObservedPoint[]) {
    const completed = await this.db.one<{ occurred_at: Date }>(
      `SELECT occurred_at FROM tracking_events WHERE trip_id = $1 AND type = 'trip_completed' AND status = 'active' AND confidence IN ('confirmed','probable')
        ORDER BY occurred_at LIMIT 1`,
      [tripId],
    );
    const first = points.length ? new Date(Math.min(...points.map((p) => p.t))) : null;
    if (completed) {
      await this.db.query(
        `UPDATE trips SET status = 'completed', actual_start_at = COALESCE(actual_start_at, $2), actual_end_at = $3
          WHERE id = $1 AND status IN ('planned','in_progress','interrupted')`,
        [tripId, first, completed.occurred_at],
      );
    } else if (sessionEnded) {
      await this.db.query(`UPDATE trips SET status = 'interrupted', actual_start_at = COALESCE(actual_start_at, $2) WHERE id = $1 AND status IN ('planned','in_progress')`, [tripId, first]);
    } else if (first) {
      await this.db.query(`UPDATE trips SET status = 'in_progress', actual_start_at = COALESCE(actual_start_at, $2) WHERE id = $1 AND status IN ('planned','interrupted')`, [tripId, first]);
    }
  }

  /** Marca para reprocesar las sesiones abiertas de una organización (p. ej. al cambiar geocercas o rutas). */
  async markOrgOpenSessions(orgId: string) {
    await this.db.query(
      `INSERT INTO device_processing_state (device_id, reprocess_from, pending_version)
       SELECT s.device_id, min(s.started_at), 1 FROM tracking_sessions s JOIN devices d ON d.id = s.device_id
        WHERE d.org_id = $1 AND s.ended_at IS NULL GROUP BY s.device_id
       ON CONFLICT (device_id) DO UPDATE SET reprocess_from = LEAST(COALESCE(device_processing_state.reprocess_from, EXCLUDED.reprocess_from), EXCLUDED.reprocess_from),
         pending_version = device_processing_state.pending_version + 1`,
      [orgId],
    );
  }

  /** Marca para reprocesar las sesiones asociadas a un viaje (p. ej. al recalcular la ruta). */
  async markTripSessions(tripId: string) {
    await this.db.query(
      `INSERT INTO device_processing_state (device_id, reprocess_from, pending_version)
       SELECT device_id, min(started_at), 1 FROM tracking_sessions WHERE trip_id = $1 GROUP BY device_id
       ON CONFLICT (device_id) DO UPDATE SET reprocess_from = LEAST(COALESCE(device_processing_state.reprocess_from, EXCLUDED.reprocess_from), EXCLUDED.reprocess_from),
         pending_version = device_processing_state.pending_version + 1`,
      [tripId],
    );
  }
}
