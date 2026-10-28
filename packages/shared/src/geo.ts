/**
 * Utilidades geográficas puras (WGS84, coordenadas en grados).
 * Distancias geodésicas con Haversine sobre la esfera media (R = 6 371 008,8 m).
 * Para proyecciones locales (distancia a segmentos, polígonos pequeños) se usa una
 * proyección equirectangular centrada en el área, con error < 0,5 % en distancias < 50 km.
 */

export const EARTH_RADIUS_M = 6_371_008.8;

export interface LonLat {
  lon: number;
  lat: number;
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function isValidLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function haversineM(a: LonLat, b: LonLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumbo inicial de a hacia b, en grados [0, 360). */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Diferencia angular mínima entre dos rumbos, en grados [0, 180]. */
export function headingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function pathLengthM(points: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1]!, points[i]!);
  return total;
}

/** Proyección local a metros alrededor de un origen. */
export function makeLocalProjection(origin: LonLat) {
  const kx = EARTH_RADIUS_M * Math.cos(toRad(origin.lat)) * (Math.PI / 180);
  const ky = EARTH_RADIUS_M * (Math.PI / 180);
  return {
    toXY: (p: LonLat): [number, number] => {
      let dLon = p.lon - origin.lon;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      return [dLon * kx, (p.lat - origin.lat) * ky];
    },
    toLonLat: ([x, y]: [number, number]): LonLat => ({ lon: origin.lon + x / kx, lat: origin.lat + y / ky }),
  };
}

export interface PolylineProjection {
  /** Distancia del punto a la polilínea (m). */
  distanceM: number;
  /** Distancia a lo largo de la polilínea hasta el punto proyectado (m). */
  alongM: number;
  /** alongM / longitud total, en [0, 1]. */
  fraction: number;
  segmentIndex: number;
  projected: LonLat;
}

/**
 * Proyecta un punto sobre una polilínea. Para cada segmento usa una proyección local
 * centrada en el inicio del segmento, por lo que funciona también con rutas largas.
 */
export class PolylineIndex {
  readonly cumulative: number[];
  readonly totalM: number;

  constructor(readonly line: readonly LonLat[]) {
    if (line.length < 2) throw new Error('La polilínea necesita al menos 2 vértices');
    this.cumulative = [0];
    for (let i = 1; i < line.length; i++) this.cumulative.push(this.cumulative[i - 1]! + haversineM(line[i - 1]!, line[i]!));
    this.totalM = this.cumulative[this.cumulative.length - 1]!;
  }

  project(p: LonLat, hint?: { fromM?: number }): PolylineProjection {
    let best: PolylineProjection | null = null;
    const fromM = hint?.fromM ?? 0;
    for (let i = 0; i < this.line.length - 1; i++) {
      if (this.cumulative[i + 1]! < fromM) continue;
      const a = this.line[i]!;
      const b = this.line[i + 1]!;
      const proj = makeLocalProjection(a);
      const [bx, by] = proj.toXY(b);
      const [px, py] = proj.toXY(p);
      const len2 = bx * bx + by * by;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
      const q = proj.toLonLat([bx * t, by * t]);
      const d = haversineM(p, q);
      if (!best || d < best.distanceM) {
        const along = this.cumulative[i]! + haversineM(a, q);
        best = { distanceM: d, alongM: along, fraction: this.totalM ? along / this.totalM : 0, segmentIndex: i, projected: q };
      }
    }
    return best!;
  }
}

/** Punto en polígono (anillo exterior) por ray casting en coordenadas lon/lat. */
export function pointInRing(p: LonLat, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

/** Distancia del punto al borde de un anillo (m), usando proyección local. */
export function distanceToRingM(p: LonLat, ring: readonly LonLat[]): number {
  const proj = makeLocalProjection(p);
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = proj.toXY(ring[i]!);
    const [bx, by] = proj.toXY(ring[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/**
 * Simplificación Douglas-Peucker en metros. Devuelve los índices conservados.
 * `keep` permite forzar índices (p. ej. puntos asociados a eventos).
 */
export function simplifyIndices(points: readonly LonLat[], toleranceM: number, keep?: ReadonlySet<number>): number[] {
  const n = points.length;
  if (n <= 2 || toleranceM <= 0) return points.map((_, i) => i);
  const proj = makeLocalProjection(points[0]!);
  const xy = points.map((p) => proj.toXY(p));
  const marked = new Uint8Array(n);
  marked[0] = 1;
  marked[n - 1] = 1;
  keep?.forEach((i) => {
    if (i >= 0 && i < n) marked[i] = 1;
  });
  // Rangos entre índices forzados, procesados iterativamente
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (marked[i]) anchors.push(i);
  const stack: Array<[number, number]> = [];
  for (let k = 1; k < anchors.length; k++) stack.push([anchors[k - 1]!, anchors[k]!]);
  while (stack.length) {
    const [s, e] = stack.pop()!;
    if (e - s < 2) continue;
    const [ax, ay] = xy[s]!;
    const [bx, by] = xy[e]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy[i]!;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > toleranceM) {
      marked[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (marked[i]) out.push(i);
  return out;
}
