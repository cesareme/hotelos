// Tesorería y banca (Tanda 6 · lote nav-services). Typed client of
// apps/api/src/modules/treasury/treasury.routes.ts on
// packages/shared/src/treasury-types.ts (money as strings "1234.50").
//
//   GET  /treasury/position | receivables | payables | forecast ?propertyId&asOf   banking.read
//   POST /treasury/bank-accounts/:id/statements/import { format, content, … }     banking.reconcile
//   GET  /treasury/bank-lines/:bankLineId/suggestions
//   POST|DELETE /treasury/bank-lines/:bankLineId/reconcile
//   POST /treasury/statements/:id/auto-reconcile { dryRun }
//   POST|GET /treasury/sepa/remittances · GET …/:id · POST …/:id/status
//   POST /treasury/sepa/supplier-payments { bankAccountId, billIds, executionDate, generate }
//
// Commissions and payroll routes of the same module live in commissionsApi.ts
// and payrollApi.ts. Legacy `/banking/*` routes stay in bankingApi.ts.

import type {
  AutoReconcileResult,
  BankLineSuggestions,
  CreateSepaRemittanceRequest,
  Csb43ImportResult,
  ReconcileLineRequest,
  ReconcileLineResult,
  SepaRemittanceRecord,
  SepaRemittanceStatus,
  StatementImportRequest,
  TreasuryForecast,
  TreasuryPayables,
  TreasuryPosition,
  TreasuryReceivables
} from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { compactQuery, financeErrorMessage, treasuryScopeQuery, type TreasuryScope } from "./finance-contracts";

export type {
  AutoReconcileResult,
  BankLineSuggestions,
  Csb43ImportResult,
  ReconcileLineRequest,
  ReconcileLineResult,
  SepaRemittanceRecord,
  StatementImportRequest,
  TreasuryForecast,
  TreasuryPayables,
  TreasuryPosition,
  TreasuryReceivables
} from "@hotelos/shared";
export type { TreasuryScope } from "./finance-contracts";

const enc = encodeURIComponent;

function scope(input: TreasuryScope): TreasuryScope {
  // «Ámbito» Sociedad (L7): `scope: "entity"` asks the whole sociedad and never falls back to the active centre.
  if (input.scope === "entity") return { scope: "entity", asOf: input.asOf };
  return { propertyId: input.propertyId ?? getActivePropertyId(), asOf: input.asOf };
}

// ---- Posición, cobros, pagos y previsión ---------------------------------------

/** Cash and banks from the ledger (570 / 572 per account) and the latest statement; `warnings` and `source` say how honest the figure is. */
export function getTreasuryPosition(input: TreasuryScope = {}): Promise<TreasuryPosition> {
  return apiRequest<TreasuryPosition>("/treasury/position", { query: treasuryScopeQuery(scope(input)) });
}

export function getTreasuryReceivables(input: TreasuryScope = {}): Promise<TreasuryReceivables> {
  return apiRequest<TreasuryReceivables>("/treasury/receivables", { query: treasuryScopeQuery(scope(input)) });
}

export function getTreasuryPayables(input: TreasuryScope = {}): Promise<TreasuryPayables> {
  return apiRequest<TreasuryPayables>("/treasury/payables", { query: treasuryScopeQuery(scope(input)) });
}

/** 30 / 60 / 90-day projection; `assumptions` lists the conventions used (issue + 30 days, …). */
export function getTreasuryForecast(input: TreasuryScope = {}): Promise<TreasuryForecast> {
  return apiRequest<TreasuryForecast>("/treasury/forecast", { query: treasuryScopeQuery(scope(input)) });
}

// ---- Extractos y conciliación ---------------------------------------------------

/** CSV import answer (`format: "csv"`): the persisted statement plus the import counters. */
export type CsvStatementImportResult = {
  id: string;
  bankAccountId: string;
  import: { statementId: string; persisted: boolean; newLines: number; duplicateLines: number; warnings: string[] };
  [key: string]: unknown;
};

export type StatementImportResult = Csb43ImportResult | CsvStatementImportResult;

