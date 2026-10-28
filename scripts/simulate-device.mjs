#!/usr/bin/env node
// Prueba de integración de punta a punta (Etapa 5):
//   "dispositivo" (mismo SyncEngine + cola SQLite que la app móvil) → API → PostGIS → worker de
//   reglas → SSE → consulta de OTRO usuario autorizado (a través del proxy de la web si WEB_URL está definida).
//
// Uso: API_URL=http://localhost:3000 [WEB_URL=http://localhost:5173] node scripts/simulate-device.mjs
// No usa datos demo: crea usuarios y un dispositivo reales de prueba (emails *@sim.test).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { SqliteQueueStore, SyncEngine, SyncHttpError, decideCapture, INITIAL_CAPTURE_STATE, DEFAULT_TRACKING_CONFIG, CURRENT_CONSENT_VERSION } from '../packages/shared/dist/index.js';

net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WEB = process.env.WEB_URL?.replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function call(path, { method = 'GET', token, json } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${JSON.stringify(body)}`), { status: r.status, body });
  return body;
}

function sqliteDriver(path) {
  const db = new DatabaseSync(path);
  return {
    exec: async (sql) => void db.exec(sql),
    run: async (sql, p = []) => void db.prepare(sql).run(...p),
    all: async (sql, p = []) => db.prepare(sql).all(...p),
    transaction: async (fn) => {
      db.exec('BEGIN');
      try {
        const r = await fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stamp = Date.now();
  // 1. Titular (lleva el teléfono) y supervisora (viewer en la organización del titular).
  const holderEmail = `titular-${stamp}@sim.test`;
  const viewerEmail = `supervisora-${stamp}@sim.test`;
  const holder = await call('/v1/auth/register', { method: 'POST', json: { email: holderEmail, password: 'simulacion-segura-1', displayName: 'Titular Sim' } });
  const viewer = await call('/v1/auth/register', { method: 'POST', json: { email: viewerEmail, password: 'simulacion-segura-1', displayName: 'Supervisora Sim' } });
  const me = await call('/v1/me', { token: holder.accessToken });
  const orgId = me.memberships[0].orgId;
  await call(`/v1/orgs/${orgId}/members`, { method: 'POST', token: holder.accessToken, json: { email: viewerEmail, role: 'viewer' } });

  // 2. Vincular dispositivo + consentimiento compartido (como la pantalla de privacidad de la app).
  const dev = await call('/v1/devices', { method: 'POST', token: holder.accessToken, json: { installId: randomUUID(), name: 'Teléfono simulado', platform: 'android', appVersion: 'sim-1.0' } });
  await call(`/v1/devices/${dev.deviceId}/consent`, { method: 'POST', token: holder.accessToken, json: { consentVersion: CURRENT_CONSENT_VERSION, shareWithOrg: true } });

  // 3. Viaje planificado con ruta estimada en línea recta (no depende del OSRM externo).
  const origin = { lon: -58.3816, lat: -34.6037 };
  const destination = { lon: -58.3816 + 3000 / 91_600, lat: -34.6037 };
  const trip = await call('/v1/trips', { method: 'POST', token: holder.accessToken, json: { name: 'Viaje simulado', origin, destination, deviceId: dev.deviceId, arrivalRadiusM: 100 } });
  await call(`/v1/trips/${trip.id}/route`, { method: 'POST', token: holder.accessToken, json: { provider: 'straight_line' } });

  // 4. SSE de la supervisora (otro usuario) para medir la latencia hasta el aviso en la web.
  const sseBase = WEB ? `${WEB}/api` : API;
  const sseAbort = new AbortController();
  let firstNotice = null;
  void (async () => {
    const r = await fetch(`${sseBase}/v1/stream`, { headers: { Authorization: `Bearer ${viewer.accessToken}` }, signal: sseAbort.signal });
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstNotice && value.includes('event: points')) firstNotice = Date.now();
    }
  })().catch(() => {});
  await sleep(500);

  // 5. "Teléfono": captura con la misma estrategia que la app y cola SQLite persistente.
  const store = new SqliteQueueStore(sqliteDriver(join(mkdtempSync(join(tmpdir(), 'geo-sim-')), 'queue.db')));
  await store.migrate();
  let offline = false;
  const transport = {
    sendBatch: async (req) => {
      if (offline) throw new TypeError('Network request failed (simulado: sin conexión)');
      try {
        return await call('/v1/ingest/batches', { method: 'POST', token: dev.deviceToken, json: req });
      } catch (e) {
        throw new SyncHttpError(e.status ?? 0, e.body?.error?.code ?? null, e.message);
      }
    },
  };
  const engine = new SyncEngine(store, transport, { uuid: randomUUID, appVersion: 'sim-1.0', batchSize: 100 });
  const sessionId = randomUUID();
  const params = DEFAULT_TRACKING_CONFIG.trip;
  const start = Date.now() - 20 * 60_000;
  await store.startSession({ id: sessionId, startedAt: start - 1000, mode: 'trip', tripId: trip.id, configSnapshot: { ...params, mode: 'trip' } });

  let state = INITIAL_CAPTURE_STATE;
  let fixes = 0;
  let kept = 0;
  // Recorre 3 km hacia el este a ~10 m/s (fix cada 2 s) y luego permanece 3 min en el destino.
  for (let t = 0; t <= 300 + 180; t += 2) {
    const along = Math.min(3000, t * 10);
    const fix = { t: start + t * 1000, lat: origin.lat + ((t % 7) - 3) * 0.000003, lon: origin.lon + along / 91_600, accuracy: 6 + (t % 5), speed: along < 3000 ? 10 : 0, heading: 90 };
    fixes++;
    const d = decideCapture(state, fix, params);
    state = d.state;
    if (!d.keep) continue;
    kept++;
    await store.enqueuePoint({ id: randomUUID(), sessionId, capturedAt: fix.t, lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, altitude: null, altitudeAccuracy: null, speed: fix.speed, heading: fix.heading, source: 'fused', mocked: false, battery: 0.8 });
    // A mitad de camino se corta la conexión: los envíos fallan y la cola crece.
    if (t === 100) offline = true;
    if (t === 220) offline = false;
    if (t % 40 === 0) await engine.syncOnce();
  }
  check('la estrategia de captura no guarda cada fix', kept < fixes / 2, `${kept} de ${fixes} fixes conservados`);
  const pendingAfterOutage = (await store.stats()).pending;
  check('durante el corte los puntos quedaron en la cola local', pendingAfterOutage > 0, `${pendingAfterOutage} pendientes antes de vaciar`);

  await store.endSession(sessionId, start + 490_000, 'trip_completed');
  const sendStarted = Date.now();
  const out = await engine.drain();
  check('al volver la conexión se sincroniza todo', out.kind === 'sent' || out.kind === 'idle', JSON.stringify(out));
  check('no queda nada pendiente en el teléfono', (await store.stats()).pending === 0);

  const n1 = (await call(`/v1/devices/${dev.deviceId}/points?${new URLSearchParams({ from: new Date(start - 60_000).toISOString(), to: new Date().toISOString(), limit: '5000' })}`, { token: holder.accessToken })).items.length;
  check('el servidor recibió exactamente los puntos conservados', n1 === kept, `${n1} en servidor / ${kept} capturados`);

  // 6. Esperar el procesamiento de eventos (worker en la API).
  let events = [];
  for (let i = 0; i < 40; i++) {
    events = (await call(`/v1/events?${new URLSearchParams({ deviceId: dev.deviceId, limit: '200' })}`, { token: viewer.accessToken })).items;
    if (events.some((e) => e.type === 'trip_completed')) break;
    await sleep(500);
  }
  const types = new Set(events.map((e) => e.type));
  check('se detectó el inicio del viaje', types.has('trip_started'));
  check('se detectó la llegada y el fin del viaje', types.has('arrival') && types.has('trip_completed'));
  check('la supervisora ve los eventos (otro usuario autorizado)', events.length > 0, `${events.length} eventos`);

  // 7. La supervisora consulta el recorrido (vía proxy de la web si está configurada).
  const viewBase = WEB ? `${WEB}/api` : API;
  const tr = await fetch(`${viewBase}/v1/devices/${dev.deviceId}/track?${new URLSearchParams({ from: new Date(start - 60_000).toISOString(), to: new Date().toISOString() })}`, { headers: { Authorization: `Bearer ${viewer.accessToken}` } }).then((r) => r.json());
  check('la supervisora reconstruye el recorrido', tr.stats?.observedPoints === kept, `${tr.stats?.observedPoints} puntos, ${Math.round(tr.stats?.distanceM ?? 0)} m${WEB ? ' (vía web)' : ''}`);
  const cmp = await call(`/v1/trips/${trip.id}/comparison`, { token: viewer.accessToken });
  check('la comparación distingue estimado de observado', cmp.planned?.durationKind === 'basic_estimate' && cmp.arrival.reached, `planificado ${Math.round(cmp.planned.distanceM)} m / observado ${cmp.observed.distanceM} m`);

  // 8. Latencia del aviso en tiempo real.
  check('aviso en tiempo real recibido por SSE', firstNotice !== null, firstNotice ? `primer aviso tras ${Math.max(0, firstNotice - sendStarted)} ms del envío final (o antes, por envíos previos)` : 'sin aviso');

  // 9. Un usuario ajeno no ve nada.
  const stranger = await call('/v1/auth/register', { method: 'POST', json: { email: `ajeno-${stamp}@sim.test`, password: 'simulacion-segura-1', displayName: 'Ajeno' } });
  const denied = await fetch(`${API}/v1/devices/${dev.deviceId}/track?from=${new Date(start).toISOString()}&to=${new Date().toISOString()}`, { headers: { Authorization: `Bearer ${stranger.accessToken}` } });
  check('un usuario ajeno recibe 404', denied.status === 404);

  sseAbort.abort();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} verificaciones correctas`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('✘ error inesperado:', e.message);
  process.exit(1);
});
