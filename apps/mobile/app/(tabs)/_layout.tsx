import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { C } from '../../src/ui';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: C.accent, headerTintColor: C.text }}>
      <Tabs.Screen name="index" options={{ title: 'Seguimiento', tabBarIcon: icon('⌖') }} />
      <Tabs.Screen name="history" options={{ title: 'Historial', tabBarIcon: icon('☰') }} />
      <Tabs.Screen name="events" options={{ title: 'Eventos', tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="trips" options={{ title: 'Viajes', tabBarIcon: icon('⇢') }} />
      <Tabs.Screen name="more" options={{ title: 'Más', tabBarIcon: icon('⋯') }} />
    </Tabs>
  );
}
