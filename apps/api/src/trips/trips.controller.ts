import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { compareTrip, DEFAULT_RULE_PARAMS, RouteRequest, TripInput, TripStatus, TripUpdate, Uuid, type TripDto } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Auth, clientMeta, parse, userIdOf, type Principal } from '../common/http.js';
import { Db } from '../db/db.js';
import { pointColumns, Processor, timingFor, toObserved } from '../processing/processor.js';
import { RoutingService } from '../routing/routing.js';

interface Row {
  id: string; org_id: string; device_id: string | null; device_name: string | null; name: string; origin: string; origin_label: string | null;
  destination: string; destination_label: string | null; arrival_radius_m: number; planned_start_at: Date | null; planned_arrival_at: Date | null;
  status: TripDto['status']; actual_start_at: Date | null; actual_end_at: Date | null; notes: string | null; created_at: Date;
  r_id: string | null; r_provider: string | null; r_profile: string | null; r_distance: number | null; r_duration: number | null;
  r_kind: 'provider_no_traffic' | 'provider_with_traffic' | 'basic_estimate' | null; r_geom: string | null; r_computed: Date | null; r_meta: Record<string, unknown> | null;
}

const SELECT = `
  SELECT t.id, t.org_id, t.device_id, d.name AS device_name, t.name, ST_AsGeoJSON(t.origin) AS origin, t.origin_label,
         ST_AsGeoJSON(t.destination) AS destination, t.destination_label, t.arrival_radius_m, t.planned_start_at, t.planned_arrival_at,
         t.status, t.actual_start_at, t.actual_end_at, t.notes, t.created_at,
         r.id AS r_id, r.provider AS r_provider, r.profile AS r_profile, r.distance_m AS r_distance, r.duration_s AS r_duration,
         r.duration_kind AS r_kind, ST_AsGeoJSON(r.geom) AS r_geom, r.computed_at AS r_computed, r.provider_meta AS r_meta
    FROM trips t LEFT JOIN devices d ON d.id = t.device_id
    LEFT JOIN planned_routes r ON r.trip_id = t.id AND r.is_current`;

const pt = (s: string) => (([lon, lat]: [number, number]) => ({ lon, lat }))(JSON.parse(s).coordinates);

const toDto = (r: Row): TripDto => ({
  id: r.id,
  orgId: r.org_id,
  deviceId: r.device_id,
  deviceName: r.device_name,
  name: r.name,
  origin: pt(r.origin),
  originLabel: r.origin_label,
  destination: pt(r.destination),
  destinationLabel: r.destination_label,
  arrivalRadiusM: r.arrival_radius_m,
  plannedStartAt: r.planned_start_at?.toISOString() ?? null,
  plannedArrivalAt: r.planned_arrival_at?.toISOString() ?? null,
  status: r.status,
  actualStartAt: r.actual_start_at?.toISOString() ?? null,
  actualEndAt: r.actual_end_at?.toISOString() ?? null,
  notes: r.notes,
  route: r.r_id
    ? {
        id: r.r_id,
        provider: r.r_provider!,
        profile: r.r_profile!,
        distanceM: r.r_distance!,
        durationS: r.r_duration,
        durationKind: r.r_kind!,
        coordinates: JSON.parse(r.r_geom!).coordinates,
        computedAt: r.r_computed!.toISOString(),
        attribution: (r.r_meta?.attribution as string | undefined) ?? null,
      }
    : null,
  createdAt: r.created_at.toISOString(),
});

const ListQuery = z.object({ orgId: Uuid.optional(), status: TripStatus.optional(), deviceId: Uuid.optional() });
const RouteBody = RouteRequest.extend({ provider: z.enum(['configured', 'straight_line']).default('configured') });

