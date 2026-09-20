import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import { PISOS, fetchMiTurnoData, forceCoarse, instructionsCloseButton, loginAsPisos, nextRoomCard, roomNumberOfCard, sectionChip, waitForMiTurno, type PisosVariant } from "../pisos/_pisos";
import { createMeasurePisos } from "./_measure-pisos";

/**
 * P2 · «Empiezas el turno: ¿qué habitación te toca ahora?» (§7 · éxito: la
 * tarjeta «Siguiente» es la primera habitación de la cola del API para la
 * sección elegida; objetivo ≤ 1 toque).
 *
 * Camino tras UX-3 (P2): /operaciones/pisos/mi-turno (home móvil del rol
 * pisos) muestra los chips de sección («Todas · n», «Planta 1 · n»…) antes de
 * los de prioridad y la tarjeta «Siguiente» arriba (§4.2). La camarera toca su
 * sección UNA vez (1 toque); el chip se recuerda por propiedad en localStorage
 * (D8) y al volver el grupo se titula «Mi sección» y no hay nada que tocar (la
 * spec lo comprueba tras recargar: 0 toques). Con ratón la tarjeta de ayuda
 * sigue sobre la lista la primera vez (dismissible + persistKey, se cierra una
 * vez para siempre): no se cuenta (§6); con el dedo va plegada bajo la lista
 * (D9). La tarea es aterrizar: el cronómetro y las peticiones cuentan desde la
 * navegación (shell incluido).
 */
async function runP2(fixtures: { page: Page; request: APIRequestContext }, testInfo: TestInfo, variant: PisosVariant): Promise<void> {
  const { page, request } = fixtures;
  const touch = variant === "tablet";
  const camarera = await loginAsPisos(page, request, PISOS.users.pisos);
  if (touch) await forceCoarse(page);
  const measure = createMeasurePisos(page, "p2", variant);
  // La sección de la camarera: la primera con habitaciones pendientes (el seed reparte 101-120 / 201-220 / 301-315 + 401-405).
  const before = await fetchMiTurnoData(request, camarera);
  const section = before.sections.find((s) => s.total > 0) ?? null;

  await measure.start(page);
  await page.goto(PISOS.routes.miTurno, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForMiTurno(page);
  measure.step("Mi turno cargado (peticiones desde la navegación, shell incluido)");
  const help = await instructionsCloseButton(page);
  if (help) measure.step("ayuda sobre la lista (ratón, primera vez; se cierra una sola vez y queda recordada: no cuenta, §6)");
  if (section) await measure.countedClick(sectionChip(page, section.name), `Sección (chip «${section.name} · n»; se recuerda como «Mi sección», D8)`);
  const next = nextRoomCard(page);
  await expect(next).toBeVisible({ timeout: 10_000 });
  const number = await roomNumberOfCard(next);
  const nextAction = next.getByRole("button", { name: /^(Iniciar|Limpia|Inspeccionada)$/ }).first();
  const nextActionVisible = await nextAction.isVisible().catch(() => false);
  const result = await measure.finish(page, {
    completed: true,
    context: { nextRoom: number, section: section?.name ?? null, sectionChips: before.sections.length, helpCardVisible: Boolean(help), nextActionVisible },
    note: section
      ? "chip de sección (1 toque, recordado) + tarjeta «Siguiente» arriba con el primario grande; al volver, 0 toques («Mi sección»)"
      : "sin secciones en el API: la tarjeta «Siguiente» es la primera de todo el hotel (0 toques)"
  });

  // Éxito verificable en datos: la tarjeta «Siguiente» es la primera habitación de la cola del API dentro de la sección (misma prioridad y orden).
  const rooms = section ? before.rooms.filter((r) => r.sectionId === section.id) : before.rooms;
  expect(rooms.length).toBeGreaterThan(0);
  expect(rooms[0].roomNumber).toBe(number);
  expect(result.clicks).toBe(section ? 1 : 0);
  expect(result.keys).toBe(0);

  // D8: al volver, la sección sigue elegida sin tocar nada («Mi sección») y la «Siguiente» es la misma.
  if (section) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForMiTurno(page);
    await expect(page.getByRole("group", { name: "Filtrar por sección" }).getByText("Mi sección", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(sectionChip(page, section.name)).toHaveAttribute("aria-pressed", "true");
    await expect(nextRoomCard(page)).toHaveAttribute("aria-label", `Habitación ${number}`);
  }
}

test.describe("p2 · ratón 1280×900", () => {
  test.use({ viewport: PISOS.viewports.raton });
  test("p2 · ver mi turno y la siguiente habitación (ratón)", async ({ page, request }, testInfo) => {
    await runP2({ page, request }, testInfo, "raton");
  });
});

test.describe("p2 · tablet 820×1180 (táctil)", () => {
  test.use({ viewport: PISOS.viewports.tablet, hasTouch: true });
  test("p2 · ver mi turno y la siguiente habitación (tablet)", async ({ page, request }, testInfo) => {
    await runP2({ page, request }, testInfo, "tablet");
  });
});
