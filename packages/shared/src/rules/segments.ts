import { haversineM } from '../geo.js';
import { classifyPoints, gapThresholdS, sortPoints, type ClassifiedPoint } from './quality.js';
import { DEFAULT_SESSION_TIMING, type ObservedPoint, type RuleParams, type SessionTiming } from './types.js';

export type GapReason = 'no_data' | 'session_boundary' | 'implausible_jump';

export type RawSegment =
  | { kind: 'observed'; sessionId: string; points: ClassifiedPoint[] }
  | { kind: 'gap'; reason: GapReason; from: ClassifiedPoint; to: ClassifiedPoint; durationS: number; distanceM: number };

export interface Reconstruction {
  segments: RawSegment[];
  outliers: ClassifiedPoint[];
  classified: ClassifiedPoint[];
  /** Distancia sumada solo dentro de segmentos observados (los huecos no se cuentan). */
  observedDistanceM: number;
}

/**
 * Reconstruye el recorrido: ordena por hora de captura, separa outliers y corta la línea
 * en cambios de sesión, huecos temporales y reubicaciones inverosímiles.
 * Nunca une con una línea dos puntos separados por un hueco.
 */
export function reconstructTrack(
  points: readonly ObservedPoint[],
  params: RuleParams,
  timingFor: (sessionId: string) => SessionTiming = () => DEFAULT_SESSION_TIMING,
): Reconstruction {
  const classified = classifyPoints(sortPoints(points), params);
  const usable = classified.filter((c) => c.usable);
  const outliers = classified.filter((c) => !c.usable);
  const segments: RawSegment[] = [];
  let current: ClassifiedPoint[] = [];
  let distance = 0;

  const flush = () => {
    if (current.length) segments.push({ kind: 'observed', sessionId: current[0]!.p.sessionId, points: current });
    current = [];
  };

  for (const c of usable) {
    const prev = current[current.length - 1];
    if (prev) {
      const dt = (c.p.t - prev.p.t) / 1000;
      const d = haversineM(prev.p, c.p);
      let reason: GapReason | null = null;
      if (prev.p.sessionId !== c.p.sessionId) reason = 'session_boundary';
      else if (c.relocation) reason = 'implausible_jump';
      else if (dt > gapThresholdS(timingFor(c.p.sessionId), params)) reason = 'no_data';
      if (reason) {
        flush();
        segments.push({ kind: 'gap', reason, from: prev, to: c, durationS: dt, distanceM: d });
      } else {
        distance += d;
      }
    }
    current.push(c);
  }
  flush();
  return { segments, outliers, classified, observedDistanceM: distance };
}
