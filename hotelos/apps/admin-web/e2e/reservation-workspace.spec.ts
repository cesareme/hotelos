import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Ficha de reserva (Tanda UX-1 · lote U7 · docs/design/UX-RECEPCION-FEEL.md
 * §5.5-5.6, F7 F13 F14 F20, §4.2): barra de comandos con una sola primaria,
 * cambio de habitación de un alojado con deshacer, cargo con deshacer y
 * factura a empresa con el número real.
 *   1. UXDAY-T4 (alojado en la 310): la cabecera no pinta Check-in/Check-out
 *      juntos (≤ 1 filled), «Cambiar habitación» → select + Intro = 3 acciones
 *      → toast «Cambio de la 310 a la NNN» con «Deshacer»; por API la reserva
 *      cambia de habitación y, tras deshacer, vuelve a la 310 (el seed queda como estaba);
 *   2. UXDAY-T6: Folio › importe 12 + Intro → línea optimista y toast con
 *      «Deshacer»; deshacer la retira sin haber enviado nada (el API no tiene
 *      DELETE de líneas); repetido sin deshacer, la línea llega al API;
 *   3. factura a empresa: reserva corporativa creada aquí por API (emitir con
 *      número entra en la cadena VeriFactu y `seed-ux-day --reset` la conserva):
 *      Documentos › «Factura a empresa» → razón social recordada de la reserva
 *      (3.3.7), NIF, «Emitir ahora con número», Intro → toast «Factura <número>
 *      emitida»; la factura existe `issued` y el NIF queda recordado para la próxima.
 */
type Room = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Toast del ToastHost; los anunciados por la región viva del shell no llevan role=status (R5), así que se localizan por data-cocoa. */
function toast(page: Page, text: string | RegExp) {
  return page.locator('[data-cocoa="toast"]').filter({ hasText: text }).first();
}

/** Habitaciones que otras reservas activas tienen asignadas en la ventana de la estancia (el API rechaza el traslado a ellas). */
async function heldRooms(request: APIRequestContext, headers: Record<string, string>, stay: { arrivalDate: string; departureDate: string }, exceptId: string): Promise<Set<string>> {
  const url = `${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations?from=${stay.arrivalDate.slice(0, 10)}&to=${stay.departureDate.slice(0, 10)}&status=confirmed,checked_in&limit=500&envelope=1`;
  const page = (await (await request.get(url, { headers })).json()) as { items?: Array<{ id: string; assignedRoomId?: string | null }> } | Array<{ id: string; assignedRoomId?: string | null }>;
  const items = Array.isArray(page) ? page : (page.items ?? []);
  return new Set(items.filter((item) => item.id !== exceptId && item.assignedRoomId).map((item) => item.assignedRoomId as string));
}

async function reservationRoom(request: APIRequestContext, headers: Record<string, string>, id: string): Promise<string | null> {
  const detail = (await (await request.get(`${E2E_API_URL}/reservations/${id}`, { headers })).json()) as { assignedRoomId?: string | null };
  return detail.assignedRoomId ?? null;
}

