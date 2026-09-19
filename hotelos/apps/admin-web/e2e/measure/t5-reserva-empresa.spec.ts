import { expect, test } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "../_helpers";
import { createMeasure, toastContaining, writeResult } from "./_measure";

/**
 * T5 · «Llama una empresa para reservar una doble del … al …; la factura irá
 * a nombre de la empresa. Crea la reserva.» (§8.2 · éxito: reserva + datos de
 * facturación de empresa; objetivo ≤ 7 pasos y con precio, UX-1: 1 pantalla).
 *
 * Camino U9a (§5.10): Nueva reserva en modo rápido (por defecto) → fechas +7/+9
 * → tipo Doble con precio en vivo (preseleccionado si es el primero con
 * disponibilidad; si no, 1 clic) → nombre + apellido → origen Teléfono →
 * razón social (la instrucción de cobro pasa sola a «Factura a empresa») + NIF
 * → Intro = 1-2 clics + 6 campos + Intro; la reserva se abre en su ficha con
 * el precio de la tarifa. Antes (asistente de 6 pasos): 9 clics + 112 teclas y
 * el API exigía dos correos y el país en ISO-3.
 *
 * Parte de factura (U7 · F14, 3.3.7), medida aparte tras crear la reserva y
 * anotada en `context` (invoiceClicks · invoiceKeys): un cargo por API (el
 * folio nace vacío hasta el cierre del día) → ficha › Documentos › «Factura a
 * empresa» → razón social recordada de la reserva y NIF recordado del modo
 * rápido (3.3.7) → Intro → borrador (por defecto; «Emitir ahora con número» es
 * irreversible y `seed-ux-day --reset` conservaría la reserva).
 */
