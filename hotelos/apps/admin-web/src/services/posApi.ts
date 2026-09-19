// Frontend client for the interactive POS (TPV) board.
//
// Finanzas · Tanda 6 (lote nav-services): tickets carry `taxTotal`,
// `businessDate`, `invoiceId` / `invoiceNumber` (simplified invoice of a
// cash/card sale), `journalEntryId` and `cashClosureId`; the list takes
// `?status=open|closed|all`. Cash closures live in cashClosureApi.ts; the
// night-audit runs (report of the day's close) are at the end of this file.
// Contracts: packages/shared/src/pos-types.ts.
import type { NightAuditReopenBody, NightAuditRunBody, NightAuditRunWire, PosLineWire, PosOutletWire, PosSettlement as PosSettlementWire, PosTicketWire } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { financeErrorMessage, posTicketsQuery, type PosTicketsInput } from "./finance-contracts";

export type PosOutlet = PosOutletWire;
export type PosLine = PosLineWire;
export type PosSettlement = PosSettlementWire;
/** Wire ticket (Tanda 6): superset of the pre-Tanda 6 shape, so existing readers keep working. */
export type PosTicket = PosTicketWire;
export type { PosTicketsInput } from "./finance-contracts";
export type {
  NightAuditPreflightBlockerWire,
  NightAuditPreflightOverrideWire,
  NightAuditReopenBody,
  NightAuditReopenReasonCode,
  NightAuditReportWire,
  NightAuditRunBody,
  NightAuditRunWire,
  NightAuditSettledFoliosWire,
  NightAuditStepWire
} from "@hotelos/shared";

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
// GET /properties/:propertyId/pos/cash-summary?from&to&outletId (or ?date) —
// read model of apps/api/src/modules/pos/pos-cash-closure.service.ts
// (getCashSummary): closed PosOrder rows (closedAt within [from, to)) grouped
// by outlet and by settlement. Tanda L3 · lote P1: the wire shape below is the
// API's, side counters included, so the board can say what the count does NOT
// contain (open tickets, rows without settlement or without closedAt, failed
// counters, a property without time zone) instead of painting a quiet day.
export type PosSettlementTotals = Record<PosSettlement, number>;
/** Closed rows whose payment method is unknown (closed before the settlement column existed): counted in `tickets` / `total`, in no method. */
export type PosCashUnsettled = { tickets: number; total: number; reason: "settlement_missing" };
/** Tickets still open that were created inside the window: pending, NOT revenue. */
export type PosCashOpenTickets = { count: number; total: number };
/**
 * Closed rows without `closed_at`: closed revenue no window can own, so they
 * never enter `totals` (window-independent; only the outlet filter applies).
 * `ids` lists at most 500 ids, oldest first; `tickets` / `total` cover every row.
 */
export type PosCashUnplaceable = { tickets: number; total: number; ids: string[]; reason: "closed_at_missing" };
export type PosCashSummaryOutlet = {
  /** Board outlet id (`out_<outletType>`); null only for an orphan Outlet FK. */
  outletId: string | null;
  /** Outlet row id (Outlet.id) the tickets are attached to — unique per row. */
  outletRowId: string;
  /** Outlet.name; null only for an orphan Outlet FK. */
  outletName: string | null;
  tickets: number;
  total: number;
  bySettlement: PosSettlementTotals;
  unsettled: PosCashUnsettled;
};
/** `utc_fallback` = the property has no (valid) IANA time zone: the business day is cut at UTC midnight. */
export type PosCashTimeZoneSource = "property" | "utc_fallback";
export type PosCashSummary = {
  propertyId: string;
  from: string;
  to: string;
  /** Echo of `date` (normalised) when the window was asked as a business day; null for from/to. */
  date: string | null;
  /** Echo of the outlet filter as received (board id or row id); null when not filtered. */
  outletId: string | null;
  /** IANA zone the window was resolved in (`UTC` under `utc_fallback`). */
  timeZone: string;
  timeZoneSource: PosCashTimeZoneSource;
  byOutlet: PosCashSummaryOutlet[];
  totals: { tickets: number; total: number; bySettlement: PosSettlementTotals; unsettled: PosCashUnsettled };
  openTickets: PosCashOpenTickets;
  unplaceable: PosCashUnplaceable;
  /** Labels of the side counters that fell back to zero because their query failed (QC-06): `openTickets`, `unplaceable`. */
  degraded: string[];
  source: "pos_orders";
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
// (persisted report: room charges from the rate plan, no-shows, settled folios
// of closed reservations, revenue, payments summary, cash closures, warnings
// and, when forced, the preflight override) · POST …/night-audit/run
// (night_audit.run; idempotent per business date; Tanda L5 · L5-D: the
// preflight is a gate — 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED without `force`,
// `{ force: true, reasonText }` closes over the blockers, audited) ·
// POST …/runs/:runId/review (night_audit.review; reviewer ≠ runner, 409
// RBAC_SOD_CONFLICT runner_ne_reviewer) · POST …/runs/:runId/reopen
// (night_audit.reopen; reason code; > 7 days needs the day_reopen approval →
// 409 APPROVAL_REQUIRED with details.requestId).
export function fetchNightAuditRuns(propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire[]>(`/properties/${propertyId}/night-audit/runs`);
}
export function fetchNightAuditRun(runId: string, propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire>(`/properties/${propertyId}/night-audit/runs/${encodeURIComponent(runId)}`);
}
export function fetchNightAuditBusinessDate(propertyId = getActivePropertyId()) {
  return apiRequest<{ propertyId: string; currentDate: string }>(`/properties/${propertyId}/night-audit/business-date`);
}
/**
 * 409 NIGHT_AUDIT_ALREADY_COMPLETED when the business date was already closed;
 * 409 NIGHT_AUDIT_PREFLIGHT_BLOCKED (details.blockers) when the preflight
 * blocks and `body.force` is not set; 400 when `force` comes without a reason.
 */
export function runNightAudit(propertyId = getActivePropertyId(), body?: NightAuditRunBody) {
  return apiRequest<NightAuditRunWire>(`/properties/${propertyId}/night-audit/run`, { method: "POST", body: body ?? {} });
}
/** Income audit of a completed run by someone other than the runner (409 runner_ne_reviewer otherwise). */
export function reviewNightAuditRun(runId: string, note?: string, propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire>(`/properties/${propertyId}/night-audit/runs/${encodeURIComponent(runId)}/review`, {
    method: "POST",
    body: note && note.trim() ? { note: note.trim() } : {}
  });
}
/** Reopens a completed day with a reason code (nothing is reversed); > 7 days → 409 APPROVAL_REQUIRED. */
export function reopenNightAuditRun(runId: string, body: NightAuditReopenBody, propertyId = getActivePropertyId()) {
  return apiRequest<NightAuditRunWire>(`/properties/${propertyId}/night-audit/runs/${encodeURIComponent(runId)}/reopen`, { method: "POST", body });
}

export function posErrorMessage(error: unknown, fallback = "No se pudo completar la operación del punto de venta."): string {
  return financeErrorMessage(error, fallback);
}
