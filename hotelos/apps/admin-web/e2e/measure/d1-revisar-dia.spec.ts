import { expect, test } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import { loginAsDirector, waitForDireccion } from "../_helpers-direccion";
import { createMeasure } from "./_measure-direccion";

/**
 * D1 · «Entras por la mañana: ¿cómo va el día y qué riesgos hay?» (brief UX-2 ·
 * éxito: Mi día de dirección con ocupación, ADR, RevPAR y riesgo de cancelación
 * visibles; objetivo 0 clics y ≤ 20 peticiones desde el goto).
 *
 * Camino: `goto /` → el aterrizaje del rol (navigation/role-tokens.ts roleHome:
 * `direccion` → /hoy/direccion) → tira «Indicadores de hoy» (GeneralManagerScreen).
 * El contador de peticiones arranca ANTES del goto: mide el shell + el panel.
 */
test("d1 · revisar el día y los riesgos al aterrizar", async ({ page, request }, testInfo) => {
  await loginAsDirector(page, request);
  const measure = createMeasure(page, "d1");

  await measure.start(page);
  measure.step("goto / (aterrizaje del rol)");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await expect(page).toHaveURL(/\/hoy\/direccion/, { timeout: 15_000 });
  await measure.mark(page, "landing");
  await waitForDireccion(page);

  const strip = page.getByRole("group", { name: "Indicadores de hoy" });
  await expect(strip.getByText("ADR", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(strip.getByText("RevPAR", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Riesgo cancelación").first()).toBeVisible({ timeout: 10_000 });
  measure.step("KPIs y riesgo de cancelación visibles");

  const result = await measure.finish(page, { completed: true, context: { landing: "/hoy/direccion" } });
  expect(result.clicks).toBe(0);
  expect(result.keys).toBe(0);
  expect(result.requests).toBeGreaterThan(0);
});
