// Frontend client for split folios + folio routing rules per reservation.
import { apiRequest } from "./api-client";

export type Folio = {
  id: string; reservationId: string; guestId: string | null;
  status: "open" | "closed";
  currency: string; label: string; isPrimary: boolean;
};
export type FolioLine = {
  id: string; folioId: string; type: string; description: string;
  quantity: number; unitPrice: number; total: number;
  taxCode: string | null; postedAt: string; postedBy: string | null;
};
export type FolioRoutingRule = {
  id: string; reservationId: string;
  sourceType: string; targetFolioId: string; priority: number;
  active: boolean; notes: string | null; createdAt: string;
};

export async function fetchReservationFolios(reservationId: string): Promise<Folio[]> {
  const res = await apiRequest<{ items: Folio[] }>(`/reservations/${reservationId}/folios`);
  return res.items;
}
export function createSecondaryFolio(reservationId: string, payload: { label: string; guestId?: string; currency?: string }) {
  return apiRequest<Folio>(`/reservations/${reservationId}/folios`, { method: "POST", body: payload });
}
export async function fetchRoutingRules(reservationId: string): Promise<FolioRoutingRule[]> {
  const res = await apiRequest<{ items: FolioRoutingRule[] }>(`/reservations/${reservationId}/routing-rules`);
  return res.items;
}
export function createRoutingRule(reservationId: string, payload: { sourceType: string; targetFolioId: string; priority?: number; notes?: string; active?: boolean }) {
  return apiRequest<FolioRoutingRule>(`/reservations/${reservationId}/routing-rules`, { method: "POST", body: payload });
}
export function deleteRoutingRule(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/routing-rules/${id}`, { method: "DELETE" });
}
export function transferFolioLine(lineId: string, targetFolioId: string) {
  return apiRequest<FolioLine>(`/folio-lines/${lineId}/transfer`, { method: "POST", body: { targetFolioId } });
}
// POST /folios/:id/split — Sprint 40 split-folio endpoint. Creates a new
// sibling folio on the same reservation and moves the selected charges into
// it. Idempotent server-side: same (sourceFolioId, sorted chargeIds, label)
// returns the previously-created folio instead of duplicating.
export type SplitFolioPayload = {
  newFolio: { label: string; guestId?: string | null; currency?: string };
  moveChargeIds: string[];
  keepInOriginal?: boolean;
};
export type SplitFolioResponse = {
  sourceFolio: { id: string; reservationId: string; status: "open" | "closed"; currency: string; guestId?: string | null };
  newFolio: { id: string; reservationId: string; status: "open" | "closed"; currency: string; guestId?: string | null };
  movedChargeIds: string[];
  idempotent: boolean;
};
export function splitFolio(folioId: string, payload: SplitFolioPayload): Promise<SplitFolioResponse> {
  return apiRequest<SplitFolioResponse>(`/folios/${folioId}/split`, { method: "POST", body: payload });
}
// Reuses existing folio service endpoints (already in the API). The balance
// endpoint returns chargesTotal/paymentsTotal/balanceDue — we surface the
// pieces the routing UI needs (total = chargesTotal).
type FolioBalanceResponse = {
  folio: Folio;
  lines: FolioLine[];
  payments: unknown[];
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};
export async function fetchFolioLines(folioId: string): Promise<{ folio: Folio; lines: FolioLine[]; total: number; balanceDue: number }> {
  const res = await apiRequest<FolioBalanceResponse>(`/folios/${folioId}/balance`);
  return { folio: res.folio, lines: res.lines, total: res.chargesTotal, balanceDue: res.balanceDue };
}
