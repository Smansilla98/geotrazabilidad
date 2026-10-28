import { describe, expect, it } from 'vitest';
import { evaluateSession } from '../src/rules/engine.js';
import { reconstructTrack } from '../src/rules/segments.js';
import { compareTrip } from '../src/rules/comparison.js';
import { DEFAULT_RULE_PARAMS, type GeofenceDef, type ObservedPoint } from '../src/rules/types.js';
import { offset, ORIGIN, TrackBuilder } from './helpers.js';

const P = DEFAULT_RULE_PARAMS;
const types = (evs: { type: string }[]) => evs.map((e) => e.type);
const ofType = <T extends { type: string }>(evs: T[], t: string) => evs.filter((e) => e.type === t);

describe('calidad y reconstrucción', () => {
  it('marca un salto GPS aislado como outlier y no lo une a la línea', () => {
    const b = new TrackBuilder().add().move(5, 10, 10);
    const saved = b.pos;
    b.jumpTo(offset(saved, 5000, 0)).wait(10).add();
    b.jumpTo(saved).move(5, 10, 10);
    const r = reconstructTrack(b.points, P);
    expect(r.outliers).toHaveLength(1);
    expect(r.outliers[0]!.flags.has('jump')).toBe(true);
    expect(r.segments.filter((s) => s.kind === 'observed')).toHaveLength(1);
    // 500 m + 500 m reales; el salto de 5 km no se suma.
    expect(r.observedDistanceM).toBeGreaterThan(950);
    expect(r.observedDistanceM).toBeLessThan(1050);
  });

  it('acepta una reubicación confirmada por puntos posteriores pero corta la línea', () => {
    const b = new TrackBuilder().add().move(3, 10, 10);
    b.jumpTo(offset(b.pos, 20_000, 0)).wait(20).add().move(3, 10, 10);
    const r = reconstructTrack(b.points, P);
    expect(r.outliers).toHaveLength(0);
    const gaps = r.segments.filter((s) => s.kind === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind === 'gap' && gaps[0]!.reason).toBe('implausible_jump');
  });

  it('no conecta puntos separados por un hueco temporal', () => {
    const b = new TrackBuilder().add().move(5, 10, 10).wait(1800).move(5, 10, 10);
    const r = reconstructTrack(b.points, P);
    expect(r.segments.map((s) => s.kind)).toEqual(['observed', 'gap', 'observed']);
  });

  it('ordena por hora de captura aunque lleguen desordenados', () => {
    const b = new TrackBuilder().add().move(10, 10, 10);
    const shuffled = [...b.points].reverse();
    const r = reconstructTrack(shuffled, P);
    const seg = r.segments[0]!;
    expect(seg.kind).toBe('observed');
    if (seg.kind === 'observed') expect(seg.points.map((c) => c.p.seq)).toEqual(b.points.map((p) => p.seq));
  });

  it('corta en el cambio de sesión', () => {
    const b = new TrackBuilder().add().move(3, 10, 10).session('session-2').move(3, 10, 10);
    const r = reconstructTrack(b.points, P);
    expect(r.segments.map((s) => s.kind === 'gap' && s.reason)).toContain('session_boundary');
  });
});

describe('detenciones y movimiento', () => {
  it('detecta una detención de 10 minutos y la reanudación', () => {
    const b = new TrackBuilder().add().move(10, 10, 12).stay(20, 30).move(10, 10, 12);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true });
    const stops = ofType(evs, 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.confidence).toBe('confirmed');
    expect(stops[0]!.endedAt! - stops[0]!.occurredAt).toBeGreaterThanOrEqual(9 * 60_000);
    expect(types(evs)).toContain('movement_started');
    expect(types(evs)).toContain('movement_resumed');
  });

  it('no considera detención una pausa de 1 minuto', () => {
    const b = new TrackBuilder().add().move(10, 10, 12).stay(2, 30).move(10, 10, 12);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true });
    expect(ofType(evs, 'stop')).toHaveLength(0);
  });

  it('una detención en curso queda abierta si la sesión no terminó', () => {
    const b = new TrackBuilder().add().move(5, 10, 12).stay(10, 60);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: false });
    expect(ofType(evs, 'stop')[0]!.endedAt).toBeNull();
  });

  it('una detención con hueco interno baja a "probable"', () => {
    const b = new TrackBuilder().add().stay(3, 30).wait(3600).stay(3, 30).move(10, 10, 12);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true });
    expect(ofType(evs, 'stop')[0]!.confidence).toBe('probable');
  });
});

