import { Layer, Source } from 'react-map-gl/maplibre';
import type { GeofenceDto, TrackResponse, TrackingEventDto } from '@geo/shared';
import { EVENT_COLOR } from '../lib/format';
import { eventsLayer, geofencesLayer, lineLayer, trackLayers } from '../lib/geojson';

export interface LayerToggles {
  points: boolean;
  events: boolean;
  geofences: boolean;
  planned: boolean;
}

const eventColorExpr = ['match', ['get', 'type'], ...Object.entries(EVENT_COLOR).flat(), '#334155'] as unknown as string;

export const INTERACTIVE_LAYERS = ['track-points', 'event-points', 'gap-ends', 'outlier-points'];

/** Capas del recorrido. Calidad por color, outliers aparte, huecos como extremos sin línea. */
export function TrackLayers({
  track,
  events,
  geofences,
  planned,
  toggles,
  highlightEventId,
}: {
  track?: TrackResponse;
  events: TrackingEventDto[];
  geofences: GeofenceDto[];
  planned?: [number, number][];
  toggles: LayerToggles;
  highlightEventId?: string | null;
}) {
  const t = trackLayers(track);
  return (
    <>
      {toggles.geofences && (
        <Source id="geofences" type="geojson" data={geofencesLayer(geofences)}>
          <Layer id="geofence-fill" type="fill" paint={{ 'fill-color': '#0d9488', 'fill-opacity': 0.12 }} />
          <Layer id="geofence-line" type="line" paint={{ 'line-color': '#0d9488', 'line-width': 1.5 }} />
          <Layer id="geofence-label" type="symbol" layout={{ 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': ['Noto Sans Regular'] }} paint={{ 'text-color': '#115e59', 'text-halo-color': '#fff', 'text-halo-width': 1.2 }} />
        </Source>
      )}
      {toggles.planned && planned && (
        <Source id="planned" type="geojson" data={lineLayer(planned)}>
          <Layer id="planned-line" type="line" layout={{ 'line-cap': 'round' }} paint={{ 'line-color': '#7c3aed', 'line-width': 4, 'line-opacity': 0.7, 'line-dasharray': [2, 2] }} />
        </Source>
      )}
      <Source id="track-lines" type="geojson" data={t.lines}>
        <Layer id="track-casing" type="line" layout={{ 'line-join': 'round', 'line-cap': 'round' }} paint={{ 'line-color': '#ffffff', 'line-width': 6 }} />
        <Layer id="track-line" type="line" layout={{ 'line-join': 'round', 'line-cap': 'round' }} paint={{ 'line-color': '#0f766e', 'line-width': 3.5 }} />
      </Source>
      {toggles.points && (
        <Source id="track-points-src" type="geojson" data={t.points}>
          <Layer
            id="track-points"
            type="circle"
            paint={{
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 4.5],
              'circle-color': ['match', ['get', 'q'], 'good', '#16a34a', 'fair', '#ca8a04', 'poor', '#dc2626', '#64748b'],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 0.8,
            }}
          />
        </Source>
      )}
      <Source id="outliers" type="geojson" data={t.outliers}>
        <Layer id="outlier-points" type="circle" paint={{ 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#9f1239', 'circle-stroke-width': 2.5 }} />
      </Source>
      <Source id="gaps" type="geojson" data={t.gaps}>
        <Layer id="gap-ends" type="circle" paint={{ 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 3 }} />
      </Source>
      <Source id="ends" type="geojson" data={t.ends}>
        <Layer id="ends-circle" type="circle" paint={{ 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'start', '#0f766e', '#111827'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }} />
      </Source>
      {toggles.events && (
        <Source id="events" type="geojson" data={eventsLayer(events)}>
          <Layer
            id="event-points"
            type="circle"
            paint={{
              'circle-radius': ['case', ['==', ['get', 'id'], highlightEventId ?? ''], 11, 7],
              'circle-color': eventColorExpr,
              'circle-opacity': ['match', ['get', 'confidence'], 'confirmed', 1, 'probable', 0.85, 0.55],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 2,
            }}
          />
        </Source>
      )}
    </>
  );
}

export function MapLegend({ showPlanned }: { showPlanned?: boolean }) {
  return (
    <div className="legend">
      <div>
        <span className="sw line" /> Recorrido observado
      </div>
      {showPlanned && (
        <div>
          <span className="sw dashed" /> Ruta planificada (estimada)
        </div>
      )}
      <div>
        <span className="sw dot good" /> ≤20 m <span className="sw dot fair" /> ≤50 m <span className="sw dot poor" /> &gt;50 m
      </div>
      <div>
        <span className="sw ring gap" /> Hueco sin datos (no se une)
      </div>
      <div>
        <span className="sw ring outlier" /> Salto GPS descartado
      </div>
      <div>
        <span className="sw ring interp" /> Posición interpolada (reproductor)
      </div>
    </div>
  );
}
