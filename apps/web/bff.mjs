// BFF (backend-for-frontend) mínimo, sin dependencias. Lo usan server.mjs (producción) y el
// plugin de Vite (desarrollo), así el comportamiento es idéntico en ambos.
//
// - /bff/login|register|refresh|logout: guarda el refresh token en una cookie httpOnly del
//   mismo origen (Path=/bff, SameSite=Strict). El access token vive solo en memoria del SPA.
// - /api/*: proxy transparente hacia la API (incluye streaming SSE). El SPA envía el access token.
// - /config.js: configuración de runtime (no se hornea en el bundle).
//
// Protección CSRF: SameSite=Strict + cabecera obligatoria X-Geo-Client en /bff (fuerza preflight
// en cualquier intento cross-site, que el servidor no autoriza).

const COOKIE = 'geo_rt';
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'te', 'trailer', 'host', 'cookie', 'content-length']);

export function webConfig(env = process.env) {
  const apiUrl = (env.API_INTERNAL_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  if (env.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/.test(apiUrl)) {
    throw new Error('API_INTERNAL_URL no puede apuntar a localhost en producción');
  }
  return {
    apiUrl,
    mapStyleUrl: env.MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty',
    cookieSecure: (env.COOKIE_SECURE ?? (env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
    appEnv: env.NODE_ENV ?? 'development',
  };
}

function readBody(req, limit = 1_100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, value, cfg, maxAgeS) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/bff', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeS}`];
  if (cfg.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function callApi(cfg, path, body, req) {
  const r = await fetch(`${cfg.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': req.socket.remoteAddress ?? '', 'User-Agent': req.headers['user-agent'] ?? 'geo-web' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  try {
    return { status: r.status, data: text ? JSON.parse(text) : null };
  } catch {
    return { status: 502, data: { error: { code: 'BAD_GATEWAY', message: 'Respuesta inválida de la API' } } };
  }
}

/** Maneja /bff/*. Devuelve true si atendió la solicitud. */
export async function handleBff(req, res, cfg) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/bff/')) return false;
  if (req.method !== 'POST') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Usá POST' } }), true;
  if (req.headers['x-geo-client'] !== 'web') return json(res, 403, { error: { code: 'CSRF', message: 'Falta la cabecera X-Geo-Client' } }), true;
  try {
    const action = url.pathname.slice(5);
    const input = action === 'refresh' || action === 'logout' ? {} : JSON.parse((await readBody(req)).toString() || '{}');
    const thirtyDays = 30 * 86_400;
    if (action === 'login' || action === 'register') {
      const r = await callApi(cfg, `/v1/auth/${action}`, input, req);
      if (r.status >= 200 && r.status < 300) {
        setCookie(res, r.data.refreshToken, cfg, thirtyDays);
        return json(res, 200, { accessToken: r.data.accessToken, expiresIn: r.data.expiresIn }), true;
      }
      return json(res, r.status, r.data), true;
    }
    if (action === 'refresh') {
      const token = getCookie(req, COOKIE);
      if (!token) return json(res, 401, { error: { code: 'NO_SESSION', message: 'No hay sesión' } }), true;
      const r = await callApi(cfg, '/v1/auth/refresh', { refreshToken: token }, req);
      if (r.status === 200) {
        setCookie(res, r.data.refreshToken, cfg, thirtyDays);
        return json(res, 200, { accessToken: r.data.accessToken, expiresIn: r.data.expiresIn }), true;
      }
      setCookie(res, '', cfg, 0);
      return json(res, 401, r.data ?? { error: { code: 'NO_SESSION', message: 'Sesión vencida' } }), true;
    }
    if (action === 'logout') {
      const token = getCookie(req, COOKIE);
      if (token) await callApi(cfg, '/v1/auth/logout', { refreshToken: token }, req).catch(() => null);
      setCookie(res, '', cfg, 0);
      return json(res, 204, {}), true;
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Acción desconocida' } }), true;
  } catch (err) {
    const status = err.status ?? 502;
    return json(res, status, { error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'API_UNREACHABLE', message: status === 413 ? 'Cuerpo demasiado grande' : 'No se pudo contactar a la API' } }), true;
  }
}

/** Proxy /api/* → API (/v1/...). Transmite el cuerpo y la respuesta en streaming (SSE incluido). */
export async function handleApiProxy(req, res, cfg) {
  if (!req.url.startsWith('/api/')) return false;
  const target = `${cfg.apiUrl}${req.url.slice(4)}`;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  const controller = new AbortController();
  // 'close' de req se emite también al terminar de leer el cuerpo: la desconexión real se ve en res.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const r = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await readBody(req) : undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
    const out = {};
    r.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k) && k !== 'content-encoding' && k !== 'set-cookie') out[k] = v;
    });
    res.writeHead(r.status, out);
    if (r.headers.get('content-type')?.includes('text/event-stream')) res.flushHeaders?.();
    if (!r.body) return res.end(), true;
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (controller.signal.aborted) return true;
    if (!res.headersSent) json(res, err.status === 413 ? 413 : 502, { error: { code: 'API_UNREACHABLE', message: 'No se pudo contactar a la API' } });
    else res.end();
  }
  return true;
}

export function configScript(cfg) {
  return `window.__GEO_CONFIG__ = ${JSON.stringify({ mapStyleUrl: cfg.mapStyleUrl, appEnv: cfg.appEnv })};`;
}

/** CSP: el mapa necesita el origen del estilo/teselas, blobs para workers y estilos inline de MapLibre. */
export function securityHeaders(cfg, env = process.env) {
  const mapOrigin = (() => {
    try {
      return new URL(cfg.mapStyleUrl).origin;
    } catch {
      return '';
    }
  })();
  const extra = (env.MAP_CSP_EXTRA ?? '').split(',').map((s) => s.trim()).filter(Boolean).join(' ');
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `connect-src 'self' ${mapOrigin} ${extra}`.trim(),
      `img-src 'self' data: blob: ${mapOrigin} ${extra}`.trim(),
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "worker-src 'self' blob:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  };
}