test("T4 · la ficha cambia de habitación a un alojado en 3 acciones y lo deshace", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  // Habitación actual del alojado (310 con el seed rearmado; otra si la medida T4 ya lo movió) y una Superior libre y limpia.
  const detail = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t4`, { headers })).json()) as { assignedRoomId?: string | null; arrivalDate: string; departureDate: string };
  const before = detail.assignedRoomId ?? null;
  expect(before, "UXDAY-T4 alojado con habitación").toBeTruthy();
  const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Room[];
  const current = rooms.find((room) => room.id === before);
  expect(current).toBeTruthy();
  // El seed no deja ninguna Superior libre sin reserva (la 305 es de UXDAY-A4): la candidata es la primera que la ficha ofrecerá (mismo tipo primero, luego otros), libre, limpia y sin otra reserva.
  const held = await heldRooms(request, headers, detail, "res_uxday_t4");
  const isFree = (room: Room) => room.id !== before && !held.has(room.id) && room.sellable !== false && room.status !== "occupied" && (room.housekeepingStatus === "clean" || room.housekeepingStatus === "inspected");
  const byNumber = (a: Room, b: Room) => a.number.localeCompare(b.number, "es", { numeric: true });
  const candidate = [...rooms.filter((room) => isFree(room) && room.roomTypeId === current!.roomTypeId).sort(byNumber), ...rooms.filter((room) => isFree(room) && room.roomTypeId !== current!.roomTypeId).sort(byNumber)][0];
  expect(candidate, "una habitación libre, limpia y sin otra reserva para el traslado").toBeTruthy();

  await page.goto("/recepcion/reservas/res_uxday_t4", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  const bar = page.getByRole("group", { name: "Acciones de la reserva" });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar.getByText("En el hotel")).toBeVisible();
  await expect(bar.locator('[data-cocoa="button"][data-variant="filled"]'), "≤ 1 acción filled en la barra (P1)").toHaveCount(0);
  await expect(bar.getByRole("button", { name: /^Check-(in|out)$/ })).toHaveCount(0);

  const change = bar.getByRole("button", { name: "Cambiar habitación" });
  await change.click();
  const picker = page.getByRole("dialog", { name: "Cambiar habitación" });
  await expect(picker).toBeVisible();
  const select = picker.getByRole("combobox");
  await select.selectOption(candidate.id);
  const moved = page.waitForResponse((response) => response.request().method() === "POST" && /\/reservations\/res_uxday_t4\/assign-room$/.test(response.url()), { timeout: 15_000 });
  await select.press("Enter");
  const undoToast = toast(page, new RegExp(`Cambio de la ${current!.number} a la ${candidate.number}`));
  await expect(undoToast).toBeVisible({ timeout: 10_000 });
  expect((await moved).ok(), "POST assign-room").toBeTruthy();
  await expect(picker).toBeHidden();
  expect(await reservationRoom(request, headers, "res_uxday_t4")).toBe(candidate.id);
  // La ficha ya pinta la nueva habitación (optimista) antes de revalidar.
  await expect(page.locator('[data-cocoa="assigned-room"]')).toHaveText(candidate.number);

  const reverted = page.waitForResponse((response) => response.request().method() === "POST" && /\/reservations\/res_uxday_t4\/assign-room$/.test(response.url()), { timeout: 15_000 });
  await undoToast.getByRole("button", { name: "Deshacer" }).click();
  expect((await reverted).ok(), "POST assign-room (deshacer)").toBeTruthy();
  await expect.poll(() => reservationRoom(request, headers, "res_uxday_t4"), { timeout: 10_000 }).toBe(before);
});

test("T6 · un cargo de 12 € con «Deshacer» no llega al API; sin deshacer, sí", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  type Folio = { lines: Array<{ id: string; total: number | string }>; balanceDue: number };
  const folioBefore = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t6/folio`, { headers })).json()) as Folio;

  await page.goto("/recepcion/reservas/res_uxday_t6", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await page.getByRole("tab", { name: /^Folio/ }).click();
  const amount = page.getByLabel("Importe (€)");
  await expect(amount).toBeVisible({ timeout: 10_000 });
  await expect(amount, "importe vacío por defecto (F13)").toHaveValue("");
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/folios\/[^/]+\/lines$/.test(req.url())) posts.push(req.url());
  });

  await amount.fill("12");
  await amount.press("Enter");
  const added = toast(page, /Cargo de 12,00\s€ añadido/);
  await expect(added).toBeVisible({ timeout: 10_000 });
  await expect(amount, "el formulario se limpia (F13)").toHaveValue("");
  const table = page.getByRole("table", { name: "Cargos del folio" });
  await expect(table.getByRole("row")).toHaveCount(folioBefore.lines.length + 2); // cabecera + línea optimista
  await added.getByRole("button", { name: "Deshacer" }).click();
  await expect(toast(page, /Cargo de 12,00\s€ deshecho/)).toBeVisible({ timeout: 5_000 });
  await expect(table.getByRole("row")).toHaveCount(folioBefore.lines.length + 1);
  expect(posts, "deshacer cancela la escritura antes de enviarla").toHaveLength(0);
  const folioUndone = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t6/folio`, { headers })).json()) as Folio;
  expect(folioUndone.lines.length).toBe(folioBefore.lines.length);

  const posted = page.waitForResponse((response) => response.request().method() === "POST" && /\/folios\/[^/]+\/lines$/.test(response.url()), { timeout: 15_000 });
  await amount.fill("12");
  await amount.press("Enter");
  await expect(toast(page, /Cargo de 12,00\s€ añadido/)).toBeVisible({ timeout: 10_000 });
  expect((await posted).ok(), "POST /folios/:id/lines tras la ventana de deshacer").toBeTruthy();
  await expect.poll(async () => ((await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t6/folio`, { headers })).json()) as Folio).lines.length, { timeout: 10_000 }).toBe(folioBefore.lines.length + 1);
  const folioAfter = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t6/folio`, { headers })).json()) as Folio;
  expect(folioAfter.lines.some((line) => Math.round(Number(line.total) * 100) === 1_200)).toBeTruthy();
});

test("factura a empresa desde la ficha: razón social recordada, NIF, número real en el toast", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId, "content-type": "application/json" };
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Room[];
  // Libre, limpia y sin otra reserva en la ventana (la 111 es de UXDAY-A5: el check-in la rechaza con 409).
  const held = await heldRooms(request, headers, { arrivalDate: iso(yesterday), departureDate: iso(tomorrow) }, "");
  const free = rooms.filter((room) => room.roomTypeId === "rt_uxday_dbl" && !held.has(room.id) && room.status !== "occupied" && room.housekeepingStatus === "clean").sort((a, b) => b.number.localeCompare(a.number, "es", { numeric: true }));
  expect(free.length, "sin doble libre, limpia y sin reserva para la reserva corporativa de prueba").toBeGreaterThan(0);
  const room = free[0];
  const created = await request.post(`${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations`, {
    headers,
    data: {
      arrivalDate: iso(yesterday),
      departureDate: iso(tomorrow),
      adults: 1,
      roomTypeId: "rt_uxday_dbl",
      assignedRoomId: room.id,
      channel: "corporate",
      currency: "EUR",
      companyName: "Empresa UXDAY SL",
      billingInstruction: "company_invoice",
      primaryGuest: { firstName: "Contacto", surname1: "Corporativo" },
      // Llegó ayer: llegada pasada confirmada (L-02).
      allowPastArrival: true
    }
  });
  expect(created.ok(), `POST reservations → ${created.status()}`).toBeTruthy();
  const reservation = (await created.json()) as { id: string; code: string };
  const checkedIn = await request.post(`${E2E_API_URL}/reservations/${reservation.id}/check-in`, { headers, data: { roomId: room.id } });
  expect(checkedIn.ok(), `POST check-in → ${checkedIn.status()}`).toBeTruthy();
  const folio = (await (await request.get(`${E2E_API_URL}/reservations/${reservation.id}/folio`, { headers })).json()) as { folio: { id: string } };
  const line = await request.post(`${E2E_API_URL}/folios/${folio.folio.id}/lines`, { headers, data: { type: "minibar", description: "Minibar", quantity: 1, unitPrice: 45 } });
  expect(line.ok(), `POST folio line → ${line.status()}`).toBeTruthy();

  await page.goto(`/recepcion/reservas/${reservation.id}`, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await page.getByRole("tab", { name: "Documentos" }).click();
  await page.getByRole("button", { name: "Factura a empresa" }).click();
  const dialog = page.getByRole("dialog", { name: /Factura a empresa/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tablist", { name: "Factura a" }).getByRole("tab", { name: "Empresa" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("Razón social"), "razón social recordada de la reserva (3.3.7)").toHaveValue("Empresa UXDAY SL");
  const taxId = dialog.getByLabel("NIF");
  await expect(taxId).toBeFocused();
  await taxId.fill("B12345674");
  await dialog.getByRole("tablist", { name: "Factura", exact: true }).getByRole("tab", { name: "Emitir ahora con número" }).click();
  await expect(dialog.getByRole("button", { name: "Emitir con número" })).toBeEnabled();
  const issued = page.waitForResponse((response) => response.request().method() === "POST" && /\/invoices\/[^/]+\/issue$/.test(response.url()), { timeout: 20_000 });
  await taxId.press("Enter");
  expect((await issued).ok(), "POST /invoices/:id/issue").toBeTruthy();
  const invoiceToast = toast(page, /Factura \S+ emitida/);
  await expect(invoiceToast).toBeVisible({ timeout: 20_000 });
  const invoiceNumber = /Factura (\S+) emitida/.exec((await invoiceToast.innerText()).trim())?.[1];
  expect(invoiceNumber, "el toast lleva el número real").toBeTruthy();
  await expect(dialog).toBeHidden();

  const invoices = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/invoices`, { headers })).json()) as Array<{ invoiceNumber?: string; status: string; customerType?: string; customerName?: string | null }> | { items: Array<{ invoiceNumber?: string; status: string; customerType?: string; customerName?: string | null }> };
  const list = Array.isArray(invoices) ? invoices : invoices.items;
  const invoice = list.find((item) => item.invoiceNumber === invoiceNumber);
  expect(invoice, `la factura ${invoiceNumber} existe`).toBeTruthy();
  expect(invoice!.status).toBe("issued");
  expect(invoice!.customerType).toBe("company");
  expect(invoice!.customerName).toBe("Empresa UXDAY SL");

  // 3.3.7: la próxima factura a esa razón social recuerda el NIF (y el folio ya facturado lo dice el API, no la ficha a ciegas).
  await page.getByRole("button", { name: "Factura a empresa" }).click();
  await expect(page.getByRole("dialog", { name: /Factura a empresa/ }).getByLabel("NIF")).toHaveValue("B12345674");
  await expect(page.getByRole("dialog", { name: /Factura a empresa/ }).getByText("Recordado de la última factura a este nombre.")).toBeVisible();
});
