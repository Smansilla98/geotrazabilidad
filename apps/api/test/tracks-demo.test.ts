import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi, ROUTES } from '../src/openapi/openapi.js';
import { makeApp, registerUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let user: Awaited<ReturnType<typeof registerUser>>;
let devices: Array<{ id: string; name: string; isDemo: boolean; connectionState: string }>;
const auth = () => ({ Authorization: `Bearer ${user.token}` });
const range = { from: new Date(Date.now() - 3 * 86_400_000).toISOString(), to: new Date().toISOString() };

beforeAll(async () => {
  ctx = await makeApp();
  user = await registerUser(ctx, 'Demo');
  const r = await ctx.http().post('/v1/demo/load').set(auth()).send({}).expect(201);
  expect(r.body.scenarios).toHaveLength(8);
  await ctx.processor.drain();
  devices = (await ctx.http().get('/v1/devices').set(auth()).expect(200)).body;
});
afterAll(async () => ctx.close());

const byName = (n: string) => devices.find((d) => d.name.startsWith(n))!;
const trips = async () => (await ctx.http().get('/v1/trips').set(auth()).expect(200)).body as Array<{ id: string; name: string; status: string }>;

describe('demo, reconstrucción y comparación', () => {
  it('los dispositivos demo están marcados y nunca figuran conectados', () => {
    expect(devices).toHaveLength(4);
    expect(devices.every((d) => d.isDemo && d.connectionState === 'never')).toBe(true);
  });

  it('reconstruye el recorrido con la pérdida de señal como discontinuidad', async () => {
    const d = byName('Moto');
    const t = await ctx.http().get(`/v1/devices/${d.id}/track`).query(range).set(auth()).expect(200);
    const gaps = t.body.segments.filter((s: { kind: string; reason?: string }) => s.kind === 'gap' && s.reason === 'no_data');
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].durationS).toBeGreaterThanOrEqual(900);
    expect(t.body.isDemo).toBe(true);
    // Ningún segmento observado cruza el hueco.
    for (const s of t.body.segments.filter((x: { kind: string }) => x.kind === 'observed')) {
      for (let i = 1; i < s.points.length; i++) expect(s.points[i][2] - s.points[i - 1][2]).toBeLessThan(15 * 60_000);
    }
  });

  it('detecta el salto GPS del escenario impreciso y lo excluye de la línea', async () => {
    const d = byName('Celular');
    const t = await ctx.http().get(`/v1/devices/${d.id}/track`).query(range).set(auth()).expect(200);
    expect(t.body.stats.outliers).toBeGreaterThanOrEqual(1);
    const ids = new Set(t.body.segments.flatMap((s: { points?: number[][] }) => (s.points ?? []).map((p) => p[3])));
    for (const o of t.body.outliers) expect(ids.has(o.pointId)).toBe(false);
  });

  it('simplifica respetando maxPoints y conservando la referencia a cada registro', async () => {
    const d = byName('Camión');
    const full = await ctx.http().get(`/v1/devices/${d.id}/track`).query(range).set(auth()).expect(200);
    const small = await ctx.http().get(`/v1/devices/${d.id}/track`).query({ ...range, maxPoints: 100 }).set(auth()).expect(200);
    expect(small.body.stats.returnedPoints).toBeLessThanOrEqual(100);
    expect(small.body.stats.simplified).toBe(true);
    expect(small.body.stats.distanceM).toBe(full.body.stats.distanceM);
    const fullIds = new Set(full.body.segments.flatMap((s: { points?: number[][] }) => (s.points ?? []).map((p) => p[3])));
    for (const s of small.body.segments) for (const p of s.points ?? []) expect(fullIds.has(p[3])).toBe(true);
  });

  it('detecta la detención prolongada', async () => {
    const d = byName('Camioneta');
    const ev = await ctx.http().get('/v1/events').query({ deviceId: d.id, types: 'stop' }).set(auth()).expect(200);
    const long = ev.body.items.find((e: { evidence: { durationS: number } }) => e.evidence.durationS >= 2000);
    expect(long).toBeTruthy();
    expect(long.confidence).toBe('confirmed');
  });

  it('compara ruta planificada y real: desvío confirmado y llegada', async () => {
    const t = (await trips()).find((x) => x.name.startsWith('Retiro con desvío'))!;
    const c = await ctx.http().get(`/v1/trips/${t.id}/comparison`).set(auth()).expect(200);
    expect(c.body.planned.durationKind).toBe('basic_estimate');
    expect(c.body.deviations.filter((x: { status: string }) => x.status === 'confirmed')).toHaveLength(1);
    expect(c.body.deviations[0].maxOffsetM).toBeGreaterThan(300);
    expect(c.body.diff.distanceM).toBeGreaterThan(0);
    expect(c.body.arrival.reached).toBe(true);
    expect(t.status).toBe('completed');
  });

  it('un recorrido incompleto queda interrumpido, sin llegada y con avance parcial', async () => {
    const t = (await trips()).find((x) => x.name.startsWith('Segunda entrega'))!;
    expect(t.status).toBe('interrupted');
    const c = await ctx.http().get(`/v1/trips/${t.id}/comparison`).set(auth()).expect(200);
    expect(c.body.arrival.reached).toBe(false);
    expect(c.body.progress.fraction).toBeGreaterThan(0.45);
    expect(c.body.progress.fraction).toBeLessThan(0.65);
  });

  it('el viaje largo llega a destino y genera entrada a geocerca en el escenario de llegada', async () => {
    const t = (await trips()).find((x) => x.name.startsWith('Entrega en La Plata'))!;
    expect(t.status).toBe('completed');
    const ev = await ctx.http().get('/v1/events').query({ types: 'geofence_enter' }).set(auth()).expect(200);
    const names = ev.body.items.map((e: { geofenceName: string }) => e.geofenceName);
    expect(names).toContain('Depósito Barracas (DEMO)');
    expect(names).toContain('Oficina Microcentro (DEMO)');
  });

  it('exporta GPX con un trkseg por tramo continuo, y CSV/GeoJSON/KML/JSON válidos', async () => {
    const d = byName('Moto');
    const q = { deviceId: d.id, ...range };
    const gpx = await ctx.http().get('/v1/exports/track').query({ ...q, format: 'gpx' }).set(auth()).expect(200);
    expect(gpx.headers['content-type']).toContain('gpx');
    expect((gpx.text.match(/<trkseg>/g) ?? []).length).toBeGreaterThanOrEqual(3); // 2 sesiones + 1 hueco
    expect(gpx.text).toContain('DEMO');
    const csv = await ctx.http().get('/v1/exports/track').query({ ...q, format: 'csv' }).set(auth()).expect(200);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toContain('capturedAt,receivedAt,lat,lon');
    const n = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM location_points WHERE device_id = $1', [d.id]);
    expect(lines.length - 1).toBe(n!.n);
    const gj = await ctx.http().get('/v1/exports/track').query({ ...q, format: 'geojson' }).set(auth()).expect(200);
    expect(JSON.parse(gj.text).type).toBe('FeatureCollection');
    const json = await ctx.http().get('/v1/exports/track').query({ ...q, format: 'json' }).set(auth()).expect(200);
    expect(JSON.parse(json.text).points).toHaveLength(n!.n);
    const kml = await ctx.http().get('/v1/exports/track').query({ ...q, format: 'kml' }).set(auth()).expect(200);
    expect(kml.text).toContain('<gx:Track>');
    const evs = await ctx.http().get('/v1/exports/events').query({ ...range, format: 'csv' }).set(auth()).expect(200);
    expect(evs.text.split('\n')[0]).toContain('confidence');
    const audit = await ctx.db.query(`SELECT action FROM audit_log WHERE actor_user_id = $1 AND action LIKE 'export.%'`, [user.userId]);
    expect(audit.length).toBeGreaterThanOrEqual(6);
  });

  it('el dashboard usa datos reales del backend', async () => {
    const s = await ctx.http().get('/v1/stats/overview').set(auth()).expect(200);
    expect(s.body.includesDemo).toBe(true);
    expect(s.body.devices.total).toBe(4);
    expect(s.body.devices.connectedRecently).toBe(0);
    expect(s.body.distanceTotalM).toBeGreaterThan(100_000);
    expect(s.body.lastPositions).toHaveLength(4);
  });

  it('recargar la demo la reemplaza sin duplicar', async () => {
    await ctx.http().post('/v1/demo/load').set(auth()).send({}).expect(201);
    const list = (await ctx.http().get('/v1/devices').set(auth()).expect(200)).body;
    expect(list).toHaveLength(4);
    await ctx.http().delete('/v1/demo').set(auth()).expect(204);
    expect((await ctx.http().get('/v1/devices').set(auth()).expect(200)).body).toHaveLength(0);
  });
});

describe('salud y documentación', () => {
  it('readiness verifica base, PostGIS y migraciones', async () => {
    const r = await ctx.http().get('/health/ready').expect(200);
    expect(r.body.checks.postgis.ok).toBe(true);
    expect(r.body.checks.migrations.ok).toBe(true);
    await ctx.http().get('/health/live').expect(200);
  });

  it('OpenAPI documenta todas las rutas registradas en la aplicación', async () => {
    const spec = buildOpenApi() as { paths: Record<string, unknown> };
    const doc = await ctx.http().get('/v1/openapi.json').expect(200);
    expect(Object.keys(doc.body.paths).length).toBe(Object.keys(spec.paths).length);
    // Rutas reales de Express vs documentadas.
    const router = (ctx.app.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } }).router;
    const real = router.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path.replace(/:(\w+)/g, '{$1}')}`))
      .filter((r) => !r.includes('/v1/docs') && !r.includes('openapi.json'));
    const documented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const missing = real.filter((r) => !documented.has(r));
    expect(missing).toEqual([]);
  });
});
