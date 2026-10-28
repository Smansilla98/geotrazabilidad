import { Injectable } from '@nestjs/common';
import type { TrackingEventDto } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AppError, notFound } from '../common/http.js';
import { Db } from '../db/db.js';

export const EVENT_SELECT = `
  SELECT e.id, e.device_id, d.name AS device_name, e.session_id, e.trip_id, t.name AS trip_name, e.geofence_id, g.name AS geofence_name,
         e.type, e.occurred_at, e.ended_at, e.lat, e.lon, e.point_id, e.confidence, e.rule_id, e.rule_version, e.rule_params, e.evidence,
         e.source, e.is_demo
    FROM tracking_events e
    JOIN devices d ON d.id = e.device_id
    LEFT JOIN trips t ON t.id = e.trip_id
    LEFT JOIN geofences g ON g.id = e.geofence_id`;

export interface EventRow {
  id: string; device_id: string; device_name: string; session_id: string | null; trip_id: string | null; trip_name: string | null;
  geofence_id: string | null; geofence_name: string | null; type: TrackingEventDto['type']; occurred_at: Date; ended_at: Date | null;
  lat: number | null; lon: number | null; point_id: number | null; confidence: TrackingEventDto['confidence']; rule_id: string; rule_version: number;
  rule_params: Record<string, unknown>; evidence: Record<string, unknown>; source: TrackingEventDto['source']; is_demo: boolean;
}

export const toEventDto = (r: EventRow): TrackingEventDto => ({
  id: r.id,
  deviceId: r.device_id,
  deviceName: r.device_name,
  sessionId: r.session_id,
  tripId: r.trip_id,
  tripName: r.trip_name,
  geofenceId: r.geofence_id,
  geofenceName: r.geofence_name,
  type: r.type,
  occurredAt: r.occurred_at.toISOString(),
  endedAt: r.ended_at?.toISOString() ?? null,
  lat: r.lat,
  lon: r.lon,
  pointId: r.point_id,
  confidence: r.confidence,
  ruleId: r.rule_id,
  ruleVersion: r.rule_version,
  ruleParams: r.rule_params,
  evidence: r.evidence,
  source: r.source,
  isDemo: r.is_demo,
});

@Injectable()
export class EventsService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async list(
    userId: string,
    q: { deviceId?: string; tripId?: string; sessionId?: string; types?: string[]; confidence?: string[]; from?: string; to?: string; limit: number; cursor?: string },
  ) {
    let devices = await this.access.visibleDeviceIds(userId);
    if (q.deviceId) {
      if (!devices.includes(q.deviceId)) throw notFound('Dispositivo');
      devices = [q.deviceId];
    }
    if (!devices.length) return { items: [], nextCursor: null };
    const params: unknown[] = [devices];
    const where = [`e.device_id = ANY($1::uuid[])`, `e.status = 'active'`];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.tripId) add('e.trip_id = ?', q.tripId);
    if (q.sessionId) add('e.session_id = ?', q.sessionId);
    if (q.types?.length) add('e.type = ANY(?::event_type[])', q.types);
    if (q.confidence?.length) add('e.confidence = ANY(?::event_confidence[])', q.confidence);
    if (q.from) add('e.occurred_at >= ?', q.from);
    if (q.to) add('e.occurred_at <= ?', q.to);
    if (q.cursor) {
      const [t, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (!t || !id) throw new AppError(400, 'INVALID_CURSOR', 'Cursor inválido');
      params.push(t, id);
      where.push(`(e.occurred_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = await this.db.query<EventRow>(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.occurred_at DESC, e.id DESC LIMIT $${params.length}`, params);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toEventDto),
      nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.occurred_at.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  async get(userId: string, id: string): Promise<TrackingEventDto> {
    const r = await this.db.one<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
    if (!r) throw notFound('Evento');
    await this.access.device(userId, r.device_id).catch(() => {
      throw notFound('Evento');
    });
    return toEventDto(r);
  }
}
