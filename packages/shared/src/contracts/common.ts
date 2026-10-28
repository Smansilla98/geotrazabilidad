import { z } from 'zod';

export const IsoDateTime = z.iso.datetime({ offset: true });
export const Uuid = z.uuid();
export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);
export const LonLatSchema = z.object({ lon: Longitude, lat: Latitude });

export const OrgRole = z.enum(['owner', 'admin', 'viewer']);
export type OrgRole = z.infer<typeof OrgRole>;

export const TrackingMode = z.enum(['battery_saver', 'normal', 'trip', 'intensive']);
export type TrackingMode = z.infer<typeof TrackingMode>;

export const LocationSource = z.enum(['gps', 'fused', 'network', 'unknown', 'demo']);
export type LocationSource = z.infer<typeof LocationSource>;

export const QualityFlag = z.enum(['low_accuracy', 'jump', 'future_ts', 'mocked', 'out_of_order', 'no_accuracy']);
export type QualityFlag = z.infer<typeof QualityFlag>;

export const EventType = z.enum([
  'movement_started',
  'stop',
  'movement_resumed',
  'heading_change',
  'geofence_enter',
  'geofence_exit',
  'arrival',
  'route_deviation',
  'signal_gap',
  'capture_resumed',
  'gps_outlier',
  'trip_started',
  'trip_completed',
]);
export type EventType = z.infer<typeof EventType>;

export const EventConfidence = z.enum(['confirmed', 'probable', 'possible', 'insufficient_data']);
export type EventConfidence = z.infer<typeof EventConfidence>;

export const ConnectionState = z.enum(['online', 'recent', 'stale', 'offline', 'never']);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const TripStatus = z.enum(['planned', 'in_progress', 'completed', 'cancelled', 'interrupted']);
export type TripStatus = z.infer<typeof TripStatus>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(200).optional(),
});

/** Umbrales de estado de conexión (segundos desde el último contacto). */
export const CONNECTION_THRESHOLDS_S = { online: 120, recent: 15 * 60, stale: 24 * 3600 } as const;

export function connectionStateFor(lastContactAt: Date | null, now: Date = new Date()): ConnectionState {
  if (!lastContactAt) return 'never';
  const s = (now.getTime() - lastContactAt.getTime()) / 1000;
  if (s <= CONNECTION_THRESHOLDS_S.online) return 'online';
  if (s <= CONNECTION_THRESHOLDS_S.recent) return 'recent';
  if (s <= CONNECTION_THRESHOLDS_S.stale) return 'stale';
  return 'offline';
}
