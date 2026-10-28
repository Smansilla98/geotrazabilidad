/** Serializadores de exportación. Funciones puras: se prueban sin base de datos. */

export interface ExportPoint {
  id: number;
  sessionId: string;
  seq: number;
  capturedAt: string;
  receivedAt: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  altitudeM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  source: string;
  qualityFlags: string[];
  isDemo: boolean;
}

export const POINT_FIELDS: (keyof ExportPoint)[] = [
  'id', 'sessionId', 'seq', 'capturedAt', 'receivedAt', 'lat', 'lon', 'accuracyM', 'altitudeM', 'speedMps', 'headingDeg', 'source', 'qualityFlags', 'isDemo',
];

export function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('|') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Evita inyección de fórmulas al abrir en planillas.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const csvRow = (values: unknown[]) => values.map(csvCell).join(',') + '\n';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Agrupa en tramos: cambia de sesión o el punto es un outlier → nuevo tramo. Sin unir huecos. */
export function splitSegments(points: ExportPoint[], gapS = 300): ExportPoint[][] {
  const segs: ExportPoint[][] = [];
  let cur: ExportPoint[] = [];
  for (const p of points) {
    if (p.qualityFlags.includes('jump')) continue;
    const prev = cur[cur.length - 1];
    if (prev && (prev.sessionId !== p.sessionId || (Date.parse(p.capturedAt) - Date.parse(prev.capturedAt)) / 1000 > gapS)) {
      segs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export interface ExportMeta {
  deviceId: string;
  deviceName: string;
  from: string;
  to: string;
  generatedAt: string;
  isDemo: boolean;
}

export function toGpx(meta: ExportMeta, points: ExportPoint[]): string {
  const segs = splitSegments(points);
  const trk = segs
    .map(
      (seg) =>
        `    <trkseg>\n${seg
          .map(
            (p) =>
              `      <trkpt lat="${p.lat}" lon="${p.lon}">${p.altitudeM != null ? `<ele>${p.altitudeM}</ele>` : ''}<time>${p.capturedAt}</time>` +
              `<extensions><geo:accuracy>${p.accuracyM ?? ''}</geo:accuracy><geo:speed>${p.speedMps ?? ''}</geo:speed><geo:pointId>${p.id}</geo:pointId>` +
              `<geo:receivedAt>${p.receivedAt}</geo:receivedAt><geo:flags>${xml(p.qualityFlags.join('|'))}</geo:flags></extensions></trkpt>`,
          )
          .join('\n')}\n    </trkseg>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="geotrazabilidad" xmlns="http://www.topografix.com/GPX/1/1" xmlns:geo="urn:geotrazabilidad:1">
  <metadata><name>${xml(meta.deviceName)}${meta.isDemo ? ' (DEMO - datos sintéticos)' : ''}</name><desc>Posiciones observadas ${meta.from} - ${meta.to}. Cada trkseg es un tramo continuo; los huecos no se unen.</desc><time>${meta.generatedAt}</time></metadata>
  <trk><name>${xml(meta.deviceName)}</name>
${trk}
  </trk>
</gpx>
`;
}

export function toKml(meta: ExportMeta, points: ExportPoint[]): string {
  const segs = splitSegments(points);
  const placemarks = segs
    .map(
      (seg, i) => `    <Placemark><name>Tramo ${i + 1}</name><gx:Track>
${seg.map((p) => `      <when>${p.capturedAt}</when>`).join('\n')}
${seg.map((p) => `      <gx:coord>${p.lon} ${p.lat} ${p.altitudeM ?? 0}</gx:coord>`).join('\n')}
    </gx:Track></Placemark>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><name>${xml(meta.deviceName)}${meta.isDemo ? ' (DEMO)' : ''}</name><description>Posiciones observadas ${meta.from} - ${meta.to}</description>
${placemarks}
  </Document>
</kml>
`;
}

export function toGeoJson(meta: ExportMeta, points: ExportPoint[]) {
  const segs = splitSegments(points);
  return {
    type: 'FeatureCollection',
    properties: { ...meta, note: 'Las líneas unen solo puntos de un mismo tramo continuo. Los puntos son observaciones originales.' },
    features: [
      ...segs.map((seg, i) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: seg.map((p) => [p.lon, p.lat]) },
        properties: { kind: 'observed_segment', index: i, startAt: seg[0]!.capturedAt, endAt: seg[seg.length - 1]!.capturedAt, points: seg.length },
      })),
      ...points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { kind: 'observation', ...p, lat: undefined, lon: undefined },
      })),
    ],
  };
}
