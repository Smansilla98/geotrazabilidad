import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { Db } from './db/db.js';
import { logger } from './logger.js';

/** Construye la aplicación (sin escuchar). La usan main.ts y las pruebas de integración. */
export async function createApp(env: Env, db: Db = new Db(env.DATABASE_URL, { max: env.DB_POOL_MAX, ssl: env.DATABASE_SSL })) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env, db), {
    logger: env.NODE_ENV === 'test' ? false : ['error', 'warn'],
    bodyParser: false,
  });
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin) || (env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin))),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  if (env.NODE_ENV !== 'test') {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
        // Sin query string en los logs: puede contener rangos y filtros; nunca credenciales.
        serializers: { req: (req) => ({ method: req.method, path: String(req.url).split('?')[0] }), res: (res) => ({ status: res.statusCode }) },
      }),
    );
  }
  app.enableShutdownHooks();
  return { app, db };
}
