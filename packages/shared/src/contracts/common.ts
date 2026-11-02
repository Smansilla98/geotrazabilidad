import { z } from 'zod';

export const IsoDateTime = z.iso.datetime({ offset: true });
export const Uuid = z.uuid();
export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);
export const LonLatSchema = z.object({ lon: Longitude, lat: Latitude });

export const OrgRole = z.enum(['owner', 'admin', 'viewer']);
export type OrgRole = z.infer<typeof OrgRole>;

/** 'fleet': captura espaciada (un punto cada 2–3 min, envío cada 5 min) para viajes largos de vehículos. */
export const TrackingMode = z.enum(['battery_saver', 'normal', 'trip', 'intensive', 'fleet']);
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

/** Permiso de ubicación informado por el dispositivo en cada lote y en cada latido. */
export const LocationPermission = z.enum(['always', 'when_in_use', 'denied', 'unknown']);
export type LocationPermission = z.infer<typeof LocationPermission>;

/**
 * Estado de la posición de un dispositivo, para quien lo sigue en el mapa:
 * - current: hay una posición reciente;
 * - no_signal: la última posición recibida es más vieja que el umbral;
 * - no_permission: el último envío informó el permiso denegado;
 * - no_data: el dispositivo nunca envió posiciones.
 */
export const PositionState = z.enum(['current', 'no_signal', 'no_permission', 'no_data']);
export type PositionState = z.infer<typeof PositionState>;

/** Umbral de "sin señal" (s). Contempla tres envíos de 5 min más el atraso de Doze en Android. */
export const NO_SIGNAL_AFTER_S = 30 * 60;

/**
 * Se calcula con la hora del servidor en que llegó el último punto (received_at), no con la hora
 * de captura: un reloj de teléfono atrasado no tiene que mostrar al dispositivo "sin señal".
 */
export function positionStateFor(
  lastPointReceivedAt: Date | null,
  permission: string | null,
  now: Date = new Date(),
  noSignalAfterS: number = NO_SIGNAL_AFTER_S,
): PositionState {
  if (permission === 'denied') return 'no_permission';
  if (!lastPointReceivedAt) return 'no_data';
  return (now.getTime() - lastPointReceivedAt.getTime()) / 1000 > noSignalAfterS ? 'no_signal' : 'current';
}

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
