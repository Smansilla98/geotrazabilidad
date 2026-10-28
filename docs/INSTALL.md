# Guía de instalación (desarrollo local)

## Requisitos
- Node 22.12+ (recomendado 24, ver `.node-version`) y npm 10+.
- Docker con Compose (para PostGIS y Mailpit; las pruebas de integración también levantan PostGIS con Testcontainers).
- App móvil: Android Studio (SDK + emulador) o un teléfono físico con depuración USB. Para iOS, macOS con Xcode y una cuenta de Apple Developer.

## Backend y web
```bash
npm ci
cp .env.example .env                    # completar JWT_SECRET: openssl rand -base64 48
docker compose up -d db mailpit         # PostGIS en :5433, Mailpit (SMTP de prueba) en :1025 / UI :8025
npm run build                           # shared → api → web
npm run db:migrate                      # aplica database/migrations/*.sql

# Desarrollo con recarga:
npm run dev -w @geo/web                 # http://localhost:5173 (Vite + el mismo BFF que en producción)
node --env-file=.env apps/api/dist/main.js   # API en http://localhost:3000 (recompilar con npm run build -w @geo/api)
```

- Documentación de la API: http://localhost:3000/v1/docs (OpenAPI en `/v1/openapi.json`).
- Datos de demostración: botón "Cargar datos de demostración" en el panel (owner/admin), o `npm run demo:seed -- tu@email`.
- Correos de recuperación: http://localhost:8025.

> Si tu Docker es un snap y `docker` no conecta: `export DOCKER_HOST=unix:///var/run/docker.sock`.

## Pruebas
```bash
npm run typecheck && npm run lint
npm test                                # shared (unidad), api (integración con PostGIS real), web (unidad)
# E2E (requiere la API corriendo en :3000 con la base migrada):
cd apps/web && npx playwright install chromium && npx playwright test
# Integración de punta a punta con el motor de sincronización de la app:
API_URL=http://localhost:3000 node scripts/simulate-device.mjs
```

## App móvil (development build)
La captura en segundo plano **no funciona en Expo Go**: hace falta un development build.
```bash
npm run build -w @geo/shared            # la app consume packages/shared compilado
cd apps/mobile && npm ci
# La URL de la API se fija al compilar. En un teléfono usá la IP LAN de tu PC (nunca localhost):
EXPO_PUBLIC_API_URL=http://192.168.0.10:3000 npx expo run:android      # o run:ios en macOS
npx expo start --dev-client             # servidor de desarrollo para el build instalado
```
- En builds que no son de producción, la URL de la API se puede cambiar desde Más → Sincronización.
- Verificaciones sin dispositivo: `npx tsc --noEmit`, `npm test` y `npm run bundle:check`.
- Pruebas en dispositivo físico: [MOBILE_DEVICE_TESTING.md](MOBILE_DEVICE_TESTING.md).
