import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv, setEnvForTests, type Env } from '../src/config/env.js';
import { Db } from '../src/db/db.js';
import { Mailer } from '../src/mail/mailer.js';
import { Processor } from '../src/processing/processor.js';
import { CURRENT_CONSENT_VERSION } from '@geo/shared';

export interface TestCtx {
  app: INestApplication;
  db: Db;
  env: Env;
  http: () => ReturnType<typeof request>;
  processor: Processor;
  mailer: Mailer;
  close: () => Promise<void>;
}

export async function makeApp(overrides: Record<string, string> = {}): Promise<TestCtx> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('dbUrl'),
    DATABASE_SSL: 'disable',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    WORKER_ENABLED: 'false',
    RETENTION_ENABLED: 'false',
    ROUTING_PROVIDER: 'none',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_PER_MIN: '100000',
    INGEST_RATE_LIMIT_PER_MIN: '10000',
    AUTH_RATE_LIMIT_PER_MIN: '1000',
    ...overrides,
  });
  setEnvForTests(env);
  const { app, db } = await createApp(env);
  await app.init();
  const server = app.getHttpServer();
  return {
    app,
    db,
    env,
    http: () => request(server),
    processor: app.get(Processor),
    mailer: app.get(Mailer),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const uniqueEmail = (p = 'u') => `${p}-${randomUUID().slice(0, 8)}@test.local`;

export async function registerUser(ctx: TestCtx, name = 'Usuario') {
  const email = uniqueEmail();
  const r = await ctx.http().post('/v1/auth/register').send({ email, password: 'contraseña-segura-1', displayName: name }).expect(201);
  const me = await ctx.http().get('/v1/me').set('Authorization', `Bearer ${r.body.accessToken}`).expect(200);
  return { email, token: r.body.accessToken as string, refresh: r.body.refreshToken as string, userId: me.body.id as string, orgId: me.body.memberships[0].orgId as string };
}

export async function registerDevice(ctx: TestCtx, userToken: string, opts: { consent?: boolean; share?: boolean; orgId?: string } = {}) {
  const r = await ctx
    .http()
    .post('/v1/devices')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ installId: randomUUID(), name: 'Teléfono de prueba', platform: 'android', appVersion: '1.0.0', orgId: opts.orgId })
    .expect(201);
  if (opts.consent !== false) {
    await ctx
      .http()
      .post(`/v1/devices/${r.body.deviceId}/consent`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ consentVersion: CURRENT_CONSENT_VERSION, shareWithOrg: opts.share ?? false })
      .expect(200);
  }
  return { deviceId: r.body.deviceId as string, deviceToken: r.body.deviceToken as string, refresh: r.body.deviceRefreshToken as string };
}

/** Genera puntos moviéndose hacia el este desde el Obelisco. */
export function points(sessionId: string, n: number, opts: { start?: number; dtS?: number; stepM?: number; startSeq?: number; lat?: number; lon?: number } = {}) {
  const start = opts.start ?? Date.now() - 3_600_000;
  const dt = (opts.dtS ?? 10) * 1000;
  const step = opts.stepM ?? 100;
  const lat = opts.lat ?? -34.6037;
  const lon0 = opts.lon ?? -58.3816;
  return Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    sessionId,
    seq: (opts.startSeq ?? 0) + i,
    capturedAt: new Date(start + i * dt).toISOString(),
    lat,
    lon: lon0 + (i * step) / 91_600,
    accuracy: 8,
    speed: step / (dt / 1000),
    heading: 90,
    source: 'gps' as const,
    mocked: false,
  }));
}

export function batch(sessionId: string, pts: ReturnType<typeof points>, extra: { endedAt?: string; startedAt?: string; tripId?: string } = {}) {
  return {
    batchId: randomUUID(),
    sentAt: new Date().toISOString(),
    client: { appVersion: '1.0.0', pendingCount: pts.length },
    sessions: [{ id: sessionId, startedAt: extra.startedAt ?? new Date(Date.parse(pts[0]?.capturedAt ?? new Date().toISOString()) - 1000).toISOString(), endedAt: extra.endedAt ?? null, mode: 'trip', tripId: extra.tripId ?? null, configSnapshot: {} }],
    points: pts,
  };
}
