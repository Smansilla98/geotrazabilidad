import { useState } from 'react';
import { APP_ENV, apiUrl, setApiOverride } from '../src/config';
import { syncNow } from '../src/tracking';
import { Button, Card, Field, fmtDT, Muted, Row, Screen, useTracking } from '../src/ui';
import { StatusBanners } from './(tabs)/index';

/** Estado de sincronización: cola local, último envío, conectividad y servidor configurado. */
export default function SyncScreen() {
  const st = useTracking();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const last = st.lastSync;
  return (
    <Screen>
      <StatusBanners />
      <Card title="Cola local">
        <Row label="Pendientes de enviar" value={String(st.pending)} />
        <Row label="Rechazados por el servidor" value={String(st.rejected)} />
        <Row label="Conexión" value={st.online == null ? 'desconocida' : st.online ? 'disponible' : 'sin conexión'} />
        <Row label="Última sincronización" value={fmtDT(st.lastSyncAt)} />
        <Row label="Resultado" value={!last ? '—' : last.kind === 'sent' ? `${last.accepted} aceptados, ${last.duplicates} duplicados, ${last.rejected} rechazados` : last.kind === 'retry' ? `reintento: ${last.reason}` : last.kind === 'blocked' ? `bloqueado (${last.reason})` : 'nada pendiente'} />
        <Muted>Cada posición se guarda en el teléfono antes de enviarse. Reenviar nunca crea duplicados: el servidor reconoce cada registro por su identificador.</Muted>
        <Button title="Sincronizar ahora" busy={busy} onPress={async () => { setBusy(true); await syncNow(); setBusy(false); }} />
      </Card>
      <Card title="Servidor">
        <Row label="Entorno" value={APP_ENV} />
        <Row label="API" value={(() => { try { return apiUrl(); } catch (e) { return (e as Error).message; } })()} />
        {APP_ENV !== 'production' && (
          <>
            <Field label="Cambiar URL (solo builds de desarrollo)" value={url} onChangeText={setUrl} autoCapitalize="none" placeholder="http://192.168.0.10:3000" />
            <Button title="Guardar URL" kind="secondary" onPress={() => void setApiOverride(url || null)} />
          </>
        )}
      </Card>
    </Screen>
  );
}
