import { bearingDeg, distanceToRingM, haversineM, headingDelta, pointInRing, type LonLat } from '../geo.js';
import type { EventConfidence } from '../contracts/common.js';
import { analyzeCorridor } from './corridor.js';
import { gapThresholdS } from './quality.js';
import { reconstructTrack } from './segments.js';
import type { ClassifiedPoint } from './quality.js';
import {
  DEFAULT_RULE_PARAMS,
  DEFAULT_SESSION_TIMING,
  RULES_VERSION,
  type DerivedEvent,
  type GeofenceDef,
  type ObservedPoint,
  type RuleParams,
  type SessionTiming,
  type TripDef,
} from './types.js';

export interface SessionInput {
  sessionId: string;
  points: readonly ObservedPoint[];
  /** true si la sesión fue finalizada por el dispositivo (los intervalos abiertos se cierran). */
  sessionEnded: boolean;
  timing?: SessionTiming;
  geofences?: readonly GeofenceDef[];
  trip?: TripDef | null;
  params?: RuleParams;
}

/**
 * Evalúa todas las reglas sobre una sesión completa. Es determinista: la misma entrada produce
 * los mismos eventos con las mismas dedupKey, lo que permite reprocesar ante puntos atrasados
 * y reemplazar (superseded) solo lo que cambió.
 */
export function evaluateSession(input: SessionInput): DerivedEvent[] {
  const params = input.params ?? DEFAULT_RULE_PARAMS;
  const timing = input.timing ?? DEFAULT_SESSION_TIMING;
  const sid = input.sessionId;
  const points = input.points.filter((p) => p.sessionId === sid);
  if (!points.length) return [];
  const rec = reconstructTrack(points, params, () => timing);
  const usable = rec.classified.filter((c) => c.usable);
  const gapS = gapThresholdS(timing, params);
  const events: DerivedEvent[] = [];
  const mk = (e: Omit<DerivedEvent, 'ruleVersion'>): DerivedEvent => ({ ...e, ruleVersion: RULES_VERSION, dedupKey: `${sid}:${e.dedupKey}` });

  // ── Outliers (saltos GPS) ──
  for (const o of rec.outliers) {
    events.push(
      mk({
        type: 'gps_outlier',
        occurredAt: o.p.t,
        endedAt: null,
        lat: o.p.lat,
        lon: o.p.lon,
        pointId: o.p.id,
        confidence: 'probable',
        ruleId: 'quality.jump',
        ruleParams: { ...params.quality },
        evidence: { pointId: o.p.id, accuracy: o.p.accuracy, flags: [...o.flags] },
        dedupKey: `gps_outlier:${o.p.id}`,
      }),
    );
  }

  // ── Huecos de captura ──
  for (const s of rec.segments) {
    if (s.kind !== 'gap' || s.reason === 'session_boundary') continue;
    const displaced = s.distanceM > params.gap.stationaryRadiusM;
    // Quieto sin actualizaciones: el SO puede no entregar fixes si no hay desplazamiento.
    if (!displaced && s.reason === 'no_data' && s.durationS <= timing.stationaryIntervalS * params.gap.stationaryIntervalFactor) continue;
    const confidence: EventConfidence = displaced || s.reason === 'implausible_jump' ? 'confirmed' : 'possible';
    events.push(
      mk({
        type: 'signal_gap',
        occurredAt: s.from.p.t,
        endedAt: s.to.p.t,
        lat: s.from.p.lat,
        lon: s.from.p.lon,
        pointId: s.from.p.id,
        confidence,
        ruleId: 'gap.v1',
        ruleParams: { thresholdS: gapS, ...params.gap },
        evidence: {
          fromPointId: s.from.p.id,
          toPointId: s.to.p.id,
          durationS: Math.round(s.durationS),
          displacementM: Math.round(s.distanceM),
          reason: s.reason,
          interpretation: displaced ? 'Se desplazó sin registrar posiciones' : 'Sin posiciones; posiblemente quieto',
        },
        dedupKey: `signal_gap:${s.from.p.t}`,
      }),
      mk({
        type: 'capture_resumed',
        occurredAt: s.to.p.t,
        endedAt: null,
        lat: s.to.p.lat,
        lon: s.to.p.lon,
        pointId: s.to.p.id,
        confidence: 'confirmed',
        ruleId: 'gap.v1',
        ruleParams: { thresholdS: gapS },
        evidence: { afterGapS: Math.round(s.durationS), fromPointId: s.from.p.id },
        dedupKey: `capture_resumed:${s.to.p.t}`,
      }),
    );
  }

  events.push(...detectStopsAndMovement(usable, input.sessionEnded, params, gapS, mk));
  events.push(...detectHeadingChanges(usable, params, mk));
  for (const g of input.geofences ?? []) events.push(...detectGeofence(usable, g, input.sessionEnded, params, gapS, mk));
  if (input.trip) events.push(...detectTrip(usable, input.trip, input.sessionEnded, params, gapS, mk));
  return events.sort((a, b) => a.occurredAt - b.occurredAt);
}

