import './net.js';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { logger } from './logger.js';

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    logger.fatal({ err: { message: (err as Error).message } }, 'config.invalid');
    process.exit(1);
  }
  const { app, db } = await createApp(env);
  await app.listen(env.PORT, env.HOST);
  logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV, worker: env.WORKER_ENABLED, routing: env.ROUTING_PROVIDER }, 'api.started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'api.stopping');
    await app.close();
    await db.close().catch(() => undefined);
    logger.info('api.stopped');
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error({ err: { message: (err as Error)?.message } }, 'process.unhandled_rejection'));
void main();
