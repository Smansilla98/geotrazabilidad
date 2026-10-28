import { useState } from 'react';
import { Alert, Platform, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Device from 'expo-device';
import { CURRENT_CONSENT_VERSION, type DeviceSummary } from '@geo/shared';
import { linkDevice, userApi } from '../src/api';
import { APP_VERSION } from '../src/config';
import { getDevice, getInstallId } from '../src/credentials';
import { stopTracking } from '../src/tracking';
import { Banner, Button, Card, ErrorText, Muted, Row, Screen, useLoad } from '../src/ui';

/**
 * Pantalla de privacidad y consentimiento. Vincular el dispositivo y otorgar el consentimiento
 * son pasos explícitos; el titular puede revocarlo aquí mismo (se detiene el seguimiento).
 */
export default function PrivacyScreen() {
  const router = useRouter();
  const [share, setShare] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useLoad(async () => {
    const d = await getDevice();
    return d ? userApi<DeviceSummary>(`/v1/devices/${d.deviceId}`).catch(() => null) : null;
  });

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      let d = await getDevice();
      if (!d) {
        await linkDevice({
          installId: await getInstallId(),
          name: Device.deviceName ?? `${Device.manufacturer ?? ''} ${Device.modelName ?? 'Teléfono'}`.trim(),
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
          appVersion: APP_VERSION,
          osVersion: Device.osVersion ?? undefined,
          model: Device.modelName ?? undefined,
        });
        d = await getDevice();
      }
      await userApi(`/v1/devices/${d!.deviceId}/consent`, { method: 'POST', json: { consentVersion: CURRENT_CONSENT_VERSION, shareWithOrg: share } });
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = () =>
    Alert.alert('Revocar consentimiento', 'Se detiene el seguimiento y el servidor deja de aceptar ubicaciones de este teléfono. El historial existente se conserva según la retención de tu organización (o podés eliminarlo desde la web).', [
      { text: 'Cancelar' },
      {
        text: 'Revocar',
        style: 'destructive',
        onPress: async () => {
          const d = await getDevice();
          await stopTracking('consent_revoked');
          if (d) await userApi(`/v1/devices/${d.deviceId}/consent`, { method: 'DELETE' }).catch((e) => setError((e as Error).message));
          void current.reload();
        },
      },
    ]);

  const c = current.data?.consent;
  return (
    <Screen>
      <Card title="Qué registra esta app">
        <Muted>• Latitud, longitud, hora de captura, precisión y, si el teléfono los informa, altitud, velocidad, rumbo y nivel de batería.</Muted>
        <Muted>• Solo mientras el seguimiento está activo. Android muestra una notificación permanente e iOS un indicador azul.</Muted>
        <Muted>• Las posiciones se guardan primero en el teléfono y se envían cifradas (HTTPS) al servidor.</Muted>
        <Muted>• El servidor infiere eventos (detenciones, llegadas, desvíos) e indica siempre su nivel de confianza.</Muted>
        <Muted>• Los datos se borran automáticamente según la retención de tu organización (90 días por defecto). Podés exportarlos o eliminarlos desde la web.</Muted>
      </Card>
      {c?.active ? (
        <Card title="Consentimiento vigente">
          <Row label="Versión" value={c.version ?? '—'} />
          <Row label="Compartido con la organización" value={c.shareWithOrg ? 'Sí' : 'No (solo vos)'} />
          <Button title="Revocar consentimiento" kind="danger" onPress={revoke} />
          <Button title="Volver" kind="secondary" onPress={() => router.replace('/')} />
        </Card>
      ) : (
        <Card title="Tu consentimiento">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Switch value={share} onValueChange={setShare} accessibilityLabel="Compartir con mi organización" />
            <Text style={{ flex: 1 }}>Compartir mis recorridos con los miembros de mi organización (owner, administradores y lectores).</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Switch value={accepted} onValueChange={setAccepted} accessibilityLabel="Acepto" />
            <Text style={{ flex: 1 }}>Leí lo anterior y acepto que esta app registre mi ubicación mientras el seguimiento esté activo (versión {CURRENT_CONSENT_VERSION}).</Text>
          </View>
          {current.data === null && <Banner kind="info" text="Al aceptar, este teléfono se vincula a tu cuenta." />}
          <ErrorText error={error} />
          <Button title="Aceptar y continuar" onPress={() => void grant()} disabled={!accepted} busy={busy} />
        </Card>
      )}
    </Screen>
  );
}
