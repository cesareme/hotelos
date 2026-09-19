// Regla PURA del botón de tarea del tablero de pisos (HousekeepingDashboard):
// qué estado envía «Empezar» / «Completar» y qué aviso confirma la acción.
// Tanda FIX-1 (F9): antes el aviso se componía como `Tarea ${label.toLowerCase()}.`
// y decía «Tarea empezar.» / «Tarea completar.». Separada de la vista para
// fijarla con tests (__tests__/housekeeping-task-actions.test.mts).
import { ACTIONS } from "../../content/actions";

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
