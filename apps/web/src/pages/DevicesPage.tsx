import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { DeviceSummary, SessionSummary } from '@geo/shared';
import { Fragment, useState } from 'react';
import { api } from '../lib/api';
import { CONNECTION_LABEL, fmtAgo, fmtDateTime } from '../lib/format';
import { DemoBadge, ErrorBox } from '../App';

export function DevicesPage() {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceSummary[]>('/v1/devices'), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ id, action, name }: { id: string; action: 'revoke' | 'delete' | 'rename'; name?: string }) =>
      action === 'revoke'
        ? api(`/v1/devices/${id}/revoke`, { method: 'POST' })
        : action === 'delete'
          ? api(`/v1/devices/${id}`, { method: 'DELETE' })
          : api(`/v1/devices/${id}`, { method: 'PATCH', json: { name } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['devices'] }),
  });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dispositivos</h1>
      </div>
      <details className="panel small">
        <summary>¿Cómo vincular un teléfono y qué significan los estados?</summary>
        <p>
          Los teléfonos se vinculan desde la app móvil: iniciar sesión → aceptar el consentimiento → permitir ubicación. Solo el titular del teléfono puede otorgar o revocar su consentimiento; los demás miembros de la organización ven sus datos únicamente si el titular eligió compartirlos.
        </p>
        <ul>
          {Object.entries(CONNECTION_LABEL).map(([k, v]) => (
            <li key={k}>
              <span className={`badge conn-${k}`}>{v.label}</span> {v.help}.
            </li>
          ))}
        </ul>
        <p>Un dispositivo nunca figura "en línea" por tener una posición histórica: el estado depende del último contacto real con el servidor.</p>
      </details>
      <ErrorBox error={devices.error ?? act.error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Titular</th>
              <th>Estado</th>
              <th>Último contacto</th>
              <th>Última posición</th>
              <th>Sync pendiente</th>
              <th>Consentimiento</th>
              <th>App</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.data?.map((d) => (
              <Fragment key={d.id}>
                <tr>
                  <td>
                    <button className="link" onClick={() => setOpen(open === d.id ? null : d.id)}>
                      {d.name}
                    </button>{' '}
                    {d.isDemo && <DemoBadge />}
                  </td>
                  <td>{d.holder.displayName}</td>
                  <td>
                    {d.status === 'revoked' ? (
                      <span className="badge revoked">Revocado</span>
                    ) : (
                      <span className={`badge conn-${d.connectionState}`} title={CONNECTION_LABEL[d.connectionState].help}>
                        {CONNECTION_LABEL[d.connectionState].label}
                      </span>
                    )}
                  </td>
                  <td title={fmtDateTime(d.lastContactAt)}>{fmtAgo(d.lastContactAt)}</td>
                  <td className="small">
                    {d.lastPoint ? (
                      <>
                        capturada {fmtDateTime(d.lastPoint.capturedAt)}
                        <br />
                        <span className="muted">recibida {fmtDateTime(d.lastPoint.receivedAt)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{d.sync.clientPendingCount == null ? '—' : d.sync.clientPendingCount ? <span className="badge warn">{d.sync.clientPendingCount}</span> : '0'}</td>
                  <td className="small">{d.consent.active ? (d.consent.shareWithOrg ? 'Vigente · compartido con la organización' : 'Vigente · solo titular') : d.isDemo ? 'n/a (demo)' : 'No otorgado'}</td>
                  <td className="small">{d.appVersion ?? '—'}</td>
                  <td className="actions">
                    <Link className="btn small ghost" to={`/map?device=${d.id}`}>
                      Mapa
                    </Link>
                    {d.canManage && (
                      <>
                        <button
                          className="btn small ghost"
                          onClick={() => {
                            const name = prompt('Nuevo nombre', d.name);
                            if (name) act.mutate({ id: d.id, action: 'rename', name });
                          }}
                        >
                          Renombrar
                        </button>
                        {d.status === 'active' && !d.isDemo && (
                          <button className="btn small ghost danger" onClick={() => confirm(`¿Revocar el acceso de "${d.name}"? Deja de poder enviar ubicaciones. El historial se conserva según la retención.`) && act.mutate({ id: d.id, action: 'revoke' })}>
                            Revocar
                          </button>
                        )}
                        <button className="btn small ghost danger" onClick={() => confirm(`¿Eliminar "${d.name}" y TODO su historial? No se puede deshacer.`) && act.mutate({ id: d.id, action: 'delete' })}>
                          Eliminar
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                {open === d.id && (
                  <tr>
                    <td colSpan={9}>
                      <Sessions deviceId={d.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!devices.data?.length && !devices.isLoading && <p className="muted">No hay dispositivos visibles.</p>}
      </div>
    </div>
  );
}

function Sessions({ deviceId }: { deviceId: string }) {
  const q = useQuery({ queryKey: ['sessions', deviceId], queryFn: () => api<SessionSummary[]>(`/v1/devices/${deviceId}/sessions?limit=20`) });
  if (!q.data) return <span className="muted">Cargando…</span>;
  if (!q.data.length) return <span className="muted">Sin seguimientos registrados.</span>;
  return (
    <table className="table small inner">
      <thead>
        <tr>
          <th>Inicio</th>
          <th>Fin</th>
          <th>Modo</th>
          <th>Puntos</th>
          <th>Motivo de fin</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {q.data.map((s) => (
          <tr key={s.id}>
            <td>{fmtDateTime(s.startedAt)}</td>
            <td>{s.endedAt ? fmtDateTime(s.endedAt) : <span className="badge conn-online">En curso</span>}</td>
            <td>{s.mode}</td>
            <td>{s.pointCount}</td>
            <td>{s.endReason ?? '—'}</td>
            <td>
              {s.firstPointAt && (
                <Link to={`/map?device=${deviceId}&from=${new Date(Date.parse(s.firstPointAt) - 60_000).toISOString()}&to=${new Date(Date.parse(s.lastPointAt!) + 60_000).toISOString()}`}>Ver recorrido</Link>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
