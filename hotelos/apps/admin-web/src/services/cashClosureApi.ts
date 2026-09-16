// Cierre de caja (arqueo) del TPV (Tanda 6 · lote nav-services). Typed client of
// the cash-closure routes of apps/api/src/modules/pos/pos.routes.ts on
// packages/shared/src/pos-types.ts (closure figures travel as decimal strings
// "118.00": a count signed by a person round-trips byte for byte).
//
//   GET  /properties/:propertyId/pos/cash-closures?status&outletId&from&to&limit   listCashClosures     pos.read
//   POST /properties/:propertyId/pos/cash-closures { outletId, businessDate, openingFloat, notes }   openCashClosure   pos.order.pay
//   GET  /properties/:propertyId/pos/cash-closures/:closureId                     getCashClosure
//   POST …/cash-closures/:closureId/close { countedByMethod, counts, notes }        closeCashClosure     pos.order.pay (crítico)
//   POST …/cash-closures/:closureId/approve { notes }                              approveCashClosure   accounting.journal.post
//
// A closure is unique per (property, outlet, business day); once closed or
// approved the outlet refuses cash/card sales of that day (409 CASH_CLOSURE_CLOSED).
// Ticket lists (`?status=`) and the night-audit runs live in posApi.ts.

import type { CashClosureApproveRequest, CashClosureCloseRequest, CashClosureOpenRequest, CashClosureWire } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { cashClosureListQuery, financeErrorMessage, type CashClosureListInput } from "./finance-contracts";

export type { CashClosureApproveRequest, CashClosureCloseRequest, CashClosureOpenRequest, CashClosureWire, CashMethod, CashClosureStatus } from "@hotelos/shared";
export type { CashClosureListInput } from "./finance-contracts";

const enc = encodeURIComponent;

/** Reception cash of the whole property (`outletId: "*"`). */
export const RECEPTION_OUTLET_ID = "*";

export function listCashClosures(input: CashClosureListInput = {}, propertyId = getActivePropertyId()): Promise<CashClosureWire[]> {
  return apiRequest<CashClosureWire[]>(`/properties/${enc(propertyId)}/pos/cash-closures`, { query: cashClosureListQuery(input) });
}

/** 201: opens the day's closure with its opening float (CASH_CLOSURE_EXISTS when the outlet/day already has one). */
export function openCashClosure(body: CashClosureOpenRequest = {}, propertyId = getActivePropertyId()): Promise<CashClosureWire> {
  return apiRequest<CashClosureWire>(`/properties/${enc(propertyId)}/pos/cash-closures`, { method: "POST", body });
}

export function getCashClosure(closureId: string, propertyId = getActivePropertyId()): Promise<CashClosureWire> {
  return apiRequest<CashClosureWire>(`/properties/${enc(propertyId)}/pos/cash-closures/${enc(closureId)}`);
}

/** Counted amounts per method (+ optional denominations, whose sum must equal `countedByMethod.cash`); posts the difference entry. Critical. */
export function closeCashClosure(closureId: string, body: CashClosureCloseRequest, propertyId = getActivePropertyId()): Promise<CashClosureWire> {
  return apiRequest<CashClosureWire>(`/properties/${enc(propertyId)}/pos/cash-closures/${enc(closureId)}/close`, { method: "POST", body });
}

export function approveCashClosure(closureId: string, body: CashClosureApproveRequest = {}, propertyId = getActivePropertyId()): Promise<CashClosureWire> {
  return apiRequest<CashClosureWire>(`/properties/${enc(propertyId)}/pos/cash-closures/${enc(closureId)}/approve`, { method: "POST", body });
}

export function cashClosureErrorMessage(error: unknown, fallback = "No se pudo completar el cierre de caja."): string {
  return financeErrorMessage(error, fallback);
}
