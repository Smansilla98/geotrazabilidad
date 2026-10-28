import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { logger } from '../logger.js';

/** Raíz del repo: este archivo vive en apps/api/{src|dist}/db/. */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../../database/migrations/', import.meta.url));

const LOCK_ID = 74_210_001; // advisory lock: evita migraciones concurrentes entre réplicas

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => {
      const sql = await readFile(`${dir}/${f}`, 'utf8');
      return { version: f.slice(0, 4), name: f, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureTable(c: pg.ClientBase) {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function migrationStatus(pool: pg.Pool, dir = MIGRATIONS_DIR) {
  const files = await loadMigrations(dir);
  const exists = await pool.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`);
  const applied = exists.rows[0].ok
    ? (await pool.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM schema_migrations`)).rows
    : [];
  const map = new Map(applied.map((a) => [a.version, a.checksum]));
  return {
    pending: files.filter((f) => !map.has(f.version)).map((f) => f.name),
    mismatched: files.filter((f) => map.has(f.version) && map.get(f.version) !== f.checksum).map((f) => f.name),
    applied: applied.length,
  };
}

/**
 * Aplica migraciones pendientes, cada una en su transacción. Solo hacia adelante.
 * Falla si una migración ya aplicada cambió (checksum distinto): nunca se reescribe historia.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await loadMigrations(dir);
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await ensureTable(client);
    const applied = new Map(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    for (const f of files) {
      const prev = applied.get(f.version);
      if (prev) {
        if (prev !== f.checksum) throw new Error(`La migración ${f.name} ya aplicada fue modificada (checksum distinto). Creá una migración nueva.`);
        continue;
      }
      logger.info({ migration: f.name }, 'migration.start');
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [f.version, f.name, f.checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        logger.error({ migration: f.name, err: { message: (e as Error).message } }, 'migration.failed');
        throw e;
      }
      appliedNow.push(f.name);
      logger.info({ migration: f.name }, 'migration.applied');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return appliedNow;
}
