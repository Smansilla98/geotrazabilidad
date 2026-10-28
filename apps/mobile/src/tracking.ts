import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import * as Crypto from 'expo-crypto';
import {
  decideCapture,
  DEFAULT_TRACKING_CONFIG,
  INITIAL_CAPTURE_STATE,
  SyncEngine,
  TrackingConfigResponse,
  type CaptureState,
  type SyncOutcome,
  type TrackingConfigParams,
  type TrackingMode,
} from '@geo/shared';
import { deviceApi, sendBatch } from './api';
import { APP_VERSION } from './config';
import { getDevice } from './credentials';
import { getStore } from './db';
import { nativeOptions, sourceOf } from './locationOptions';

export const LOCATION_TASK = 'geo-location-updates';
const ACCURACY = {
  low: Location.Accuracy.Low,
  balanced: Location.Accuracy.Balanced,
  high: Location.Accuracy.High,
  highest: Location.Accuracy.Highest,
} as const;
const META = { session: 'active_session', mode: 'active_mode', capture: 'capture_state', config: 'remote_config', lastSync: 'last_sync_at', lastFix: 'last_fix' } as const;

// ── Estado observable para la UI (useSyncExternalStore) ──
export interface TrackingStatus {
  active: boolean;
  sessionId: string | null;
  mode: TrackingMode;
  permission: 'always' | 'when_in_use' | 'denied' | 'unknown';
  pending: number;
  rejected: number;
  lastSyncAt: number | null;
  lastSync: SyncOutcome | null;
  lastFix: { lat: number; lon: number; t: number; accuracy: number | null } | null;
  online: boolean | null;
  /** Hay una sesión abierta pero el SO detuvo la captura (app cerrada a la fuerza, reinicio). */
  interrupted: boolean;
}
let status: TrackingStatus = {
  active: false, sessionId: null, mode: 'normal', permission: 'unknown', pending: 0, rejected: 0,
  lastSyncAt: null, lastSync: null, lastFix: null, online: null, interrupted: false,
};
const subs = new Set<() => void>();
export const getStatus = () => status;
export const subscribe = (fn: () => void) => (subs.add(fn), () => void subs.delete(fn));
function patch(p: Partial<TrackingStatus>) {
  status = { ...status, ...p };
  subs.forEach((f) => f());
}

// ── Configuración de captura: remota validada o valores locales seguros ──
export async function paramsFor(mode: TrackingMode): Promise<TrackingConfigParams> {
  const store = await getStore();
  const raw = await store.getMeta(META.config);
  if (raw) {
    const parsed = TrackingConfigResponse.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.modes[mode]) return parsed.data.modes[mode];
  }
  return DEFAULT_TRACKING_CONFIG[mode];
}

export async function refreshRemoteConfig() {
  const d = await getDevice();
  if (!d) return;
  try {
    const cfg = await deviceApi<unknown>(`/v1/devices/${d.deviceId}/config`);
    if (TrackingConfigResponse.safeParse(cfg).success) await (await getStore()).setMeta(META.config, JSON.stringify(cfg));
  } catch {
    /* sin conexión: se siguen usando los valores guardados o por defecto */
  }
}

// ── Tarea de segundo plano: definida a nivel de módulo (requisito de TaskManager) ──
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  try {
    await handleLocations(data.locations);
  } catch {
    /* nunca lanzar desde la tarea: el SO podría dejar de entregar actualizaciones */
  }
});

export async function handleLocations(locations: Location.LocationObject[]) {
  const store = await getStore();
  const sessionId = await store.getMeta(META.session);
  if (!sessionId) return;
  const mode = ((await store.getMeta(META.mode)) ?? 'normal') as TrackingMode;
  const params = await paramsFor(mode);
  const rawState = await store.getMeta(META.capture);
  let state: CaptureState = rawState ? (JSON.parse(rawState) as CaptureState) : INITIAL_CAPTURE_STATE;
  const battery = await Battery.getPowerStateAsync().catch(() => null);
  const ctx = { batteryLevel: battery?.batteryLevel ?? null, charging: battery ? battery.batteryState === Battery.BatteryState.CHARGING || battery.batteryState === Battery.BatteryState.FULL : null };

  // El SO puede entregar lotes diferidos: se procesan en orden de captura.
  for (const loc of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
    const c = loc.coords;
    const fix = { t: loc.timestamp, lat: c.latitude, lon: c.longitude, accuracy: c.accuracy ?? null, speed: c.speed != null && c.speed >= 0 ? c.speed : null, heading: c.heading != null && c.heading >= 0 ? c.heading : null };
    const d = decideCapture(state, fix, params, ctx);
    state = d.state;
    if (!d.keep) continue;
    await store.enqueuePoint({
      id: Crypto.randomUUID(),
      sessionId,
      capturedAt: loc.timestamp,
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy ?? null,
      altitude: c.altitude ?? null,
      altitudeAccuracy: c.altitudeAccuracy ?? null,
      speed: fix.speed,
      heading: fix.heading,
      source: sourceOf(loc.mocked),
      mocked: loc.mocked ?? null,
      battery: ctx.batteryLevel,
    });
    await store.setMeta(META.lastFix, JSON.stringify({ lat: c.latitude, lon: c.longitude, t: loc.timestamp, accuracy: c.accuracy ?? null }));
  }
  await store.setMeta(META.capture, JSON.stringify(state));

  // Sincronización oportunista respetando el intervalo del modo.
  const last = Number((await store.getMeta(META.lastSync)) ?? 0);
  if (Date.now() - last >= params.syncIntervalS * 1000) await syncNow();
  else await refreshStatus();
}