type Mk = (e: Omit<DerivedEvent, 'ruleVersion'>) => DerivedEvent;

function centroid(pts: readonly ClassifiedPoint[]): LonLat {
  const lat = pts.reduce((s, c) => s + c.p.lat, 0) / pts.length;
  const lon = pts.reduce((s, c) => s + c.p.lon, 0) / pts.length;
  return { lat, lon };
}

/** Detección de detenciones (stay points) y de inicio/reanudación de movimiento. */
function detectStopsAndMovement(usable: readonly ClassifiedPoint[], ended: boolean, params: RuleParams, gapS: number, mk: Mk): DerivedEvent[] {
  const sp = params.stop;
  const pts = usable.filter((c) => c.p.accuracy == null || c.p.accuracy <= sp.maxAccuracyM);
  const out: DerivedEvent[] = [];
  const stops: Array<{ i: number; j: number }> = [];
  let i = 0;
  while (i < pts.length) {
    let j = i + 1;
    while (j < pts.length && haversineM(pts[i]!.p, pts[j]!.p) <= sp.radiusM) j++;
    const durS = (pts[j - 1]!.p.t - pts[i]!.p.t) / 1000;
    if (j - 1 > i && durS >= sp.minDurationS) {
      stops.push({ i, j: j - 1 });
      i = j;
    } else i++;
  }

  for (const s of stops) {
    const cluster = pts.slice(s.i, s.j + 1);
    const start = cluster[0]!;
    const last = cluster[cluster.length - 1]!;
    const isLastData = s.j === pts.length - 1;
    const open = isLastData && !ended;
    let maxInternalGap = 0;
    for (let k = 1; k < cluster.length; k++) maxInternalGap = Math.max(maxInternalGap, (cluster[k]!.p.t - cluster[k - 1]!.p.t) / 1000);
    const c = centroid(cluster);
    out.push(
      mk({
        type: 'stop',
        occurredAt: start.p.t,
        endedAt: open ? null : last.p.t,
        lat: c.lat,
        lon: c.lon,
        pointId: start.p.id,
        confidence: maxInternalGap > gapS ? 'probable' : 'confirmed',
        ruleId: 'stop.v1',
        ruleParams: { ...sp },
        evidence: {
          firstPointId: start.p.id,
          lastPointId: last.p.id,
          pointCount: cluster.length,
          durationS: Math.round((last.p.t - start.p.t) / 1000),
          maxInternalGapS: Math.round(maxInternalGap),
          ongoing: open,
        },
        dedupKey: `stop:${start.p.t}`,
      }),
    );
  }

  // Movimiento: primer punto que se aleja más que el radio del ancla (inicio de sesión o fin de detención).
  const isStopIdx = new Set<number>();
  stops.forEach((s) => {
    for (let k = s.i; k <= s.j; k++) isStopIdx.add(k);
  });
  let anchorIdx = 0;
  let movingDetected = false;
  let k = 0;
  while (k < pts.length) {
    const stopHere = stops.find((s) => s.i === k);
    if (stopHere) {
      const next = pts[stopHere.j + 1];
      if (next) {
        const prevStop = pts[stopHere.j]!;
        out.push(
          mk({
            type: movingDetected ? 'movement_resumed' : 'movement_started',
            occurredAt: next.p.t,
            endedAt: null,
            lat: next.p.lat,
            lon: next.p.lon,
            pointId: next.p.id,
            confidence: 'confirmed',
            ruleId: 'movement.v1',
            ruleParams: { radiusM: sp.radiusM },
            evidence: { afterStopFromPointId: pts[stopHere.i]!.p.id, lastStopPointId: prevStop.p.id, displacementM: Math.round(haversineM(prevStop.p, next.p)) },
            dedupKey: `${movingDetected ? 'movement_resumed' : 'movement_started'}:${next.p.t}`,
          }),
        );
        movingDetected = true;
      }
      anchorIdx = stopHere.j + 1;
      k = stopHere.j + 1;
      continue;
    }
    if (!movingDetected && !isStopIdx.has(k) && haversineM(pts[anchorIdx]!.p, pts[k]!.p) > sp.radiusM) {
      const p = pts[k]!;
      out.push(
        mk({
          type: 'movement_started',
          occurredAt: p.p.t,
          endedAt: null,
          lat: p.p.lat,
          lon: p.p.lon,
          pointId: p.p.id,
          confidence: 'confirmed',
          ruleId: 'movement.v1',
          ruleParams: { radiusM: sp.radiusM },
          evidence: { anchorPointId: pts[anchorIdx]!.p.id, displacementM: Math.round(haversineM(pts[anchorIdx]!.p, p.p)) },
          dedupKey: `movement_started:${p.p.t}`,
        }),
      );
      movingDetected = true;
    }
    k++;
  }
  return out;
}

