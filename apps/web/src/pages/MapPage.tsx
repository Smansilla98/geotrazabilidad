import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { Layer, Marker, Source, type MapLayerMouseEvent, type MapRef } from 'react-map-gl/maplibre';
import type { DeviceSummary, EventType, GeofenceDto, TrackResponse, TrackingEventDto, TripDto } from '@geo/shared';
import { EventType as EventTypeEnum } from '@geo/shared';
import { api, download } from '../lib/api';
import { CONFIDENCE_LABEL, CONNECTION_LABEL, EVENT_COLOR, EVENT_LABEL, fmtAgo, fmtDateTime, fmtDistance, fmtDuration, fmtSpeed, fromLocalInput, toLocalInput, TZ } from '../lib/format';
import { bboxOf, flattenTrack, positionAt, type FlatPoint } from '../lib/geojson';
import { MapBase } from '../components/MapBase';
import { INTERACTIVE_LAYERS, MapLegend, TrackLayers, type LayerToggles } from '../components/TrackLayers';
import { Timeline } from '../components/Timeline';
import { DemoBadge, ErrorBox } from '../App';

type Selection =
  | { kind: 'point'; point: FlatPoint }
  | { kind: 'event'; event: TrackingEventDto }
  | { kind: 'gap'; props: Record<string, unknown> }
  | { kind: 'outlier'; id: number; at: string }
  | null;

const PRESETS = [
  { label: 'Últimas 6 h', ms: 6 * 3600_000 },
  { label: '24 h', ms: 86_400_000 },
  { label: '3 días', ms: 3 * 86_400_000 },
  { label: '7 días', ms: 7 * 86_400_000 },
];

