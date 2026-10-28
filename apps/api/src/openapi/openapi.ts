import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Controller, Get, Header, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import type { Response } from 'express';
import { z, type ZodType } from 'zod';
import * as C from '@geo/shared';
import { ENV } from '../auth/tokens.js';
import { Public } from '../common/http.js';
import type { Env } from '../config/env.js';

extendZodWithOpenApi(z);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  auth?: 'user' | 'device' | 'none' | 'user_or_device';
  body?: ZodType;
  query?: z.ZodObject;
  response?: ZodType;
  status?: number;
}

/**
 * Documentación OpenAPI generada desde los mismos esquemas zod que validan las solicitudes
 * (packages/shared). Esta lista de rutas es la que se revisa contra los controladores en las pruebas.
 */
export const ROUTES: Route[] = [
  { method: 'post', path: '/v1/auth/register', summary: 'Registro de usuario (crea su organización personal)', tag: 'Auth', auth: 'none', body: C.RegisterRequest, response: C.TokenPair, status: 201 },
  { method: 'post', path: '/v1/auth/login', summary: 'Inicio de sesión', tag: 'Auth', auth: 'none', body: C.LoginRequest, response: C.TokenPair },
  { method: 'post', path: '/v1/auth/refresh', summary: 'Rotación de refresh token', tag: 'Auth', auth: 'none', body: C.RefreshRequest, response: C.TokenPair },
  { method: 'post', path: '/v1/auth/logout', summary: 'Cierre de sesión (revoca la familia de tokens)', tag: 'Auth', auth: 'none', body: C.RefreshRequest, status: 204 },
  { method: 'post', path: '/v1/auth/password/forgot', summary: 'Solicitud de recuperación (siempre 202)', tag: 'Auth', auth: 'none', body: C.ForgotPasswordRequest, status: 202 },
  { method: 'post', path: '/v1/auth/password/reset', summary: 'Nueva contraseña con token de un solo uso', tag: 'Auth', auth: 'none', body: C.ResetPasswordRequest, status: 204 },
  { method: 'get', path: '/v1/me', summary: 'Perfil y membresías', tag: 'Auth', response: C.MeResponse },
  { method: 'get', path: '/v1/me/export', summary: 'Exportación de datos propios (JSON)', tag: 'Privacidad' },
  { method: 'get', path: '/v1/orgs/{orgId}/members', summary: 'Miembros de la organización', tag: 'Organizaciones' },
  { method: 'post', path: '/v1/orgs/{orgId}/members', summary: 'Agregar miembro existente (owner/admin)', tag: 'Organizaciones', body: C.AddMemberRequest },
  { method: 'patch', path: '/v1/orgs/{orgId}/members/{userId}', summary: 'Cambiar rol (owner)', tag: 'Organizaciones' },
  { method: 'delete', path: '/v1/orgs/{orgId}/members/{userId}', summary: 'Quitar miembro', tag: 'Organizaciones', status: 204 },
  { method: 'patch', path: '/v1/orgs/{orgId}', summary: 'Nombre y retención (owner)', tag: 'Organizaciones', body: C.UpdateOrgRequest },
  { method: 'get', path: '/v1/orgs/{orgId}/tracking-config', summary: 'Estrategia de captura de la organización', tag: 'Organizaciones', response: C.TrackingConfigResponse },
  { method: 'put', path: '/v1/orgs/{orgId}/tracking-config', summary: 'Actualizar estrategia de captura (owner/admin)', tag: 'Organizaciones' },
  { method: 'post', path: '/v1/devices', summary: 'Vincular dispositivo y obtener credenciales', tag: 'Dispositivos', body: C.RegisterDeviceRequest, response: C.DeviceTokenResponse, status: 201 },
  { method: 'post', path: '/v1/devices/token/refresh', summary: 'Rotación del token de dispositivo', tag: 'Dispositivos', auth: 'none', body: C.DeviceRefreshRequest, response: C.DeviceTokenResponse },
  { method: 'get', path: '/v1/devices', summary: 'Dispositivos visibles con estado de conexión', tag: 'Dispositivos', response: z.array(C.DeviceSummary) },
  { method: 'get', path: '/v1/devices/{id}', summary: 'Detalle de dispositivo', tag: 'Dispositivos', auth: 'user_or_device', response: C.DeviceSummary },
  { method: 'patch', path: '/v1/devices/{id}', summary: 'Renombrar', tag: 'Dispositivos', body: C.UpdateDeviceRequest, response: C.DeviceSummary },
  { method: 'delete', path: '/v1/devices/{id}', summary: 'Eliminar dispositivo y todo su historial', tag: 'Dispositivos', status: 204 },
  { method: 'post', path: '/v1/devices/{id}/revoke', summary: 'Revocar acceso', tag: 'Dispositivos', response: C.DeviceSummary },
  { method: 'post', path: '/v1/devices/{id}/consent', summary: 'Otorgar consentimiento (solo titular)', tag: 'Dispositivos', body: C.ConsentRequest, response: C.DeviceSummary },
  { method: 'delete', path: '/v1/devices/{id}/consent', summary: 'Revocar consentimiento (solo titular)', tag: 'Dispositivos', status: 204 },
  { method: 'get', path: '/v1/devices/{id}/config', summary: 'Configuración de captura vigente', tag: 'Dispositivos', auth: 'device', response: C.TrackingConfigResponse },
  { method: 'post', path: '/v1/devices/{id}/heartbeat', summary: 'Latido del dispositivo (cola pendiente, permisos)', tag: 'Dispositivos', auth: 'device', body: C.HeartbeatRequest },
  { method: 'post', path: '/v1/ingest/batches', summary: 'Ingesta idempotente por lotes (máx. 500 puntos / 1 MB)', tag: 'Ingesta', auth: 'device', body: C.IngestBatchRequest, response: C.IngestBatchResponse },
  { method: 'get', path: '/v1/devices/{id}/sessions', summary: 'Sesiones de seguimiento', tag: 'Recorridos', response: z.array(C.SessionSummary) },
  { method: 'get', path: '/v1/devices/{id}/points', summary: 'Puntos crudos paginados por cursor', tag: 'Recorridos' },
  { method: 'get', path: '/v1/devices/{id}/track', summary: 'Recorrido reconstruido (segmentos, huecos, outliers)', tag: 'Recorridos', query: C.TrackQuery, response: C.TrackResponse },
  { method: 'get', path: '/v1/events', summary: 'Eventos derivados (paginado)', tag: 'Eventos', query: C.EventsQuery },
  { method: 'get', path: '/v1/events/{id}', summary: 'Evento con evidencia y parámetros de la regla', tag: 'Eventos', response: C.TrackingEventDto },
  { method: 'get', path: '/v1/geofences', summary: 'Geocercas', tag: 'Geocercas', response: z.array(C.GeofenceDto) },
  { method: 'post', path: '/v1/geofences', summary: 'Crear geocerca (owner/admin)', tag: 'Geocercas', body: C.GeofenceInput, response: C.GeofenceDto, status: 201 },
  { method: 'get', path: '/v1/geofences/{id}', summary: 'Detalle de geocerca', tag: 'Geocercas', response: C.GeofenceDto },
  { method: 'put', path: '/v1/geofences/{id}', summary: 'Actualizar geocerca', tag: 'Geocercas', body: C.GeofenceInput, response: C.GeofenceDto },
  { method: 'delete', path: '/v1/geofences/{id}', summary: 'Eliminar geocerca', tag: 'Geocercas', status: 204 },
  { method: 'get', path: '/v1/trips', summary: 'Viajes', tag: 'Viajes', response: z.array(C.TripDto) },
  { method: 'post', path: '/v1/trips', summary: 'Crear viaje (owner/admin)', tag: 'Viajes', body: C.TripInput, response: C.TripDto, status: 201 },
  { method: 'get', path: '/v1/trips/{id}', summary: 'Detalle de viaje', tag: 'Viajes', response: C.TripDto },
  { method: 'patch', path: '/v1/trips/{id}', summary: 'Actualizar viaje', tag: 'Viajes', body: C.TripUpdate, response: C.TripDto },
  { method: 'delete', path: '/v1/trips/{id}', summary: 'Eliminar viaje', tag: 'Viajes', status: 204 },
  { method: 'post', path: '/v1/trips/{id}/route', summary: 'Calcular ruta estimada (OSRM o línea recta)', tag: 'Viajes', body: C.RouteRequest, response: C.TripDto, status: 201 },
  { method: 'get', path: '/v1/trips/{id}/comparison', summary: 'Comparación planificado vs. observado', tag: 'Viajes', response: C.TripComparison },
  { method: 'get', path: '/v1/trips/{id}/progress', summary: 'Progreso del viaje', tag: 'Viajes' },
  { method: 'get', path: '/v1/stats/overview', summary: 'Indicadores del dashboard', tag: 'Estadísticas', response: C.StatsOverview },
  { method: 'get', path: '/v1/exports/track', summary: 'Exportar recorrido (csv, json, geojson, gpx, kml)', tag: 'Exportación', query: C.ExportQuery },
  { method: 'get', path: '/v1/exports/events', summary: 'Exportar eventos (csv, json)', tag: 'Exportación', query: C.EventsExportQuery },
  { method: 'get', path: '/v1/stream', summary: 'Server-Sent Events: avisos de cambios', tag: 'Tiempo real' },
  { method: 'post', path: '/v1/demo/load', summary: 'Cargar escenarios de demostración (owner/admin)', tag: 'Demo' },
  { method: 'delete', path: '/v1/demo', summary: 'Borrar datos de demostración', tag: 'Demo', status: 204 },
  { method: 'get', path: '/health/live', summary: 'Liveness', tag: 'Salud', auth: 'none' },
  { method: 'get', path: '/health/ready', summary: 'Readiness (DB, PostGIS, migraciones)', tag: 'Salud', auth: 'none' },
];

