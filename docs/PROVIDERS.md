# Proveedores externos: mapas, geocodificación y rutas

Cada capacidad es un **módulo separado con su propia interfaz**. No se asume que un proveedor de teselas también ofrezca rutas, geocodificación, tráfico o matrices.

## 1. Teselas y estilo de mapa (web y móvil, MapLibre)

| Opción | Clave | Costo | Notas | Uso propuesto |
|---|---|---|---|---|
| **OpenFreeMap** | No | Gratis | Teselas vectoriales OSM, estilos listos para MapLibre, sin límites publicados. Requiere atribución a OpenMapTiles y OSM | **Por defecto en MVP y desarrollo** |
| MapTiler Cloud | Sí, pública y restringible por dominio | Free tier, después pago | SLA, estilos satelitales e híbridos | **Producción recomendada** si se necesita SLA o capa satelital |
| Protomaps (PMTiles autoalojado) | No | Almacenamiento y egreso propios | Un archivo PMTiles servido desde un bucket o CDN | Si se quiere independencia total |
| tile.openstreetmap.org (raster) | No | Gratis con política de uso | **No apto** para una app con tráfico: la política prohíbe uso intensivo y apps sin acuerdo | No se usa |

La configuración es `MAP_STYLE_URL` (web, leída en runtime) y `EXPO_PUBLIC_MAP_STYLE_URL` (móvil). La atribución se muestra siempre en ambos mapas. Si el proveedor necesita clave, esta es **pública** (va al navegador o al bundle), así que tiene que estar restringida por dominio o bundle id en el panel del proveedor.

## 2. Rutas (ruta estimada, ETA base)

> **Decisión del propietario (2026-10-27): servidor demo de OSRM** (`OSRM_BASE_URL=https://router.project-osrm.org`). Verificado en vivo. Limitaciones aceptadas: sin SLA, sin tráfico, solo perfil `driving` (la API rechaza otros perfiles con ese servidor) y política de uso no apta para tráfico de producción. Cambiar a OSRM propio o GraphHopper es solo cambiar `OSRM_BASE_URL` o agregar un adaptador.

| Opción | Clave | Tráfico | Map matching | Notas |
|---|---|---|---|---|
| **OSRM autoalojado** | No | No | Sí (`/match`) | Recomendado si se acota la región: el extracto de Argentina se procesa en minutos y necesita unos 2–4 GB de RAM. En Railway sería un servicio aparte con volumen. |
| OSRM demo (`router.project-osrm.org`) | No | No | Sí | **Solo para desarrollo y pruebas manuales.** Su política prohíbe el uso en producción y no tiene SLA. |
| GraphHopper Directions API | Sí | No en el plan estándar | Sí (Map Matching API) | Opción administrada sin infraestructura. Tiene free tier limitado. |
| openrouteservice | Sí | No | No como API general | Alternativa administrada para rutas. |
| Valhalla autoalojado | No | No | Sí (`trace_attributes`) | Más flexible y más complejo de operar. |
| Google, HERE, TomTom, Mapbox | Sí | **Sí** | Varía | Son los únicos con tráfico en tiempo real. Pagos y con restricciones de almacenamiento o uso con mapas de terceros que hay que revisar antes. |

Implementación: interfaz `RoutingProvider` con `route(origin, destination, profile)` y, opcionalmente, `match(points)`. Hay adaptadores `osrm` (URL base configurable) y `graphhopper`, más un fallback `straight_line` que **siempre** se marca como `duration_kind = basic_estimate`.

- **Sin tráfico:** ningún proveedor gratuito da tráfico en tiempo real. El ETA se presenta como "estimado sin tráfico", con proveedor y momento del cálculo.
- **ETA durante el viaje:** `restante_en_ruta / velocidad_media_observada_reciente`. Solo se muestra si hay al menos 5 min de datos en movimiento y una cobertura razonable. Se etiqueta "estimación básica".

## 3. Geocodificación (búsqueda de origen y destino)

| Opción | Clave | Notas |
|---|---|---|
| Nominatim público | No | 1 req/s, sin autocompletar, `User-Agent` identificable obligatorio. **Solo para desarrollo o bajo volumen.** |
| Photon (komoot, público o autoalojado) | No | Sirve para autocompletar. La instancia pública es de mejor esfuerzo. |
| MapTiler Geocoding / LocationIQ | Sí | Producción con cuota. |

En el MVP la geocodificación es **opcional**: origen y destino se eligen tocando el mapa o desde una geocerca. El módulo `GeocodingProvider` se habilita con `GEOCODING_PROVIDER` y las llamadas pasan por la API, que cachea y limita la frecuencia sin exponer claves.

## 4. Otros servicios

| Servicio | Necesario para | Desarrollo | Producción |
|---|---|---|---|
| SMTP | Recuperación de contraseña | Mailpit (docker-compose) | Cualquier SMTP transaccional (Resend, Postmark, SES…). **Pago o con free tier** |
| Apple Developer Program | Instalar en iPhone físico o publicar | Obligatorio para probar en dispositivo | USD 99/año |
| Google Play Console | Publicar en Android | No hace falta para APK de prueba | USD 25 único. Si se publica, Google revisa la declaración de ubicación en segundo plano |
| EAS Build (Expo) | Compilar binarios en la nube | Opcional: también se compila localmente | Free tier limitado |

## 5. Dependencias que requieren decisión o clave antes de producción

1. Proveedor de rutas: OSRM autoalojado (costo de RAM en Railway) o GraphHopper (clave y cuota).
2. Proveedor de teselas para producción: OpenFreeMap (sin SLA) o MapTiler (clave).
3. Proveedor SMTP.
4. Cuentas de Apple y Google para distribuir la app.
