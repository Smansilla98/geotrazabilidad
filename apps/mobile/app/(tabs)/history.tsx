import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import type { SessionSummary } from '@geo/shared';
import { userApi } from '../../src/api';
import { getDevice } from '../../src/credentials';
import { Button, Card, ErrorText, fmtDT, Muted, Screen, s, useLoad } from '../../src/ui';

/** Historial de recorridos de este teléfono, tal como los registró el servidor. */
export default function HistoryScreen() {
  const router = useRouter();
  const q = useLoad(async () => {
    const d = await getDevice();
    return d ? userApi<SessionSummary[]>(`/v1/devices/${d.deviceId}/sessions?limit=100`) : [];
  });
  return (
    <Screen>
      <Button title="Actualizar" kind="secondary" onPress={() => void q.reload()} busy={q.loading} />
      <ErrorText error={q.error} />
      <Card title="Recorridos sincronizados">
        {q.data?.map((x) => (
          <Pressable key={x.id} style={s.item} onPress={() => router.push(`/session/${x.id}`)} accessibilityRole="button">
            <Text style={{ fontWeight: '600' }}>{fmtDT(x.startedAt)}</Text>
            <Muted>
              {x.endedAt ? `hasta ${fmtDT(x.endedAt)}` : 'en curso'} · {x.pointCount} posiciones · modo {x.mode}
              {x.tripId ? ' · viaje' : ''}
            </Muted>
          </Pressable>
        ))}
        {!q.loading && !q.data?.length && <Muted>Todavía no hay recorridos en el servidor. Los registros pendientes aparecen al sincronizar.</Muted>}
      </Card>
    </Screen>
  );
}
