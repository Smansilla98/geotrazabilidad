# Estado del proyecto: funcionalidades, limitaciones y plan

Actualizado: 2026-10-30.

**Leyenda**
- ✅ Implementado **y verificado**, con la evidencia que se indica.
- 🟡 Implementado, pero sin verificación completa.
- ⏳ Pendiente.

Abreviaturas de evidencia:
- **U**: prueba unitaria.
- **I**: integración contra PostGIS real.
- **E2E**: Playwright en navegador real.
- **SIM**: `scripts/simulate-device.mjs`, que usa el mismo motor de sincronización que la app contra la API.
- **M**: verificación manual (curl o capturas).

## Matriz de funcionalidades

### Backend y datos
| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Esquema PostGIS, migraciones versionadas (0001–0003), runner con checksum y lock | ✅ | I (todas las suites migran desde cero), M (idempotente por CLI) |
| Registro, login, refresh rotativo con detección de reuso, logout, recuperación por email | ✅ | I `auth.test.ts` (7 pruebas) |
| Organizaciones y roles owner/admin/viewer, miembros, protección del último owner | ✅ | I `authz.test.ts` |
| Aislamiento entre usuarios: un id ajeno da 404 en todos los endpoints | ✅ | I, E2E, SIM |
| Vínculo de dispositivo, token de dispositivo revocable, consentimiento del titular | ✅ | I `ingest.test.ts`, `authz.test.ts` |
| Ingesta por lotes idempotente, validación por punto, límites de 500 puntos y 1 MB, desfase de reloj | ✅ | I (11 pruebas), SIM |
| Estado de sincronización y de conexión (online/recent/stale/offline/never) | ✅ | I, E2E (los demo nunca figuran conectados) |
| Configuración de captura remota por organización | ✅ | I (dispositivo la obtiene), U (validación) |
| Motor de reglas: calidad/saltos, huecos, detenciones, movimiento, cambio de rumbo, geocercas con permanencia e histéresis, llegada, desvío por corredor, inicio y fin de viaje | ✅ | U (25 pruebas de reglas), I (procesamiento), SIM |
| Reprocesamiento ante puntos atrasados (los eventos reemplazados quedan `superseded`) | ✅ | U, I |
| Reconstrucción de recorrido con discontinuidades y simplificación que conserva ids | ✅ | U, I `tracks-demo.test.ts` |
| Comparación planificado/real, avance y ETA básica | ✅ | U, I, E2E, SIM |
| Rutas OSRM (servidor demo) y línea recta como estimación básica | ✅ | M (ruta real de 2911 m, 185 vértices) |
| Exportaciones CSV/JSON/GeoJSON/GPX/KML, exportación de datos propios, auditoría | ✅ | U `formats.test.ts`, I, E2E (descarga de GPX) |
| Retención configurable y borrado diario | ✅ | I `retention.test.ts` |
| SSE en tiempo real con LISTEN/NOTIFY | ✅ | M (curl a través del proxy), SIM |
| Health checks reales, OpenAPI que cubre todas las rutas, logs JSON sin coordenadas | ✅ | I (prueba que compara rutas reales con las documentadas), M |
| Datos de demostración: 8 escenarios marcados DEMO | ✅ | I, E2E |

### Web
| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Auth (BFF, cookie httpOnly, CSRF), sesión persistente, logout | ✅ | E2E, M |
| Panel con indicadores reales y estado vacío | ✅ | E2E |
| Mapa con capas: calidad, huecos sin línea, outliers, geocercas, eventos, ruta planificada | ✅ | E2E (verifica que el worker de WebGL cargue), M (capturas) |
| Reproductor temporal: velocidad, avance por pasos, interpolación identificada, huecos | ✅ | E2E, U `geojson.test.ts` |
| Eventos: lista con filtros, paginación y abrir en el mapa | ✅ | E2E |
| Viajes: creación en el mapa, cálculo de ruta, comparación | ✅ | E2E (comparación); M (OSRM por API) |
| Geocercas: crear círculo o polígono, eliminar | 🟡 | El API está verificado (I); la UI de dibujo no tiene E2E |
| Dispositivos: estados, sesiones, renombrar, revocar, eliminar | 🟡 | El API está verificado (I); las acciones de UI no tienen E2E |
| Configuración: retención, miembros, exportar mis datos | 🟡 | El API está verificado (I); la UI no tiene E2E |
| Responsive para tablet y móvil | 🟡 | CSS implementado; solo se verificó visualmente en escritorio |

### App móvil
| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Login, registro, recuperación, privacidad y consentimiento, vínculo del dispositivo | 🟡 | Tipos y bundle OK; sin ejecutar en dispositivo |
| Captura en segundo plano (foreground service / Always) con modos y estrategia adaptativa | 🟡 | La estrategia está verificada (U, SIM); el SO real no |
| Cola SQLite persistente, sincronización idempotente con backoff, recuperación tras reinicio | ✅ lógica / 🟡 en dispositivo | U con SQLite real, SIM; falta expo-sqlite en un teléfono |
| Detección de captura interrumpida y reanudación | 🟡 | Implementado; requiere dispositivo |
| Mapa, historial, detalle, eventos, viajes y progreso, geocercas, dispositivos, sync, perfil (14 pantallas) | 🟡 | Tipos y bundle OK |
| Permisos Android correctos y permisos innecesarios bloqueados | ✅ | `expo prebuild`, inspección del manifiesto |

