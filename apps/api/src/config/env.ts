import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
    DATABASE_SSL: z.enum(['auto', 'require', 'disable']).default('auto'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres').optional(),
    JWT_ACCESS_TTL_S: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    DEVICE_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(180),
    CORS_ORIGINS: z.string().default(''),
    WEB_URL: z.string().url().default('http://localhost:5173'),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('Geotrazabilidad <no-reply@localhost>'),
    ROUTING_PROVIDER: z.enum(['osrm', 'none']).default('osrm'),
    OSRM_BASE_URL: z.string().url().default('https://router.project-osrm.org'),
    ROUTING_USER_AGENT: z.string().default('geotrazabilidad-mvp/0.1 (contacto: configurar ROUTING_USER_AGENT)'),
    ROUTING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    WORKER_ENABLED: bool(true),
    WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    RETENTION_ENABLED: bool(true),
    DEMO_ENABLED: bool(true),
    API_DOCS_ENABLED: bool(true),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(100000).default(600),
    INGEST_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10000).default(120),
    AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(1000).default(20),
    EXPORT_MAX_POINTS: z.coerce.number().int().min(1000).max(5_000_000).default(200_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.JWT_SECRET) ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Obligatoria en producción' });
      if (!env.CORS_ORIGINS) ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Definí los orígenes permitidos en producción' });
      if (/localhost|127\.0\.0\.1/.test(env.WEB_URL)) ctx.addIssue({ code: 'custom', path: ['WEB_URL'], message: 'No puede apuntar a localhost en producción' });
    }
  });

export type Env = Omit<z.infer<typeof EnvSchema>, 'JWT_SECRET'> & { JWT_SECRET: string; corsOrigins: string[] };

let cached: Env | null = null;

/** Valida el entorno al arrancar (fail-fast). En desarrollo genera un secreto efímero si falta. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${msg}`);
  }
  const e = parsed.data;
  const secret = e.JWT_SECRET ?? `dev-only-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  return { ...e, JWT_SECRET: secret, corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function setEnvForTests(e: Env) {
  cached = e;
}
