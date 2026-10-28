import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/http.js';
import { Db } from '../db/db.js';
import { migrationStatus } from '../db/migrate.js';
import { logger } from '../logger.js';

/**
 * /health/live: el proceso responde (liveness).
 * /health/ready: puede atender solicitudes esenciales: base alcanzable, PostGIS instalado y
 * migraciones al día. Responde 503 si algo falla (Railway no habilita el deploy).
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly db: Db) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptimeS: Math.round(process.uptime()) };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const started = Date.now();
      await this.db.query('SELECT 1');
      checks.database = { ok: true, detail: `${Date.now() - started} ms` };
      const pg = await this.db.one<{ v: string }>('SELECT postgis_version() AS v').catch(() => null);
      checks.postgis = pg ? { ok: true, detail: pg.v } : { ok: false, detail: 'La extensión PostGIS no está disponible' };
      const m = await migrationStatus(this.db.pool);
      checks.migrations = m.pending.length || m.mismatched.length
        ? { ok: false, detail: `pendientes: ${m.pending.join(', ') || '-'}; modificadas: ${m.mismatched.join(', ') || '-'}` }
        : { ok: true, detail: `${m.applied} aplicadas` };
    } catch (err) {
      checks.database = { ok: false, detail: 'Sin conexión a la base de datos' };
      logger.error({ err: { message: (err as Error).message } }, 'health.db_unreachable');
    }
    const ok = Object.values(checks).every((c) => c.ok) && 'migrations' in checks;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable', checks });
  }
}
