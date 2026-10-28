import { expect, test, type Page } from '@playwright/test';

const pass = 'contraseña-e2e-123';
const email = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;

async function registerUi(page: Page, who: string) {
  const e = email(who.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase());
  await page.goto('/register');
  await page.getByLabel('Nombre').fill(who);
  await page.getByLabel('Email').fill(e);
  await page.getByLabel('Contraseña').fill(pass);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  return e;
}

test('flujo principal: registro, demo, mapa, reproductor, evento y exportación', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await registerUi(page, 'Operadora');
  // Estado vacío explicativo, sin números ficticios.
  await expect(page.getByText('Todavía no hay datos de ubicación')).toBeVisible();
  await page.getByRole('button', { name: 'Cargar datos de demostración' }).click();
  await expect(page.getByText('Dispositivos', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.kpi', { has: page.locator('.kpi-label', { hasText: /^Dispositivos$/ }) }).locator('.kpi-value')).toHaveText('4', { timeout: 20_000 });
  await expect(page.locator('.kpi', { has: page.locator('.kpi-label', { hasText: /^Conectados/ }) }).locator('.kpi-value')).toHaveText('0');

  // Mapa: dispositivo con pérdida de señal.
  await page.getByRole('link', { name: 'Mapa y recorridos' }).click();
  await page.getByLabel('Dispositivo').selectOption({ label: 'Moto mensajería (DEMO)' });
  await page.getByRole('button', { name: '3 días' }).click();
  await expect(page.locator('.details')).toContainText('Huecos sin datos');
  await expect(page.locator('.kv dt', { hasText: 'Huecos sin datos' }).locator('xpath=following-sibling::dd[1]')).not.toHaveText('0');
  await expect(page.locator('.alert.demo')).toBeVisible();
  // El mapa WebGL debe inicializarse (worker de MapLibre cargado).
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(consoleErrors.filter((e) => /worker/i.test(e))).toEqual([]);

  // Reproductor: reproducir y pausar avanza el reloj.
  const clock = page.locator('.clock');
  const before = await clock.textContent();
  await page.getByRole('button', { name: 'Reproducir' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pausar' }).click();
  expect(await clock.textContent()).not.toBe(before);

  // Seleccionar un evento desde la lista abre su detalle con evidencia.
  await page.locator('.event-list.compact li', { hasText: 'Pérdida de señal' }).first().click();
  await expect(page.locator('.card')).toContainText('Confianza');
  await expect(page.locator('.card')).toContainText('gap.v1');

  // Exportar GPX descarga un archivo.
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GPX' }).click();
  expect((await dl).suggestedFilename()).toMatch(/DEMO\.gpx$/);
});

test('comparación de viaje con desvío y eventos', async ({ page }) => {
  await registerUi(page, 'Analista');
  await page.getByRole('button', { name: 'Cargar datos de demostración' }).click();
  await expect(page.locator('.kpi').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Viajes' }).click();
  await page.getByRole('link', { name: 'Retiro con desvío (DEMO)' }).click();
  await expect(page.getByText('Desvío confirmado').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Planificado (estimado)')).toBeVisible();
  await expect(page.locator('.kv').first()).toContainText('Sí');

  await page.getByRole('link', { name: 'Eventos' }).click();
  await page.getByLabel('Tipo').selectOption({ label: 'Desvío de ruta' });
  await expect(page.locator('tbody tr').first()).toContainText('Desvío de ruta');
  await page.locator('tbody tr').first().getByRole('link', { name: 'Ver en mapa' }).click();
  await expect(page).toHaveURL(/\/map\?.*event=/);
  await expect(page.locator('.card')).toContainText('corridor.v1');
});

test('aislamiento: otro usuario no ve los dispositivos ajenos', async ({ page, browser }) => {
  await registerUi(page, 'Dueña');
  await page.getByRole('button', { name: 'Cargar datos de demostración' }).click();
  await expect(page.locator('.kpi').first()).toBeVisible({ timeout: 20_000 });
  const other = await browser.newPage();
  await registerUi(other, 'Ajeno');
  await other.goto('/devices');
  await expect(other.getByText('No hay dispositivos visibles.')).toBeVisible();
  await other.close();
});

test('la sesión persiste al recargar y se cierra con logout', async ({ page }) => {
  await registerUi(page, 'Sesion');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.goto('/devices');
  await expect(page).toHaveURL(/\/login/);
});
