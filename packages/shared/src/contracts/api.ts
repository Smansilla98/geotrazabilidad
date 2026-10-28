import { z } from 'zod';
import {
  ConnectionState,
  EventConfidence,
  EventType,
  IsoDateTime,
  Latitude,
  LocationSource,
  LonLatSchema,
  Longitude,
  OrgRole,
  TrackingMode,
  TripStatus,
  Uuid,
} from './common.js';
import { TrackingConfigParams } from './tracking-config.js';

// ───────────── Auth ─────────────
export const Password = z.string().min(10, 'Mínimo 10 caracteres').max(200);
export const RegisterRequest = z.object({
  email: z.email().max(254),
  password: Password,
  displayName: z.string().trim().min(1).max(80),
});
export const LoginRequest = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });
export const RefreshRequest = z.object({ refreshToken: z.string().min(20).max(500) });
export const ForgotPasswordRequest = z.object({ email: z.email().max(254) });
export const ResetPasswordRequest = z.object({ token: z.string().min(20).max(500), password: Password });
export const TokenPair = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number() });
export type TokenPair = z.infer<typeof TokenPair>;

export const MeResponse = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  memberships: z.array(z.object({ orgId: Uuid, orgName: z.string(), role: OrgRole, retentionDays: z.number() })),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const AddMemberRequest = z.object({ email: z.email(), role: OrgRole });
export const UpdateOrgRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

// ───────────── Dispositivos ─────────────
export const RegisterDeviceRequest = z.object({
  orgId: Uuid.optional(),
  installId: Uuid,
  name: z.string().trim().min(1).max(80),
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().max(40).optional(),
  osVersion: z.string().max(40).optional(),
  model: z.string().max(80).optional(),
});
export const DeviceTokenResponse = z.object({
  deviceId: Uuid,
  deviceToken: z.string(),
  deviceRefreshToken: z.string(),
  expiresIn: z.number(),
});
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>;
export const DeviceRefreshRequest = z.object({ deviceId: Uuid, refreshToken: z.string().min(20).max(500) });

export const ConsentRequest = z.object({ consentVersion: z.string().min(1).max(20), shareWithOrg: z.boolean() });
export const CURRENT_CONSENT_VERSION = '2026-10-1';