function detectHeadingChanges(usable: readonly ClassifiedPoint[], params: RuleParams, mk: Mk): DerivedEvent[] {
  const hp = params.heading;
  const out: DerivedEvent[] = [];
  let lastAt = -Infinity;
  for (let k = 1; k < usable.length - 1; k++) {
    const a = usable[k - 1]!.p;
    const b = usable[k]!.p;
    const c = usable[k + 1]!.p;
    const l1 = haversineM(a, b);
    const l2 = haversineM(b, c);
    if (l1 < hp.minLegM || l2 < hp.minLegM) continue;
    const v1 = l1 / Math.max(1, (b.t - a.t) / 1000);
    const v2 = l2 / Math.max(1, (c.t - b.t) / 1000);
    if (v1 < hp.minSpeedMps || v2 < hp.minSpeedMps) continue;
    const delta = headingDelta(bearingDeg(a, b), bearingDeg(b, c));
    if (delta < hp.minDeltaDeg || b.t - lastAt < hp.debounceS * 1000) continue;
    lastAt = b.t;
    out.push(
      mk({
        type: 'heading_change',
        occurredAt: b.t,
        endedAt: null,
        lat: b.lat,
        lon: b.lon,
        pointId: b.id,
        confidence: 'probable',
        ruleId: 'heading.v1',
        ruleParams: { ...hp },
        evidence: { deltaDeg: Math.round(delta), beforeDeg: Math.round(bearingDeg(a, b)), afterDeg: Math.round(bearingDeg(b, c)) },
        dedupKey: `heading_change:${b.t}`,
      }),
    );
  }
  return out;
}

/** Distancia con signo al borde: negativa dentro, positiva fuera (m). */
export function signedDistanceToGeofence(p: LonLat, g: GeofenceDef): number {
  if (g.shape === 'circle') return haversineM(p, g.center!) - g.radiusM!;
  const ring = g.ring!;
  const d = distanceToRingM(p, ring);
  return pointInRing(p, ring) ? -d : d;
}

type ZoneState = 'inside' | 'outside';

interface Transition {
  to: ZoneState;
  first: ClassifiedPoint;
  confirm: ClassifiedPoint;
  count: number;
  hadGap: boolean;
  minDistance: number;
}

/**
 * Máquina de estados con histéresis y permanencia:
 * - Un punto es "claramente dentro" si d ≤ −margen y "claramente fuera" si d ≥ +margen,
 *   con margen = histéresis + min(precisión, tope)/2. Los puntos en la banda se ignoran.
 * - El estado inicial se toma del primer punto claro, sin emitir evento.
 * - Un cambio se confirma con ≥ 2 puntos claros del nuevo lado durante ≥ dwell segundos, sin
 *   puntos claros del lado anterior en el medio. Un punto aislado nunca confirma.
 */
