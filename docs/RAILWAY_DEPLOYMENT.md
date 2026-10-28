# Despliegue en Railway

> **Estado al 2026-10-27**
>
> | Estado | ¿Completo? | Evidencia |
> |---|---|---|
> | 1. Código preparado para Railway | **Sí** | `.railway/railway.ts` (compila con los tipos oficiales del paquete `railway`); comandos de build/arranque verificados en una copia limpia con `NODE_ENV=production`; PostGIS verificado sobre un volumen con `lost+found` |
> | 2. Despliegue ejecutado | **No** | No hay cuenta ni CLI de Railway en el entorno de desarrollo |
> | 3. Despliegue validado | **No** | Depende del punto 2 |
> | 4. Sistema validado funcionalmente en producción | **No** | Depende del punto 2 |

## 1. Arquitectura de despliegue

| Servicio Railway | Origen | Puerto | Health check | Persistencia |
|---|---|---|---|---|
| `postgis` | Imagen `postgis/postgis:17-3.5` | 5432 (solo red privada) | — | Volumen `postgis-data` en `/var/lib/postgresql/data` |
| `api` | Repo GitHub, Railpack | `PORT` de Railway | `GET /health/ready` (DB + PostGIS + migraciones) | Ninguna en disco: todo en la base |
| `web` | Repo GitHub, Railpack | `PORT` de Railway | `GET /healthz` (proceso + alcanza la API) | Ninguna |

La app móvil **no** se despliega en Railway: se compila con EAS o localmente (`expo run:android`) y apunta a la URL pública de la API.

No se usa Redis ni un worker separado: el procesamiento de eventos corre dentro de la API (`WORKER_ENABLED=true`) y usa Postgres como cola (`SKIP LOCKED`) y para el tiempo real (`LISTEN/NOTIFY`). Si en el futuro se separa, el mismo build arranca con `node apps/api/dist/worker.js` y la API pasa a `WORKER_ENABLED=false`.

## 2. Requisitos previos

- Cuenta de Railway con un plan que permita volúmenes. El plan gratuito/trial tiene límites de recursos y horas.
- Repositorio en GitHub con este código, conectado a Railway (GitHub App de Railway instalada).
- CLI de Railway (`npm i -g @railway/cli` o el instalador oficial) para usar Infrastructure as Code.
- Un proveedor SMTP para la recuperación de contraseña (Resend, Postmark, SES, etc.). Sin SMTP la recuperación no envía correos y la API lo registra como error.
- **Antes de desplegar**, ejecutá todo localmente (sección 12).

## 3. Preparación del repositorio

1. `.railway/railway.ts` apunta a `smansilla98/geotrazabilidad` (rama `main`); cambialo si usás otro repositorio o rama.
2. Verificá que la integración continua (`.github/workflows/ci.yml`) pase en GitHub. **No despliegues si falla.** Para que Railway espere la CI, activá *Wait for CI* en cada servicio (Settings → Deploy) o usá `checkSuites` en el origen.
3. `.node-version` fija Node 24 (LTS); Railpack lo respeta.

## 4. Crear el proyecto y los servicios (Infrastructure as Code)

```bash
railway login
railway init            # o: railway link  (si el proyecto ya existe)
railway config plan     # muestra qué se va a crear; los valores secretos aparecen como «hidden»
railway config apply
```

Esto crea el volumen, los tres servicios, los comandos de build/arranque, el `preDeploy` de migraciones, los health checks y las variables no secretas.

**Alternativa por interfaz web** (si preferís no usar IaC): creá los servicios a mano con la misma información de la tabla de la sección 7. No mezcles ambos métodos en un mismo servicio.

> Config as Code (`railway.json`/`railway.toml`) está deprecado y Railway deja de leerlo el **2026-12-01**; por eso este repositorio no lo usa.

## 5. PostgreSQL con PostGIS

