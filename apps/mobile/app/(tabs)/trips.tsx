import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import type { TripDto } from '@geo/shared';
import { userApi } from '../../src/api';
import { Button, Card, ErrorText, fmtDT, Muted, Screen, s, useLoad } from '../../src/ui';

const STATUS: Record<string, string> = { planned: 'Planificado', in_progress: 'En curso', completed: 'Finalizado', cancelled: 'Cancelado', interrupted: 'Interrumpido' };

export default function TripsScreen() {
  const router = useRouter();
  const q = useLoad(() => userApi<TripDto[]>('/v1/trips'));
  return (
    <Screen>
      <Muted>Los viajes se planifican desde la plataforma web. Aquí podés iniciar el seguimiento asociado a un viaje.</Muted>
      <Button title="Actualizar" kind="secondary" onPress={() => void q.reload()} busy={q.loading} />
      <ErrorText error={q.error} />
      <Card title="Viajes">
        {q.data?.map((t) => (
          <Pressable key={t.id} style={s.item} onPress={() => router.push(`/trip/${t.id}`)} accessibilityRole="button">
            <Text style={{ fontWeight: '600' }}>{t.name}</Text>
            <Muted>{STATUS[t.status]} · inicio planificado {fmtDT(t.plannedStartAt)}</Muted>
          </Pressable>
        ))}
        {!q.loading && !q.data?.length && <Muted>No hay viajes.</Muted>}
      </Card>
    </Screen>
  );
}