// ── Sincronización ──
let engine: SyncEngine | null = null;
let syncing: Promise<SyncOutcome> | null = null;

async function getEngine() {
  engine ??= new SyncEngine(await getStore(), { sendBatch }, {
    uuid: () => Crypto.randomUUID(),
    appVersion: APP_VERSION,
    batchSize: 200,
    clientInfo: async () => {
      const b = await Battery.getBatteryLevelAsync().catch(() => -1);
      return { batteryLevel: b >= 0 ? b : null, permission: status.permission };
    },
  });
  return engine;
}

/** Envía todo lo pendiente (coalesce llamadas concurrentes). */
export function syncNow(): Promise<SyncOutcome> {
  syncing ??= (async () => {
    const store = await getStore();
    const e = await getEngine();
    let out: SyncOutcome = { kind: 'idle' };
    try {
      out = await e.drain(20);
      if (out.kind !== 'retry' && out.kind !== 'blocked') await store.setMeta(META.lastSync, String(Date.now()));
      if (out.kind === 'sent' && out.configChanged) await refreshRemoteConfig();
      await store.purgeAcked(Date.now() - 7 * 86_400_000);
    } catch (err) {
      out = { kind: 'retry', reason: (err as Error).message, delayMs: 30_000 };
    }
    patch({ lastSync: out, lastSyncAt: out.kind === 'sent' || out.kind === 'idle' ? Date.now() : status.lastSyncAt });
    await refreshStatus();
    return out;
  })().finally(() => (syncing = null));
  return syncing;
}

export async function sendHeartbeat() {
  const d = await getDevice();
  if (!d) return null;
  const st = await (await getStore()).stats();
  try {
    return await deviceApi<{ consentActive: boolean; configVersion: number }>(`/v1/devices/${d.deviceId}/heartbeat`, {
      method: 'POST',
      json: { pendingCount: st.pending, permission: status.permission, trackingActive: status.active, appVersion: APP_VERSION, batteryLevel: await Battery.getBatteryLevelAsync().catch(() => null) },
    });
  } catch {
    return null;
  }
}

// ── Permisos ──
export async function refreshPermission(): Promise<TrackingStatus['permission']> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return patch({ permission: fg.canAskAgain ? 'unknown' : 'denied' }), status.permission;
  const bg = await Location.getBackgroundPermissionsAsync();
  patch({ permission: bg.granted ? 'always' : 'when_in_use' });
  return status.permission;
}

/** Primero "en uso"; después "siempre" (en Android 11+ abre Ajustes). Puede operar solo en primer plano. */
export async function requestPermissions(): Promise<TrackingStatus['permission']> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return patch({ permission: 'denied' }), 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  patch({ permission: bg.granted ? 'always' : 'when_in_use' });
  return status.permission;
}

// ── Control del seguimiento ──
export async function startTracking(mode: TrackingMode, tripId: string | null = null) {
  const store = await getStore();
  const perm = await refreshPermission();
  if (perm === 'denied' || perm === 'unknown') throw new Error('Se necesita permiso de ubicación para iniciar el seguimiento.');
  await refreshRemoteConfig();
  const params = await paramsFor(mode);
  let sessionId = await store.getMeta(META.session);
  if (!sessionId) {
    sessionId = Crypto.randomUUID();
    await store.startSession({ id: sessionId, startedAt: Date.now(), mode, tripId, configSnapshot: { ...params, mode } });
    await store.setMeta(META.session, sessionId);
    await store.setMeta(META.mode, mode);
    await store.setMeta(META.capture, JSON.stringify(INITIAL_CAPTURE_STATE));
  }
  const o = nativeOptions(mode, params);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: ACCURACY[o.accuracy],
    distanceInterval: o.distanceInterval,
    timeInterval: o.timeInterval,
    deferredUpdatesInterval: o.deferredUpdatesInterval,
    deferredUpdatesDistance: o.deferredUpdatesDistance,
    activityType: o.activityType === 'automotive' ? Location.ActivityType.AutomotiveNavigation : Location.ActivityType.Other,
    pausesUpdatesAutomatically: o.pausesUpdatesAutomatically,
    showsBackgroundLocationIndicator: o.showsBackgroundLocationIndicator,
    foregroundService: {
      notificationTitle: 'Registrando tu ubicación',
      notificationBody: 'Seguimiento activo. Abrí la app para ver el estado o detenerlo.',
      notificationColor: '#0f766e',
      killServiceOnDestroy: false,
    },
  });
  patch({ active: true, sessionId, mode, interrupted: false });
}

export async function stopTracking(reason = 'user') {
  const store = await getStore();
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  const sessionId = await store.getMeta(META.session);
  if (sessionId) await store.endSession(sessionId, Date.now(), reason);
  await store.setMeta(META.session, '');
  patch({ active: false, sessionId: null, interrupted: false });
  void syncNow();
}

/** Estado real al abrir la app: detecta sesiones abiertas cuya captura fue detenida por el SO. */
export async function refreshStatus() {
  const store = await getStore();
  const st = await store.stats();
  const sessionId = (await store.getMeta(META.session)) || null;
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  const fix = await store.getMeta(META.lastFix);
  patch({
    pending: st.pending,
    rejected: st.rejected,
    sessionId,
    active: !!sessionId && running,
    interrupted: !!sessionId && !running,
    mode: ((await store.getMeta(META.mode)) ?? 'normal') as TrackingMode,
    lastFix: fix ? JSON.parse(fix) : null,
  });
}

export function setOnline(online: boolean | null) {
  patch({ online });
}

export async function recentSessionPoints(limit = 2000) {
  const store = await getStore();
  return status.sessionId ? store.recentPoints(status.sessionId, limit) : [];
}
