import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "../_helpers";
import { createMeasure, toastContaining, waitForMiDia } from "./_measure";

/**
 * T2 · «Entra una persona sin reserva: quiere una doble hoy y se va mañana.
 * Cóbrale y hazle el check-in.» (§8.2 · éxito: reserva `walk_in` + pago +
 * GuestCheckedIn; objetivo ≤ 11 = crear ≤ 7 + check-in ≤ 4; óptimo U6 §5.3:
 * 3 clics + 2 campos).
 *
 * Camino U6: Mi día → «Walk-in» → el cajón abre hoy → mañana con la doble
 * cotizada y la primera limpia y libre preseleccionada → nombre + apellido →
 * «Crear y hacer check-in» (cobro del importe de la estancia incluido) = 2
 * clics + 2 campos (el tipo Doble ya va preseleccionado; si no, 1 clic más).
 */
test("t2 · walk-in: crear la reserva, cobrar y hacer el check-in", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const measure = createMeasure(page, "t2");
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiDia(page);
  measure.step("Mi día cargado");

  await measure.start(page);
  await measure.countedClick(page.getByRole("button", { name: /^Walk-in/ }).first(), "Walk-in (cabecera de Mi día)");
  const drawer = page.getByRole("dialog", { name: "Walk-in" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "drawer-open");

  // Tipo Doble con precio en vivo (preseleccionado: el primero con disponibilidad).
  const typeSelect = drawer.getByLabel("Tipo", { exact: true });
  await expect(typeSelect).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await typeSelect.locator("option").allTextContents()).some((text) => /Doble · \d+,\d\d\s€ · \d+ libres?/.test(text)), { timeout: 10_000 }).toBe(true);
  if (!/Doble/.test((await typeSelect.locator("option:checked").textContent()) ?? "")) {
    await measure.countedSelect(typeSelect, "Tipo = Doble", "rt_uxday_dbl");
  }
  const roomSelect = drawer.getByLabel("Habitación", { exact: true });
  await expect.poll(async () => roomSelect.inputValue(), { timeout: 10_000 }).not.toBe("");
  const roomId = await roomSelect.inputValue();

  // Huésped (datos ficticios) y confirmación: «Crear y hacer check-in».
  await measure.countedFill(drawer.getByLabel(/^Nombre/), "Cliente", "Nombre");
  await measure.countedFill(drawer.getByLabel(/^Apellido/), "Walkin", "Primer apellido");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && /\/properties\/[^/]+\/reservations$/.test(response.url()), { timeout: 20_000 });
  await measure.countedClick(drawer.getByRole("button", { name: /^Crear y hacer check-in$/ }), "Crear y hacer check-in");
  const createdResponse = await created;
  expect(createdResponse.ok(), `POST reservations → ${createdResponse.status()}`).toBeTruthy();
  const reservation = (await createdResponse.json()) as { id: string; code: string; totalAmount: number | string };
  await measure.mark(page, "reservation-created");

  await expect(toastContaining(page, new RegExp(`Walk-in ${reservation.code} en la \\d+: check-in hecho`))).toBeVisible({ timeout: 20_000 });
  const total = Number(reservation.totalAmount);
  const result = await measure.finish(page, {
    completed: true,
    context: { reservationCode: reservation.code, bookingSource: "walk_in", totalEur: total },
    note: "cajón Walk-in de Mi día (U6): tipo con precio en vivo y habitación preseleccionados; el cobro del importe de la estancia se registra como anticipo (el cargo de alojamiento lo asienta el cierre del día)"
  });

  // Éxito verificable en datos: alojada, con habitación y con cobro capturado.
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const detail = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}`, { headers })).json()) as { status: string; assignedRoomId: string | null; bookingSource?: string | null };
  expect(detail.status).toBe("checked_in");
  expect(detail.assignedRoomId).toBe(roomId);
  if ("bookingSource" in detail) expect(detail.bookingSource).toBe("walk_in");
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers })).json()) as { paymentsTotal: number; balanceDue: number };
  expect(Math.round(folio.paymentsTotal * 100)).toBe(Math.round(total * 100));
  expect(folio.balanceDue).toBeLessThanOrEqual(0);
  expect(result.clicks).toBeLessThanOrEqual(3);
});
