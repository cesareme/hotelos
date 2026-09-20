import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import {
  DEFERRED_WRITE_MS,
  PISOS,
  forceCoarse,
  loginAsPisos,
  pickWorkOrder,
  scopeChip,
  toastContaining,
  toastOffersUndo,
  waitForApiResponse,
  waitForMisAverias,
  workOrderById,
  workOrderCard,
  type PisosVariant
} from "../pisos/_pisos";
import { createMeasurePisos } from "./_measure-pisos";

/**
 * P5 · «Toma el parte del grifo y dalo por resuelto.» (§7 · éxito: work_orders
 * resolved y asignado a quien lo tomó; objetivo ≤ 3 toques).
 *
 * Camino tras UX-3 (P3): Mis averías (mantenimiento@) arranca en «Mías» cuando
 * el técnico ya tiene partes (§4.4; el seed le deja uno en curso), así que la
 * cola se ve tocando «Todas» (1 toque, solo si el parte no está a la vista) →
 * «Tomar» en la tarjeta (PATCH in_progress + assignedTo optimista, aviso «Parte
 * xxxxxx → En curso · asignado a ti» con «Deshacer», D7) → la tarjeta ofrece
 * «Resuelta» al instante (sin refresh() completo, F1) → «Resuelta» (optimista;
 * aviso «Parte xxxxxx resuelto.» con «Deshacer» 8 s; el POST /resolve viaja al
 * agotar la ventana, §5) = 2 (+1) toques; la spec espera al POST antes de
 * acabar, así que `ms` incluye los 8 s. Cada variante consume un parte abierto
 * sin asignar del seed (wo_uxday_p5a / p5b).
 */
async function runP5(fixtures: { page: Page; request: APIRequestContext }, testInfo: TestInfo, variant: PisosVariant): Promise<void> {
  const { page, request } = fixtures;
  const touch = variant === "tablet";
  const tecnico = await loginAsPisos(page, request, PISOS.users.mantenimiento);
  if (touch) await forceCoarse(page);
  const measure = createMeasurePisos(page, "p5", variant);
  const order = await pickWorkOrder(request, tecnico, PISOS.ids.p5, (w) => w.status === "open" && !w.assignedTo);
  if (!order) {
    await measure.finish(page, { completed: false, note: "sin parte abierto sin asignar (wo_uxday_p5a / p5b): rearma el seed" });
    return;
  }
  await page.goto(PISOS.routes.misAverias, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMisAverias(page);
  measure.step("Mis averías cargado");
  const card = workOrderCard(page, order.title);

  await measure.start(page);
  let scopeTapped = false;
  if (!(await card.isVisible().catch(() => false))) {
    // La pantalla arranca en «Mías» (el técnico tiene un parte en curso): la cola está en «Todas».
    await measure.countedClick(scopeChip(page, "Todas"), "Todas (chip de alcance: la pantalla arranca en «Mías»)");
    scopeTapped = true;
  }
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  const takePatch = waitForApiResponse(page, "PATCH", `/work-orders/${order.id}`, 15_000);
  await measure.countedClick(card.getByRole("button", { name: "Tomar", exact: true }), "Tomar (tarjeta de Mis averías → en curso, asignada a mí; optimista con «Deshacer»)");
  const takeToast = toastContaining(page, /Parte \w{6} → En curso · asignado a ti/);
  await expect(takeToast).toBeVisible({ timeout: 15_000 });
  const takeUndo = await toastOffersUndo(takeToast);
  const takeResponse = await takePatch;
  expect(takeResponse.ok(), `PATCH /work-orders/:id (Tomar) → ${takeResponse.status()}`).toBeTruthy();
  await measure.mark(page, "tomada");
  const resolve = card.getByRole("button", { name: "Resuelta", exact: true });
  await expect(resolve).toBeVisible({ timeout: 15_000 });
  const resolvePost = waitForApiResponse(page, "POST", `/work-orders/${order.id}/resolve`);
  await measure.countedClick(resolve, "Resuelta (tarjeta; optimista + «Deshacer» 8 s, POST /resolve diferido)");
  const resolveToast = toastContaining(page, /Parte \w{6} resuelto\./);
  await expect(resolveToast).toBeVisible({ timeout: 15_000 });
  const resolveUndo = await toastOffersUndo(resolveToast);
  await measure.mark(page, "resuelta-optimista");
  measure.step(`ventana de «Deshacer» ${DEFERRED_WRITE_MS / 1000} s (escritura diferida): la spec no toca nada hasta que el POST viaja`);
  const resolveResponse = await resolvePost;
  expect(resolveResponse.ok(), `POST /work-orders/:id/resolve → ${resolveResponse.status()}`).toBeTruthy();
  const result = await measure.finish(page, {
    completed: true,
    context: { workOrderId: order.id, scopeChipTapped: scopeTapped, undoOfferedTake: takeUndo, undoOfferedResolve: resolveUndo, deferredWriteMs: DEFERRED_WRITE_MS },
    note: scopeTapped
      ? "«Todas» (la pantalla arranca en «Mías») + «Tomar» + «Resuelta»; ambas con «Deshacer», «Resuelta» diferida 8 s: ms incluye la ventana"
      : "«Tomar» + «Resuelta»; ambas con «Deshacer», «Resuelta» diferida 8 s: ms incluye la ventana"
  });

  // Éxito verificable en datos: el parte queda resuelto y asignado a quien lo tomó.
  const after = await workOrderById(request, tecnico, order.id);
  expect(after?.status).toBe("resolved");
  expect(after?.assignedTo, "«Tomar» asigna el parte a quien lo toma (F9)").toBeTruthy();
  expect(result.clicks).toBe(scopeTapped ? 3 : 2);
  expect(result.keys).toBe(0);
}

test.describe("p5 · ratón 1280×900", () => {
  test.use({ viewport: PISOS.viewports.raton });
  test.setTimeout(90_000);
  test("p5 · tomar y resolver un parte (ratón)", async ({ page, request }, testInfo) => {
    await runP5({ page, request }, testInfo, "raton");
  });
});

test.describe("p5 · tablet 820×1180 (táctil)", () => {
  test.use({ viewport: PISOS.viewports.tablet, hasTouch: true });
  test.setTimeout(90_000);
  test("p5 · tomar y resolver un parte (tablet)", async ({ page, request }, testInfo) => {
    await runP5({ page, request }, testInfo, "tablet");
  });
});
