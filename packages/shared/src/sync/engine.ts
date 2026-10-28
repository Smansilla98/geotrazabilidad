import type { IngestBatchRequest, IngestBatchResponse } from '../contracts/api.js';
import type { QueueStore } from './queue.js';

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}${code ? ` ${code}` : ''}`);
  }
}

export interface SyncTransport {
  sendBatch(req: IngestBatchRequest): Promise<IngestBatchResponse>;
}

export type SyncOutcome =
  | { kind: 'idle' }
  | { kind: 'sent'; accepted: number; duplicates: number; rejected: number; more: boolean; configChanged: boolean }
  | { kind: 'retry'; reason: string; delayMs: number }
  | { kind: 'blocked'; reason: 'auth' | 'consent' | 'revoked'; message: string };

export interface SyncOptions {
  batchSize?: number;
  appVersion?: string;
  now?: () => number;
  random?: () => number;
  uuid: () => string;
  clientInfo?: () => Promise<Partial<IngestBatchRequest['client']>>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Backoff exponencial con jitter ("equal jitter"): [d/2, d], con d = min(max, base·2^n). */
export function backoffDelay(attempt: number, baseMs = 2000, maxMs = 15 * 60_000, random: () => number = Math.random): number {
  const d = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(d / 2 + random() * (d / 2));
}

/**
 * Sincronizador idempotente. Reglas:
 * - Un lote fallido por red/5xx/429 se reintenta completo con backoff (los puntos siguen en la cola).
 * - accepted y duplicates se confirman; rejected son rechazos de validación permanentes.
 * - 400/413 de lote completo: se reduce el tamaño a la mitad; con lote de 1 se rechaza ese punto
 *   (evita que un registro corrupto bloquee la cola para siempre).
 * - 401/403: se detiene y se informa (requiere reautenticación o consentimiento).
 */
export class SyncEngine {
  private failures = 0;
  private batchSize: number;
  private readonly maxBatch: number;

  constructor(
    private readonly store: QueueStore,
    private readonly transport: SyncTransport,
    private readonly opts: SyncOptions,
  ) {
    this.maxBatch = opts.batchSize ?? 200;
    this.batchSize = this.maxBatch;
  }

  get consecutiveFailures() {
    return this.failures;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  async syncOnce(): Promise<SyncOutcome> {
    const batch = await this.store.pendingBatch(this.batchSize);
    if (!batch.points.length && !batch.sessions.length) return { kind: 'idle' };
    const stats = await this.store.stats();
    const req: IngestBatchRequest = {
      batchId: this.opts.uuid(),
      sentAt: new Date(this.now()).toISOString(),
      client: { appVersion: this.opts.appVersion, pendingCount: stats.pending, ...(await this.opts.clientInfo?.()) },
      sessions: batch.sessions,
      points: batch.points,
    };
    const ids = batch.points.map((p) => p.id);
    await this.store.recordAttempt(ids);
    let res: IngestBatchResponse;
    try {
      res = await this.transport.sendBatch(req);
    } catch (e) {
      return this.handleError(e, ids);
    }
    this.failures = 0;
    this.batchSize = Math.min(this.maxBatch, this.batchSize * 2);
    const confirmed = [...res.accepted, ...res.duplicates];
    await this.store.markAcked(confirmed, batch.sessionVersions, this.now());
    if (res.rejected.length) await this.store.markRejected(res.rejected);
    const after = await this.store.stats();
    return {
      kind: 'sent',
      accepted: res.accepted.length,
      duplicates: res.duplicates.length,
      rejected: res.rejected.length,
      more: after.pending > 0,
      configChanged: res.config.changed,
    };
  }

  /** Sincroniza hasta vaciar la cola o encontrar un error. */
  async drain(maxRounds = 50): Promise<SyncOutcome> {
    let last: SyncOutcome = { kind: 'idle' };
    for (let i = 0; i < maxRounds; i++) {
      last = await this.syncOnce();
      if (last.kind !== 'sent' || !last.more) return last;
    }
    return last;
  }

  private async handleError(e: unknown, ids: string[]): Promise<SyncOutcome> {
    if (e instanceof SyncHttpError) {
      if (e.status === 401) return { kind: 'blocked', reason: 'auth', message: e.message };
      if (e.status === 403) return { kind: 'blocked', reason: e.code === 'DEVICE_REVOKED' ? 'revoked' : 'consent', message: e.message };
      if (e.status === 400 || e.status === 413) {
        if (this.batchSize > 1) {
          this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
          return { kind: 'retry', reason: `lote inválido (${e.status}); se reduce a ${this.batchSize}`, delayMs: 0 };
        }
        await this.store.markRejected(ids.map((id) => ({ id, code: 'INVALID_VALUE' })));
        this.batchSize = this.maxBatch;
        return { kind: 'retry', reason: 'registro inválido descartado', delayMs: 0 };
      }
    }
    const delayMs = backoffDelay(this.failures, this.opts.baseDelayMs, this.opts.maxDelayMs, this.opts.random);
    this.failures++;
    const reason = e instanceof Error ? e.message : String(e);
    return { kind: 'retry', reason, delayMs };
  }
}
