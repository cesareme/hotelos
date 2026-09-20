import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import {
  PISOS,
  fetchMisAverias,
  fetchWorkOrderMedia,
  forceCoarse,
  loginAsPisos,
  makeTestPng,
  pickDirtyRoom,
  roomCard,
  roomNumberOfCard,
  toastContaining,
  waitForApiResponse,
  waitForMiTurno,
  workOrderById,
  type PisosVariant
} from "../pisos/_pisos";
import { createMeasurePisos } from "./_measure-pisos";

/**
 * P4 · «El grifo del lavabo gotea: repórtalo a mantenimiento con una foto.»
 * (§7 · éxito: parte «Hab. NNN: Fuga de agua» abierto con `mediaCount 1`;
 * objetivo ≤ 3 toques + cámara, 0 teclas con chip de motivo).
 *
 * Camino tras UX-3 (P4 + M1): «Reportar» en la tarjeta de Mi turno (pisos@) →
 * ReportIncidentDrawer: chip «Fuga de agua» (el título sale solo) → «Foto»
 * (CocoaFileInput `capture="environment"`: la cámara trasera en la tablet; aquí
 * `setInputFiles` con un PNG generado de 1.800 × 1.350 que el cajón reduce a
 * JPEG por canvas, como una foto real) → «Enviar a mantenimiento» (POST
 * /work-orders con `photos[]`, 201) = 3 toques · 0 teclas. La cámara no es un
 * toque de la interfaz ni una tecla: se anota como paso. Éxito por API con el
 * encargado (maintenance.read): `GET /work-orders/:id/media` con 1 elemento y
 * `items[].mediaCount 1` en /dashboards/maintenance-mobile. Si el cajón no
 * tuviera campo de foto (baseline U0, F4) la spec cae al camino de texto y
 * acaba `completed: false` «sin foto».
 */
async function runP4(fixtures: { page: Page; request: APIRequestContext }, testInfo: TestInfo, variant: PisosVariant): Promise<void> {
  const { page, request } = fixtures;
  const touch = variant === "tablet";
  const camarera = await loginAsPisos(page, request, PISOS.users.pisos);
  if (touch) await forceCoarse(page);
  const measure = createMeasurePisos(page, "p4", variant);
  await page.goto(PISOS.routes.miTurno, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiTurno(page);
  measure.step("Mi turno cargado");
  // Habitación: una sucia del seed si queda; si no, la primera tarjeta de la cola.
  const dirty = await pickDirtyRoom(request, camarera);
  const card = dirty ? roomCard(page, dirty.roomNumber) : page.getByRole("group", { name: /^Habitación \d+/ }).first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible({ timeout: 10_000 });
  const number = dirty?.roomNumber ?? (await roomNumberOfCard(card));
  const photo = makeTestPng(1800, 1350);

  await measure.start(page);
  await measure.countedClick(card.getByRole("button", { name: "Reportar", exact: true }), "Reportar (tarjeta de Mi turno)");
  const drawer = page.getByRole("dialog", { name: "Reportar incidencia" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "drawer-open");
  const fileInput = drawer.locator('input[type="file"]');
  const photoInputs = await fileInput.count();
  measure.step(`campos de foto en el cajón: ${photoInputs}`);

  if (photoInputs === 0) {
    // Camino de la baseline (F4): solo texto, sin foto posible.
    const text = `UXDAY-P4 ${variant}: el grifo del lavabo gotea`;
    await measure.countedFill(drawer.locator("#housekeeping-report"), text, "Incidencia (texto libre; sin chips de motivo)");
    await measure.countedClick(drawer.getByRole("button", { name: "Enviar a mantenimiento", exact: true }), "Enviar a mantenimiento (cajón)");
    await expect(toastContaining(page, /enviada a mantenimiento|Incidencia reportada a mantenimiento/)).toBeVisible({ timeout: 15_000 });
    const partial = await measure.finish(page, {
      completed: false,
      context: { room: number, photoInputs, workOrderCreated: true },
      note: "sin foto: «Reportar» no admite adjuntar imagen (F4); el parte se crea solo con texto"
    });
    expect(partial.completed).toBe(false);
    return;
  }

  const chip = drawer.getByRole("button", { name: "Fuga de agua", exact: true });
  await measure.countedClick(chip, "Motivo «Fuga de agua» (chip: el título del parte sale solo)");
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await fileInput.first().setInputFiles({ name: "grifo.png", mimeType: "image/png", buffer: photo });
  measure.step(`cámara: setInputFiles grifo.png (PNG 1.800 × 1.350, ${photo.length} B; capture=environment en la tablet; no cuenta como toque ni tecla)`);
  await expect(drawer.locator('img[alt="Foto 1"]')).toBeVisible({ timeout: 20_000 });
  await measure.mark(page, "foto-lista");
  const post = waitForApiResponse(page, "POST", "/work-orders", 20_000);
  await measure.countedClick(drawer.getByRole("button", { name: "Enviar a mantenimiento", exact: true }), "Enviar a mantenimiento (cajón; POST /work-orders con photos[])");
  const response = await post;
  const created = (await response.json()) as { id: string; title?: string };
  const sent = JSON.parse(response.request().postData() ?? "{}") as { photos?: Array<{ contentBase64?: string; mimeType?: string }> };
  const sentPhoto = sent.photos?.[0];
  await expect(toastContaining(page, new RegExp(`Avería de la ${number} enviada a mantenimiento · 1 foto`))).toBeVisible({ timeout: 15_000 });
  const result = await measure.finish(page, {
    completed: true,
    context: {
      room: number,
      photoInputs,
      workOrderId: created.id,
      postStatus: response.status(),
      photoMimeSent: sentPhoto?.mimeType ?? null,
      photoBytesSent: sentPhoto?.contentBase64 ? Math.round((sentPhoto.contentBase64.length * 3) / 4) : null,
      photoBytesOriginal: photo.length
    },
    note: "chip de motivo + Foto (cámara, paso) + Enviar = 3 toques · 0 teclas; el título sale solo («Hab. NNN: Fuga de agua») y el parte nace con 1 foto"
  });

  // Éxito verificable en datos (lo lee el encargado; la camarera no tiene maintenance.read): parte abierto con su foto.
  const encargado = await loginAsPisos(page, request, PISOS.users.encargado);
  expect(response.status(), "POST /work-orders con photos responde 201").toBe(201);
  const order = await workOrderById(request, encargado, created.id);
  expect(order?.title, "el parte existe con el título Hab. NNN: Fuga de agua").toBe(`Hab. ${number}: Fuga de agua`);
  expect(order?.status).toBe("open");
  const media = await fetchWorkOrderMedia(request, encargado, created.id);
  expect(media.length, "GET /work-orders/:id/media devuelve la foto").toBe(1);
  const item = (await fetchMisAverias(request, encargado)).find((i) => i.workOrderId === created.id);
  expect(item?.mediaCount, "items[].mediaCount de Mis averías").toBe(1);
  expect(result.clicks).toBe(3);
  expect(result.keys).toBe(0);
}

test.describe("p4 · ratón 1280×900", () => {
  test.use({ viewport: PISOS.viewports.raton });
  test("p4 · reportar una avería con foto (ratón)", async ({ page, request }, testInfo) => {
    await runP4({ page, request }, testInfo, "raton");
  });
});

test.describe("p4 · tablet 820×1180 (táctil)", () => {
  test.use({ viewport: PISOS.viewports.tablet, hasTouch: true });
  test("p4 · reportar una avería con foto (tablet)", async ({ page, request }, testInfo) => {
    await runP4({ page, request }, testInfo, "tablet");
  });
});