### Infraestructura
| Funcionalidad | Estado | Evidencia |
|---|---|---|
| docker-compose local, `.env.example` | ✅ | Uso continuo durante el desarrollo |
| CI de GitHub Actions (checks, e2e, simulación, móvil) | ✅ | Run 40696091025 en GitHub: los tres jobs en verde |
| Proyecto en expo.dev y perfiles EAS (`development`, `preview`, `production`) | ✅ preparado | `eas project:info`, `eas config` y bundle en una copia limpia con el hook de EAS; todavía no se lanzó un build en EAS |
| Railway IaC y comandos de build/arranque | ✅ preparado | Compila con los tipos oficiales; builds en limpio con `NODE_ENV=production`; PostGIS con `lost+found` |
| Despliegue en Railway | ⏳ | Sin cuenta ni CLI (ver RAILWAY_DEPLOYMENT.md) |

## Errores encontrados y corregidos por las pruebas
1. **Seguridad:** el margen de reuso de refresh tokens aceptaba tokens revocados explícitamente → se separó `replaced_at` de `revoked_at` (migración 0003).
2. **Seguridad:** la revocación por robo de token se deshacía por ROLLBACK → ahora se confirma antes de responder 401.
3. Node cortaba conexiones a servidores lejanos (OSRM) a los 250 ms (happy eyeballs) → timeout de 2 s.
4. El proxy de la web cancelaba todos los POST (`req.on('close')` se dispara al terminar de leer el cuerpo).
5. El mapa web quedaba en blanco en producción: faltaban el worker de MapLibre en el build y el MIME `.mjs`.
6. El build en Railway habría fallado: `npm ci` con `NODE_ENV=production` omite las devDependencies → `--include=dev`.
7. El reproductor marcaba "hueco" justo en el último punto de un tramo.

## Limitaciones conocidas
- **No hay pruebas en dispositivos físicos** (ver [MOBILE_DEVICE_TESTING.md](MOBILE_DEVICE_TESTING.md)). Límites de la plataforma: [PLATFORM_LIMITS.md](PLATFORM_LIMITS.md).
- **OSRM demo:** sin SLA, sin tráfico, solo el perfil "driving" y una política de uso no apta para producción. Los ETA son "estimación básica" o "sin tráfico".
- **Map matching no implementado:** los desvíos usan un corredor alrededor de la ruta, sin ajustar a la red vial.
- **Rate limit en memoria por instancia:** con varias réplicas no se comparte.
- **Geocercas:** la evaluación ocurre en el servidor después de sincronizar. Sin conexión no hay eventos en tiempo real en el teléfono. El estado de geocerca no se arrastra entre sesiones: cada sesión inicia su estado con el primer punto claro.
- **Sesiones muy largas** (días en modo ahorro) se reevalúan completas ante cada lote. Funciona, pero conviene acotarlas o particionar el procesamiento si crecen.
- **Exportaciones GPX/KML/GeoJSON** se arman en memoria (tope `EXPORT_MAX_POINTS`). No hay exportaciones asíncronas para volúmenes grandes.
- **No hay endpoint de eliminación de cuenta** (solo de dispositivo). La exportación de datos propios sí existe.
- **No hay invitaciones por email:** solo se pueden agregar usuarios ya registrados.
- **Geocodificación (búsqueda de direcciones) no implementada:** origen y destino se eligen en el mapa.
- **La app móvil no cambia de modo nativo en segundo plano** (restricción de Android 12+): la adaptación en segundo plano se hace filtrando en JS; la reconfiguración nativa ocurre al iniciar desde la app.

## Plan para lo restante (por prioridad)
1. **Pruebas en dispositivos físicos** (lista de 15 casos) y corrección de lo que surja. *Requiere un Android físico y, para iOS, Mac + cuenta Apple.*
2. **Desplegar en Railway** siguiendo la guía y correr `simulate-device.mjs` contra producción. Validar SSE a través del proxy y la persistencia tras redeploy. *Requiere cuenta Railway.*
3. **Primer build en EAS** (`npm run build:dev`) e instalación en un Android físico.
4. **Proveedor de rutas de producción:** OSRM propio para la región (servicio en Railway con volumen) o GraphHopper con clave, más map matching (`/match`).
5. **E2E de la UI de geocercas, dispositivos y configuración**, y verificación responsive en tablet y móvil.
6. Endpoint de eliminación de cuenta e invitaciones por email.
7. Rate limit distribuido (en Postgres) antes de escalar a varias réplicas.
8. Exportaciones asíncronas con almacenamiento de objetos para rangos grandes.
9. Particionado mensual de `location_points` al acercarse a unos 100 M de filas.
