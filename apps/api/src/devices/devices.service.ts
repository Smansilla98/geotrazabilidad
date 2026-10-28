import { Inject, Injectable } from '@nestjs/common';
import { connectionStateFor, DEFAULT_TRACKING_CONFIG, type DeviceSummary, type TrackingConfigResponse } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { ENV, opaqueToken, sha256, signAccess } from '../auth/tokens.js';
import { AppError } from '../common/http.js';
import type { Env } from '../config/env.js';
import { Db, type Queryable } from '../db/db.js';

interface DeviceRow {
  id: string;
  org_id: string;
  name: string;
  platform: string;
  status: 'active' | 'revoked';
  is_demo: boolean;
  holder_id: string;
  holder_name: string;
  app_version: string | null;
  last_contact_at: Date | null;
  client_pending_count: number | null;
  client_reported_at: Date | null;
  last_error: string | null;
  lp_lat: number | null;
  lp_lon: number | null;
  lp_captured_at: Date | null;
  lp_received_at: Date | null;
  lp_accuracy: number | null;
  consent_active: boolean;
  consent_share: boolean | null;
  consent_version: string | null;
  can_manage: boolean;
}

export const DEVICE_SUMMARY_SQL = `
  SELECT d.id, d.org_id, d.name, d.platform, d.status, d.is_demo,
         u.id AS holder_id, u.display_name AS holder_name,
         COALESCE(s.app_version, d.app_version) AS app_version,
         s.last_contact_at, s.client_pending_count, s.client_reported_at, s.last_error,
         lp.lat AS lp_lat, lp.lon AS lp_lon, lp.captured_at AS lp_captured_at, lp.received_at AS lp_received_at, lp.accuracy_m AS lp_accuracy,
         (c.id IS NOT NULL) AS consent_active, c.share_with_org AS consent_share, c.consent_version,
         (d.holder_user_id = $1 OR m.role IN ('owner','admin')) AS can_manage
    FROM devices d
    JOIN users u ON u.id = d.holder_user_id
    LEFT JOIN memberships m ON m.org_id = d.org_id AND m.user_id = $1
    LEFT JOIN device_sync_state s ON s.device_id = d.id
    LEFT JOIN device_consents c ON c.device_id = d.id AND c.revoked_at IS NULL
    LEFT JOIN LATERAL (
      SELECT lat, lon, captured_at, received_at, accuracy_m FROM location_points
       WHERE device_id = d.id AND NOT ('jump' = ANY(quality_flags))
       ORDER BY captured_at DESC LIMIT 1) lp ON true`;

