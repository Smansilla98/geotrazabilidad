import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgRole, TrackingConfigResponse } from '@geo/shared';
import { api, download } from '../lib/api';
import { ErrorBox, usePrimaryOrg } from '../App';

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Administrador', viewer: 'Lector' };

export function SettingsPage() {
  const qc = useQueryClient();
  const { orgId, role, me } = usePrimaryOrg();
  const membership = me?.memberships.find((m) => m.orgId === orgId);
  const [retention, setRetention] = useState<number | ''>('');
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<OrgRole>('viewer');
  const [err, setErr] = useState<unknown>(null);
  const members = useQuery({
    queryKey: ['members', orgId],
    enabled: !!orgId,
    queryFn: () => api<Array<{ id: string; email: string; displayName: string; role: OrgRole }>>(`/v1/orgs/${orgId}/members`),
  });
  const cfg = useQuery({ queryKey: ['tracking-config', orgId], enabled: !!orgId, queryFn: () => api<TrackingConfigResponse>(`/v1/orgs/${orgId}/tracking-config`) });
  const saveOrg = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}`, { method: 'PATCH', json: { retentionDays: Number(retention) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const addMember = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/members`, { method: 'POST', json: { email, role: newRole } }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/v1/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
  });

  return (
    <div className="page settings">
      <h1>Configuración</h1>
      <div className="grid-2">
        <section className="panel">
          <h2>Organización: {membership?.orgName}</h2>
          <p className="small">
            Tu rol: <strong>{role ? ROLE_LABEL[role] : '—'}</strong>
          </p>
          <h3>Retención de ubicaciones</h3>
          <p className="small muted">
            Las posiciones y los eventos más antiguos que este plazo se eliminan automáticamente una vez por día. Valor actual: <strong>{membership?.retentionDays} días</strong>.
          </p>
          {role === 'owner' && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                saveOrg.mutate();
              }}
            >
              <input type="number" min={1} max={3650} placeholder="días" value={retention} onChange={(e) => setRetention(e.target.value ? Number(e.target.value) : '')} aria-label="Días de retención" />
              <button className="btn small primary" disabled={!retention}>
                Guardar
              </button>
            </form>
          )}
          <ErrorBox error={saveOrg.error} />
          <h3>Miembros</h3>
          <ul className="list">
            {members.data?.map((m) => (
              <li key={m.id}>
                <div>
                  <strong>{m.displayName}</strong> <span className="muted small">{m.email}</span>
                  <div className="small">{ROLE_LABEL[m.role]}</div>
                </div>
                {(role === 'owner' || role === 'admin') && m.id !== me?.id && (
                  <button className="btn small ghost danger" onClick={() => removeMember.mutate(m.id)}>
                    Quitar
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(role === 'owner' || role === 'admin') && (
            <form
              className="row wrap"
              onSubmit={(e) => {
                e.preventDefault();
                addMember.mutate();
              }}
            >
              <input type="email" placeholder="email de una cuenta existente" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as OrgRole)}>
                <option value="viewer">Lector</option>
                <option value="admin">Administrador</option>
                {role === 'owner' && <option value="owner">Owner</option>}
              </select>
              <button className="btn small primary">Agregar</button>
            </form>
          )}
          <ErrorBox error={addMember.error ?? removeMember.error} />
          <p className="small muted">
            Owner: todo, incluida la retención. Administrador: dispositivos, viajes, geocercas y miembros. Lector: solo consulta. Nadie ve la ubicación de un teléfono ajeno si su titular no la compartió con la organización.
          </p>
        </section>
        <section className="panel">
          <h2>Privacidad y datos propios</h2>
          <p className="small">Podés descargar todos los datos de los dispositivos de los que sos titular (posiciones, consentimientos y perfil).</p>
          <button className="btn small" onClick={() => download('/v1/me/export', 'mis-datos.json').catch(setErr)}>
            Exportar mis datos (JSON)
          </button>
          <ErrorBox error={err} />
          <p className="small">Para dejar de compartir tu ubicación, revocá el consentimiento desde la app móvil o eliminá el dispositivo en "Dispositivos" (borra todo su historial).</p>
          <h2>Estrategia de captura</h2>
          <p className="small muted">
            Parámetros que la app recibe del servidor (versión {cfg.data?.version ?? '—'}{cfg.data?.version === 0 ? ', valores por defecto' : ''}). La app tiene valores locales seguros para operar sin conexión.
          </p>
          {cfg.data && (
            <div className="table-wrap">
              <table className="table small">
                <thead>
                  <tr>
                    <th>Modo</th>
                    <th>Precisión</th>
                    <th>Dist. mín.</th>
                    <th>Máx. sin punto (mov.)</th>
                    <th>Latido detenido</th>
                    <th>Sync</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(cfg.data.modes).map(([mode, p]) => (
                    <tr key={mode}>
                      <td>{{ battery_saver: 'Ahorro', normal: 'Normal', trip: 'Viaje', intensive: 'Intensivo' }[mode]}</td>
                      <td>{p.accuracy}</td>
                      <td>{p.minDistanceM} m</td>
                      <td>{p.maxIntervalMovingS} s</td>
                      <td>{Math.round(p.stationaryIntervalS / 60)} min</td>
                      <td>{p.syncIntervalS} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
