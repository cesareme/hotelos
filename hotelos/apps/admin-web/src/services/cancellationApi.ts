// Frontend client for CancellationPolicy CRUD + cancellation/no-show fee engine.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type PenaltyType = "first_night" | "percent" | "fixed_amount" | "all_stay" | "none";

export type CancellationPolicy = {
  id: string; propertyId: string; code: string; name: string; description: string | null;
  freeCancelHours: number;
  penaltyType: PenaltyType; penaltyValue: number | null;
  noShowPenaltyType: PenaltyType; noShowPenaltyValue: number | null;
  active: boolean; createdAt: string; updatedAt: string;
};

export type ChargeBreakdown = {
  amount: number;
  basis: "none" | "first_night" | "percent" | "fixed_amount" | "all_stay";
  withinFreeWindow: boolean;
  policyCode: string | null; policyName: string | null;
  label: string;
};

export async function fetchCancellationPolicies(propertyId = getActivePropertyId()): Promise<CancellationPolicy[]> {
  const res = await apiRequest<{ items: CancellationPolicy[] }>(`/properties/${propertyId}/cancellation-policies`);
  return res.items;
}
export function createCancellationPolicy(payload: Partial<CancellationPolicy> & { code: string; name: string }, propertyId = getActivePropertyId()) {
  return apiRequest<CancellationPolicy>(`/properties/${propertyId}/cancellation-policies`, { method: "POST", body: payload });
}
export function updateCancellationPolicy(id: string, patch: Partial<CancellationPolicy>) {
  return apiRequest<CancellationPolicy>(`/cancellation-policies/${id}`, { method: "PATCH", body: patch });
}
export function deleteCancellationPolicy(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/cancellation-policies/${id}`, { method: "DELETE" });
}
export function previewCancellationCharge(reservationId: string) {
  return apiRequest<ChargeBreakdown>(`/reservations/${reservationId}/cancellation-charge`);
}
