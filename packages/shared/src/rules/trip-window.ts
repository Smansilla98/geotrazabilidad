import type { TrackingDirective } from '../contracts/api.js';
import type { TripStatus } from '../contracts/common.js';

/** Datos del viaje que definen hasta cuándo se registra (tiempos en epoch ms). */
export interface TripWindowInput {
  status: TripStatus;
  /** Inicio observado: el primer punto o la apertura de la primera sesión del viaje. */
  startedAt: number | null;
  /** Llegada (completed) o cancelación (cancelled). */
  endedAt: number | null;
  maxDurationS: number;
  stopGraceS: number;
}

/**
 * Fin de la ventana de registro del viaje. Lo que se captura después no pertenece al viaje:
 * - duración máxima desde el inicio (respaldo cuando no se detecta la llegada);
 * - llegada + margen de gracia;
 * - cancelación (sin margen).
 * null = la ventana sigue abierta.
 */
export function tripWindowEnd(t: TripWindowInput): number | null {
  const ends: number[] = [];
  if (t.startedAt != null) ends.push(t.startedAt + t.maxDurationS * 1000);
  if (t.status === 'completed' && t.endedAt != null) ends.push(t.endedAt + t.stopGraceS * 1000);
  if (t.status === 'cancelled' && t.endedAt != null) ends.push(t.endedAt);
  return ends.length ? Math.min(...ends) : null;
}

/** Indicación para el dispositivo: seguir registrando el viaje o detenerse, con el motivo. */
export function trackingDirectiveFor(t: TripWindowInput, now: number): Pick<TrackingDirective, 'state' | 'reason'> {
  if (t.status === 'cancelled') return { state: 'stop', reason: 'trip_cancelled' };
  if (t.status === 'completed' && t.endedAt != null && now >= t.endedAt + t.stopGraceS * 1000) return { state: 'stop', reason: 'trip_completed' };
  if (t.startedAt != null && now >= t.startedAt + t.maxDurationS * 1000) return { state: 'stop', reason: 'trip_max_duration' };
  return { state: 'active', reason: null };
}
