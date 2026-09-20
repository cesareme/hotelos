import { expect, test } from "@playwright/test";
import { assertNoLoginGate, loginAsUxDay, UXDAY } from "./_helpers";

/**
 * Integraciones honestas (Tanda L8 · lote L8-08): la pestaña Configuración ›
 * Módulos e integraciones › Integraciones (`/configuracion/modulos/integraciones`,
 * MarketplaceCatalogScreen + IntegrationsStatusPanel de L8-06) con la sesión de
 * DIRECCIÓN del tenant UXDAY (plantilla general_manager: integrations.read;
 * recepción no entra en esta pantalla):
 *   1. la pestaña queda seleccionada y el panel «Estado de las integraciones»
 *      pinta una tabla por área (5 áreas) con 18 filas, una por IntegrationKey,
 *      cada una con un badge de modo del contrato (Sin integración · Pruebas
 *      (sin efecto real) · Real) leído de GET /integrations/status;
 *   2. cero badges «Real» en filas que crucen por red: el tenant de prueba no
 *      tiene credenciales de nada, así que la única fila que puede decir «Real»
 *      es la exportación manual a gestoría (transporte «Manual», ficheros que
 *      una persona descarga; nada sale del sistema); ninguna fila «Real» lleva
 *      «API (red)»;
 *   3. el contador «Reales» de la cabecera cuenta exactamente esos badges
 *      (filas recibidas, nunca un número inventado) y no hay consultas
 *      degradadas anunciadas;
 *   4. ninguna fila en pruebas dice «enviado»: las frases hablan de simulación.
 */
const MODE_BADGE = /^(Sin integración|Pruebas \(sin efecto real\)|Real)$/;

test("la pestaña Integraciones muestra la tabla de estado y ningún «Real» que cruce por red", async ({ page, request }, testInfo) => {
  await loginAsUxDay(page, request, { email: UXDAY.users.direccion });
  await page.goto("/configuracion/modulos/integraciones", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  await expect(page.getByRole("tab", { name: "Integraciones", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  const region = page.getByRole("region", { name: "Estado de las integraciones" });
  await expect(region).toBeVisible({ timeout: 15_000 });

  // 1. Una tabla por área y 18 filas de datos (las cabeceras llevan columnheader, no cell).
  const tables = region.getByRole("table", { name: /^Integraciones · / });
  await expect(tables.first()).toBeVisible({ timeout: 15_000 });
  await expect(tables).toHaveCount(5);
  const rows = tables.getByRole("row").filter({ has: page.getByRole("cell") });
  await expect(rows).toHaveCount(18);
  // Etiqueta exacta de la primera columna (la frase de IGIC también nombra a VeriFactu).
  for (const label of ["OPERA Cloud (modo sombra)", "Pasarela de pago (PSP)", "WhatsApp", "VeriFactu", "Proveedor de IA", "Redis"]) {
    await expect(rows.filter({ has: page.getByText(label, { exact: true }) })).toHaveCount(1);
  }
  const modeBadges = region.locator('[data-cocoa="badge"]').filter({ hasText: MODE_BADGE });
  await expect(modeBadges).toHaveCount(18);

  // 2. Cero badges «Real» por red.
  const realBadges = region.locator('[data-cocoa="badge"]').filter({ hasText: /^Real$/ });
  const realCount = await realBadges.count();
  expect(realCount, "como mucho la exportación manual a gestoría puede ser «Real»").toBeLessThanOrEqual(1);
  for (let index = 0; index < realCount; index += 1) {
    const row = realBadges.nth(index).locator("xpath=ancestor::tr[1]");
    await expect(row).toContainText("Exportación a gestoría");
    await expect(row).toContainText("Manual");
    await expect(row).not.toContainText("API (red)");
  }
  const networkRealRows = rows.filter({ hasText: "API (red)" }).filter({ has: page.locator('[data-cocoa="badge"]').filter({ hasText: /^Real$/ }) });
  await expect(networkRealRows, "ninguna fila «Real» con transporte API (red)").toHaveCount(0);

  // 3. El contador «Reales» cuenta las filas recibidas; sin consultas degradadas.
  const realKpi = region.locator('[data-cocoa="kpi"]').filter({ hasText: "Reales" });
  await expect(realKpi).toHaveCount(1);
  await expect(realKpi).toContainText(String(realCount));
  const noneCount = await region.locator('[data-cocoa="badge"]').filter({ hasText: /^Sin integración$/ }).count();
  const sandboxCount = await region.locator('[data-cocoa="badge"]').filter({ hasText: /^Pruebas \(sin efecto real\)$/ }).count();
  expect(realCount + noneCount + sandboxCount).toBe(18);
  await expect(region.getByText(/consultas? sin datos/)).toHaveCount(0);

  // 4. Ninguna fila en pruebas dice «enviado».
  const sandboxRows = rows.filter({ has: page.locator('[data-cocoa="badge"]').filter({ hasText: /^Pruebas \(sin efecto real\)$/ }) });
  expect(await sandboxRows.count()).toBe(sandboxCount);
  for (let index = 0; index < sandboxCount; index += 1) {
    const text = await sandboxRows.nth(index).innerText();
    expect(text, "una fila en pruebas nunca dice «enviado»").not.toMatch(/\benviad[oa]s?\b/i);
    expect(text).toMatch(/simul|prueba|ficticia|local/i);
  }
});
