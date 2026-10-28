import { Injectable } from '@nestjs/common';
import type { OrgRole } from '@geo/shared';
import { forbidden, notFound } from '../common/http.js';
import { Db, type Queryable } from '../db/db.js';

/**
 * Única fuente de verdad de la autorización sobre datos de ubicación.
 *
 * Un usuario ve las posiciones de un dispositivo si:
 *  - es su titular, o
 *  - es miembro (owner/admin/viewer) de la organización del dispositivo y el titular tiene un
 *    consentimiento vigente con share_with_org = true, o el dispositivo es de demostración.
 * Puede administrarlo (renombrar, revocar, borrar) si es titular u owner/admin de la organización.
 *
 * Un id ajeno o inexistente produce 404 (no 403) para no confirmar su existencia.
 */
export const VISIBLE_DEVICES_SQL = `
  SELECT d.id FROM devices d
  LEFT JOIN memberships m ON m.org_id = d.org_id AND m.user_id = $1
  LEFT JOIN device_consents c ON c.device_id = d.id AND c.revoked_at IS NULL
  WHERE d.holder_user_id = $1
     OR (m.user_id IS NOT NULL AND (c.share_with_org IS TRUE OR d.is_demo))`;

export interface DeviceAccess {
  id: string;
  orgId: string;
  holderUserId: string;
  isDemo: boolean;
  status: string;
  canManage: boolean;
  role: OrgRole | null;
}

@Injectable()
export class AccessService {
  constructor(private readonly db: Db) {}

  async visibleDeviceIds(userId: string, q: Queryable = this.db.pool): Promise<string[]> {
    const r = await q.query<{ id: string }>(VISIBLE_DEVICES_SQL, [userId]);
    return r.rows.map((x) => x.id);
  }

  async role(userId: string, orgId: string): Promise<OrgRole | null> {
    const r = await this.db.one<{ role: OrgRole }>('SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2', [userId, orgId]);
    return r?.role ?? null;
  }

  /** Verifica un rol mínimo en la organización. 404 si no es miembro. */
  async requireRole(userId: string, orgId: string, roles: OrgRole[]): Promise<OrgRole> {
    const role = await this.role(userId, orgId);
    if (!role) throw notFound('Organización');
    if (!roles.includes(role)) throw forbidden();
    return role;
  }

  /** Organización por defecto para crear recursos: la indicada (si es miembro) o la primera propia. */
  async resolveOrg(userId: string, orgId: string | undefined, roles: OrgRole[]): Promise<string> {
    if (orgId) {
      await this.requireRole(userId, orgId, roles);
      return orgId;
    }
    const r = await this.db.one<{ org_id: string }>(
      `SELECT org_id FROM memberships WHERE user_id = $1 AND role = ANY($2::org_role[]) ORDER BY (role = 'owner') DESC, created_at LIMIT 1`,
      [userId, roles],
    );
    if (!r) throw forbidden('No tenés una organización con permisos suficientes');
    return r.org_id;
  }

  async device(userId: string, deviceId: string): Promise<DeviceAccess> {
    const r = await this.db.one<{ id: string; org_id: string; holder_user_id: string; is_demo: boolean; status: string; role: OrgRole | null; visible: boolean }>(
      `SELECT d.id, d.org_id, d.holder_user_id, d.is_demo, d.status, m.role,
              (d.id IN (${VISIBLE_DEVICES_SQL})) AS visible
         FROM devices d LEFT JOIN memberships m ON m.org_id = d.org_id AND m.user_id = $1
        WHERE d.id = $2`,
      [userId, deviceId],
    );
    if (!r || !r.visible) throw notFound('Dispositivo');
    return {
      id: r.id,
      orgId: r.org_id,
      holderUserId: r.holder_user_id,
      isDemo: r.is_demo,
      status: r.status,
      role: r.role,
      canManage: r.holder_user_id === userId || r.role === 'owner' || r.role === 'admin',
    };
  }

  async manageableDevice(userId: string, deviceId: string): Promise<DeviceAccess> {
    const d = await this.device(userId, deviceId);
    if (!d.canManage) throw forbidden();
    return d;
  }

  /** Viajes/geocercas: lectura para miembros; escritura para owner/admin. */
  async orgResource(userId: string, table: 'trips' | 'geofences', id: string, write: boolean): Promise<{ orgId: string; role: OrgRole }> {
    const r = await this.db.one<{ org_id: string; role: OrgRole | null }>(
      `SELECT t.org_id, m.role FROM ${table} t LEFT JOIN memberships m ON m.org_id = t.org_id AND m.user_id = $1 WHERE t.id = $2`,
      [userId, id],
    );
    if (!r || !r.role) throw notFound(table === 'trips' ? 'Viaje' : 'Geocerca');
    if (write && r.role === 'viewer') throw forbidden();
    return { orgId: r.org_id, role: r.role };
  }
}