export const DeviceSummary = z.object({
  id: Uuid,
  orgId: Uuid,
  name: z.string(),
  platform: z.string(),
  status: z.enum(['active', 'revoked']),
  isDemo: z.boolean(),
  holder: z.object({ id: Uuid, displayName: z.string() }),
  appVersion: z.string().nullable(),
  connectionState: ConnectionState,
  lastContactAt: IsoDateTime.nullable(),
  lastPoint: z
    .object({ lat: Latitude, lon: Longitude, capturedAt: IsoDateTime, receivedAt: IsoDateTime, accuracyM: z.number().nullable() })
    .nullable(),
  sync: z.object({ clientPendingCount: z.number().nullable(), clientReportedAt: IsoDateTime.nullable(), lastError: z.string().nullable() }),
  consent: z.object({ active: z.boolean(), shareWithOrg: z.boolean(), version: z.string().nullable() }),
  canManage: z.boolean(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;
export const UpdateDeviceRequest = z.object({ name: z.string().trim().min(1).max(80) });

export const HeartbeatRequest = z.object({
  pendingCount: z.number().int().min(0),
  permission: z.enum(['always', 'when_in_use', 'denied', 'unknown']),
  trackingActive: z.boolean(),
  batteryLevel: z.number().min(0).max(1).nullable().optional(),
  appVersion: z.string().max(40).optional(),
  lastError: z.string().max(500).nullable().optional(),
});

// ───────────── Ingesta ─────────────
export const MAX_POINTS_PER_BATCH = 500;

export const IngestSession = z.object({
  id: Uuid,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable().optional(),
  endReason: z.string().max(40).nullable().optional(),
  mode: TrackingMode,
  tripId: Uuid.nullable().optional(),
  configSnapshot: z.record(z.string(), z.unknown()).default({}),
});
export type IngestSession = z.infer<typeof IngestSession>;

/** Punto tal como lo envía el cliente. La validación de rango se hace por punto (rechazo individual). */
export const IngestPoint = z.object({
  id: Uuid,
  sessionId: Uuid,
  seq: z.number().int().min(0),
  capturedAt: IsoDateTime,
  lat: z.number(),
  lon: z.number(),
  accuracy: z.number().min(0).nullable().optional(),
  altitude: z.number().nullable().optional(),
  altitudeAccuracy: z.number().min(0).nullable().optional(),
  speed: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  source: LocationSource.default('unknown'),
  mocked: z.boolean().nullable().optional(),
  battery: z.number().min(0).max(1).nullable().optional(),
});
export type IngestPoint = z.infer<typeof IngestPoint>;

export const IngestBatchRequest = z.object({
  batchId: Uuid,
  sentAt: IsoDateTime,
  client: z.object({
    appVersion: z.string().max(40).optional(),
    pendingCount: z.number().int().min(0).optional(),
    batteryLevel: z.number().min(0).max(1).nullable().optional(),
    permission: z.enum(['always', 'when_in_use', 'denied', 'unknown']).optional(),
    configVersion: z.number().int().optional(),
  }),
  sessions: z.array(IngestSession).max(50),
  points: z.array(IngestPoint).max(MAX_POINTS_PER_BATCH),
});
export type IngestBatchRequest = z.infer<typeof IngestBatchRequest>;

export const RejectCode = z.enum([
  'LAT_OUT_OF_RANGE',
  'LON_OUT_OF_RANGE',
  'UNKNOWN_SESSION',
  'SESSION_OF_OTHER_DEVICE',
  'TOO_FAR_IN_FUTURE',
  'BEFORE_SESSION_START',
  'INVALID_VALUE',
]);
export type RejectCode = z.infer<typeof RejectCode>;

export const IngestBatchResponse = z.object({
  batchId: Uuid,
  serverTime: IsoDateTime,
  accepted: z.array(Uuid),
  duplicates: z.array(Uuid),
  rejected: z.array(z.object({ id: Uuid, code: RejectCode })),
  config: z.object({ version: z.number(), changed: z.boolean() }),
});
export type IngestBatchResponse = z.infer<typeof IngestBatchResponse>;

// ───────────── Recorridos ─────────────
export const TrackQuery = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
  sessionId: Uuid.optional(),
  tripId: Uuid.optional(),
  /** Tolerancia de simplificación en metros; 0 = sin simplificar. */
  toleranceM: z.coerce.number().min(0).max(500).default(0),
  maxPoints: z.coerce.number().int().min(100).max(20000).default(5000),
});

/** [lon, lat, epochMs, pointId, accuracy|null, speed|null, flagsBitmask] */
export const TrackPointTuple = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number().nullable(), z.number().nullable(), z.number()]);
export type TrackPointTuple = z.infer<typeof TrackPointTuple>;

export const TrackSegment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observed'), sessionId: Uuid, startAt: IsoDateTime, endAt: IsoDateTime, points: z.array(TrackPointTuple) }),
  z.object({
    kind: z.literal('gap'),
    startAt: IsoDateTime,
    endAt: IsoDateTime,
    durationS: z.number(),
    distanceM: z.number(),
    reason: z.enum(['no_data', 'session_boundary', 'implausible_jump']),
    from: LonLatSchema,
    to: LonLatSchema,
  }),
]);
export type TrackSegment = z.infer<typeof TrackSegment>;

export const TrackResponse = z.object({
  deviceId: Uuid,
  from: IsoDateTime,
  to: IsoDateTime,
  isDemo: z.boolean(),
  truncated: z.boolean(),
  stats: z.object({
    distanceM: z.number(),
    observedPoints: z.number(),
    returnedPoints: z.number(),
    simplified: z.boolean(),
    gaps: z.number(),
    outliers: z.number(),
    maxSpeedMps: z.number().nullable(),
    durationS: z.number(),
  }),
  segments: z.array(TrackSegment),
  outliers: z.array(z.object({ pointId: z.number(), lon: z.number(), lat: z.number(), at: IsoDateTime, flags: z.array(z.string()) })),
});
export type TrackResponse = z.infer<typeof TrackResponse>;