let cached: object | null = null;

export function buildOpenApi(): object {
  if (cached) return cached;
  const reg = new OpenAPIRegistry();
  const bearer = reg.registerComponent('securitySchemes', 'userBearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de usuario' });
  const device = reg.registerComponent('securitySchemes', 'deviceBearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de dispositivo' });
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const auth = r.auth ?? 'user';
    reg.registerPath({
      method: r.method,
      path: r.path,
      summary: r.summary,
      tags: [r.tag],
      security: auth === 'none' ? [] : auth === 'device' ? [{ [device.name]: [] }] : auth === 'user_or_device' ? [{ [bearer.name]: [] }, { [device.name]: [] }] : [{ [bearer.name]: [] }],
      request: {
        params: params.length ? z.object(Object.fromEntries(params.map((p) => [p, z.string()]))) : undefined,
        query: r.query,
        body: r.body ? { content: { 'application/json': { schema: r.body } } } : undefined,
      },
      responses: {
        [r.status ?? 200]: { description: 'OK', content: r.response ? { 'application/json': { schema: r.response } } : undefined },
        400: { description: 'Datos inválidos', content: { 'application/json': { schema: C.ApiErrorSchema } } },
        401: { description: 'No autenticado' },
        404: { description: 'No encontrado o sin acceso' },
      },
    });
  }
  cached = new OpenApiGeneratorV31(reg.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'API de geolocalización y trazabilidad',
      version: '1.0.0',
      description: 'API v1. Las posiciones son datos observados; los eventos son inferencias versionadas con evidencia; las rutas planificadas son estimaciones de un proveedor.',
    },
    servers: [{ url: '/' }],
  });
  return cached;
}

