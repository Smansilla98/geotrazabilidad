import type { DeviceTokenResponse, IngestBatchRequest, IngestBatchResponse, TokenPair } from '@geo/shared';
import { SyncHttpError } from '@geo/shared';
import { apiUrl } from './config';
import { getDevice, getUserSession, setDevice, setUserSession } from './credentials';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function raw(path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}) {
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
}

async function parseError(r: Response): Promise<ApiError> {
  const b = (await r.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  return new ApiError(r.status, b?.error?.code ?? 'HTTP_ERROR', b?.error?.message ?? `Error ${r.status}`);
}

// ── Usuario ──
export async function login(email: string, password: string) {
  const r = await raw('/v1/auth/login', { method: 'POST', json: { email, password } });
  if (!r.ok) throw await parseError(r);
  const t = (await r.json()) as TokenPair;
  await setUserSession({ accessToken: t.accessToken, refreshToken: t.refreshToken });
}

export async function register(email: string, password: string, displayName: string) {
  const r = await raw('/v1/auth/register', { method: 'POST', json: { email, password, displayName } });
  if (!r.ok) throw await parseError(r);
  const t = (await r.json()) as TokenPair;
  await setUserSession({ accessToken: t.accessToken, refreshToken: t.refreshToken });
}

export async function forgotPassword(email: string) {
  await raw('/v1/auth/password/forgot', { method: 'POST', json: { email } });
}

export async function logoutUser() {
  const s = await getUserSession();
  if (s) await raw('/v1/auth/logout', { method: 'POST', json: { refreshToken: s.refreshToken } }).catch(() => null);
  await setUserSession(null);
}

let userRefresh: Promise<boolean> | null = null;
async function refreshUser(): Promise<boolean> {
  userRefresh ??= (async () => {
    const s = await getUserSession();
    if (!s) return false;
    const r = await raw('/v1/auth/refresh', { method: 'POST', json: { refreshToken: s.refreshToken } }).catch(() => null);
    if (!r?.ok) {
      if (r && r.status === 401) await setUserSession(null);
      return false;
    }
    const t = (await r.json()) as TokenPair;
    await setUserSession({ accessToken: t.accessToken, refreshToken: t.refreshToken });
    return true;
  })().finally(() => (userRefresh = null));
  return userRefresh;
}

/** Llamada autenticada como usuario (pantallas de consulta). */
export async function userApi<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let s = await getUserSession();
  let r = await raw(path, { ...init, token: s?.accessToken });
  if (r.status === 401 && (await refreshUser())) {
    s = await getUserSession();
    r = await raw(path, { ...init, token: s?.accessToken });
  }
  if (!r.ok) throw await parseError(r);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

// ── Dispositivo ──
export async function linkDevice(input: { installId: string; name: string; platform: 'android' | 'ios'; appVersion: string; osVersion?: string; model?: string }) {
  const d = await userApi<DeviceTokenResponse>('/v1/devices', { method: 'POST', json: input });
  await setDevice({ deviceId: d.deviceId, deviceToken: d.deviceToken, refreshToken: d.deviceRefreshToken });
  return d.deviceId;
}

let deviceRefresh: Promise<boolean> | null = null;
async function refreshDevice(): Promise<boolean> {
  deviceRefresh ??= (async () => {
    const d = await getDevice();
    if (!d) return false;
    const r = await raw('/v1/devices/token/refresh', { method: 'POST', json: { deviceId: d.deviceId, refreshToken: d.refreshToken } }).catch(() => null);
    if (!r?.ok) return false;
    const t = (await r.json()) as DeviceTokenResponse;
    await setDevice({ deviceId: t.deviceId, deviceToken: t.deviceToken, refreshToken: t.deviceRefreshToken });
    return true;
  })().finally(() => (deviceRefresh = null));
  return deviceRefresh;
}

/** Llamada con la credencial del dispositivo (ingesta, latido, configuración). */
export async function deviceApi<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let d = await getDevice();
  if (!d) throw new SyncHttpError(401, 'NO_DEVICE', 'El dispositivo no está vinculado');
  let r = await raw(path, { ...init, token: d.deviceToken });
  if (r.status === 401 && (await refreshDevice())) {
    d = await getDevice();
    r = await raw(path, { ...init, token: d!.deviceToken });
  }
  if (!r.ok) {
    const e = await parseError(r);
    throw new SyncHttpError(r.status, e.code, e.message);
  }
  return (await r.json()) as T;
}

export const sendBatch = (req: IngestBatchRequest) => deviceApi<IngestBatchResponse>('/v1/ingest/batches', { method: 'POST', json: req });