function zoneTransitions(
  usable: readonly ClassifiedPoint[],
  g: GeofenceDef,
  params: RuleParams,
  gapS: number,
): { transitions: Transition[]; pending: Transition | null; initial: ZoneState | null } {
  const gp = params.geofence;
  let state: ZoneState | null = null;
  let initial: ZoneState | null = null;
  let cand: Transition | null = null;
  const transitions: Transition[] = [];
  let prevT: number | null = null;
  for (const c of usable) {
    const acc = c.p.accuracy;
    if (acc != null && acc > gp.maxAccuracyM) continue;
    const d = signedDistanceToGeofence(c.p, g);
    const margin = g.hysteresisM + Math.min(acc ?? gp.accuracyMarginCapM, gp.accuracyMarginCapM) / 2;
    const clear: ZoneState | null = d <= -margin ? 'inside' : d >= margin ? 'outside' : null;
    const gapped = prevT != null && (c.p.t - prevT) / 1000 > gapS;
    prevT = c.p.t;
    if (!clear) continue;
    if (state === null) {
      state = clear;
      initial = clear;
      continue;
    }
    if (clear === state) {
      cand = null;
      continue;
    }
    if (!cand || cand.to !== clear) cand = { to: clear, first: c, confirm: c, count: 1, hadGap: false, minDistance: d };
    else {
      cand.confirm = c;
      cand.count++;
      cand.hadGap ||= gapped;
      cand.minDistance = clear === 'inside' ? Math.min(cand.minDistance, d) : Math.max(cand.minDistance, d);
    }
    const dwell = clear === 'inside' ? g.enterDwellS : g.exitDwellS;
    if (cand.count >= 2 && (cand.confirm.p.t - cand.first.p.t) / 1000 >= dwell) {
      transitions.push(cand);
      state = clear;
      cand = null;
    }
  }
  return { transitions, pending: cand, initial };
}

function detectGeofence(usable: readonly ClassifiedPoint[], g: GeofenceDef, _ended: boolean, params: RuleParams, gapS: number, mk: Mk): DerivedEvent[] {
  const { transitions } = zoneTransitions(usable, g, params, gapS);
  return transitions.map((tr) =>
    mk({
      type: tr.to === 'inside' ? 'geofence_enter' : 'geofence_exit',
      occurredAt: tr.first.p.t,
      endedAt: null,
      lat: tr.first.p.lat,
      lon: tr.first.p.lon,
      pointId: tr.first.p.id,
      confidence: tr.hadGap ? 'probable' : 'confirmed',
      ruleId: 'geofence.v1',
      ruleParams: { enterDwellS: g.enterDwellS, exitDwellS: g.exitDwellS, hysteresisM: g.hysteresisM, ...params.geofence },
      evidence: {
        firstPointId: tr.first.p.id,
        confirmPointId: tr.confirm.p.id,
        pointCount: tr.count,
        dwellS: Math.round((tr.confirm.p.t - tr.first.p.t) / 1000),
        boundaryDistanceM: Math.round(tr.minDistance),
        hadGap: tr.hadGap,
      },
      dedupKey: `geofence:${g.id}:${tr.to}:${tr.first.p.t}`,
      geofenceId: g.id,
    }),
  );
}

