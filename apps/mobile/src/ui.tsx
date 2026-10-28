import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { getStatus, subscribe } from './tracking';

export const C = {
  bg: '#f4f6f8', panel: '#ffffff', text: '#0f172a', muted: '#64748b', border: '#e2e8f0',
  accent: '#0f766e', danger: '#b91c1c', warn: '#b45309', ok: '#15803d', demo: '#6d28d9',
};

export const useTracking = () => useSyncExternalStore(subscribe, getStatus);

/** Carga asíncrona simple con reintento manual (sin dependencias extra). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await fn(), loading: false });
    } catch (e) {
      setState({ error: (e as Error).message, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => void run(), [run]);
  return { ...state, reload: run };
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return scroll ? (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {children}
    </ScrollView>
  ) : (
    <View style={[s.screen, { padding: 0 }]}>{children}</View>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={s.card}>
      {title && <Text style={s.cardTitle}>{title}</Text>}
      {children}
    </View>
  );
}

export function Button({ title, onPress, kind = 'primary', disabled, busy }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, kind === 'secondary' && s.btnSecondary, kind === 'danger' && s.btnDanger, (disabled || busy) && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={[s.btnText, kind === 'secondary' && { color: C.accent }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{props.label}</Text>
      <TextInput placeholderTextColor={C.muted} {...props} style={s.input} accessibilityLabel={props.label} />
    </View>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.value}>{value}</Text>
    </View>
  );
}

export function Banner({ kind, text }: { kind: 'ok' | 'warn' | 'danger' | 'info' | 'demo'; text: string }) {
  const color = { ok: C.ok, warn: C.warn, danger: C.danger, info: C.accent, demo: C.demo }[kind];
  return (
    <View style={[s.banner, { borderColor: color, backgroundColor: `${color}14` }]} accessibilityRole="alert">
      <Text style={{ color, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

export const Muted = ({ children }: { children: ReactNode }) => <Text style={s.muted}>{children}</Text>;
export const ErrorText = ({ error }: { error?: string | null }) => (error ? <Text style={{ color: C.danger }}>{error}</Text> : null);

export const fmtDT = (v: string | number | null | undefined) => (v == null ? '—' : new Date(v).toLocaleString('es-AR'));
export const fmtKm = (m: number | null | undefined) => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  card: { backgroundColor: C.panel, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: C.text },
  btn: { backgroundColor: C.accent, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.accent },
  btnDanger: { backgroundColor: C.danger },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  label: { fontSize: 13, fontWeight: '600', color: C.text },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 12, backgroundColor: '#fff', color: C.text, fontSize: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 3 },
  muted: { color: C.muted, fontSize: 13 },
  value: { color: C.text, fontSize: 14, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  banner: { borderWidth: 1, borderRadius: 10, padding: 10 },
  h1: { fontSize: 22, fontWeight: '800', color: C.text },
  item: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 2 },
});
