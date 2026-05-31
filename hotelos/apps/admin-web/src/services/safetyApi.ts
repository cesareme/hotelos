// Frontend client for interactive safety actions (incidents, checks).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export function createIncident(
  payload: { title: string; severity: IncidentSeverity; location?: string; description?: string },
  propertyId = getActivePropertyId()
) {
  return apiRequest(`/safety/properties/${propertyId}/incidents`, {
    method: "POST",
    body: { ...payload, occurredAt: new Date().toISOString() }
  });
}
export function updateIncident(id: string, patch: Record<string, unknown>) {
  return apiRequest(`/safety/incidents/${id}`, { method: "PATCH", body: patch });
}
export function createSafetyCheck(payload: { name: string; assignedTo?: string }, propertyId = getActivePropertyId()) {
  return apiRequest(`/safety/properties/${propertyId}/checks`, { method: "POST", body: payload });
}
