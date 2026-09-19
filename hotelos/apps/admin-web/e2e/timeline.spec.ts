import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_URL, UXDAY, assertNoLoginGate, loginAsUxDay } from "./_helpers";

/**
 * Live Timeline (Tanda UX-1 · lote U9b · docs/design/UX-RECEPCION-FEEL.md
 * §5.11, §4.2, §7.1 2.1.1 / 2.5.7 / 2.5.8, §7.2, F24):
 *   1. UXDAY-T4 (alojado): con la barra seleccionada, ⌥↓ la cambia a la
 *      habitación de la fila de abajo SIN diálogo (POST assign-room directo,
 *      barra optimista + «Deshacer» 8 s) y ⌘Z / Ctrl+Z la devuelve (POST
 *      assign-room inverso); ⌥→ sobre un alojado se rechaza con el motivo del
 *      motor sin ninguna petición (el API responde 409 REC-03 a las fechas);
 *      ⌥↓ contra una habitación ocupada se rechaza con el motivo, sin petición.
 *   2. Una llegada confirmada: ⌥→ mueve la estancia un día (PATCH directo, sin
 *      diálogo) y «Deshacer» de la barra la devuelve (PATCH inverso).
 *   3. Tablet emulada (820 × 1180, dedo): las barras miden ≥ 44 px, un
 *      deslizamiento vertical sobre las barras DESPLAZA la parrilla sin mover
 *      nada, y la pulsación larga (250 ms) arma el arrastre: mover una celda a
 *      la derecha aplica el PATCH sin diálogo y «Deshacer» lo revierte.
 * Datos: solo el tenant UXDAY; el seed no deja ninguna Superior libre junto a
 * la 310 (309 / 311 alojadas), así que si T4 no tiene una habitación vecina
 * libre del mismo tipo la spec lo traslada antes por API a una Doble libre con
 * la siguiente también libre (como hace la medida T4) y deja constancia; al
 * final T4 queda donde empezó la parte de teclado (deshacer real) y las
 * llegadas movidas vuelven a su fecha (deshacer real). `seed-ux-day --reset`
 * rearma el día.
 */
type Room = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable?: boolean; maintenanceStatus?: string };
type Reservation = { id: string; code: string; status: string; assignedRoomId?: string | null; arrivalDate: string; departureDate: string; roomTypeId: string };

const T4 = "res_uxday_t4";
const CONTROL_OR_META = process.platform === "darwin" ? "Meta" : "Control";

function headersFor(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "x-property-id": UXDAY.propertyId };
}

async function getReservation(request: APIRequestContext, headers: Record<string, string>, id: string): Promise<Reservation> {
  return (await (await request.get(`${E2E_API_URL}/reservations/${id}`, { headers })).json()) as Reservation;
}

async function getRooms(request: APIRequestContext, headers: Record<string, string>): Promise<Room[]> {
  const payload = (await (await request.get(`${E2E_API_URL}/properties/${UXDAY.propertyId}/rooms`, { headers })).json()) as Room[] | { items?: Room[] };
  return Array.isArray(payload) ? payload : (payload.items ?? []);
}

/** Habitaciones que otras reservas vivas tienen asignadas en la ventana de la estancia (el motor y el API las rechazan). */
async function heldRooms(request: APIRequestContext, headers: Record<string, string>, stay: { arrivalDate: string; departureDate: string }, exceptId: string): Promise<Set<string>> {
  const url = `${E2E_API_URL}/properties/${UXDAY.propertyId}/reservations?from=${stay.arrivalDate.slice(0, 10)}&to=${stay.departureDate.slice(0, 10)}&status=confirmed,checked_in&limit=500&envelope=1`;
  const page = (await (await request.get(url, { headers })).json()) as { items?: Array<{ id: string; assignedRoomId?: string | null }> } | Array<{ id: string; assignedRoomId?: string | null }>;
  const items = Array.isArray(page) ? page : (page.items ?? []);
  return new Set(items.filter((item) => item.id !== exceptId && item.assignedRoomId).map((item) => item.assignedRoomId as string));
}

