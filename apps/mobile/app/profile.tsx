import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import type { MeResponse } from '@geo/shared';
import { logoutUser, userApi } from '../src/api';
import { setDevice } from '../src/credentials';
import { stopTracking } from '../src/tracking';
import { Button, Card, ErrorText, Muted, Row, Screen, useLoad, useTracking } from '../src/ui';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Administrador', viewer: 'Lector' };

export default function ProfileScreen() {
  const router = useRouter();
  const st = useTracking();
  const me = useLoad(() => userApi<MeResponse>('/v1/me'));
  const logout = () =>
    Alert.alert('Cerrar sesión', st.pending ? `Hay ${st.pending} registros sin enviar. Se detendrá el seguimiento; los registros se conservan y se enviarán al volver a vincular.` : 'Se detendrá el seguimiento y se desvinculará este teléfono de la sesión.', [
      { text: 'Cancelar' },
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: async () => {
          await stopTracking('logout');
          await logoutUser();
          await setDevice(null);
          router.replace('/login');
        },
      },
    ]);
  return (
    <Screen>
      <ErrorText error={me.error} />
      {me.data && (
        <Card title={me.data.displayName}>
          <Row label="Email" value={me.data.email} />
          {me.data.memberships.map((m) => (
            <Row key={m.orgId} label={m.orgName} value={`${ROLE[m.role]} · retención ${m.retentionDays} d`} />
          ))}
        </Card>
      )}
      <Muted>Para exportar o eliminar tus datos usá la plataforma web (Configuración → Privacidad).</Muted>
      <Button title="Cerrar sesión" kind="danger" onPress={logout} />
    </Screen>
  );
}
