import { describe, expect, it } from 'vitest';
import { bearingDeg, EARTH_RADIUS_M, haversineM, headingDelta, PolylineIndex, pointInRing, distanceToRingM, simplifyIndices, isValidLatLon } from '../src/geo.js';
import { offset, ORIGIN } from './helpers.js';

const rel = (a: number, b: number) => Math.abs(a - b) / b;

describe('geo', () => {
  it('haversine coincide con valores analíticos (±0,1 %)', () => {
    expect(rel(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), (2 * Math.PI * EARTH_RADIUS_M) / 360)).toBeLessThan(0.001);
    expect(rel(haversineM({ lat: 0, lon: 0 }, { lat: 90, lon: 0 }), (Math.PI * EARTH_RADIUS_M) / 2)).toBeLessThan(0.001);
    expect(rel(haversineM({ lat: 0, lon: -179.5 }, { lat: 0, lon: 179.5 }), (2 * Math.PI * EARTH_RADIUS_M) / 360)).toBeLessThan(0.001);
    expect(haversineM(ORIGIN, ORIGIN)).toBe(0);
  });

  it('haversine coincide con una distancia urbana conocida', () => {
    const p = offset(ORIGIN, 3000, 4000);
    expect(rel(haversineM(ORIGIN, p), 5000)).toBeLessThan(0.001);
  });

  it('rumbo y diferencia angular', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 5);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 5);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 5);
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(90, 270)).toBe(180);
  });

  it('valida rangos de lat/lon', () => {
    expect(isValidLatLon(-90, 180)).toBe(true);
    expect(isValidLatLon(90.0001, 0)).toBe(false);
    expect(isValidLatLon(0, -180.1)).toBe(false);
    expect(isValidLatLon(Number.NaN, 0)).toBe(false);
  });

  it('proyecta un punto sobre una polilínea', () => {
    const a = ORIGIN;
    const b = offset(ORIGIN, 1000, 0);
    const c = offset(ORIGIN, 1000, 1000);
    const idx = new PolylineIndex([a, b, c]);
    expect(rel(idx.totalM, 2000)).toBeLessThan(0.002);
    const pr = idx.project(offset(ORIGIN, 500, 100));
    expect(pr.distanceM).toBeCloseTo(100, -0.5);
    expect(pr.alongM).toBeCloseTo(500, -1);
    const pr2 = idx.project(offset(ORIGIN, 1050, 600));
    expect(pr2.segmentIndex).toBe(1);
    expect(pr2.distanceM).toBeCloseTo(50, -0.5);
    expect(pr2.fraction).toBeGreaterThan(0.75);
  });

  it('punto en polígono y distancia al borde', () => {
    const ring = [ORIGIN, offset(ORIGIN, 200, 0), offset(ORIGIN, 200, 200), offset(ORIGIN, 0, 200), ORIGIN];
    expect(pointInRing(offset(ORIGIN, 100, 100), ring)).toBe(true);
    expect(pointInRing(offset(ORIGIN, 300, 100), ring)).toBe(false);
    expect(distanceToRingM(offset(ORIGIN, 100, 100), ring)).toBeCloseTo(100, -0.5);
    expect(distanceToRingM(offset(ORIGIN, 250, 100), ring)).toBeCloseTo(50, -0.5);
  });

  it('simplifica conservando extremos y puntos forzados', () => {
    const pts = Array.from({ length: 50 }, (_, i) => offset(ORIGIN, i * 10, 0));
    expect(simplifyIndices(pts, 1)).toEqual([0, 49]);
    expect(simplifyIndices(pts, 1, new Set([20]))).toEqual([0, 20, 49]);
    const bent = [...pts, offset(ORIGIN, 490, 300)];
    expect(simplifyIndices(bent, 5)).toEqual([0, 49, 50]);
  });
});
