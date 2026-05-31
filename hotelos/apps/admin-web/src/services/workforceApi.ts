// Frontend client for interactive workforce actions (shifts, time clock, absences).
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export function clockIn(staffName: string, propertyId = getActivePropertyId()) {
  return apiRequest(`/workforce/time-clock/clock-in`, { method: "POST", body: { propertyId, staffName, action: "in", at: new Date().toISOString() } });
}
export function clockOut(staffName: string, propertyId = getActivePropertyId()) {
  return apiRequest(`/workforce/time-clock/clock-out`, { method: "POST", body: { propertyId, staffName, action: "out", at: new Date().toISOString() } });
}
export function createShift(payload: { staffName: string; role?: string; startAt: string; endAt: string }, propertyId = getActivePropertyId()) {
  return apiRequest(`/workforce/properties/${propertyId}/shifts`, { method: "POST", body: payload });
}
export function approveAbsence(id: string) {
  return apiRequest(`/workforce/absences/${id}`, { method: "PATCH", body: { status: "approved" } });
}
