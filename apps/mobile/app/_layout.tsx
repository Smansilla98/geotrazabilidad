// La tarea de ubicación debe definirse al cargar el módulo (también en el contexto de segundo plano).
import '../src/tracking';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Network from 'expo-network';
import { loadApiOverride } from '../src/config';
import { getDevice, getUserSession } from '../src/credentials';
import { paramsFor, refreshPermission, refreshRemoteConfig, refreshStatus, sendHeartbeat, setOnline, syncNow, getStatus } from '../src/tracking';
import { C } from '../src/ui';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const [ready, setReady] = useState(false);

  // Navegación según estado: sin sesión → login; sin dispositivo vinculado o sin consentimiento → privacidad.
  useEffect(() => {
    void (async () => {
      await loadApiOverride();
      const user = await getUserSession();
      const device = await getDevice();
      const inAuth = segments[0] === 'login' || segments[0] === 'register';
      if (!user && !device && !inAuth) router.replace('/login');
      else if (user && !device && segments[0] !== 'privacy') router.replace('/privacy');
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments[0]]);

  // Sincronización en primer plano: al abrir, al volver a la app, al recuperar conexión y periódicamente.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      await refreshPermission().catch(() => null);
      await refreshStatus().catch(() => null);
      if (await getDevice()) {
        await syncNow();
        await sendHeartbeat();
      }
    };
    void refreshRemoteConfig().then(tick);
    const schedule = async () => {
      const p = await paramsFor(getStatus().mode);
      if (timer) clearInterval(timer);
      timer = setInterval(() => void tick(), Math.max(30, p.syncIntervalS) * 1000);
    };
    void schedule();
    const appSub = AppState.addEventListener('change', (st) => st === 'active' && void tick());
    const netSub = Network.addNetworkStateListener((st) => {
      setOnline(st.isInternetReachable ?? st.isConnected ?? null);
      if (st.isInternetReachable) void tick();
    });
    void Network.getNetworkStateAsync().then((st) => setOnline(st.isInternetReachable ?? st.isConnected ?? null));
    return () => {
      if (timer) clearInterval(timer);
      appSub.remove();
      netSub.remove();
    };
  }, []);

  if (!ready) return null;
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTintColor: C.accent, contentStyle: { backgroundColor: C.bg } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ title: 'Iniciar sesión', headerBackVisible: false }} />
        <Stack.Screen name="register" options={{ title: 'Crear cuenta' }} />
        <Stack.Screen name="privacy" options={{ title: 'Privacidad y consentimiento' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Detalle del recorrido' }} />
        <Stack.Screen name="trip/[id]" options={{ title: 'Viaje' }} />
        <Stack.Screen name="geofences" options={{ title: 'Geocercas' }} />
        <Stack.Screen name="devices" options={{ title: 'Dispositivos vinculados' }} />
        <Stack.Screen name="sync" options={{ title: 'Sincronización y conexión' }} />
        <Stack.Screen name="profile" options={{ title: 'Perfil' }} />
      </Stack>
    </>
  );
}
