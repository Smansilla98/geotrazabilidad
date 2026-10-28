import type { TripComparison } from '../contracts/api.js';
import type { EventConfidence } from '../contracts/common.js';
import type { LonLat } from '../geo.js';
import { analyzeCorridor, basicEta } from './corridor.js';
import { gapThresholdS } from './quality.js';
import { reconstructTrack } from './segments.js';
import { DEFAULT_RULE_PARAMS, DEFAULT_SESSION_TIMING, type ObservedPoint, type RuleParams, type SessionTiming } from './types.js';

export interface ComparisonInput {
  tripId: string;
  points: readonly ObservedPoint[];
  planned: { provider: string; distanceM: number; durationS: number | null; durationKind: string; computedAt: string; coordinates: LonLat[] } | null;
  arrival: { confidence: EventConfidence; at: number } | null;
  timing?: SessionTiming;
  params?: RuleParams;
}

const iso = (t: number) => new Date(t).toISOString();

/**
 * Compara lo planificado (estimado por un proveedor) con lo observado (posiciones reales).
 * La distancia observada solo suma tramos con datos: es un mínimo, nunca rellena huecos.
 */
export function compareTrip(input: ComparisonInput): TripComparison {
  const params = input.params ?? DEFAULT_RULE_PARAMS;
  const timing = input.timing ?? DEFAULT_SESSION_TIMING;
  const rec = reconstructTrack(input.points, params, () => timing);
  const usable = rec.classified.filter((c) => c.usable);
  const first = usable[0];
  const last = usable[usable.length - 1];
  const durationS = first && last ? (last.p.t - first.p.t) / 1000 : null;
  const gaps = rec.segments.filter((s) => s.kind === 'gap');
  const gapTime = gaps.reduce((s, g) => s + (g.kind === 'gap' ? g.durationS : 0), 0);
  const observedFraction = durationS && durationS > 0 ? Math.max(0, 1 - gapTime / durationS) : null;

  const result: TripComparison = {
    tripId: input.tripId,
    planned: input.planned
      ? {
          provider: input.planned.provider,
          distanceM: input.planned.distanceM,
          durationS: input.planned.durationS,
          durationKind: input.planned.durationKind,
          computedAt: input.planned.computedAt,
        }
      : null,
    observed: {
      distanceM: Math.round(rec.observedDistanceM),
      durationS: durationS == null ? null : Math.round(durationS),
      startedAt: first ? iso(first.p.t) : null,
      endedAt: last ? iso(last.p.t) : null,
      pointCount: usable.length,
      lastPointAt: last ? iso(last.p.t) : null,
    },
    diff: {
      distanceM: input.planned && usable.length ? Math.round(rec.observedDistanceM - input.planned.distanceM) : null,
      durationS: input.planned?.durationS != null && durationS != null ? Math.round(durationS - input.planned.durationS) : null,
    },
    arrival: input.arrival
      ? { reached: input.arrival.confidence === 'confirmed' || input.arrival.confidence === 'probable', confidence: input.arrival.confidence, at: iso(input.arrival.at) }
      : { reached: false, confidence: null, at: null },
    progress: { fraction: null, reliable: false, distanceRemainingM: null, etaS: null, etaKind: null },
    deviations: [],
    coverage: {
      observedFraction: observedFraction == null ? null : Math.round(observedFraction * 1000) / 1000,
      gaps: gaps.flatMap((g) => (g.kind === 'gap' ? [{ startAt: iso(g.from.p.t), endAt: iso(g.to.p.t) }] : [])),
    },
    method: 'corridor.v1',
    params: { ...params.corridor, gapThresholdS: gapThresholdS(timing, params) },
  };

  if (input.planned && input.planned.coordinates.length >= 2 && usable.length) {
    const a = analyzeCorridor(usable, input.planned.coordinates, params, gapThresholdS(timing, params));
    const fraction = a.routeLengthM ? Math.min(1, a.maxAlongM / a.routeLengthM) : null;
    const reliable = a.onCount >= 5 && (observedFraction ?? 0) >= params.progress.minCoverage;
    const arrived = result.arrival.reached;
    const remaining = arrived ? 0 : Math.max(0, a.routeLengthM - a.maxAlongM);
    result.progress = {
      fraction: arrived ? 1 : fraction == null ? null : Math.round(fraction * 1000) / 1000,
      reliable: arrived || reliable,
      distanceRemainingM: Math.round(remaining),
      etaS: arrived ? 0 : (() => {
        const eta = basicEta(a.points, remaining, params);
        return eta == null ? null : Math.round(eta);
      })(),
      etaKind: arrived ? null : 'basic_estimate',
    };
    if (result.progress.etaS == null && !arrived) result.progress.etaKind = null;
    result.deviations = a.runs.map((r) => ({
      status: r.status,
      startAt: iso(r.startAt),
      endAt: iso(r.endAt),
      maxOffsetM: Math.round(r.maxOffsetM),
      pointCount: r.points.length,
      startPointId: r.points[0]!.c.p.id,
      endPointId: r.points[r.points.length - 1]!.c.p.id,
    }));
  }
  return result;
}
