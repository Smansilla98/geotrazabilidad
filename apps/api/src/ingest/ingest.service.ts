import { Injectable } from '@nestjs/common';
import type { IngestBatchRequest, IngestBatchResponse, IngestPoint, RejectCode } from '@geo/shared';
import { AppError } from '../common/http.js';
import { Db } from '../db/db.js';
import { DevicesService } from '../devices/devices.service.js';
import { logger } from '../logger.js';
import { Notifier } from '../stream/notifier.js';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const BEFORE_SESSION_TOLERANCE_MS = 60_000;

const finiteOrNull = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v);

/** Normaliza valores "no disponible" de las plataformas (p. ej. -1 en iOS) a null. */
export function normalizePoint(p: IngestPoint) {
  const speed = finiteOrNull(p.speed);
  const heading = finiteOrNull(p.heading);
  const accuracy = finiteOrNull(p.accuracy);
  const altAcc = finiteOrNull(p.altitudeAccuracy);
  return {
    accuracy: accuracy != null && accuracy >= 0 ? accuracy : null,
    altitude: finiteOrNull(p.altitude),
    altitudeAccuracy: altAcc != null && altAcc >= 0 ? altAcc : null,
    speed: speed != null && speed >= 0 ? speed : null,
    heading: heading != null && heading >= 0 && heading < 360 ? heading : null,
    battery: finiteOrNull(p.battery),
  };
}

@Injectable()
export class IngestService {
  constructor(
    private readonly db: Db,
    private readonly devices: DevicesService,
    private readonly notifier: Notifier,
  ) {}

