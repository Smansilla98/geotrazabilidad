import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EventsExportQuery, ExportQuery } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ENV } from '../auth/tokens.js';
import { AppError, Auth, clientMeta, notFound, parse, userIdOf, type Principal } from '../common/http.js';
import type { Env } from '../config/env.js';
import { Db } from '../db/db.js';
import { EVENT_SELECT, toEventDto, type EventRow } from '../events/events.service.js';
import { csvRow, POINT_FIELDS, toGeoJson, toGpx, toKml, type ExportMeta, type ExportPoint } from './formats.js';

const PAGE = 5000;
const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  geojson: 'application/geo+json',
  gpx: 'application/gpx+xml',
  kml: 'application/vnd.google-earth.kml+xml',
} as const;

/** Exportaciones generadas al vuelo (sin archivos en disco). Respetan permisos y quedan auditadas. */
@Controller('v1')
export class ExportsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async *pages(deviceIds: string[], from: string, to: string): AsyncGenerator<ExportPoint[]> {
    let after: [Date, number] | null = null;
    for (;;) {
      const rows: Array<ExportPoint & { captured: Date }> = await this.db.query(
        `SELECT id, session_id AS "sessionId", seq, captured_at AS captured, to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAt",
                to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt", lat, lon, accuracy_m AS "accuracyM",
                altitude_m AS "altitudeM", speed_mps AS "speedMps", heading_deg AS "headingDeg", source, quality_flags AS "qualityFlags", is_demo AS "isDemo"
           FROM location_points WHERE device_id = ANY($1::uuid[]) AND captured_at BETWEEN $2 AND $3
            AND ($4::timestamptz IS NULL OR (captured_at, id) > ($4::timestamptz, $5::bigint))
          ORDER BY captured_at, id LIMIT ${PAGE}`,
        [deviceIds, from, to, after?.[0] ?? null, after?.[1] ?? null],
      );
      if (!rows.length) return;
      yield rows.map(({ captured: _c, ...r }) => r);
      const last = rows[rows.length - 1]!;
      after = [last.captured, last.id];
      if (rows.length < PAGE) return;
    }
  }

  @Get('exports/track')
  async track(@Auth() p: Principal, @Query() q: unknown, @Req() req: Request, @Res() res: Response) {
    const uid = userIdOf(p);
    const f = parse(ExportQuery, q);
    const dev = await this.access.device(uid, f.deviceId);
    const count = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM location_points WHERE device_id = $1 AND captured_at BETWEEN $2 AND $3', [
      f.deviceId, f.from, f.to,
    ]);
    if ((count?.n ?? 0) > this.env.EXPORT_MAX_POINTS) {
      throw new AppError(413, 'EXPORT_TOO_LARGE', `El rango contiene ${count!.n} puntos; el máximo por exportación es ${this.env.EXPORT_MAX_POINTS}. Reducí el rango.`);
    }
    const name = (await this.db.one<{ name: string }>('SELECT name FROM devices WHERE id = $1', [f.deviceId]))!.name;
    const meta: ExportMeta = { deviceId: f.deviceId, deviceName: name, from: f.from, to: f.to, generatedAt: new Date().toISOString(), isDemo: dev.isDemo };
    await this.audit.log({ orgId: dev.orgId, actorUserId: uid, action: `export.track.${f.format}`, targetType: 'device', targetId: f.deviceId, metadata: { from: f.from, to: f.to, points: count?.n }, ...clientMeta(req) });

    const filename = `recorrido-${f.deviceId.slice(0, 8)}-${f.from.slice(0, 10)}${dev.isDemo ? '-DEMO' : ''}.${f.format}`;
    res.status(200).set({ 'Content-Type': CONTENT_TYPES[f.format], 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });

    if (f.format === 'csv') {
      res.write(csvRow(POINT_FIELDS));
      for await (const page of this.pages([f.deviceId], f.from, f.to)) res.write(page.map((pt) => csvRow(POINT_FIELDS.map((k) => pt[k]))).join(''));
      return res.end();
    }
    if (f.format === 'json') {
      res.write(`{"meta":${JSON.stringify(meta)},"points":[`);
      let first = true;
      for await (const page of this.pages([f.deviceId], f.from, f.to)) {
        for (const pt of page) {
          res.write((first ? '' : ',') + JSON.stringify(pt));
          first = false;
        }
      }
      return res.end(']}');
    }
    // GPX/KML/GeoJSON necesitan agrupar tramos: se arman en memoria (acotado por EXPORT_MAX_POINTS).
    const all: ExportPoint[] = [];
    for await (const page of this.pages([f.deviceId], f.from, f.to)) all.push(...page);
    if (f.format === 'gpx') return res.end(toGpx(meta, all));
    if (f.format === 'kml') return res.end(toKml(meta, all));
    return res.end(JSON.stringify(toGeoJson(meta, all)));
  }

  @Get('exports/events')
  async events(@Auth() p: Principal, @Query() q: unknown, @Req() req: Request, @Res() res: Response) {
    const uid = userIdOf(p);
    const f = parse(EventsExportQuery, q);
    let ids = await this.access.visibleDeviceIds(uid);
    if (f.deviceId) {
      if (!ids.includes(f.deviceId)) throw notFound('Dispositivo');
      ids = [f.deviceId];
    }
    const rows = ids.length
      ? await this.db.query<EventRow>(
          `${EVENT_SELECT} WHERE e.device_id = ANY($1::uuid[]) AND e.status = 'active' AND e.occurred_at BETWEEN $2 AND $3 ORDER BY e.occurred_at LIMIT 100000`,
          [ids, f.from, f.to],
        )
      : [];
    await this.audit.log({ actorUserId: uid, action: `export.events.${f.format}`, metadata: { from: f.from, to: f.to, count: rows.length, deviceId: f.deviceId }, ...clientMeta(req) });
    const items = rows.map(toEventDto);
    res.status(200).set({ 'Content-Type': CONTENT_TYPES[f.format], 'Content-Disposition': `attachment; filename="eventos-${f.from.slice(0, 10)}.${f.format}"`, 'Cache-Control': 'no-store' });
    if (f.format === 'json') return res.end(JSON.stringify({ from: f.from, to: f.to, generatedAt: new Date().toISOString(), events: items }));
    const cols = ['id', 'deviceId', 'deviceName', 'type', 'occurredAt', 'endedAt', 'lat', 'lon', 'confidence', 'tripName', 'geofenceName', 'ruleId', 'ruleVersion', 'source', 'isDemo', 'evidence'] as const;
    res.write(csvRow([...cols]));
    for (const e of items) res.write(csvRow(cols.map((c) => e[c])));
    return res.end();
  }

  /** Portabilidad: todos los datos de los dispositivos de los que el usuario es titular. */
  @Get('me/export')
  async mine(@Auth() p: Principal, @Req() req: Request, @Res() res: Response) {
    const uid = userIdOf(p);
    const devices = await this.db.query<{ id: string; name: string; platform: string; created_at: Date }>(
      'SELECT id, name, platform, created_at FROM devices WHERE holder_user_id = $1 AND NOT is_demo',
      [uid],
    );
    const total = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM location_points WHERE device_id = ANY($1::uuid[])', [devices.map((d) => d.id)]);
    if ((total?.n ?? 0) > this.env.EXPORT_MAX_POINTS * 5) throw new AppError(413, 'EXPORT_TOO_LARGE', 'Demasiados datos para una exportación directa; exportá por dispositivo y rango.');
    await this.audit.log({ actorUserId: uid, action: 'export.me', metadata: { devices: devices.length, points: total?.n }, ...clientMeta(req) });
    res.status(200).set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mis-datos.json"', 'Cache-Control': 'no-store' });
    const me = await this.db.one('SELECT id, email, display_name AS "displayName", created_at AS "createdAt" FROM users WHERE id = $1', [uid]);
    const consents = await this.db.query('SELECT device_id AS "deviceId", consent_version AS "version", share_with_org AS "shareWithOrg", granted_at AS "grantedAt", revoked_at AS "revokedAt" FROM device_consents WHERE user_id = $1', [uid]);
    res.write(`{"user":${JSON.stringify(me)},"consents":${JSON.stringify(consents)},"devices":[`);
    for (const [i, d] of devices.entries()) {
      res.write(`${i ? ',' : ''}{"device":${JSON.stringify(d)},"points":[`);
      let first = true;
      for await (const page of this.pages([d.id], '1970-01-01T00:00:00Z', '2999-01-01T00:00:00Z')) {
        for (const pt of page) {
          res.write((first ? '' : ',') + JSON.stringify(pt));
          first = false;
        }
      }
      res.write(']}');
    }
    res.end(']}');
  }
}
