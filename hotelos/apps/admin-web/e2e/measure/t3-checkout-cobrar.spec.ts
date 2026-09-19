import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "../_helpers";
import { createMeasure, toastContaining, waitForMiDia } from "./_measure";

/**
 * T3 · «Se va el huésped de la 204 con 120 € pendientes. Cobra y cierra la
 * estancia.» (§8.2 · éxito: pago + GuestCheckedOut; cobrar ≤ 3 clics, óptimo 2).
 *
 * Camino U6 (§5.1 (1), §5.4): Mi día → pestaña «Salen hoy» → la fila de la 204
 * lleva la acción primaria «Cobrar 120,00 € y cerrar» (sale hoy con saldo) →
 * el cajón abre desde la caché con el mismo CTA → «Cobrar 120,00 € y cerrar»
 * = 3 clics (el óptimo de 2 exige que la salida esté a la vista sin cambiar
 * de pestaña: «Llegan hoy» sigue siendo la vista por defecto).
 */
test("t3 · salida de la 204 con 120 € pendientes: cobrar y cerrar", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const measure = createMeasure(page, "t3");
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiDia(page);
  measure.step("Mi día cargado");

  await measure.start(page);
  await measure.countedClick(page.getByRole("tablist", { name: "Vista de recepción" }).getByRole("tab", { name: /^Salen hoy/ }), "Pestaña Salen hoy");
  const departures = page.getByRole("table", { name: "Salidas de hoy" });
  await expect(departures).toBeVisible({ timeout: 10_000 });
  // Fila por la celda exacta «204» (el textContent de un <tr> concatena las celdas sin espacios).
  const row = departures.getByRole("row").filter({ has: page.getByRole("cell", { name: "204", exact: true }) }).first();
  const primary = row.getByRole("button", { name: /^Cobrar 120,00 € y cerrar$/ });
  if (!(await primary.isVisible().catch(() => false))) {
    await measure.finish(page, { completed: false, note: "la 204 ya no tiene salida pendiente con saldo: rearma el seed con --reset" });
    return;
  }
  await measure.countedClick(primary, "Cobrar 120,00 € y cerrar (fila 204)");

  // Drawer «Check-out» con subtítulo «<huésped> · Hab. 204» y el mismo CTA.
  const drawer = page.getByRole("dialog").filter({ hasText: /Hab\. 204/ }).first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "drawer-open");
  const cta = drawer.getByRole("button", { name: /^Cobrar 120,00 € y cerrar$/ });
  await expect(cta).toBeEnabled({ timeout: 10_000 });
  await measure.countedClick(cta, "Cobrar 120,00 € y cerrar (drawer)");

  await expect(toastContaining(page, /Check-out de la 204 hecho/)).toBeVisible({ timeout: 20_000 });
  const result = await measure.finish(page, { completed: true, context: { reservationCode: "UXDAY-T3", room: 204, balanceEur: 120 } });

  // Éxito verificable en datos: salida hecha y 120 € cobrados.
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const detail = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t3`, { headers })).json()) as { status: string };
  expect(detail.status).toBe("checked_out");
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t3/folio`, { headers })).json()) as { paymentsTotal: number; balanceDue: number };
  expect(Math.round(folio.paymentsTotal * 100)).toBe(22_000);
  expect(Math.abs(folio.balanceDue)).toBeLessThan(0.01);
  expect(result.clicks).toBe(3);
});
