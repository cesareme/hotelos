import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { assertNoLoginGate } from "../_helpers";
import { PISOS, forceCoarse, loginAsPisos, openTasksOf, pickCleanRoomWithoutTasks, roomCard, toastContaining, waitForApiResponse, waitForTableroPisos, type PisosVariant } from "../pisos/_pisos";
import { createMeasurePisos } from "./_measure-pisos";

/**
 * P3 · «Crea una tarea de limpieza para una habitación y asígnasela a la
 * camarera.» (§7 · éxito: housekeeping_tasks nueva en la habitación con
 * `assignedTo`; objetivo ≤ 3 toques con asignación).
 *
 * Camino tras UX-3 (P1, F9): «Nueva tarea» en la tarjeta de la habitación del
 * tablero de pisos (gobernanta@) → cajón con tipo y prioridad por defecto y el
 * campo «Asignar a» (CocoaInput con datalist de los asignados vistos y el
 * usuario de sesión) → con ratón, Intro crea la tarea (`submitOnEnter`, P2
 * teclado primero); en la tablet, el botón «Crear tarea» (≥ 44 px) = 1 clic +
 * tecleo / 2 toques + tecleo. Aviso «Tarea creada para la habitación NNN ·
 * asignada a <correo>» (copia fijada §4.1). La habitación se elige por API:
 * limpia, sin tareas y fuera de las que usan las specs t*; el asignado es el
 * correo de la camarera del seed (nunca un nombre).
 */
async function runP3(fixtures: { page: Page; request: APIRequestContext }, testInfo: TestInfo, variant: PisosVariant): Promise<void> {
  const { page, request } = fixtures;
  const touch = variant === "tablet";
  const gobernanta = await loginAsPisos(page, request, PISOS.users.gobernanta);
  if (touch) await forceCoarse(page);
  const measure = createMeasurePisos(page, "p3", variant);
  const room = await pickCleanRoomWithoutTasks(request, gobernanta);
  if (!room) {
    await measure.finish(page, { completed: false, note: "sin habitación limpia sin tareas fuera de las de las specs t*: rearma el seed" });
    return;
  }
  await page.goto(PISOS.routes.pisos, { waitUntil: "domcontentloaded" });
  await assertNoLoginGate(page, testInfo);
  await waitForTableroPisos(page);
  measure.step("Tablero de pisos cargado");
  const card = roomCard(page, room.number);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  const assignee = PISOS.users.pisos;

  await measure.start(page);
  await measure.countedClick(card.getByRole("button", { name: "Nueva tarea", exact: true }), "Nueva tarea (tarjeta del tablero)");
  const drawer = page.getByRole("dialog", { name: "Nueva tarea" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await measure.mark(page, "drawer-open");
  await measure.countedFill(drawer.locator("#hk-task-assignee"), assignee, "Asignar a (correo de la camarera; datalist con sugerencias)");
  const taskPost = waitForApiResponse(page, "POST", "/housekeeping/tasks", 15_000);
  if (touch) await measure.countedClick(drawer.getByRole("button", { name: "Crear tarea", exact: true }), "Crear tarea (cajón; tipo y prioridad por defecto)");
  else await measure.countedPress(page, "Enter", "Intro crea la tarea (submitOnEnter del cajón)");
  const response = await taskPost;
  expect(response.ok(), `POST /housekeeping/tasks → ${response.status()}`).toBeTruthy();
  await expect(toastContaining(page, new RegExp(`Tarea creada para la habitación ${room.number} · asignada a `))).toBeVisible({ timeout: 15_000 });
  const result = await measure.finish(page, {
    completed: true,
    context: { room: room.number, assignedToSessionEmail: true, submit: touch ? "botón" : "Intro" },
    note: touch ? "tarjeta → cajón → «Asignar a» (tecleo) → «Crear tarea»; aviso con número y asignación" : "tarjeta → cajón → «Asignar a» (tecleo) → Intro (teclado primero, P2); aviso con número y asignación"
  });

  // Éxito verificable en datos: la habitación tiene una tarea nueva asignada a la camarera.
  const tasks = await openTasksOf(request, gobernanta, room.id);
  expect(tasks.length, "tarea creada en la habitación").toBeGreaterThanOrEqual(1);
  expect(tasks.some((task) => task.taskType === "departure_clean" && task.assignedTo === assignee && (task.status === "assigned" || task.status === "pending"))).toBe(true);
  expect(result.clicks).toBe(touch ? 2 : 1);
  expect(result.keys).toBe(assignee.length + (touch ? 0 : 1));
}

test.describe("p3 · ratón 1280×900", () => {
  test.use({ viewport: PISOS.viewports.raton });
  test("p3 · crear una tarea de limpieza (ratón)", async ({ page, request }, testInfo) => {
    await runP3({ page, request }, testInfo, "raton");
  });
});

test.describe("p3 · tablet 820×1180 (táctil)", () => {
  test.use({ viewport: PISOS.viewports.tablet, hasTouch: true });
  test("p3 · crear una tarea de limpieza (tablet)", async ({ page, request }, testInfo) => {
    await runP3({ page, request }, testInfo, "tablet");
  });
});
