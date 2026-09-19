import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay, provisionDeparture } from "./_helpers";

/**
 * Lista de reservas (Tanda UX-1 · lote U8 · §5.7, F10, F11, F26, F34, D11) con
 * la sesión de recepción del tenant UXDAY (seed-ux-day):
 *   1. al montar, la primera petición de reservas es la página de la vista
 *      (nunca un sondeo `limit=1`); las peticiones GET al API se cuentan y se
 *      imprimen (antes de U8: 8 GET antes del primer pintado);
 *   2. «En el hotel» + «204» encuentra UXDAY-T3 (la habitación se filtra en
 *      cliente: ningún GET lleva `q=204`) y la tabla no se vacía a esqueleto
 *      mientras se teclea; si la medida t3 ya cerró UXDAY-T3 (`pnpm e2e` corre
 *      el proyecto «measure» antes), la spec crea por API una salida equivalente
 *      (alojada, sale hoy, 120 € pendientes) y busca su habitación;
 *   3. Intro sobre la fila abre el inspector lateral (role=complementary) con
 *      el código en el título y la acción primaria de U6 (sale hoy con 120 €:
 *      «Cobrar 120,00 € y cerrar»);
 *   4. ↑↓ cambian de reserva sin cerrar el panel; Esc lo cierra y el foco
 *      vuelve a la fila;
 *   5. «Columnas ▾» oculta «Origen» y la preferencia sobrevive a la recarga
 *      (localStorage `hotelos-table-columns:reservas.lista`).
 */
const LIST_URL = "/recepcion/reservas/lista";

/**
 * Reserva alojada que sale hoy con 120 € pendientes: UXDAY-T3 en la 204 con el seed rearmado; si la medida t3 ya la cerró,
 * una salida de prueba equivalente creada por API (Doble libre, limpia y sin otra reserva; sin factura: la borra el reset).
 */
async function inHouseDepartureWithBalance(request: APIRequestContext, headers: Record<string, string>): Promise<{ code: string; room: string; balanceText: string }> {
  type Detail = { code?: string; status?: string; assignedRoomId?: string | null };
  type Folio = { balanceDue: number };
  const t3 = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t3`, { headers })).json()) as Detail;
  if (t3.status === "checked_in" && t3.assignedRoomId) {
    const folio = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t3/folio`, { headers })).json()) as Folio;
    const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Array<{ id: string; number: string }>;
    const room = rooms.find((item) => item.id === t3.assignedRoomId);
    if (room && Math.round(folio.balanceDue * 100) === 12_000) return { code: "UXDAY-T3", room: room.number, balanceText: "120,00" };
  }
  const departure = await provisionDeparture(request, headers, { balance: 120, guest: { firstName: "Prueba", surname1: "Lista" } });
  // eslint-disable-next-line no-console
  console.log(`[e2e:reservations-list] UXDAY-T3 ya no está alojada con 120 € (measure t3): salida de prueba ${departure.code} en la ${departure.room.number}`);
  return { code: departure.code, room: departure.room.number, balanceText: "120,00" };
}

function trackApiGets(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().startsWith(E2E_API_URL)) urls.push(request.url());
  });
  return urls;
}

