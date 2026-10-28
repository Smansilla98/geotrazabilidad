import { describe, expect, it } from 'vitest';
import { csvCell, splitSegments, toGeoJson, toGpx, type ExportPoint } from './formats.js';

const pt = (i: number, extra: Partial<ExportPoint> = {}): ExportPoint => ({
  id: i,
  sessionId: 's1',
  seq: i,
  capturedAt: new Date(Date.UTC(2026, 9, 27, 12, 0, i * 10)).toISOString(),
  receivedAt: new Date(Date.UTC(2026, 9, 27, 13)).toISOString(),
  lat: -34.6,
  lon: -58.38 + i * 0.001,
  accuracyM: 5,
  altitudeM: null,
  speedMps: 3,
  headingDeg: 90,
  source: 'gps',
  qualityFlags: [],
  isDemo: false,
  ...extra,
});

describe('formatos de exportación', () => {
  it('CSV escapa comillas, comas y neutraliza fórmulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-58.38')).toBe('-58.38');
    expect(csvCell(['jump', 'mocked'])).toBe('jump|mocked');
    expect(csvCell(null)).toBe('');
  });

  it('separa tramos por sesión y por hueco, y excluye outliers', () => {
    const pts = [pt(0), pt(1), pt(2, { qualityFlags: ['jump'] }), pt(3), pt(100), pt(101, { sessionId: 's2' })];
    const segs = splitSegments(pts);
    expect(segs.map((s) => s.map((p) => p.id))).toEqual([[0, 1, 3], [100], [101]]);
  });

  it('GPX conserva hora de captura, precisión e id del registro', () => {
    const gpx = toGpx({ deviceId: 'd', deviceName: 'Tel <1>', from: 'a', to: 'b', generatedAt: 'c', isDemo: true }, [pt(0), pt(1)]);
    expect(gpx).toContain('<time>2026-10-27T12:00:00.000Z</time>');
    expect(gpx).toContain('<geo:pointId>1</geo:pointId>');
    expect(gpx).toContain('Tel &lt;1&gt; (DEMO - datos sintéticos)');
  });

  it('GeoJSON separa líneas de tramo y observaciones', () => {
    const gj = toGeoJson({ deviceId: 'd', deviceName: 'x', from: 'a', to: 'b', generatedAt: 'c', isDemo: false }, [pt(0), pt(1), pt(200)]);
    expect(gj.features.filter((f) => f.properties.kind === 'observed_segment')).toHaveLength(2);
    expect(gj.features.filter((f) => f.properties.kind === 'observation')).toHaveLength(3);
  });
});
