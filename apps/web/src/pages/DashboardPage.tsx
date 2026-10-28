import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Marker } from 'react-map-gl/maplibre';
import type { StatsOverview } from '@geo/shared';
import { api } from '../lib/api';
import { CONFIDENCE_LABEL, CONNECTION_LABEL, EVENT_COLOR, EVENT_LABEL, fmtAgo, fmtDateTime, fmtDistance } from '../lib/format';
import { MapBase } from '../components/MapBase';
import { DemoBadge, ErrorBox, usePrimaryOrg } from '../App';

export function DashboardPage() {
  const qc = useQueryClient();
  const { canWrite } = usePrimaryOrg();
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<StatsOverview>('/v1/stats/overview'), refetchInterval: 60_000 });
  const demo = useMutation({
    mutationFn: () => api<{ points: number }>('/v1/demo/load', { method: 'POST', json: {} }),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries(), 1500),
  });
  const s = stats.data;

  if (s && s.devices.total === 0) {
    return (
      <div className="page">
        <h1>Panel</h1>
        <div className="empty-state">
          <h2>Todavía no hay datos de ubicación</h2>
          <ol>
            <li>Instalá la app móvil, iniciá sesión con esta cuenta y vinculá el teléfono.</li>
            <li>En la app, aceptá el consentimiento de privacidad y otorgá el permiso de ubicación.</li>
            <li>Iniciá un seguimiento: las posiciones se guardan en el teléfono y se sincronizan cuando hay conexión.</li>
          </ol>
          <p className="muted">También podés explorar la plataforma con recorridos sintéticos, identificados en todo momento como DEMO y separados de los datos reales.</p>
          {canWrite && (
            <button className="btn primary" onClick={() => demo.mutate()} disabled={demo.isPending}>
              {demo.isPending ? 'Cargando demo…' : 'Cargar datos de demostración'}
            </button>
          )}
          <ErrorBox error={demo.error} />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Panel</h1>
        {s?.includesDemo && (
          <span className="muted small">
            <DemoBadge /> Incluye dispositivos de demostración
          </span>
        )}
        <span className="muted small">Actualizado {s ? fmtAgo(s.generatedAt) : '…'}</span>
      </div>
      <ErrorBox error={stats.error} />
      <div className="kpis">
        <Kpi label="Dispositivos" value={s?.devices.total} sub={`${s?.devices.active ?? 0} activos · ${s?.devices.revoked ?? 0} revocados`} />
        <Kpi label="Conectados (15 min)" value={s?.devices.connectedRecently} sub="contacto real con el servidor" />
        <Kpi label="Seguimientos activos" value={s?.activeSessions} sub={`${s?.sessionsTotal ?? 0} recorridos en total`} />
        <Kpi label="Viajes en curso" value={s?.tripsInProgress} />
        <Kpi label="Distancia registrada" value={s ? fmtDistance(s.distanceTotalM) : undefined} sub={`${s?.pointsTotal ?? 0} posiciones`} />
        <Kpi label="Eventos (24 h)" value={s?.eventsLast24h} />
        <Kpi label="Sync pendiente" value={s?.devices.withPendingSync} sub="dispositivos con cola local" warn={!!s?.devices.withPendingSync} />
      </div>
      <div className="grid-2">
        <section className="panel">
          <h2>Última posición por dispositivo</h2>
          <div className="mini-map">
            <MapBase initial={s?.lastPositions[0] ? { lon: s.lastPositions[0].lon, lat: s.lastPositions[0].lat, zoom: 10 } : undefined}>
              {s?.lastPositions.map((p) => (
                <Marker key={p.deviceId} longitude={p.lon} latitude={p.lat} anchor="bottom">
                  <Link to={`/map?device=${p.deviceId}`} className={`pin conn-${p.connectionState}`} title={`${p.deviceName} · ${fmtDateTime(p.capturedAt)}`}>
                    {p.deviceName.slice(0, 1)}
                  </Link>
                </Marker>
              ))}
            </MapBase>
          </div>
          <table className="table small">
            <thead>
              <tr>
                <th>Dispositivo</th>
                <th>Estado</th>
                <th>Capturada</th>
                <th>Recibida</th>
              </tr>
            </thead>
            <tbody>
              {s?.lastPositions.map((p) => (
                <tr key={p.deviceId}>
                  <td>
                    <Link to={`/map?device=${p.deviceId}`}>{p.deviceName}</Link> {p.isDemo && <DemoBadge />}
                  </td>
                  <td>
                    <span className={`badge conn-${p.connectionState}`} title={CONNECTION_LABEL[p.connectionState].help}>
                      {CONNECTION_LABEL[p.connectionState].label}
                    </span>
                  </td>
                  <td>{fmtDateTime(p.capturedAt)}</td>
                  <td>{fmtDateTime(p.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>Eventos recientes</h2>
          <ol className="event-list">
            {s?.recentEvents.map((e) => (
              <li key={e.id}>
                <span className="dot" style={{ background: EVENT_COLOR[e.type] }} />
                <span>
                  <Link to={`/map?device=${e.deviceId}&event=${e.id}&from=${new Date(Date.parse(e.occurredAt) - 3 * 3600_000).toISOString()}&to=${new Date(Date.parse(e.occurredAt) + 3 * 3600_000).toISOString()}`}>
                    {EVENT_LABEL[e.type]}
                  </Link>{' '}
                  · {e.deviceName} {e.isDemo && <DemoBadge />}
                  <br />
                  <span className="muted small">
                    {fmtDateTime(e.occurredAt)} · {CONFIDENCE_LABEL[e.confidence]}
                    {e.geofenceName ? ` · ${e.geofenceName}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {!s?.recentEvents.length && <p className="muted">Sin eventos todavía.</p>}
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, warn }: { label: string; value: number | string | undefined; sub?: string; warn?: boolean }) {
  return (
    <div className={`kpi ${warn ? 'warn' : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value ?? '—'}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
