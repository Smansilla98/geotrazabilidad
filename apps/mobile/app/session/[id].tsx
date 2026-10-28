import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import type { SessionSummary, TrackResponse } from '@geo/shared';
import { userApi } from '../../src/api';
import { MAP_STYLE_URL } from '../../src/config';
import { getDevice } from '../../src/credentials';
import { Card, ErrorText, fmtDT, fmtKm, Muted, Row, Screen, useLoad } from '../../src/ui';

/** Detalle de un recorrido: segmentos observados; los huecos no se unen con líneas. */
export default function SessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useLoad(async () => {
    const d = await getDevice();
    const sessions = await userApi<SessionSummary[]>(`/v1/devices/${d!.deviceId}/sessions?limit=200`);
    const sess = sessions.find((x) => x.id === id);
    if (!sess?.firstPointAt) return { sess, track: null };
    const qs = new URLSearchParams({ from: new Date(Date.parse(sess.firstPointAt) - 1000).toISOString(), to: new Date(Date.parse(sess.lastPointAt!) + 1000).toISOString(), sessionId: id, maxPoints: '3000' });
    return { sess, track: await userApi<TrackResponse>(`/v1/devices/${d!.deviceId}/track?${qs}`) };
  }, [id]);
  const tr = q.data?.track;
  const lines: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: (tr?.segments ?? []).flatMap((sg) => (sg.kind === 'observed' && sg.points.length > 1 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: sg.points.map((p) => [p[0], p[1]]) } }] : [])),
  };
  const first = tr?.segments.find((x) => x.kind === 'observed');
  const center: [number, number] = first && first.kind === 'observed' && first.points[0] ? [first.points[0][0], first.points[0][1]] : [-58.42, -34.61];
  return (
    <Screen scroll={false}>
      <View style={{ height: '55%' }}>
        <Map style={{ flex: 1 }} mapStyle={MAP_STYLE_URL} attribution logo={false}>
          <Camera initialViewState={{ center, zoom: 13 }} />
          <GeoJSONSource id="t" data={lines}>
            <Layer id="t-line" type="line" paint={{ 'line-color': '#0f766e', 'line-width': 4 }} />
          </GeoJSONSource>
        </Map>
      </View>
      <View style={{ padding: 14 }}>
        <ErrorText error={q.error} />
        <Card title="Resumen">
          <Row label="Inicio" value={fmtDT(q.data?.sess?.startedAt)} />
          <Row label="Fin" value={q.data?.sess?.endedAt ? fmtDT(q.data.sess.endedAt) : 'en curso'} />
          <Row label="Distancia observada" value={fmtKm(tr?.stats.distanceM)} />
          <Row label="Posiciones" value={String(tr?.stats.observedPoints ?? 0)} />
          <Row label="Huecos sin datos" value={String(tr?.stats.gaps ?? 0)} />
          <Muted>La distancia suma solo tramos con datos; durante los huecos el trayecto es desconocido.</Muted>
        </Card>
      </View>
    </Screen>
  );
}