export const SessionSummary = z.object({
  id: Uuid,
  deviceId: Uuid,
  tripId: Uuid.nullable(),
  mode: TrackingMode,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  endReason: z.string().nullable(),
  pointCount: z.number(),
  firstPointAt: IsoDateTime.nullable(),
  lastPointAt: IsoDateTime.nullable(),
  isDemo: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// ───────────── Eventos ─────────────
export const EventsQuery = z.object({
  deviceId: Uuid.optional(),
  tripId: Uuid.optional(),
  sessionId: Uuid.optional(),
  types: z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(EventType)).optional(),
  confidence: z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(EventConfidence)).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.string().max(200).optional(),
});

export const TrackingEventDto = z.object({
  id: Uuid,
  deviceId: Uuid,
  deviceName: z.string(),
  sessionId: Uuid.nullable(),
  tripId: Uuid.nullable(),
  tripName: z.string().nullable(),
  geofenceId: Uuid.nullable(),
  geofenceName: z.string().nullable(),
  type: EventType,
  occurredAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  pointId: z.number().nullable(),
  confidence: EventConfidence,
  ruleId: z.string(),
  ruleVersion: z.number(),
  ruleParams: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()),
  source: z.enum(['server_rules', 'device', 'user']),
  isDemo: z.boolean(),
});
export type TrackingEventDto = z.infer<typeof TrackingEventDto>;

// ───────────── Geocercas ─────────────
const Ring = z.array(z.tuple([Longitude, Latitude])).min(4);
export const GeofenceKind = z.enum(['home', 'work', 'depot', 'office', 'delivery', 'poi', 'trip_origin', 'trip_destination', 'other']);
export const GeofenceInput = z
  .object({
    orgId: Uuid.optional(),
    name: z.string().trim().min(1).max(80),
    kind: GeofenceKind,
    shape: z.enum(['circle', 'polygon']),
    center: LonLatSchema.optional(),
    radiusM: z.number().min(10).max(50000).optional(),
    polygon: z.array(Ring).min(1).max(1).optional(),
    enterDwellS: z.number().int().min(0).max(3600).default(60),
    exitDwellS: z.number().int().min(0).max(3600).default(60),
    hysteresisM: z.number().int().min(0).max(500).default(25),
    active: z.boolean().default(true),
  })
  .refine((g) => (g.shape === 'circle' ? !!g.center && !!g.radiusM : !!g.polygon), {
    message: 'Un círculo requiere center y radiusM; un polígono requiere polygon',
  });
export type GeofenceInput = z.infer<typeof GeofenceInput>;
export const GeofenceDto = z.object({
  id: Uuid,
  orgId: Uuid,
  name: z.string(),
  kind: GeofenceKind,
  shape: z.enum(['circle', 'polygon']),
  center: LonLatSchema.nullable(),
  radiusM: z.number().nullable(),
  polygon: z.array(z.array(z.tuple([z.number(), z.number()]))).nullable(),
  enterDwellS: z.number(),
  exitDwellS: z.number(),
  hysteresisM: z.number(),
  active: z.boolean(),
  createdAt: IsoDateTime,
});
export type GeofenceDto = z.infer<typeof GeofenceDto>;

