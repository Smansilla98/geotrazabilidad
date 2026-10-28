import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AddMemberRequest, DEFAULT_TRACKING_CONFIG, OrgRole, TrackingConfigParams, TrackingMode, UpdateOrgRequest, Uuid } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Auth, clientMeta, notFound, parse, userIdOf, type Principal } from '../common/http.js';
import { Db } from '../db/db.js';

const TrackingConfigUpdate = z.object({ modes: z.record(TrackingMode, TrackingConfigParams) });

@Controller('v1/orgs')
export class OrgsController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Get(':orgId/members')
  async members(@Auth() p: Principal, @Param('orgId') orgId: string) {
    const uid = userIdOf(p);
    await this.access.requireRole(uid, parse(Uuid, orgId), ['owner', 'admin', 'viewer']);
    return this.db.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", m.role, m.created_at AS "joinedAt"
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
      [orgId],
    );
  }

  /** Agrega un usuario existente por email. Solo owner/admin; solo owner puede otorgar owner. */
  @Post(':orgId/members')
  async addMember(@Auth() p: Principal, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    const role = await this.access.requireRole(uid, parse(Uuid, orgId), ['owner', 'admin']);
    const b = parse(AddMemberRequest, body);
    if (b.role === 'owner' && role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Solo un owner puede designar otro owner');
    const u = await this.db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [b.email.toLowerCase()]);
    if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'No existe una cuenta con ese email. La persona debe registrarse primero.');
    await this.db.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, u.id, b.role],
    );
    await this.audit.log({ orgId, actorUserId: uid, action: 'org.member_upsert', targetType: 'user', targetId: u.id, metadata: { role: b.role }, ...clientMeta(req) });
    return { userId: u.id, role: b.role };
  }

  @Patch(':orgId/members/:userId')
  async changeRole(@Auth() p: Principal, @Param('orgId') orgId: string, @Param('userId') target: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    await this.access.requireRole(uid, parse(Uuid, orgId), ['owner']);
    const { role } = parse(z.object({ role: OrgRole }), body);
    await this.ensureNotLastOwner(orgId, parse(Uuid, target), role);
    const r = await this.db.query('UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2 RETURNING user_id', [orgId, target, role]);
    if (!r.length) throw notFound('Miembro');
    await this.audit.log({ orgId, actorUserId: uid, action: 'org.member_role', targetType: 'user', targetId: target, metadata: { role }, ...clientMeta(req) });
    return { userId: target, role };
  }

  @Delete(':orgId/members/:userId')
  @HttpCode(204)
  async removeMember(@Auth() p: Principal, @Param('orgId') orgId: string, @Param('userId') target: string, @Req() req: Request) {
    const uid = userIdOf(p);
    // Cualquier miembro puede salir; quitar a otros requiere owner/admin.
    await this.access.requireRole(uid, parse(Uuid, orgId), target === uid ? ['owner', 'admin', 'viewer'] : ['owner', 'admin']);
    await this.ensureNotLastOwner(orgId, parse(Uuid, target), null);
    await this.db.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, target]);
    await this.audit.log({ orgId, actorUserId: uid, action: 'org.member_remove', targetType: 'user', targetId: target, ...clientMeta(req) });
  }

  @Patch(':orgId')
  async update(@Auth() p: Principal, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    await this.access.requireRole(uid, parse(Uuid, orgId), ['owner']);
    const b = parse(UpdateOrgRequest, body);
    const r = await this.db.one(
      `UPDATE organizations SET name = COALESCE($2, name), retention_days = COALESCE($3, retention_days) WHERE id = $1
       RETURNING id, name, retention_days AS "retentionDays"`,
      [orgId, b.name ?? null, b.retentionDays ?? null],
    );
    await this.audit.log({ orgId, actorUserId: uid, action: 'org.update', metadata: b, ...clientMeta(req) });
    return r;
  }

  @Get(':orgId/tracking-config')
  async getConfig(@Auth() p: Principal, @Param('orgId') orgId: string) {
    await this.access.requireRole(userIdOf(p), parse(Uuid, orgId), ['owner', 'admin', 'viewer']);
    const r = await this.db.one<{ version: number; params: unknown }>('SELECT version, params FROM tracking_configs WHERE org_id = $1', [orgId]);
    return r ? { version: r.version, modes: r.params } : { version: 0, modes: DEFAULT_TRACKING_CONFIG };
  }

  @Put(':orgId/tracking-config')
  async putConfig(@Auth() p: Principal, @Param('orgId') orgId: string, @Body() body: unknown, @Req() req: Request) {
    const uid = userIdOf(p);
    await this.access.requireRole(uid, parse(Uuid, orgId), ['owner', 'admin']);
    const b = parse(TrackingConfigUpdate, body);
    const r = await this.db.one<{ version: number }>(
      `INSERT INTO tracking_configs (org_id, name, params, version) VALUES ($1, 'default', $2, 1)
       ON CONFLICT (org_id) DO UPDATE SET params = EXCLUDED.params, version = tracking_configs.version + 1, updated_at = now()
       RETURNING version`,
      [orgId, JSON.stringify(b.modes)],
    );
    await this.audit.log({ orgId, actorUserId: uid, action: 'org.tracking_config', metadata: { version: r?.version }, ...clientMeta(req) });
    return { version: r!.version, modes: b.modes };
  }

  private async ensureNotLastOwner(orgId: string, userId: string, newRole: string | null) {
    if (newRole === 'owner') return;
    const r = await this.db.one<{ owners: number; is_owner: boolean }>(
      `SELECT count(*) FILTER (WHERE role = 'owner')::int AS owners, bool_or(user_id = $2 AND role = 'owner') AS is_owner FROM memberships WHERE org_id = $1`,
      [orgId, userId],
    );
    if (r?.is_owner && r.owners <= 1) throw new AppError(409, 'LAST_OWNER', 'La organización debe conservar al menos un owner');
  }
}
