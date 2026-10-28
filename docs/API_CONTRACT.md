# Contrato de API v1 (borrador de Fase 1)

- Prefijo `/v1`. Formato JSON con fechas en ISO-8601 UTC (`2026-10-27T13:05:12.345Z`).
- Esquemas zod en `packages/shared/contracts`, que generan OpenAPI servido en `/v1/docs` (deshabilitable en producción con `API_DOCS_ENABLED`).
- Errores con el formato `{ "error": { "code": "CONSENT_REQUIRED", "message": "…", "details": {…} } }`.
- Autenticación con `Authorization: Bearer <access>`. Hay dos tipos de principal:
  - **usuario**: JWT de 15 min y refresh rotativo de 30 días;
  - **dispositivo**: JWT con `sub=device_id` y alcance `ingest`, solo válido mientras el dispositivo esté `active` y con consentimiento vigente.

## Endpoints

| Método | Ruta | Principal | Descripción |
|---|---|---|---|
| POST | `/v1/auth/register` | — | Crea usuario y organización personal |
| POST | `/v1/auth/login` | — | Devuelve access y refresh |
| POST | `/v1/auth/refresh` | — | Rota el refresh. Un reuso revoca toda la familia |
| POST | `/v1/auth/logout` | usuario | Revoca la familia |
| POST | `/v1/auth/password/forgot` | — | Siempre responde 202 (no revela si el email existe) |
| POST | `/v1/auth/password/reset` | — | Token de un solo uso |
| GET | `/v1/me` | usuario | Perfil y membresías |
| GET/POST | `/v1/orgs/:orgId/members` | owner/admin | Gestión de miembros |
| PATCH | `/v1/orgs/:orgId` | owner | Nombre y `retention_days` |
| POST | `/v1/devices` | usuario | Vincula un dispositivo (`installId`, plataforma, modelo) y devuelve el token de dispositivo |
| GET | `/v1/devices` | usuario | Dispositivos visibles con `connectionState`, última posición y sync |
| GET/PATCH/DELETE | `/v1/devices/:id` | titular/admin | Detalle, renombrar, eliminar |
| POST | `/v1/devices/:id/revoke` | titular/admin | Revoca el acceso |
| POST | `/v1/devices/:id/consent` | titular | Otorga o actualiza el consentimiento (`version`, `shareWithOrg`) |
| DELETE | `/v1/devices/:id/consent` | titular | Revoca el consentimiento |
| GET | `/v1/devices/:id/config` | dispositivo | Estrategia de captura vigente (`version`, parámetros por modo) |
| POST | `/v1/devices/:id/heartbeat` | dispositivo | `pendingCount`, permisos, batería, versión |
| POST | `/v1/ingest/batches` | dispositivo | **Ingesta por lotes** (ver abajo) |
| GET | `/v1/devices/:id/sessions` | usuario | Seguimientos paginados |
| GET | `/v1/devices/:id/points` | usuario | Puntos crudos paginados por cursor `(captured_at, id)`, máx. 5000 |
| GET | `/v1/devices/:id/track` | usuario | Recorrido reconstruido con segmentos, discontinuidades y simplificación |
| GET | `/v1/events` | usuario | Filtros: `deviceId`, `tripId`, `types[]`, `from`, `to`, `confidence[]`. Paginado |
| GET | `/v1/events/:id` | usuario | Incluye `evidence` y `ruleParams` |
| CRUD | `/v1/geofences` | usuario (escritura owner/admin) | Círculo o polígono GeoJSON |
| CRUD | `/v1/trips` | usuario (escritura owner/admin) | |
| POST | `/v1/trips/:id/route` | owner/admin | Calcula y guarda la ruta estimada con el proveedor configurado |
| GET | `/v1/trips/:id/progress` | usuario | Distancia recorrida/restante, tiempo transcurrido, ETA si hay base, desvío |
| GET | `/v1/trips/:id/comparison` | usuario | Planificada vs. real (ver abajo) |
| GET | `/v1/stats/overview` | usuario | Indicadores del dashboard |
| GET | `/v1/exports/track` | usuario | `deviceId`, `from`, `to`, `format=csv\|json\|geojson\|gpx\|kml`, en streaming y auditado |
| GET | `/v1/exports/events` | usuario | `format=csv\|json` |
| GET | `/v1/me/export` | usuario | Exportación de los datos propios (portabilidad) |
| GET | `/v1/stream` | usuario | SSE: `point.batch`, `event.upsert`, `device.state`, filtrado por dispositivos visibles |
| GET | `/health/live` | — | Proceso vivo |
| GET | `/health/ready` | — | DB alcanzable, PostGIS presente, migraciones al día |

## Ingesta por lotes

`POST /v1/ingest/batches`. Límite: 500 puntos y 1 MB de cuerpo. Rate limit: 60 lotes/min por dispositivo.

