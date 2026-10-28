import '../net.js';
import 'reflect-metadata';
import { loadEnv } from '../config/env.js';
import { Db } from '../db/db.js';
import { logger } from '../logger.js';
import { Processor } from '../processing/processor.js';
import { Notifier } from '../stream/notifier.js';
import { AuditService } from '../audit/audit.service.js';
import { DemoService } from './demo.service.js';

/**
 * Carga la demo en la organización propia (owner) de un usuario existente y procesa los eventos.
 * Uso: npm run demo:seed -- usuario@ejemplo.com
 */
const email = process.argv[2];
if (!email) {
  console.error('Uso: npm run demo:seed -- <email-de-usuario-registrado>');
  process.exit(2);
}
const env = loadEnv();
const db = new Db(env.DATABASE_URL, { max: 2, ssl: env.DATABASE_SSL });
try {
  const u = await db.one<{ id: string; org_id: string }>(
    `SELECT u.id, m.org_id FROM users u JOIN memberships m ON m.user_id = u.id AND m.role = 'owner' WHERE u.email = $1 ORDER BY m.created_at LIMIT 1`,
    [email.toLowerCase()],
  );
  if (!u) throw new Error(`No existe un usuario owner con email ${email}`);
  const r = await new DemoService(db, new AuditService(db)).load(u.org_id, u.id);
  const processor = new Processor(db, new Notifier(db), { ...env, WORKER_ENABLED: false });
  await processor.drain();
  const ev = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM tracking_events e JOIN devices d ON d.id = e.device_id WHERE d.org_id = $1 AND e.is_demo', [u.org_id]);
  logger.info({ orgId: u.org_id, points: r.points, scenarios: r.scenarios.length, events: ev?.n }, 'demo.seeded');
} catch (err) {
  logger.fatal({ err: { message: (err as Error).message } }, 'demo.seed_failed');
  process.exitCode = 1;
} finally {
  await db.close();
}