  /**
   * Ingesta idempotente. Garantías:
   * - Reenviar el mismo lote o el mismo punto nunca crea duplicados (UNIQUE device_id+client_point_id).
   * - Cada punto se acepta, se reconoce como duplicado o se rechaza con un código; nunca se pierde en silencio.
   * - captured_at se conserva tal como lo envió el dispositivo; received_at lo asigna el servidor.
   * - No calcula eventos: marca el dispositivo para reprocesar desde el punto más antiguo recibido.
   */
  async ingest(deviceId: string, req: IngestBatchRequest): Promise<IngestBatchResponse> {
    const receivedAt = new Date();
    const sentAt = new Date(req.sentAt);
    const skewMs = receivedAt.getTime() - sentAt.getTime();

    const result = await this.db.tx(async (c) => {
      const dev = await c.query<{ org_id: string; status: string; consent: boolean }>(
        `SELECT d.org_id, d.status, EXISTS (SELECT 1 FROM device_consents WHERE device_id = d.id AND revoked_at IS NULL) AS consent
           FROM devices d WHERE d.id = $1 FOR SHARE`,
        [deviceId],
      );
      const device = dev.rows[0];
      if (!device || device.status !== 'active') throw new AppError(403, 'DEVICE_REVOKED', 'El acceso de este dispositivo fue revocado');
      if (!device.consent) throw new AppError(403, 'CONSENT_REQUIRED', 'No hay un consentimiento vigente para registrar ubicaciones');

      // Sesiones: upsert solo si pertenecen a este dispositivo. El cierre nunca se "reabre".
      const sessionStart = new Map<string, number>();
      let earliestChange: number | null = null;
      for (const s of req.sessions) {
        let tripId = s.tripId ?? null;
        if (tripId) {
          const t = await c.query('SELECT 1 FROM trips WHERE id = $1 AND org_id = $2 AND (device_id IS NULL OR device_id = $3)', [tripId, device.org_id, deviceId]);
          if (!t.rowCount) tripId = null;
        }
        const r = await c.query<{ id: string; started_at: Date }>(
          `INSERT INTO tracking_sessions (id, device_id, trip_id, mode, config_snapshot, started_at, ended_at, end_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             ended_at = COALESCE(tracking_sessions.ended_at, EXCLUDED.ended_at),
             end_reason = COALESCE(tracking_sessions.end_reason, EXCLUDED.end_reason),
             trip_id = COALESCE(tracking_sessions.trip_id, EXCLUDED.trip_id)
           WHERE tracking_sessions.device_id = EXCLUDED.device_id
           RETURNING id, started_at`,
          [s.id, deviceId, tripId, s.mode, JSON.stringify(s.configSnapshot ?? {}), s.startedAt, s.endedAt ?? null, s.endReason ?? null],
        );
        const row = r.rows[0];
        if (row) {
          sessionStart.set(row.id, row.started_at.getTime());
          if (s.endedAt) earliestChange = Math.min(earliestChange ?? Infinity, new Date(s.endedAt).getTime());
          if (tripId && s.tripId) await c.query(`UPDATE trips SET device_id = COALESCE(device_id, $2) WHERE id = $1`, [tripId, deviceId]);
        }
      }
      const missing = [...new Set(req.points.map((p) => p.sessionId))].filter((id) => !sessionStart.has(id));
      const foreign = new Set<string>();
      if (missing.length) {
        const r = await c.query<{ id: string; device_id: string; started_at: Date }>('SELECT id, device_id, started_at FROM tracking_sessions WHERE id = ANY($1::uuid[])', [missing]);
        for (const s of r.rows) {
          if (s.device_id === deviceId) sessionStart.set(s.id, s.started_at.getTime());
          else foreign.add(s.id);
        }
      }

      const rejected: Array<{ id: string; code: RejectCode }> = [];
      const valid: Array<IngestPoint & ReturnType<typeof normalizePoint> & { flags: string[] }> = [];
      const seenIds = new Set<string>();
      const nowMs = receivedAt.getTime();
      for (const p of req.points) {
        if (seenIds.has(p.id)) continue; // repetido dentro del mismo lote
        seenIds.add(p.id);
        const reject = (code: RejectCode) => rejected.push({ id: p.id, code });
        if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) { reject('LAT_OUT_OF_RANGE'); continue; }
        if (!Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) { reject('LON_OUT_OF_RANGE'); continue; }
        if (foreign.has(p.sessionId)) { reject('SESSION_OF_OTHER_DEVICE'); continue; }
        const start = sessionStart.get(p.sessionId);
        if (start === undefined) { reject('UNKNOWN_SESSION'); continue; }
        const t = new Date(p.capturedAt).getTime();
        const flags: string[] = [];
        if (t > nowMs + FUTURE_TOLERANCE_MS) {
          // Reloj del dispositivo adelantado: se acepta solo si el desfase estimado lo explica.
          if (t + skewMs > nowMs + FUTURE_TOLERANCE_MS) { reject('TOO_FAR_IN_FUTURE'); continue; }
          flags.push('future_ts');
        }
        if (t < start - BEFORE_SESSION_TOLERANCE_MS) { reject('BEFORE_SESSION_START'); continue; }
        if (p.mocked) flags.push('mocked');
        valid.push({ ...p, ...normalizePoint(p), flags });
      }

      const batch = await c.query<{ id: string }>(
        `INSERT INTO ingest_batches (device_id, client_batch_id, sent_at, received_at, clock_skew_ms, accepted, duplicates, rejected)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 0)
         ON CONFLICT (device_id, client_batch_id) DO UPDATE SET received_at = EXCLUDED.received_at
         RETURNING id`,
        [deviceId, req.batchId, sentAt, receivedAt, Math.max(-2_000_000_000, Math.min(2_000_000_000, skewMs))],
      );
      const batchId = batch.rows[0]!.id;

      let accepted: string[] = [];
      if (valid.length) {
        const col = <K extends keyof (typeof valid)[number]>(k: K) => valid.map((v) => v[k] ?? null);
        const r = await c.query<{ client_point_id: string; captured_at: Date }>(
          `INSERT INTO location_points (device_id, session_id, client_point_id, seq, lat, lon, captured_at, received_at,
              accuracy_m, altitude_m, altitude_accuracy_m, speed_mps, heading_deg, source, is_mocked, battery_level, quality_flags, batch_id)
           SELECT $1, u.session_id, u.client_point_id, u.seq, u.lat, u.lon, u.captured_at, $2,
                  u.accuracy, u.altitude, u.alt_acc, u.speed, u.heading, u.source::location_source, u.mocked, u.battery,
                  CASE WHEN u.flags = '' THEN '{}'::text[] ELSE string_to_array(u.flags, ',') END, $3
             FROM unnest($4::uuid[], $5::uuid[], $6::int[], $7::float8[], $8::float8[], $9::timestamptz[],
                         $10::float8[], $11::float8[], $12::float8[], $13::float8[], $14::float8[], $15::text[], $16::bool[], $17::float8[], $18::text[])
               AS u(session_id, client_point_id, seq, lat, lon, captured_at, accuracy, altitude, alt_acc, speed, heading, source, mocked, battery, flags)
           ON CONFLICT (device_id, client_point_id) DO NOTHING
           RETURNING client_point_id, captured_at`,
          [
            deviceId, receivedAt, batchId,
            col('sessionId'), col('id'), col('seq'), col('lat'), col('lon'), col('capturedAt'),
            col('accuracy'), col('altitude'), col('altitudeAccuracy'), col('speed'), col('heading'), col('source'),
            col('mocked'), col('battery'), valid.map((v) => v.flags.join(',')),
          ],
        );
        accepted = r.rows.map((x) => x.client_point_id);
        for (const x of r.rows) earliestChange = Math.min(earliestChange ?? Infinity, x.captured_at.getTime());
      }
      const acceptedSet = new Set(accepted);
      const duplicates = valid.map((v) => v.id).filter((id) => !acceptedSet.has(id));

      await c.query('UPDATE ingest_batches SET accepted = accepted + $2, duplicates = $3, rejected = $4 WHERE id = $1', [batchId, accepted.length, duplicates.length, rejected.length]);

      const last = await c.query<{ id: number; captured_at: Date; received_at: Date }>(
        'SELECT id, captured_at, received_at FROM location_points WHERE device_id = $1 ORDER BY captured_at DESC LIMIT 1',
        [deviceId],
      );
      await c.query(
        `INSERT INTO device_sync_state (device_id, last_contact_at, last_point_received_at, last_point_captured_at, last_point_id,
            client_pending_count, client_reported_at, last_batch_id, app_version, permission, battery_level, clock_skew_ms)
         VALUES ($1, now(), $2, $3, $4, $5, now(), $6, $7, $8, $9, $10)
         ON CONFLICT (device_id) DO UPDATE SET last_contact_at = now(),
           last_point_received_at = CASE WHEN $11 > 0 THEN $2 ELSE device_sync_state.last_point_received_at END,
           last_point_captured_at = $3, last_point_id = $4,
           client_pending_count = $5, client_reported_at = now(), last_batch_id = $6,
           app_version = COALESCE($7, device_sync_state.app_version), permission = COALESCE($8, device_sync_state.permission),
           battery_level = COALESCE($9, device_sync_state.battery_level), clock_skew_ms = $10, last_error = NULL`,
        [
          deviceId, receivedAt, last.rows[0]?.captured_at ?? null, last.rows[0]?.id ?? null,
          Math.max(0, (req.client.pendingCount ?? 0) - accepted.length - duplicates.length), batchId,
          req.client.appVersion ?? null, req.client.permission ?? null, req.client.batteryLevel ?? null, Math.round(skewMs), accepted.length,
        ],
      );

      if (earliestChange !== null) {
        await c.query(
          `INSERT INTO device_processing_state (device_id, reprocess_from, pending_version) VALUES ($1, $2, 1)
           ON CONFLICT (device_id) DO UPDATE SET reprocess_from = LEAST(COALESCE(device_processing_state.reprocess_from, $2), $2),
             pending_version = device_processing_state.pending_version + 1`,
          [deviceId, new Date(earliestChange)],
        );
      }
      return { accepted, duplicates, rejected, orgId: device.org_id, lastCapturedAt: last.rows[0]?.captured_at ?? null };
    });

    if (result.accepted.length) {
      void this.notifier.publish({ type: 'points', deviceId, orgId: result.orgId, count: result.accepted.length, lastCapturedAt: result.lastCapturedAt?.toISOString() ?? null });
    }
    logger.info(
      { deviceId, batchId: req.batchId, accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: result.rejected.length, skewMs },
      'ingest.batch',
    );
    const cfg = await this.devices.trackingConfig(deviceId);
    return {
      batchId: req.batchId,
      serverTime: receivedAt.toISOString(),
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected,
      config: { version: cfg.version, changed: req.client.configVersion !== undefined && req.client.configVersion !== cfg.version },
    };
  }
}