@Injectable()
export class DevicesService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  toSummary(r: DeviceRow, now = new Date()): DeviceSummary {
    // Para dispositivos demo no hay contacto real: nunca se muestran como conectados.
    const lastContact = r.is_demo ? null : r.last_contact_at;
    return {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      platform: r.platform,
      status: r.status,
      isDemo: r.is_demo,
      holder: { id: r.holder_id, displayName: r.holder_name },
      appVersion: r.app_version,
      connectionState: r.status === 'revoked' ? 'offline' : connectionStateFor(lastContact, now),
      lastContactAt: lastContact?.toISOString() ?? null,
      lastPoint:
        r.lp_lat != null && r.lp_captured_at && r.lp_received_at
          ? { lat: r.lp_lat, lon: r.lp_lon!, capturedAt: r.lp_captured_at.toISOString(), receivedAt: r.lp_received_at.toISOString(), accuracyM: r.lp_accuracy }
          : null,
      sync: { clientPendingCount: r.client_pending_count, clientReportedAt: r.client_reported_at?.toISOString() ?? null, lastError: r.last_error },
      consent: { active: r.consent_active, shareWithOrg: !!r.consent_share, version: r.consent_version },
      canManage: r.can_manage,
    };
  }

  async list(userId: string): Promise<DeviceSummary[]> {
    const ids = await this.access.visibleDeviceIds(userId);
    if (!ids.length) return [];
    const rows = await this.db.query<DeviceRow>(`${DEVICE_SUMMARY_SQL} WHERE d.id = ANY($2::uuid[]) ORDER BY d.is_demo, d.name`, [userId, ids]);
    return rows.map((r) => this.toSummary(r));
  }

  async get(userId: string, deviceId: string): Promise<DeviceSummary> {
    await this.access.device(userId, deviceId);
    const r = await this.db.one<DeviceRow>(`${DEVICE_SUMMARY_SQL} WHERE d.id = $2`, [userId, deviceId]);
    return this.toSummary(r!);
  }

  /** Vincula (o re-vincula) un dispositivo físico a la cuenta y emite sus credenciales. */
  async register(
    userId: string,
    input: { orgId?: string; installId: string; name: string; platform: 'android' | 'ios'; appVersion?: string; osVersion?: string; model?: string },
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const orgId = await this.access.resolveOrg(userId, input.orgId, ['owner', 'admin', 'viewer']);
    return this.db.tx(async (c) => {
      const existing = await c.query<{ id: string; holder_user_id: string }>('SELECT id, holder_user_id FROM devices WHERE org_id = $1 AND install_id = $2 FOR UPDATE', [
        orgId,
        input.installId,
      ]);
      let deviceId: string;
      if (existing.rows[0]) {
        if (existing.rows[0].holder_user_id !== userId) throw new AppError(409, 'DEVICE_LINKED_TO_OTHER_USER', 'Esta instalación ya está vinculada a otra cuenta');
        deviceId = existing.rows[0].id;
        await c.query(
          `UPDATE devices SET name = $2, app_version = $3, os_version = $4, model = $5, status = 'active', revoked_at = NULL WHERE id = $1`,
          [deviceId, input.name, input.appVersion ?? null, input.osVersion ?? null, input.model ?? null],
        );
      } else {
        const r = await c.query<{ id: string }>(
          `INSERT INTO devices (org_id, holder_user_id, install_id, name, platform, app_version, os_version, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [orgId, userId, input.installId, input.name, input.platform, input.appVersion ?? null, input.osVersion ?? null, input.model ?? null],
        );
        deviceId = r.rows[0]!.id;
      }
      await c.query(`INSERT INTO device_sync_state (device_id, app_version) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET app_version = EXCLUDED.app_version`, [
        deviceId,
        input.appVersion ?? null,
      ]);
      await c.query(`INSERT INTO device_processing_state (device_id) VALUES ($1) ON CONFLICT DO NOTHING`, [deviceId]);
      // Re-vincular invalida credenciales previas de esa instalación.
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
      await this.audit.log({ orgId, actorUserId: userId, action: existing.rows[0] ? 'device.relink' : 'device.register', targetType: 'device', targetId: deviceId, ...meta }, c);
      return { deviceId, ...(await this.issueDeviceTokens(deviceId, userId, crypto.randomUUID(), c)) };
    });
  }

  async issueDeviceTokens(deviceId: string, userId: string, familyId: string, q: Queryable = this.db.pool) {
    const refresh = opaqueToken();
    await q.query(
      `INSERT INTO refresh_tokens (user_id, device_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [userId, deviceId, familyId, sha256(refresh), this.env.DEVICE_REFRESH_TTL_DAYS],
    );
    return {
      deviceToken: await signAccess(this.env.JWT_SECRET, { sub: deviceId, typ: 'device', uid: userId }, this.env.JWT_ACCESS_TTL_S),
      deviceRefreshToken: refresh,
      expiresIn: this.env.JWT_ACCESS_TTL_S,
    };
  }

  async refreshDeviceToken(deviceId: string, token: string) {
    const r = await this.auth.refresh(token, deviceId);
    const d = await this.db.one<{ status: string }>('SELECT status FROM devices WHERE id = $1', [deviceId]);
    if (!d || d.status !== 'active') throw new AppError(403, 'DEVICE_REVOKED', 'El acceso de este dispositivo fue revocado');
    return { deviceId, ...(await this.issueDeviceTokens(deviceId, r.userId, r.familyId)) };
  }

  async rename(userId: string, deviceId: string, name: string) {
    await this.access.manageableDevice(userId, deviceId);
    await this.db.query('UPDATE devices SET name = $2 WHERE id = $1', [deviceId, name]);
    return this.get(userId, deviceId);
  }

  async revoke(userId: string, deviceId: string, meta: { ip: string | null; userAgent: string | null }) {
    const d = await this.access.manageableDevice(userId, deviceId);
    await this.db.tx(async (c) => {
      await c.query(`UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1 AND status = 'active'`, [deviceId]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
      await c.query(`UPDATE tracking_sessions SET ended_at = now(), end_reason = 'device_revoked' WHERE device_id = $1 AND ended_at IS NULL`, [deviceId]);
      await this.audit.log({ orgId: d.orgId, actorUserId: userId, action: 'device.revoke', targetType: 'device', targetId: deviceId, ...meta }, c);
    });
    return this.get(userId, deviceId);
  }

  /** Borrado físico con todo su historial (sesiones, puntos, eventos). */
  async remove(userId: string, deviceId: string, meta: { ip: string | null; userAgent: string | null }) {
    const d = await this.access.manageableDevice(userId, deviceId);
    await this.db.tx(async (c) => {
      const counts = await c.query<{ points: number }>('SELECT count(*)::int AS points FROM location_points WHERE device_id = $1', [deviceId]);
      await c.query('DELETE FROM devices WHERE id = $1', [deviceId]);
      await this.audit.log(
        { orgId: d.orgId, actorUserId: userId, action: 'device.delete', targetType: 'device', targetId: deviceId, metadata: { deletedPoints: counts.rows[0]?.points ?? 0 }, ...meta },
        c,
      );
    });
  }

  /** Solo el titular otorga o revoca consentimiento: es su ubicación. */
  async setConsent(userId: string, deviceId: string, version: string, shareWithOrg: boolean, meta: { ip: string | null; userAgent: string | null }) {
    const d = await this.access.device(userId, deviceId);
    if (d.holderUserId !== userId) throw new AppError(403, 'HOLDER_ONLY', 'Solo el titular del dispositivo puede otorgar el consentimiento');
    await this.db.tx(async (c) => {
      await c.query('UPDATE device_consents SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
      await c.query('INSERT INTO device_consents (device_id, user_id, consent_version, share_with_org) VALUES ($1, $2, $3, $4)', [deviceId, userId, version, shareWithOrg]);
      await this.audit.log({ orgId: d.orgId, actorUserId: userId, action: 'device.consent_granted', targetType: 'device', targetId: deviceId, metadata: { version, shareWithOrg }, ...meta }, c);
    });
    return this.get(userId, deviceId);
  }

  async revokeConsent(userId: string, deviceId: string, meta: { ip: string | null; userAgent: string | null }) {
    const d = await this.access.device(userId, deviceId);
    if (d.holderUserId !== userId) throw new AppError(403, 'HOLDER_ONLY', 'Solo el titular del dispositivo puede revocar el consentimiento');
    await this.db.tx(async (c) => {
      await c.query('UPDATE device_consents SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
      await c.query(`UPDATE tracking_sessions SET ended_at = now(), end_reason = 'consent_revoked' WHERE device_id = $1 AND ended_at IS NULL`, [deviceId]);
      await this.audit.log({ orgId: d.orgId, actorUserId: userId, action: 'device.consent_revoked', targetType: 'device', targetId: deviceId, ...meta }, c);
    });
  }

  async trackingConfig(deviceId: string): Promise<TrackingConfigResponse> {
    const r = await this.db.one<{ version: number; params: TrackingConfigResponse['modes'] }>(
      'SELECT t.version, t.params FROM tracking_configs t JOIN devices d ON d.org_id = t.org_id WHERE d.id = $1',
      [deviceId],
    );
    return r ? { version: r.version, modes: r.params } : { version: 0, modes: DEFAULT_TRACKING_CONFIG };
  }

  async heartbeat(
    deviceId: string,
    b: { pendingCount: number; permission: string; trackingActive: boolean; batteryLevel?: number | null; appVersion?: string; lastError?: string | null },
  ) {
    await this.db.query(
      `INSERT INTO device_sync_state (device_id, last_contact_at, client_pending_count, client_reported_at, permission, tracking_active, battery_level, app_version, last_error)
       VALUES ($1, now(), $2, now(), $3, $4, $5, $6, $7)
       ON CONFLICT (device_id) DO UPDATE SET last_contact_at = now(), client_pending_count = $2, client_reported_at = now(), permission = $3,
         tracking_active = $4, battery_level = $5, app_version = COALESCE($6, device_sync_state.app_version), last_error = $7`,
      [deviceId, b.pendingCount, b.permission, b.trackingActive, b.batteryLevel ?? null, b.appVersion ?? null, b.lastError ?? null],
    );
    const cfg = await this.trackingConfig(deviceId);
    const consent = await this.db.one<{ id: string }>('SELECT id FROM device_consents WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
    return { serverTime: new Date().toISOString(), configVersion: cfg.version, consentActive: !!consent };
  }
}