El servicio Postgres que ofrece Railway por defecto **no incluye PostGIS**. Este proyecto usa la imagen oficial `postgis/postgis:17-3.5` como servicio con volumen:

- `PGDATA=/var/lib/postgresql/data/pgdata`: los volúmenes de Railway traen `lost+found` y Postgres no inicializa sobre un directorio no vacío. Verificado localmente simulando ese volumen.
- `POSTGRES_PASSWORD` se carga como secreto (ver sección 6). **Definilo antes del primer arranque**: Postgres solo lo usa al inicializar el volumen; cambiarlo después requiere `ALTER USER` dentro de la base.
- La base no tiene dominio público. La API la alcanza por red privada (`postgis.railway.internal:5432`), sin TLS (`DATABASE_SSL=disable`), porque la red privada de Railway ya está aislada.
- La primera migración ejecuta `CREATE EXTENSION postgis, citext, pgcrypto`: el usuario `geo` es superusuario dentro de esa imagen, así que tiene permiso.

**Verificar PostGIS después del deploy:**
```bash
curl https://<api>/health/ready     # checks.postgis.ok = true y su versión
# o, desde la consola del servicio postgis en Railway:
psql -U geo -d geo -c "SELECT postgis_full_version();"
```

**Si no podés usar una imagen con PostGIS** (alternativa documentada, no implementada): el modelo depende de PostGIS para las columnas generadas `geom` y `area`, los índices GiST, `ST_DistanceSphere` en las estadísticas y la validación de polígonos. Una variante sin PostGIS reemplazaría esas columnas por lat/lon + bbox, haría los cálculos en TypeScript (las reglas ya están en TS) y validaría polígonos en la API. Requiere una migración y cambios en las consultas. Evaluarlo antes de cambiar el modelo.

## 6. Variables de entorno

Los nombres coinciden con `apps/api/src/config/env.ts` (validado al arrancar: la API **no inicia** si falta algo obligatorio en producción) y con `apps/web/bff.mjs`.

### `postgis`
| Variable | Obligatoria | Valor |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_DB` | Sí | `geo` (lo define el IaC) |
| `POSTGRES_PASSWORD` | **Sí, secreto** | `openssl rand -base64 32` |
| `PGDATA` | Sí | `/var/lib/postgresql/data/pgdata` (lo define el IaC) |

### `api`
| Variable | Obligatoria | Valor / descripción |
|---|---|---|
| `NODE_ENV` | Sí | `production` |
| `PORT` | Automática | La inyecta Railway |
| `HOST` | Sí | `::` (escucha IPv4 e IPv6; la red privada de Railway lo necesita) |
| `DATABASE_URL` | Sí | Referencia: `postgresql://${{postgis.POSTGRES_USER}}:${{postgis.POSTGRES_PASSWORD}}@${{postgis.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgis.POSTGRES_DB}}` |
| `DATABASE_SSL` | No | `disable` para la red privada |
| `JWT_SECRET` | **Sí, secreto** | ≥ 32 caracteres: `openssl rand -base64 48`. Cambiarlo invalida todas las sesiones |
| `CORS_ORIGINS` | Sí | `https://<dominio-web>` (separados por coma). La app móvil no usa CORS |
| `WEB_URL` | Sí | `https://<dominio-web>` (enlaces de recuperación de contraseña). No puede ser localhost |
| `SMTP_URL` | Recomendada, secreto | `smtps://usuario:clave@smtp.proveedor.com:465` |
| `MAIL_FROM` | Recomendada | `Geotrazabilidad <no-reply@tu-dominio>` |
| `ROUTING_PROVIDER` | No | `osrm` (o `none`) |
| `OSRM_BASE_URL` | No | `https://router.project-osrm.org` (**servidor demo, sin SLA, uso no apto para producción**) |
| `ROUTING_USER_AGENT` | Recomendada | Identificá tu app y un contacto (política de uso de OSRM) |
| `WORKER_ENABLED` | No | `true` |
| `RETENTION_ENABLED` | No | `true` (borrado diario según `retention_days` de cada organización) |
| `DEMO_ENABLED` | No | `true` permite cargar datos de demostración (siempre marcados DEMO). Poné `false` si no los querés en producción |
| `API_DOCS_ENABLED` | No | `true` publica `/v1/docs`. Poné `false` si no querés exponer la documentación |
| `LOG_LEVEL` | No | `info` |
| `TRUST_PROXY` | No | `1` (detrás del proxy de Railway) |
| `RATE_LIMIT_PER_MIN` / `INGEST_RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` | No | 600 / 120 / 20 |
| `JWT_ACCESS_TTL_S`, `REFRESH_TTL_DAYS`, `DEVICE_REFRESH_TTL_DAYS`, `DB_POOL_MAX`, `EXPORT_MAX_POINTS` | No | Ver `.env.example` |

