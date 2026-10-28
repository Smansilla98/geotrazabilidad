import { Inject, Injectable } from '@nestjs/common';
import { haversineM, type LonLat } from '@geo/shared';
import { ENV } from '../auth/tokens.js';
import { AppError } from '../common/http.js';
import type { Env } from '../config/env.js';
import { logger } from '../logger.js';

export type Profile = 'driving' | 'cycling' | 'foot';

export interface RouteResult {
  provider: string;
  profile: Profile;
  coordinates: [number, number][];
  distanceM: number;
  durationS: number | null;
  durationKind: 'provider_no_traffic' | 'provider_with_traffic' | 'basic_estimate';
  meta: Record<string, unknown>;
}

/**
 * Proveedor de rutas. Capacidad separada de mapas y geocodificación.
 * OSRM no tiene datos de tráfico: la duración siempre se marca 'provider_no_traffic'.
 *
 * AVISO: el servidor demo público (router.project-osrm.org) es solo para desarrollo/pruebas,
 * sin SLA y con una política de uso que no admite tráfico de producción. Ver docs/PROVIDERS.md.
 */
@Injectable()
export class RoutingService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get isPublicDemo() {
    return /router\.project-osrm\.org/.test(this.env.OSRM_BASE_URL);
  }

  async route(origin: LonLat, destination: LonLat, profile: Profile, provider: 'configured' | 'straight_line' = 'configured'): Promise<RouteResult> {
    if (provider === 'straight_line') return this.straightLine(origin, destination, profile);
    if (this.env.ROUTING_PROVIDER === 'none') throw new AppError(503, 'ROUTING_DISABLED', 'No hay un proveedor de rutas configurado');
    if (this.isPublicDemo && profile !== 'driving') {
      throw new AppError(400, 'PROFILE_UNSUPPORTED', 'El servidor demo de OSRM solo ofrece el perfil "driving"');
    }
    const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
    const url = `${this.env.OSRM_BASE_URL.replace(/\/$/, '')}/route/v1/${profile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': this.env.ROUTING_USER_AGENT }, signal: AbortSignal.timeout(this.env.ROUTING_TIMEOUT_MS) });
    } catch (err) {
      logger.warn({ provider: 'osrm', err: { message: (err as Error).message }, ms: Date.now() - started }, 'routing.unreachable');
      throw new AppError(502, 'ROUTING_UNAVAILABLE', 'El proveedor de rutas no respondió. Podés reintentar o usar una estimación en línea recta.');
    }
    const body = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }>;
      data_version?: string;
    } | null;
    if (!res.ok || body?.code !== 'Ok' || !body.routes?.[0]) {
      logger.warn({ provider: 'osrm', status: res.status, code: body?.code }, 'routing.failed');
      const noRoute = body?.code === 'NoRoute' || body?.code === 'NoSegment';
      throw new AppError(noRoute ? 422 : 502, noRoute ? 'NO_ROUTE' : 'ROUTING_FAILED', noRoute ? 'No hay una ruta entre origen y destino' : `Error del proveedor de rutas (${body?.code ?? res.status})`);
    }
    const r = body.routes[0];
    logger.info({ provider: 'osrm', ms: Date.now() - started, points: r.geometry.coordinates.length }, 'routing.ok');
    return {
      provider: 'osrm',
      profile,
      coordinates: r.geometry.coordinates,
      distanceM: r.distance,
      durationS: r.duration,
      durationKind: 'provider_no_traffic',
      meta: {
        baseUrl: this.env.OSRM_BASE_URL,
        publicDemo: this.isPublicDemo,
        dataVersion: body.data_version ?? null,
        attribution: '© OpenStreetMap contributors, OSRM',
      },
    };
  }

  /** Estimación básica, siempre identificada como tal. Velocidad media supuesta por perfil. */
  straightLine(origin: LonLat, destination: LonLat, profile: Profile): RouteResult {
    const speeds: Record<Profile, number> = { driving: 11.1, cycling: 4.2, foot: 1.4 };
    const d = haversineM(origin, destination);
    return {
      provider: 'straight_line',
      profile,
      coordinates: [
        [origin.lon, origin.lat],
        [destination.lon, destination.lat],
      ],
      distanceM: d,
      durationS: d / speeds[profile],
      durationKind: 'basic_estimate',
      meta: { assumedSpeedMps: speeds[profile], note: 'Línea recta: no representa la red vial' },
    };
  }
}
