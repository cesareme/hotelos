import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay, provisionDeparture } from "./_helpers";

/**
 * Check-out rápido (Tanda UX-1 · lote U6 · §5.4, F5, F14 parcial, D6): salida
 * con saldo desde Mi día. La reserva se crea aquí mismo por API (llegó ayer,
 * sale hoy, Doble libre, limpia y sin otra reserva —`provisionDeparture` de
 * _helpers.ts filtra por solape como el API—, 45 € de minibar sin cobrar) porque
 * emitir la factura con número entra en la cadena VeriFactu y `seed-ux-day
 * --reset` conserva esa reserva (cerrada, sin retener la habitación): las
 * UXDAY-* del seed (T3, D2…) deben seguir rearmables para el proyecto «measure».
 *   1. «Salen hoy» → la fila lleva la acción primaria «Cobrar 45,00 € y cerrar»
 *      (primaryActionFor: sale hoy con saldo);
 *   2. el cajón NO tiene el switch «Avisar a housekeeping» (D6) y dice «La
 *      habitación pasará a sucia.»; «Factura a» ofrece Huésped / Empresa;
 *      «Factura» ofrece borrador (por defecto) / emitir ahora / sin factura;
 *   3. con «Emitir ahora con número», el CTA repite «Cobrar 45,00 € y cerrar»
 *      (dos etiquetas en total) e Intro lo confirma;
 *   4. toasts «Check-out de la NNN hecho» y «Factura <número> emitida» con el
 *      número real (esperada, no en segundo plano); el cajón se cierra al instante;
 *   5. por API: reserva `checked_out`, saldo 0 y la factura `issued` con ese número.
 */
test("el drawer de check-out cobra el saldo, cierra y emite la factura con su número", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId, "content-type": "application/json" };
  const departure = await provisionDeparture(request, headers, { balance: 45, guest: { firstName: "Prueba", surname1: "Salida" } });
  type Folio = { folio: { id: string }; balanceDue: number; paymentsTotal: number };
  const folioBefore = (await (await request.get(`${E2E_API_URL}/reservations/${departure.id}/folio`, { headers })).json()) as Folio;
  expect(folioBefore.balanceDue).toBe(departure.balance);
  const balanceText = folioBefore.balanceDue.toFixed(2).replace(".", ",");

  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await page.getByRole("tablist", { name: "Vista de recepción" }).getByRole("tab", { name: /^Salen hoy/ }).click();
  const departures = page.getByRole("table", { name: "Salidas de hoy" });
  await expect(departures).toBeVisible({ timeout: 10_000 });
  const row = departures.getByRole("row").filter({ has: page.getByRole("cell", { name: departure.room.number, exact: true }) }).first();
  const primary = row.getByRole("button", { name: new RegExp(`^Cobrar ${balanceText} € y cerrar$`) });
  await expect(primary, "la fila que sale hoy con saldo lleva «Cobrar X € y cerrar»").toBeEnabled({ timeout: 10_000 });
  await primary.click();

  const drawer = page.getByRole("dialog").filter({ hasText: new RegExp(`Hab\\. ${departure.room.number}`) }).first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  // D6: sin switch decorativo; frase informativa. Factura a huésped / empresa (F14 parcial) y modo de factura.
  await expect(drawer.getByText(/Avisar a housekeeping/)).toHaveCount(0);
  await expect(drawer.getByText("La habitación pasará a sucia.")).toBeVisible();
  const invoiceTo = drawer.getByRole("tablist", { name: "Factura a" });
  await expect(invoiceTo.getByRole("tab", { name: "Huésped" })).toHaveAttribute("aria-selected", "true");
  await expect(invoiceTo.getByRole("tab", { name: "Empresa" })).toBeVisible();
  const invoiceMode = drawer.getByRole("tablist", { name: "Factura", exact: true });
  await expect(invoiceMode.getByRole("tab", { name: "Borrador para Facturación" })).toHaveAttribute("aria-selected", "true");
  await invoiceMode.getByRole("tab", { name: "Emitir ahora con número" }).click();
  // El estado se pinta con el diccionario, nunca el enum crudo.
  await expect(drawer.getByText("En el hotel").first()).toBeVisible();
  await expect(drawer.getByText(/checked_in/)).toHaveCount(0);

  const cta = drawer.getByRole("button", { name: new RegExp(`^Cobrar ${balanceText} € y cerrar$`) });
  await expect(cta).toBeEnabled({ timeout: 10_000 });
  await cta.focus();
  await cta.press("Enter");

  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: new RegExp(`Check-out de la ${departure.room.number} hecho`) }).first()).toBeVisible({ timeout: 20_000 });
  const invoiceToast = page.locator('[data-cocoa="toast"]').filter({ hasText: /Factura \S+ emitida/ }).first();
  await expect(invoiceToast).toBeVisible({ timeout: 20_000 });
  const invoiceNumber = /Factura (\S+) emitida/.exec((await invoiceToast.innerText()).trim())?.[1];
  expect(invoiceNumber, "el toast lleva el número real de la factura").toBeTruthy();
  // El cajón se cierra al instante (sin espera de 2,5 s) y la fila pasa a «Salida hecha».
  await expect(drawer).toBeHidden({ timeout: 5_000 });
  await expect(row.getByText("Salida hecha")).toBeVisible({ timeout: 10_000 });

  const after = (await (await request.get(`${E2E_API_URL}/reservations/${departure.id}`, { headers })).json()) as { status: string };
  expect(after.status).toBe("checked_out");
  const folioAfter = (await (await request.get(`${E2E_API_URL}/reservations/${departure.id}/folio`, { headers })).json()) as Folio;
  expect(Math.abs(folioAfter.balanceDue)).toBeLessThan(0.01);
  expect(Math.round(folioAfter.paymentsTotal * 100)).toBe(Math.round((folioBefore.paymentsTotal + folioBefore.balanceDue) * 100));
  const invoices = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/invoices`, { headers })).json()) as Array<{ invoiceNumber?: string; status: string }> | { items: Array<{ invoiceNumber?: string; status: string }> };
  const list = Array.isArray(invoices) ? invoices : invoices.items;
  const issued = list.find((invoice) => invoice.invoiceNumber === invoiceNumber);
  expect(issued, `la factura ${invoiceNumber} existe en el listado`).toBeTruthy();
  expect(issued!.status).toBe("issued");
});