### `web`
| Variable | Obligatoria | Valor |
|---|---|---|
| `NODE_ENV` | Sí | `production` |
| `HOST` | Sí | `::` |
| `API_INTERNAL_URL` | Sí | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`. **No puede ser localhost** (el servidor no arranca) |
| `MAP_STYLE_URL` | No | `https://tiles.openfreemap.org/styles/liberty` |
| `COOKIE_SECURE` | Sí | `true` |
| `MAP_CSP_EXTRA` | No | Orígenes extra para la CSP si cambiás de proveedor de teselas (separados por coma) |

La web **no** tiene secretos: el navegador solo recibe `/config.js` con el estilo del mapa.

### Cargar secretos
En la interfaz (servicio → Variables) o con la CLI:
```bash
railway variables --service postgis --set "POSTGRES_PASSWORD=$(openssl rand -base64 32)"
railway variables --service api --set "JWT_SECRET=$(openssl rand -base64 48)"
railway variables --service api --set "SMTP_URL=smtps://..." --set "MAIL_FROM=..." --set "ROUTING_USER_AGENT=geotrazabilidad/1.0 (tu-email)"
```
El IaC los declara con `preserve()`: conserva el valor cargado y nunca lo escribe en el repositorio.

## 7. Comandos de build y arranque (verificados localmente)

| Servicio | Build | Pre-deploy | Start |
|---|---|---|---|
| `api` | `npm ci --include=dev --workspace @geo/shared --workspace @geo/api --include-workspace-root && npm run build -w @geo/shared && npm run build -w @geo/api` | `node apps/api/dist/db/migrate-cli.js` | `node apps/api/dist/main.js` |
| `web` | `npm ci --include=dev --workspace @geo/shared --workspace @geo/web --include-workspace-root && npm run build -w @geo/shared && npm run build -w @geo/web` | — | `node apps/web/server.mjs` |

- `--include=dev` es **necesario**: con `NODE_ENV=production` (también presente durante el build en Railway), `npm ci` omite las devDependencies y no hay `tsc` ni `vite`. Este problema se detectó y corrigió al verificar los builds en limpio.
- La app móvil no está en los workspaces raíz: Railway no descarga React Native.
- `watchPatterns` evita redeployar la web si solo cambió la API, y viceversa.

## 8. Migraciones

- Viven en `database/migrations/NNNN_nombre.sql`. Son solo hacia adelante y cada una corre en su propia transacción.
- Se ejecutan en el **pre-deploy** de la API. Si fallan, Railway **aborta el deploy** y la versión anterior sigue sirviendo.
- Las migraciones **no** se ejecutan al iniciar cada instancia. El runner usa un advisory lock para no correr en paralelo, y rechaza continuar si una migración ya aplicada fue modificada (compara checksums).
- `/health/ready` responde 503 si quedan migraciones pendientes.
- Estado manual: `railway run --service api node apps/api/dist/db/migrate-cli.js --status`.
- Para cambios destructivos (DROP, cambios de tipo), aplicá el patrón *expand/contract*: primero agregá columnas y código compatible con ambas versiones, y retirá lo viejo en un deploy posterior. Nunca las incluyas en el mismo deploy que el código que deja de usarlas.

