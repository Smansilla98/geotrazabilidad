import './net.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ENV } from './auth/tokens.js';
import { loadEnv } from './config/env.js';
import { Db } from './db/db.js';
import { logger } from './logger.js';
import { Processor } from './processing/processor.js';
import { RetentionService } from './retention/retention.service.js';
import { Notifier } from './stream/notifier.js';

/**
 * Worker separado (opcional). Mismo build que la API, otro comando de inicio.
 * Usalo si querés escalar el procesamiento aparte: en ese caso poné WORKER_ENABLED=false en la API.
 */
const env = { ...loadEnv(), WORKER_ENABLED: true };
const db = new Db(env.DATABASE_URL, { max: Math.min(env.DB_POOL_MAX, 5), ssl: env.DATABASE_SSL });

@Module({ providers: [{ provide: ENV, useValue: env }, { provide: Db, useValue: db }, Notifier, Processor, RetentionService] })
class WorkerModule {}

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks();
logger.info('worker.started');
const stop = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