```json
{
  "batchId": "0192d0c4-…",
  "sentAt": "2026-10-27T13:05:00.000Z",
  "client": { "appVersion": "1.0.0", "pendingCount": 1240, "batteryLevel": 0.62,
              "permission": "always", "configVersion": 3 },
  "sessions": [
    { "id": "0192d0c0-…", "startedAt": "2026-10-27T12:00:00.000Z", "endedAt": null,
      "mode": "trip", "tripId": null, "configSnapshot": { "…": "…" } }
  ],
  "points": [
    { "id": "0192d0c1-…", "sessionId": "0192d0c0-…", "seq": 17,
      "capturedAt": "2026-10-27T12:03:10.120Z",
      "lat": -34.6037, "lon": -58.3816,
      "accuracy": 8.5, "altitude": 25.1, "altitudeAccuracy": 3.0,
      "speed": 11.2, "heading": 93.4, "source": "fused", "mocked": false, "battery": 0.62 }
  ]
}
```

Respuesta `200` (también en reenvíos):

```json
{
  "batchId": "0192d0c4-…",
  "serverTime": "2026-10-27T13:05:01.010Z",
  "accepted":   ["0192d0c1-…"],
  "duplicates": [],
  "rejected":   [{ "id": "…", "code": "LAT_OUT_OF_RANGE" }],
  "config": { "version": 3, "changed": false }
}
```

Reglas:
- Una sesión es un upsert idempotente por `id`: el cliente la reenvía en cada lote que tenga puntos de ella hasta que la confirme.
- `accepted` y `duplicates` se dan por confirmados en el cliente y se marcan `acked`. `rejected` es un rechazo **permanente** de validación: no se reintenta y se guarda localmente para diagnóstico. Un error 5xx o de red reintenta el lote completo.
- Validaciones por punto: rangos de lat/lon, `capturedAt` no más de 5 min en el futuro respecto del servidor (corregido por el desfase estimado; si no, se acepta con la marca `future_ts`), `capturedAt` no anterior al inicio de la sesión menos 1 min, y la sesión debe pertenecer al dispositivo.
- La ingesta **no** calcula eventos. Solo marca `reprocess_from` y responde rápido.

## Recorrido reconstruido

`GET /v1/devices/:id/track?from&to&tolerance=auto`

```json
{
  "deviceId": "…", "from": "…", "to": "…",
  "stats": { "distanceM": 18420.5, "observedPoints": 1312, "returnedPoints": 640,
             "simplified": true, "gaps": 2, "outliers": 3 },
  "segments": [
    { "kind": "observed", "startAt": "…", "endAt": "…",
      "points": [[lon, lat, epochMs, pointId, accuracy, speed, flags], "…"] },
    { "kind": "gap", "startAt": "…", "endAt": "…", "durationS": 1260, "reason": "no_data" }
  ],
  "outliers": [ { "pointId": 123, "lon": 0, "lat": 0, "at": "…", "flag": "jump" } ]
}
```

Corte de segmento cuando: `Δt > gapThreshold` (según el modo, por defecto 5 min), velocidad implícita > 70 m/s, o cambio de sesión. La simplificación (`ST_SimplifyPreserveTopology` o Douglas-Peucker con tolerancia según zoom/bbox) se aplica **solo** dentro de segmentos observados y siempre conserva los extremos y los puntos asociados a eventos. Cada punto devuelto mantiene su `pointId`.

## Comparación planificado vs. real

`GET /v1/trips/:id/comparison`

```json
{
  "planned":  { "provider": "osrm", "distanceM": 21000, "durationS": 1800, "durationKind": "provider_no_traffic" },
  "observed": { "distanceM": 23650, "durationS": 2410, "startedAt": "…", "endedAt": "…" },
  "diff":     { "distanceM": 2650, "durationS": 610 },
  "arrival":  { "reached": true, "confidence": "confirmed", "at": "…" },
  "progress": { "fraction": 1.0, "reliable": true },
  "deviations": [
    { "status": "confirmed", "startAt": "…", "endAt": "…", "maxOffsetM": 840,
      "startPointId": 991, "rejoinPointId": 1040 },
    { "status": "possible", "…": "…" }
  ],
  "coverage": { "observedFraction": 0.93, "gaps": [ { "startAt": "…", "endAt": "…" } ] },
  "method": "corridor.v1", "params": { "corridorM": 75, "minDurationS": 60, "minPoints": 3 }
}
```

Método `corridor.v1`: cada punto observado se proyecta sobre la polilínea planificada con `ST_LineLocatePoint` y su distancia geodésica.
- Fuera de corredor: `distancia > max(corridorM, 2 × accuracy)`.
- `confirmed`: al menos `minPoints` consecutivos y `minDurationS` fuera del corredor, todos con `accuracy ≤ 50 m`.
- `possible`: hay puntos fuera del corredor, pero no alcanzan esos umbrales.
- `imprecise`: hay puntos fuera, pero su accuracy no permite decidir.
- `insufficient_data`: el tramo cae en un hueco.
- Avance: máximo **monótono** de la fracción a lo largo de la ruta, solo con puntos dentro del corredor. Se marca `reliable = false` si la cobertura es menor al 60 %.
- El map matching (OSRM `/match`) queda como mejora posterior, detrás de la misma interfaz.
