# Registro del proyecto

Nada se marca como terminado sin una verificación registrada. El detalle por funcionalidad está en [STATUS.md](STATUS.md).

## Estado por fase

| Fase | Estado | Verificación |
|---|---|---|
| 1. Análisis y diseño | Validada por el propietario (2026-10-27) | Cambios pedidos: web React + Vite, roles propuestos, OSRM demo |
| 2. Backend y base de datos | **Completa** | 42 pruebas de integración contra PostGIS + 4 unitarias |
| 3. App móvil | **Implementada, no verificada en dispositivo** | Tipos, bundle de Metro, prebuild y prueba unitaria. Lógica de cola y sync probada con SQLite real |
| 4. Web | **Completa** | 4 E2E (Playwright) + 4 unitarias + capturas |
| 5. Integración | **Completa en local** | `simulate-device.mjs`: 12/12 verificaciones |
| 6. Estabilización y Railway | **Preparado, no desplegado** | Builds en limpio con `NODE_ENV=production`; IaC compilado |

## Pruebas ejecutadas (2026-10-27, todas en verde)
- `packages/shared`: 46 unitarias (geo, reglas, comparación, estrategia de captura, cola y sync con `node:sqlite`).
- `apps/api`: 42 de integración (Testcontainers `postgis/postgis:17-3.5`) + 4 unitarias de formatos.
- `apps/web`: 4 unitarias (reproductor y capas) + 4 E2E en Chromium contra el servidor de producción y la API real.
- `apps/mobile`: `tsc`, `expo export --platform android`, `expo prebuild --platform android`, 1 unitaria.
- Simulación de punta a punta: 12/12.
- Verificaciones manuales:
  - OSRM demo en vivo;
  - BFF con CSRF y cookie;
  - SSE a través del proxy;
  - CSP;
  - arranque en producción sin secretos (falla, como corresponde);
  - IPv6 (`HOST=::`);
  - CORS;
  - PostGIS sobre un volumen con `lost+found`.

## Errores encontrados y corregidos
Ver STATUS.md § "Errores encontrados y corregidos" (7 errores, 2 de ellos de seguridad).

## Decisiones técnicas
- 2026-10-27: ADR en ARCHITECTURE.md. Revisados durante la implementación: sin Kysely (ADR 7), web en Vite + BFF (ADR 10), reglas en TS (ADR 8b).
- 2026-10-27: Railway IaC (`.railway/railway.ts`) en lugar de `railway.json`, porque Config as Code deja de leerse el 2026-12-01.
- 2026-10-27: TypeScript 6.0 (no 7.0) por compatibilidad de decoradores con NestJS 12 (ESM).
- 2026-10-27: la app móvil queda fuera de los workspaces raíz para no arrastrar React Native a los builds de Railway; consume `@geo/shared` como `file:`.

## Riesgos pendientes
- Comportamiento real en segundo plano en Android e iOS (sin probar).
- OSRM demo en producción (política de uso y disponibilidad).
- SSE y red privada en Railway (sin probar en la plataforma).

## Dependencias externas
- Railway (cuenta), SMTP, GitHub (remoto y CI), OSRM demo (o un proveedor propio), OpenFreeMap (teselas), cuentas de Apple y Google para distribuir la app.

## Requisitos para producción
- Cargar en Railway `POSTGRES_PASSWORD`, `JWT_SECRET`, `SMTP_URL`, `MAIL_FROM` y `ROUTING_USER_AGENT`.
- Activar backups del volumen.
- Decidir `DEMO_ENABLED` y `API_DOCS_ENABLED`.
- Revisión legal del texto de consentimiento.
- Pruebas en dispositivo.

## Notas de entorno
- Docker funciona con `DOCKER_HOST=unix:///var/run/docker.sock` (el CLI snap no ve /tmp).
- 2026-10-27: el disco se llenó durante la sesión; el propietario liberó espacio. No se perdió ningún archivo (verificado).
