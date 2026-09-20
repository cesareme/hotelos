import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  HK_UNDO_MS,
  assigneeSuggestions,
  boardWithRoomHousekeeping,
  boardWithTask,
  boardWithTaskStatus,
  maintenanceStatusEntry,
  roomWithHousekeeping,
  sessionUserName,
  taskCreatedToast
} from "../housekeeping-task-actions.ts";
import { PISOS_TOASTS } from "../../../content/pisos-actions.ts";
import { ROOM_STATUS } from "../../../content/status-dictionary.ts";
import type { HkBoardItem } from "../../../services/housekeepingApi.ts";

// Tanda UX-3 · P1 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.1, §5):
// «feel» del tablero de pisos. Reglas puras del board optimista + contrato de
// fuente de HousekeepingDashboard.tsx y services/housekeepingApi.ts (busy por
// habitación, mutate + deshacer diferido, sin enum crudo, assignedTo en el
// POST, density operational, ⌘K).

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const dashboard = stripComments(readFileSync(new URL("../HousekeepingDashboard.tsx", import.meta.url), "utf8"));
const api = stripComments(readFileSync(new URL("../../../services/housekeepingApi.ts", import.meta.url), "utf8"));

const room = (over: Partial<HkBoardItem["room"]> = {}): HkBoardItem["room"] => ({
  id: "room_1",
  propertyId: "prop_x",
  number: "305",
  status: "dirty",
  housekeepingStatus: "dirty",
  maintenanceStatus: "ok",
  sellable: true,
  ...over
});
const task = (over: Partial<HkBoardItem["tasks"][number]> = {}): HkBoardItem["tasks"][number] => ({
  id: "task_1",
  roomId: "room_1",
  taskType: "departure_clean",
  priority: "normal",
  status: "pending",
  createdAt: "2026-09-20T08:00:00.000Z",
  ...over
});

describe("reglas puras · limpieza optimista de una habitación (L5: status espeja la limpieza solo si está libre)", () => {
  it("una habitación libre y sucia marcada limpia pasa a clean en housekeepingStatus y en status", () => {
    const next = roomWithHousekeeping({ room: room(), tasks: [] }, "clean");
    assert.equal(next.room.housekeepingStatus, "clean");
    assert.equal(next.room.status, "clean");
  });

  it("una ocupada o fuera de servicio conserva su ocupación y solo cambia la limpieza", () => {
    for (const status of ["occupied", "out_of_order", "out_of_service"] as const) {
      const next = roomWithHousekeeping({ room: room({ status, housekeepingStatus: "dirty" }), tasks: [] }, "inspected");
      assert.equal(next.room.housekeepingStatus, "inspected");
      assert.equal(next.room.status, status);
    }
  });

  it("boardWithRoomHousekeeping cambia solo la tarjeta pedida y no muta el board original", () => {
    const board: HkBoardItem[] = [
      { room: room({ id: "a", number: "101" }), tasks: [] },
      { room: room({ id: "b", number: "102" }), tasks: [] }
    ];
    const next = boardWithRoomHousekeeping(board, "b", "clean");
    assert.equal(next[0], board[0], "la tarjeta no tocada es la misma referencia");
    assert.equal(next[1].room.housekeepingStatus, "clean");
    assert.equal(board[1].room.housekeepingStatus, "dirty", "el board original no cambia (rollback seguro)");
  });

  it("la inversa devuelve la tarjeta al estado anterior (Deshacer sin petición)", () => {
    const board: HkBoardItem[] = [{ room: room({ status: "inspected", housekeepingStatus: "inspected" }), tasks: [] }];
    const dirty = boardWithRoomHousekeeping(board, "room_1", "clean");
    const back = boardWithRoomHousekeeping(dirty, "room_1", "inspected");
    assert.deepEqual(back, board);
  });
});

