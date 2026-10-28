import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { GeofenceInput, Uuid, type GeofenceDto } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Auth, clientMeta, notFound, parse, userIdOf, type Principal } from '../common/http.js';
import { Db } from '../db/db.js';
import { Processor } from '../processing/processor.js';

interface Row {
  id: string; org_id: string; name: string; kind: GeofenceDto['kind']; shape: 'circle' | 'polygon'; center: string | null; radius_m: number | null;
  polygon: string | null; enter_dwell_s: number; exit_dwell_s: number; hysteresis_m: number; active: boolean; created_at: Date;
}
const SELECT = `SELECT id, org_id, name, kind, shape, ST_AsGeoJSON(center) AS center, radius_m, ST_AsGeoJSON(polygon) AS polygon,
  enter_dwell_s, exit_dwell_s, hysteresis_m, active, created_at FROM geofences`;

const toDto = (r: Row): GeofenceDto => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  kind: r.kind,
  shape: r.shape,
  center: r.center ? (([lon, lat]) => ({ lon, lat }))(JSON.parse(r.center).coordinates) : null,
  radiusM: r.radius_m,
  polygon: r.polygon ? JSON.parse(r.polygon).coordinates : null,
  enterDwellS: r.enter_dwell_s,
  exitDwellS: r.exit_dwell_s,
  hysteresisM: r.hysteresis_m,
  active: r.active,
  createdAt: r.created_at.toISOString(),
});

@Controller('v1/geofences')
export class GeofencesController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly processor: Processor,
  ) {}

  @Get()
  async list(@Auth() p: Principal, @Query() q: unknown) {
    const uid = userIdOf(p);
    const { orgId } = parse(z.object({ orgId: Uuid.optional() }), q);
    const rows = await this.db.query<Row>(
      `${SELECT} WHERE org_id IN (SELECT org_id FROM memberships WHERE user_id = $1) AND ($2::uuid IS NULL OR org_id = $2) ORDER BY name`,
      [uid, orgId ?? null],
    );
    return rows.map(toDto);
  }

  @Get(':id')
  async get(@Auth() p: Principal, @Param('id') id: string) {
    await this.access.orgResource(userIdOf(p), 'geofences', parse(Uuid, id), false);
    return toDto((await this.db.one<Row>(`${SELECT} WHERE id = $1`, [id]))!);
  }

  @Post()
  async create(@Auth() p: Principal, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    const g = parse(GeofenceInput, body);
    const orgId = await this.access.resolveOrg(uid, g.orgId, ['owner', 'admin']);
    const id = await this.write(null, orgId, uid, g);
    await this.audit.log({ orgId, actorUserId: uid, action: 'geofence.create', targetType: 'geofence', targetId: id, ...clientMeta(req) });
    await this.processor.markOrgOpenSessions(orgId);
    return toDto((await this.db.one<Row>(`${SELECT} WHERE id = $1`, [id]))!);
  }

  @Put(':id')
  async update(@Auth() p: Principal, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    const { orgId } = await this.access.orgResource(uid, 'geofences', parse(Uuid, id), true);
    const g = parse(GeofenceInput, body);
    await this.write(id, orgId, uid, g);
    await this.audit.log({ orgId, actorUserId: uid, action: 'geofence.update', targetType: 'geofence', targetId: id, ...clientMeta(req) });
    await this.processor.markOrgOpenSessions(orgId);
    return toDto((await this.db.one<Row>(`${SELECT} WHERE id = $1`, [id]))!);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Auth() p: Principal, @Param('id') id: string, @Req() req: Request) {
    const uid = userIdOf(p);
    const { orgId } = await this.access.orgResource(uid, 'geofences', parse(Uuid, id), true);
    await this.db.query('DELETE FROM geofences WHERE id = $1', [id]);
    await this.audit.log({ orgId, actorUserId: uid, action: 'geofence.delete', targetType: 'geofence', targetId: id, ...clientMeta(req) });
  }

  private async write(id: string | null, orgId: string, userId: string, g: z.infer<typeof GeofenceInput>): Promise<string> {
    const center = g.shape === 'circle' && g.center ? JSON.stringify({ type: 'Point', coordinates: [g.center.lon, g.center.lat] }) : null;
    const polygon = g.shape === 'polygon' && g.polygon ? JSON.stringify({ type: 'Polygon', coordinates: g.polygon }) : null;
    if (polygon) {
      const v = await this.db.one<{ valid: boolean; reason: string }>(
        `SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) x`,
        [polygon],
      );
      if (!v?.valid) throw new AppError(400, 'INVALID_POLYGON', `Polígono inválido: ${v?.reason ?? 'desconocido'}`);
    }
    const params = [orgId, g.name, g.kind, g.shape, center, g.shape === 'circle' ? g.radiusM : null, polygon, g.enterDwellS, g.exitDwellS, g.hysteresisM, g.active];
    const geo = `ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6, ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)`;
    if (!id) {
      const r = await this.db.one<{ id: string }>(
        `INSERT INTO geofences (org_id, name, kind, shape, center, radius_m, polygon, enter_dwell_s, exit_dwell_s, hysteresis_m, active, created_by)
         VALUES ($1, $2, $3, $4, ${geo}, $8, $9, $10, $11, $12) RETURNING id`,
        [...params, userId],
      );
      return r!.id;
    }
    const r = await this.db.query(
      `UPDATE geofences SET name = $2, kind = $3, shape = $4, center = ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), radius_m = $6,
         polygon = ST_SetSRID(ST_GeomFromGeoJSON($7), 4326), enter_dwell_s = $8, exit_dwell_s = $9, hysteresis_m = $10, active = $11
       WHERE id = $12 AND org_id = $1 RETURNING id`,
      [...params, id],
    );
    if (!r.length) throw notFound('Geocerca');
    return id;
  }
}