const byNumber = (a: Room, b: Room) => a.number.localeCompare(b.number, "es", { numeric: true });

function isFreeFor(room: Room, held: Set<string>): boolean {
  return !held.has(room.id) && room.sellable !== false && room.status !== "occupied" && room.status !== "out_of_order" && room.status !== "out_of_service" && room.maintenanceStatus !== "blocked";
}

/** Barra de deshacer (CocoaUndoBar, role=status) que nombra la reserva. */
function undoBar(page: Page, text: RegExp) {
  return page.locator(".c22-undo-bar").filter({ hasText: text }).first();
}

/** Toast del ToastHost (los anunciados por la región del shell no llevan role=status, R5). */
function toast(page: Page, text: string | RegExp) {
  return page.locator('[data-cocoa="toast"]').filter({ hasText: text }).first();
}

/** La parrilla (role=grid) vive dentro del CocoaScrollArea con nombre «Live Timeline de reservas por habitación». */
async function openTimeline(page: Page, testInfo: Parameters<typeof assertNoLoginGate>[1]) {
  await page.goto("/hoy/live-timeline", { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  const region = page.getByRole("region", { name: "Live Timeline de reservas por habitación" });
  await expect(region).toBeVisible({ timeout: 20_000 });
  const grid = region.getByRole("grid");
  await expect(grid).toBeVisible();
  return grid;
}

/**
 * Trae la fila de una habitación a la ventana virtual de la parrilla (solo se montan las filas visibles; van por tipo y
 * número) desplazando el CocoaScrollArea. Nunca pliega grupos: plegar «el primero» escondía la fila cuando la habitación
 * era una Doble más allá de la ventana (T4 aparcado en la 206 → «Desplegar Doble» y barra ausente).
 */
async function revealRoom(page: Page, roomId: string): Promise<void> {
  const row = page.locator(`[data-room-id="${roomId}"]`).first();
  const scroller = page.locator('[data-cocoa="scroll-area"][aria-label="Live Timeline de reservas por habitación"]').first();
  for (let i = 0; i < 40; i++) {
    if (await row.isVisible().catch(() => false)) {
      await row.scrollIntoViewIfNeeded();
      return;
    }
    const atEnd = await scroller.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, before + Math.max(120, el.clientHeight * 0.6));
      return el.scrollTop === before;
    });
    if (atEnd) return;
    await page.waitForTimeout(80);
  }
}

function bar(page: Page, reservationId: string) {
  return page.locator(`[data-reservation-id="${reservationId}"]`).first();
}

/** Recuento de escrituras del Live Timeline durante un tramo (PATCH de reserva y POST assign-room). */
function trackWrites(page: Page): { count(): number; stop(): void } {
  let n = 0;
  const handler = (request: { method(): string; url(): string }) => {
    if ((request.method() === "PATCH" && /\/reservations\/[^/]+$/.test(request.url())) || (request.method() === "POST" && /\/assign-room$/.test(request.url()))) n++;
  };
  page.on("request", handler);
  return { count: () => n, stop: () => page.off("request", handler) };
}