function detectTrip(usable: readonly ClassifiedPoint[], trip: TripDef, ended: boolean, params: RuleParams, gapS: number, mk: Mk): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  if (!usable.length) return out;
  const r = trip.arrivalRadiusM;
  const hyst = Math.min(25, r / 4);

  // Inicio del viaje: salida del radio de origen confirmada por dos puntos consecutivos fuera.
  const outsideOrigin = (c: ClassifiedPoint) => haversineM(c.p, trip.origin) > r + hyst;
  const firstUsable = usable[0]!;
  if (outsideOrigin(firstUsable) && haversineM(firstUsable.p, trip.origin) > 2 * r) {
    out.push(
      mk({
        type: 'trip_started',
        occurredAt: firstUsable.p.t,
        endedAt: null,
        lat: firstUsable.p.lat,
        lon: firstUsable.p.lon,
        pointId: firstUsable.p.id,
        confidence: 'possible',
        ruleId: 'trip.start.v1',
        ruleParams: { arrivalRadiusM: r },
        evidence: { reason: 'El primer punto ya estaba lejos del origen: no se observó la salida', distanceToOriginM: Math.round(haversineM(firstUsable.p, trip.origin)) },
        dedupKey: `trip_started:${trip.id}`,
        tripId: trip.id,
      }),
    );
  } else {
    for (let k = 0; k < usable.length - 1; k++) {
      if (outsideOrigin(usable[k]!) && outsideOrigin(usable[k + 1]!)) {
        const p = usable[k]!;
        out.push(
          mk({
            type: 'trip_started',
            occurredAt: p.p.t,
            endedAt: null,
            lat: p.p.lat,
            lon: p.p.lon,
            pointId: p.p.id,
            confidence: 'confirmed',
            ruleId: 'trip.start.v1',
            ruleParams: { arrivalRadiusM: r },
            evidence: { firstOutsidePointId: p.p.id, confirmPointId: usable[k + 1]!.p.id },
            dedupKey: `trip_started:${trip.id}`,
            tripId: trip.id,
          }),
        );
        break;
      }
    }
  }

  // Llegada: geocerca circular en el destino con permanencia.
  const dest: GeofenceDef = {
    id: `trip:${trip.id}:destination`,
    shape: 'circle',
    center: trip.destination,
    radiusM: r,
    enterDwellS: params.arrival.dwellS,
    exitDwellS: params.arrival.dwellS,
    hysteresisM: hyst,
  };
  const z = zoneTransitions(usable, dest, params, gapS);
  const arrival = z.transitions.find((t) => t.to === 'inside');
  const arrivalParams = { arrivalRadiusM: r, dwellS: params.arrival.dwellS, hysteresisM: hyst };
  if (arrival) {
    const confidence: EventConfidence = arrival.hadGap ? 'probable' : 'confirmed';
    const base = {
      occurredAt: arrival.first.p.t,
      endedAt: null,
      lat: arrival.first.p.lat,
      lon: arrival.first.p.lon,
      pointId: arrival.first.p.id,
      confidence,
      ruleParams: arrivalParams,
      evidence: { firstPointId: arrival.first.p.id, confirmPointId: arrival.confirm.p.id, pointCount: arrival.count, dwellS: Math.round((arrival.confirm.p.t - arrival.first.p.t) / 1000) },
      tripId: trip.id,
    };
    out.push(mk({ ...base, type: 'arrival', ruleId: 'trip.arrival.v1', dedupKey: `arrival:${trip.id}` }));
    out.push(mk({ ...base, type: 'trip_completed', ruleId: 'trip.arrival.v1', dedupKey: `trip_completed:${trip.id}` }));
  } else if (z.pending?.to === 'inside' && ended) {
    const p = z.pending.first;
    out.push(
      mk({
        type: 'arrival',
        occurredAt: p.p.t,
        endedAt: null,
        lat: p.p.lat,
        lon: p.p.lon,
        pointId: p.p.id,
        confidence: 'possible',
        ruleId: 'trip.arrival.v1',
        ruleParams: arrivalParams,
        evidence: { reason: 'Hay puntos dentro del destino pero no alcanzan la permanencia mínima', pointCount: z.pending.count },
        dedupKey: `arrival:${trip.id}`,
        tripId: trip.id,
      }),
    );
  }

  // Desvíos respecto de la ruta planificada.
  if (trip.route && trip.route.length >= 2) {
    const analysis = analyzeCorridor(usable, trip.route, params, gapS);
    for (const run of analysis.runs) {
      if (run.status !== 'confirmed' && run.status !== 'possible') continue;
      const off = run.points.filter((p) => p.cls === 'off');
      const first = off[0]!;
      out.push(
        mk({
          type: 'route_deviation',
          occurredAt: first.c.p.t,
          endedAt: run.openEnded && !ended ? null : off[off.length - 1]!.c.p.t,
          lat: first.c.p.lat,
          lon: first.c.p.lon,
          pointId: first.c.p.id,
          confidence: run.status,
          ruleId: 'corridor.v1',
          ruleParams: { ...params.corridor },
          evidence: {
            offPointCount: off.length,
            uncertainPointCount: run.points.length - off.length,
            maxOffsetM: Math.round(run.maxOffsetM),
            firstPointId: first.c.p.id,
            lastPointId: off[off.length - 1]!.c.p.id,
            durationS: Math.round((off[off.length - 1]!.c.p.t - first.c.p.t) / 1000),
          },
          dedupKey: `route_deviation:${trip.id}:${first.c.p.t}`,
          tripId: trip.id,
        }),
      );
    }
  }
  return out;
}

