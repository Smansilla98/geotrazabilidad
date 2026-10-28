# Alcance del MVP, riesgos y plan por etapas

## 1. Alcance del MVP

**Criterio rector (spec §15):** un dispositivo autorizado registra un recorrido, lo sincroniza, se generan los eventos y **otro** usuario autorizado consulta el historial en la web. La comparación de rutas funciona con datos reales y separa lo estimado de lo observado.

### Incluido

| Área | Funcionalidad |
|---|---|
| Identidad | Registro, login, refresh rotativo, logout, recuperación de contraseña por email, organizaciones con roles owner/admin/viewer e invitación de miembros por email |
| Dispositivos | Vínculo, token de dispositivo, consentimiento versionado, revocación, estados de conexión, sync state |
| Captura (móvil) | 4 modos, estrategia adaptativa en JS, configuración remota con valores locales, cola SQLite, sync idempotente con backoff, recuperación tras reinicio |
| Ingesta | Lotes, validación, dedupe, desfase de reloj, marcas de calidad, rate limit |
| Reglas (servidor) | Validación, outliers/saltos, huecos, detenciones (inicio/fin de movimiento), geocercas con permanencia e histéresis, llegada, desvío `corridor.v1`, avance de viaje. Reprocesamiento ante puntos atrasados |
| Viajes | CRUD, ruta estimada (OSRM/GraphHopper/línea recta), progreso, comparación |
| Web | Dashboard real, dispositivos, mapa con recorrido segmentado, puntos por calidad, geocercas, timeline de eventos, reproductor, comparación, exportaciones |
| Tiempo real | SSE para actualizar el mapa y el estado de dispositivos |
| Privacidad | Retención por organización, borrado de dispositivo y de cuenta, exportación de datos propios, auditoría de accesos |
| Demo | 8 escenarios sintéticos en una organización y dispositivos marcados como DEMO |
| Ops | docker-compose, migraciones, health checks, logs estructurados (pino), CI, Railway IaC, documentación |

### Fuera del MVP (planificado)

- Map matching (OSRM `/match`).
- Geocercas nativas en el dispositivo (iOS tiene un máximo de 20).
- Geocodificación con autocompletar.
- Exportaciones asíncronas grandes con almacenamiento de objetos.
- Particionado de `location_points`.
- Notificaciones push de eventos.
- Rate limit distribuido (con varias réplicas de la API).
- 2FA y SSO.

## 2. Riesgos técnicos principales

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | **No se puede verificar la captura en segundo plano en este entorno** (sin dispositivo ni emulador) | Cierta | Alto | Lógica de captura y cola como funciones puras con pruebas unitarias. Checklist de pruebas en dispositivo físico. Estado "pendiente de verificación" hasta ejecutarlas |
| R2 | Restricciones de Android 12+ para reconfigurar el foreground service desde background | Media | Medio | Adaptación por filtrado en JS y reconfiguración nativa solo en primer plano |
| R3 | Fabricantes que matan el servicio | Alta | Medio | Detección de huecos y heartbeat, guía para el usuario. No se promete continuidad |
| R4 | Reloj del dispositivo incorrecto | Media | Alto | `sentAt` vs. `received_at` por lote, marca `future_ts`, orden por `captured_at` con `seq` como desempate dentro de la sesión |
| R5 | Puntos atrasados que invalidan eventos ya emitidos | Alta | Medio | Reprocesamiento desde `reprocess_from` y eventos `superseded` (nunca borrados en silencio) |
| R6 | PostGIS en Railway no es el Postgres por defecto | Cierta | Medio | Servicio con la imagen `postgis/postgis:17-3.5` y volumen. Health check de readiness que verifica `postgis_version()`. Plan B documentado: Postgres sin PostGIS con lat/lon + Haversine en la app (pierde GiST y simplificación en SQL) |
| R7 | Config as Code de Railway deja de leerse el 2026-12-01 | Cierta | Medio | Usar IaC (`.railway/railway.ts`) desde el inicio |
| R8 | Volumen de historiales largos en el navegador | Media | Medio | Simplificación en el servidor, paginación por cursor, límites por consulta |
| R9 | El proveedor de rutas público (OSRM demo) no es apto para producción | Cierta | Medio | Interfaz intercambiable. Decisión de producción pendiente (ver PROVIDERS.md) |
| R10 | Falsos positivos de geocercas y desvíos | Media | Alto (confianza del usuario) | Permanencia, histéresis, umbral por accuracy y niveles de confianza explícitos. Pruebas con escenarios sintéticos de borde |
| R11 | Uso indebido para vigilancia de terceros | Media | Alto | Consentimiento del titular, indicador visible, revocación por parte del titular, auditoría y documento legal |
| R12 | Rate limit en memoria con varias réplicas | Baja en MVP | Bajo | Una réplica en el MVP. Mover a Postgres o Redis si se escala |

