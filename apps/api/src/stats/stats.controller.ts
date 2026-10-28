import { Controller, Get } from '@nestjs/common';
import { connectionStateFor, type StatsOverview } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { Auth, userIdOf, type Principal } from '../common/http.js';
import { Db } from '../db/db.js';
import { EVENT_SELECT, toEventDto, type EventRow } from '../events/events.service.js';

/** Indicadores del dashboard calculados sobre datos reales y solo de dispositivos visibles. */
@Controller('v1/stats')
export class StatsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  @Get('overview')
  async overview(@Auth() p: Principal): Promise<StatsOverview> {
    const uid = userIdOf(p);
    const ids = await this.access.visibleDeviceIds(uid);
    const now = new Date();
    const empty: StatsOverview = {
      generatedAt: now.toISOString(),
      includesDemo: false,
      devices: { total: 0, active: 0, revoked: 0, connectedRecently: 0, withPendingSync: 0 },
      activeSessions: 0,
      tripsInProgress: 0,
      sessionsTotal: 0,
      distanceTotalM: 0,
      pointsTotal: 0,
      eventsLast24h: 0,
      recentEvents: [],
      lastPositions: [],
    };
    if (!ids.length) return empty;

    const [dev] = await this.db.query<{ total: number; active: number; revoked: number; demo: number; connected: number; pending: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE d.status = 'active')::int AS active,
              count(*) FILTER (WHERE d.status = 'revoked')::int AS revoked,
              count(*) FILTER (WHERE d.is_demo)::int AS demo,
              count(*) FILTER (WHERE NOT d.is_demo AND s.last_contact_at > now() - interval '15 minutes')::int AS connected,
              count(*) FILTER (WHERE s.client_pending_count > 0)::int AS pending
         FROM devices d LEFT JOIN device_sync_state s ON s.device_id = d.id WHERE d.id = ANY($1::uuid[])`,
      [ids],
    );
    const [sess] = await this.db.query<{ total: number; active: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE ended_at IS NULL)::int AS active FROM tracking_sessions WHERE device_id = ANY($1::uuid[])`,
      [ids],
    );
    // Distancia: suma geodésica entre puntos consecutivos de cada sesión, excluyendo outliers y saltos > 5 min.
    const [dist] = await this.db.query<{ points: number; meters: number }>(
      `SELECT count(*)::int AS points, COALESCE(sum(d) FILTER (WHERE dt <= 300), 0)::float8 AS meters FROM (
         SELECT ST_DistanceSphere(geom, lag(geom) OVER w) AS d,
                extract(epoch FROM captured_at - lag(captured_at) OVER w) AS dt
           FROM location_points WHERE device_id = ANY($1::uuid[]) AND NOT ('jump' = ANY(quality_flags))
         WINDOW w AS (PARTITION BY session_id ORDER BY captured_at, seq)) x`,
      [ids],
    );
    const [trips] = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trips WHERE status = 'in_progress' AND (device_id = ANY($1::uuid[]) OR (device_id IS NULL AND org_id IN (SELECT org_id FROM memberships WHERE user_id = $2)))`,
      [ids, uid],
    );
    const [ev] = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tracking_events WHERE device_id = ANY($1::uuid[]) AND status = 'active' AND occurred_at > now() - interval '24 hours'`,
      [ids],
    );
    const recent = await this.db.query<EventRow>(`${EVENT_SELECT} WHERE e.device_id = ANY($1::uuid[]) AND e.status = 'active' ORDER BY e.occurred_at DESC LIMIT 10`, [ids]);
    const last = await this.db.query<{ id: string; name: string; is_demo: boolean; last_contact_at: Date | null; lat: number; lon: number; captured_at: Date; received_at: Date }>(
      `SELECT d.id, d.name, d.is_demo, s.last_contact_at, lp.lat, lp.lon, lp.captured_at, lp.received_at
         FROM devices d LEFT JOIN device_sync_state s ON s.device_id = d.id
         JOIN LATERAL (SELECT lat, lon, captured_at, received_at FROM location_points WHERE device_id = d.id AND NOT ('jump' = ANY(quality_flags))
                        ORDER BY captured_at DESC LIMIT 1) lp ON true
        WHERE d.id = ANY($1::uuid[]) ORDER BY lp.captured_at DESC`,
      [ids],
    );
    return {
      generatedAt: now.toISOString(),
      includesDemo: dev!.demo > 0,
      devices: { total: dev!.total, active: dev!.active, revoked: dev!.revoked, connectedRecently: dev!.connected, withPendingSync: dev!.pending },
      activeSessions: sess!.active,
      tripsInProgress: trips!.n,
      sessionsTotal: sess!.total,
      distanceTotalM: Math.round(dist!.meters),
      pointsTotal: dist!.points,
      eventsLast24h: ev!.n,
      recentEvents: recent.map(toEventDto),
      lastPositions: last.map((l) => ({
        deviceId: l.id,
        deviceName: l.name,
        isDemo: l.is_demo,
        connectionState: connectionStateFor(l.is_demo ? null : l.last_contact_at, now),
        lat: l.lat,
        lon: l.lon,
        capturedAt: l.captured_at.toISOString(),
        receivedAt: l.received_at.toISOString(),
      })),
    };
  }
}
