import { bearingDeg, haversineM, PolylineIndex, type LonLat, type TrackingMode } from '@geo/shared';

/**
 * Escenarios SINTÉTICOS de demostración (Buenos Aires). No provienen de ningún dispositivo:
 * se generan de forma determinista y se guardan con is_demo = true y source = 'demo'.
 */

export interface DemoPoint {
  t: number;
  lat: number;
  lon: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
}

export interface DemoScenario {
  key: string;
  title: string;
  device: 0 | 1 | 2 | 3;
  mode: TrackingMode;
  points: DemoPoint[];
  startedAt: number;
  endedAt: number;
  endReason: string;
  trip?: { name: string; origin: LonLat; destination: LonLat; arrivalRadiusM: number; plannedRoute: LonLat[]; plannedSpeedMps: number };
}

export const DEMO_DEVICES = ['Camioneta reparto (DEMO)', 'Moto mensajería (DEMO)', 'Celular personal (DEMO)', 'Camión larga distancia (DEMO)'];

export const DEMO_GEOFENCES = [
  {
    name: 'Oficina Microcentro (DEMO)',
    kind: 'office' as const,
    shape: 'polygon' as const,
    ring: [
      [-58.3850, -34.6015],
      [-58.3785, -34.6015],
      [-58.3785, -34.6060],
      [-58.3850, -34.6060],
      [-58.3850, -34.6015],
    ] as [number, number][],
  },
  { name: 'Depósito Barracas (DEMO)', kind: 'depot' as const, shape: 'circle' as const, center: { lon: -58.3720, lat: -34.6455 }, radiusM: 150 },
];

const P = (lat: number, lon: number): LonLat => ({ lat, lon });
const ROUTES = {
  palermoCentro: [P(-34.581, -58.421), P(-34.5885, -58.4105), P(-34.5945, -58.4005), P(-34.596, -58.3925), P(-34.5995, -58.3865), P(-34.6037, -58.3816)],
  caLaPlata: [P(-34.6037, -58.3816), P(-34.628, -58.372), P(-34.66, -58.335), P(-34.705, -58.275), P(-34.765, -58.205), P(-34.83, -58.11), P(-34.885, -58.02), P(-34.9214, -57.9545)],
  belgranoNunez: [P(-34.5627, -58.4566), P(-34.5555, -58.4625), P(-34.548, -58.4685), P(-34.5415, -58.4735)],
  constitucionRetiro: [P(-34.6277, -58.3815), P(-34.6125, -58.3815), P(-34.6037, -58.3816), P(-34.595, -58.3812), P(-34.5915, -58.3745)],
  // Desvío: deja la 9 de Julio, toma una paralela ~600 m al este y vuelve.
  constitucionRetiroDesvio: [P(-34.6277, -58.3815), P(-34.6165, -58.3815), P(-34.6165, -58.3750), P(-34.6020, -58.3750), P(-34.6000, -58.3814), P(-34.595, -58.3812), P(-34.5915, -58.3745)],
  caballitoFlores: [P(-34.6186, -58.4416), P(-34.6235, -58.4545), P(-34.6285, -58.4635), P(-34.6305, -58.4705)],
  almagroBarracas: [P(-34.6095, -58.4195), P(-34.6215, -58.4030), P(-34.6335, -58.3890), P(-34.6455, -58.3720)],
  recoletaVillaCrespo: [P(-34.5875, -58.3975), P(-34.5925, -58.4135), P(-34.5965, -58.4285), P(-34.5995, -58.4405), P(-34.6015, -58.4495)],
};

