import type { ApiError } from '@geo/shared';

/** El access token vive solo en memoria; el refresh token en una cookie httpOnly gestionada por el BFF. */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(authed: boolean) => void>();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const onAuthChange = (fn: (authed: boolean) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const setToken = (t: string | null) => {
  accessToken = t;
  listeners.forEach((fn) => fn(!!t));
};

async function bff(path: string, body?: unknown): Promise<Response> {
  return fetch(`/bff/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Geo-Client': 'web' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
}

async function toError(r: Response): Promise<HttpError> {
  const body = (await r.json().catch(() => null)) as ApiError | null;
  return new HttpError(r.status, body?.error.code ?? 'HTTP_ERROR', body?.error.message ?? `Error ${r.status}`, body?.error.details);
}

export async function login(email: string, password: string) {
  const r = await bff('login', { email, password });
  if (!r.ok) throw await toError(r);
  setToken(((await r.json()) as { accessToken: string }).accessToken);
}

export async function register(email: string, password: string, displayName: string) {
  const r = await bff('register', { email, password, displayName });
  if (!r.ok) throw await toError(r);
  setToken(((await r.json()) as { accessToken: string }).accessToken);
}

export async function logout() {
  await bff('logout').catch(() => null);
  setToken(null);
}

/** Restaura la sesión desde la cookie (recarga de página). Coalesce llamadas concurrentes. */
export function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await bff('refresh');
      if (!r.ok) {
        setToken(null);
        return false;
      }
      setToken(((await r.json()) as { accessToken: string }).accessToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const doFetch = () =>
    fetch(`/api${path}`, {
      ...init,
      headers: {
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  let r = await doFetch();
  if (r.status === 401 && (await tryRefresh())) r = await doFetch();
  if (!r.ok) throw await toError(r);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

/** Descarga autenticada (exportaciones): fetch → blob → enlace temporal. */
export async function download(path: string, fallbackName: string) {
  let r = await fetch(`/api${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (r.status === 401 && (await tryRefresh())) r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw await toError(r);
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * SSE con fetch (permite la cabecera Authorization, a diferencia de EventSource).
 * Reconexión con espera creciente; al reconectar se notifica 'resync' para volver a consultar.
 */
export function openStream(onEvent: (type: string, data: unknown) => void, onState: (s: StreamState) => void): () => void {
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      onState(attempt ? 'reconnecting' : 'connecting');
      try {
        let r = await fetch('/api/v1/stream', { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
        if (r.status === 401 && (await tryRefresh())) r = await fetch('/api/v1/stream', { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
        if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
        onState('open');
        if (attempt) onEvent('resync', {});
        attempt = 0;
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) {
              try {
                onEvent(event, JSON.parse(data));
              } catch {
                /* ignorar */
              }
            }
          }
        }
      } catch {
        if (stopped) break;
      }
      if (stopped) break;
      attempt++;
      onState('reconnecting');
      await new Promise((res) => setTimeout(res, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
    }
    onState('closed');
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

export const runtimeConfig = (): { mapStyleUrl: string; appEnv: string } =>
  (window as unknown as { __GEO_CONFIG__?: { mapStyleUrl: string; appEnv: string } }).__GEO_CONFIG__ ?? {
    mapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    appEnv: 'development',
  };