test("t5 · reserva por teléfono para una empresa con factura a la empresa", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const measure = createMeasure(page, "t5");
  await page.goto("/recepcion/reservas/nueva", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  const form = page.getByRole("form", { name: "Nueva reserva rápida" });
  await expect(form).toBeVisible({ timeout: 15_000 });
  const typeSelect = form.locator("#rc-field-roomtype");
  await expect.poll(async () => (await typeSelect.locator("option").allTextContents()).some((text) => /Doble · \d+,\d\d\s€\/noche · \d+ libres?/.test(text)), { timeout: 10_000 }).toBe(true);
  measure.step("Nueva reserva (modo rápido) cargada con precio en vivo");

  const iso = (offsetDays: number) => {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  };
  const arrival = iso(7);
  const departure = iso(9);
  const company = "Empresa UXDAY SL";
  const nif = "B12345674";

  await measure.start(page);
  // Estancia: fechas y tipo (con precio en vivo; Doble ya preseleccionado si es el primero con disponibilidad).
  const dates = form.locator('input[type="date"]');
  await measure.countedFill(dates.nth(0), arrival, "Llegada");
  await measure.countedFill(dates.nth(1), departure, "Salida");
  if (!/Doble/.test((await typeSelect.locator("option:checked").textContent()) ?? "")) {
    await measure.countedSelect(typeSelect, "Tipo de habitación = Doble", "rt_uxday_dbl");
  }
  await expect.poll(async () => (await typeSelect.locator("option:checked").textContent()) ?? "", { timeout: 10_000 }).toMatch(/Doble · \d+,\d\d\s€\/noche/);
  // Huésped: persona de contacto (ficticia).
  await measure.countedFill(form.locator("#rc-field-firstname"), "Contacto", "Nombre");
  await measure.countedFill(form.locator("#rc-field-surname1"), "Corporativo", "Apellido");
  // Origen y empresa: la razón social pone sola la instrucción «Factura a empresa».
  await measure.countedSelect(form.getByLabel("Origen de la reserva"), "Origen de la reserva = Teléfono", "phone");
  await measure.countedFill(form.getByLabel("Razón social"), company, "Razón social");
  const taxIdField = form.getByLabel("NIF", { exact: true });
  await measure.countedFill(taxIdField, nif, "NIF de la empresa");
  await expect(form.getByText("Factura a empresa", { exact: true }), "insignia «Factura a empresa» (la instrucción de cobro cambió sola)").toBeVisible();
  // Intro crea la reserva y abre la ficha.
  const created = page.waitForResponse((response) => response.request().method() === "POST" && /\/properties\/[^/]+\/reservations$/.test(response.url()), { timeout: 20_000 });
  await measure.countedPress(page, "Enter", "Intro (Crear reserva)");
  const createdResponse = await created;
  expect(createdResponse.ok(), `POST reservations → ${createdResponse.status()}`).toBeTruthy();
  const reservation = (await createdResponse.json()) as { id: string; code: string; totalAmount: number | string };
  await expect(toastContaining(page, new RegExp(`Reserva ${reservation.code} creada`))).toBeVisible({ timeout: 15_000 });
  expect(Number(reservation.totalAmount), "con precio (tarifa publicada)").toBeGreaterThan(0);

  const result = await measure.finish(page, {
    completed: true,
    context: { reservationCode: reservation.code, steps: 1, arrival, departure, company, totalEur: Number(reservation.totalAmount), withPrice: true },
    note: "modo rápido (U9a): 1 pantalla, precio en vivo en el tipo, razón social → «Factura a empresa» sola, Intro crea y abre la ficha; sin correos ni país obligatorios"
  });

  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const detail = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}`, { headers })).json()) as {
    bookingSource?: string | null;
    companyName: string | null;
    billingInstruction: string | null;
    arrivalDate: string;
    departureDate: string;
    totalAmount: number | string;
  };
  if ("bookingSource" in detail) expect(detail.bookingSource).toBe("phone");
  expect(detail.companyName).toBe(company);
  expect(detail.billingInstruction).toBe("company_invoice");
  expect(detail.arrivalDate.slice(0, 10)).toBe(arrival);
  expect(detail.departureDate.slice(0, 10)).toBe(departure);
  expect(Number(detail.totalAmount)).toBeGreaterThan(0);
  expect(result.clicks).toBeLessThanOrEqual(2);

  // --- Parte de factura (U7): desde la ficha, con razón social y NIF recordados (3.3.7).
  await expect(page).toHaveURL(new RegExp(`/recepcion/reservas/${reservation.id}`), { timeout: 15_000 });
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers })).json()) as { folio: { id: string } };
  const line = await request.post(`${E2E_API_URL}/folios/${folio.folio.id}/lines`, { headers: jsonHeaders, data: { type: "room", description: "Alojamiento (anticipo de prueba)", quantity: 1, unitPrice: 89 } });
  expect(line.ok(), `POST folio line → ${line.status()}`).toBeTruthy();
  await page.goto(`/recepcion/reservas/${reservation.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("group", { name: "Acciones de la reserva" })).toBeVisible({ timeout: 15_000 });
  let invoiceClicks = 0;
  let invoiceKeys = 0;
  await page.getByRole("tab", { name: "Documentos" }).click();
  invoiceClicks += 1;
  await page.getByRole("button", { name: "Factura a empresa" }).click();
  invoiceClicks += 1;
  const dialog = page.getByRole("dialog", { name: /Factura a empresa/ });
  await expect(dialog.getByLabel("Razón social"), "razón social recordada de la reserva (3.3.7)").toHaveValue(company);
  const taxId = dialog.getByLabel("NIF");
  await expect(taxId, "NIF recordado del modo rápido (3.3.7)").toHaveValue(nif);
  const drafted = page.waitForResponse((response) => response.request().method() === "POST" && /\/folios\/[^/]+\/invoice$/.test(response.url()), { timeout: 20_000 });
  await taxId.press("Enter");
  invoiceKeys += 1;
  expect((await drafted).ok(), "POST /folios/:id/invoice").toBeTruthy();
  await expect(toastContaining(page, /Borrador de factura creado/)).toBeVisible({ timeout: 15_000 });
  writeResult("t5", {
    ...result,
    context: { ...(result.context ?? {}), invoiceClicks, invoiceKeys, invoiceMode: "draft" },
    note: `${result.note ?? ""}; factura a empresa desde la ficha (U7): ${invoiceClicks} clics + ${invoiceKeys} teclas, razón social y NIF recordados, borrador`
  });
});
