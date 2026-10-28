import { forwardRef, type ReactNode } from 'react';
import MapGL, { NavigationControl, ScaleControl, AttributionControl, type MapRef, type MapLayerMouseEvent } from 'react-map-gl/maplibre';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { runtimeConfig } from '../lib/api';

// MapLibre 6 carga su web worker desde un archivo aparte que el bundler no copia solo:
// se emite como recurso del build y se le indica su URL (mismo origen, compatible con la CSP).
void setWorkerUrl(workerUrl);

interface Props {
  children?: ReactNode;
  interactiveLayerIds?: string[];
  onClick?: (e: MapLayerMouseEvent) => void;
  initial?: { lon: number; lat: number; zoom: number };
  cursor?: string;
  onLoad?: () => void;
}

/** Mapa base MapLibre. Estilo configurable en runtime (MAP_STYLE_URL); la atribución siempre visible. */
export const MapBase = forwardRef<MapRef, Props>(function MapBase({ children, interactiveLayerIds, onClick, initial, cursor, onLoad }, ref) {
  return (
    <MapGL
      ref={ref}
      initialViewState={{ longitude: initial?.lon ?? -58.42, latitude: initial?.lat ?? -34.61, zoom: initial?.zoom ?? 11 }}
      mapStyle={runtimeConfig().mapStyleUrl}
      style={{ width: '100%', height: '100%' }}
      interactiveLayerIds={interactiveLayerIds}
      onClick={onClick}
      cursor={cursor}
      onLoad={onLoad}
      attributionControl={false}
    >
      <NavigationControl position="top-right" />
      <ScaleControl position="bottom-left" unit="metric" />
      <AttributionControl position="bottom-right" compact={false} customAttribution="Teselas: OpenFreeMap · © OpenMapTiles · © colaboradores de OpenStreetMap" />
      {children}
    </MapGL>
  );
});
