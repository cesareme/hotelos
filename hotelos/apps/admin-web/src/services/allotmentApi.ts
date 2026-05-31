// Frontend client for TourOperators + Allotments (B2B contracted blocks).
import { apiRequest } from "./api-client";
import { getActivePropertyId, getActiveOrganizationId } from "./activeProperty";

export type TourOperator = {
  id: string; organizationId: string; code: string; name: string;
  taxId: string | null; contactEmail: string | null; contactPhone: string | null;
  defaultCommissionPct: number | null; paymentTermsDays: number; currency: string;
  active: boolean; notes: string | null; createdAt: string; updatedAt: string;
};

export type AllotmentType = "soft" | "hard" | "free_sale";
export type CounterpartyType = "tour_operator" | "bedbank" | "corporate" | "ota";
export type RateType = "net" | "commissionable";

export type Allotment = {
  id: string; propertyId: string;
  tourOperatorId: string | null; channelId: string | null;
  code: string; name: string;
  roomTypeId: string; ratePlanId: string | null;
  validFrom: string; validTo: string;
  totalRooms: number; releaseDays: number;
  contractedRate: number | null; currency: string;
  status: string;
  // Industria · campos B2B
  allotmentType: AllotmentType;
  counterpartyType: CounterpartyType;
  rateType: RateType;
  commissionPct: number | null;
  stopSell: boolean;
  notes: string | null;
  createdAt: string; updatedAt: string;
};

export type AllotmentDayRemaining = { date: string; blocked: number; pickedUp: number; released: number; remaining: number };

export type PickupSummaryDay = { date: string; blocked: number; pickedUp: number; released: number; remaining: number; pickupPct: number };
export type PickupSummaryAllotment = {
  allotmentId: string; code: string; name: string;
  releaseDays: number; totalRooms: number;
  validFrom: string; validTo: string;
  totalBlocked: number; totalPickedUp: number; totalReleased: number; totalRemaining: number;
  pickupPct: number;
  daysToNextRelease: number | null;
  nextReleaseDate: string | null;
  upcomingReleaseRooms: number;
  days: PickupSummaryDay[];
};
export type PickupSummary = {
  generatedAt: string;
  window: { from: string; to: string };
  allotments: PickupSummaryAllotment[];
};

export function fetchPickupSummary(windowDays = 60, propertyId = getActivePropertyId()) {
  return apiRequest<PickupSummary>(`/properties/${propertyId}/allotments/pickup-summary?windowDays=${windowDays}`);
}

export async function fetchTourOperators(organizationId = getActiveOrganizationId()): Promise<TourOperator[]> {
  const res = await apiRequest<{ items: TourOperator[] }>(`/organizations/${organizationId}/tour-operators`);
  return res.items;
}
export async function fetchAllotments(propertyId = getActivePropertyId()): Promise<Allotment[]> {
  const res = await apiRequest<{ items: Allotment[] }>(`/properties/${propertyId}/allotments`);
  return res.items;
}
export function getAllotmentDetail(id: string) {
  return apiRequest<Allotment & { days: Array<{ date: string; blockedRooms: number; pickedUpRooms: number; releasedRooms: number }> }>(`/allotments/${id}`);
}
export async function fetchAllotmentRemaining(id: string, from: string, to: string): Promise<AllotmentDayRemaining[]> {
  const res = await apiRequest<{ items: AllotmentDayRemaining[] }>(`/allotments/${id}/remaining?from=${from}&to=${to}`);
  return res.items;
}
export function fetchRemainingForDay(roomTypeId: string, date: string, propertyId = getActivePropertyId()) {
  return apiRequest<{ totalRemaining: number; byAllotment: Array<{ allotmentId: string; allotmentCode: string; remaining: number }> }>(`/properties/${propertyId}/allotments/remaining-for-day?roomTypeId=${roomTypeId}&date=${date}`);
}
export type CreateAllotmentPayload = {
  code: string; name: string;
  tourOperatorId?: string; channelId?: string;
  roomTypeId: string; ratePlanId?: string;
  validFrom: string; validTo: string;
  totalRooms: number; releaseDays?: number;
  contractedRate?: number; currency?: string;
  status?: "draft" | "active";
  allotmentType?: AllotmentType;
  counterpartyType?: CounterpartyType;
  rateType?: RateType;
  commissionPct?: number;
  stopSell?: boolean;
  notes?: string;
};

export function createAllotment(payload: CreateAllotmentPayload, propertyId = getActivePropertyId()) {
  return apiRequest<Allotment>(`/properties/${propertyId}/allotments`, { method: "POST", body: payload });
}
export function releaseExpired(propertyId = getActivePropertyId()) {
  return apiRequest<{ releasedDays: number; releasedRooms: number }>(`/properties/${propertyId}/allotments/release-expired`, { method: "POST", body: {} });
}

// ─── PILOT · creación de TT.OO. desde la UI ──────────────────────────────
export type CreateTourOperatorPayload = {
  code: string;
  name: string;
  taxId?: string;
  contactEmail?: string;
  contactPhone?: string;
  defaultCommissionPct?: number;
  paymentTermsDays?: number;
  currency?: string;
  notes?: string;
  active?: boolean;
};

export function createTourOperator(payload: CreateTourOperatorPayload, organizationId = getActiveOrganizationId()) {
  return apiRequest<TourOperator>(`/organizations/${organizationId}/tour-operators`, { method: "POST", body: payload });
}

export function updateTourOperator(id: string, payload: Partial<CreateTourOperatorPayload>) {
  return apiRequest<TourOperator>(`/tour-operators/${id}`, { method: "PATCH", body: payload });
}