@Controller('v1/trips')
export class TripsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly routing: RoutingService,
    private readonly processor: Processor,
  ) {}

  @Get()
  async list(@Auth() p: Principal, @Query() q: unknown) {
    const uid = userIdOf(p);
    const f = parse(ListQuery, q);
    const rows = await this.db.query<Row>(
      `${SELECT} WHERE t.org_id IN (SELECT org_id FROM memberships WHERE user_id = $1)
         AND ($2::uuid IS NULL OR t.org_id = $2) AND ($3::trip_status IS NULL OR t.status = $3) AND ($4::uuid IS NULL OR t.device_id = $4)
       ORDER BY COALESCE(t.planned_start_at, t.created_at) DESC LIMIT 500`,
      [uid, f.orgId ?? null, f.status ?? null, f.deviceId ?? null],
    );
    return rows.map(toDto);
  }

  @Get(':id')
  async get(@Auth() p: Principal, @Param('id') id: string) {
    await this.access.orgResource(userIdOf(p), 'trips', parse(Uuid, id), false);
    return toDto((await this.db.one<Row>(`${SELECT} WHERE t.id = $1`, [id]))!);
  }

  @Post()
  async create(@Auth() p: Principal, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    const t = parse(TripInput, body);
    const orgId = await this.access.resolveOrg(uid, t.orgId, ['owner', 'admin']);
    if (t.deviceId) await this.assertDeviceInOrg(uid, t.deviceId, orgId);
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO trips (org_id, device_id, name, origin, origin_label, destination, destination_label, arrival_radius_m, planned_start_at, planned_arrival_at, notes, created_by)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        orgId, t.deviceId ?? null, t.name, t.origin.lon, t.origin.lat, t.originLabel ?? null, t.destination.lon, t.destination.lat, t.destinationLabel ?? null,
        t.arrivalRadiusM, t.plannedStartAt ?? null, t.plannedArrivalAt ?? null, t.notes ?? null, uid,
      ],
    );
    await this.audit.log({ orgId, actorUserId: uid, action: 'trip.create', targetType: 'trip', targetId: r!.id, ...clientMeta(req) });
    return toDto((await this.db.one<Row>(`${SELECT} WHERE t.id = $1`, [r!.id]))!);
  }

  @Patch(':id')
  async update(@Auth() p: Principal, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    const { orgId } = await this.access.orgResource(uid, 'trips', parse(Uuid, id), true);
    const b = parse(TripUpdate, body);
    if (b.deviceId) await this.assertDeviceInOrg(uid, b.deviceId, orgId);
    await this.db.query(
      `UPDATE trips SET name = COALESCE($2, name),
         device_id = CASE WHEN $3::boolean THEN $4::uuid ELSE device_id END,
         status = COALESCE($5::trip_status, status),
         actual_end_at = CASE WHEN $5::trip_status IN ('cancelled','completed','interrupted') THEN COALESCE(actual_end_at, now()) ELSE actual_end_at END,
         planned_start_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE planned_start_at END,
         planned_arrival_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE planned_arrival_at END,
         notes = CASE WHEN $10::boolean THEN $11 ELSE notes END
       WHERE id = $1`,
      [
        id, b.name ?? null, b.deviceId !== undefined, b.deviceId ?? null, b.status ?? null,
        b.plannedStartAt !== undefined, b.plannedStartAt ?? null, b.plannedArrivalAt !== undefined, b.plannedArrivalAt ?? null, b.notes !== undefined, b.notes ?? null,
      ],
    );
    await this.audit.log({ orgId, actorUserId: uid, action: 'trip.update', targetType: 'trip', targetId: id, metadata: { status: b.status }, ...clientMeta(req) });
    return toDto((await this.db.one<Row>(`${SELECT} WHERE t.id = $1`, [id]))!);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Auth() p: Principal, @Param('id') id: string, @Req() req: Request) {
    const uid = userIdOf(p);
    const { orgId } = await this.access.orgResource(uid, 'trips', parse(Uuid, id), true);
    await this.db.query('DELETE FROM trips WHERE id = $1', [id]);
    await this.audit.log({ orgId, actorUserId: uid, action: 'trip.delete', targetType: 'trip', targetId: id, ...clientMeta(req) });
  }

  /** Calcula y guarda la ruta estimada con el proveedor configurado (o línea recta, explícitamente). */
  @Post(':id/route')
  async route(@Auth() p: Principal, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    const { orgId } = await this.access.orgResource(uid, 'trips', parse(Uuid, id), true);
    const b = parse(RouteBody, body ?? {});
    const trip = (await this.db.one<Row>(`${SELECT} WHERE t.id = $1`, [id]))!;
    const r = await this.routing.route(pt(trip.origin), pt(trip.destination), b.profile, b.provider);
    await this.db.tx(async (c) => {
      await c.query('UPDATE planned_routes SET is_current = false WHERE trip_id = $1 AND is_current', [id]);
      await c.query(
        `INSERT INTO planned_routes (trip_id, provider, profile, geom, distance_m, duration_s, duration_kind, provider_meta)
         VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5, $6, $7, $8)`,
        [id, r.provider, r.profile, JSON.stringify({ type: 'LineString', coordinates: r.coordinates }), r.distanceM, r.durationS, r.durationKind, r.meta],
      );
    });
    await this.audit.log({ orgId, actorUserId: uid, action: 'trip.route', targetType: 'trip', targetId: id, metadata: { provider: r.provider }, ...clientMeta(req) });
    await this.processor.markTripSessions(id);
    return toDto((await this.db.one<Row>(`${SELECT} WHERE t.id = $1`, [id]))!);
  }

  @Get(':id/comparison')
  async comparison(@Auth() p: Principal, @Param('id') id: string) {
    const uid = userIdOf(p);
    await this.access.orgResource(uid, 'trips', parse(Uuid, id), false);
    const trip = (await this.db.one<Row>(`${SELECT} WHERE t.id = $1`, [id]))!;
    const sessions = await this.db.query<{ id: string; device_id: string; mode: 'normal'; config_snapshot: unknown }>(
      'SELECT id, device_id, mode, config_snapshot FROM tracking_sessions WHERE trip_id = $1',
      [id],
    );
    // La comparación solo usa posiciones de dispositivos que el usuario puede ver.
    const visible = new Set(await this.access.visibleDeviceIds(uid));
    const allowed = sessions.filter((s) => visible.has(s.device_id));
    const points = allowed.length
      ? (await this.db.query<Parameters<typeof toObserved>[0]>(`SELECT ${pointColumns()} FROM location_points WHERE session_id = ANY($1::uuid[]) ORDER BY captured_at, seq`, [allowed.map((s) => s.id)])).map(toObserved)
      : [];
    const arrival = await this.db.one<{ confidence: 'confirmed' | 'probable' | 'possible'; occurred_at: Date }>(
      `SELECT confidence, occurred_at FROM tracking_events WHERE trip_id = $1 AND type = 'arrival' AND status = 'active' ORDER BY occurred_at LIMIT 1`,
      [id],
    );
    const dto = toDto(trip);
    return compareTrip({
      tripId: id,
      points,
      planned: dto.route
        ? {
            provider: dto.route.provider,
            distanceM: dto.route.distanceM,
            durationS: dto.route.durationS,
            durationKind: dto.route.durationKind,
            computedAt: dto.route.computedAt,
            coordinates: dto.route.coordinates.map(([lon, lat]) => ({ lon, lat })),
          }
        : null,
      arrival: arrival ? { confidence: arrival.confidence, at: arrival.occurred_at.getTime() } : null,
      timing: allowed[0] ? timingFor(allowed[0].mode, allowed[0].config_snapshot) : undefined,
      params: DEFAULT_RULE_PARAMS,
    });
  }

  /** Progreso para la app y paneles: subconjunto de la comparación (misma fuente de cálculo). */
  @Get(':id/progress')
  async progress(@Auth() p: Principal, @Param('id') id: string) {
    const c = await this.comparison(p, id);
    return {
      tripId: id,
      progress: c.progress,
      observed: c.observed,
      arrival: c.arrival,
      activeDeviation: c.deviations.find((d) => d.status === 'confirmed' && d.endAt === c.observed.endedAt) ?? null,
      deviations: c.deviations.filter((d) => d.status === 'confirmed').length,
    };
  }

  private async assertDeviceInOrg(userId: string, deviceId: string, orgId: string) {
    const d = await this.access.device(userId, deviceId);
    if (d.orgId !== orgId) throw new AppError(400, 'DEVICE_OTHER_ORG', 'El dispositivo pertenece a otra organización');
  }
}