export function MapPage() {
  const [params, setParams] = useSearchParams();
  const mapRef = useRef<MapRef>(null);
  const deviceId = params.get('device');
  const to = params.get('to') ?? new Date(Math.ceil(Date.now() / 60_000) * 60_000).toISOString();
  const from = params.get('from') ?? new Date(Date.parse(to) - 2 * 86_400_000).toISOString();
  const focusEventId = params.get('event');
  const tripId = params.get('trip');
  const [types, setTypes] = useState<Set<EventType>>(new Set(EventTypeEnum.options.filter((t) => t !== 'heading_change')));
  const [toggles, setToggles] = useState<LayerToggles>({ points: true, events: true, geofences: true, planned: true });
  const [selection, setSelection] = useState<Selection>(null);
  const [t, setT] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [exportError, setExportError] = useState<unknown>(null);

  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };

  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceSummary[]>('/v1/devices') });
  const device = devices.data?.find((d) => d.id === deviceId);
  useEffect(() => {
    if (!deviceId && devices.data?.length) set({ device: devices.data[0]!.id });
  }, [deviceId, devices.data]);

  const trackQ = useQuery({
    queryKey: ['track', deviceId, from, to, tripId],
    enabled: !!deviceId,
    queryFn: () => api<TrackResponse>(`/v1/devices/${deviceId}/track?${new URLSearchParams({ from, to, maxPoints: '8000', ...(tripId ? { tripId } : {}) })}`),
  });
  const eventsQ = useQuery({
    queryKey: ['events', deviceId, from, to],
    enabled: !!deviceId,
    queryFn: () => api<{ items: TrackingEventDto[] }>(`/v1/events?${new URLSearchParams({ deviceId: deviceId!, from, to, limit: '500' })}`),
  });
  const geofences = useQuery({ queryKey: ['geofences'], queryFn: () => api<GeofenceDto[]>('/v1/geofences') });
  const trip = useQuery({ queryKey: ['trip', tripId], enabled: !!tripId, queryFn: () => api<TripDto>(`/v1/trips/${tripId}`) });

  const flat = useMemo(() => flattenTrack(trackQ.data), [trackQ.data]);
  const events = useMemo(() => (eventsQ.data?.items ?? []).filter((e) => types.has(e.type)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)), [eventsQ.data, types]);
  const pos = t != null ? positionAt(flat, t) : null;

  const fit = useCallback(() => {
    const coords = flat.map((p) => [p.lon, p.lat] as [number, number]);
    const b = bboxOf(coords);
    if (b) mapRef.current?.fitBounds(b, { padding: 60, duration: 600 });
  }, [flat]);

  // Encuadre automático al cargar un recorrido nuevo; o centrado en el evento pedido por URL.
  useEffect(() => {
    if (!flat.length) return;
    setT(flat[0]!.t);
    const ev = focusEventId ? eventsQ.data?.items.find((e) => e.id === focusEventId) : null;
    if (ev) selectEvent(ev);
    else fit();
  }, [trackQ.data, eventsQ.data?.items.length]);

  useEffect(() => {
    if (pos && follow && t != null && flat.length && t > flat[0]!.t) mapRef.current?.easeTo({ center: [pos.lon, pos.lat], duration: 0 });
  }, [t]);

  function selectEvent(e: TrackingEventDto) {
    setSelection({ kind: 'event', event: e });
    setT(Date.parse(e.occurredAt));
    setFollow(false);
    if (e.lat != null && e.lon != null) mapRef.current?.flyTo({ center: [e.lon, e.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 700 });
  }

  const onMapClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return setSelection(null);
    const p = f.properties as Record<string, unknown>;
    if (f.layer.id === 'event-points') {
      const ev = eventsQ.data?.items.find((x) => x.id === p.id);
      if (ev) selectEvent(ev);
    } else if (f.layer.id === 'track-points') {
      const pt = flat.find((x) => x.id === p.id);
      if (pt) {
        setSelection({ kind: 'point', point: pt });
        setT(pt.t);
      }
    } else if (f.layer.id === 'gap-ends') setSelection({ kind: 'gap', props: p });
    else if (f.layer.id === 'outlier-points') setSelection({ kind: 'outlier', id: Number(p.id), at: String(p.at) });
  };

  const exportAs = async (format: string) => {
    setExportError(null);
    try {
      await download(`/v1/exports/track?${new URLSearchParams({ deviceId: deviceId!, from, to, format })}`, `recorrido.${format}`);
    } catch (e) {
      setExportError(e);
    }
  };

  if (devices.data && !devices.data.length) {
    return (
      <div className="page">
        <h1>Mapa y recorridos</h1>
        <div className="empty-state">
          <p>Todavía no hay dispositivos visibles para tu usuario.</p>
          <p>
            Vinculá un teléfono desde la app móvil o cargá los datos de demostración en el <Link to="/">panel</Link>.
          </p>
        </div>
      </div>
    );
  }

  const stats = trackQ.data?.stats;
  return (
    <div className="map-page">
      <aside className="filters panel">
        <h2>Filtros</h2>
        <label>
          Dispositivo
          <select value={deviceId ?? ''} onChange={(e) => (set({ device: e.target.value, event: null, trip: null }), setSelection(null))}>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.status === 'revoked' ? ' (revocado)' : ''}
              </option>
            ))}
          </select>
        </label>
        {device && (
          <div className="device-mini">
            {device.isDemo && <DemoBadge />} <span className={`badge conn-${device.connectionState}`}>{CONNECTION_LABEL[device.connectionState].label}</span>
            <div className="muted small">Último contacto: {fmtAgo(device.lastContactAt)}</div>
            {device.lastPoint && <div className="muted small">Última posición recibida: {fmtDateTime(device.lastPoint.receivedAt)}</div>}
          </div>
        )}
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.label} className="btn small ghost" onClick={() => set({ from: new Date(Date.now() - p.ms).toISOString(), to: new Date().toISOString(), event: null })}>
              {p.label}
            </button>
          ))}
        </div>
        <label>
          Desde
          <input type="datetime-local" value={toLocalInput(new Date(from))} onChange={(e) => e.target.value && set({ from: fromLocalInput(e.target.value) })} />
        </label>
        <label>
          Hasta
          <input type="datetime-local" value={toLocalInput(new Date(to))} onChange={(e) => e.target.value && set({ to: fromLocalInput(e.target.value) })} />
        </label>
        <div className="muted small">Zona horaria: {TZ}. Los datos se almacenan en UTC.</div>
        {tripId && trip.data && (
          <div className="alert info small">
            Viaje: <Link to={`/trips/${tripId}`}>{trip.data.name}</Link>{' '}
            <button className="link" onClick={() => set({ trip: null })}>
              quitar filtro
            </button>
          </div>
        )}
        <fieldset>
          <legend>Capas</legend>
          {(['points', 'events', 'geofences', 'planned'] as const).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={toggles[k]} onChange={(e) => setToggles({ ...toggles, [k]: e.target.checked })} />
              {{ points: 'Puntos (calidad)', events: 'Eventos', geofences: 'Geocercas', planned: 'Ruta planificada' }[k]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Tipos de evento</legend>
          {EventTypeEnum.options.map((ty) => (
            <label key={ty} className="check">
              <input
                type="checkbox"
                checked={types.has(ty)}
                onChange={(e) => {
                  const n = new Set(types);
                  if (e.target.checked) n.add(ty);
                  else n.delete(ty);
                  setTypes(n);
                }}
              />
              <span className="dot" style={{ background: EVENT_COLOR[ty] }} /> {EVENT_LABEL[ty]}
            </label>
          ))}
        </fieldset>
      </aside>

      <section className="map-area">
        <MapBase ref={mapRef} interactiveLayerIds={INTERACTIVE_LAYERS} onClick={onMapClick} onLoad={fit}>
          <TrackLayers
            track={trackQ.data}
            events={events}
            geofences={geofences.data ?? []}
            planned={trip.data?.route?.coordinates}
            toggles={toggles}
            highlightEventId={selection?.kind === 'event' ? selection.event.id : null}
          />
          {pos && (
            <Marker longitude={pos.lon} latitude={pos.lat} anchor="center">
              <div className={`player-marker ${pos.interpolated ? 'interp' : ''} ${pos.inGap ? 'gap' : ''}`} title={pos.inGap ? 'Sin datos en este momento: última posición conocida' : pos.interpolated ? 'Posición interpolada (no registrada)' : 'Posición registrada'} />
            </Marker>
          )}
          {selection?.kind === 'event' && selection.event.type === 'route_deviation' && selection.event.lat != null && (
            <Source id="sel" type="geojson" data={{ type: 'Feature', geometry: { type: 'Point', coordinates: [selection.event.lon!, selection.event.lat] }, properties: {} }}>
              <Layer id="sel-ring" type="circle" paint={{ 'circle-radius': 18, 'circle-color': 'transparent', 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 2 }} />
            </Source>
          )}
        </MapBase>
        <div className="map-tools">
          <button className="btn small" onClick={fit} disabled={!flat.length}>
            Encuadrar recorrido
          </button>
          <button
            className="btn small"
            disabled={!device?.lastPoint}
            onClick={() => device?.lastPoint && mapRef.current?.flyTo({ center: [device.lastPoint.lon, device.lastPoint.lat], zoom: 16 })}
          >
            Centrar en última posición
          </button>
          <label className="check small">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Seguir reproducción
          </label>
        </div>
        <MapLegend showPlanned={!!trip.data?.route} />
        {(trackQ.isFetching || eventsQ.isFetching) && <div className="map-loading">Cargando…</div>}
        {pos?.inGap && <div className="map-banner">Sin datos registrados en este momento: se muestra la última posición conocida.</div>}
        {pos?.interpolated && <div className="map-banner subtle">Posición interpolada entre dos registros (no capturada por el dispositivo).</div>}
      </section>

      <aside className="details panel">
        <ErrorBox error={trackQ.error ?? eventsQ.error ?? exportError} />
        {trackQ.data?.isDemo && (
          <div className="alert demo small">
            <DemoBadge /> Recorrido sintético de demostración.
          </div>
        )}
        <h2>Resumen</h2>
        {stats ? (
          <dl className="kv">
            <dt>Distancia observada</dt>
            <dd title="Suma de tramos con datos; los huecos no se cuentan">{fmtDistance(stats.distanceM)}</dd>
            <dt>Duración</dt>
            <dd>{fmtDuration(stats.durationS)}</dd>
            <dt>Puntos</dt>
            <dd>
              {stats.returnedPoints} de {stats.observedPoints}
              {stats.simplified ? ' (simplificado)' : ''}
            </dd>
            <dt>Huecos sin datos</dt>
            <dd>{stats.gaps}</dd>
            <dt>Saltos descartados</dt>
            <dd>{stats.outliers}</dd>
            <dt>Velocidad máx. registrada</dt>
            <dd>{fmtSpeed(stats.maxSpeedMps)}</dd>
          </dl>
        ) : (
          <p className="muted">{deviceId ? 'Sin datos todavía.' : 'Elegí un dispositivo.'}</p>
        )}
        {trackQ.data?.truncated && <div className="alert warn small">El rango tiene demasiados puntos: se muestran los primeros 100.000. Acortá el rango.</div>}
        <SelectionDetail selection={selection} />
        <h2>Eventos ({events.length})</h2>
        <ol className="event-list compact">
          {events.map((e) => (
            <li key={e.id} className={selection?.kind === 'event' && selection.event.id === e.id ? 'selected' : ''} onClick={() => selectEvent(e)}>
              <span className="dot" style={{ background: EVENT_COLOR[e.type] }} />
              <span>
                <strong>{EVENT_LABEL[e.type]}</strong>
                {e.geofenceName ? ` · ${e.geofenceName}` : ''}
                <br />
                <span className="muted small">
                  {fmtDateTime(e.occurredAt)} · {CONFIDENCE_LABEL[e.confidence]}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <h2>Exportar</h2>
        <div className="row wrap">
          {['csv', 'json', 'geojson', 'gpx', 'kml'].map((f) => (
            <button key={f} className="btn small" disabled={!deviceId} onClick={() => void exportAs(f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </aside>

      <section className="timeline-area panel">
        <Timeline track={trackQ.data} flat={flat} events={events} t={t} setT={(v) => setT(v)} onSelectEvent={selectEvent} />
      </section>
    </div>
  );
}

function SelectionDetail({ selection }: { selection: Selection }) {
  if (!selection) return <p className="muted small">Hacé clic en un punto, evento o hueco del mapa para ver su detalle.</p>;
  if (selection.kind === 'point') {
    const p = selection.point;
    return (
      <div className="card">
        <h3>Posición registrada #{p.id}</h3>
        <dl className="kv">
          <dt>Capturada</dt>
          <dd>{fmtDateTime(p.t)}</dd>
          <dt>Precisión</dt>
          <dd>{p.accuracy == null ? 'no informada' : `±${Math.round(p.accuracy)} m`}</dd>
          <dt>Velocidad</dt>
          <dd>{fmtSpeed(p.speed)}</dd>
          <dt>Coordenadas</dt>
          <dd>
            {p.lat.toFixed(6)}, {p.lon.toFixed(6)}
          </dd>
          <dt>Marcas de calidad</dt>
          <dd>{p.flags.length ? p.flags.join(', ') : 'ninguna'}</dd>
        </dl>
      </div>
    );
  }
  if (selection.kind === 'gap') {
    const g = selection.props;
    return (
      <div className="card">
        <h3>Discontinuidad</h3>
        <p className="small">
          {g.reason === 'session_boundary' ? 'Cambio de sesión de seguimiento (el seguimiento estuvo detenido).' : g.reason === 'implausible_jump' ? 'Desplazamiento inverosímil entre registros: no se une con una línea.' : 'No hay posiciones registradas en este intervalo: el trayecto intermedio es desconocido.'}
        </p>
        <dl className="kv">
          <dt>Desde</dt>
          <dd>{fmtDateTime(String(g.startAt))}</dd>
          <dt>Hasta</dt>
          <dd>{fmtDateTime(String(g.endAt))}</dd>
          <dt>Duración</dt>
          <dd>{fmtDuration(Number(g.durationS))}</dd>
          <dt>Distancia en línea recta</dt>
          <dd>{fmtDistance(Number(g.distanceM))}</dd>
        </dl>
      </div>
    );
  }
  if (selection.kind === 'outlier') {
    return (
      <div className="card">
        <h3>Salto GPS descartado #{selection.id}</h3>
        <p className="small">El registro original se conserva, pero se excluye de la línea del recorrido por implicar una velocidad inverosímil respecto de los puntos vecinos.</p>
        <p className="muted small">{fmtDateTime(selection.at)}</p>
      </div>
    );
  }
  const e = selection.event;
  return (
    <div className="card">
      <h3>
        <span className="dot" style={{ background: EVENT_COLOR[e.type] }} /> {EVENT_LABEL[e.type]}
      </h3>
      <dl className="kv">
        <dt>Momento</dt>
        <dd>
          {fmtDateTime(e.occurredAt)}
          {e.endedAt ? ` → ${fmtDateTime(e.endedAt)}` : e.type === 'stop' ? ' (en curso)' : ''}
        </dd>
        <dt>Confianza</dt>
        <dd>
          <span className={`badge conf-${e.confidence}`}>{CONFIDENCE_LABEL[e.confidence]}</span>
        </dd>
        {e.geofenceName && (
          <>
            <dt>Zona</dt>
            <dd>{e.geofenceName}</dd>
          </>
        )}
        {e.tripName && (
          <>
            <dt>Viaje</dt>
            <dd>
              <Link to={`/trips/${e.tripId}`}>{e.tripName}</Link>
            </dd>
          </>
        )}
        <dt>Regla</dt>
        <dd>
          {e.ruleId} (v{e.ruleVersion}) · {e.source === 'server_rules' ? 'inferido por el servidor' : e.source}
        </dd>
      </dl>
      <details>
        <summary>Evidencia y parámetros (auditoría)</summary>
        <pre className="json">{JSON.stringify({ evidence: e.evidence, ruleParams: e.ruleParams }, null, 2)}</pre>
      </details>
    </div>
  );
}
