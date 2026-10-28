import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { AppError, DEVICE_ALLOWED, IS_PUBLIC, type Principal } from '../common/http.js';
import type { Env } from '../config/env.js';
import { Db } from '../db/db.js';
import { ENV, verifyAccess } from './tokens.js';

/**
 * Guard global. Todo endpoint requiere autenticación salvo @Public().
 * Los tokens de dispositivo solo valen en endpoints marcados con @DeviceAuth() y se revalida
 * en cada request que el dispositivo siga activo (revocación inmediata, no al expirar el JWT).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Falta el token de acceso');
    let claims;
    try {
      claims = await verifyAccess(this.env.JWT_SECRET, token);
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Token inválido o vencido');
    }
    const deviceMode = this.reflector.getAllAndOverride<'only' | 'also' | undefined>(DEVICE_ALLOWED, targets);
    if (claims.typ === 'user') {
      if (deviceMode === 'only') throw new AppError(403, 'DEVICE_TOKEN_REQUIRED', 'Este endpoint requiere el token del dispositivo');
      const u = await this.db.one<{ disabled_at: Date | null }>('SELECT disabled_at FROM users WHERE id = $1', [claims.sub]);
      if (!u || u.disabled_at) throw new AppError(401, 'UNAUTHORIZED', 'Usuario inexistente o deshabilitado');
      req.principal = { kind: 'user', userId: claims.sub };
      return true;
    }
    if (!deviceMode) throw new AppError(403, 'USER_TOKEN_REQUIRED', 'Este endpoint requiere un usuario');
    const d = await this.db.one<{ status: string; holder_user_id: string }>('SELECT status, holder_user_id FROM devices WHERE id = $1', [claims.sub]);
    if (!d) throw new AppError(401, 'UNAUTHORIZED', 'Dispositivo inexistente');
    if (d.status !== 'active') throw new AppError(403, 'DEVICE_REVOKED', 'El acceso de este dispositivo fue revocado');
    req.principal = { kind: 'device', deviceId: claims.sub, userId: d.holder_user_id };
    await this.db.query(
      `INSERT INTO device_sync_state (device_id, last_contact_at) VALUES ($1, now())
       ON CONFLICT (device_id) DO UPDATE SET last_contact_at = now()`,
      [claims.sub],
    );
    return true;
  }
}

/** Rate limit por principal autenticado (dispositivo o usuario); por IP si es anónimo. */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const p = req.principal as Principal | undefined;
    if (p?.kind === 'device') return `device:${p.deviceId}`;
    if (p?.kind === 'user') return `user:${p.userId}`;
    return `ip:${String(req.ip ?? 'unknown')}`;
  }
}