## 9. Dominios, URL pública de la API y CORS

1. Generá un dominio público para `web` y otro para `api`: servicio → Settings → Networking → *Generate Domain*. Los dominios `*.up.railway.app` ya tienen HTTPS.
2. La web habla con la API por la red privada (`API_INTERNAL_URL`). El dominio público de la API solo lo necesitan la **app móvil** y `/v1/docs`.
3. `CORS_ORIGINS` y `WEB_URL` usan el dominio de la web. Si configurás un dominio propio, actualizá ambas variables.
4. App móvil: compilala con `EXPO_PUBLIC_API_URL=https://<dominio-api>` y `EXPO_PUBLIC_APP_ENV=production` (en producción no se puede cambiar la URL desde la app).
5. **SSE a través de Railway:** `/v1/stream` envía un comentario cada 25 s para que el proxy no corte la conexión por inactividad, y el cliente reconecta solo y vuelve a consultar los datos. El proxy de la web transmite en streaming sin bufferear. *Pendiente de verificar en Railway.*

## 10. Validación posterior al despliegue

```bash
API=https://<dominio-api>; WEB=https://<dominio-web>
curl -s $API/health/ready | jq      # database, postgis y migrations en ok
curl -s $WEB/healthz | jq           # {"status":"ok","checks":{"api":true}}
curl -sI $WEB | grep -i content-security-policy
# Flujo completo contra producción, con un dispositivo simulado (crea usuarios *@sim.test):
API_URL=$API WEB_URL=$WEB node scripts/simulate-device.mjs
```
Después, en el navegador:
1. Registrate y, si `DEMO_ENABLED=true`, cargá la demo.
2. Abrí Mapa: deben verse las teselas, el recorrido y el reproductor.
3. Con un viaje, calculá una ruta con OSRM.
4. Compilá la app con la URL de producción, iniciá un seguimiento y confirmá que aparece en la web.

Por último, **reiniciá y redeployá** los servicios y confirmá que usuarios, recorridos y eventos siguen ahí (prueba de persistencia del volumen).

## 11. Actualización, rollback, backups y recuperación

**Actualización:** push a la rama configurada → CI → build → pre-deploy (migraciones) → health check → Railway pasa el tráfico a la nueva versión. Si el health check no pasa, la versión anterior sigue activa.

**Rollback de código:** servicio → Deployments → deploy anterior → *Rollback*. Las migraciones **no** se revierten solas. Como son aditivas (expand/contract), el código anterior funciona con el esquema nuevo. Si una migración rompió datos, restaurá un backup.

**Backups:**
- Activá los backups del volumen `postgis-data` (servicio → Backups; también se puede declarar `backupSchedules` en el IaC). Revisá la retención que ofrece tu plan.
- Además, conviene un `pg_dump` lógico periódico fuera de Railway, por ejemplo con un servicio cron o desde CI:
  ```bash
  pg_dump "$DATABASE_PUBLIC_URL" -Fc -f geo-$(date +%F).dump
  ```
  Para esto hace falta un TCP proxy temporal hacia `postgis`, o ejecutarlo dentro de la red privada.

**Restauración:**
1. Restaurá el backup del volumen desde la interfaz, o creá un servicio PostGIS nuevo y corré `pg_restore -d "$URL" --clean --if-exists geo-AAAA-MM-DD.dump`.
2. Apuntá `DATABASE_URL` al servicio restaurado.
3. Redeployá la API: el pre-deploy aplica las migraciones que falten.
4. Verificá `/health/ready`.

