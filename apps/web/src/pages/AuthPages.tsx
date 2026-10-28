import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { HttpError, login, register } from '../lib/api';

type Mode = 'login' | 'register' | 'forgot';

export function AuthPage({ mode }: { mode: Mode }) {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else if (mode === 'register') await register(email, password, name);
      else {
        const r = await fetch('/api/v1/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        if (!r.ok && r.status !== 202) throw new HttpError(r.status, 'ERR', 'No se pudo enviar la solicitud');
        setInfo('Si existe una cuenta con ese email, vas a recibir un enlace para elegir una nueva contraseña (vence en 30 minutos).');
        return;
      }
      nav(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      const e2 = err as HttpError;
      setError(e2.details && Array.isArray(e2.details) ? (e2.details as { message: string }[]).map((d) => d.message).join('. ') : e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand big">
          <span className="brand-dot" /> Geotrazabilidad
        </div>
        <h1>{mode === 'login' ? 'Iniciar sesión' : mode === 'register' ? 'Crear cuenta' : 'Recuperar contraseña'}</h1>
        {mode === 'register' && (
          <label>
            Nombre
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        {mode !== 'forgot' && (
          <label>
            Contraseña
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 10 : 1}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
            {mode === 'register' && <span className="muted small">Mínimo 10 caracteres.</span>}
          </label>
        )}
        {error && <div className="alert error">{error}</div>}
        {info && <div className="alert info">{info}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Procesando…' : mode === 'login' ? 'Ingresar' : mode === 'register' ? 'Crear cuenta' : 'Enviar enlace'}
        </button>
        <div className="auth-links">
          {mode !== 'login' && <Link to="/login">Ya tengo cuenta</Link>}
          {mode !== 'register' && <Link to="/register">Crear una cuenta</Link>}
          {mode === 'login' && <Link to="/forgot-password">Olvidé mi contraseña</Link>}
        </div>
        <p className="muted small">
          Las ubicaciones son datos personales sensibles. Solo se registran desde dispositivos cuyo titular dio su consentimiento explícito en la app móvil.
        </p>
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'done' | string>('idle');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await fetch('/api/v1/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: params.get('token') ?? '', password }),
    });
    if (r.ok) setState('done');
    else setState(((await r.json().catch(() => null)) as { error?: { message: string } } | null)?.error?.message ?? 'No se pudo cambiar la contraseña');
  };
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>Nueva contraseña</h1>
        {state === 'done' ? (
          <>
            <div className="alert info">Contraseña actualizada. Se cerraron las sesiones web anteriores.</div>
            <Link className="btn primary" to="/login">
              Iniciar sesión
            </Link>
          </>
        ) : (
          <>
            <label>
              Nueva contraseña
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoComplete="new-password" />
            </label>
            {state !== 'idle' && <div className="alert error">{state}</div>}
            <button className="btn primary">Guardar</button>
          </>
        )}
      </form>
    </div>
  );
}
