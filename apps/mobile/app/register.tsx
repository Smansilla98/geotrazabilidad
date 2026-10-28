import { useState } from 'react';
import { useRouter } from 'expo-router';
import { register } from '../src/api';
import { Button, ErrorText, Field, Muted, Screen } from '../src/ui';

export default function RegisterScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await register(email.trim().toLowerCase(), password, name.trim());
      router.replace('/privacy');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Field label="Nombre" value={name} onChangeText={setName} autoComplete="name" />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Contraseña (mínimo 10 caracteres)" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />
      <ErrorText error={error} />
      <Button title="Crear cuenta" onPress={() => void submit()} busy={busy} disabled={!name || !email || password.length < 10} />
      <Muted>Al crear la cuenta se crea también tu organización personal. Nadie ve tu ubicación salvo que vos la compartas.</Muted>
    </Screen>
  );
}
