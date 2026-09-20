// Regla PURA del botón de tarea del tablero de pisos (HousekeepingDashboard):
// qué estado envía «Empezar» / «Completar» y qué aviso confirma la acción.
// Tanda FIX-1 (F9): antes el aviso se componía como `Tarea ${label.toLowerCase()}.`
// y decía «Tarea empezar.» / «Tarea completar.». Separada de la vista para
// fijarla con tests (__tests__/housekeeping-task-actions.test.mts).
import { ACTIONS } from "../../content/actions";
import { PISOS_TOASTS } from "../../content/pisos-actions";
import { roomStatus, type StatusEntry } from "../../content/status-dictionary";
import type { HkBoardItem, HkHousekeepingStatus, HkMaintenanceStatus, HkTask } from "../../services/housekeepingApi";

export type HousekeepingTaskAction = {
  /** Estado que envía PATCH /housekeeping/tasks/:id. */
  status: "done" | "in_progress";
  /** Texto del botón. */
  label: string;
  /** Aviso (toast) al completar la acción. */
  done: string;
};

/** Siguiente acción de una tarea según su estado: en curso → completar; cualquier otro → empezar. */
export function nextTaskAction(status: string): HousekeepingTaskAction {
  return status === "in_progress"
    ? { status: "done", label: ACTIONS.complete, done: "Tarea completada." }
    : { status: "in_progress", label: "Empezar", done: "Tarea empezada." };
}

// ---------------------------------------------------------------------------
// Tanda UX-3 · P1 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.1, §5): reglas
// puras del tablero optimista. La vista aplica el cambio a la caché del board
// con `useApiData.mutate` ANTES de que el API conteste (P3 < 100 ms) y
// «Deshacer» lo revierte con la regla inversa sin enviar nada. Probadas sin DOM
// en __tests__/housekeeping-board-feel.test.mts.
// ---------------------------------------------------------------------------

/** Ventana de «Deshacer» de las escrituras diferidas (misma que ACTION_DURATION del toast: 8 s). */
export const HK_UNDO_MS = 8000;

/** Escrituras del tablero que se difieren (no tienen inversa en el API: mark-clean no degrada una inspeccionada; «desinspeccionar» no existe). */
export type HkDeferredWrite = Extract<HkHousekeepingStatus, "clean" | "inspected">;

const FREE_ROOM_STATUS = new Set<string>(["clean", "dirty", "inspected"]);

/**
 * Habitación con otra limpieza (L5: `housekeepingStatus` siempre; `status` solo
 * la espeja cuando la habitación está libre — una ocupada o fuera de servicio
 * conserva su ocupación).
 */
export function roomWithHousekeeping(item: HkBoardItem, housekeeping: HkHousekeepingStatus): HkBoardItem {
  const status = FREE_ROOM_STATUS.has(item.room.status) ? housekeeping : item.room.status;
  return { ...item, room: { ...item.room, housekeepingStatus: housekeeping, status } };
}

/** Board con la habitación `roomId` en otra limpieza (las demás tarjetas, intactas). */
export function boardWithRoomHousekeeping(board: HkBoardItem[], roomId: string, housekeeping: HkHousekeepingStatus): HkBoardItem[] {
  return board.map((item) => (item.room.id === roomId ? roomWithHousekeeping(item, housekeeping) : item));
}

/** Board con la tarea `taskId` en otro estado («Empezar» / «Completar» optimistas). */
export function boardWithTaskStatus(board: HkBoardItem[], taskId: string, status: string): HkBoardItem[] {
  return board.map((item) =>
    item.tasks.some((t) => t.id === taskId) ? { ...item, tasks: item.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) } : item
  );
}

/** Board con una tarea nueva en su habitación (optimista; la revalidación trae el id real). */
export function boardWithTask(board: HkBoardItem[], task: HkTask): HkBoardItem[] {
  return board.map((item) => (item.room.id === task.roomId ? { ...item, tasks: [...item.tasks, task] } : item));
}

/** Nombre con el que se asigna una tarea al usuario de sesión: nombre completo, si no el correo, si no vacío. */
export function sessionUserName(user: { fullName?: string | null; email?: string | null } | null | undefined): string {
  return (user?.fullName ?? "").trim() || (user?.email ?? "").trim();
}

/**
 * Sugerencias del campo «Asignar a» (datalist): el usuario de sesión primero y
 * después los `assignedTo` ya vistos en el board, sin repetidos ni vacíos y
 * ordenados en español.
 */
export function assigneeSuggestions(board: HkBoardItem[], sessionName = ""): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const me = sessionName.trim();
  if (me) {
    seen.add(me.toLowerCase());
    out.push(me);
  }
  const others: string[] = [];
  for (const item of board) {
    for (const task of item.tasks) {
      const who = (task.assignedTo ?? "").trim();
      if (!who || seen.has(who.toLowerCase())) continue;
      seen.add(who.toLowerCase());
      others.push(who);
    }
  }
  others.sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
  return [...out, ...others];
}

/** Aviso al crear una tarea: con el número y, si se asignó, el nombre (copia fijada en content/pisos-actions.ts). */
export function taskCreatedToast(roomNumber: string, assignedTo = ""): string {
  const who = assignedTo.trim();
  return who ? PISOS_TOASTS.taskCreatedAssigned(roomNumber, who) : PISOS_TOASTS.taskCreated(roomNumber);
}

const MAINTENANCE_ATTENTION: StatusEntry = { label: "Mantenimiento pendiente", short: "Mant.", tone: "warning", icon: "info-circle" };

/**
 * Badge de mantenimiento de la tarjeta por diccionario (F2: nunca
 * «Mantenimiento: blocked»): `ok` → nada; `blocked` → «Bloqueada» (ROOM_STATUS);
 * `needs_attention` → «Mantenimiento pendiente».
 */
export function maintenanceStatusEntry(status: HkMaintenanceStatus | string | null | undefined): StatusEntry | null {
  const key = (status ?? "ok").trim().toLowerCase();
  if (!key || key === "ok") return null;
  if (key === "blocked") return roomStatus("blocked");
  return MAINTENANCE_ATTENTION;
}
