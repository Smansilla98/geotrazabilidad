import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { Db } from '../db/db.js';
import { logger } from '../logger.js';

export type GeoUpdate =
  | { type: 'points'; deviceId: string; orgId: string; count: number; lastCapturedAt: string | null }
  | { type: 'events'; deviceId: string; orgId: string; sessionIds: string[]; changed: number }
  | { type: 'device'; deviceId: string; orgId: string };

const CHANNEL = 'geo_updates';

/**
 * Difusión de cambios entre réplicas con LISTEN/NOTIFY de Postgres. Los mensajes solo avisan
 * qué cambió (sin coordenadas); los clientes vuelven a consultar la API REST con sus permisos.
 */
@Injectable()
export class Notifier implements OnModuleDestroy {
  private listener: pg.Client | null = null;
  private readonly subs = new Set<(u: GeoUpdate) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly db: Db) {}

  async publish(u: GeoUpdate): Promise<void> {
    try {
      await this.db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(u)]);
    } catch (err) {
      logger.warn({ err: { message: (err as Error).message } }, 'notify.publish_failed');
    }
  }

  subscribe(fn: (u: GeoUpdate) => void): () => void {
    this.subs.add(fn);
    void this.ensureListening();
    return () => this.subs.delete(fn);
  }

  private async ensureListening() {
    if (this.listener || this.closed) return;
    const opts = this.db.pool.options;
    const client = new pg.Client({ connectionString: opts.connectionString, ssl: opts.ssl });
    this.listener = client;
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const u = JSON.parse(msg.payload) as GeoUpdate;
        this.subs.forEach((fn) => fn(u));
      } catch {
        /* payload inválido: se ignora */
      }
    });
    const retry = (err: Error) => {
      logger.warn({ err: { message: err.message } }, 'notify.listener_lost');
      this.listener = null;
      client.removeAllListeners();
      client.end().catch(() => undefined);
      if (!this.closed && this.subs.size && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.ensureListening();
        }, 2000);
      }
    };
    client.on('error', retry);
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      retry(err as Error);
    }
  }

  async onModuleDestroy() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.listener?.end().catch(() => undefined);
  }
}
