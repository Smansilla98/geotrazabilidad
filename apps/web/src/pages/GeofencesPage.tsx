import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layer, Source, type MapLayerMouseEvent } from 'react-map-gl/maplibre';
import { GeofenceKind, type GeofenceDto } from '@geo/shared';
import { api } from '../lib/api';
import { circlePolygon, geofencesLayer } from '../lib/geojson';
import { MapBase } from '../components/MapBase';
import { ErrorBox, usePrimaryOrg } from '../App';

const KIND_LABEL: Record<string, string> = {
  home: 'Casa', work: 'Trabajo', depot: 'Depósito', office: 'Oficina', delivery: 'Punto de entrega', poi: 'Zona de interés', trip_origin: 'Origen de viaje', trip_destination: 'Destino de viaje', other: 'Otra',
};

export function GeofencesPage() {
  const qc = useQueryClient();
  const { canWrite } = usePrimaryOrg();
  const list = useQuery({ queryKey: ['geofences'], queryFn: () => api<GeofenceDto[]>('/v1/geofences') });
  const [shape, setShape] = useState<'circle' | 'polygon'>('circle');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('poi');
  const [radius, setRadius] = useState(150);
  const [enterDwell, setEnterDwell] = useState(60);
  const [hyst, setHyst] = useState(25);
  const [verts, setVerts] = useState<[number, number][]>([]);
  const create = useMutation({
    mutationFn: () =>
      api<GeofenceDto>('/v1/geofences', {
        method: 'POST',
        json:
          shape === 'circle'
            ? { name, kind, shape, center: { lon: verts[0]![0], lat: verts[0]![1] }, radiusM: radius, enterDwellS: enterDwell, exitDwellS: enterDwell, hysteresisM: hyst }
            : { name, kind, shape, polygon: [[...verts, verts[0]!]], enterDwellS: enterDwell, exitDwellS: enterDwell, hysteresisM: hyst },
      }),
    onSuccess: () => {
      setVerts([]);
      setName('');
      void qc.invalidateQueries({ queryKey: ['geofences'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/geofences/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['geofences'] }),
  });
  const onClick = (e: MapLayerMouseEvent) => {
    if (!canWrite) return;
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    setVerts(shape === 'circle' ? [p] : [...verts, p]);
  };
  const draft: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features:
      shape === 'circle' && verts[0]
        ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePolygon({ lon: verts[0][0], lat: verts[0][1] }, radius)] }, properties: {} }]
        : verts.length >= 2
          ? [{ type: 'Feature', geometry: { type: verts.length >= 3 ? 'Polygon' : 'LineString', coordinates: verts.length >= 3 ? [[...verts, verts[0]!]] : verts } as GeoJSON.Geometry, properties: {} }]
          : [],
  };
  const ready = name && (shape === 'circle' ? verts.length === 1 : verts.length >= 3);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Geocercas</h1>
      </div>
      <p className="muted small">
        Una entrada o salida se confirma solo con al menos 2 posiciones claras del nuevo lado durante la permanencia mínima. Una banda de histéresis en el borde evita eventos repetidos. Los cambios se aplican a los datos nuevos y a los seguimientos en curso.
      </p>
      <div className="grid-2 wide-right">
        <section className="panel">
          {canWrite ? (
            <form
              className="form-col"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <h2>Nueva geocerca</h2>
              <div className="row">
                <label className="check">
                  <input type="radio" checked={shape === 'circle'} onChange={() => (setShape('circle'), setVerts([]))} /> Círculo
                </label>
                <label className="check">
                  <input type="radio" checked={shape === 'polygon'} onChange={() => (setShape('polygon'), setVerts([]))} /> Polígono
                </label>
              </div>
              <p className="small muted">{shape === 'circle' ? 'Tocá el mapa para ubicar el centro.' : `Tocá el mapa para agregar vértices (${verts.length}; mínimo 3).`}</p>
              <label>
                Nombre
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
              </label>
              <label>
                Tipo
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {GeofenceKind.options.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              {shape === 'circle' && (
                <label>
                  Radio (m)
                  <input type="number" min={10} max={50000} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                </label>
              )}
              <label>
                Permanencia mínima (s)
                <input type="number" min={0} max={3600} value={enterDwell} onChange={(e) => setEnterDwell(Number(e.target.value))} />
              </label>
              <label>
                Histéresis del borde (m)
                <input type="number" min={0} max={500} value={hyst} onChange={(e) => setHyst(Number(e.target.value))} />
              </label>
              <ErrorBox error={create.error} />
              <div className="row">
                <button className="btn primary" disabled={!ready || create.isPending}>
                  Guardar
                </button>
                <button type="button" className="btn ghost" onClick={() => setVerts([])}>
                  Limpiar
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">Tu rol permite ver las geocercas, no modificarlas.</p>
          )}
          <h2>Geocercas ({list.data?.length ?? 0})</h2>
          <ul className="list">
            {list.data?.map((g) => (
              <li key={g.id}>
                <div>
                  <strong>{g.name}</strong>
                  <div className="muted small">
                    {KIND_LABEL[g.kind]} · {g.shape === 'circle' ? `círculo ${g.radiusM} m` : 'polígono'} · permanencia {g.enterDwellS} s · histéresis {g.hysteresisM} m
                  </div>
                </div>
                {canWrite && (
                  <button className="btn small ghost danger" onClick={() => confirm(`¿Eliminar "${g.name}"?`) && remove.mutate(g.id)}>
                    Eliminar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel map-panel">
          <MapBase onClick={onClick} cursor={canWrite ? 'crosshair' : undefined}>
            <Source id="gf" type="geojson" data={geofencesLayer(list.data ?? [])}>
              <Layer id="gf-fill" type="fill" paint={{ 'fill-color': '#0d9488', 'fill-opacity': 0.15 }} />
              <Layer id="gf-line" type="line" paint={{ 'line-color': '#0d9488', 'line-width': 2 }} />
            </Source>
            <Source id="draft" type="geojson" data={draft}>
              <Layer id="draft-fill" type="fill" filter={['==', '$type', 'Polygon']} paint={{ 'fill-color': '#f59e0b', 'fill-opacity': 0.2 }} />
              <Layer id="draft-line" type="line" paint={{ 'line-color': '#d97706', 'line-width': 2, 'line-dasharray': [2, 1] }} />
            </Source>
          </MapBase>
        </section>
      </div>
    </div>
  );
}