**Retención:** la API borra cada día las posiciones y eventos más antiguos que `retention_days` de cada organización (90 por defecto; lo configura el owner en Configuración), la auditoría de más de 365 días y los lotes de ingesta de más de 30 días. Los backups conservan datos por fuera de esa política: alineá su retención con tu política de privacidad.

## 12. Ejecutar todo localmente antes de desplegar

Ver [INSTALL.md](INSTALL.md). En resumen:
```bash
cp .env.example .env    # completar JWT_SECRET
npm ci && docker compose up -d db mailpit
npm run build && npm run db:migrate
node --env-file=.env apps/api/dist/main.js        # API en :3000
API_INTERNAL_URL=http://localhost:3000 PORT=5173 node apps/web/server.mjs
API_URL=http://localhost:3000 WEB_URL=http://localhost:5173 node scripts/simulate-device.mjs
```

## 13. Diagnóstico de errores habituales (logs de Railway)

Los logs son JSON. Filtrá por `msg` en el visor de logs del servicio:

| Síntoma | Log / causa | Solución |
|---|---|---|
| La API no arranca | `config.invalid` con la lista de variables | Cargar las variables faltantes (sección 6) |
| El deploy se aborta en pre-deploy | `migration.failed` / `migration.error` | Ver el mensaje SQL; corregir con una migración nueva, nunca editando una ya aplicada |
| `/health/ready` da 503 | `checks.database`, `postgis` o `migrations` en false | Revisar `DATABASE_URL`, que el servicio postgis esté arriba y que se haya corrido la migración |
| `ECONNREFUSED`/`ENOTFOUND` a `postgis.railway.internal` | Red privada | Ambos servicios deben estar en el mismo proyecto y entorno |
| La web devuelve 502 en `/api/*` o `/healthz` 503 | `API_UNREACHABLE` | Revisar `API_INTERNAL_URL` y que la API escuche en `HOST=::` |
| Build: `tsc: not found` / `vite: not found` | Faltan devDependencies | El comando debe incluir `npm ci --include=dev` |
| Postgres no inicia: *directory exists but is not empty* | Volumen con `lost+found` | `PGDATA` debe apuntar a un subdirectorio |
| Rutas: `ROUTING_UNAVAILABLE` | `routing.unreachable` | El OSRM demo puede estar caído o limitarte; reintentá, usá "línea recta" o configurá otro proveedor |
| La recuperación de contraseña no envía mails | `mail.not_sent_smtp_missing` / `mail.send_failed` | Configurar o revisar `SMTP_URL` |
| El móvil recibe 403 `CONSENT_REQUIRED` | El titular no tiene un consentimiento vigente | Aceptarlo en la pantalla de Privacidad de la app |
| Eventos que no aparecen | `worker.device_failed` | Ver el error; el worker reintenta con espera creciente |
| Muchas 429 | `RATE_LIMITED` | Ajustar los `*_RATE_LIMIT_PER_MIN`. El límite es por instancia: con varias réplicas, cada una cuenta por separado |

Los logs no incluyen contraseñas, tokens ni coordenadas: los redacta pino y la ruta se registra sin query string.

## 14. Costos que pueden generar cargos

| Componente | Factor de costo |
|---|---|
| Servicios `api` y `web` | CPU y RAM por uso (Node: aproximadamente 100–250 MB cada uno en reposo) |
| `postgis` | RAM y CPU, más el **volumen** (GB/mes), que crece unos 300 bytes por posición más índices |
| Backups de volumen | Almacenamiento adicional según retención |
| Egress | Exportaciones grandes, SSE y descargas desde la web |
| Réplicas | Multiplican CPU/RAM. Además requieren rate limit distribuido (pendiente) |
| Externos | SMTP (según proveedor); OSRM propio si se migra del demo (un servicio con ~2–4 GB de RAM para Argentina); teselas con SLA (MapTiler) si se reemplaza OpenFreeMap; Apple Developer (USD 99/año) y Google Play (USD 25) para distribuir la app |
