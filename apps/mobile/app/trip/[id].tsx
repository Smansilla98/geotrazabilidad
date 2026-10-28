import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TripDto } from '@geo/shared';
import { userApi } from '../../src/api';
import { Banner, Button, Card, ErrorText, fmtDT, fmtKm, Muted, Row, Screen, useLoad, useTracking } from '../../src/ui';

interface Progress {
  progress: { fraction: number | null; reliable: boolean; distanceRemainingM: number | null; etaS: number | null; etaKind: string | null };
  observed: { distanceM: number; durationS: number | null; lastPointAt: string | null };
  arrival: { reached: boolean; confidence: string | null; at: string | null };
  activeDeviation: { maxOffsetM: number; startAt: string } | null;
}

/** Detalle de viaje con progreso calculado por el servidor (sin tráfico; ETA básica identificada). */
export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const st = useTracking();
  const trip = useLoad(() => userApi<TripDto>(`/v1/trips/${id}`), [id]);
  const prog = useLoad(() => userApi<Progress>(`/v1/trips/${id}/progress`), [id, st.lastSyncAt]);
  const t = trip.data;
  const p = prog.data;
  return (
    <Screen>
      <ErrorText error={trip.error ?? prog.error} />
      {t && (
        <Card title={t.name}>
          <Row label="Estado" value={t.status} />
          <Row label="Inicio planificado" value={fmtDT(t.plannedStartAt)} />
          <Row label="Llegada estimada" value={fmtDT(t.plannedArrivalAt)} />
          <Row label="Ruta estimada" value={t.route ? `${fmtKm(t.route.distanceM)} (${t.route.provider}, sin tráfico)` : 'sin calcular'} />
          {t.notes && <Muted>{t.notes}</Muted>}
        </Card>
      )}
      {p && (
        <Card title="Progreso">
          {p.activeDeviation && <Banner kind="danger" text={`Desvío confirmado: hasta ${Math.round(p.activeDeviation.maxOffsetM)} m de la ruta`} />}
          <Row label="Distancia recorrida" value={fmtKm(p.observed.distanceM)} />
          <Row label="Tiempo transcurrido" value={p.observed.durationS == null ? '—' : `${Math.round(p.observed.durationS / 60)} min`} />
          <Row label="Avance" value={p.progress.fraction == null ? '—' : `${Math.round(p.progress.fraction * 100)} %${p.progress.reliable ? '' : ' (poco fiable)'}`} />
          <Row label="Distancia restante" value={fmtKm(p.progress.distanceRemainingM)} />
          <Row label="Tiempo restante" value={p.progress.etaS == null ? 'datos insuficientes' : `${Math.round(p.progress.etaS / 60)} min (estimación básica)`} />
          <Row label="Llegada" value={p.arrival.reached ? `Sí, ${fmtDT(p.arrival.at)}` : 'No registrada'} />
          <Row label="Última posición en el servidor" value={fmtDT(p.observed.lastPointAt)} />
          <Muted>Pendientes en el teléfono: {st.pending}. El progreso refleja solo lo ya sincronizado.</Muted>
        </Card>
      )}
      {t && (t.status === 'planned' || t.status === 'in_progress' || t.status === 'interrupted') && !st.active && (
        <Button title="Iniciar seguimiento de este viaje" onPress={() => router.push({ pathname: '/', params: { tripId: t.id } })} />
      )}
      <Button title="Actualizar" kind="secondary" onPress={() => void prog.reload()} busy={prog.loading} />
    </Screen>
  );
}
