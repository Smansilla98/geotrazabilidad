/**
 * Infraestructura en Railway (IaC). Reemplaza a railway.json/railway.toml (Config as Code),
 * que Railway deja de leer el 2026-12-01.
 *
 *   railway login && railway link
 *   railway config plan     # revisar
 *   railway config apply    # aplicar
 *
 * Servicios:
 *   postgis  imagen oficial postgis/postgis con volumen persistente (el Postgres por defecto de Railway no trae PostGIS)
 *   api      NestJS; migraciones en preDeploy (si fallan, el deploy se aborta y sigue la versión anterior)
 *   web      SPA + BFF; habla con la API por la red privada
 *
 * Secretos: POSTGRES_PASSWORD, JWT_SECRET, SMTP_URL y ROUTING_USER_AGENT se cargan en Railway (preserve()
 * conserva el valor existente y nunca lo escribe en este archivo). Ver docs/RAILWAY_DEPLOYMENT.md.
 * Repositorio: smansilla98/geotrazabilidad.
 */
import { defineRailway, github, image, preserve, service, volume } from 'railway/iac';

const REPO = 'smansilla98/geotrazabilidad';
const BRANCH = 'main';

export default defineRailway((_ctx, project) => {
  const pgData = volume('postgis-data', { sizeMB: 5120 });

  const postgis = service('postgis', {
    source: image('postgis/postgis:17-3.5'),
    volumeMounts: { '/var/lib/postgresql/data': pgData },
    env: {
      POSTGRES_USER: 'geo',
      POSTGRES_DB: 'geo',
      POSTGRES_PASSWORD: preserve(),
      // El volumen trae lost+found: Postgres necesita un subdirectorio vacío.
      PGDATA: '/var/lib/postgresql/data/pgdata',
    },
  });

  // Instala y compila solo los workspaces necesarios (la app móvil no se incluye en el monorepo raíz).
  const apiBuild =
    'npm ci --include=dev --workspace @geo/shared --workspace @geo/api --include-workspace-root && npm run build -w @geo/shared && npm run build -w @geo/api';
  const api = service('api', {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: 'RAILPACK', buildCommand: apiBuild, watchPatterns: ['apps/api/**', 'packages/shared/**', 'database/**', 'package-lock.json'] },
    start: 'node apps/api/dist/main.js',
    preDeploy: 'node apps/api/dist/db/migrate-cli.js',
    healthcheck: '/health/ready',
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5 },
    env: {
      NODE_ENV: 'production',
      // '::' acepta IPv4 e IPv6: necesario para la red privada de Railway.
      HOST: '::',
      DATABASE_URL: 'postgresql://${{postgis.POSTGRES_USER}}:${{postgis.POSTGRES_PASSWORD}}@${{postgis.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgis.POSTGRES_DB}}',
      DATABASE_SSL: 'disable',
      JWT_SECRET: preserve(),
      CORS_ORIGINS: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      WEB_URL: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      SMTP_URL: preserve(),
      MAIL_FROM: preserve(),
      ROUTING_PROVIDER: 'osrm',
      OSRM_BASE_URL: 'https://router.project-osrm.org',
      ROUTING_USER_AGENT: preserve(),
      WORKER_ENABLED: 'true',
      RETENTION_ENABLED: 'true',
      DEMO_ENABLED: 'true',
      API_DOCS_ENABLED: 'true',
      LOG_LEVEL: 'info',
      TRUST_PROXY: '1',
    },
  });

  const webBuild =
    'npm ci --include=dev --workspace @geo/shared --workspace @geo/web --include-workspace-root && npm run build -w @geo/shared && npm run build -w @geo/web';
  const web = service('web', {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: 'RAILPACK', buildCommand: webBuild, watchPatterns: ['apps/web/**', 'packages/shared/**', 'package-lock.json'] },
    start: 'node apps/web/server.mjs',
    healthcheck: '/healthz',
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5 },
    env: {
      NODE_ENV: 'production',
      HOST: '::',
      API_INTERNAL_URL: 'http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}',
      MAP_STYLE_URL: 'https://tiles.openfreemap.org/styles/liberty',
      COOKIE_SECURE: 'true',
    },
  });

  return project('geotrazabilidad', { resources: [pgData, postgis, api, web] });
});
