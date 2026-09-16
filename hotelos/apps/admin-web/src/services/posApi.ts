// Frontend client for the interactive POS (TPV) board.
//
// Finanzas · Tanda 6 (lote nav-services): tickets carry `taxTotal`,
// `businessDate`, `invoiceId` / `invoiceNumber` (simplified invoice of a
// cash/card sale), `journalEntryId` and `cashClosureId`; the list takes
// `?status=open|closed|all`. Cash closures live in cashClosureApi.ts; the
// night-audit runs (report of the day's close) are at the end of this file.
// Contracts: packages/shared/src/pos-types.ts.
import type { NightAuditRunWire, PosLineWire, PosOutletWire, PosSettlement as PosSettlementWire, PosTicketWire } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { financeErrorMessage, posTicketsQuery, type PosTicketsInput } from "./finance-contracts";

export type PosOutlet = PosOutletWire;
export type PosLine = PosLineWire;
export type PosSettlement = PosSettlementWire;
/** Wire ticket (Tanda 6): superset of the pre-Tanda 6 shape, so existing readers keep working. */
export type PosTicket = PosTicketWire;
export type { PosTicketsInput } from "./finance-contracts";
export type { NightAuditRunWire, NightAuditReportWire, NightAuditStepWire } from "@hotelos/shared";

export function fetchPosOutlets(propertyId = getActivePropertyId()) {
  return apiRequest<PosOutlet[]>(`/properties/${propertyId}/pos/outlets`);
}
/** `status` defaults to the API default (open tickets); `closedFrom` / `limit` bound the closed list. */
export function fetchPosTickets(propertyId = getActivePropertyId(), input: PosTicketsInput = {}) {
  return apiRequest<PosTicket[]>(`/properties/${propertyId}/pos/tickets`, { query: posTicketsQuery(input) });
}
export function openPosTicket(payload: { outletId: string; roomNumber?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<PosTicket>(`/pos/tickets`, { method: "POST", body: { propertyId, ...payload } });
}
export function addPosLine(ticketId: string, line: { name: string; quantity: number; unitPrice: number; productId?: string | null }) {
  return apiRequest<PosTicket>(`/pos/tickets/${ticketId}/lines`, { method: "POST", body: line });
}
/** cash / card → simplified invoice + entry + VAT-book row; room → folio lines. 409 CASH_CLOSURE_CLOSED when the day's cash is closed. */
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

// --- Cierre del día (night audit) ---------------------------------------------
// GET /properties/:propertyId/night-audit/runs (latest 30) · GET …/runs/:runId
// (persisted report: room charges from the rate plan, no-shows, revenue,
// payments summary, cash closures and warnings) · POST …/night-audit/run
// (idempotent per business date; accounting.journal.post).
export function fetchNightAuditRuns(propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire[]>(`/properties/${propertyId}/night-audit/runs`);
}
export function fetchNightAuditRun(runId: string, propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire>(`/properties/${propertyId}/night-audit/runs/${encodeURIComponent(runId)}`);
}
export function fetchNightAuditBusinessDate(propertyId = getActivePropertyId()) {
  return apiRequest<{ propertyId: string; currentDate: string }>(`/properties/${propertyId}/night-audit/business-date`);
}
/** 409 NIGHT_AUDIT_ALREADY_COMPLETED when the business date was already closed. */
export function runNightAudit(propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire>(`/properties/${propertyId}/night-audit/run`, { method: "POST" });
}

export function posErrorMessage(error: unknown, fallback = "No se pudo completar la operación del punto de venta."): string {
  return financeErrorMessage(error, fallback);
}
