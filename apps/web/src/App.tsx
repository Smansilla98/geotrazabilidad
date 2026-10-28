import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import type { MeResponse } from '@geo/shared';
import { api, logout, onAuthChange, openStream, tryRefresh, type StreamState } from './lib/api';

type SessionState = { status: 'loading' } | { status: 'anon' } | { status: 'authed' };

const LiveContext = createContext<StreamState>('closed');
export const useLiveState = () => useContext(LiveContext);

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/v1/me') });
}

/** Rol más alto del usuario en su organización principal (la UI lo usa solo para ocultar acciones; el servidor decide). */
export function usePrimaryOrg() {
  const me = useMe().data;
  const m = me?.memberships.find((x) => x.role === 'owner') ?? me?.memberships[0];
  return { orgId: m?.orgId, role: m?.role, canWrite: m?.role === 'owner' || m?.role === 'admin', me };
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const location = useLocation();
  useEffect(() => {
    let alive = true;
    const off = onAuthChange((authed) => alive && setState({ status: authed ? 'authed' : 'anon' }));
    void tryRefresh().then((ok) => alive && setState({ status: ok ? 'authed' : 'anon' }));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (state.status === 'loading') return <div className="center-screen">Cargando sesión…</div>;
  if (state.status === 'anon') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

const NAV = [
  { to: '/', label: 'Panel', icon: '◧' },
  { to: '/map', label: 'Mapa y recorridos', icon: '⌖' },
  { to: '/events', label: 'Eventos', icon: '≣' },
  { to: '/trips', label: 'Viajes', icon: '⇢' },
  { to: '/geofences', label: 'Geocercas', icon: '◎' },
  { to: '/devices', label: 'Dispositivos', icon: '▣' },
  { to: '/settings', label: 'Configuración', icon: '⚙' },
];

const LIVE_LABEL: Record<StreamState, string> = {
  connecting: 'Conectando…',
  open: 'Tiempo real activo',
  reconnecting: 'Reconectando…',
  closed: 'Sin tiempo real',
};

export function AppLayout() {
  const qc = useQueryClient();
  const [live, setLive] = useState<StreamState>('connecting');
  const { me } = usePrimaryOrg();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    // Los avisos solo indican qué cambió; se vuelve a consultar la API con los permisos del usuario.
    return openStream((type, data) => {
      const d = data as { deviceId?: string };
      if (type === 'resync') return void qc.invalidateQueries();
      if (type === 'points' || type === 'events' || type === 'device') {
        void qc.invalidateQueries({ queryKey: ['stats'] });
        void qc.invalidateQueries({ queryKey: ['devices'] });
        if (d.deviceId) {
          void qc.invalidateQueries({ queryKey: ['track', d.deviceId] });
          void qc.invalidateQueries({ queryKey: ['events'] });
          void qc.invalidateQueries({ queryKey: ['trips'] });
        }
      }
    }, setLive);
  }, [qc]);

  return (
    <LiveContext.Provider value={live}>
      <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-dot" /> Geotrazabilidad
          </div>
          <nav>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className={`live live-${live}`} title="Avisos de cambios en tiempo real (SSE)">
              <span className="live-dot" /> {LIVE_LABEL[live]}
            </div>
            <div className="me">
              <div className="me-name">{me?.displayName}</div>
              <div className="muted small">{me?.email}</div>
            </div>
            <button className="btn ghost small" onClick={() => void logout().then(() => qc.clear())}>
              Cerrar sesión
            </button>
          </div>
        </aside>
        <button className="nav-toggle" aria-label="Abrir menú" onClick={() => setNavOpen((v) => !v)}>
          ☰
        </button>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </LiveContext.Provider>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="alert error" role="alert">
      {msg}
    </div>
  );
}

export function DemoBadge() {
  return (
    <span className="badge demo" title="Datos sintéticos de demostración: no provienen de un dispositivo real">
      DEMO
    </span>
  );
}
