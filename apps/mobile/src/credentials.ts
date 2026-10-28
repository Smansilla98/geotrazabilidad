import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/**
 * Credenciales en el almacenamiento seguro del sistema (Keychain / Keystore).
 * - Sesión de usuario: para las pantallas de consulta.
 * - Credencial del dispositivo: la única que se usa para enviar ubicaciones.
 */
export interface UserSession {
  accessToken: string;
  refreshToken: string;
}
export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
  refreshToken: string;
}

const K = { user: 'user_session', device: 'device_credentials', install: 'install_id' } as const;
// En segundo plano el dispositivo puede estar bloqueado: la credencial del dispositivo debe ser legible.
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

async function getJson<T>(key: string): Promise<T | null> {
  const v = await SecureStore.getItemAsync(key, OPTS);
  return v ? (JSON.parse(v) as T) : null;
}

export const getUserSession = () => getJson<UserSession>(K.user);
export const setUserSession = (s: UserSession | null) => (s ? SecureStore.setItemAsync(K.user, JSON.stringify(s), OPTS) : SecureStore.deleteItemAsync(K.user, OPTS));
export const getDevice = () => getJson<DeviceCredentials>(K.device);
export const setDevice = (d: DeviceCredentials | null) => (d ? SecureStore.setItemAsync(K.device, JSON.stringify(d), OPTS) : SecureStore.deleteItemAsync(K.device, OPTS));

/** Identificador estable de esta instalación (se regenera si se reinstala la app). */
export async function getInstallId(): Promise<string> {
  let id = await SecureStore.getItemAsync(K.install, OPTS);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(K.install, id, OPTS);
  }
  return id;
}
