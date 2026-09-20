// Etiquetas en español de las tablas y alertas de Mi día › Operaciones
// (OperationsDirectorScreen). El API envía los enums crudos
// («departure_clean», «in_progress», «front_desk»); el director nunca debe
// leerlos tal cual. Puras y con test (__tests__/operations-director-labels.test.mts).
// Tanda FIX-1 (F9). Desconocido → el propio código; ausente → «—».

/** Tipo de tarea de pisos → etiqueta. */
export const HK_TASK_TYPE_LABEL: Record<string, string> = {
  departure_clean: "Limpieza de salida",
  stayover: "Repaso",
  inspection: "Inspección",
  turndown: "Cobertura",
  deep_clean: "Limpieza a fondo"
};

/** Estado de una tarea de pisos (HousekeepingTaskStatus) → etiqueta. */
export const HK_TASK_STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  assigned: "Asignada",
  in_progress: "En curso",
  done: "Hecha",
  rejected: "Rechazada"
};

/** Estado de una orden de trabajo (WorkOrderStatus) → etiqueta (misma redacción que Mis averías). */
export const WO_STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  assigned: "Asignada",
  in_progress: "En curso",
  waiting_vendor: "Esperando proveedor",
  resolved: "Resuelta",
  closed: "Cerrada"
};

/** Prioridad de tareas y órdenes → etiqueta. */
export const PRIORITY_LABEL: Record<string, string> = {
  low: "Baja",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
  critical: "Crítica",
  emergency: "Emergencia",
  preventive: "Preventiva"
};

/** Estado de un turno (Shift.status) → etiqueta. */
/** Estados de TURNO de personal (no de reserva): tipado cerrado para no confundirlo con el diccionario de estados de reserva. */
export type ShiftStatusCode = "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled" | "absent" | "no_show";
export const SHIFT_STATUS_LABEL: Record<ShiftStatusCode, string> = {
  scheduled: "Programado",
  confirmed: "Confirmado",
  in_progress: "En curso",
  completed: "Completado",
  cancelled: "Cancelado",
  absent: "Ausente",
  no_show: "No presentado"
};

/** Departamento de una alerta (OpsDirectorDepartment.id) → nombre. */
export const DEPARTMENT_LABEL: Record<string, string> = {
  front_desk: "Recepción",
  housekeeping: "Pisos",
  maintenance: "Mantenimiento",
  workforce: "Personal",
  safety: "Seguridad",
  fb_pos: "F&B / TPV",
  fnb: "F&B",
  spa: "Spa",
  sales: "Ventas",
  finance: "Finanzas",
  management: "Dirección"
};

/** Etiqueta de `code` en `map`; desconocido → el código tal cual; nulo o vacío → «—». */
export function labelOf(map: Record<string, string>, code: string | null | undefined): string {
  const key = (code ?? "").trim();
  if (!key) return "—";
  return map[key] ?? map[key.toLowerCase()] ?? key;
}

export const hkTaskTypeLabel = (code: string | null | undefined): string => labelOf(HK_TASK_TYPE_LABEL, code);
export const hkTaskStatusLabel = (code: string | null | undefined): string => labelOf(HK_TASK_STATUS_LABEL, code);
export const woStatusLabel = (code: string | null | undefined): string => labelOf(WO_STATUS_LABEL, code);
export const priorityLabel = (code: string | null | undefined): string => labelOf(PRIORITY_LABEL, code);
export const shiftStatusLabel = (code: string | null | undefined): string => labelOf(SHIFT_STATUS_LABEL, code);
export const departmentLabel = (code: string | null | undefined): string => labelOf(DEPARTMENT_LABEL, code);

/** Habitación de una fila de detalle: el número resuelto por el API o, si falta, el id (nunca «undefined»). */
export function roomLabel(row: { roomNumber?: string | null; roomId?: string | null }): string {
  return row.roomNumber ?? row.roomId ?? "—";
}
