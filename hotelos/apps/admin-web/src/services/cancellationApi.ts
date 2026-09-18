// Frontend client for CancellationPolicy CRUD + cancellation/no-show fee engine.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type PenaltyType = "first_night" | "percent" | "fixed_amount" | "all_stay" | "none";

export type CancellationPolicy = {
  id: string; propertyId: string; code: string; name: string; description: string | null;
  freeCancelHours: number;
  penaltyType: PenaltyType; penaltyValue: number | null;
  noShowPenaltyType: PenaltyType; noShowPenaltyValue: number | null;
  active: boolean;
  /** Tanda L3: the hotel's default policy (reservations without a policy of their own). At most one per hotel. */
  isDefault: boolean;
  createdAt: string; updatedAt: string;
};

export type ChargeMode = "cancellation" | "no_show";

export type ChargeBreakdown = {
  amount: number;
  basis: "none" | "first_night" | "percent" | "fixed_amount" | "all_stay";
  withinFreeWindow: boolean;
  policyCode: string | null; policyName: string | null;
  label: string;
  /** Instant the free-cancel window is measured against (14:00 hotel time of the arrival day); null without policy / for no-shows. */
  cutoffAt?: string | null;
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
/** Preview of the penalty the policy would apply now: `mode` «cancellation» (default) or «no_show». */
export function previewCancellationCharge(reservationId: string, mode?: ChargeMode) {
  const query = mode ? `?mode=${encodeURIComponent(mode)}` : "";
  return apiRequest<ChargeBreakdown>(`/reservations/${reservationId}/cancellation-charge${query}`);
}
