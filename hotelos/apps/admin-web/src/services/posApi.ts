// Frontend client for the interactive POS (TPV) board.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type PosOutlet = { id: string; name: string; category: string };
export type PosLine = { name: string; quantity: number; unitPrice: number; total: number };
export type PosSettlement = "room" | "cash" | "card";
export type PosTicket = {
  id: string;
  propertyId: string;
  outletId: string;
  outletName: string;
  status: "open" | "closed";
  roomNumber?: string;
  lines: PosLine[];
  total: number;
  // Tanda 2 · FISC-05: settlement / closedAt / closedByUserId are persisted on
  // PosOrder, so they survive an API restart and feed the cash summary.
  settlement?: PosSettlement;
  createdAt: string;
  closedAt?: string;
  closedByUserId?: string | null;
};

export function fetchPosOutlets(propertyId = getActivePropertyId()) {
  return apiRequest<PosOutlet[]>(`/properties/${propertyId}/pos/outlets`);
}
export function fetchPosTickets(propertyId = getActivePropertyId()) {
  return apiRequest<PosTicket[]>(`/properties/${propertyId}/pos/tickets`);
}
export function openPosTicket(payload: { outletId: string; roomNumber?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<PosTicket>(`/pos/tickets`, { method: "POST", body: { propertyId, ...payload } });
}
export function addPosLine(ticketId: string, line: { name: string; quantity: number; unitPrice: number }) {
  return apiRequest<PosTicket>(`/pos/tickets/${ticketId}/lines`, { method: "POST", body: line });
}
export function closePosTicket(ticketId: string, settlement: PosSettlement) {
  return apiRequest<PosTicket>(`/pos/tickets/${ticketId}/close`, { method: "POST", body: { settlement } });
}

// --- Cash summary (arqueo) ---------------------------------------------------
// GET /properties/:propertyId/pos/cash-summary?from&to&outletId — aggregates
// closed PosOrder rows (closedAt within [from, to]) by outlet and settlement.
export type PosSettlementTotals = { cash: number; card: number; room: number };
export type PosCashSummaryOutlet = {
  outletId: string;
  outletName: string;
  tickets: number;
  total: number;
  bySettlement: PosSettlementTotals;
};
export type PosCashSummary = {
  from: string;
  to: string;
  outletId?: string | null;
  byOutlet: PosCashSummaryOutlet[];
  totals: { tickets: number; total: number; bySettlement: PosSettlementTotals };
};

export function fetchPosCashSummary(
  params: { from: string; to: string; outletId?: string },
  propertyId = getActivePropertyId()
) {
  return apiRequest<PosCashSummary>(`/properties/${propertyId}/pos/cash-summary`, {
    query: { from: params.from, to: params.to, outletId: params.outletId || undefined }
  });
}
