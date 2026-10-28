import type { ConnectionState, EventConfidence, EventType } from '@geo/shared';

/** Las fechas se guardan en UTC; se muestran en la zona horaria del navegador. */
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dt = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'medium' });
const tOnly = new Intl.DateTimeFormat('es-AR', { timeStyle: 'medium' });
export const fmtDateTime = (v: string | number | Date | null | undefined) => (v == null ? '—' : dt.format(new Date(v)));
export const fmtTime = (v: string | number | Date) => tOnly.format(new Date(v));

export function fmtDistance(m: number | null | undefined) {
  if (m == null) return '—';
  return Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(m >= 100_000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

export function fmtDuration(s: number | null | undefined) {
  if (s == null) return '—';
  const sign = s < 0 ? '−' : '';
  s = Math.abs(Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${sign}${h} h ${m} min`;
  if (m) return `${sign}${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${sign}${s} s`;
}

export const fmtSpeed = (mps: number | null | undefined) => (mps == null ? '—' : `${(mps * 3.6).toFixed(0)} km/h`);

export function fmtAgo(v: string | null | undefined) {
  if (!v) return 'nunca';
  const s = (Date.now() - Date.parse(v)) / 1000;
  if (s < 60) return 'hace instantes';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}

export const EVENT_LABEL: Record<EventType, string> = {
  movement_started: 'Inicio de movimiento',
  stop: 'Detención',
  movement_resumed: 'Reanudación',
  heading_change: 'Cambio de dirección',
  geofence_enter: 'Entrada a zona',
  geofence_exit: 'Salida de zona',
  arrival: 'Llegada a destino',
  route_deviation: 'Desvío de ruta',
  signal_gap: 'Pérdida de señal / sin datos',
  capture_resumed: 'Captura reanudada',
  gps_outlier: 'Salto GPS descartado',
  trip_started: 'Inicio de viaje',
  trip_completed: 'Viaje finalizado',
};

export const EVENT_COLOR: Record<EventType, string> = {
  movement_started: '#2563eb',
  stop: '#b45309',
  movement_resumed: '#2563eb',
  heading_change: '#64748b',
  geofence_enter: '#059669',
  geofence_exit: '#0891b2',
  arrival: '#16a34a',
  route_deviation: '#dc2626',
  signal_gap: '#7c3aed',
  capture_resumed: '#7c3aed',
  gps_outlier: '#9f1239',
  trip_started: '#0f766e',
  trip_completed: '#15803d',
};

export const CONFIDENCE_LABEL: Record<EventConfidence, string> = {
  confirmed: 'Confirmado',
  probable: 'Probable',
  possible: 'Posible',
  insufficient_data: 'Datos insuficientes',
};

export const CONNECTION_LABEL: Record<ConnectionState, { label: string; help: string }> = {
  online: { label: 'En línea', help: 'Contacto con el servidor en los últimos 2 minutos' },
  recent: { label: 'Reciente', help: 'Último contacto hace menos de 15 minutos' },
  stale: { label: 'Inactivo', help: 'Último contacto hace menos de 24 horas' },
  offline: { label: 'Desconectado', help: 'Sin contacto hace más de 24 horas, o revocado' },
  never: { label: 'Sin contacto', help: 'Nunca se conectó (o es un dispositivo de demostración)' },
};

export const STATUS_LABEL: Record<string, string> = {
  planned: 'Planificado',
  in_progress: 'En curso',
  completed: 'Finalizado',
  cancelled: 'Cancelado',
  interrupted: 'Interrumpido',
};

/** Precisión → clase de calidad (misma escala en mapa y leyenda). */
export const accuracyClass = (acc: number | null) => (acc == null ? 'unknown' : acc <= 20 ? 'good' : acc <= 50 ? 'fair' : 'poor');

export function toLocalInput(d: Date) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}
export const fromLocalInput = (s: string) => new Date(s).toISOString();
