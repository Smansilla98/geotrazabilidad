import { Text } from 'react-native';
import type { TrackingEventDto } from '@geo/shared';
import { userApi } from '../../src/api';
import { getDevice } from '../../src/credentials';
import { Button, Card, ErrorText, fmtDT, Muted, Screen, s, useLoad } from '../../src/ui';
import { View } from 'react-native';

const LABEL: Record<string, string> = {
  movement_started: 'Inicio de movimiento', stop: 'Detención', movement_resumed: 'Reanudación', heading_change: 'Cambio de dirección',
  geofence_enter: 'Entrada a zona', geofence_exit: 'Salida de zona', arrival: 'Llegada a destino', route_deviation: 'Desvío de ruta',
  signal_gap: 'Pérdida de señal / sin datos', capture_resumed: 'Captura reanudada', gps_outlier: 'Salto GPS descartado', trip_started: 'Inicio de viaje', trip_completed: 'Viaje finalizado',
};
const CONF: Record<string, string> = { confirmed: 'Confirmado', probable: 'Probable', possible: 'Posible', insufficient_data: 'Datos insuficientes' };

/** Eventos inferidos por el servidor para este teléfono (con su nivel de confianza). */
export default function EventsScreen() {
  const q = useLoad(async () => {
    const d = await getDevice();
    return d ? (await userApi<{ items: TrackingEventDto[] }>(`/v1/events?deviceId=${d.deviceId}&limit=100`)).items : [];
  });
  return (
    <Screen>
      <Button title="Actualizar" kind="secondary" onPress={() => void q.reload()} busy={q.loading} />
      <ErrorText error={q.error} />
      <Card title="Eventos recientes">
        {q.data?.map((e) => (
          <View key={e.id} style={s.item}>
            <Text style={{ fontWeight: '600' }}>{LABEL[e.type] ?? e.type}{e.geofenceName ? ` · ${e.geofenceName}` : ''}</Text>
            <Muted>{fmtDT(e.occurredAt)} · {CONF[e.confidence]}{e.tripName ? ` · ${e.tripName}` : ''}</Muted>
          </View>
        ))}
        {!q.loading && !q.data?.length && <Muted>Sin eventos. Se generan en el servidor a partir de tus recorridos sincronizados.</Muted>}
      </Card>
    </Screen>
  );
}
