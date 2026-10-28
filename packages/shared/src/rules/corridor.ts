import { PolylineIndex, type LonLat } from '../geo.js';
import type { DeviationStatus } from '../contracts/api.js';
import type { ClassifiedPoint } from './quality.js';
import type { RuleParams } from './types.js';

export type CorridorClass = 'on' | 'off' | 'uncertain';

export interface CorridorPoint {
  c: ClassifiedPoint;
  offsetM: number;
  alongM: number;
  cls: CorridorClass;
}

export interface DeviationRun {
  status: DeviationStatus;
  points: CorridorPoint[];
  startAt: number;
  endAt: number;
  maxOffsetM: number;
  /** El tramo llega hasta el último punto disponible (puede seguir en curso). */
  openEnded: boolean;
}

export interface CorridorAnalysis {
  points: CorridorPoint[];
  runs: DeviationRun[];
  maxAlongM: number;
  routeLengthM: number;
  onCount: number;
}

/**
 * Método corridor.v1: compara cada posición observada con la polilínea planificada.
 * - offset: distancia geodésica a la ruta (proyección sobre el segmento más cercano).
 * - 'off' si offset > max(corredor, 2·precisión); 'uncertain' si la precisión no permite decidir.
 * - Un desvío se confirma solo con ≥ minPoints puntos 'off' que abarquen ≥ minDurationS sin huecos.
 * - El avance es el máximo monótono de la posición a lo largo de la ruta, solo con puntos 'on',
 *   buscando desde (avance - backtrackM) para no saltar a tramos lejanos donde la ruta se cruza.
 */
export function analyzeCorridor(
  usable: readonly ClassifiedPoint[],
  route: readonly LonLat[],
  params: RuleParams,
  gapThresholdS: number,
): CorridorAnalysis {
  const cp = params.corridor;
  const index = new PolylineIndex(route);
  let maxAlong = 0;
  let onCount = 0;
  const points: CorridorPoint[] = usable.map((c) => {
    const global = index.project(c.p);
    const acc = c.p.accuracy;
    let cls: CorridorClass;
    if (global.distanceM <= cp.corridorM) cls = 'on';
    else if (acc == null || acc > cp.maxAccuracyM) cls = 'uncertain';
    else cls = global.distanceM > Math.max(cp.corridorM, 2 * acc) ? 'off' : 'on';
    let along = global.alongM;
    if (cls === 'on') {
      const local = index.project(c.p, { fromM: Math.max(0, maxAlong - cp.backtrackM) });
      along = local.distanceM <= cp.corridorM * 1.5 ? local.alongM : global.alongM;
      if (along > maxAlong) maxAlong = along;
      onCount++;
    }
    return { c, offsetM: global.distanceM, alongM: along, cls };
  });

  const runs: DeviationRun[] = [];
  let run: CorridorPoint[] = [];
  const closeRun = (openEnded: boolean) => {
    if (!run.length) return;
    const off = run.filter((r) => r.cls === 'off');
    const startAt = run[0]!.c.p.t;
    const endAt = run[run.length - 1]!.c.p.t;
    let status: DeviationStatus;
    if (!off.length) status = 'imprecise';
    else {
      const offSpanS = (off[off.length - 1]!.c.p.t - off[0]!.c.p.t) / 1000;
      status = off.length >= cp.minPoints && offSpanS >= cp.minDurationS ? 'confirmed' : 'possible';
    }
    runs.push({ status, points: run, startAt, endAt, maxOffsetM: Math.max(...run.map((r) => r.offsetM)), openEnded });
    run = [];
  };

  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!;
    const prev = points[i - 1];
    const gap = prev && (cur.c.p.t - prev.c.p.t) / 1000 > gapThresholdS;
    if (gap) {
      // Si alguno de los extremos del hueco está fuera de la ruta, no sabemos qué pasó en el medio.
      if (prev.cls !== 'on' || cur.cls !== 'on') {
        closeRun(false);
        runs.push({
          status: 'insufficient_data',
          points: [prev, cur],
          startAt: prev.c.p.t,
          endAt: cur.c.p.t,
          maxOffsetM: Math.max(prev.offsetM, cur.offsetM),
          openEnded: false,
        });
      } else closeRun(false);
    }
    if (cur.cls === 'on') closeRun(false);
    else run.push(cur);
  }
  closeRun(true);
  return { points, runs, maxAlongM: maxAlong, routeLengthM: index.totalM, onCount };
}

/** ETA básica: distancia restante / velocidad media observada reciente. Sin tráfico. */
export function basicEta(
  points: readonly CorridorPoint[],
  remainingM: number,
  params: RuleParams,
): number | null {
  const on = points.filter((p) => p.cls === 'on');
  if (on.length < 3) return null;
  const last = on[on.length - 1]!;
  const windowStart = last.c.p.t - params.progress.etaWindowS * 1000;
  const recent = on.filter((p) => p.c.p.t >= windowStart);
  const first = recent[0]!;
  const dt = (last.c.p.t - first.c.p.t) / 1000;
  if (dt < params.progress.etaMinMovingS) return null;
  const advanced = last.alongM - first.alongM;
  if (advanced <= 50) return null;
  return remainingM / (advanced / dt);
}

export function offsetSummary(points: readonly CorridorPoint[]) {
  return points.length ? Math.max(...points.map((p) => p.offsetM)) : 0;
}