describe("reglas puras · tareas optimistas", () => {
  it("boardWithTaskStatus cambia el estado de la tarea en su habitación y nada más", () => {
    const board: HkBoardItem[] = [
      { room: room({ id: "a" }), tasks: [task({ id: "t1", roomId: "a" })] },
      { room: room({ id: "b" }), tasks: [task({ id: "t2", roomId: "b" })] }
    ];
    const next = boardWithTaskStatus(board, "t2", "in_progress");
    assert.equal(next[0], board[0]);
    assert.equal(next[1].tasks[0].status, "in_progress");
    assert.equal(board[1].tasks[0].status, "pending");
  });

  it("boardWithTask añade la tarea nueva al final de su habitación", () => {
    const board: HkBoardItem[] = [{ room: room({ id: "a" }), tasks: [task({ id: "t1", roomId: "a" })] }];
    const next = boardWithTask(board, task({ id: "draft-1", roomId: "a", assignedTo: "Camarera de prueba" }));
    assert.deepEqual(
      next[0].tasks.map((t) => t.id),
      ["t1", "draft-1"]
    );
    assert.equal(boardWithTask(board, task({ id: "x", roomId: "zzz" }))[0].tasks.length, 1, "una habitación desconocida no rompe el board");
  });
});

describe("reglas puras · «Asignar a» (datalist) y aviso de tarea creada", () => {
  it("sessionUserName: nombre completo, si no el correo, si no vacío", () => {
    assert.equal(sessionUserName({ fullName: "Gobernanta de prueba", email: "gobernanta@uxday.test" }), "Gobernanta de prueba");
    assert.equal(sessionUserName({ fullName: "  ", email: "gobernanta@uxday.test" }), "gobernanta@uxday.test");
    assert.equal(sessionUserName(null), "");
  });

  it("assigneeSuggestions: usuario de sesión primero, asignados vistos sin repetidos ni vacíos, en orden español", () => {
    const board: HkBoardItem[] = [
      { room: room({ id: "a" }), tasks: [task({ assignedTo: "Zoe (prueba)" }), task({ id: "t2", assignedTo: "" })] },
      { room: room({ id: "b" }), tasks: [task({ id: "t3", assignedTo: "Ana (prueba)" }), task({ id: "t4", assignedTo: "zoe (prueba)" })] }
    ];
    assert.deepEqual(assigneeSuggestions(board, "Gobernanta de prueba"), ["Gobernanta de prueba", "Ana (prueba)", "Zoe (prueba)"]);
    assert.deepEqual(assigneeSuggestions(board), ["Ana (prueba)", "Zoe (prueba)"]);
    assert.deepEqual(assigneeSuggestions([], "  "), []);
  });

  it("el aviso lleva SIEMPRE el número y el nombre solo si se asignó (copia de content/pisos-actions.ts)", () => {
    assert.equal(taskCreatedToast("305"), PISOS_TOASTS.taskCreated("305"));
    assert.equal(taskCreatedToast("305", "  "), "Tarea creada para la habitación 305.");
    assert.equal(taskCreatedToast("305", "Camarera de prueba"), PISOS_TOASTS.taskCreatedAssigned("305", "Camarera de prueba"));
    assert.match(taskCreatedToast("305", "Camarera de prueba"), /habitación 305 · asignada a Camarera de prueba$/);
  });
});

describe("reglas puras · mantenimiento por diccionario (F2) y ventana de deshacer", () => {
  it("ok → sin badge; blocked → «Bloqueada» del diccionario; needs_attention → etiqueta en español, nunca el enum", () => {
    assert.equal(maintenanceStatusEntry("ok"), null);
    assert.equal(maintenanceStatusEntry(undefined), null);
    assert.equal(maintenanceStatusEntry("blocked"), ROOM_STATUS.blocked);
    const attention = maintenanceStatusEntry("needs_attention");
    assert.ok(attention);
    assert.equal(attention.label, "Mantenimiento pendiente");
    assert.doesNotMatch(attention.label, /needs_attention|blocked/);
  });

  it("HK_UNDO_MS es la ventana del toast con acción (8 s)", () => {
    assert.equal(HK_UNDO_MS, 8000);
  });
});

describe("HousekeepingDashboard.tsx · busy POR habitación (F1)", () => {
  it("no hay busy global: el estado es un Set por habitación y ningún botón se apaga por `disabled={busy}` global", () => {
    assert.doesNotMatch(dashboard, /useState\(false\)/, "sin `const [busy, setBusy] = useState(false)`");
    assert.match(dashboard, /const \[busyRooms, setBusyRooms\] = useState<ReadonlySet<string>>/);
    assert.match(dashboard, /const busy = busyRooms\.has\(item\.room\.id\);/);
    assert.doesNotMatch(dashboard, /\brefresh\(\);\s*\}\s*catch/, "sin `await fn(); refresh()` tras cada acción");
  });
});