// ───────────── Viajes ─────────────
export const TripInput = z.object({
  orgId: Uuid.optional(),
  deviceId: Uuid.nullable().optional(),
  name: z.string().trim().min(1).max(120),
  origin: LonLatSchema,
  originLabel: z.string().max(200).nullable().optional(),
  destination: LonLatSchema,
  destinationLabel: z.string().max(200).nullable().optional(),
  arrivalRadiusM: z.number().int().min(10).max(5000).default(100),
  plannedStartAt: IsoDateTime.nullable().optional(),
  plannedArrivalAt: IsoDateTime.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const TripUpdate = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  deviceId: Uuid.nullable().optional(),
  status: z.enum(['planned', 'cancelled', 'interrupted', 'completed']).optional(),
  plannedStartAt: IsoDateTime.nullable().optional(),
  plannedArrivalAt: IsoDateTime.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const RouteRequest = z.object({ profile: z.enum(['driving', 'cycling', 'foot']).default('driving') });

export const PlannedRouteDto = z.object({
  id: Uuid,
  provider: z.string(),
  profile: z.string(),
  distanceM: z.number(),
  durationS: z.number().nullable(),
  durationKind: z.enum(['provider_no_traffic', 'provider_with_traffic', 'basic_estimate']),
  coordinates: z.array(z.tuple([z.number(), z.number()])),
  computedAt: IsoDateTime,
  attribution: z.string().nullable(),
});
export type PlannedRouteDto = z.infer<typeof PlannedRouteDto>;

export const TripDto = z.object({
  id: Uuid,
  orgId: Uuid,
  deviceId: Uuid.nullable(),
  deviceName: z.string().nullable(),
  name: z.string(),
  origin: LonLatSchema,
  originLabel: z.string().nullable(),
  destination: LonLatSchema,
  destinationLabel: z.string().nullable(),
  arrivalRadiusM: z.number(),
  plannedStartAt: IsoDateTime.nullable(),
  plannedArrivalAt: IsoDateTime.nullable(),
  status: TripStatus,
  actualStartAt: IsoDateTime.nullable(),
  actualEndAt: IsoDateTime.nullable(),
  notes: z.string().nullable(),
  route: PlannedRouteDto.nullable(),
  createdAt: IsoDateTime,
});
export type TripDto = z.infer<typeof TripDto>;

export const DeviationStatus = z.enum(['confirmed', 'possible', 'imprecise', 'insufficient_data']);
export type DeviationStatus = z.infer<typeof DeviationStatus>;

export const TripComparison = z.object({
  tripId: Uuid,
  planned: z
    .object({ provider: z.string(), distanceM: z.number(), durationS: z.number().nullable(), durationKind: z.string(), computedAt: IsoDateTime })
    .nullable(),
  observed: z.object({
    distanceM: z.number(),
    durationS: z.number().nullable(),
    startedAt: IsoDateTime.nullable(),
    endedAt: IsoDateTime.nullable(),
    pointCount: z.number(),
    lastPointAt: IsoDateTime.nullable(),
  }),
  diff: z.object({ distanceM: z.number().nullable(), durationS: z.number().nullable() }),
  arrival: z.object({ reached: z.boolean(), confidence: EventConfidence.nullable(), at: IsoDateTime.nullable() }),
  progress: z.object({
    fraction: z.number().nullable(),
    reliable: z.boolean(),
    distanceRemainingM: z.number().nullable(),
    etaS: z.number().nullable(),
    etaKind: z.enum(['basic_estimate']).nullable(),
  }),
  deviations: z.array(
    z.object({
      status: DeviationStatus,
      startAt: IsoDateTime,
      endAt: IsoDateTime,
      maxOffsetM: z.number(),
      pointCount: z.number(),
      startPointId: z.number(),
      endPointId: z.number(),
    }),
  ),
  coverage: z.object({ observedFraction: z.number().nullable(), gaps: z.array(z.object({ startAt: IsoDateTime, endAt: IsoDateTime })) }),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type TripComparison = z.infer<typeof TripComparison>;

// ───────────── Estadísticas ─────────────
export const StatsOverview = z.object({
  generatedAt: IsoDateTime,
  includesDemo: z.boolean(),
  devices: z.object({ total: z.number(), active: z.number(), revoked: z.number(), connectedRecently: z.number(), withPendingSync: z.number() }),
  activeSessions: z.number(),
  tripsInProgress: z.number(),
  sessionsTotal: z.number(),
  distanceTotalM: z.number(),
  pointsTotal: z.number(),
  eventsLast24h: z.number(),
  recentEvents: z.array(TrackingEventDto),
  lastPositions: z.array(
    z.object({
      deviceId: Uuid,
      deviceName: z.string(),
      isDemo: z.boolean(),
      connectionState: ConnectionState,
      lat: z.number(),
      lon: z.number(),
      capturedAt: IsoDateTime,
      receivedAt: IsoDateTime,
    }),
  ),
});
export type StatsOverview = z.infer<typeof StatsOverview>;

export const ExportQuery = z.object({
  deviceId: Uuid,
  from: IsoDateTime,
  to: IsoDateTime,
  format: z.enum(['csv', 'json', 'geojson', 'gpx', 'kml']),
});
export const EventsExportQuery = z.object({
  deviceId: Uuid.optional(),
  from: IsoDateTime,
  to: IsoDateTime,
  format: z.enum(['csv', 'json']),
});

export const TrackingConfigResponse = z.object({ version: z.number(), modes: z.record(TrackingMode, TrackingConfigParams) });
export type TrackingConfigResponse = z.infer<typeof TrackingConfigResponse>;
