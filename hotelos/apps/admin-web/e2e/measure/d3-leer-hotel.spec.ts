import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import { loginAsDirector, waitForDireccion } from "../_helpers-direccion";
import { commandPalette, createMeasure, dataRows, navItem } from "./_measure-direccion";

/**
 * D3 · «¿Cómo va el hotel B este mes: ocupación e ingresos?» (brief UX-2 ·
 * éxito: detalle de la propiedad con el KPI «Ingresos del mes»
 * (PropertyDetailScreen.tsx); objetivo ≤ 3 clics, ≤ 14 peticiones).
 *
 * Camino de hoy: menú «Cartera de propiedades» (`.c22-nav-item`) → fila del
 * hotel activo en «Propiedades de la cartera» (PortfolioDashboard.tsx) →
 * /informes/cartera/:propiedad con «Ocupación» e «Ingresos del mes».
 *
 * Variante teclado (⌘K, como t6-buscar-y-cargo): ⌘K → «Cartera de
 * propiedades» → Intro → Tab hasta la fila (las filas de CocoaTable tienen
 * tabIndex 0 y abren con Intro) → Intro. Se guarda como `variants.teclado`.
 */
async function landOnDireccion(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/hoy/direccion", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForDireccion(page);
}

/** Fila del hotel activo si está en la cartera; si no, la primera con datos. */
async function propertyRow(page: Page, table: Locator, propertyName: string): Promise<Locator> {
  const rows = dataRows(table);
  const own = rows.filter({ hasText: propertyName }).first();
  return (await own.isVisible().catch(() => false)) ? own : rows.first();
}

async function expectDetail(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/informes\/cartera\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByText("Ingresos del mes", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Ocupación", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

test("d3 · leer ocupación e ingresos del mes de un hotel", async ({ page, request }, testInfo) => {
  const session = await loginAsDirector(page, request);
  const measure = createMeasure(page, "d3");
  await landOnDireccion(page, testInfo);
  measure.step("Mi día de dirección cargado");

  await measure.start(page);
  await measure.countedClick(navItem(page, "PortfolioDashboard"), "Cartera de propiedades (menú)");
  await expect(page).toHaveURL(/\/informes\/cartera$/, { timeout: 15_000 });
  const table = page.getByRole("table", { name: "Propiedades de la cartera" });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await measure.mark(page, "cartera-open");
  const row = await propertyRow(page, table, session.propertyName);
  await measure.countedClick(row, "Fila del hotel (cartera)");
  await expectDetail(page);

  const result = await measure.finish(page, { completed: true, context: { propertyId: session.propertyId } });
  expect(result.clicks).toBe(2);
});

test("d3 · variante teclado: ⌘K → Cartera → fila → detalle", async ({ page, request }, testInfo) => {
  const session = await loginAsDirector(page, request);
  const measure = createMeasure(page, "d3");
  await landOnDireccion(page, testInfo);
  measure.step("Mi día de dirección cargado");

  await measure.start(page);
  await measure.countedPress(page, "ControlOrMeta+k", "⌘K");
  const palette = commandPalette(page);
  await expect(palette).toBeVisible({ timeout: 10_000 });
  await measure.countedFill(palette.getByRole("searchbox").first(), "Cartera de propiedades", "Búsqueda (pantalla)");
  await expect(palette.getByRole("option").filter({ hasText: /^Cartera de propiedades/ }).first()).toBeVisible({ timeout: 10_000 });
  await measure.countedPress(page, "Enter", "Enter (Cartera de propiedades)");
  await expect(page).toHaveURL(/\/informes\/cartera$/, { timeout: 15_000 });
  const table = page.getByRole("table", { name: "Propiedades de la cartera" });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await measure.mark(page, "cartera-open");

  const row = await propertyRow(page, table, session.propertyName);
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Camino honesto de hoy: el primer Tab cae en el enlace «Saltar al contenido»
  // (layouts/BackOfficeLayout.tsx `.c22-skip-link`, WCAG 2.4.1) → Intro salta el
  // menú lateral → Tab hasta la fila (tabIndex 0 en CocoaTable) → Intro.
  let focused = false;
  for (let i = 0; i < 150 && !focused; i += 1) {
    await measure.countedPress(page, "Tab", "Tab (hasta la fila)");
    const onSkipLink = await page.evaluate(() => document.activeElement?.classList.contains("c22-skip-link") ?? false).catch(() => false);
    if (onSkipLink) await measure.countedPress(page, "Enter", "Enter (Saltar al contenido)");
    focused = await row.evaluate((element) => element === document.activeElement).catch(() => false);
  }
  if (!focused) {
    await measure.finishVariant(page, "teclado", { completed: false, note: "la fila del hotel no recibe el foco en ≤ 150 Tab" });
    return;
  }
  await measure.countedPress(page, "Enter", "Enter (fila del hotel)");
  await expectDetail(page);

  const variant = await measure.finishVariant(page, "teclado", { completed: true, note: "solo teclado (⌘K → Cartera de propiedades → Intro → Tab → Intro en «Saltar al contenido» → Tab×n → Intro)" });
  expect(variant.clicks).toBe(0);
  expect(variant.keys).toBeGreaterThan(0);
});
