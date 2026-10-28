import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, UserLocation } from '@maplibre/maplibre-react-native';
import { useLocalSearchParams } from 'expo-router';
import type { GeofenceDto, TrackingMode, TripDto } from '@geo/shared';
import { userApi } from '../../src/api';
import { MAP_STYLE_URL } from '../../src/config';
import { recentSessionPoints, requestPermissions, startTracking, stopTracking, syncNow } from '../../src/tracking';
import { Banner, Button, C, Card, fmtDT, Muted, Row, s, useLoad, useTracking } from '../../src/ui';

const MODES: { key: TrackingMode; label: string; help: string }[] = [
  { key: 'battery_saver', label: 'Ahorro', help: 'Pocos puntos; ideal para el día completo.' },
  { key: 'normal', label: 'Normal', help: 'Equilibrio entre detalle y batería.' },
  { key: 'trip', label: 'Viaje', help: 'Más detalle mientras te desplazás.' },
  { key: 'intensive', label: 'Intensivo', help: 'Máximo detalle; alto consumo.' },
];

function circle(center: { lon: number; lat: number }, r: number): [number, number][] {
  return Array.from({ length: 49 }, (_, i) => {
    const a = (i / 48) * 2 * Math.PI;
    return [center.lon + (r / (111_195 * Math.cos((center.lat * Math.PI) / 180))) * Math.cos(a), center.lat + (r / 111_195) * Math.sin(a)];
  });
}

