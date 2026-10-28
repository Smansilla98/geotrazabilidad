import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DEFAULT_TRACKING_CONFIG } from '@geo/shared';
import { AuditService } from '../audit/audit.service.js';
import { Db } from '../db/db.js';
import { buildScenarios, DEMO_DEVICES, DEMO_GEOFENCES, routeLengthM } from './scenarios.js';

/**
 * Carga de datos de demostración en una organización. Todo queda marcado is_demo = true:
 * dispositivos (plataforma 'demo'), sesiones, puntos (source 'demo'), viajes, geocercas y eventos.
 * Recargar reemplaza la demo anterior; nunca toca datos reales.
 */
@Injectable()
export class DemoService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async clear(orgId: string): Promise<void> {
    await this.db.tx(async (c) => {
      await c.query('DELETE FROM devices WHERE org_id = $1 AND is_demo', [orgId]);
      await c.query('DELETE FROM trips WHERE org_id = $1 AND is_demo', [orgId]);
      await c.query('DELETE FROM geofences WHERE org_id = $1 AND is_demo', [orgId]);
    });
  }

  async load(orgId: string, holderUserId: string, now: Date = new Date()) {
    await this.clear(orgId);
    // Anclado al día anterior, 08:00 hora de Buenos Aires (UTC-3).
    const y = new Date(now.getTime() - 86_400_000);
    const base = Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 11, 0, 0);
    const scenarios = buildScenarios(base);
    let points = 0;
    await this.db.tx(async (c) => {
      const deviceIds: string[] = [];
      for (const name of DEMO_DEVICES) {
        const r = await c.query<{ id: string }>(
          `INSERT INTO devices (org_id, holder_user_id, install_id, name, platform, is_demo, app_version) VALUES ($1, $2, $3, $4, 'demo', true, 'demo') RETURNING id`,
          [orgId, holderUserId, randomUUID(), name],
        );
        deviceIds.push(r.rows[0]!.id);
        await c.query('INSERT INTO device_sync_state (device_id) VALUES ($1)', [r.rows[0]!.id]);
      }
      for (const g of DEMO_GEOFENCES) {
        if (g.shape === 'circle') {
          await c.query(
            `INSERT INTO geofences (org_id, name, kind, shape, center, radius_m, is_demo, created_by) VALUES ($1, $2, $3, 'circle', ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, true, $7)`,
            [orgId, g.name, g.kind, g.center.lon, g.center.lat, g.radiusM, holderUserId],
          );
        } else {
          await c.query(
            `INSERT INTO geofences (org_id, name, kind, shape, polygon, is_demo, created_by) VALUES ($1, $2, $3, 'polygon', ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), true, $5)`,
            [orgId, g.name, g.kind, JSON.stringify({ type: 'Polygon', coordinates: [g.ring] }), holderUserId],
          );
        }
      }
      for (const s of scenarios) {
        const deviceId = deviceIds[s.device]!;
        let tripId: string | null = null;
        if (s.trip) {
          const t = await c.query<{ id: string }>(
            `INSERT INTO trips (org_id, device_id, name, origin, destination, arrival_radius_m, planned_start_at, planned_arrival_at, notes, is_demo, created_by)
             VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), ST_SetSRID(ST_MakePoint($6, $7), 4326), $8, $9, $10, $11, true, $12) RETURNING id`,
            [
              orgId, deviceId, s.trip.name, s.trip.origin.lon, s.trip.origin.lat, s.trip.destination.lon, s.trip.destination.lat, s.trip.arrivalRadiusM,
              new Date(s.startedAt), new Date(s.startedAt + (routeLengthM(s.trip.plannedRoute) / s.trip.plannedSpeedMps) * 1000),
              `Escenario sintético: ${s.title}`, holderUserId,
            ],
          );
          tripId = t.rows[0]!.id;
          const len = routeLengthM(s.trip.plannedRoute);
          await c.query(
            `INSERT INTO planned_routes (trip_id, provider, profile, geom, distance_m, duration_s, duration_kind, provider_meta)
             VALUES ($1, 'demo_synthetic', 'driving', ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3, $4, 'basic_estimate', $5)`,
            [
              tripId,
              JSON.stringify({ type: 'LineString', coordinates: s.trip.plannedRoute.map((p) => [p.lon, p.lat]) }),
              len,
              len / s.trip.plannedSpeedMps,
              { note: 'Ruta sintética de demostración; no proviene de un proveedor de rutas', attribution: 'Datos de demostración' },
            ],
          );
        }
        const sessionId = randomUUID();
        await c.query(
          `INSERT INTO tracking_sessions (id, device_id, trip_id, mode, config_snapshot, started_at, ended_at, end_reason, is_demo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [sessionId, deviceId, tripId, s.mode, { ...DEFAULT_TRACKING_CONFIG[s.mode], demoScenario: s.key }, new Date(s.startedAt), new Date(s.endedAt), s.endReason],
        );
        const pts = s.points;
        points += pts.length;
        await c.query(
          `INSERT INTO location_points (device_id, session_id, client_point_id, seq, lat, lon, captured_at, received_at, accuracy_m, speed_mps, heading_deg, source, is_demo)
           SELECT $1, $2, gen_random_uuid(), u.seq, u.lat, u.lon, u.t, u.t, u.acc, u.speed, u.heading, 'demo', true
             FROM unnest($3::int[], $4::float8[], $5::float8[], $6::timestamptz[], $7::float8[], $8::float8[], $9::float8[]) AS u(seq, lat, lon, t, acc, speed, heading)`,
          [
            deviceId, sessionId, pts.map((_, i) => i), pts.map((p) => p.lat), pts.map((p) => p.lon), pts.map((p) => new Date(p.t)),
            pts.map((p) => p.accuracy), pts.map((p) => p.speed), pts.map((p) => p.heading),
          ],
        );
      }
      for (const id of deviceIds) {
        await c.query(
          `INSERT INTO device_processing_state (device_id, reprocess_from, pending_version) VALUES ($1, '1970-01-01', 1)
           ON CONFLICT (device_id) DO UPDATE SET reprocess_from = '1970-01-01', pending_version = device_processing_state.pending_version + 1`,
          [id],
        );
      }
      await this.audit.log({ orgId, actorUserId: holderUserId, action: 'demo.load', metadata: { scenarios: scenarios.length, points } }, c);
    });
    return { scenarios: scenarios.map((s) => ({ key: s.key, title: s.title, points: s.points.length, device: DEMO_DEVICES[s.device] })), points };
  }
}
