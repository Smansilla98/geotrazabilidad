import { View, Text } from 'react-native';
import type { GeofenceDto } from '@geo/shared';
import { userApi } from '../src/api';
import { Card, ErrorText, Muted, Screen, s, useLoad } from '../src/ui';

/** Geocercas (se administran en la web; la evaluación ocurre en el servidor). */
export default function GeofencesScreen() {
  const q = useLoad(() => userApi<GeofenceDto[]>('/v1/geofences'));
  return (
    <Screen>
      <Muted>Las entradas y salidas se confirman en el servidor con permanencia mínima e histéresis, para no generar falsos positivos con una posición aislada.</Muted>
      <ErrorText error={q.error} />
      <Card title="Geocercas">
        {q.data?.map((g) => (
          <View key={g.id} style={s.item}>
            <Text style={{ fontWeight: '600' }}>{g.name}</Text>
            <Muted>{g.shape === 'circle' ? `Círculo de ${g.radiusM} m` : 'Polígono'} · permanencia {g.enterDwellS} s{g.active ? '' : ' · inactiva'}</Muted>
          </View>
        ))}
        {!q.loading && !q.data?.length && <Muted>Sin geocercas. Se crean desde la plataforma web.</Muted>}
      </Card>
    </Screen>
  );
}
