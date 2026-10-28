import { loadEnv } from '../config/env.js';
import { logger } from '../logger.js';
import { Db } from './db.js';
import { migrate, migrationStatus } from './migrate.js';

/** Uso: node dist/db/migrate-cli.js [--status]. Lo ejecuta el preDeploy de Railway. */
const e = loadEnv();
const db = new Db(e.DATABASE_URL, { max: 1, ssl: e.DATABASE_SSL });
try {
  if (process.argv.includes('--status')) {
    logger.info(await migrationStatus(db.pool), 'migration.status');
  } else {
    const applied = await migrate(db.pool);
    const postgis = await db.one<{ v: string }>('SELECT postgis_version() AS v');
    logger.info({ applied, postgis: postgis?.v }, applied.length ? 'migration.done' : 'migration.up_to_date');
  }
  await db.close();
} catch (err) {
  logger.fatal({ err: { message: (err as Error).message } }, 'migration.error');
  await db.close().catch(() => undefined);
  process.exit(1);
}
