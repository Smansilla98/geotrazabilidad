import { z } from 'zod';
import type { TrackingMode } from './common.js';

/**
 * Parámetros de captura por modo. El servidor puede enviar una versión propia;
 * la app usa DEFAULT_TRACKING_CONFIG cuando no hay conexión o la config remota es inválida.
 */
export const TrackingConfigParams = z.object({
  /** Precisión solicitada al SO. */
  accuracy: z.enum(['low', 'balanced', 'high', 'highest']),
  /** distanceInterval nativo (m): el SO no entrega fixes con menos desplazamiento. */
  nativeDistanceM: z.number().min(0).max(1000),
  /** timeInterval nativo (ms, solo Android). */
  nativeIntervalMs: z.number().int().min(1000).max(15 * 60_000),
  /** Distancia mínima entre puntos conservados en movimiento (m). */
  minDistanceM: z.number().min(0).max(2000),
  /** Tiempo máximo sin conservar un punto en movimiento (s). */
  maxIntervalMovingS: z.number().min(1).max(3600),
  /** Intervalo de punto de "latido" estando detenido (s). */
  stationaryIntervalS: z.number().min(10).max(6 * 3600),
  /** Cambio de rumbo que fuerza conservar un punto (grados). */
  headingChangeDeg: z.number().min(5).max(180),
  /** Puntos con peor precisión se descartan salvo como latido (m). */
  maxAccuracyM: z.number().min(5).max(5000),
  /** Velocidad por debajo de la cual se considera quieto (m/s). */
  stationarySpeedMps: z.number().min(0).max(5),
  /** Radio para considerar que no se movió (m). */
  stationaryRadiusM: z.number().min(5).max(500),
  /** Tiempo dentro del radio para pasar a "detenido" (s). */
  stationaryAfterS: z.number().min(10).max(3600),
  /** Agrupar entregas en segundo plano (ms); 0 = sin diferir. */
  deferredUpdatesIntervalMs: z.number().int().min(0).max(30 * 60_000),
  /** Intervalo de sincronización con conexión (s). */
  syncIntervalS: z.number().int().min(10).max(3600),
  /** Por debajo de este nivel de batería se aplican los parámetros de ahorro. */
  lowBatteryThreshold: z.number().min(0).max(1),
});
export type TrackingConfigParams = z.infer<typeof TrackingConfigParams>;

export const DEFAULT_TRACKING_CONFIG: Record<TrackingMode, TrackingConfigParams> = {
  battery_saver: {
    accuracy: 'balanced',
    nativeDistanceM: 50,
    nativeIntervalMs: 60_000,
    minDistanceM: 100,
    maxIntervalMovingS: 300,
    stationaryIntervalS: 1800,
    headingChangeDeg: 60,
    maxAccuracyM: 200,
    stationarySpeedMps: 0.8,
    stationaryRadiusM: 75,
    stationaryAfterS: 300,
    deferredUpdatesIntervalMs: 5 * 60_000,
    syncIntervalS: 900,
    lowBatteryThreshold: 0,
  },
  normal: {
    accuracy: 'balanced',
    nativeDistanceM: 20,
    nativeIntervalMs: 15_000,
    minDistanceM: 40,
    maxIntervalMovingS: 120,
    stationaryIntervalS: 900,
    headingChangeDeg: 45,
    maxAccuracyM: 100,
    stationarySpeedMps: 0.6,
    stationaryRadiusM: 40,
    stationaryAfterS: 180,
    deferredUpdatesIntervalMs: 60_000,
    syncIntervalS: 300,
    lowBatteryThreshold: 0.15,
  },
  trip: {
    accuracy: 'high',
    nativeDistanceM: 10,
    nativeIntervalMs: 5_000,
    minDistanceM: 20,
    maxIntervalMovingS: 30,
    stationaryIntervalS: 300,
    headingChangeDeg: 30,
    maxAccuracyM: 65,
    stationarySpeedMps: 0.5,
    stationaryRadiusM: 30,
    stationaryAfterS: 120,
    deferredUpdatesIntervalMs: 0,
    syncIntervalS: 60,
    lowBatteryThreshold: 0.15,
  },
  intensive: {
    accuracy: 'highest',
    nativeDistanceM: 0,
    nativeIntervalMs: 2_000,
    minDistanceM: 5,
    maxIntervalMovingS: 5,
    stationaryIntervalS: 60,
    headingChangeDeg: 15,
    maxAccuracyM: 50,
    stationarySpeedMps: 0.4,
    stationaryRadiusM: 20,
    stationaryAfterS: 60,
    deferredUpdatesIntervalMs: 0,
    syncIntervalS: 30,
    lowBatteryThreshold: 0.2,
  },
};
