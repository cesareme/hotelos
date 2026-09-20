// Frontend client for the interactive housekeeping board (real CRUD).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

// Tanda L5 (lote A) · estado de habitación unificado (vocabulario cerrado):
// `status` = ocupación / disponibilidad y, si está libre, espejo de la limpieza;
// `housekeepingStatus` = limpieza (siempre presente); `maintenanceStatus` = mantenimiento.
export type HkRoomStatus = "clean" | "dirty" | "inspected" | "occupied" | "out_of_order" | "out_of_service";
export type HkHousekeepingStatus = "dirty" | "clean" | "inspected";
export type HkMaintenanceStatus = "ok" | "blocked" | "needs_attention";

export type HkRoom = {
  id: string;
  propertyId: string;
  number: string;
  floor?: string;
  status: HkRoomStatus;
  housekeepingStatus: HkHousekeepingStatus;
  maintenanceStatus: HkMaintenanceStatus;
  sellable: boolean;
};
export type HkTask = {
  id: string;
  roomId: string;
  taskType: string;
  priority: string;
  status: string;
  assignedTo?: string;
  dueAt?: string;
  createdAt: string;
};
export type HkBoardItem = { room: HkRoom; tasks: HkTask[] };

export type HkTaskType = "departure_clean" | "stayover" | "inspection" | "deep_clean";
export type HkPriority = "low" | "normal" | "high";

/**
 * Tanda UX-3 · P1: las escrituras diferidas del tablero («Marcar limpia» /
 * «Inspeccionar» con «Deshacer» 8 s) viajan con `keepalive` cuando la ventana se
 * vacía en `pagehide`, para que el POST sobreviva al cierre de la pestaña.
 */
export type HkWriteOptions = { keepalive?: boolean };

export function fetchHousekeepingBoard(propertyId = getActivePropertyId()) {
  return apiRequest<HkBoardItem[]>(`/properties/${propertyId}/housekeeping/board`);
}
/** POST /housekeeping/tasks: el API admite `assignedTo` (nombre o correo de la camarera) desde siempre; el tablero lo envía desde UX-3 · P1 («Asignar a»). */
export function createHousekeepingTask(
  payload: { roomId: string; taskType: HkTaskType; priority?: HkPriority; assignedTo?: string },
  propertyId = getActivePropertyId()
) {
  return apiRequest<HkTask>(`/housekeeping/tasks`, { method: "POST", body: { propertyId, ...payload } });
}
export function updateHousekeepingTask(id: string, patch: { status?: string; priority?: HkPriority; assignedTo?: string }) {
  return apiRequest<HkTask>(`/housekeeping/tasks/${id}`, { method: "PATCH", body: patch });
}
export function markRoomClean(roomId: string, options: HkWriteOptions = {}) {
  return apiRequest<HkRoom>(`/rooms/${roomId}/mark-clean`, { method: "POST", keepalive: options.keepalive });
}
export function markRoomInspected(roomId: string, options: HkWriteOptions = {}) {
  return apiRequest<HkRoom>(`/rooms/${roomId}/mark-inspected`, { method: "POST", keepalive: options.keepalive });
}