test.describe("Live Timeline · hacer + deshacer sin diálogo", () => {
  test("U9b · UXDAY-T4: ⌥↓ cambia de habitación sin diálogo y ⌘Z lo deshace; ⌥→ y una ocupada se rechazan con el motivo", async ({ page, request }, testInfo) => {
    const session = await loginAsUxDay(page, request);
    const headers = headersFor(session.token);
    let t4 = await getReservation(request, headers, T4);
    expect(t4.status, "UXDAY-T4 alojado").toBe("checked_in");
    expect(t4.assignedRoomId, "UXDAY-T4 con habitación").toBeTruthy();
    const rooms = await getRooms(request, headers);
    const held = await heldRooms(request, headers, t4, T4);
    const roomById = new Map(rooms.map((room) => [room.id, room]));

    // Fila vecina en la parrilla = siguiente habitación del mismo tipo por número (las filas van agrupadas por tipo y ordenadas por número).
    const sameType = (typeId: string) => rooms.filter((room) => room.roomTypeId === typeId).sort(byNumber);
    const nextInType = (roomId: string): Room | undefined => {
      const room = roomById.get(roomId);
      if (!room) return undefined;
      const list = sameType(room.roomTypeId);
      return list[list.findIndex((item) => item.id === roomId) + 1];
    };

    let below = nextInType(t4.assignedRoomId as string);
    let relocated: { from: string; to: string } | null = null;
    if (!below || !isFreeFor(below, held)) {
      // Con el seed rearmado la 311 está alojada: el motor lo rechaza con honestidad (se comprueba abajo) y
      // para ejercitar el movimiento real se traslada T4 por API a una Doble libre cuya siguiente también lo esté.
      const dbl = sameType("rt_uxday_dbl").filter((room) => isFreeFor(room, held));
      const parking = dbl.find((room) => {
        const next = nextInType(room.id);
        return next !== undefined && isFreeFor(next, held) && next.roomTypeId === room.roomTypeId;
      });
      expect(parking, "una Doble libre con la siguiente también libre para aparcar a UXDAY-T4").toBeTruthy();
      const before = roomById.get(t4.assignedRoomId as string)!;
      const occupiedBelow = below;
      // ⌥↓ contra la habitación ocupada de abajo: rechazo honesto, sin petición.
      await openTimeline(page, testInfo);
      await revealRoom(page, before.id);
      const rejectedWrites = trackWrites(page);
      if (await bar(page, T4).isVisible().catch(() => false)) {
        await bar(page, T4).focus();
        await page.keyboard.press("Alt+ArrowDown");
        if (occupiedBelow && held.has(occupiedBelow.id) === false && occupiedBelow.status === "occupied") {
          await expect(toast(page, /ocupada actualmente/)).toBeVisible({ timeout: 5_000 });
        } else {
          await expect(toast(page, /ocupada actualmente|ya está asignada a la reserva|bloqueada/)).toBeVisible({ timeout: 5_000 });
        }
        expect(rejectedWrites.count(), "el rechazo del motor no llega al API").toBe(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      rejectedWrites.stop();
      const moved = await request.post(`${E2E_API_URL}/reservations/${T4}/assign-room`, { headers, data: { roomId: parking!.id } });
      expect(moved.ok(), `aparcar UXDAY-T4 en la ${parking!.number} por API`).toBeTruthy();
      relocated = { from: before.number, to: parking!.number };
      // eslint-disable-next-line no-console
      console.log(`[e2e:timeline] UXDAY-T4 aparcado por API de la ${before.number} en la ${parking!.number} (ninguna Superior vecina libre en el seed); no se devuelve: seed-ux-day --reset lo rearma.`);
      t4 = await getReservation(request, headers, T4);
      below = nextInType(t4.assignedRoomId as string);
    }
    expect(below, "habitación de la fila de abajo").toBeTruthy();
    const origin = roomById.get(t4.assignedRoomId as string)!;

    await openTimeline(page, testInfo);
    await revealRoom(page, origin.id);
    const t4Bar = bar(page, T4);
    await expect(t4Bar).toBeVisible({ timeout: 10_000 });
    await expect(t4Bar).toHaveAttribute("data-resize", "false");
    await expect(t4Bar, "el aria-label explica por qué no hay asideros").toHaveAttribute("aria-label", /solo puede cambiar de habitación/);

    // ⌥→ sobre un alojado: rechazo del motor (el API respondería 409 REC-03), sin petición y sin diálogo.
    const datesWrites = trackWrites(page);
    await t4Bar.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect(toast(page, "Una reserva en casa solo puede cambiar de habitación")).toBeVisible({ timeout: 5_000 });
    expect(datesWrites.count()).toBe(0);
    datesWrites.stop();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ⌥↓: cambio de habitación DIRECTO (sin diálogo): assign-room + barra de deshacer.
    const assigned = page.waitForResponse((response) => response.request().method() === "POST" && new RegExp(`/reservations/${T4}/assign-room$`).test(response.url()), { timeout: 15_000 });
    await t4Bar.focus();
    await page.keyboard.press("Alt+ArrowDown");
    const undo = undoBar(page, new RegExp(`Reserva UXDAY-T4 movida a Hab\\. ${below!.number}`));
    await expect(undo).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("dialog"), "0 diálogos: el cambio se aplica directo").toHaveCount(0);
    expect((await assigned).ok(), "POST assign-room").toBeTruthy();
    // La barra ya está en la fila de abajo (optimista) y conserva el foco (teclado).
    await expect(page.locator(`[data-room-id="${below!.id}"] [data-reservation-id="${T4}"]`)).toBeVisible();
    await expect(bar(page, T4)).toBeFocused();
    await expect(undo, "la nota honesta del traslado en casa").toContainText("habitación intermedia queda sucia");
    expect((await getReservation(request, headers, T4)).assignedRoomId).toBe(below!.id);

    // ⌘Z (Ctrl+Z fuera de Mac): deshacer = assign-room inverso; barra de vuelta en su fila.
    const reverted = page.waitForResponse((response) => response.request().method() === "POST" && new RegExp(`/reservations/${T4}/assign-room$`).test(response.url()), { timeout: 15_000 });
    await page.keyboard.press(`${CONTROL_OR_META}+z`);
    expect((await reverted).ok(), "POST assign-room (deshacer)").toBeTruthy();
    await expect(toast(page, /Traslado revertido/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-room-id="${origin.id}"] [data-reservation-id="${T4}"]`)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => getReservation(request, headers, T4).then((r) => r.assignedRoomId), { timeout: 10_000 }).toBe(origin.id);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (relocated) testInfo.annotations.push({ type: "datos", description: `UXDAY-T4 aparcado por API de la ${relocated.from} en la ${relocated.to}` });
  });

  test("U9b · una llegada confirmada: ⌥→ mueve la estancia un día sin diálogo (PATCH) y «Deshacer» la devuelve", async ({ page, request }, testInfo) => {
    const session = await loginAsUxDay(page, request);
    const headers = headersFor(session.token);
    const rooms = await getRooms(request, headers);
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    // Una confirmada con habitación (el seed: UXDAY-A3 en la 110, A4 en la 305, A5 en la 111, A6 en la 401): la primera cuya
    // habitación sigue libre un día después (sin otra reserva viva que solape). Las llegadas ya registradas por otras specs no valen.
    const candidates = ["res_uxday_a3", "res_uxday_a5", "res_uxday_a4", "res_uxday_a6"];
    let target: Reservation | null = null;
    for (const id of candidates) {
      const res = await getReservation(request, headers, id).catch(() => null);
      if (!res || res.status !== "confirmed" || !res.assignedRoomId) continue;
      const nextDay = (iso: string) => {
        const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      };
      const held = await heldRooms(request, headers, { arrivalDate: nextDay(res.arrivalDate), departureDate: nextDay(res.departureDate) }, res.id);
      if (!held.has(res.assignedRoomId)) {
        target = res;
        break;
      }
    }
    expect(target, "una llegada confirmada con habitación libre al día siguiente (seed rearmado)").toBeTruthy();
    const res = target!;
    const room = roomById.get(res.assignedRoomId as string)!;

    await openTimeline(page, testInfo);
    await revealRoom(page, room.id);
    const resBar = bar(page, res.id);
    await expect(resBar).toBeVisible({ timeout: 10_000 });
    await expect(resBar).toHaveAttribute("data-resize", "true");

    const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && new RegExp(`/reservations/${res.id}$`).test(response.url()), { timeout: 15_000 });
    await resBar.focus();
    await page.keyboard.press("Alt+ArrowRight");
    const undo = undoBar(page, new RegExp(`Reserva ${res.code} movida de fechas`));
    await expect(undo).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("dialog"), "0 diálogos en un cambio de fechas").toHaveCount(0);
    await expect(undo, "el aviso del motor viaja en la nota de deshacer").toContainText("El precio no se recalcula");
    expect((await patched).ok(), "PATCH de fechas").toBeTruthy();
    const moved = await getReservation(request, headers, res.id);
    expect(moved.arrivalDate.slice(0, 10) > res.arrivalDate.slice(0, 10), "llegada un día después").toBeTruthy();

    const reverted = page.waitForResponse((response) => response.request().method() === "PATCH" && new RegExp(`/reservations/${res.id}$`).test(response.url()), { timeout: 15_000 });
    await undo.getByRole("button", { name: /^Deshacer/ }).click();
    expect((await reverted).ok(), "PATCH inverso (deshacer)").toBeTruthy();
    await expect(toast(page, "Cambio deshecho.")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => getReservation(request, headers, res.id).then((r) => r.arrivalDate.slice(0, 10)), { timeout: 10_000 }).toBe(res.arrivalDate.slice(0, 10));
  });
});

/** Viewport de la tablet emulada (iPad apaisado de 10,9″ en vertical; §7.2). */
const TABLET = { width: 820, height: 1180 };

/**
 * Primera barra de la parrilla cuyo bloque cae ENTERO dentro del viewport (bajo la cabecera de días sticky), o la primera
 * del DOM traída a la vista. La parrilla es más ancha que la pantalla y los toques del CDP exigen coordenadas del viewport.
 */
async function visibleBar(page: Page, grid: ReturnType<Page["locator"]>) {
  const bars = grid.locator(".tl-bar");
  const total = await bars.count();
  for (let i = 0; i < total; i++) {
    const box = await bars.nth(i).boundingBox();
    if (box && box.x >= 0 && box.x + box.width <= TABLET.width && box.y >= 100 && box.y + box.height <= TABLET.height) return bars.nth(i);
  }
  const first = bars.first();
  await first.scrollIntoViewIfNeeded();
  return first;
}

test.describe("Live Timeline · tablet (dedo)", () => {
  test.use({ viewport: TABLET, hasTouch: true });

  test("U9b · barras ≥ 44 px, el deslizamiento vertical desplaza la parrilla y la pulsación larga arrastra sin diálogo", async ({ page, request, context }, testInfo) => {
    const session = await loginAsUxDay(page, request);
    const headers = headersFor(session.token);
    const cdp = await context.newCDPSession(page);
    // Chromium emula el puntero grueso con hasTouch; se fuerza además por CDP para que `pointer: coarse` sea el del dedo.
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });

    const rooms = await getRooms(request, headers);
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    const candidates = ["res_uxday_a3", "res_uxday_a5", "res_uxday_a4", "res_uxday_a6"];
    let target: Reservation | null = null;
    for (const id of candidates) {
      const res = await getReservation(request, headers, id).catch(() => null);
      if (!res || res.status !== "confirmed" || !res.assignedRoomId) continue;
      const nextDay = (iso: string) => {
        const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      };
      const held = await heldRooms(request, headers, { arrivalDate: nextDay(res.arrivalDate), departureDate: nextDay(res.departureDate) }, res.id);
      if (!held.has(res.assignedRoomId)) {
        target = res;
        break;
      }
    }
    expect(target, "una llegada confirmada con habitación libre al día siguiente (seed rearmado)").toBeTruthy();
    const res = target!;
    const room = roomById.get(res.assignedRoomId as string)!;

    const grid = await openTimeline(page, testInfo);
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches), "pointer: coarse emulado").toBe(true);
    // La parrilla mide ~1.850 px de ancho en un viewport de 820: la primera barra del DOM puede quedar fuera de pantalla y
    // los toques del CDP (Input.dispatchTouchEvent) solo llegan a coordenadas dentro del viewport, así que se toca una barra visible.
    const anyBar = await visibleBar(page, grid);
    await expect(anyBar).toBeVisible({ timeout: 10_000 });
    const height = (await anyBar.boundingBox())?.height ?? 0;
    expect(height, "barra ≥ 44 px con el dedo (WCAG 2.5.8)").toBeGreaterThanOrEqual(44);
    expect(await anyBar.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");
    const handle = grid.locator(".tl-bar__handle").first();
    if (await handle.count()) expect(await handle.evaluate((el) => getComputedStyle(el).width)).toBe("24px");

    // 1 · Deslizar el dedo hacia arriba SOBRE una barra desplaza la parrilla: nada se mueve, ninguna petición.
    const scroller = page.locator('[data-cocoa="scroll-area"][aria-label="Live Timeline de reservas por habitación"]').first();
    await expect(scroller).toBeVisible();
    const box = (await anyBar.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    expect(startX >= 0 && startX <= TABLET.width && startY >= 0 && startY <= TABLET.height, "el toque cae dentro del viewport").toBeTruthy();
    const scrollWrites = trackWrites(page);
    const before = await scroller.evaluate((el) => el.scrollTop);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: startY }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX, y: startY - step * 30 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(400);
    expect(scrollWrites.count(), "deslizar no escribe").toBe(0);
    await expect(page.locator(".c22-undo-bar")).toHaveCount(0);
    scrollWrites.stop();
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });

    // 2 · Pulsación larga sobre la llegada y arrastre de una celda a la derecha: PATCH directo + Deshacer.
    await revealRoom(page, room.id);
    const resBar = bar(page, res.id);
    await expect(resBar).toBeVisible({ timeout: 10_000 });
    // La barra de la llegada puede estar fuera del viewport (parrilla más ancha que la pantalla): se trae a la vista antes de tocarla.
    await resBar.scrollIntoViewIfNeeded();
    const cellWidth = await grid.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--tl-col")));
    const rb = (await resBar.boundingBox())!;
    const x0 = rb.x + Math.min(rb.width / 2, 60);
    const y0 = rb.y + rb.height / 2;
    expect(x0 >= 0 && x0 + cellWidth <= TABLET.width && y0 >= 0 && y0 <= TABLET.height, "la pulsación y el arrastre de una celda caben en el viewport").toBeTruthy();
    const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && new RegExp(`/reservations/${res.id}$`).test(response.url()), { timeout: 15_000 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
    await page.waitForTimeout(350);
    await expect(resBar, "la pulsación larga arma el arrastre").toHaveAttribute("data-armed", "true");
    await expect(page.getByRole("tooltip", { name: "Ficha rápida de la reserva" }), "la pulsación larga abre la tarjeta rápida").toBeVisible();
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (cellWidth * step) / 6, y: y0 }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const undo = undoBar(page, new RegExp(`Reserva ${res.code} movida de fechas`));
    await expect(undo).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await patched).ok(), "PATCH de fechas por arrastre táctil").toBeTruthy();
    const reverted = page.waitForResponse((response) => response.request().method() === "PATCH" && new RegExp(`/reservations/${res.id}$`).test(response.url()), { timeout: 15_000 });
    await undo.getByRole("button", { name: /^Deshacer/ }).tap();
    expect((await reverted).ok(), "PATCH inverso (deshacer)").toBeTruthy();
    await expect.poll(() => getReservation(request, headers, res.id).then((r) => r.arrivalDate.slice(0, 10)), { timeout: 10_000 }).toBe(res.arrivalDate.slice(0, 10));
  });
});
