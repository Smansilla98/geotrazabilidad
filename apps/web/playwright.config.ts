import { defineConfig } from '@playwright/test';

/**
 * E2E contra el servidor de producción de la web (server.mjs) y una API real.
 * Requiere la API corriendo (WEB_E2E_API, por defecto http://localhost:3000) con base PostGIS migrada.
 */
const PORT = 5190;
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires' },
  webServer: {
    command: `node server.mjs`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), API_INTERNAL_URL: process.env.WEB_E2E_API ?? 'http://localhost:3000' },
  },
});