/** PRNG determinista (mulberry32): los mismos escenarios en cada carga. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(p: LonLat, meters: number, r: () => number): LonLat {
  const dx = (r() - 0.5) * 2 * meters;
  const dy = (r() - 0.5) * 2 * meters;
  return { lat: p.lat + dy / 111_195, lon: p.lon + dx / (111_195 * Math.cos((p.lat * Math.PI) / 180)) };
}

function pointAt(line: LonLat[], idx: PolylineIndex, along: number): LonLat {
  const d = Math.max(0, Math.min(idx.totalM, along));
  let i = 0;
  while (i < line.length - 2 && idx.cumulative[i + 1]! < d) i++;
  const a = line[i]!;
  const b = line[i + 1]!;
  const segLen = idx.cumulative[i + 1]! - idx.cumulative[i]!;
  const f = segLen ? (d - idx.cumulative[i]!) / segLen : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

interface DriveOpts {
  start: number;
  speed: number;
  dtS: number;
  seed: number;
  noiseM?: number;
  accuracy?: [number, number];
  /** Pausas: [fracción del recorrido, segundos detenido]. */
  stops?: Array<[number, number]>;
  /** Hueco sin datos: [fracción, segundos] (el vehículo sigue moviéndose). */
  gap?: [number, number];
  /** Detener la generación en esta fracción (recorrido incompleto). */
  until?: number;
  /** Permanencia final en destino (s). */
  dwellEndS?: number;
}

function drive(line: LonLat[], o: DriveOpts): DemoPoint[] {
  const idx = new PolylineIndex(line);
  const r = rng(o.seed);
  const out: DemoPoint[] = [];
  const [accMin, accMax] = o.accuracy ?? [5, 15];
  const stops = [...(o.stops ?? [])].sort((a, b) => a[0] - b[0]);
  const end = idx.totalM * (o.until ?? 1);
  let t = o.start;
  let along = 0;
  let gapDone = false;
  const emit = (pos: LonLat, speed: number | null, heading: number | null) =>
    out.push({ t, ...jitter(pos, o.noiseM ?? 4, r), accuracy: Math.round(accMin + r() * (accMax - accMin)), speed, heading });

  emit(line[0]!, 0, null);
  while (along < end) {
    const stop = stops[0];
    if (stop && along >= stop[0] * idx.totalM) {
      stops.shift();
      const pos = pointAt(line, idx, along);
      for (let s = 0; s < stop[1]; s += Math.max(o.dtS, 30)) {
        t += Math.max(o.dtS, 30) * 1000;
        emit(pos, 0, null);
      }
      continue;
    }
    const v = o.speed * (0.8 + r() * 0.4);
    along = Math.min(end, along + v * o.dtS);
    t += o.dtS * 1000;
    if (o.gap && !gapDone && along >= o.gap[0] * idx.totalM) {
      gapDone = true;
      t += o.gap[1] * 1000;
      along = Math.min(end, along + o.speed * o.gap[1]);
    }
    const pos = pointAt(line, idx, along);
    const next = pointAt(line, idx, Math.min(idx.totalM, along + 10));
    emit(pos, Math.round(v * 10) / 10, along < idx.totalM ? Math.round(bearingDeg(pos, next)) : null);
  }
  if (o.dwellEndS) {
    const pos = pointAt(line, idx, end);
    for (let s = 0; s < o.dwellEndS; s += 30) {
      t += 30_000;
      emit(pos, 0, null);
    }
  }
  return out;
}

