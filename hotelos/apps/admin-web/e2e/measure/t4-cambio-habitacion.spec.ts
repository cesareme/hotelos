import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "../_helpers";
import { createMeasure, waitForMiDia } from "./_measure";

/**
 * T4 · «El huésped de la 310 tiene una avería. Cámbialo a otra habitación.»
 * (§8.2 · éxito: reserva checked_in con nueva habitación; objetivo ≤ 4,
 * óptimo UX-1: 3 = «Cambiar habitación» + select + Intro).
 *
 * Camino UX-1 (U7): Mi día › En el hotel › fila de la 310 › ficha (2 clics) →
 * «Cambiar habitación» en la barra de comandos → habitación → Intro (2 clics +
 * 1 tecla). El traslado es optimista con «Deshacer» 8 s (F7, §4.2); la spec no
 * deshace: la medida deja al huésped en la nueva habitación y `seed-ux-day
 * --reset` rearma el día.
 */
type Room = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean };

/** Habitaciones que otras reservas activas tienen asignadas en la ventana de la estancia (el API rechaza el traslado a ellas). */
async function heldRooms(request: APIRequestContext, headers: Record<string, string>, stay: { arrivalDate: string; departureDate: string }, exceptId: string): Promise<Set<string>> {
  const url = `${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations?from=${stay.arrivalDate.slice(0, 10)}&to=${stay.departureDate.slice(0, 10)}&status=confirmed,checked_in&limit=500&envelope=1`;
  const page = (await (await request.get(url, { headers })).json()) as { items?: Array<{ id: string; assignedRoomId?: string | null }> } | Array<{ id: string; assignedRoomId?: string | null }>;
  const items = Array.isArray(page) ? page : (page.items ?? []);
  return new Set(items.filter((item) => item.id !== exceptId && item.assignedRoomId).map((item) => item.assignedRoomId as string));
}

test("t4 · avería en la 310: cambiar de habitación a un alojado", async ({ page, request }, testInfo) => {
  const session = await loginAsUxDay(page, request);
  const headers = { Authorization: `Bearer ${session.token}`, "x-property-id": UXDAY.propertyId };
  const rooms = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Room[];
  // Habitación actual del alojado (310 con el seed rearmado; otra si una pasada anterior ya lo movió).
  const detailBefore = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t4`, { headers })).json()) as { assignedRoomId?: string | null; arrivalDate: string; departureDate: string };
  const current = rooms.find((room) => room.id === detailBefore.assignedRoomId);
  expect(current, "UXDAY-T4 alojado con habitación").toBeTruthy();
  // El seed no deja ninguna Superior libre sin reserva (la 305 es de UXDAY-A4): la candidata es la primera que la ficha ofrece (mismo tipo, luego otros), libre, limpia y sin otra reserva.
  const held = await heldRooms(request, headers, detailBefore, "res_uxday_t4");
  const isFree = (room: Room) => room.id !== current!.id && !held.has(room.id) && room.sellable !== false && room.status !== "occupied" && (room.housekeepingStatus === "clean" || room.housekeepingStatus === "inspected");
  const byNumber = (a: Room, b: Room) => a.number.localeCompare(b.number, "es", { numeric: true });
  const candidate = [...rooms.filter((room) => isFree(room) && room.roomTypeId === current!.roomTypeId).sort(byNumber), ...rooms.filter((room) => isFree(room) && room.roomTypeId !== current!.roomTypeId).sort(byNumber)][0];
  expect(candidate, "una habitación libre, limpia y sin otra reserva para el traslado (seed rearmado)").toBeTruthy();
  const measure = createMeasure(page, "t4");
  await page.goto("/hoy", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiDia(page);
  measure.step("Mi día cargado");

  await measure.start(page);
  await measure.countedClick(page.getByRole("tablist", { name: "Vista de recepción" }).getByRole("tab", { name: /^En el hotel/ }), "Pestaña En el hotel");
  const inHouse = page.getByRole("table", { name: "Huéspedes alojados" });
  await expect(inHouse).toBeVisible({ timeout: 10_000 });
  const row = inHouse.getByRole("row").filter({ has: page.getByRole("cell", { name: current!.number, exact: true }) }).first();
  await expect(row).toBeVisible();
  const open = row.getByRole("button", { name: /Ver folio|Ver reserva|Abrir/ }).first();
  await measure.countedClick(open, `Abrir la ficha de la ${current!.number}`);
  await expect(page).toHaveURL(/\/recepcion\/reservas\/res_uxday_t4/, { timeout: 15_000 });
  await measure.mark(page, "ficha-open");

  const bar = page.getByRole("group", { name: "Acciones de la reserva" });
  await measure.countedClick(bar.getByRole("button", { name: "Cambiar habitación" }), "Cambiar habitación (barra de comandos)");
  const picker = page.getByRole("dialog", { name: "Cambiar habitación" });
  await expect(picker).toBeVisible();
  await measure.countedSelect(picker.getByRole("combobox"), `Habitación = ${candidate.number}`, candidate.id);
  const moved = page.waitForResponse((response) => response.request().method() === "POST" && /\/reservations\/res_uxday_t4\/assign-room$/.test(response.url()), { timeout: 15_000 });
  await measure.countedPress(page, "Enter", "Intro (mover)");
  // El toast del traslado lo anuncia la región viva del shell (sin role=status, R5): se localiza por data-cocoa.
  await expect(page.locator('[data-cocoa="toast"]').filter({ hasText: new RegExp(`Cambio de la ${current!.number} a la ${candidate.number}`) }).first()).toBeVisible({ timeout: 10_000 });
  expect((await moved).ok(), "POST assign-room").toBeTruthy();

  const result = await measure.finish(page, {
    completed: true,
    context: { reservationCode: "UXDAY-T4", fromRoom: Number(current!.number), toRoom: Number(candidate.number), undoOffered: true },
    note: "traslado optimista con «Deshacer» 8 s (no se deshace en la medida); el seed rearma la 310"
  });

  const detail = (await (await request.get(`${E2E_API_URL}/reservations/res_uxday_t4`, { headers })).json()) as { status: string; assignedRoomId?: string | null };
  expect(detail.status).toBe("checked_in");
  expect(detail.assignedRoomId).toBe(candidate.id);
  expect(result.clicks + result.keys).toBeLessThanOrEqual(5);
});
