import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import {
  DEFERRED_WRITE_MS,
  PISOS,
  blockRoomDialog,
  forceCoarse,
  loginAsPisos,
  pickWorkOrder,
  roomState,
  toastContaining,
  toastOffersUndo,
  waitForApiResponse,
  waitForMantenimiento,
  workOrderById,
  type PisosVariant
} from "../pisos/_pisos";
import { createMeasurePisos } from "./_measure-pisos";

/**
 * P6 · «Hay una fuga en la habitación: bloquéala mientras se arregla y
 * desbloquéala al terminar.» (§7 · éxito: la habitación pasa a bloqueada por
 * el parte y vuelve a vendible; objetivo: bloquear ≤ 3 toques con diálogo
 * nominal · desbloquear aparte, diseño §2).
 *
 * Camino tras UX-3 (P3): abrir la orden en la lista del tablero de
 * mantenimiento (encargado@) → «Bloquear habitación» → diálogo nominal
 * «Bloquear la NNN» / «Mantenerla en venta» (§5: afecta a inventario) →
 * confirmar (POST /block-room, aviso «Habitación NNN bloqueada.» con número,
 * F8) = 3 toques: la tarea principal, medida por el arnés. Desbloquear =
 * «Resolver» libera la habitación (POST /resolve releaseRoom, optimista con
 * «Deshacer» 8 s, escritura diferida): 1 toque, medido aparte con otro arnés y
 * anotado en `phases` del mismo resultado (`amend`); la spec espera al POST
 * antes de comprobar el dato. En la tablet (< 900 px) la ficha abre en un cajón
 * con los mismos botones. Exige maintenance.workorder.manage +
 * ai.high_risk.confirm: el técnico no puede (D4). Cada variante consume un
 * parte urgente sin bloquear del seed (wo_uxday_p6a / p6b).
 */
async function runP6(fixtures: { page: Page; request: APIRequestContext }, testInfo: TestInfo, variant: PisosVariant): Promise<void> {
  const { page, request } = fixtures;
  const touch = variant === "tablet";
  const encargado = await loginAsPisos(page, request, PISOS.users.encargado);
  if (touch) await forceCoarse(page);
  const measure = createMeasurePisos(page, "p6", variant);
  const order = await pickWorkOrder(request, encargado, PISOS.ids.p6, (w) => w.status === "open" && !w.blocksRoom && Boolean(w.roomId));
  if (!order?.roomId) {
    await measure.finish(page, { completed: false, note: "sin parte urgente abierto sin bloquear (wo_uxday_p6a / p6b): rearma el seed" });
    return;
  }
  const roomId = order.roomId;
  const number = (await roomState(request, encargado, roomId))?.number ?? "";
  expect(number, "la habitación del parte existe en el tablero").not.toBe("");
  await page.goto(PISOS.routes.mantenimiento, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMantenimiento(page);
  measure.step("Tablero de mantenimiento cargado");
  const list = page.getByRole("list", { name: "Órdenes de trabajo" });
  await expect(list).toBeVisible();

  // Fase 1 · bloquear (tarea principal: ≤ 3 toques con diálogo nominal).
  await measure.start(page);
  await measure.countedClick(list.getByRole("button", { name: order.title, exact: true }), "Abrir la orden (lista del tablero)");
  const block = page.getByRole("button", { name: "Bloquear habitación", exact: true });
  await expect(block).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "ficha-open");
  await measure.countedClick(block, "Bloquear habitación (ficha → diálogo nominal)");
  const dialog = blockRoomDialog(page, number);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByRole("button", { name: "Mantenerla en venta", exact: true })).toBeVisible();
  await measure.mark(page, "dialogo-nominal");
  const blockPost = waitForApiResponse(page, "POST", `/work-orders/${order.id}/block-room`, 15_000);
  await measure.countedClick(dialog.getByRole("button", { name: `Bloquear la ${number}`, exact: true }), "Confirmar «Bloquear la NNN» (diálogo nominal)");
  const blockResponse = await blockPost;
  expect(blockResponse.ok(), `POST /work-orders/:id/block-room → ${blockResponse.status()}`).toBeTruthy();
  await expect(toastContaining(page, `Habitación ${number} bloqueada.`)).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  // La ficha ya refleja el bloqueo (optimista): «Resolver» liberará la habitación (releaseRoom = blocksRoom).
  await expect(block).toBeHidden({ timeout: 15_000 });
  await measure.mark(page, "bloqueada");
  const blocked = await roomState(request, encargado, roomId);
  expect(blocked?.maintenanceStatus, "bloqueada por el parte").toBe("blocked");
  expect(blocked?.sellable).toBe(false);
  const result = await measure.finish(page, {
    completed: true,
    context: { workOrderId: order.id, room: number, nominalDialog: true },
    note: "bloquear = abrir la orden + «Bloquear habitación» + confirmar «Bloquear la NNN» (diálogo nominal, §5; aviso con número); desbloquear («Resolver» libera) se mide aparte en phases"
  });

  // Fase 2 · desbloquear: «Resolver» libera la habitación (optimista + «Deshacer» 8 s; POST /resolve diferido).
  const unblock = createMeasurePisos(page, "p6", variant);
  await unblock.start(page);
  const resolvePost = waitForApiResponse(page, "POST", `/work-orders/${order.id}/resolve`);
  await unblock.countedClick(page.getByRole("button", { name: "Resolver", exact: true }), "Resolver (ficha; libera la habitación; optimista + «Deshacer» 8 s, POST /resolve diferido)");
  const resolveToast = toastContaining(page, new RegExp(`Parte \\w{6} resuelto · habitación ${number} liberada\\.`));
  await expect(resolveToast).toBeVisible({ timeout: 15_000 });
  const resolveUndo = await toastOffersUndo(resolveToast);
  unblock.step(`ventana de «Deshacer» ${DEFERRED_WRITE_MS / 1000} s (escritura diferida): la spec no toca nada hasta que el POST viaja`);
  const resolveResponse = await resolvePost;
  expect(resolveResponse.ok(), `POST /work-orders/:id/resolve → ${resolveResponse.status()}`).toBeTruthy();
  const unblockPhase = unblock.snapshot("desbloquear");
  const amended = measure.amend({
    phases: [measure.snapshot("bloquear"), unblockPhase],
    context: { undoOfferedResolve: resolveUndo, deferredWriteMs: DEFERRED_WRITE_MS, totalClicks: result.clicks + unblockPhase.clicks }
  });

  // Éxito verificable en datos: la habitación vuelve a vendible (mantenimiento ok) y el parte queda resuelto.
  const released = await roomState(request, encargado, roomId);
  expect(released?.maintenanceStatus).toBe("ok");
  expect(released?.sellable).toBe(true);
  expect((await workOrderById(request, encargado, order.id))?.status).toBe("resolved");
  expect(result.clicks).toBe(3);
  expect(unblockPhase.clicks).toBe(1);
  expect(amended.phases?.length).toBe(2);
}

test.describe("p6 · ratón 1280×900", () => {
  test.use({ viewport: PISOS.viewports.raton });
  test.setTimeout(90_000);
  test("p6 · bloquear y desbloquear una habitación (ratón)", async ({ page, request }, testInfo) => {
    await runP6({ page, request }, testInfo, "raton");
  });
});

test.describe("p6 · tablet 820×1180 (táctil)", () => {
  test.use({ viewport: PISOS.viewports.tablet, hasTouch: true });
  test.setTimeout(90_000);
  test("p6 · bloquear y desbloquear una habitación (tablet)", async ({ page, request }, testInfo) => {
    await runP6({ page, request }, testInfo, "tablet");
  });
});
