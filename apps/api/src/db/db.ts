import pg from 'pg';
import { logger } from '../logger.js';

// timestamptz → Date (por defecto), bigint (int8) → number: los ids de location_points caben en 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export function sslFor(url: string, mode: 'auto' | 'require' | 'disable'): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  // auto: red privada de Railway (*.railway.internal) y localhost sin TLS; proxies públicos con TLS.
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal') || host === 'db') return false;
  if (/sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

export class Db {
  readonly pool: pg.Pool;

  constructor(url: string, opts: { max?: number; ssl?: 'auto' | 'require' | 'disable' } = {}) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: opts.max ?? 10,
      ssl: sslFor(url, opts.ssl ?? 'auto'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: process.env.SERVICE_NAME ?? 'geo-api',
    });
    this.pool.on('error', (err) => logger.error({ err: { message: err.message } }, 'db.pool.error'));
  }

  async query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query<T>(sql, params);
    return r.rows;
  }

  async one<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
