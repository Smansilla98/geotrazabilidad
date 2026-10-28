import type { EventConfidence, EventType } from '../contracts/common.js';
import type { LonLat } from '../geo.js';

/** Posición observada tal como la ven las reglas (ya persistida). */
export interface ObservedPoint {
  /** id del registro en la base (o índice en pruebas). */
  id: number;
  sessionId: string;
  seq: number;
  /** captured_at en epoch ms (UTC). */
  t: number;
  lat: number;
  lon: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  /** Marcas asignadas en la ingesta (mocked, future_ts, ...). */
  flags: readonly string[];
}

export interface GeofenceDef {
  id: string;
  shape: 'circle' | 'polygon';
  center?: LonLat;
  radiusM?: number;
  /** Anillo exterior cerrado (primer vértice = último). */
  ring?: LonLat[];
  enterDwellS: number;
  exitDwellS: number;
  hysteresisM: number;
}

export interface TripDef {
  id: string;
  origin: LonLat;
  destination: LonLat;
  arrivalRadiusM: number;
  route: LonLat[] | null;
}

export interface SessionTiming {
  /** Intervalo máximo esperado entre puntos en movimiento (s), según el modo de captura. */
  maxIntervalMovingS: number;
  /** Intervalo de latido esperado estando detenido (s). */
  stationaryIntervalS: number;
}

export interface DerivedEvent {
  type: EventType;
  occurredAt: number;
  endedAt: number | null;
  lat: number | null;
  lon: number | null;
  pointId: number | null;
  confidence: EventConfidence;
  ruleId: string;
  ruleVersion: number;
  ruleParams: Record<string, unknown>;
  evidence: Record<string, unknown>;
  /** Clave estable: misma condición => misma clave (idempotencia del reprocesamiento). */
  dedupKey: string;
  geofenceId?: string | null;
  tripId?: string | null;
}

export const RULES_VERSION = 1;

export interface RuleParams {
  quality: { lowAccuracyM: number; maxSpeedMps: number; jumpMinDistanceM: number };
  gap: { minThresholdS: number; movingIntervalFactor: number; stationaryIntervalFactor: number; stationaryRadiusM: number };
  stop: { radiusM: number; minDurationS: number; maxAccuracyM: number };
  heading: { minDeltaDeg: number; minSpeedMps: number; minLegM: number; debounceS: number };
  geofence: { maxAccuracyM: number; accuracyMarginCapM: number };
  arrival: { dwellS: number };
  corridor: { corridorM: number; minDurationS: number; minPoints: number; maxAccuracyM: number; backtrackM: number };
  progress: { minCoverage: number; etaMinMovingS: number; etaWindowS: number };
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  quality: { lowAccuracyM: 100, maxSpeedMps: 70, jumpMinDistanceM: 300 },
  gap: { minThresholdS: 120, movingIntervalFactor: 3, stationaryIntervalFactor: 2, stationaryRadiusM: 100 },
  stop: { radiusM: 60, minDurationS: 180, maxAccuracyM: 100 },
  heading: { minDeltaDeg: 60, minSpeedMps: 3, minLegM: 20, debounceS: 120 },
  geofence: { maxAccuracyM: 150, accuracyMarginCapM: 50 },
  arrival: { dwellS: 60 },
  corridor: { corridorM: 75, minDurationS: 60, minPoints: 3, maxAccuracyM: 50, backtrackM: 300 },
  progress: { minCoverage: 0.6, etaMinMovingS: 300, etaWindowS: 600 },
};

export const DEFAULT_SESSION_TIMING: SessionTiming = { maxIntervalMovingS: 120, stationaryIntervalS: 900 };
