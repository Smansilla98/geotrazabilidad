import type { TrackingConfigParams, TrackingMode } from '@geo/shared';

/**
 * Traduce los parámetros de un modo a opciones nativas de expo-location (función pura, probada).
 * La precisión se devuelve como nombre; tracking.ts la mapea al enum de expo-location.
 */
export function nativeOptions(mode: TrackingMode, p: TrackingConfigParams) {
  return {
    accuracy: p.accuracy,
    distanceInterval: p.nativeDistanceM,
    timeInterval: p.nativeIntervalMs,
    deferredUpdatesInterval: p.deferredUpdatesIntervalMs,
    deferredUpdatesDistance: p.deferredUpdatesIntervalMs > 0 ? Math.max(p.minDistanceM, 50) : 0,
    activityType: mode === 'trip' || mode === 'intensive' ? 'automotive' : 'other',
    // La pausa automática de iOS puede no reanudarse sola: se desactiva y se ahorra con distancia y diferimiento.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  } as const;
}

/** Normaliza la fuente reportada (Android expone "mocked"; la API no siempre indica el proveedor). */
export function sourceOf(mocked: boolean | undefined): 'fused' | 'unknown' {
  return mocked === undefined ? 'unknown' : 'fused';
}
