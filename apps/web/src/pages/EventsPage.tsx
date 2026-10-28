import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { EventConfidence, EventType, type DeviceSummary, type TrackingEventDto } from '@geo/shared';
import { api, download } from '../lib/api';
import { CONFIDENCE_LABEL, EVENT_COLOR, EVENT_LABEL, fmtDateTime, fmtDuration, fromLocalInput, toLocalInput } from '../lib/format';
import { DemoBadge, ErrorBox } from '../App';

export function EventsPage() {
  const [deviceId, setDeviceId] = useState('');
  const [type, setType] = useState('');
  const [confidence, setConfidence] = useState('');
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86_400_000).toISOString());
  const [to, setTo] = useState(new Date().toISOString());
  const [err, setErr] = useState<unknown>(null);
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceSummary[]>('/v1/devices') });
  const q = useInfiniteQuery({
    queryKey: ['events', 'list', deviceId, type, confidence, from, to],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ items: TrackingEventDto[]; nextCursor: string | null }>(
        `/v1/events?${new URLSearchParams({ from, to, limit: '100', ...(deviceId && { deviceId }), ...(type && { types: type }), ...(confidence && { confidence }), ...(pageParam && { cursor: pageParam }) })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const mapLink = (e: TrackingEventDto) =>
    `/map?${new URLSearchParams({ device: e.deviceId, event: e.id, from: new Date(Date.parse(e.occurredAt) - 3 * 3600_000).toISOString(), to: new Date(Date.parse(e.endedAt ?? e.occurredAt) + 3 * 3600_000).toISOString() })}`;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Historial de eventos</h1>
        <button
          className="btn small"
          onClick={() =>
            download(`/v1/exports/events?${new URLSearchParams({ from, to, format: 'csv', ...(deviceId && { deviceId }) })}`, 'eventos.csv').catch(setErr)
          }
        >
          Exportar CSV
        </button>
        <button className="btn small" onClick={() => download(`/v1/exports/events?${new URLSearchParams({ from, to, format: 'json', ...(deviceId && { deviceId }) })}`, 'eventos.json').catch(setErr)}>
          Exportar JSON
        </button>
      </div>
      <p className="muted small">
        Los eventos son <strong>inferencias</strong> del servidor a partir de las posiciones observadas. Cada uno indica la regla que lo produjo, su nivel de confianza y la evidencia usada.
      </p>
      <div className="toolbar">
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Dispositivo">
          <option value="">Todos los dispositivos</option>
          {devices.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {EventType.options.map((t) => (
            <option key={t} value={t}>
              {EVENT_LABEL[t]}
            </option>
          ))}
        </select>
        <select value={confidence} onChange={(e) => setConfidence(e.target.value)} aria-label="Confianza">
          <option value="">Toda confianza</option>
          {EventConfidence.options.map((c) => (
            <option key={c} value={c}>
              {CONFIDENCE_LABEL[c]}
            </option>
          ))}
        </select>
        <input type="datetime-local" value={toLocalInput(new Date(from))} onChange={(e) => e.target.value && setFrom(fromLocalInput(e.target.value))} aria-label="Desde" />
        <input type="datetime-local" value={toLocalInput(new Date(to))} onChange={(e) => e.target.value && setTo(fromLocalInput(e.target.value))} aria-label="Hasta" />
      </div>
      <ErrorBox error={q.error ?? err} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Fecha y hora</th>
              <th>Tipo</th>
              <th>Dispositivo</th>
              <th>Confianza</th>
              <th>Zona / viaje</th>
              <th>Detalle</th>
              <th>Fuente</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.occurredAt)}</td>
                <td>
                  <span className="dot" style={{ background: EVENT_COLOR[e.type] }} /> {EVENT_LABEL[e.type]}
                </td>
                <td>
                  {e.deviceName} {e.isDemo && <DemoBadge />}
                </td>
                <td>
                  <span className={`badge conf-${e.confidence}`}>{CONFIDENCE_LABEL[e.confidence]}</span>
                </td>
                <td>{e.geofenceName ?? (e.tripName ? <Link to={`/trips/${e.tripId}`}>{e.tripName}</Link> : '—')}</td>
                <td className="small">{eventSummary(e)}</td>
                <td className="small muted">
                  {e.ruleId} v{e.ruleVersion}
                </td>
                <td>
                  <Link to={mapLink(e)} className="btn small ghost">
                    Ver en mapa
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && !q.isLoading && <p className="muted">No hay eventos con esos filtros.</p>}
      </div>
      {q.hasNextPage && (
        <button className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          Cargar más
        </button>
      )}
    </div>
  );
}

function eventSummary(e: TrackingEventDto) {
  const ev = e.evidence as Record<string, number | string | boolean>;
  switch (e.type) {
    case 'stop':
      return `${fmtDuration(Number(ev.durationS))}${ev.ongoing ? ' (en curso)' : ''}`;
    case 'signal_gap':
      return `${fmtDuration(Number(ev.durationS))} sin datos · ${String(ev.interpretation ?? '')}`;
    case 'route_deviation':
      return `hasta ${ev.maxOffsetM} m fuera de la ruta · ${fmtDuration(Number(ev.durationS))}`;
    case 'geofence_enter':
    case 'geofence_exit':
      return `permanencia ${fmtDuration(Number(ev.dwellS))} · ${ev.pointCount} puntos`;
    default:
      return e.endedAt ? `hasta ${fmtDateTime(e.endedAt)}` : '';
  }
}
