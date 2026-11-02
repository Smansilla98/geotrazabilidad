import { describe, expect, it } from 'vitest';
import { connectionStateFor, NO_SIGNAL_AFTER_S, positionStateFor } from '../src/contracts/common.js';
import { DEFAULT_TRACKING_CONFIG, TrackingConfigParams } from '../src/contracts/tracking-config.js';
import { evaluateSession } from '../src/rules/engine.js';
import { trackingDirectiveFor, tripWindowEnd, type TripWindowInput } from '../src/rules/trip-window.js';
import { DEFAULT_RULE_PARAMS, ruleParamsForTiming } from '../src/rules/types.js';
import { TrackBuilder } from './helpers.js';

const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
const H = 3600_000;
const trip = (p: Partial<TripWindowInput> = {}): TripWindowInput => ({
  status: 'in_progress',
  startedAt: T0,
  endedAt: null,
  maxDurationS: 24 * 3600,
  stopGraceS: 600,
  ...p,
});

describe('ventana y corte del viaje', () => {
  it('en curso: la ventana termina en la duración máxima y el registro sigue', () => {
    expect(tripWindowEnd(trip())).toBe(T0 + 24 * H);
    expect(trackingDirectiveFor(trip(), T0 + 5 * H)).toEqual({ state: 'active', reason: null });
  });

  it('sin inicio observado no hay ventana ni corte por duración', () => {
    expect(tripWindowEnd(trip({ startedAt: null, status: 'planned' }))).toBeNull();
    expect(trackingDirectiveFor(trip({ startedAt: null, status: 'planned' }), T0 + 48 * H).state).toBe('active');
  });

  it('pasada la duración máxima indica detenerse', () => {
    expect(trackingDirectiveFor(trip({ maxDurationS: 3600 }), T0 + H)).toEqual({ state: 'stop', reason: 'trip_max_duration' });
  });

  it('al llegar sigue registrando durante el margen y después se detiene', () => {
    const t = trip({ status: 'completed', endedAt: T0 + 2 * H });
    expect(tripWindowEnd(t)).toBe(T0 + 2 * H + 600_000);
    expect(trackingDirectiveFor(t, T0 + 2 * H + 300_000).state).toBe('active');
    expect(trackingDirectiveFor(t, T0 + 2 * H + 600_000)).toEqual({ state: 'stop', reason: 'trip_completed' });
  });

  it('cancelado: corta en el momento de la cancelación, sin margen', () => {
    const t = trip({ status: 'cancelled', endedAt: T0 + H });
    expect(tripWindowEnd(t)).toBe(T0 + H);
    expect(trackingDirectiveFor(t, T0 + H)).toEqual({ state: 'stop', reason: 'trip_cancelled' });
  });

  it('gana el corte que ocurra primero', () => {
    expect(tripWindowEnd(trip({ status: 'completed', endedAt: T0 + 3 * H, maxDurationS: 2 * 3600 }))).toBe(T0 + 2 * H);
  });
});

describe('estado de la posición', () => {
  const now = new Date(T0);
  it('distingue actual, sin señal, sin permiso y sin datos', () => {
    expect(positionStateFor(new Date(T0 - 60_000), 'always', now)).toBe('current');
    expect(positionStateFor(new Date(T0 - (NO_SIGNAL_AFTER_S + 1) * 1000), 'always', now)).toBe('no_signal');
    expect(positionStateFor(new Date(T0 - 60_000), 'denied', now)).toBe('no_permission');
    expect(positionStateFor(null, null, now)).toBe('no_data');
  });

  it('el umbral de sin señal contempla el envío cada 5 min (no es el de conexión)', () => {
    const last = new Date(T0 - 20 * 60_000);
    expect(positionStateFor(last, 'always', now)).toBe('current');
    expect(connectionStateFor(last, now)).toBe('stale');
  });
});

describe('modo flota', () => {
  it('su configuración por defecto es válida y espacia los puntos 2–3 min con envío cada 5 min', () => {
    const f = TrackingConfigParams.parse(DEFAULT_TRACKING_CONFIG.fleet);
    expect(f.maxIntervalMovingS).toBe(180);
    expect(f.nativeIntervalMs).toBe(150_000);
    expect(f.syncIntervalS).toBe(300);
  });

  it('los umbrales de detención se ajustan a la captura espaciada', () => {
    expect(ruleParamsForTiming({ maxIntervalMovingS: 120, stationaryIntervalS: 900 })).toBe(DEFAULT_RULE_PARAMS);
    const p = ruleParamsForTiming({ maxIntervalMovingS: 180, stationaryIntervalS: 900 });
    expect(p.stop).toMatchObject({ radiusM: 200, minDurationS: 600 });
  });

  it('con puntos cada 3 min, una pausa de 6 min no es detención y una de 15 min sí', () => {
    const timing = { maxIntervalMovingS: 180, stationaryIntervalS: 900 };
    const params = ruleParamsForTiming(timing);
    const run = (stayPoints: number) => {
      const b = new TrackBuilder().add().move(5, 180, 15).stay(stayPoints, 180, 40).move(5, 180, 15);
      return evaluateSession({ sessionId: 'session-1', points: b.points, sessionEnded: true, timing, params }).filter((e) => e.type === 'stop');
    };
    expect(run(2)).toHaveLength(0);
    expect(run(5)).toHaveLength(1);
  });
});
