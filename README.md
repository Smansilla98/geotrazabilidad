# Plataforma de geolocalización, trazabilidad y reconstrucción de recorridos

Monorepo con tres productos que comparten backend, modelo de datos y autenticación:

| Producto | Tecnología | Estado |
|---|---|---|
| `apps/api` | NestJS 12 + PostgreSQL 17/PostGIS 3.5 | Completo y probado (integración contra PostGIS real) |
| `apps/web` | React 19 + Vite + MapLibre, servida por un BFF Node | Completa y probada (E2E con Playwright) |
| `apps/mobile` | Expo SDK 58 (development build) + MapLibre RN | Implementada; **sin verificar en dispositivo físico** |
| `packages/shared` | Contratos zod, reglas de eventos, estrategia de captura, cola y sincronización | Probado (46 pruebas) |

Las posiciones son **datos observados**. Las detenciones, llegadas y desvíos son **eventos inferidos** con su regla, su confianza y su evidencia. Las rutas planificadas y los ETA son **estimaciones** de un proveedor. El sistema nunca presenta una estimación como si fuera una observación.

## Inicio rápido
```bash
npm ci && cp .env.example .env   # completar JWT_SECRET
docker compose up -d db mailpit
npm run build && npm run db:migrate
node --env-file=.env apps/api/dist/main.js &
npm run dev -w @geo/web          # http://localhost:5173 → registrate → "Cargar datos de demostración"
```

## Documentación
| Documento | Contenido |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | **Matriz de funcionalidades verificadas, limitaciones y plan** |
| [docs/INSTALL.md](docs/INSTALL.md) | Instalación local, pruebas, compilación de la app |
| [docs/RAILWAY_DEPLOYMENT.md](docs/RAILWAY_DEPLOYMENT.md) | Despliegue en Railway paso a paso |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitectura, diagrama de componentes y decisiones |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Modelo de datos, borrado y retención |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | Contrato v1 (la referencia viva está en `/v1/docs`) |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Mapas, rutas y geocodificación |
| [docs/PLATFORM_LIMITS.md](docs/PLATFORM_LIMITS.md) | Límites de la ubicación en Android e iOS |
| [docs/MOBILE_DEVICE_TESTING.md](docs/MOBILE_DEVICE_TESTING.md) | Pruebas pendientes en dispositivos físicos |
| [docs/PRIVACY_LEGAL.md](docs/PRIVACY_LEGAL.md) | Privacidad e implicaciones legales |
| [docs/PLAN.md](docs/PLAN.md) | Alcance del MVP y riesgos (diseño original) |
| [docs/PROJECT_LOG.md](docs/PROJECT_LOG.md) | Registro de avance |
