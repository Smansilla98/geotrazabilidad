import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * URL de la API por entorno. Se toma de EXPO_PUBLIC_API_URL al compilar; en builds de desarrollo
 * se puede sobrescribir desde la pantalla de sincronización (útil para apuntar a la IP de la PC).
 * Nunca hay una URL de desarrollo fija en el código de producción.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; appEnv?: string };
export const APP_ENV = extra.appEnv ?? 'development';
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
export const MAP_STYLE_URL = process.env.EXPO_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';

const OVERRIDE_KEY = 'api_url_override';
let override: string | null = null;

export async function loadApiOverride() {
  if (APP_ENV === 'production') return;
  override = await SecureStore.getItemAsync(OVERRIDE_KEY);
}

export async function setApiOverride(url: string | null) {
  if (APP_ENV === 'production') return;
  override = url;
  if (url) await SecureStore.setItemAsync(OVERRIDE_KEY, url);
  else await SecureStore.deleteItemAsync(OVERRIDE_KEY);
}

export function apiUrl(): string {
  const url = override ?? extra.apiUrl;
  if (!url) throw new Error('Falta EXPO_PUBLIC_API_URL: configurá la URL de la API al compilar la app.');
  return url.replace(/\/$/, '');
}
