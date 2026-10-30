import type { ExpoConfig } from 'expo/config';

/**
 * Configuración de la app. Los permisos de ubicación en segundo plano son explícitos y su texto
 * explica el uso real. No hay rastreo oculto: Android muestra una notificación persistente
 * (foreground service) y iOS el indicador azul mientras se registra.
 */
const config: ExpoConfig = {
  name: 'Geotrazabilidad',
  slug: 'geotrazabilidad',
  owner: 'smansilla',
  scheme: 'geotrazabilidad',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.smansilla.geotrazabilidad',
    supportsTablet: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'Usamos tu ubicación para registrar el recorrido mientras el seguimiento está activo.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Con "Permitir siempre" el recorrido se sigue registrando con la pantalla bloqueada. Podés detener el seguimiento o revocar el permiso cuando quieras.',
    },
  },
  android: {
    package: 'com.smansilla.geotrazabilidad',
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_LOCATION'],
    // Permisos de la plantilla que esta app no usa: se bloquean (privacidad y revisión de Google Play).
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-secure-store',
    '@maplibre/maplibre-react-native',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Con "Permitir siempre" el recorrido se sigue registrando con la pantalla bloqueada. Podés detener el seguimiento o revocar el permiso cuando quieras.',
        locationWhenInUsePermission: 'Usamos tu ubicación para registrar el recorrido mientras el seguimiento está activo.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? 'development',
    // Proyecto en expo.dev: https://expo.dev/accounts/smansilla/projects/geotrazabilidad
    eas: { projectId: '10d5454d-85cb-4fed-9320-91737f3a3491' },
  },
};

export default config;
