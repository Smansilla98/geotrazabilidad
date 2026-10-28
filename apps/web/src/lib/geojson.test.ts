import { describe, expect, it } from 'vitest';
import type { TrackResponse } from '@geo/shared';
import { flattenTrack, positionAt, trackLayers } from './geojson';

const track: TrackResponse = {
  deviceId: 'd',
  from: '',
  to: '',
  isDemo: false,
  truncated: false,
  stats: { distanceM: 0, observedPoints: 4, returnedPoints: 4, simplified: false, gaps: 1, outliers: 0, maxSpeedMps: null, durationS: 0 },
  segments: [
    { kind: 'observed', sessionId: 's', startAt: '', endAt: '', points: [[0, 0, 0, 1, 5, 1, 0], [1, 0, 10_000, 2, 5, 1, 0]] },
    { kind: 'gap', reason: 'no_data', startAt: '', endAt: '', durationS: 600, distanceM: 1000, from: { lon: 1, lat: 0 }, to: { lon: 5, lat: 0 } },
    { kind: 'observed', sessionId: 's', startAt: '', endAt: '', points: [[5, 0, 610_000, 3, 80, 1, 1], [6, 0, 620_000, 4, 5, 1, 0]] },
  ],
  outliers: [],
};

describe('reproductor', () => {
  const flat = flattenTrack(track);

  it('en un punto registrado no marca interpolación', () => {
    expect(positionAt(flat, 10_000)).toMatchObject({ lon: 1, interpolated: false, inGap: false });
  });

  it('entre dos puntos del mismo tramo interpola y lo informa', () => {
    expect(positionAt(flat, 5_000)).toMatchObject({ lon: 0.5, interpolated: true, inGap: false });
  });

  it('dentro de un hueco no inventa posición: devuelve la última conocida', () => {
    expect(positionAt(flat, 300_000)).toMatchObject({ lon: 1, interpolated: false, inGap: true });
  });

  it('los huecos se dibujan como extremos, nunca como línea', () => {
    const l = trackLayers(track);
    expect(l.lines.features).toHaveLength(2);
    expect(l.gaps.features.map((f) => f.properties.end)).toEqual(['from', 'to']);
    expect(l.points.features.find((f) => f.properties.id === 3)?.properties.q).toBe('poor');
  });
});
