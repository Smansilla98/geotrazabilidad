# Límites reales de la captura de ubicación (Android / iOS)

> Basado en la documentación de `expo-location` para SDK 58 (consultada el 2026-10-27) y en el comportamiento conocido de las plataformas. Los puntos marcados **[verificar en dispositivo]** no pueden comprobarse en este entorno: no hay emulador ni teléfono conectado.

## Comunes

- **No funciona en Expo Go.** La captura en segundo plano requiere un development build (`expo prebuild` / EAS).
- **Si el usuario fuerza el cierre de la app, la captura se detiene** y solo vuelve cuando la app se abre de nuevo. La app lo detecta al reabrir (hueco + evento `capture_resumed`) y no lo oculta.
- La plataforma puede entregar posiciones **en ráfagas atrasadas** (deferred/batched). Por eso `captured_at` sale del timestamp del fix y no de la hora de llegada.
- `speed`, `heading`, `altitude` y `altitudeAccuracy` pueden venir nulos o en `-1`. Se normalizan a `null`.
- `mocked` indica ubicaciones simuladas: en Android, proveedor mock; en iOS, simulación por software.

## Android

| Tema | Comportamiento | Impacto en el diseño |
|---|---|---|
| Permisos | Primero `ACCESS_FINE/COARSE_LOCATION` y después `ACCESS_BACKGROUND_LOCATION`, que desde Android 11 **solo se concede en Ajustes**. Desde Android 12 el usuario puede dar solo ubicación aproximada | Flujo de permisos en dos pasos con explicación previa. Si solo hay ubicación aproximada, se avisa en la UI y los puntos quedan con `accuracy` alta |
| Foreground service | Obligatorio para la captura continua en segundo plano. Muestra una **notificación persistente**, que además cumple el requisito de indicador visible | `foregroundService.notificationTitle/Body` siempre presentes |
| Iniciar o reiniciar el servicio desde background | Desde Android 12 hay restricciones para iniciar foreground services desde segundo plano | **No** se reinicia `startLocationUpdatesAsync` desde la tarea de fondo para cambiar de modo. La adaptación en background se hace **filtrando en JS** (descartar o espaciar puntos), y la reconfiguración nativa ocurre al pasar a primer plano. **[verificar en dispositivo]** |
| App cerrada | No se relanza sola por eventos de ubicación ni de geocercas | Huecos esperables, documentados |
| Fabricantes (Xiaomi, Huawei, Samsung…) | Optimizaciones agresivas que matan servicios (ver dontkillmyapp.com) | Pantalla de ayuda con instrucciones para excluir la app de la optimización de batería. Heartbeat para detectar silencios |
| Geocercas nativas | Hasta 100 por app | No se usan en el MVP: las geocercas se evalúan en el servidor |
| Google Play | La ubicación en segundo plano requiere declaración y revisión de política | Documentado en el despliegue móvil |

## iOS

| Tema | Comportamiento | Impacto en el diseño |
|---|---|---|
| Permisos | "Al usar la app" y luego "Siempre". Si el usuario eligió "Permitir una vez", no se puede detectar y la solicitud de background devuelve denegado | Enlace a `app-settings:` y estado claro en la UI |
| Background | Requiere `UIBackgroundModes: location` (lo agrega el config plugin con `isIosBackgroundLocationEnabled`) | Config plugin |
| Indicador | `showsBackgroundLocationIndicator: true` muestra el indicador azul | Activado siempre |
| Pausa automática | `pausesUpdatesAutomatically` puede pausar las actualizaciones al detectar quietud y **no reanudarlas** sin interacción | Se deja en `false`. El ahorro se hace con `distanceInterval` y `deferredUpdates*` |
| App cerrada | Solo los cambios significativos (~500 m) o las regiones pueden relanzar la app | Huecos esperables. Uso de significant-change como mejora futura **[verificar en dispositivo]** |
| Geocercas nativas | Máximo 20 regiones simultáneas | No se usan en el MVP |
| Precisión reducida | El usuario puede desactivar la "ubicación precisa" | Se avisa en la UI |
| Distribución | Probar en un iPhone físico requiere cuenta Apple Developer | Dependencia externa |

## Lo que el sistema **no** promete

- Seguimiento continuo perfecto. Va a haber huecos por cierre forzado, optimización de batería, falta de permisos, modo avión o túneles. El sistema los **detecta y muestra** como discontinuidades. No los rellena.
- Precisión mejor que la que reporta el sistema operativo.
- ETA con tráfico sin un proveedor pago que lo ofrezca.
