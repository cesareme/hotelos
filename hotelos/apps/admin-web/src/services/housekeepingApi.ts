// Frontend client for the interactive housekeeping board (real CRUD).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type HkRoom = {
  id: string;
  propertyId: string;
  number: string;
  floor?: string;
  status: string;
  housekeepingStatus?: string;
  maintenanceStatus?: string;
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

export function fetchHousekeepingBoard(propertyId = getActivePropertyId()) {
  return apiRequest<HkBoardItem[]>(`/properties/${propertyId}/housekeeping/board`);
}
export function createHousekeepingTask(
  payload: { roomId: string; taskType: HkTaskType; priority?: HkPriority },
  propertyId = getActivePropertyId()
) {
  return apiRequest<HkTask>(`/housekeeping/tasks`, { method: "POST", body: { propertyId, ...payload } });
}
export function updateHousekeepingTask(id: string, patch: { status?: string; priority?: HkPriority; assignedTo?: string }) {
  return apiRequest<HkTask>(`/housekeeping/tasks/${id}`, { method: "PATCH", body: patch });
}
export function markRoomClean(roomId: string) {
  return apiRequest<HkRoom>(`/rooms/${roomId}/mark-clean`, { method: "POST" });
}
export function markRoomInspected(roomId: string) {
  return apiRequest<HkRoom>(`/rooms/${roomId}/mark-inspected`, { method: "POST" });
}
