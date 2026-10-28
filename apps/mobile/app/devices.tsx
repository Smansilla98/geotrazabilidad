import { View, Text } from 'react-native';
import type { DeviceSummary } from '@geo/shared';
import { userApi } from '../src/api';
import { getDevice } from '../src/credentials';
import { Card, ErrorText, fmtDT, Muted, Screen, s, useLoad } from '../src/ui';

const CONN: Record<string, string> = { online: 'En línea', recent: 'Reciente', stale: 'Inactivo', offline: 'Desconectado', never: 'Sin contacto' };

export default function DevicesScreen() {
  const q = useLoad(async () => ({ list: await userApi<DeviceSummary[]>('/v1/devices'), mine: (await getDevice())?.deviceId }));
  return (
    <Screen>
      <ErrorText error={q.error} />
      <Card title="Dispositivos">
        {q.data?.list.filter((d) => !d.isDemo).map((d) => (
          <View key={d.id} style={s.item}>
            <Text style={{ fontWeight: '600' }}>{d.name}{d.id === q.data?.mine ? ' (este teléfono)' : ''}</Text>
            <Muted>{d.status === 'revoked' ? 'Revocado' : CONN[d.connectionState]} · último contacto {fmtDT(d.lastContactAt)} · app {d.appVersion ?? '—'}</Muted>
          </View>
        ))}
      </Card>
      <Muted>Para revocar o eliminar un dispositivo y su historial, usá la plataforma web.</Muted>
    </Screen>
  );
}
