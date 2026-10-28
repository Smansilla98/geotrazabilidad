import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Marker, type MapLayerMouseEvent } from 'react-map-gl/maplibre';
import type { DeviceSummary, TripDto } from '@geo/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtDistance, fromLocalInput, STATUS_LABEL } from '../lib/format';
import { MapBase } from '../components/MapBase';
import { ErrorBox, usePrimaryOrg } from '../App';

export function TripsPage() {
  const { canWrite } = usePrimaryOrg();
  const [creating, setCreating] = useState(false);
  const trips = useQuery({ queryKey: ['trips'], queryFn: () => api<TripDto[]>('/v1/trips') });
  return (
    <div className="page">
      <div className="page-head">
        <h1>Viajes</h1>
        {canWrite && (
          <button className="btn primary small" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancelar' : 'Nuevo viaje'}
          </button>
        )}
      </div>
      {creating && <TripForm onDone={() => setCreating(false)} />}
      <ErrorBox error={trips.error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Estado</th>
              <th>Dispositivo</th>
              <th>Inicio planificado</th>
              <th>Ruta estimada</th>
              <th>Inicio / fin real</th>
            </tr>
          </thead>
          <tbody>
            {trips.data?.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/trips/${t.id}`}>{t.name}</Link>
                </td>
                <td>
                  <span className={`badge status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                </td>
                <td>{t.deviceName ?? '—'}</td>
                <td>{fmtDateTime(t.plannedStartAt)}</td>
                <td>{t.route ? `${fmtDistance(t.route.distanceM)} · ${t.route.provider}` : 'sin calcular'}</td>
                <td className="small">
                  {fmtDateTime(t.actualStartAt)} → {fmtDateTime(t.actualEndAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!trips.data?.length && !trips.isLoading && <p className="muted">No hay viajes. Creá uno indicando origen y destino en el mapa.</p>}
      </div>
    </div>
  );
}

function TripForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceSummary[]>('/v1/devices') });
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [origin, setOrigin] = useState<{ lon: number; lat: number } | null>(null);
  const [dest, setDest] = useState<{ lon: number; lat: number } | null>(null);
  const [start, setStart] = useState('');
  const [arrival, setArrival] = useState('');
  const [radius, setRadius] = useState(100);
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<TripDto>('/v1/trips', {
        method: 'POST',
        json: {
          name,
          deviceId: deviceId || null,
          origin,
          destination: dest,
          arrivalRadiusM: radius,
          plannedStartAt: start ? fromLocalInput(start) : null,
          plannedArrivalAt: arrival ? fromLocalInput(arrival) : null,
          notes: notes || null,
        },
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['trips'] });
      onDone();
      nav(`/trips/${t.id}`);
    },
  });
  const onClick = (e: MapLayerMouseEvent) => {
    const p = { lon: e.lngLat.lng, lat: e.lngLat.lat };
    if (!origin) setOrigin(p);
    else if (!dest) setDest(p);
    else {
      setOrigin(p);
      setDest(null);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form className="panel form-grid" onSubmit={submit}>
      <div className="form-col">
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label>
          Dispositivo asociado
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">(sin asignar: se asocia al iniciarlo desde la app)</option>
            {devices.data
              ?.filter((d) => !d.isDemo && d.status === 'active')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Inicio planificado
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          Llegada estimada
          <input type="datetime-local" value={arrival} onChange={(e) => setArrival(e.target.value)} />
        </label>
        <label>
          Radio de llegada (m)
          <input type="number" min={10} max={5000} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </label>
        <label>
          Observaciones
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
        </label>
        <p className="small muted">
          Origen: {origin ? `${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}` : 'tocá el mapa'} · Destino: {dest ? `${dest.lat.toFixed(5)}, ${dest.lon.toFixed(5)}` : origin ? 'tocá el mapa' : '—'}
        </p>
        <ErrorBox error={create.error} />
        <button className="btn primary" disabled={!origin || !dest || !name || create.isPending}>
          Crear viaje
        </button>
      </div>
      <div className="form-map">
        <MapBase onClick={onClick} cursor="crosshair">
          {origin && (
            <Marker longitude={origin.lon} latitude={origin.lat}>
              <div className="pin start">A</div>
            </Marker>
          )}
          {dest && (
            <Marker longitude={dest.lon} latitude={dest.lat}>
              <div className="pin end">B</div>
            </Marker>
          )}
        </MapBase>
      </div>
    </form>
  );
}
