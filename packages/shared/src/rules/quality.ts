import { haversineM } from '../geo.js';
import type { ObservedPoint, RuleParams, SessionTiming } from './types.js';

export interface ClassifiedPoint {
  p: ObservedPoint;
  flags: Set<string>;
  /** Utilizable para la línea del recorrido y las reglas (no es salto/outlier). */
  usable: boolean;
  /** Se acepta, pero hubo un desplazamiento inverosímil respecto del anterior (reubicación real tras hueco). */
  relocation: boolean;
}

/** Orden canónico: hora de captura y, como desempate dentro de la sesión, seq. */
export function sortPoints<T extends ObservedPoint>(points: readonly T[]): T[] {
  return [...points].sort((a, b) => a.t - b.t || (a.sessionId === b.sessionId ? a.seq - b.seq : a.sessionId.localeCompare(b.sessionId)) || a.id - b.id);
}

function implausible(a: ObservedPoint, b: ObservedPoint, q: RuleParams['quality']): boolean {
  const d = haversineM(a, b);
  const tolerance = q.jumpMinDistanceM + (a.accuracy ?? 0) + (b.accuracy ?? 0);
  if (d <= tolerance) return false;
  const dt = (b.t - a.t) / 1000;
  return dt <= 0 || d / dt > q.maxSpeedMps;
}

/**
 * Clasifica calidad: precisión baja, saltos (outliers) y desorden de seq.
 * Un salto se confirma como outlier solo si el punto siguiente vuelve a ser coherente con el
 * último punto bueno. Si los puntos siguientes confirman la nueva ubicación, se trata como
 * reubicación (p. ej. tras un hueco largo): se acepta y la línea se corta.
 */
export function classifyPoints(sorted: readonly ObservedPoint[], params: RuleParams): ClassifiedPoint[] {
  const q = params.quality;
  const out: ClassifiedPoint[] = sorted.map((p) => {
    const flags = new Set<string>(p.flags);
    if (p.accuracy == null) flags.add('no_accuracy');
    else if (p.accuracy > q.lowAccuracyM) flags.add('low_accuracy');
    return { p, flags, usable: true, relocation: false };
  });

  const lastSeq = new Map<string, number>();
  let lastGood: ClassifiedPoint | null = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const prevSeq = lastSeq.get(c.p.sessionId);
    if (prevSeq !== undefined && c.p.seq < prevSeq) c.flags.add('out_of_order');
    lastSeq.set(c.p.sessionId, Math.max(prevSeq ?? -1, c.p.seq));

    if (!lastGood || lastGood.p.sessionId !== c.p.sessionId || !implausible(lastGood.p, c.p, q)) {
      lastGood = c;
      continue;
    }
    const next = out.slice(i + 1).find((n) => n.p.sessionId === c.p.sessionId);
    const nextAgreesWithCandidate = next && !implausible(c.p, next.p, q);
    const nextAgreesWithPrevious = next && !implausible(lastGood.p, next.p, q);
    if (nextAgreesWithCandidate && !nextAgreesWithPrevious) {
      c.relocation = true;
      lastGood = c;
    } else {
      c.flags.add('jump');
      c.usable = false;
    }
  }
  return out;
}

export function gapThresholdS(timing: SessionTiming, params: RuleParams): number {
  return Math.max(params.gap.minThresholdS, timing.maxIntervalMovingS * params.gap.movingIntervalFactor);
}

/** Bitmask compacta de flags para la respuesta de recorrido. */
export const FLAG_BITS: Record<string, number> = {
  low_accuracy: 1,
  jump: 2,
  future_ts: 4,
  mocked: 8,
  out_of_order: 16,
  no_accuracy: 32,
};
export function flagsToMask(flags: Iterable<string>): number {
  let m = 0;
  for (const f of flags) m |= FLAG_BITS[f] ?? 0;
  return m;
}
export function maskToFlags(mask: number): string[] {
  return Object.entries(FLAG_BITS)
    .filter(([, b]) => (mask & b) !== 0)
    .map(([f]) => f);
}
