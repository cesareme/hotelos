import { expect, test, type APIRequestContext, type Browser, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import {
  DEFERRED_WRITE_MS,
  PISOS,
  forceCoarse,
  loginAsPisos,
  openTasksOf,
  pickDirtyRoom,
  roomCard,
  roomState,
  toastContaining,
  toastOffersUndo,
  waitForApiResponse,
  waitForMiTurno,
  waitForTableroPisos,
  type PisosVariant
} from "../pisos/_pisos";
import { createMeasurePisos } from "./_measure-pisos";

/**
 * P1 · «La habitación está sucia: márcala limpia y que la gobernanta la
 * inspeccione.» (§7 · éxito: rooms.housekeeping_status = inspected y la tarea
 * de salida cerrada; objetivo ≤ 3 toques en tablet).
 *
 * Camino tras UX-3 (P1 + P2): la camarera (pisos@) pulsa «Limpia» en la
 * tarjeta de su Mi turno: cambio optimista al instante, aviso «Hab. NNN →
 * Limpia · tarea cerrada» con «Deshacer» 8 s y escritura DIFERIDA (§5): el POST
 * /rooms/:id/housekeeping-status y el PATCH que cierra la tarea (D1) viajan al
 * agotarse la ventana; la spec los espera sin tocar nada (por eso `ms` incluye
 * los 8 s). Como la tarea se cierra, la habitación deja de listarse en Mi turno
 * y la gobernanta (gobernanta@, segundo contexto: otra persona y otro
 * dispositivo) la inspecciona desde el tablero de pisos («Inspeccionar»,
 * optimista + «Deshacer» diferido) = 1 + 1 = 2 toques. Cada variante consume
 * una habitación sucia del seed (tarea hkt_uxday_p1_* pendiente; 5
 * disponibles); sin ninguna, se anota y no se mide.
 */
async function runP1(fixtures: { page: Page; request: APIRequestContext; browser: Browser }, testInfo: TestInfo, variant: PisosVariant): Promise<void> {
  const { page, request, browser } = fixtures;
  const touch = variant === "tablet";
  const camarera = await loginAsPisos(page, request, PISOS.users.pisos);
  if (touch) await forceCoarse(page);
  const measure = createMeasurePisos(page, "p1", variant);
  const room = await pickDirtyRoom(request, camarera);
  if (!room) {
    await measure.finish(page, { completed: false, note: "sin habitación sucia con tarea hkt_uxday_p1_* pendiente: rearma el seed (db:seed:ux-day -- --reset + db:seed:ux-day-pisos)" });
    return;
  }
  await page.goto(PISOS.routes.miTurno, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiTurno(page);
  measure.step("Mi turno cargado (camarera)");
  const card = roomCard(page, room.roomNumber);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();

  await measure.start(page);
  // Las dos escrituras diferidas se registran ANTES del toque: viajan juntas al agotarse la ventana.
  const cleanWrite = waitForApiResponse(page, "POST", `/rooms/${room.roomId}/housekeeping-status`);
  const taskClose = room.taskId ? waitForApiResponse(page, "PATCH", `/housekeeping/tasks/${room.taskId}`) : null;
  await measure.countedClick(card.getByRole("button", { name: "Limpia", exact: true }), "Limpia (tarjeta de Mi turno, camarera; optimista + «Deshacer» 8 s, cierra la tarea D1)");
  const cleanToast = toastContaining(page, new RegExp(`Hab\\. ${room.roomNumber} → Limpia`));
  await expect(cleanToast).toBeVisible({ timeout: 15_000 });
  const cleanUndo = await toastOffersUndo(cleanToast);
  await measure.mark(page, "limpia-optimista");
  measure.step(`ventana de «Deshacer» ${DEFERRED_WRITE_MS / 1000} s (escritura diferida): la spec no toca nada hasta que el POST viaja`);
  const cleanResponse = await cleanWrite;
  expect(cleanResponse.ok(), `POST housekeeping-status clean → ${cleanResponse.status()}`).toBeTruthy();
  if (taskClose) {
    const closeResponse = await taskClose;
    expect(closeResponse.ok(), `PATCH tarea done (D1) → ${closeResponse.status()}`).toBeTruthy();
  }
  await measure.mark(page, "limpia-confirmada");

  const context = await browser.newContext({ viewport: PISOS.viewports[variant], hasTouch: touch, locale: "es-ES", timezoneId: "Europe/Madrid" });
  try {
    const page2 = await context.newPage();
    const gobernanta = await loginAsPisos(page2, request, PISOS.users.gobernanta);
    if (touch) await forceCoarse(page2);
    await page2.goto(PISOS.routes.pisos, { waitUntil: "domcontentloaded" });
    await assertNoLoginGate(page2, testInfo);
    await waitForTableroPisos(page2);
    measure.attach(page2);
    measure.step("Tablero de pisos cargado (gobernanta; sus peticiones cuentan desde aquí): la habitación ya no está en Mi turno porque la tarea se cerró (D1)");
    const card2 = roomCard(page2, room.roomNumber);
    await card2.scrollIntoViewIfNeeded();
    await expect(card2).toBeVisible();
    // El tablero escribe por POST /rooms/:id/mark-inspected (services/housekeepingApi.ts); Mi turno, por /housekeeping-status.
    const inspectWrite = waitForApiResponse(page2, "POST", `/rooms/${room.roomId}/mark-inspected`);
    await measure.countedClick(card2.getByRole("button", { name: "Inspeccionar", exact: true }), "Inspeccionar (tarjeta del tablero de pisos, gobernanta; optimista + «Deshacer» 8 s)");
    const inspectToast = toastContaining(page2, `Habitación ${room.roomNumber} inspeccionada.`);
    await expect(inspectToast).toBeVisible({ timeout: 15_000 });
    const inspectUndo = await toastOffersUndo(inspectToast);
    await measure.mark(page2, "inspeccionada-optimista");
    const inspectResponse = await inspectWrite;
    expect(inspectResponse.ok(), `POST housekeeping-status inspected → ${inspectResponse.status()}`).toBeTruthy();
    const result = await measure.finish(page, {
      completed: true,
      context: { room: room.roomNumber, taskId: room.taskId ?? null, undoOfferedClean: cleanUndo, undoOfferedInspect: inspectUndo, deferredWriteMs: DEFERRED_WRITE_MS },
      note: "dos personas: camarera «Limpia» (Mi turno, cierra la tarea D1) + gobernanta «Inspeccionar» (tablero); optimistas con «Deshacer» 8 s y escritura diferida: ms incluye las dos ventanas"
    });

    // Éxito verificable en datos: la habitación queda inspeccionada y la tarea de salida ya no está abierta.
    const state = await roomState(request, gobernanta, room.roomId);
    expect(state?.housekeepingStatus, "la habitación queda inspeccionada").toBe("inspected");
    if (room.taskId) {
      const open = await openTasksOf(request, gobernanta, room.roomId);
      expect(open.some((task) => task.id === room.taskId), "la tarea de salida se cerró con «Limpia» (D1)").toBe(false);
    }
    expect(result.clicks).toBe(2);
    expect(result.keys).toBe(0);
  } finally {
    await context.close();
  }
}

test.describe("p1 · ratón 1280×900", () => {
  test.use({ viewport: PISOS.viewports.raton });
  test.setTimeout(90_000);
  test("p1 · marcar limpia e inspeccionar (ratón)", async ({ page, request, browser }, testInfo) => {
    await runP1({ page, request, browser }, testInfo, "raton");
  });
});

test.describe("p1 · tablet 820×1180 (táctil)", () => {
  test.use({ viewport: PISOS.viewports.tablet, hasTouch: true });
  test.setTimeout(90_000);
  test("p1 · marcar limpia e inspeccionar (tablet)", async ({ page, request, browser }, testInfo) => {
    await runP1({ page, request, browser }, testInfo, "tablet");
  });
});