const require = createRequire(import.meta.url);
const swaggerDir = (() => {
  try {
    return dirname(require.resolve('swagger-ui-dist/package.json'));
  } catch {
    return null;
  }
})();

@Controller('v1')
@SkipThrottle()
export class DocsController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Public()
  @Get('openapi.json')
  spec() {
    if (!this.env.API_DOCS_ENABLED) throw new NotFoundException();
    return buildOpenApi();
  }

  @Public()
  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs() {
    if (!this.env.API_DOCS_ENABLED || !swaggerDir) throw new NotFoundException();
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>API v1</title>
<link rel="stylesheet" href="/v1/docs/assets/swagger-ui.css"></head><body><div id="ui"></div>
<script src="/v1/docs/assets/swagger-ui-bundle.js"></script>
<script src="/v1/docs/assets/init.js"></script></body></html>`;
  }

  @Public()
  @Get('docs/assets/init.js')
  @Header('Content-Type', 'application/javascript')
  init() {
    if (!this.env.API_DOCS_ENABLED) throw new NotFoundException();
    return `window.ui = SwaggerUIBundle({ url: '/v1/openapi.json', dom_id: '#ui' });`;
  }

  @Public()
  @Get('docs/assets/:file')
  asset(@Param('file') file: string, @Res() res: Response) {
    if (!this.env.API_DOCS_ENABLED || !swaggerDir) throw new NotFoundException();
    if (!file || !['swagger-ui.css', 'swagger-ui-bundle.js'].includes(file)) throw new NotFoundException();
    res.sendFile(`${swaggerDir}/${file}`);
  }
}
