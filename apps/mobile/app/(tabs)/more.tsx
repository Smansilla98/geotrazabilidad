import { Pressable, Text } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { Card, Muted, Screen, s } from '../../src/ui';

const ITEMS: { href: Href; title: string; sub: string }[] = [
  { href: '/sync', title: 'Sincronización y conexión', sub: 'Registros pendientes, último envío, servidor' },
  { href: '/geofences', title: 'Geocercas', sub: 'Zonas configuradas por tu organización' },
  { href: '/devices', title: 'Dispositivos vinculados', sub: 'Tus teléfonos y su estado' },
  { href: '/privacy', title: 'Privacidad y consentimiento', sub: 'Qué se registra y cómo revocarlo' },
  { href: '/profile', title: 'Perfil', sub: 'Cuenta, organización y cierre de sesión' },
];

export default function MoreScreen() {
  const router = useRouter();
  return (
    <Screen>
      <Card>
        {ITEMS.map((i) => (
          <Pressable key={String(i.href)} style={s.item} onPress={() => router.push(i.href)} accessibilityRole="button">
            <Text style={{ fontWeight: '600', fontSize: 15 }}>{i.title}</Text>
            <Muted>{i.sub}</Muted>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}
