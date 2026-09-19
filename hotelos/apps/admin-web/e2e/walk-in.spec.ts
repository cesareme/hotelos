import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Walk-in (Tanda UX-1 · lote U6 · §5.3, F4 · T2 completo): «Entra una persona
 * sin reserva: quiere una doble hoy y se va mañana. Cóbrale y hazle el
 * check-in.»
 *   1. Mi día → «Walk-in» (⌥W también) abre el cajón con hoy → mañana, 1 noche,
 *      el tipo con precio en vivo (POST availability/quote) y la primera doble
 *      limpia y libre preseleccionada;
 *   2. nombre y apellido (datos ficticios), cobro «Cobrar 89,00 €» por defecto;
 *   3. «Crear y hacer check-in» (Intro desde el apellido también): POST
 *      reservations con `bookingSource: "walk_in"` → cobro → check-in → SES;
 *   4. toast «Walk-in RES-… en la NNN: check-in hecho»; por API: `checked_in`,
 *      habitación asignada, origen walk_in y el importe cobrado como anticipo.
 */
test("walk-in desde Mi día: crear, cobrar y hacer el check-in en un solo cajón", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await expect(page.getByText("Llegan hoy").first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /^Walk-in/ }).first().click();
  const drawer = page.getByRole("dialog", { name: "Walk-in" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  // Estancia hoy → mañana y tipo Doble con precio en vivo (89,00 € · N libres).
  await expect(drawer.getByText(/1 noche/).first()).toBeVisible({ timeout: 10_000 });
  const typeSelect = drawer.getByLabel("Tipo", { exact: true });
  await expect(typeSelect).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await typeSelect.locator("option").allTextContents()).some((text) => /Doble · \d+,\d\d\s€ · \d+ libres?/.test(text)), { timeout: 10_000 }).toBe(true);
  if (!/Doble/.test((await typeSelect.locator("option:checked").textContent()) ?? "")) await typeSelect.selectOption("rt_uxday_dbl");
  const roomSelect = drawer.getByLabel("Habitación", { exact: true });
  await expect.poll(async () => roomSelect.inputValue(), { timeout: 10_000 }).not.toBe("");
  const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Array<{ id: string; number: string; roomTypeId: string; status: string; housekeepingStatus: string }>;
  const selectedRoomId = await roomSelect.inputValue();
  const picked = rooms.find((room) => room.id === selectedRoomId);
  expect(picked, "habitación preseleccionada").toBeTruthy();
  expect(picked!.roomTypeId).toBe("rt_uxday_dbl");
  expect(picked!.status).not.toBe("occupied");
  expect(picked!.housekeepingStatus).toMatch(/^(clean|inspected)$/);

  // Huésped (mínimo del API) y cobro por defecto «Cobrar 89,00 €».
  const firstName = drawer.getByLabel(/^Nombre/);
  await expect(firstName).toBeFocused({ timeout: 5_000 });
  await firstName.fill("Cliente");
  const surname = drawer.getByLabel(/^Apellido/);
  await surname.fill("Walkin");
  const mode = drawer.getByRole("tablist", { name: "Modo de cobro" });
  await expect(mode.getByRole("tab", { name: /^Cobrar \d+,\d\d €$/ })).toHaveAttribute("aria-selected", "true");
  const amountText = /Cobrar (\d+,\d\d)\s€/.exec((await mode.getByRole("tab", { name: /^Cobrar \d+,\d\d €$/ }).textContent()) ?? "")?.[1] ?? "";
  const amount = Number(amountText.replace(",", "."));
  expect(amount).toBeGreaterThan(0);

  const created = page.waitForResponse((response) => response.request().method() === "POST" && /\/properties\/[^/]+\/reservations$/.test(response.url()), { timeout: 20_000 });
  await surname.press("Enter");
  const createdResponse = await created;
  expect(createdResponse.ok(), `POST reservations → ${createdResponse.status()}`).toBeTruthy();
  const reservation = (await createdResponse.json()) as { id: string; code: string; totalAmount: number | string };

  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: new RegExp(`Walk-in ${reservation.code} en la ${picked!.number}: check-in hecho`) }).first()).toBeVisible({ timeout: 20_000 });
  await expect(drawer).toBeHidden({ timeout: 5_000 });

  const detail = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}`, { headers })).json()) as { status: string; assignedRoomId: string | null; bookingSource?: string | null };
  expect(detail.status).toBe("checked_in");
  expect(detail.assignedRoomId).toBe(picked!.id);
  if ("bookingSource" in detail) expect(detail.bookingSource).toBe("walk_in");
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers })).json()) as { paymentsTotal: number; balanceDue: number };
  expect(Math.round(folio.paymentsTotal * 100)).toBe(Math.round(Number(reservation.totalAmount) * 100));
  expect(folio.balanceDue).toBeLessThanOrEqual(0);
});