## 3. Plan por etapas con criterios verificables

Cada etapa se cierra solo si sus criterios pasan. El resultado se registra en `PROJECT_LOG.md`.

### Etapa 0 — Fundaciones (repo y entorno)
- Monorepo con npm workspaces, TypeScript estricto, ESLint, Prettier, Vitest; `docker-compose` con PostGIS y Mailpit; `.env.example`; CI esqueleto.
- **Criterios:** `npm ci && npm run typecheck && npm run lint && npm test` pasan en limpio; `docker compose up -d db` levanta y `SELECT postgis_version()` responde.

### Etapa 1 — Núcleo compartido (`packages/shared`)
- Contratos zod v1, utilidades geo y reglas puras (calidad, saltos, huecos, detenciones, geocercas con histéresis, corredor/desvío, avance) más la estrategia de captura.
- **Criterios:** pruebas unitarias con trayectorias conocidas: la distancia Haversine coincide con valores de referencia (±0,1 %); una oscilación sobre el borde de una geocerca **no** genera eventos repetidos; un punto aislado dentro de la geocerca **no** confirma la entrada; una detención de 10 min se detecta y una de 1 min no; un salto de 5 km en 10 s se marca como outlier.

### Etapa 2 — Backend y base de datos
- Migración `0001`, runner, auth, orgs, dispositivos, consentimiento, ingesta, sync state, track, eventos, worker, health, OpenAPI, logs.
- **Criterios (integración contra PostGIS real):** reenviar el mismo lote 3 veces deja N filas, no 3N; el usuario B recibe 404 en el track de un dispositivo de A; sin consentimiento la ingesta da 403; un lote con 501 puntos da 413/400; puntos atrasados recalculan una detención (el evento previo pasa a `superseded`); `/health/ready` falla si la base de datos cae; `/v1/docs` lista todos los endpoints.

### Etapa 3 — App móvil (flujo esencial)
- Login → permisos → iniciar → capturar → SQLite → sync → estado → finalizar. Después viajes, geocercas y el resto de pantallas.
- **Criterios automáticos:** pruebas de cola y sync (simulando fallo de red, 5xx, reinicio de la app con cola a medio enviar: nada se pierde ni se duplica); `expo prebuild` y `tsc` pasan; el APK de desarrollo compila (si el entorno lo permite).
- **Criterios en dispositivo físico (pendientes hasta disponer de uno):** captura con la pantalla bloqueada durante 30 min; modo avión durante 10 min y luego sincronización completa; cierre forzado detectado como hueco; revocación de permisos reflejada en la UI.

### Etapa 4 — Web
- BFF y auth, dashboard, dispositivos, mapa y recorrido, timeline, reproductor, eventos, geocercas, viajes y comparación, exportaciones, SSE.
- **Criterios:** e2e de Playwright (login → seleccionar dispositivo demo → ver track con hueco → reproducir → abrir evento → el mapa se centra → exportar GPX válido); el dashboard sin datos muestra el estado vacío; un viewer sin consentimiento compartido no ve el dispositivo.

### Etapa 5 — Integración
- Script de extremo a extremo que simula la app real (mismo cliente de sync que el móvil) → API → DB → worker → SSE → web.
- **Criterios:** un punto enviado aparece en la web en menos de 5 s (con el worker en proceso); otro usuario de la misma organización, con rol viewer y consentimiento compartido, ve el historial.

### Etapa 6 — Estabilización y Railway
- Suite completa, revisión de seguridad, carga básica (por ejemplo 50 dispositivos × lotes de 100), `.railway/railway.ts`, `docs/RAILWAY_DEPLOYMENT.md`, matriz de funcionalidades.
- **Criterios:** `npm run build` y el arranque con los comandos de producción se verifican localmente con `NODE_ENV=production`; la imagen Docker de PostGIS más las migraciones se reproducen desde cero. **Despliegue real:** solo si el propietario vincula la cuenta de Railway. Los cuatro estados del spec (preparado, ejecutado, validado, validado funcionalmente) se informan por separado.
