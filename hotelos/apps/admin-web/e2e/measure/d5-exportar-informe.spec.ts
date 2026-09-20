import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import { loginAsDirector, waitForDireccion } from "../_helpers-direccion";
import { commandPalette, createMeasure, navItem } from "./_measure-direccion";

/**
 * D5 · «Sácame el informe de reservas del mes para el consejo.» (brief UX-2 ·
 * éxito: POST /reports/properties/prop_uxday_b/export 200 y callout
 * «Exportación lista» (ReportingCenterScreen.tsx, FIX-1); objetivo ≤ 3 clics,
 * ≤ 16 peticiones).
 *
 * Camino de hoy: menú «Centro de informes» → «Generar exportación» (tipo y
 * formato por defecto: reservas · PDF). La descarga automática (F5) no cuenta.
 *
 * Variante teclado (⌘K, como t6-buscar-y-cargo): ⌘K → «Centro de informes» →
 * Intro → ⌘K → «Generar exportación» (comando de página «Generar exportación
 * de informe») → Intro. Se guarda como `variants.teclado`.
 */
const EXPORT_PATH = (propertyId: string) => new RegExp(`/reports/properties/${propertyId}/export$`);

async function landOnDireccion(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/hoy/direccion", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForDireccion(page);
}

async function expectReportingCenter(page: Page) {
  await expect(page).toHaveURL(/\/informes$/, { timeout: 15_000 });
  const button = page.getByRole("button", { name: "Generar exportación", exact: true });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  return button;
}

test("d5 · exportar un informe del Centro de informes", async ({ page, request }, testInfo) => {
  const session = await loginAsDirector(page, request);
  const measure = createMeasure(page, "d5");
  await landOnDireccion(page, testInfo);
  measure.step("Mi día de dirección cargado");

  await measure.start(page);
  await measure.countedClick(navItem(page, "ReportingCenter"), "Centro de informes (menú)");
  const button = await expectReportingCenter(page);
  await measure.mark(page, "informes-open");
  const posted = page.waitForResponse((response) => response.request().method() === "POST" && EXPORT_PATH(session.propertyId).test(response.url()), { timeout: 20_000 });
  await measure.countedClick(button, "Generar exportación");
  const response = await posted;
  const completed = response.status() === 200;
  if (completed) await expect(page.getByText("Exportación lista", { exact: true })).toBeVisible({ timeout: 15_000 });

  const result = await measure.finish(page, {
    completed,
    context: { propertyId: session.propertyId, status: response.status() },
    note: completed ? undefined : `POST /reports/properties/:id/export → ${response.status()}`
  });
  expect(response.status(), "POST /reports/properties/:id/export").toBe(200);
  expect(result.clicks).toBe(2);
});

test("d5 · variante teclado: ⌘K → Centro de informes → ⌘K → Generar exportación", async ({ page, request }, testInfo) => {
  const session = await loginAsDirector(page, request);
  const measure = createMeasure(page, "d5");
  await landOnDireccion(page, testInfo);
  measure.step("Mi día de dirección cargado");

  await measure.start(page);
  await measure.countedPress(page, "ControlOrMeta+k", "⌘K");
  const palette = commandPalette(page);
  await expect(palette).toBeVisible({ timeout: 10_000 });
  await measure.countedFill(palette.getByRole("searchbox").first(), "Centro de informes", "Búsqueda (pantalla)");
  await expect(palette.getByRole("option").filter({ hasText: /^Centro de informes/ }).first()).toBeVisible({ timeout: 10_000 });
  await measure.countedPress(page, "Enter", "Enter (Centro de informes)");
  await expectReportingCenter(page);
  await measure.mark(page, "informes-open");

  await measure.countedPress(page, "ControlOrMeta+k", "⌘K (comandos de la página)");
  await expect(palette).toBeVisible({ timeout: 10_000 });
  await measure.countedFill(palette.getByRole("searchbox").first(), "Generar exportación", "Comando «Generar exportación de informe»");
  await expect(palette.getByRole("option").filter({ hasText: /^Generar exportación de informe/ }).first()).toBeVisible({ timeout: 10_000 });
  const posted = page.waitForResponse((response) => response.request().method() === "POST" && EXPORT_PATH(session.propertyId).test(response.url()), { timeout: 20_000 });
  await measure.countedPress(page, "Enter", "Enter (Generar exportación)");
  const response = await posted;
  const completed = response.status() === 200;
  if (completed) await expect(page.getByText("Exportación lista", { exact: true })).toBeVisible({ timeout: 15_000 });

  const variant = await measure.finishVariant(page, "teclado", {
    completed,
    note: completed ? "solo teclado (⌘K → Centro de informes → Intro → ⌘K → Generar exportación → Intro)" : `POST /reports/properties/:id/export → ${response.status()}`
  });
  expect(response.status(), "POST /reports/properties/:id/export").toBe(200);
  expect(variant.clicks).toBe(0);
});
