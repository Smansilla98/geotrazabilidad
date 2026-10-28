// Servidor de producción de la web: estáticos del build + BFF + proxy a la API. Sin dependencias.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { configScript, handleApiProxy, handleBff, securityHeaders, webConfig } from './bff.mjs';

net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const cfg = webConfig();
const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 5173);
const HOST = process.env.HOST ?? '0.0.0.0';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};
const sec = securityHeaders(cfg);
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'geo-web', msg, ...extra }));

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) return res.writeHead(400).end();
  const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
  if (!isFile) {
    if (extname(path)) return res.writeHead(404, sec).end('No encontrado');
    file = join(DIST, 'index.html'); // fallback SPA
  }
  const body = await readFile(file);
  const hashed = path.startsWith('/assets/');
  res.writeHead(200, { ...sec, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(configScript(cfg));
    }
    if (req.url === '/healthz') {
      // Saludable solo si puede atender lo esencial: necesita alcanzar la API.
      const api = await fetch(`${cfg.apiUrl}/health/live`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
      res.writeHead(api ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ status: api ? 'ok' : 'unavailable', checks: { api } }));
    }
    if (await handleBff(req, res, cfg)) return;
    if (await handleApiProxy(req, res, cfg)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    await serveStatic(req, res);
  } catch (err) {
    log('error', 'web.request_failed', { err: err.message, path: req.url?.split('?')[0] });
    if (!res.headersSent) res.writeHead(500).end('Error interno');
  }
});

server.listen(PORT, HOST, () => log('info', 'web.started', { port: PORT, api: cfg.apiUrl.replace(/\/\/[^@]*@/, '//') }));
const stop = (signal) => {
  log('info', 'web.stopping', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