describe('huecos de señal', () => {
  it('genera signal_gap confirmado si se desplazó sin datos, y capture_resumed', () => {
    const b = new TrackBuilder().add().move(5, 10, 12).wait(600).jumpTo(offset(ORIGIN, 3000, 0)).add().move(5, 10, 12);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true });
    const gaps = ofType(evs, 'signal_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.confidence).toBe('confirmed');
    expect(ofType(evs, 'capture_resumed')).toHaveLength(1);
  });

  it('no genera hueco si estaba quieto dentro del intervalo de latido esperado', () => {
    const b = new TrackBuilder().add().stay(3, 30).wait(600).stay(3, 30);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true });
    expect(ofType(evs, 'signal_gap')).toHaveLength(0);
  });

  it('puntos atrasados que rellenan el hueco eliminan el evento al reprocesar', () => {
    const full = new TrackBuilder().add().move(60, 10, 12);
    // Hueco de 510 s (umbral del modo normal: 360 s) con desplazamiento de ~6 km.
    const withGap = full.points.filter((p) => p.seq < 5 || p.seq > 55);
    const before = evaluateSession({ sessionId: 'session-1', points: withGap, sessionEnded: false });
    expect(ofType(before, 'signal_gap')).toHaveLength(1);
    const after = evaluateSession({ sessionId: 'session-1', points: full.points, sessionEnded: false });
    expect(ofType(after, 'signal_gap')).toHaveLength(0);
  });
});

describe('geocercas', () => {
  const home: GeofenceDef = { id: 'home', shape: 'circle', center: offset(ORIGIN, 1000, 0), radiusM: 100, enterDwellS: 60, exitDwellS: 60, hysteresisM: 25 };

  it('entra y sale con permanencia, una sola vez cada una', () => {
    // Recorre 2 km hacia el este pasando por la casa, se queda 5 min y sigue.
    // 1 km hacia el este a 1 m/s (pasos de 10 m) hasta la casa, 5 min quieto y sigue 1 km.
    const b = new TrackBuilder().add().move(100, 10, 1);
    b.stay(10, 30, 3);
    b.move(100, 10, 1);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, geofences: [home] });
    expect(ofType(evs, 'geofence_enter')).toHaveLength(1);
    expect(ofType(evs, 'geofence_exit')).toHaveLength(1);
    expect(ofType(evs, 'geofence_enter')[0]!.confidence).toBe('confirmed');
  });

  it('un punto aislado dentro no confirma la entrada', () => {
    const b = new TrackBuilder(undefined, offset(ORIGIN, 1000, 300)).add().move(3, 30, 1);
    b.jumpTo(offset(ORIGIN, 1000, 0)).wait(30).add();
    b.jumpTo(offset(ORIGIN, 1000, 300)).wait(30).add().move(3, 30, 1);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, geofences: [home] });
    expect(ofType(evs, 'geofence_enter')).toHaveLength(0);
  });

  it('oscilar sobre el borde no genera eventos repetidos', () => {
    const b = new TrackBuilder(undefined, offset(ORIGIN, 1000, 300)).add().move(3, 30, 1);
    // Oscila a 95–105 m del centro (dentro de la banda de histéresis) durante 20 minutos.
    for (let i = 0; i < 40; i++) b.jumpTo(offset(ORIGIN, 1000, i % 2 ? 95 : 105)).wait(30).add();
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, geofences: [home] });
    expect(ofType(evs, 'geofence_enter')).toHaveLength(0);
    expect(ofType(evs, 'geofence_exit')).toHaveLength(0);
  });

  it('una sesión que empieza dentro no inventa una entrada', () => {
    const b = new TrackBuilder(undefined, offset(ORIGIN, 1000, 0)).add().stay(5, 30).move(40, 10, 10);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, geofences: [home] });
    expect(ofType(evs, 'geofence_enter')).toHaveLength(0);
    expect(ofType(evs, 'geofence_exit')).toHaveLength(1);
  });

  it('geocerca poligonal', () => {
    const c = offset(ORIGIN, 1000, 0);
    const ring = [offset(c, -100, -100), offset(c, 100, -100), offset(c, 100, 100), offset(c, -100, 100), offset(c, -100, -100)];
    const poly: GeofenceDef = { id: 'poly', shape: 'polygon', ring, enterDwellS: 60, exitDwellS: 60, hysteresisM: 20 };
    const b = new TrackBuilder().add().move(100, 10, 1).stay(10, 30, 3).move(100, 10, 1);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, geofences: [poly] });
    expect(types(evs).filter((t) => t.startsWith('geofence'))).toEqual(['geofence_enter', 'geofence_exit']);
  });

  it('los puntos muy imprecisos se ignoran', () => {
    const b = new TrackBuilder().add({ accuracy: 500 });
    for (let i = 0; i < 10; i++) b.jumpTo(offset(ORIGIN, 1000, 0)).wait(30).add({ accuracy: 400 });
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, geofences: [home] });
    expect(ofType(evs, 'geofence_enter')).toHaveLength(0);
  });
});