describe("HousekeepingDashboard.tsx · optimista + «Deshacer» diferido (P3, P4, §5)", () => {
  it("«Marcar limpia» / «Inspeccionar» pasan por useApiData.mutate con la regla pura y escritura diferida", () => {
    assert.match(dashboard, /const \{ data, loading, error, refresh, mutate \} = useApiData<HkBoardItem\[\]>/);
    assert.match(dashboard, /import \{ deferredCommit, undoDeferred, type DeferredFlushReason \} from "\.\/deferred-commit";/);
    assert.match(dashboard, /const pending = deferredCommit\(HK_UNDO_MS\);/);
    assert.match(dashboard, /\(prev\) => boardWithRoomHousekeeping\(toArray<HkBoardItem>\(prev\), roomId, write\)/);
    assert.match(dashboard, /onClick=\{\(\) => void deferRoomWrite\(item, "clean"\)\}/);
    assert.match(dashboard, /onClick=\{\(\) => void deferRoomWrite\(item, "inspected"\)\}/);
  });

  it("el toast lleva «Deshacer» (PISOS_ACTIONS.undo), dura la ventana, no se pausa con el ratón y deshacer cancela sin enviar nada; tardío, avisa (REV-01)", () => {
    assert.match(dashboard, /label: PISOS_ACTIONS\.undo/);
    assert.match(dashboard, /duration: HK_UNDO_MS,\s*pauseOnHover: false,/);
    assert.match(dashboard, /import \{ deferredCommit, undoDeferred, type DeferredFlushReason \} from "\.\/deferred-commit";/);
    assert.match(dashboard, /if \(!undoDeferred\(pending, \(\) => showToast\(PISOS_TOASTS\.undoExpired\(n\), \{ variant: "warning" \}\)\)\) return;/);
    assert.doesNotMatch(dashboard, /if \(pending\.settled\(\)\) return;/, "un «Deshacer» con la ventana agotada nunca calla");
    assert.match(dashboard, /const go = await pending\.wait\(\);\s*if \(!go\) return;/);
    assert.match(dashboard, /showToast\(PISOS_TOASTS\.undone\(n\), \{ variant: "info" \}\)/);
  });

  it("una ventana por habitación: la segunda acción vacía la anterior; pagehide vacía todas con keepalive", () => {
    assert.match(dashboard, /pendingByRoom\.current\.get\(roomId\)\?\.flush\(\);/);
    assert.match(dashboard, /window\.addEventListener\("pagehide", onPageHide\);/);
    assert.match(dashboard, /flushPending\("pagehide"\)/);
    assert.match(dashboard, /keepalive: pending\.reason\(\) === "pagehide"/);
    assert.match(dashboard, /if \(write === "clean"\) await markRoomClean\(roomId, options\);\s*else await markRoomInspected\(roomId, options\);/);
  });

  it("«Actualizar» con escrituras pendientes las envía en vez de pisar el estado optimista", () => {
    assert.match(dashboard, /const refreshBoard = useCallback\(\(\) => \{\s*if \(pendingByRoom\.current\.size > 0\) \{\s*flushPending\("manual"\);\s*return;\s*\}\s*refresh\(\);/);
    assert.match(dashboard, /onClick=\{refreshBoard\}/);
    assert.match(dashboard, /onRetry: refreshBoard/);
  });

  it("los avisos llevan el número (copia fijada): «Habitación 305 limpia.», nunca «marcada limpia.»", () => {
    assert.match(dashboard, /PISOS_TOASTS\.roomClean\(n\)/);
    assert.match(dashboard, /PISOS_TOASTS\.roomInspected\(n\)/);
    assert.doesNotMatch(dashboard, /marcada limpia/);
    assert.doesNotMatch(dashboard, /"Tarea creada\."/);
  });
});

describe("HousekeepingDashboard.tsx · etiquetas por diccionario, nunca el enum crudo (F2, P6)", () => {
  it("no hay mapas locales de etiquetas ni «Mantenimiento: {maint}»", () => {
    assert.doesNotMatch(dashboard, /const TASK_TYPE_LABEL/);
    assert.doesNotMatch(dashboard, /const TASK_STATUS_LABEL/);
    assert.doesNotMatch(dashboard, /const PRIORITY_LABEL/);
    assert.doesNotMatch(dashboard, /Mantenimiento: \{/);
    assert.doesNotMatch(dashboard, /\?\? t\.taskType\}/);
    assert.doesNotMatch(dashboard, /\?\? t\.status\}/);
  });

  it("usa hkTaskTypeLabel / hkTaskStatusLabel / priorityLabel y el badge de mantenimiento del diccionario", () => {
    assert.match(dashboard, /import \{ hkTaskStatusLabel, hkTaskTypeLabel, priorityLabel \} from "\.\/operations-director-labels";/);
    assert.match(dashboard, /\{hkTaskTypeLabel\(t\.taskType\)\}/);
    assert.match(dashboard, /\{hkTaskStatusLabel\(t\.status\)\}/);
    assert.match(dashboard, /\{priorityLabel\(t\.priority\)\}/);
    assert.match(dashboard, /const maintenance = maintenanceStatusEntry\(item\.room\.maintenanceStatus\);/);
    assert.match(dashboard, /<CocoaStatusBadge entry=\{maintenance\} title="Mantenimiento" \/>/);
  });
});

describe("«Nueva tarea» · «Asignar a» con datalist, Enter envía y assignedTo viaja en el POST (F9)", () => {
  it("el cajón tiene submitOnEnter y un CocoaInput con sugerencias (asignados vistos + usuario de sesión)", () => {
    assert.match(dashboard, /<CocoaDrawer[\s\S]*?submitOnEnter[\s\S]*?>/);
    assert.match(dashboard, /const assignees = useMemo\(\(\) => assigneeSuggestions\(board, sessionUserName\(getUser\(\)\)\), \[board\]\);/);
    assert.match(dashboard, /<CocoaField label=\{PISOS_ACTIONS\.assignTo\}/);
    assert.match(dashboard, /<CocoaInput id="hk-task-assignee" value=\{formAssignee\} onChange=\{setFormAssignee\} suggestions=\{assignees\}/);
    assert.match(dashboard, /import \{ getUser \} from "\.\.\/\.\.\/services\/auth-storage";/);
  });

  it("el POST lleva assignedTo (vacío → undefined) y el aviso lleva número y nombre", () => {
    assert.match(dashboard, /const assignedTo = formAssignee\.trim\(\) \|\| undefined;/);
    assert.match(dashboard, /createHousekeepingTask\(\{ roomId, taskType: formType, priority: formPriority, assignedTo \}\)/);
    assert.match(dashboard, /taskCreatedToast\(n, assignedTo\)/);
    assert.match(api, /payload: \{ roomId: string; taskType: HkTaskType; priority\?: HkPriority; assignedTo\?: string \}/);
  });

  it("services/housekeepingApi: mark-clean / mark-inspected admiten keepalive para la ventana vaciada en pagehide", () => {
    assert.match(api, /export type HkWriteOptions = \{ keepalive\?: boolean \};/);
    assert.match(api, /export function markRoomClean\(roomId: string, options: HkWriteOptions = \{\}\)/);
    assert.match(api, /export function markRoomInspected\(roomId: string, options: HkWriteOptions = \{\}\)/);
    assert.match(api, /keepalive: options\.keepalive/);
  });
});

describe("HousekeepingDashboard.tsx · densidad por dispositivo y ⌘K (P5, F10, F11)", () => {
  it("declara density=\"operational\"", () => {
    assert.match(dashboard, /density="operational"/);
  });

  it("⌘K ofrece actualizar, nueva tarea y un comando por filtro", () => {
    assert.match(dashboard, /id: "housekeeping-refresh"/);
    assert.match(dashboard, /id: "housekeeping-new-task"/);
    assert.match(dashboard, /id: `housekeeping-filter-\$\{f\.id\}`/);
  });

  it("mantiene una sola acción primaria por tarjeta (Marcar limpia o Inspeccionar; Nueva tarea es bordered)", () => {
    const card = dashboard.slice(dashboard.indexOf('<div className="cocoa-cluster" style={roomActionsStyle}>'), dashboard.indexOf("</CocoaCard>"));
    assert.match(card, /\{!isClean && !isInspected \? \(\s*<CocoaButton size="small" disabled=\{busy\}/);
    assert.match(card, /\{isClean \? \(\s*<CocoaButton size="small" disabled=\{busy\}/);
    assert.match(card, /<CocoaButton size="small" variant="bordered" tone="neutral" disabled=\{busy\} onClick=\{\(\) => openTaskForm\(item\.room\.id\)\}>/);
  });
});
