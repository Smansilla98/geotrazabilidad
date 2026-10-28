import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ENV } from '../auth/tokens.js';
import type { Env } from '../config/env.js';
import { Db } from '../db/db.js';
import { logger } from '../logger.js';

const JOB = 'retention';
const BATCH = 10_000;
const AUDIT_RETENTION_DAYS = 365;

/**
 * Política de retención: borra posiciones con captured_at más antiguo que retention_days de cada
 * organización (por defecto 90). Después elimina eventos y sesiones que quedaron sin datos.
 * Corre como máximo una vez cada 23 h (registro persistido en job_runs, seguro con varias réplicas).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    if (!this.env.RETENTION_ENABLED || !this.env.WORKER_ENABLED) return;
    const check = () => this.runIfDue().catch((err) => logger.error({ err: { message: (err as Error).message } }, 'retention.failed'));
    this.timer = setInterval(check, 60 * 60_000);
    setTimeout(check, 30_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runIfDue(): Promise<boolean> {
    const claimed = await this.db.query(
      `INSERT INTO job_runs (job, last_run_at) VALUES ($1, now())
       ON CONFLICT (job) DO UPDATE SET last_run_at = now() WHERE job_runs.last_run_at < now() - interval '23 hours'
       RETURNING job`,
      [JOB],
    );
    if (!claimed.length) return false;
    const result = await this.run();
    await this.db.query('UPDATE job_runs SET last_result = $2 WHERE job = $1', [JOB, result]);
    return true;
  }

  async run(now: Date = new Date()) {
    const started = Date.now();
    let points = 0;
    for (;;) {
      const r = await this.db.query<{ n: number }>(
        `WITH doomed AS (
           SELECT p.id FROM location_points p JOIN devices d ON d.id = p.device_id JOIN organizations o ON o.id = d.org_id
            WHERE p.captured_at < $1::timestamptz - make_interval(days => o.retention_days) LIMIT ${BATCH})
         DELETE FROM location_points WHERE id IN (SELECT id FROM doomed) RETURNING 1 AS n`,
        [now],
      );
      points += r.length;
      if (r.length < BATCH) break;
    }
    const events = await this.db.query(
      `DELETE FROM tracking_events e USING devices d, organizations o
        WHERE d.id = e.device_id AND o.id = d.org_id AND e.occurred_at < $1::timestamptz - make_interval(days => o.retention_days) RETURNING 1`,
      [now],
    );
    const sessions = await this.db.query(
      `DELETE FROM tracking_sessions s USING devices d, organizations o
        WHERE d.id = s.device_id AND o.id = d.org_id AND s.ended_at IS NOT NULL
          AND s.ended_at < $1::timestamptz - make_interval(days => o.retention_days)
          AND NOT EXISTS (SELECT 1 FROM location_points p WHERE p.session_id = s.id) RETURNING 1`,
      [now],
    );
    const batches = await this.db.query(`DELETE FROM ingest_batches WHERE received_at < $1::timestamptz - interval '30 days' RETURNING 1`, [now]);
    const audit = await this.db.query(`DELETE FROM audit_log WHERE created_at < $1::timestamptz - make_interval(days => $2) RETURNING 1`, [now, AUDIT_RETENTION_DAYS]);
    const tokens = await this.db.query(`DELETE FROM refresh_tokens WHERE expires_at < $1::timestamptz - interval '7 days' RETURNING 1`, [now]);
    const result = { points, events: events.length, sessions: sessions.length, batches: batches.length, audit: audit.length, tokens: tokens.length, ms: Date.now() - started };
    logger.info(result, 'retention.done');
    return result;
  }
}
