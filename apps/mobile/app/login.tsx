import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { forgotPassword, login } from '../src/api';
import { getDevice } from '../src/credentials';
import { Button, ErrorText, Field, Muted, Screen, s } from '../src/ui';

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim().toLowerCase(), password);
      router.replace((await getDevice()) ? '/' : '/privacy');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Text style={s.h1}>Geotrazabilidad</Text>
      <Muted>Registrá tus recorridos con tu consentimiento explícito. Podés detener el seguimiento o revocar el acceso en cualquier momento.</Muted>
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Contraseña" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
      <ErrorText error={error} />
      <Button title="Ingresar" onPress={() => void submit()} busy={busy} disabled={!email || !password} />
      <Button
        title="Olvidé mi contraseña"
        kind="secondary"
        onPress={() => {
          if (!email) return Alert.alert('Ingresá tu email primero');
          void forgotPassword(email.trim().toLowerCase()).then(() => Alert.alert('Revisá tu correo', 'Si existe una cuenta con ese email, recibirás un enlace para elegir una nueva contraseña.'));
        }}
      />
      <Link href="/register" style={{ color: '#0f766e', textAlign: 'center', padding: 8 }}>
        Crear una cuenta
      </Link>
    </Screen>
  );
}
