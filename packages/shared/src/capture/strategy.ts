import { DEFAULT_TRACKING_CONFIG, type TrackingConfigParams } from '../contracts/tracking-config.js';
import { haversineM, headingDelta } from '../geo.js';

export interface CaptureFix {
  t: number;
  lat: number;
  lon: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
}

export type MotionState = 'unknown' | 'moving' | 'stationary';

export interface CaptureState {
  lastKept: CaptureFix | null;
  anchor: CaptureFix | null;
  anchorSince: number | null;
  motion: MotionState;
}

export const INITIAL_CAPTURE_STATE: CaptureState = { lastKept: null, anchor: null, anchorSince: null, motion: 'unknown' };

export type CaptureReason =
  | 'first'
  | 'motion_change'
  | 'distance'
  | 'interval'
  | 'heading'
  | 'stationary_heartbeat'
  | 'low_accuracy_heartbeat'
  | 'low_accuracy'
  | 'stale'
  | 'throttled';

export interface CaptureDecision {
  keep: boolean;
  reason: CaptureReason;
  state: CaptureState;
  /** Parámetros efectivos aplicados (pueden diferir del modo por batería baja). */
  effective: TrackingConfigParams;
}

export interface CaptureContext {
  batteryLevel?: number | null;
  charging?: boolean | null;
}

/** Con batería baja y sin cargar, se espacian los puntos como en el modo de ahorro. */
export function effectiveParams(p: TrackingConfigParams, ctx: CaptureContext): TrackingConfigParams {
  const low = ctx.batteryLevel != null && !ctx.charging && ctx.batteryLevel < p.lowBatteryThreshold;
  if (!low) return p;
  const saver = DEFAULT_TRACKING_CONFIG.battery_saver;
  return {
    ...p,
    minDistanceM: Math.max(p.minDistanceM, saver.minDistanceM),
    maxIntervalMovingS: Math.max(p.maxIntervalMovingS, saver.maxIntervalMovingS),
    stationaryIntervalS: Math.max(p.stationaryIntervalS, saver.stationaryIntervalS),
    syncIntervalS: Math.max(p.syncIntervalS, saver.syncIntervalS),
  };
}

/**
 * Decide si se conserva un fix del SO. Es una función pura: el estado se persiste fuera
 * (la tarea de segundo plano puede ejecutarse en un contexto JS nuevo).
 * Considera distancia, tiempo, velocidad, rumbo, calidad, estado de movimiento y batería.
 */
export function decideCapture(state: CaptureState, fix: CaptureFix, params: TrackingConfigParams, ctx: CaptureContext = {}): CaptureDecision {
  const p = effectiveParams(params, ctx);
  const last = state.lastKept;
  const done = (keep: boolean, reason: CaptureReason, s: CaptureState): CaptureDecision => ({
    keep,
    reason,
    state: keep ? { ...s, lastKept: fix } : s,
    effective: p,
  });

  if (last && fix.t <= last.t) return done(false, 'stale', state);

  if (fix.accuracy == null || fix.accuracy > p.maxAccuracyM) {
    // Se conserva como latido para distinguir "sin señal buena" de "sin datos".
    if (!last || fix.t - last.t >= p.stationaryIntervalS * 1000) return done(true, 'low_accuracy_heartbeat', state);
    return done(false, 'low_accuracy', state);
  }

  // Estado de movimiento con ancla y radio (el radio crece con la imprecisión del fix).
  let { anchor, anchorSince, motion } = state;
  const prevMotion = motion;
  if (!anchor || anchorSince == null) {
    anchor = fix;
    anchorSince = fix.t;
  } else if (haversineM(anchor, fix) > Math.max(p.stationaryRadiusM, fix.accuracy)) {
    motion = 'moving';
    anchor = fix;
    anchorSince = fix.t;
  } else if (fix.t - anchorSince >= p.stationaryAfterS * 1000 && (fix.speed == null || fix.speed < p.stationarySpeedMps)) {
    motion = 'stationary';
  }
  const next: CaptureState = { lastKept: last, anchor, anchorSince, motion };

  if (!last) return done(true, 'first', next);
  if (prevMotion !== motion && prevMotion !== 'unknown') return done(true, 'motion_change', next);

  const dt = fix.t - last.t;
  if (motion === 'stationary') {
    return dt >= p.stationaryIntervalS * 1000 ? done(true, 'stationary_heartbeat', next) : done(false, 'throttled', next);
  }
  const d = haversineM(last, fix);
  if (d >= p.minDistanceM) return done(true, 'distance', next);
  if (dt >= p.maxIntervalMovingS * 1000) return done(true, 'interval', next);
  if (
    fix.heading != null &&
    last.heading != null &&
    (fix.speed ?? 0) > 2 &&
    d >= 5 &&
    headingDelta(fix.heading, last.heading) >= p.headingChangeDeg
  )
    return done(true, 'heading', next);
  return done(false, 'throttled', next);
}
