import { expect, test } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import { loginAsDirector, waitForDireccion } from "../_helpers-direccion";
import { createMeasure, dataRows, navItem, parsePercent } from "./_measure-direccion";

/**
 * D4 · «¿Qué hotel de la cartera va peor de ocupación?» (brief UX-2 · éxito:
 * la tabla «Propiedades de la cartera» ordenada por ocupación con al menos dos
 * hoteles; objetivo ≤ 3 clics, ≤ 14 peticiones).
 *
 * Camino de hoy: menú «Cartera de propiedades» → cabecera «Ocupación» (botón
 * de CocoaTable; la primera pulsación en una columna numérica ordena
 * descendente, PortfolioDashboard.tsx onSort) → dos filas comparables.
 * Con un solo hotel en el tenant la medida acaba `completed=false` (se anota).
 */
test("d4 · comparar los hoteles de la cartera por ocupación", async ({ page, request }, testInfo) => {
  await loginAsDirector(page, request);
  const measure = createMeasure(page, "d4");
  await page.goto("/hoy/direccion", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForDireccion(page);
  measure.step("Mi día de dirección cargado");

  await measure.start(page);
  await measure.countedClick(navItem(page, "PortfolioDashboard"), "Cartera de propiedades (menú)");
  await expect(page).toHaveURL(/\/informes\/cartera$/, { timeout: 15_000 });
  const table = page.getByRole("table", { name: "Propiedades de la cartera" });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await measure.mark(page, "cartera-open");

  const header = table.getByRole("columnheader", { name: "Ocupación" });
  await measure.countedClick(header.getByRole("button"), "Ordenar por ocupación (cabecera)");
  await expect(header).toHaveAttribute("aria-sort", /ascending|descending/, { timeout: 10_000 });
  const direction = (await header.getAttribute("aria-sort")) ?? "";

  // textContent, no innerText: la cabecera de CocoaTable va en mayúsculas por CSS (`text-transform: uppercase`).
  const headers = await table.getByRole("columnheader").allTextContents();
  const column = headers.findIndex((text) => text.trim().toLocaleLowerCase("es").startsWith("ocupación"));
  expect(column, "columna «Ocupación» en la tabla").toBeGreaterThanOrEqual(0);
  const rows = dataRows(table);
  const count = await rows.count();
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(parsePercent(await rows.nth(i).getByRole("cell").nth(column).innerText()));
  const sorted = values.every((value, i) => i === 0 || Number.isNaN(value) || Number.isNaN(values[i - 1]) || (direction === "descending" ? values[i - 1] >= value : values[i - 1] <= value));

  const completed = count >= 2 && sorted;
  const result = await measure.finish(page, {
    completed,
    context: { properties: count, direction, sorted },
    note: completed ? undefined : count < 2 ? `solo ${count} propiedad(es) en la cartera: el seed D1 añade prop_uxday_b` : "la columna no queda ordenada"
  });
  expect(result.clicks).toBe(2);
  expect(sorted).toBe(true);
});