export default function TrackingScreen() {
  const st = useTracking();
  const params = useLocalSearchParams<{ tripId?: string }>();
  const [mode, setMode] = useState<TrackingMode>(params.tripId ? 'trip' : 'normal');
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState<[number, number][]>([]);
  const geofences = useLoad(() => userApi<GeofenceDto[]>('/v1/geofences').catch(() => [] as GeofenceDto[]));
  const trip = useLoad(() => (params.tripId ? userApi<TripDto>(`/v1/trips/${params.tripId}`) : Promise.resolve(null)), [params.tripId]);

  useEffect(() => {
    void recentSessionPoints().then((pts) => setTrack(pts.map((p) => [p.lon, p.lat])));
  }, [st.lastFix?.t, st.sessionId]);

  const start = async () => {
    setBusy(true);
    try {
      let perm = st.permission;
      if (perm !== 'always' && perm !== 'when_in_use') perm = await requestPermissions();
      if (perm === 'denied') {
        Alert.alert('Permiso denegado', 'Sin permiso de ubicación no se puede registrar el recorrido. Podés habilitarlo en Ajustes.', [
          { text: 'Cancelar' },
          { text: 'Abrir Ajustes', onPress: () => void Linking.openSettings() },
        ]);
        return;
      }
      if (perm === 'when_in_use') {
        Alert.alert('Solo en primer plano', 'Con el permiso "Al usar la app" el registro se detiene al bloquear la pantalla. Para registrar en segundo plano elegí "Permitir siempre" en Ajustes.');
      }
      await startTracking(mode, params.tripId ?? null);
    } catch (e) {
      Alert.alert('No se pudo iniciar', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = () =>
    Alert.alert('Detener seguimiento', 'Se cierra la sesión actual y se sincronizan los registros pendientes.', [
      { text: 'Cancelar' },
      { text: 'Detener', style: 'destructive', onPress: () => void stopTracking('user') },
    ]);

  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
  const geofenceShapes = fc(
    (geofences.data ?? []).map((g) => ({
      type: 'Feature',
      properties: { name: g.name },
      geometry: { type: 'Polygon', coordinates: g.shape === 'circle' && g.center && g.radiusM ? [circle(g.center, g.radiusM)] : (g.polygon ?? []) },
    })),
  );
  const t = trip.data;
  const center: [number, number] = st.lastFix ? [st.lastFix.lon, st.lastFix.lat] : t ? [t.origin.lon, t.origin.lat] : [-58.42, -34.61];

  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: '45%' }}>
        <Map style={{ flex: 1 }} mapStyle={MAP_STYLE_URL} attribution logo={false}>
          <Camera initialViewState={{ center, zoom: 14 }} trackUserLocation={st.active ? 'default' : undefined} />
          <UserLocation accuracy heading />
          <GeoJSONSource id="geofences" data={geofenceShapes}>
            <Layer id="gf-fill" type="fill" paint={{ 'fill-color': '#0d9488', 'fill-opacity': 0.15 }} />
            <Layer id="gf-line" type="line" paint={{ 'line-color': '#0d9488', 'line-width': 1.5 }} />
          </GeoJSONSource>
          {t?.route && (
            <GeoJSONSource id="planned" data={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.route.coordinates } }}>
              <Layer id="planned-line" type="line" paint={{ 'line-color': '#7c3aed', 'line-width': 4, 'line-opacity': 0.6, 'line-dasharray': [2, 2] }} />
            </GeoJSONSource>
          )}
          {t && (
            <GeoJSONSource
              id="trip-ends"
              data={fc([
                { type: 'Feature', properties: { k: 'o' }, geometry: { type: 'Point', coordinates: [t.origin.lon, t.origin.lat] } },
                { type: 'Feature', properties: { k: 'd' }, geometry: { type: 'Point', coordinates: [t.destination.lon, t.destination.lat] } },
              ])}
            >
              <Layer id="trip-ends-c" type="circle" paint={{ 'circle-radius': 8, 'circle-color': ['match', ['get', 'k'], 'o', '#0f766e', '#111827'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }} />
            </GeoJSONSource>
          )}
          {track.length >= 2 && (
            <GeoJSONSource id="session" data={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: track } }}>
              <Layer id="session-line" type="line" paint={{ 'line-color': '#0f766e', 'line-width': 4 }} />
            </GeoJSONSource>
          )}
        </Map>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }} style={{ backgroundColor: C.bg }}>
        <StatusBanners />
        {t && <Banner kind="info" text={`Viaje: ${t.name}`} />}
        {st.active ? (
          <Card title="Seguimiento activo">
            <Row label="Modo" value={MODES.find((m) => m.key === st.mode)?.label ?? st.mode} />
            <Row label="Última posición" value={st.lastFix ? `${fmtDT(st.lastFix.t)} (±${Math.round(st.lastFix.accuracy ?? 0)} m)` : 'esperando señal…'} />
            <Row label="Pendientes de enviar" value={String(st.pending)} />
            <Button title="Detener seguimiento" kind="danger" onPress={stop} />
            <Button title="Sincronizar ahora" kind="secondary" onPress={() => void syncNow()} />
          </Card>
        ) : (
          <Card title={st.interrupted ? 'Seguimiento interrumpido' : 'Iniciar seguimiento'}>
            {st.interrupted && <Muted>El sistema detuvo la captura (app cerrada o reinicio). Podés reanudar la misma sesión: el tramo sin datos quedará marcado como hueco.</Muted>}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {MODES.map((m) => (
                <Pressable
                  key={m.key}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: mode === m.key }}
                  onPress={() => setMode(m.key)}
                  style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: mode === m.key ? C.accent : C.border, backgroundColor: mode === m.key ? `${C.accent}18` : '#fff' }}
                >
                  <Text style={{ color: mode === m.key ? C.accent : C.text, fontWeight: '600' }}>{m.label}</Text>
                </Pressable>
              ))}
            </View>
            <Muted>{MODES.find((m) => m.key === mode)?.help}</Muted>
            <Button title={st.interrupted ? 'Reanudar seguimiento' : 'Iniciar seguimiento'} onPress={() => void start()} busy={busy} />
            {st.interrupted && <Button title="Cerrar la sesión interrumpida" kind="secondary" onPress={() => void stopTracking('interrupted')} />}
          </Card>
        )}
        <Text style={[s.muted, { fontSize: 11 }]}>Mapa: OpenFreeMap · © OpenMapTiles · © colaboradores de OpenStreetMap</Text>
      </ScrollView>
    </View>
  );
}

export function StatusBanners() {
  const st = useTracking();
  return (
    <View style={{ gap: 6 }}>
      {st.active && <Banner kind="ok" text="● Registrando ubicación" />}
      {st.permission === 'denied' && <Banner kind="danger" text="Sin permiso de ubicación: no se registra nada." />}
      {st.permission === 'when_in_use' && <Banner kind="warn" text={'Permiso "Al usar la app": el registro se pausa con la pantalla bloqueada.'} />}
      {st.online === false && <Banner kind="warn" text={`Sin conexión: ${st.pending} registros guardados en el teléfono, se enviarán al reconectar.`} />}
      {st.lastSync?.kind === 'blocked' && <Banner kind="danger" text={st.lastSync.reason === 'consent' ? 'El servidor no tiene tu consentimiento vigente. Revisá Privacidad.' : st.lastSync.reason === 'revoked' ? 'Este dispositivo fue revocado: no puede enviar ubicaciones.' : 'Sesión del dispositivo vencida: volvé a iniciar sesión.'} />}
      {st.lastSync?.kind === 'retry' && st.online !== false && <Banner kind="warn" text={`Reintentando sincronizar (${st.lastSync.reason}).`} />}
    </View>
  );
}
