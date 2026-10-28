import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Layer, Marker, Source, type MapRef } from 'react-map-gl/maplibre';
import type { TrackResponse, TripComparison, TripDto } from '@geo/shared';
import { api } from '../lib/api';
import { CONFIDENCE_LABEL, fmtDateTime, fmtDistance, fmtDuration, STATUS_LABEL } from '../lib/format';
import { bboxOf, lineLayer, trackLayers } from '../lib/geojson';
import { MapBase } from '../components/MapBase';
import { ErrorBox, usePrimaryOrg } from '../App';

const DEV_LABEL = { confirmed: 'Desvío confirmado', possible: 'Posible desvío', imprecise: 'Posición imprecisa', insufficient_data: 'Datos insuficientes' } as const;
const KIND_LABEL: Record<string, string> = {
  provider_no_traffic: 'proveedor de rutas, sin tráfico',
  provider_with_traffic: 'proveedor de rutas, con tráfico',
  basic_estimate: 'estimación básica',
};

export function TripDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { canWrite } = usePrimaryOrg();
  const mapRef = useRef<MapRef>(null);
  const [profile, setProfile] = useState('driving');
  const trip = useQuery({ queryKey: ['trips', id], queryFn: () => api<TripDto>(`/v1/trips/${id}`) });
  const cmp = useQuery({ queryKey: ['trips', id, 'comparison'], queryFn: () => api<TripComparison>(`/v1/trips/${id}/comparison`) });
  const t = trip.data;
  const range = t && cmp.data?.observed.startedAt ? { from: new Date(Date.parse(cmp.data.observed.startedAt) - 60_000).toISOString(), to: new Date(Date.parse(cmp.data.observed.endedAt!) + 60_000).toISOString() } : null;
  const track = useQuery({
    queryKey: ['track', t?.deviceId, 'trip', id, range?.from],
    enabled: !!t?.deviceId && !!range,
    queryFn: () => api<TrackResponse>(`/v1/devices/${t!.deviceId}/track?${new URLSearchParams({ ...range!, tripId: id! })}`),
  });
  const route = useMutation({
    mutationFn: (provider: 'configured' | 'straight_line') => api<TripDto>(`/v1/trips/${id}/route`, { method: 'POST', json: { profile, provider } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trips'] });
      // El reprocesamiento de desvíos es asíncrono: se vuelve a consultar en breve.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['trips', id] }), 2500);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api(`/v1/trips/${id}`, { method: 'PATCH', json: { status: 'cancelled' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['trips'] }),
  });

  const layers = useMemo(() => trackLayers(track.data), [track.data]);
  const fitTrip = () => {
    const coords: [number, number][] = [...(t?.route?.coordinates ?? []), ...(t ? [[t.origin.lon, t.origin.lat] as [number, number], [t.destination.lon, t.destination.lat] as [number, number]] : [])];
    const b = bboxOf(coords);
    if (b) mapRef.current?.fitBounds(b, { padding: 60, duration: 0 });
  };
  useEffect(() => {
    const coords: [number, number][] = [...(t?.route?.coordinates ?? []), ...(t ? [[t.origin.lon, t.origin.lat] as [number, number], [t.destination.lon, t.destination.lat] as [number, number]] : [])];
    const b = bboxOf(coords);
    if (b) setTimeout(() => mapRef.current?.fitBounds(b, { padding: 60, duration: 0 }), 300);
  }, [t]);

  if (!t) return <div className="page">{trip.error ? <ErrorBox error={trip.error} /> : 'Cargando…'}</div>;
  const c = cmp.data;
  const deviationPoints = new Set<number>();
  c?.deviations.forEach((d) => (deviationPoints.add(d.startPointId), deviationPoints.add(d.endPointId)));

  return (
    <div className="page trip-detail">
      <div className="page-head">
        <h1>{t.name}</h1>
        <span className={`badge status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
        {t.deviceId && (
          <Link className="btn small ghost" to={`/map?device=${t.deviceId}&trip=${t.id}${range ? `&from=${range.from}&to=${range.to}` : ''}`}>
            Abrir en el reproductor
          </Link>
        )}
        {canWrite && (t.status === 'planned' || t.status === 'in_progress') && (
          <button className="btn small ghost" onClick={() => cancel.mutate()}>
            Cancelar viaje
          </button>
        )}
      </div>
      <ErrorBox error={cmp.error ?? route.error} />
      <div className="grid-2 wide-left">
        <section className="panel map-panel">
          <MapBase ref={mapRef} onLoad={fitTrip}>
            {t.route && (
              <Source id="planned" type="geojson" data={lineLayer(t.route.coordinates)}>
                <Layer id="planned-line" type="line" layout={{ 'line-cap': 'round' }} paint={{ 'line-color': '#7c3aed', 'line-width': 5, 'line-opacity': 0.6, 'line-dasharray': [2, 2] }} />
              </Source>
            )}
            <Source id="obs" type="geojson" data={layers.lines}>
              <Layer id="obs-casing" type="line" paint={{ 'line-color': '#fff', 'line-width': 6 }} />
              <Layer id="obs-line" type="line" paint={{ 'line-color': '#0f766e', 'line-width': 3.5 }} />
            </Source>
            <Source id="gaps" type="geojson" data={layers.gaps}>
              <Layer id="gap-ends" type="circle" paint={{ 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 3 }} />
            </Source>
            <Marker longitude={t.origin.lon} latitude={t.origin.lat}>
              <div className="pin start">A</div>
            </Marker>
            <Marker longitude={t.destination.lon} latitude={t.destination.lat}>
              <div className="pin end">B</div>
            </Marker>
            {c?.deviations
              .filter((d) => d.status === 'confirmed' || d.status === 'possible')
              .map((d, i) => {
                const pt = track.data?.segments.flatMap((s) => (s.kind === 'observed' ? s.points : [])).find((p) => p[3] === d.startPointId);
                return pt ? (
                  <Marker key={i} longitude={pt[0]} latitude={pt[1]}>
                    <div className={`pin deviation ${d.status}`} title={`${DEV_LABEL[d.status]} desde ${fmtDateTime(d.startAt)}`}>
                      !
                    </div>
                  </Marker>
                ) : null;
              })}
          </MapBase>
          <div className="legend static">
            <div>
              <span className="sw dashed" /> Planificada (estimada por {t.route?.provider ?? '—'})
            </div>
            <div>
              <span className="sw line" /> Observada (posiciones registradas)
            </div>
            <div>
              <span className="sw ring gap" /> Hueco sin datos
            </div>
          </div>
        </section>
        <section className="panel">
          <h2>Ruta estimada</h2>
          {t.route ? (
            <p className="small">
              {fmtDistance(t.route.distanceM)} · {fmtDuration(t.route.durationS)} ({KIND_LABEL[t.route.durationKind]}). Proveedor: <strong>{t.route.provider}</strong>, calculada {fmtDateTime(t.route.computedAt)}.{' '}
              {t.route.attribution && <span className="muted">{t.route.attribution}</span>}
            </p>
          ) : (
            <p className="muted small">Sin ruta estimada. Sin ella no se pueden detectar desvíos ni medir el avance.</p>
          )}
          {canWrite && (
            <div className="row wrap">
              <select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Perfil">
                <option value="driving">Auto</option>
                <option value="cycling">Bicicleta</option>
                <option value="foot">A pie</option>
              </select>
              <button className="btn small primary" onClick={() => route.mutate('configured')} disabled={route.isPending}>
                {route.isPending ? 'Calculando…' : 'Calcular con OSRM'}
              </button>
              <button className="btn small" onClick={() => route.mutate('straight_line')} disabled={route.isPending} title="Estimación básica: no sigue calles">
                Línea recta
              </button>
            </div>
          )}
          <p className="muted small">El servidor demo de OSRM no tiene tráfico ni SLA: los tiempos son orientativos.</p>

          <h2>Comparación planificado vs. real</h2>
          {c ? (
            <>
              <table className="table compare">
                <thead>
                  <tr>
                    <th />
                    <th>Planificado (estimado)</th>
                    <th>Real (observado)</th>
                    <th>Diferencia</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>Distancia</th>
                    <td>{fmtDistance(c.planned?.distanceM)}</td>
                    <td title="Solo tramos con datos: los huecos no se suman">{fmtDistance(c.observed.distanceM)}</td>
                    <td>{c.diff.distanceM == null ? '—' : `${c.diff.distanceM > 0 ? '+' : ''}${fmtDistance(c.diff.distanceM)}`}</td>
                  </tr>
                  <tr>
                    <th>Duración</th>
                    <td>{fmtDuration(c.planned?.durationS)}</td>
                    <td>{fmtDuration(c.observed.durationS)}</td>
                    <td>{c.diff.durationS == null ? '—' : `${c.diff.durationS > 0 ? '+' : ''}${fmtDuration(c.diff.durationS)}`}</td>
                  </tr>
                </tbody>
              </table>
              <dl className="kv">
                <dt>Llegó al destino</dt>
                <dd>{c.arrival.reached ? `Sí · ${fmtDateTime(c.arrival.at)} (${CONFIDENCE_LABEL[c.arrival.confidence!]})` : c.arrival.confidence === 'possible' ? 'Posiblemente (sin permanencia suficiente)' : 'No registrado'}</dd>
                <dt>Avance sobre la ruta</dt>
                <dd>{c.progress.fraction == null ? '—' : `${Math.round(c.progress.fraction * 100)} %${c.progress.reliable ? '' : ' (poco fiable: cobertura baja)'}`}</dd>
                <dt>Distancia restante</dt>
                <dd>{fmtDistance(c.progress.distanceRemainingM)}</dd>
                <dt>Tiempo restante</dt>
                <dd>{c.progress.etaS == null ? 'sin datos suficientes' : `${fmtDuration(c.progress.etaS)} (estimación básica, sin tráfico)`}</dd>
                <dt>Cobertura de datos</dt>
                <dd>{c.coverage.observedFraction == null ? '—' : `${Math.round(c.coverage.observedFraction * 100)} % del tiempo con posiciones`}</dd>
                <dt>Método</dt>
                <dd className="small">
                  {c.method}: corredor de {String(c.params.corridorM)} m; desvío confirmado con ≥{String(c.params.minPoints)} puntos y ≥{String(c.params.minDurationS)} s fuera.
                </dd>
              </dl>
              <h3>Tramos fuera de la ruta</h3>
              {c.deviations.length ? (
                <ul className="deviations">
                  {c.deviations.map((d, i) => (
                    <li key={i} className={`dev-${d.status}`}>
                      <strong>{DEV_LABEL[d.status]}</strong> · {fmtDateTime(d.startAt)} → {fmtDateTime(d.endAt)} · hasta {fmtDistance(d.maxOffsetM)} de la ruta · {d.pointCount} puntos
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">{c.planned ? 'Sin tramos fuera del corredor.' : 'Calculá una ruta para evaluar desvíos.'}</p>
              )}
            </>
          ) : (
            <p className="muted">Cargando…</p>
          )}
          <h3>Datos del viaje</h3>
          <dl className="kv small">
            <dt>Dispositivo</dt>
            <dd>{t.deviceName ?? 'sin asignar'}</dd>
            <dt>Inicio planificado</dt>
            <dd>{fmtDateTime(t.plannedStartAt)}</dd>
            <dt>Llegada estimada</dt>
            <dd>{fmtDateTime(t.plannedArrivalAt)}</dd>
            <dt>Observaciones</dt>
            <dd>{t.notes ?? '—'}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
