import { Injectable } from '@nestjs/common';
import {
  DEFAULT_RULE_PARAMS,
  flagsToMask,
  reconstructTrack,
  simplifyIndices,
  type ClassifiedPoint,
  type SessionSummary,
  type TrackPointTuple,
  type TrackResponse,
  type TrackSegment,
  type TrackingMode,
} from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/http.js';
import { Db } from '../db/db.js';
import { pointColumns, timingFor, toObserved } from '../processing/processor.js';

/** Tope duro de puntos cargados por consulta de recorrido (protege memoria del servidor). */
const HARD_CAP = 100_000;
const MAX_RANGE_DAYS = 31;

@Injectable()
export class TracksService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async sessions(userId: string, deviceId: string, q: { from?: string; to?: string; limit: number }): Promise<SessionSummary[]> {
    await this.access.device(userId, deviceId);
    const rows = await this.db.query<{
      id: string; device_id: string; trip_id: string | null; mode: TrackingMode; started_at: Date; ended_at: Date | null; end_reason: string | null;
      is_demo: boolean; n: number; first_at: Date | null; last_at: Date | null;
    }>(
      `SELECT s.id, s.device_id, s.trip_id, s.mode, s.started_at, s.ended_at, s.end_reason, s.is_demo,
              agg.n, agg.first_at, agg.last_at
         FROM tracking_sessions s
         LEFT JOIN LATERAL (SELECT count(*)::int AS n, min(captured_at) AS first_at, max(captured_at) AS last_at FROM location_points WHERE session_id = s.id) agg ON true
        WHERE s.device_id = $1 AND ($2::timestamptz IS NULL OR COALESCE(s.ended_at, now()) >= $2) AND ($3::timestamptz IS NULL OR s.started_at <= $3)
        ORDER BY s.started_at DESC LIMIT $4`,
      [deviceId, q.from ?? null, q.to ?? null, q.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      tripId: r.trip_id,
      mode: r.mode,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      endReason: r.end_reason,
      pointCount: r.n,
      firstPointAt: r.first_at?.toISOString() ?? null,
      lastPointAt: r.last_at?.toISOString() ?? null,
      isDemo: r.is_demo,
    }));
  }

  /** Puntos crudos paginados por cursor (captured_at, id). */
  async points(userId: string, deviceId: string, q: { from: string; to: string; limit: number; cursor?: string }) {
    await this.access.device(userId, deviceId);
    let after: [string, number] | null = null;
    if (q.cursor) {
      const [t, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (!t || !id || Number.isNaN(Number(id))) throw new AppError(400, 'INVALID_CURSOR', 'Cursor inválido');
      after = [t, Number(id)];
    }
    const rows = await this.db.query<Record<string, unknown> & { id: number; captured_at: Date }>(
      `SELECT id, session_id AS "sessionId", client_point_id AS "clientPointId", seq, lat, lon, captured_at, received_at AS "receivedAt",
              accuracy_m AS "accuracyM", altitude_m AS "altitudeM", speed_mps AS "speedMps", heading_deg AS "headingDeg", source,
              is_mocked AS "isMocked", battery_level AS "batteryLevel", quality_flags AS "qualityFlags", is_demo AS "isDemo"
         FROM location_points
        WHERE device_id = $1 AND captured_at >= $2 AND captured_at <= $3
          AND ($4::timestamptz IS NULL OR (captured_at, id) > ($4::timestamptz, $5::bigint))
        ORDER BY captured_at, id LIMIT $6`,
      [deviceId, q.from, q.to, after?.[0] ?? null, after?.[1] ?? null, Math.min(q.limit, 5000) + 1],
    );
    const limit = Math.min(q.limit, 5000);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ captured_at, ...r }) => ({ ...r, capturedAt: captured_at.toISOString() })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.captured_at.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  /**
   * Reconstrucción del recorrido real. El servidor decide los cortes (huecos, sesiones, saltos)
   * y simplifica solo dentro de tramos observados, conservando extremos y puntos con eventos.
   */
  async track(
    userId: string,
    deviceId: string,
    q: { from: string; to: string; sessionId?: string; tripId?: string; toleranceM: number; maxPoints: number },
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<TrackResponse> {
    const dev = await this.access.device(userId, deviceId);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from)) throw new AppError(400, 'INVALID_RANGE', '"to" debe ser posterior a "from"');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new AppError(400, 'RANGE_TOO_LARGE', `El rango máximo es de ${MAX_RANGE_DAYS} días`);

    const filters: string[] = ['p.device_id = $1', 'p.captured_at >= $2', 'p.captured_at <= $3'];
    const params: unknown[] = [deviceId, from, to];
    if (q.sessionId) {
      params.push(q.sessionId);
      filters.push(`p.session_id = $${params.length}`);
    }
    if (q.tripId) {
      params.push(q.tripId);
      filters.push(`p.session_id IN (SELECT id FROM tracking_sessions WHERE trip_id = $${params.length})`);
    }
    params.push(HARD_CAP + 1);
    const rows = await this.db.query<Parameters<typeof toObserved>[0]>(
      `SELECT ${pointColumns('p')}
         FROM location_points p WHERE ${filters.join(' AND ')} ORDER BY p.captured_at, p.seq LIMIT $${params.length}`,
      params,
    );
    const truncated = rows.length > HARD_CAP;
    const points = rows.slice(0, HARD_CAP).map(toObserved);
    const sessions = await this.db.query<{ id: string; mode: TrackingMode; config_snapshot: unknown }>(
      'SELECT id, mode, config_snapshot FROM tracking_sessions WHERE id = ANY($1::uuid[])',
      [[...new Set(points.map((p) => p.sessionId))]],
    );
    const timing = new Map(sessions.map((s) => [s.id, timingFor(s.mode, s.config_snapshot)]));
    const rec = reconstructTrack(points, DEFAULT_RULE_PARAMS, (sid) => timing.get(sid) ?? timingFor('normal', null));

    const eventPoints = new Set(
      (
        await this.db.query<{ point_id: number }>(
          `SELECT point_id FROM tracking_events WHERE device_id = $1 AND status = 'active' AND point_id IS NOT NULL AND occurred_at BETWEEN $2 AND $3`,
          [deviceId, from, to],
        )
      ).map((r) => r.point_id),
    );

    const observedCount = rec.segments.reduce((n, s) => n + (s.kind === 'observed' ? s.points.length : 0), 0);
    let tolerance = q.toleranceM;
    const simplifySeg = (pts: ClassifiedPoint[], tol: number) => {
      if (tol <= 0) return pts;
      const keep = new Set<number>();
      pts.forEach((c, i) => eventPoints.has(c.p.id) && keep.add(i));
      return simplifyIndices(pts.map((c) => c.p), tol, keep).map((i) => pts[i]!);
    };
    let kept = rec.segments.map((s) => (s.kind === 'observed' ? simplifySeg(s.points, tolerance) : null));
    const countKept = () => kept.reduce((n, k) => n + (k?.length ?? 0), 0);
    // Aumenta la tolerancia hasta respetar maxPoints (historiales largos).
    for (let i = 0; countKept() > q.maxPoints && i < 12; i++) {
      tolerance = tolerance > 0 ? tolerance * 2 : 2;
      kept = rec.segments.map((s) => (s.kind === 'observed' ? simplifySeg(s.points, tolerance) : null));
    }

    const tuple = (c: ClassifiedPoint): TrackPointTuple => [c.p.lon, c.p.lat, c.p.t, c.p.id, c.p.accuracy, c.p.speed, flagsToMask(c.flags)];
    const iso = (t: number) => new Date(t).toISOString();
    const segments: TrackSegment[] = rec.segments.map((s, i) =>
      s.kind === 'observed'
        ? { kind: 'observed', sessionId: s.sessionId, startAt: iso(s.points[0]!.p.t), endAt: iso(s.points[s.points.length - 1]!.p.t), points: kept[i]!.map(tuple) }
        : {
            kind: 'gap',
            reason: s.reason,
            startAt: iso(s.from.p.t),
            endAt: iso(s.to.p.t),
            durationS: Math.round(s.durationS),
            distanceM: Math.round(s.distanceM),
            from: { lon: s.from.p.lon, lat: s.from.p.lat },
            to: { lon: s.to.p.lon, lat: s.to.p.lat },
          },
    );
    const usable = rec.classified.filter((c) => c.usable);
    const speeds = usable.map((c) => c.p.speed).filter((v): v is number => v != null);
    await this.audit.log({ orgId: dev.orgId, actorUserId: userId, action: 'track.view', targetType: 'device', targetId: deviceId, metadata: { from: q.from, to: q.to }, ...meta });
    return {
      deviceId,
      from: from.toISOString(),
      to: to.toISOString(),
      isDemo: dev.isDemo,
      truncated,
      stats: {
        distanceM: Math.round(rec.observedDistanceM),
        observedPoints: observedCount,
        returnedPoints: countKept(),
        simplified: tolerance > 0 && countKept() < observedCount,
        gaps: rec.segments.filter((s) => s.kind === 'gap' && s.reason !== 'session_boundary').length,
        outliers: rec.outliers.length,
        maxSpeedMps: speeds.length ? Math.max(...speeds) : null,
        durationS: usable.length ? Math.round((usable[usable.length - 1]!.p.t - usable[0]!.p.t) / 1000) : 0,
      },
      segments,
      outliers: rec.outliers.map((o) => ({ pointId: o.p.id, lon: o.p.lon, lat: o.p.lat, at: iso(o.p.t), flags: [...o.flags] })),
    };
  }
}
