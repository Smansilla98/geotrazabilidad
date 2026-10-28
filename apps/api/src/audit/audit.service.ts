import { Injectable } from '@nestjs/common';
import { Db, type Queryable } from '../db/db.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  orgId?: string | null;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Nunca coordenadas. */
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  async log(e: AuditEntry, q: Queryable = this.db.pool): Promise<void> {
    try {
      await q.query(
        `INSERT INTO audit_log (org_id, actor_user_id, actor_device_id, action, target_type, target_id, ip, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9)`,
        [e.orgId ?? null, e.actorUserId ?? null, e.actorDeviceId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, e.userAgent ?? null, e.metadata ?? {}],
      );
    } catch (err) {
      // La auditoría no debe tumbar la operación principal, pero sí quedar registrada como error.
      logger.error({ err: { message: (err as Error).message }, action: e.action }, 'audit.write_failed');
    }
  }
}