describe('viajes: llegada, desvío y comparación', () => {
  const dest = offset(ORIGIN, 3000, 0);
  const route = [ORIGIN, offset(ORIGIN, 1500, 0), dest];
  const trip = { id: 'trip-1', origin: ORIGIN, destination: dest, arrivalRadiusM: 100, route };

  function straightTrip() {
    return new TrackBuilder().add().stay(2, 20).move(30, 10, 10).stay(6, 20, 2);
  }

  it('viaje sin desvío: inicio, llegada y finalización confirmados', () => {
    const b = straightTrip();
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, trip });
    expect(ofType(evs, 'trip_started')[0]!.confidence).toBe('confirmed');
    expect(ofType(evs, 'arrival')[0]!.confidence).toBe('confirmed');
    expect(ofType(evs, 'trip_completed')).toHaveLength(1);
    expect(ofType(evs, 'route_deviation')).toHaveLength(0);
  });

  it('desvío sostenido se confirma; un punto aislado fuera es solo "posible"', () => {
    const b = new TrackBuilder().add().move(10, 10, 10); // 1 km por la ruta
    b.move(4, 10, 10, 0); // 400 m al norte
    b.move(10, 15, 10, 90); // 150 s fuera de la ruta
    b.move(4, 10, 10, 180); // vuelve
    b.move(5, 10, 10, 90);
    const p = b.pos;
    b.jumpTo(offset(p, 0, 150)).wait(10).add(); // un único punto 150 m fuera
    b.jumpTo(p).move(12, 10, 10);
    // Ruta más larga para que el final del escenario siga sobre la ruta.
    const longTrip = { ...trip, destination: offset(ORIGIN, 8000, 0), route: [ORIGIN, offset(ORIGIN, 8000, 0)] };
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, trip: longTrip });
    const devs = ofType(evs, 'route_deviation');
    expect(devs.map((d) => d.confidence)).toEqual(['confirmed', 'possible']);
    expect((devs[0]!.evidence as { maxOffsetM: number }).maxOffsetM).toBeGreaterThan(300);
  });

  it('puntos imprecisos fuera del corredor no generan desvío', () => {
    const b = new TrackBuilder().add().move(10, 10, 10);
    const p = b.pos;
    for (let i = 0; i < 6; i++) b.jumpTo(offset(p, i * 10, 120)).wait(20).add({ accuracy: 150 });
    b.jumpTo(p).move(10, 10, 10);
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, trip });
    expect(ofType(evs, 'route_deviation')).toHaveLength(0);
    const cmp = compareTrip({
      tripId: 'trip-1',
      points: b.points,
      planned: { provider: 'test', distanceM: 3000, durationS: 300, durationKind: 'provider_no_traffic', computedAt: new Date().toISOString(), coordinates: route },
      arrival: null,
    });
    expect(cmp.deviations.map((d) => d.status)).toEqual(['imprecise']);
  });

  it('llegada sin permanencia suficiente en sesión finalizada es "posible"', () => {
    const b = new TrackBuilder().add().move(30, 10, 10).wait(5).add();
    const evs = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, trip });
    const arr = ofType(evs, 'arrival');
    expect(arr).toHaveLength(1);
    expect(arr[0]!.confidence).toBe('possible');
    expect(ofType(evs, 'trip_completed')).toHaveLength(0);
  });

  it('la comparación separa distancia y duración planificadas de las observadas', () => {
    const b = straightTrip();
    const cmp = compareTrip({
      tripId: 'trip-1',
      points: b.points,
      planned: { provider: 'test', distanceM: 3000, durationS: 240, durationKind: 'provider_no_traffic', computedAt: new Date().toISOString(), coordinates: route },
      arrival: { confidence: 'confirmed', at: b.points.at(-1)!.t },
    });
    expect(cmp.observed.distanceM).toBeGreaterThan(2800);
    expect(cmp.observed.distanceM).toBeLessThan(3200);
    expect(cmp.diff.durationS).toBe(cmp.observed.durationS! - 240);
    expect(cmp.progress.fraction).toBe(1);
    expect(cmp.arrival.reached).toBe(true);
    expect(cmp.deviations).toHaveLength(0);
  });

  it('avance parcial y ETA básica en un viaje en curso', () => {
    const b = new TrackBuilder().add().move(40, 10, 4); // 1,6 km a 4 m/s durante 400 s
    const cmp = compareTrip({
      tripId: 'trip-1',
      points: b.points,
      planned: { provider: 'test', distanceM: 3000, durationS: 240, durationKind: 'provider_no_traffic', computedAt: new Date().toISOString(), coordinates: route },
      arrival: null,
    });
    expect(cmp.progress.fraction).toBeGreaterThan(0.5);
    expect(cmp.progress.fraction).toBeLessThan(0.56);
    expect(cmp.progress.reliable).toBe(true);
    expect(cmp.progress.etaKind).toBe('basic_estimate');
    expect(cmp.progress.etaS).toBeGreaterThan(330);
    expect(cmp.progress.etaS).toBeLessThan(370);
  });
});

describe('determinismo', () => {
  it('reevaluar la misma sesión produce las mismas claves', () => {
    const b = new TrackBuilder().add().move(10, 10, 12).stay(20, 30).move(10, 10, 12);
    const a = evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true }).map((e) => e.dedupKey);
    const shuffled: ObservedPoint[] = [...b.points].sort(() => 0.5 - Math.random());
    const c = evaluateSession({ sessionId: 'session-1', points: shuffled, sessionEnded: true }).map((e) => e.dedupKey);
    expect(c).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });
});
