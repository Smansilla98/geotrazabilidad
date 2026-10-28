import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import type { MeResponse, TokenPair } from '@geo/shared';
import { AppError } from '../common/http.js';
import type { Env } from '../config/env.js';
import { Db, type Queryable } from '../db/db.js';
import { logger } from '../logger.js';
import { Mailer } from '../mail/mailer.js';
import { AuditService } from '../audit/audit.service.js';
import { ENV, opaqueToken, sha256, signAccess } from './tokens.js';

const REUSE_GRACE_MS = 60_000;
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Hash fijo para igualar tiempos cuando el email no existe (evita enumeración por timing). */
let dummyHash: Promise<string> | null = null;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  async register(email: string, password: string, displayName: string, meta: { ip: string | null; userAgent: string | null }): Promise<TokenPair> {
    const hash = await argon2.hash(password, ARGON);
    const userId = await this.db.tx(async (c) => {
      const exists = await c.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rowCount) throw new AppError(409, 'EMAIL_TAKEN', 'Ya existe una cuenta con ese email');
      const u = await c.query<{ id: string }>('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id', [email, hash, displayName]);
      const id = u.rows[0]!.id;
      const o = await c.query<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [`Organización de ${displayName}`]);
      await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [o.rows[0]!.id, id]);
      await this.audit.log({ orgId: o.rows[0]!.id, actorUserId: id, action: 'user.register', targetType: 'user', targetId: id, ...meta }, c);
      return id;
    });
    return this.issueUserTokens(userId, randomUUID());
  }

  async login(email: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<TokenPair> {
    const u = await this.db.one<{ id: string; password_hash: string; disabled_at: Date | null }>('SELECT id, password_hash, disabled_at FROM users WHERE email = $1', [email]);
    if (!u) {
      dummyHash ??= argon2.hash('timing-equalizer-password', ARGON);
      await argon2.verify(await dummyHash, password).catch(() => false);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email o contraseña incorrectos');
    }
    const ok = await argon2.verify(u.password_hash, password).catch(() => false);
    if (!ok || u.disabled_at) {
      await this.audit.log({ actorUserId: u.id, action: 'auth.login_failed', ...meta });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email o contraseña incorrectos');
    }
    await this.audit.log({ actorUserId: u.id, action: 'auth.login', ...meta });
    return this.issueUserTokens(u.id, randomUUID());
  }

  async issueUserTokens(userId: string, familyId: string, q: Queryable = this.db.pool): Promise<TokenPair> {
    const refresh = opaqueToken();
    await q.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [userId, familyId, sha256(refresh), this.env.REFRESH_TTL_DAYS],
    );
    return {
      accessToken: await signAccess(this.env.JWT_SECRET, { sub: userId, typ: 'user' }, this.env.JWT_ACCESS_TTL_S),
      refreshToken: refresh,
      expiresIn: this.env.JWT_ACCESS_TTL_S,
    };
  }

  /**
   * Rotación: cada refresh se usa una sola vez. Si se presenta uno ya rotado (posible robo),
   * se revoca toda la familia y se obliga a iniciar sesión de nuevo.
   */
  async refresh(token: string, expectDevice: string | null = null): Promise<{ userId: string; deviceId: string | null; familyId: string }> {
    const result = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string; user_id: string; device_id: string | null; family_id: string; expires_at: Date; revoked_at: Date | null; replaced_at: Date | null }>(
        'SELECT id, user_id, device_id, family_id, expires_at, revoked_at, replaced_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
        [sha256(token)],
      );
      const row = r.rows[0];
      if (!row || row.revoked_at) throw new AppError(401, 'INVALID_REFRESH', 'Sesión inválida');
      // Un token ya rotado solo se acepta durante un margen corto (respuesta perdida en red móvil).
      // Fuera del margen es reuso: posible robo → se revoca toda la familia.
      if (row.replaced_at && Date.now() - row.replaced_at.getTime() >= REUSE_GRACE_MS) {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
        logger.warn({ userId: row.user_id, familyId: row.family_id }, 'auth.refresh_reuse_detected');
        await this.audit.log({ actorUserId: row.user_id, action: 'auth.refresh_reuse_detected', metadata: { familyId: row.family_id } }, c);
        // No se lanza aquí: la revocación debe confirmarse (un throw haría ROLLBACK).
        return null;
      }
      if (row.expires_at < new Date()) throw new AppError(401, 'INVALID_REFRESH', 'Sesión vencida');
      if ((expectDevice ?? null) !== (row.device_id ?? null)) throw new AppError(401, 'INVALID_REFRESH', 'Sesión inválida');
      if (!row.replaced_at) await c.query('UPDATE refresh_tokens SET replaced_at = now() WHERE id = $1', [row.id]);
      return { userId: row.user_id, deviceId: row.device_id, familyId: row.family_id };
    });
    if (!result) throw new AppError(401, 'INVALID_REFRESH', 'Sesión inválida');
    return result;
  }

  async refreshUser(token: string): Promise<TokenPair> {
    const r = await this.refresh(token, null);
    return this.issueUserTokens(r.userId, r.familyId);
  }

  async logout(token: string): Promise<void> {
    const r = await this.db.one<{ family_id: string }>('SELECT family_id FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
    if (r) await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [r.family_id]);
  }

  /** Siempre responde igual exista o no el email. */
  async forgotPassword(email: string): Promise<void> {
    const u = await this.db.one<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
    if (!u) return;
    const token = opaqueToken();
    await this.db.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`, [u.id, sha256(token)]);
    const link = `${this.env.WEB_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mailer.send(email, 'Recuperación de contraseña', `Hola ${u.display_name}:\n\nPara elegir una nueva contraseña abrí este enlace (vence en 30 minutos):\n${link}\n\nSi no lo pediste, ignorá este mensaje.`);
    await this.audit.log({ actorUserId: u.id, action: 'auth.password_reset_requested' });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const hash = await argon2.hash(password, ARGON);
    await this.db.tx(async (c) => {
      const r = await c.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(token)],
      );
      const row = r.rows[0];
      if (!row) throw new AppError(400, 'INVALID_RESET_TOKEN', 'El enlace es inválido o venció');
      await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
      // Cierra todas las sesiones web (no las de dispositivos, que tienen su propio vínculo).
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id IS NULL AND revoked_at IS NULL', [row.user_id]);
      await this.audit.log({ actorUserId: row.user_id, action: 'auth.password_reset' }, c);
    });
  }

  async me(userId: string): Promise<MeResponse> {
    const u = await this.db.one<{ id: string; email: string; display_name: string }>('SELECT id, email, display_name FROM users WHERE id = $1', [userId]);
    if (!u) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');
    const ms = await this.db.query<{ org_id: string; name: string; role: 'owner' | 'admin' | 'viewer'; retention_days: number }>(
      `SELECT m.org_id, o.name, m.role, o.retention_days FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId],
    );
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      memberships: ms.map((m) => ({ orgId: m.org_id, orgName: m.name, role: m.role, retentionDays: m.retention_days })),
    };
  }
}