/** Genera los 8 escenarios anclados a `base` (normalmente ayer). */
export function buildScenarios(base: number): DemoScenario[] {
  const H = 3_600_000;
  const sc: DemoScenario[] = [];
  const add = (s: Omit<DemoScenario, 'startedAt' | 'endedAt'> & { endedAt?: number }) => {
    const first = s.points[0]!.t;
    const last = s.points[s.points.length - 1]!.t;
    sc.push({ ...s, startedAt: first - 5_000, endedAt: s.endedAt ?? last + 5_000 });
  };

  add({
    key: 'urbano',
    title: 'Trayecto urbano Palermo → Microcentro',
    device: 2,
    mode: 'normal',
    endReason: 'user',
    points: drive(ROUTES.palermoCentro, { start: base + 0 * H, speed: 7, dtS: 15, seed: 1, stops: [[0.45, 90]], dwellEndS: 300 }),
  });

  const laPlata = drive(ROUTES.caLaPlata, { start: base + 1 * H, speed: 24, dtS: 30, seed: 2, dwellEndS: 360 });
  add({
    key: 'larga_distancia',
    title: 'Viaje de larga distancia CABA → La Plata',
    device: 3,
    mode: 'trip',
    endReason: 'trip_completed',
    points: laPlata,
    trip: { name: 'Entrega en La Plata (DEMO)', origin: ROUTES.caLaPlata[0]!, destination: ROUTES.caLaPlata.at(-1)!, arrivalRadiusM: 200, plannedRoute: ROUTES.caLaPlata, plannedSpeedMps: 22 },
  });

  add({
    key: 'detencion',
    title: 'Detención prolongada (40 min) Belgrano → Núñez',
    device: 0,
    mode: 'normal',
    endReason: 'user',
    points: drive(ROUTES.belgranoNunez, { start: base + 4 * H, speed: 6, dtS: 20, seed: 3, stops: [[0.5, 2400]] }),
  });

  add({
    key: 'desvio',
    title: 'Desvío de la ruta planificada Constitución → Retiro',
    device: 0,
    mode: 'trip',
    endReason: 'trip_completed',
    points: drive(ROUTES.constitucionRetiroDesvio, { start: base + 6 * H, speed: 8, dtS: 10, seed: 4, dwellEndS: 180 }),
    trip: {
      name: 'Retiro con desvío (DEMO)',
      origin: ROUTES.constitucionRetiro[0]!,
      destination: ROUTES.constitucionRetiro.at(-1)!,
      arrivalRadiusM: 120,
      plannedRoute: ROUTES.constitucionRetiro,
      plannedSpeedMps: 9,
    },
  });

  add({
    key: 'perdida_conexion',
    title: 'Pérdida de señal de 15 min Caballito → Flores',
    device: 1,
    mode: 'trip',
    endReason: 'user',
    points: drive(ROUTES.caballitoFlores, { start: base + 2 * H, speed: 3, dtS: 15, seed: 5, gap: [0.35, 900] }),
  });

  const imprecise = drive(ROUTES.recoletaVillaCrespo, { start: base + 8 * H, speed: 5, dtS: 20, seed: 6, noiseM: 45, accuracy: [60, 320] });
  const j = Math.floor(imprecise.length / 2);
  imprecise[j] = { ...imprecise[j]!, lat: imprecise[j]!.lat + 0.04, lon: imprecise[j]!.lon - 0.02, accuracy: 30 };
  add({ key: 'imprecisas', title: 'Posiciones imprecisas y un salto GPS', device: 2, mode: 'battery_saver', endReason: 'user', points: imprecise });

  add({
    key: 'llegada',
    title: 'Llegada a destino: Almagro → Depósito Barracas',
    device: 1,
    mode: 'trip',
    endReason: 'trip_completed',
    points: drive(ROUTES.almagroBarracas, { start: base + 5 * H, speed: 9, dtS: 10, seed: 7, dwellEndS: 600 }),
    trip: {
      name: 'Retiro de mercadería en depósito (DEMO)',
      origin: ROUTES.almagroBarracas[0]!,
      destination: ROUTES.almagroBarracas.at(-1)!,
      arrivalRadiusM: 120,
      plannedRoute: ROUTES.almagroBarracas,
      plannedSpeedMps: 10,
    },
  });

  add({
    key: 'incompleto',
    title: 'Recorrido incompleto (finalizado antes de llegar)',
    device: 3,
    mode: 'trip',
    endReason: 'user',
    points: drive(ROUTES.caLaPlata, { start: base + 10 * H, speed: 22, dtS: 30, seed: 8, until: 0.55 }),
    trip: { name: 'Segunda entrega La Plata (DEMO)', origin: ROUTES.caLaPlata[0]!, destination: ROUTES.caLaPlata.at(-1)!, arrivalRadiusM: 200, plannedRoute: ROUTES.caLaPlata, plannedSpeedMps: 22 },
  });

  return sc;
}

export const routeLengthM = (line: LonLat[]) => line.slice(1).reduce((s, p, i) => s + haversineM(line[i]!, p), 0);
