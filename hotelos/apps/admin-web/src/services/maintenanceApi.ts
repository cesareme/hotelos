// Frontend client for the interactive maintenance board (real work-order CRUD).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type WoPriority = "emergency" | "urgent" | "normal" | "preventive";
export type WoStatus = "open" | "assigned" | "in_progress" | "waiting_vendor" | "resolved" | "closed";

export type WorkOrder = {
  id: string;
  propertyId: string;
  roomId?: string;
  assetId?: string;
  title: string;
  description?: string;
  priority: WoPriority;
  status: WoStatus;
  blocksRoom: boolean;
  assignedTo?: string;
  createdAt: string;
  resolvedAt?: string;
};

export function fetchWorkOrders(propertyId = getActivePropertyId()) {
  return apiRequest<WorkOrder[]>(`/properties/${propertyId}/work-orders`);
}
export function createWorkOrder(payload: { roomNumber?: string; title: string; description?: string; priority?: WoPriority; blocksRoom?: boolean }) {
  return apiRequest<WorkOrder>(`/work-orders`, { method: "POST", body: payload });
}
export function updateWorkOrder(id: string, patch: { status?: WoStatus; priority?: WoPriority; assignedTo?: string; title?: string; description?: string }) {
  return apiRequest<WorkOrder>(`/work-orders/${id}`, { method: "PATCH", body: patch });
}
export function resolveWorkOrder(id: string, body: { resolutionNote?: string; releaseRoom?: boolean } = {}) {
  return apiRequest<WorkOrder>(`/work-orders/${id}/resolve`, { method: "POST", body });
}
export function blockRoomForWorkOrder(id: string) {
  return apiRequest<WorkOrder>(`/work-orders/${id}/block-room`, { method: "POST" });
}