/** Persisted import; duplicates are detected by fingerprint (`duplicateLines`) and never re-created. */
export function importBankStatement(bankAccountId: string, body: StatementImportRequest): Promise<StatementImportResult> {
  return apiRequest<StatementImportResult>(`/treasury/bank-accounts/${enc(bankAccountId)}/statements/import`, { method: "POST", body });
}

export function getBankLineSuggestions(bankLineId: string): Promise<BankLineSuggestions> {
  return apiRequest<BankLineSuggestions>(`/treasury/bank-lines/${enc(bankLineId)}/suggestions`);
}

/** Reconciles one line with a document (`matchType` payment · card_settlement · supplier_bill · payroll_period · commission_accrual · bank_fee · bank_interest · manual); fees and interest post their entry. */
export function reconcileBankLine(bankLineId: string, body: ReconcileLineRequest): Promise<ReconcileLineResult> {
  return apiRequest<ReconcileLineResult>(`/treasury/bank-lines/${enc(bankLineId)}/reconcile`, { method: "POST", body });
}

export type UnreconcileResult = { bankLineId: string; unmatched: boolean; reversalJournalEntryId: string | null };

export function unreconcileBankLine(bankLineId: string): Promise<UnreconcileResult> {
  return apiRequest<UnreconcileResult>(`/treasury/bank-lines/${enc(bankLineId)}/reconcile`, { method: "DELETE" });
}

/** High-confidence matches of a whole statement; `dryRun: true` only reports. */
export function autoReconcileStatement(statementId: string, options: { dryRun?: boolean } = {}): Promise<AutoReconcileResult> {
  return apiRequest<AutoReconcileResult>(`/treasury/statements/${enc(statementId)}/auto-reconcile`, { method: "POST", body: options });
}

// ---- Remesas SEPA (Norma 19 · Norma 34) --------------------------------------------

export function createSepaRemittance(body: CreateSepaRemittanceRequest): Promise<SepaRemittanceRecord> {
  return apiRequest<SepaRemittanceRecord>("/treasury/sepa/remittances", { method: "POST", body: { ...body, propertyId: body.propertyId ?? getActivePropertyId() } });
}

export function listSepaRemittances(input: { propertyId?: string; limit?: number } = {}): Promise<SepaRemittanceRecord[]> {
  return apiRequest<{ items: SepaRemittanceRecord[] }>("/treasury/sepa/remittances", { query: compactQuery({ propertyId: input.propertyId ?? getActivePropertyId(), limit: input.limit }) }).then((page) => page.items);
}

export function getSepaRemittance(remittanceId: string): Promise<SepaRemittanceRecord> {
  return apiRequest<SepaRemittanceRecord>(`/treasury/sepa/remittances/${enc(remittanceId)}`);
}

/** generated → sent → accepted | rejected · cancelled (REMITTANCE_STATUS_TRANSITION otherwise). */
export function updateSepaRemittanceStatus(remittanceId: string, body: { status: SepaRemittanceStatus; note?: string }): Promise<SepaRemittanceRecord> {
  return apiRequest<SepaRemittanceRecord>(`/treasury/sepa/remittances/${enc(remittanceId)}/status`, { method: "POST", body });
}

export type SupplierPaymentRemittanceRequest = { propertyId?: string; bankAccountId: string; billIds: string[]; executionDate: string; generate?: boolean };

export type SupplierPaymentRemittanceResult = {
  body: unknown;
  totalAmount: string;
  transactions: number;
  warnings: string[];
  /** Only when `generate: true`. */
  remittance?: SepaRemittanceRecord;
  [key: string]: unknown;
};

/** Builds (and with `generate` persists) a Norma 34 transfer file for posted supplier bills. */
export function buildSupplierPaymentRemittance(body: SupplierPaymentRemittanceRequest): Promise<SupplierPaymentRemittanceResult> {
  return apiRequest<SupplierPaymentRemittanceResult>("/treasury/sepa/supplier-payments", { method: "POST", body: { ...body, propertyId: body.propertyId ?? getActivePropertyId() } });
}

// ---- Errores ------------------------------------------------------------------

export function treasuryErrorMessage(error: unknown, fallback = "No se pudo completar la operación de tesorería."): string {
  return financeErrorMessage(error, fallback);
}