test("la lista busca por habitación, abre el inspector con Intro, ↑↓ cambian de reserva y las columnas persisten", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const target = await inHouseDepartureWithBalance(request, { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId });
  const gets = trackApiGets(page);
  await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);

  const table = page.getByRole("table", { name: "Reservas" });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(table.locator("tbody tr[data-interactive]").first()).toBeVisible({ timeout: 10_000 });

  // 1 · Peticiones al montar: la lista va primero; los contadores se difieren tras el primer pintado.
  const reservationGets = gets.filter((url) => /\/reservations\?/.test(url));
  expect(reservationGets.length, "la página de la vista se pide al montar").toBeGreaterThanOrEqual(1);
  expect(reservationGets[0], "la primera petición de reservas es la página, no un sondeo limit=1").not.toMatch(/[?&]limit=1(&|$)/);
  // Los contadores se difieren tras el primer pintado: se espera a que la red se asiente, no una ventana fija (UX1-REV-13).
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const probes = gets.filter((url) => /[?&]limit=1(&|$)/.test(url)).length;
  const departuresWindow = gets.filter((url) => /[?&]limit=300(&|$)/.test(url)).length;
  const catalog = gets.filter((url) => /\/(rooms|room-types)(\?|$)/.test(url)).length;
  // eslint-disable-next-line no-console
  console.log(`[e2e:reservations-list] GET al API hasta 1 s tras el primer pintado: ${gets.length} (página de la vista ${reservationGets.length - probes - departuresWindow} · catálogos ${catalog} · diferidos: ${probes} sondeos limit=1 + ${departuresWindow} ventana de salidas · shell ${gets.length - reservationGets.length - catalog})`);
  expect(probes, "como mucho 3 sondeos limit=1 (los KPI que no son la vista activa)").toBeLessThanOrEqual(3);

  // 2 · «En el hotel» + «204» → UXDAY-T3 (o la salida de prueba y su habitación), en cliente y sin vaciar la tabla.
  await page.getByRole("tablist", { name: "Vistas operativas" }).getByRole("tab", { name: /^En el hotel/ }).click();
  const rowsBefore = table.locator("tbody tr[data-interactive]");
  await expect(rowsBefore.nth(1)).toBeVisible({ timeout: 10_000 });
  const search = page.locator("#reservations-search");
  await search.fill(target.room);
  // Mientras se teclea no hay filas esqueleto: la tabla sigue montada.
  await expect(page.locator('[data-cocoa="table-loading"]')).toHaveCount(0);
  const t3 = table.getByRole("row").filter({ hasText: target.code }).first();
  await expect(t3).toBeVisible({ timeout: 10_000 });
  await expect(t3.getByRole("cell", { name: target.room, exact: true })).toBeVisible();
  expect(gets.some((url) => new RegExp(`[?&]q=${target.room}`).test(url)), "una habitación nunca viaja como q").toBe(false);

  // 3 · Intro abre el inspector con la acción primaria de U6.
  await t3.focus();
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("complementary", { name: new RegExp(`Detalle de la reserva ${target.code}`) });
  await expect(inspector).toBeVisible({ timeout: 10_000 });
  await expect(inspector.getByRole("heading", { level: 2 })).toContainText(target.code);
  await expect(inspector.getByRole("heading", { level: 2 })).toContainText(target.room);
  await expect(inspector.getByRole("button", { name: new RegExp(`^Cobrar ${target.balanceText} € y cerrar$`) }), "sale hoy con 120 € pendientes (folio)").toBeVisible({ timeout: 10_000 });
  await expect(inspector.getByRole("button", { name: "Abrir ficha completa" })).toBeVisible();
  await expect(inspector.getByRole("list", { name: "Folio abreviado" })).toBeVisible({ timeout: 10_000 });
  // El estado se pinta con el diccionario, nunca el enum crudo.
  await expect(inspector.getByText(/checked_in/)).toHaveCount(0);

  // 4 · Con varias filas, ↑↓ cambian de reserva sin cerrar el panel.
  await search.fill("");
  await expect(rowsBefore.nth(1)).toBeVisible({ timeout: 10_000 });
  // El shell tiene su propio landmark complementary (la navegación): el inspector se localiza por su nombre.
  const panel = page.getByRole("complementary", { name: /^Detalle de la reserva/ });
  await expect(panel).toHaveCount(1);
  const t3Again = table.getByRole("row").filter({ hasText: target.code }).first();
  await t3Again.focus();
  const t3Index = await table.locator("tbody tr[data-interactive]").evaluateAll((rows, needle) => rows.findIndex((row) => row.textContent?.includes(needle)), target.code);
  const direction = t3Index > 0 ? "ArrowUp" : "ArrowDown";
  await page.keyboard.press(direction);
  await expect(panel).toHaveCount(1);
  await expect(panel.getByRole("heading", { level: 2 })).not.toContainText(target.code);
  await page.keyboard.press(direction === "ArrowUp" ? "ArrowDown" : "ArrowUp");
  await expect(panel.getByRole("heading", { level: 2 })).toContainText(target.code);
  // El foco sigue en la fila (no en el panel): la lista sigue siendo el sitio de trabajo.
  await expect(t3Again).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(t3Again).toBeFocused();

  // 5 · «Columnas ▾»: ocultar «Origen» persiste tras recargar.
  await expect(table.getByRole("columnheader", { name: /Origen/ })).toBeVisible();
  // El popover de columnas no cambia de lado ni limita su alto (CocoaPopover, observación para U10): se abre
  // con el botón arriba del viewport para que las nueve filas y el pie queden a la vista.
  const openColumns = async () => {
    const button = page.getByRole("button", { name: "Columnas" });
    await button.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await button.click();
  };
  await openColumns();
  const menu = page.getByRole("dialog", { name: "Columnas de la tabla" });
  await expect(menu).toBeVisible();
  await menu.getByLabel("Origen", { exact: true }).uncheck();
  await expect(table.getByRole("columnheader", { name: /Origen/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const stored = await page.evaluate(() => window.localStorage.getItem("hotelos-table-columns:reservas.lista"));
  expect(stored, "la preferencia se guarda en localStorage").toContain("sourceCode");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("table", { name: "Reservas" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Reservas" }).getByRole("columnheader", { name: /Código/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Reservas" }).getByRole("columnheader", { name: /Origen/ })).toHaveCount(0);
  // Se vuelve a mostrar la columna para no condicionar otras specs (el pie «Restablecer» del popover
  // queda fuera del viewport de 900 px con nueve columnas: observación para CocoaPopover, U10).
  await openColumns();
  await page.getByRole("dialog", { name: "Columnas de la tabla" }).getByLabel("Origen", { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("table", { name: "Reservas" }).getByRole("columnheader", { name: /Origen/ })).toBeVisible();
  const restored = JSON.parse((await page.evaluate(() => window.localStorage.getItem("hotelos-table-columns:reservas.lista"))) ?? "{}") as { hidden?: string[] };
  expect(restored.hidden ?? []).not.toContain("sourceCode");
});
