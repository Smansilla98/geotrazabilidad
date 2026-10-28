import type { GeofenceDto, TrackResponse, TrackingEventDto } from '@geo/shared';
import { maskToFlags } from '@geo/shared';
import { accuracyClass } from './format';

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const fc = (features: Feature[]): GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>> => ({ type: 'FeatureCollection', features });

/** Aproxima un círculo geodésico con un polígono (solo para dibujar). */
export function circlePolygon(center: { lon: number; lat: number }, radiusM: number, steps = 64): [number, number][] {
  const out: [number, number][] = [];
  const latR = radiusM / 111_195;
  const lonR = radiusM / (111_195 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([center.lon + lonR * Math.cos(a), center.lat + latR * Math.sin(a)]);
  }
  return out;
}

export interface FlatPoint {
  lon: number;
  lat: number;
  t: number;
  id: number;
  accuracy: number | null;
  speed: number | null;
  flags: string[];
  segment: number;
}

/** Puntos observados en orden temporal, con el índice de su segmento continuo. */
export function flattenTrack(track: TrackResponse | undefined): FlatPoint[] {
  if (!track) return [];
  const out: FlatPoint[] = [];
  track.segments.forEach((s, i) => {
    if (s.kind !== 'observed') return;
    for (const [lon, lat, t, id, accuracy, speed, mask] of s.points) out.push({ lon, lat, t, id, accuracy, speed, flags: maskToFlags(mask), segment: i });
  });
  return out;
}

export function trackLayers(track: TrackResponse | undefined) {
  if (!track) return { lines: fc([]), points: fc([]), gaps: fc([]), outliers: fc([]), ends: fc([]) };
  const lines: Feature[] = [];
  const points: Feature[] = [];
  const gaps: Feature[] = [];
  track.segments.forEach((s, i) => {
    if (s.kind === 'observed') {
      if (s.points.length >= 2) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: s.points.map((p) => [p[0], p[1]]) }, properties: { segment: i } });
      for (const [lon, lat, t, id, acc, speed, mask] of s.points) {
        points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id, t, acc, speed, q: accuracyClass(acc), flags: maskToFlags(mask).join(',') } });
      }
    } else {
      // Discontinuidad: se marcan los extremos; NO se dibuja una línea como si el tramo estuviera confirmado.
      for (const [end, p] of [['from', s.from], ['to', s.to]] as const) {
        gaps.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { end, reason: s.reason, durationS: s.durationS, distanceM: s.distanceM, startAt: s.startAt, endAt: s.endAt } });
      }
    }
  });
  const outliers = track.outliers.map<Feature>((o) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lon, o.lat] }, properties: { id: o.pointId, at: o.at } }));
  const flat = flattenTrack(track);
  const ends: Feature[] = [];
  if (flat.length) {
    ends.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [flat[0]!.lon, flat[0]!.lat] }, properties: { kind: 'start', label: 'Inicio' } });
    ends.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [flat.at(-1)!.lon, flat.at(-1)!.lat] }, properties: { kind: 'end', label: 'Fin' } });
  }
  return { lines: fc(lines), points: fc(points), gaps: fc(gaps), outliers: fc(outliers), ends: fc(ends) };
}

export function eventsLayer(events: TrackingEventDto[]) {
  return fc(
    events
      .filter((e) => e.lat != null && e.lon != null)
      .map((e) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon!, e.lat!] }, properties: { id: e.id, type: e.type, confidence: e.confidence } })),
  );
}

export function geofencesLayer(geofences: GeofenceDto[]) {
  return fc(
    geofences.map((g) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: g.shape === 'circle' && g.center && g.radiusM ? [circlePolygon(g.center, g.radiusM)] : (g.polygon ?? []) },
      properties: { id: g.id, name: g.name, kind: g.kind, active: g.active },
    })),
  );
}

export function lineLayer(coords: [number, number][] | undefined) {
  return fc(coords && coords.length >= 2 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] : []);
}

export function bboxOf(coords: Array<[number, number]>): [[number, number], [number, number]] | null {
  if (!coords.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (minX === maxX && minY === maxY) return [[minX - 0.005, minY - 0.005], [maxX + 0.005, maxY + 0.005]];
  return [[minX, minY], [maxX, maxY]];
}

/**
 * Posición del reproductor en el instante t. Entre dos puntos del mismo segmento se interpola
 * (y se informa como interpolada). Dentro de un hueco no hay posición: se devuelve la última conocida.
 */
export function positionAt(flat: FlatPoint[], t: number): { lon: number; lat: number; interpolated: boolean; inGap: boolean; point: FlatPoint | null } | null {
  if (!flat.length) return null;
  if (t <= flat[0]!.t) return { ...flat[0]!, interpolated: false, inGap: false, point: flat[0]! };
  let lo = 0;
  let hi = flat.length - 1;
  if (t >= flat[hi]!.t) return { ...flat[hi]!, interpolated: false, inGap: false, point: flat[hi]! };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (flat[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = flat[lo]!;
  const b = flat[hi]!;
  if (t === a.t) return { ...a, interpolated: false, inGap: false, point: a };
  if (a.segment !== b.segment) return { lon: a.lon, lat: a.lat, interpolated: false, inGap: true, point: a };
  const f = (t - a.t) / (b.t - a.t);
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, interpolated: true, inGap: false, point: f < 0.5 ? a : b };
}
