// Comisiones de canales (Tanda 6 · lote nav-services). Typed client of the
// commission routes: legacy rules/accruals/summary of server.ts (strict
// CreateCommissionRuleSchema, apps/api/src/schemas/payroll-commissions.schemas.ts)
// plus the Tanda 6 accrual routes of apps/api/src/modules/treasury/treasury.routes.ts.
// Contracts: packages/shared/src/treasury-types.ts (CommissionAccrualRecord ·
// AccrueCommissionResult; money as strings).
//
//   GET  /commissions/rules?propertyId · POST /commissions/rules · POST /commissions/rules/:id/deactivate   commissions.read · manage
//   GET  /commissions/accruals?propertyId&from&to · GET /commissions/summary?propertyId&from&to
//   GET  /commissions/accruals/:id
//   POST /commissions/accrue { reservationId, channelCode?, baseAmount?, accruedAt? }   accrueCommission (D 629.1 / H 410)
//   POST /commissions/accruals/:id/settle { paidAt, bankLedgerCode, reference } · POST …/:id/reverse { reason }

import type { AccrueCommissionResult, CommissionAccrualRecord } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { compactQuery, financeErrorMessage } from "./finance-contracts";

export type { AccrueCommissionResult, CommissionAccrualRecord } from "@hotelos/shared";

const enc = encodeURIComponent;

export const COMMISSION_APPLIES_TO = ["gross_revenue", "net_revenue", "total"] as const;
export type CommissionAppliesTo = (typeof COMMISSION_APPLIES_TO)[number];

export const COMMISSION_APPLIES_TO_LABELS_ES: Readonly<Record<CommissionAppliesTo, string>> = Object.freeze({
  gross_revenue: "Ingreso bruto",
  net_revenue: "Ingreso neto",
  total: "Total"
});

export type CommissionRuleRecord = {
  id: string;
  propertyId: string;
  channelId: string | null;
  channelCode: string | null;
  ratePct: string;
  appliesTo: CommissionAppliesTo | string;
  ledgerAccountCode: string;
  active: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
};

export type CreateCommissionRuleRequest = {
  propertyId?: string;
  /** One of channelId / channelCode is required. */
  channelId?: string | null;
  channelCode?: string | null;
  /** 0 < ratePct ≤ 100 (number or decimal string). */
  ratePct: number | string;
  appliesTo?: CommissionAppliesTo;
  /** PGC account (default 629.1). */
  ledgerAccountCode?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

export type CommissionSummary = {
  propertyId: string;
  from: string | null;
  to: string | null;
  total: { commissionAmount: number; baseAmount: number; count: number };
  byChannel: Array<{ channelKey: string; commissionAmount: number; baseAmount: number; count: number }>;
  byStatus: Array<{ status: string; commissionAmount: number; count: number }>;
};

type WindowInput = { propertyId?: string; from?: string; to?: string };

function windowQuery(input: WindowInput) {
  return compactQuery({ propertyId: input.propertyId ?? getActivePropertyId(), from: input.from, to: input.to });
}

// ---- Reglas ---------------------------------------------------------------------

export function listCommissionRules(propertyId = getActivePropertyId()): Promise<CommissionRuleRecord[]> {
  return apiRequest<CommissionRuleRecord[]>("/commissions/rules", { query: compactQuery({ propertyId }) });
}

/** Strict body (400 in Spanish naming the key); a channelId of another property is an opaque 404. */
export function createCommissionRule(body: CreateCommissionRuleRequest): Promise<CommissionRuleRecord> {
  return apiRequest<CommissionRuleRecord>("/commissions/rules", { method: "POST", body: { ...body, propertyId: body.propertyId ?? getActivePropertyId() } });
}

export function deactivateCommissionRule(ruleId: string): Promise<CommissionRuleRecord> {
  return apiRequest<CommissionRuleRecord>(`/commissions/rules/${enc(ruleId)}/deactivate`, { method: "POST" });
}

// ---- Devengos -------------------------------------------------------------------

export function listCommissionAccruals(input: WindowInput = {}): Promise<CommissionAccrualRecord[]> {
  return apiRequest<CommissionAccrualRecord[]>("/commissions/accruals", { query: windowQuery(input) });
}

export function getCommissionSummary(input: WindowInput = {}): Promise<CommissionSummary> {
  return apiRequest<CommissionSummary>("/commissions/summary", { query: windowQuery(input) });
}

export function getCommissionAccrual(accrualId: string): Promise<CommissionAccrualRecord> {
  return apiRequest<CommissionAccrualRecord>(`/commissions/accruals/${enc(accrualId)}`);
}

export type AccrueCommissionRequest = { reservationId: string; propertyId?: string; channelCode?: string; baseAmount?: number | string; accruedAt?: string };

/** Manual accrual of an OTA reservation; `base.warnings` says when the base is estimated. Direct-channel reservations are a 400. */
export function accrueCommission(body: AccrueCommissionRequest): Promise<AccrueCommissionResult> {
  return apiRequest<AccrueCommissionResult>("/commissions/accrue", { method: "POST", body: { ...body, propertyId: body.propertyId ?? getActivePropertyId() } });
}

export type SettleCommissionRequest = { paidAt?: string; bankLedgerCode?: string; reference?: string };

/** Settlement entry D 410 / H 572 (COMMISSION_SETTLED when already settled). */
export function settleCommissionAccrual(accrualId: string, body: SettleCommissionRequest = {}): Promise<CommissionAccrualRecord> {
  return apiRequest<CommissionAccrualRecord>(`/commissions/accruals/${enc(accrualId)}/settle`, { method: "POST", body });
}

export function reverseCommissionAccrual(accrualId: string, body: { reason?: string } = {}): Promise<CommissionAccrualRecord> {
  return apiRequest<CommissionAccrualRecord>(`/commissions/accruals/${enc(accrualId)}/reverse`, { method: "POST", body });
}

export function commissionsErrorMessage(error: unknown, fallback = "No se pudo completar la operación de comisiones."): string {
  return financeErrorMessage(error, fallback);
}
