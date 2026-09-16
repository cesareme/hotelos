// Contabilidad · diario, mayor, plan de cuentas y ajustes (Tanda 6 · lote
// nav-services). Typed client of apps/api/src/modules/accounting/ledger.routes.ts
// on the contracts of packages/shared/src/accounting-types.ts (money as
// strings "121.00", dates AAAA-MM-DD, typed 4xx with details.code).
//
//   GET  /accounting/journal?…&envelope=1     listJournal            accounting.reports.read
//   GET  /accounting/journal/export           downloadJournalCsv     accounting.reports.read
//   GET  /accounting/journal/:id              getJournalEntry        accounting.reports.read
//   POST /accounting/journal                  createManualJournalEntry  accounting.journal.post (alto riesgo)
//   POST /accounting/journal/:id/reverse      reverseJournalEntry    accounting.journal.post + ai.high_risk.confirm
//   GET  /accounting/ledger/:accountCode      getAccountLedger · downloadLedgerCsv
//   GET|POST /accounting/chart · PATCH /accounting/chart/:code
//   GET|PATCH /accounting/settings
//   POST /accounting/replay · GET /accounting/projection/status
//
// Errors: accountingErrorMessage(error) maps FISCAL_YEAR_CLOSED,
// CHART_NOT_PROVISIONED, JOURNAL_UNBALANCED… to Spanish (finance-contracts.ts).

import type {
  AccountLedgerView,
  AccountingSettingsPatchInput,
  AccountingSettingsView,
  ChartAccountCreateInput,
  ChartAccountPatchInput,
  ChartAccountView,
  JournalEntryView,
  JournalListPage,
  JournalListQuery,
  ManualJournalEntryInput,
  ProjectionStatusView,
  ReplayReportView,
  ReplayRequestInput,
  ReverseJournalEntryInput
} from "@hotelos/shared";
import { apiRequest, apiRequestBlob, type BlobResponse } from "./api-client";
import { chartQuery, downloadFilename, financeErrorMessage, journalQuery, ledgerQuery, type LedgerQueryInput } from "./finance-contracts";

export type { AccountLedgerView, AccountingSettingsView, ChartAccountView, JournalEntryView, JournalListPage, JournalListQuery, ManualJournalEntryInput, ReverseJournalEntryInput } from "@hotelos/shared";

/** A downloaded file with the name the API suggested. */
export type NamedDownload = { blob: Blob; filename: string; contentType: string };

function named(response: BlobResponse, fallback: string): NamedDownload {
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, fallback), contentType: response.contentType };
}

// ---- Diario ---------------------------------------------------------------

export function listJournal(query: JournalListQuery = {}): Promise<JournalListPage> {
  return apiRequest<JournalListPage>("/accounting/journal", { query: journalQuery(query) });
}

export function getJournalEntry(journalEntryId: string): Promise<JournalEntryView> {
  return apiRequest<JournalEntryView>(`/accounting/journal/${encodeURIComponent(journalEntryId)}`);
}

/** Manual entry (201). At least two balanced lines with positive amounts on debit or credit. */
export function createManualJournalEntry(body: ManualJournalEntryInput): Promise<JournalEntryView> {
  return apiRequest<JournalEntryView>("/accounting/journal", { method: "POST", body });
}

/** Marked reversal (201): nothing is deleted; `entryDate` defaults to the reversed entry's date. */
export function reverseJournalEntry(journalEntryId: string, body: ReverseJournalEntryInput): Promise<JournalEntryView> {
  return apiRequest<JournalEntryView>(`/accounting/journal/${encodeURIComponent(journalEntryId)}/reverse`, { method: "POST", body });
}

/** CSV of the filtered journal (same filters as listJournal, no paging). */
export async function downloadJournalCsv(query: Omit<JournalListQuery, "limit" | "cursor"> = {}): Promise<NamedDownload> {
  const { envelope: _envelope, ...filters } = journalQuery(query);
  return named(await apiRequestBlob("/accounting/journal/export", { query: filters }), "diario.csv");
}

// ---- Mayor ----------------------------------------------------------------

/** Movements of one account; `totals` and `closingBalance` cover the whole window even when `truncated`. */
export function getAccountLedger(accountCode: string, query: LedgerQueryInput = {}): Promise<AccountLedgerView> {
  return apiRequest<AccountLedgerView>(`/accounting/ledger/${encodeURIComponent(accountCode)}`, { query: ledgerQuery(query) });
}

export async function downloadLedgerCsv(accountCode: string, query: LedgerQueryInput = {}): Promise<NamedDownload> {
  return named(await apiRequestBlob(`/accounting/ledger/${encodeURIComponent(accountCode)}`, { query: ledgerQuery(query, "csv") }), `mayor-${accountCode}.csv`);
}

// ---- Plan de cuentas ------------------------------------------------------

export type ChartAccountsResponse = { organizationId: string; chartTemplate: string | null; accounts: ChartAccountView[] };

export function listChartAccounts(options: { postableOnly?: boolean } = {}): Promise<ChartAccountsResponse> {
  return apiRequest<ChartAccountsResponse>("/accounting/chart", { query: chartQuery(options) });
}

export function createChartAccount(body: ChartAccountCreateInput): Promise<ChartAccountView> {
  return apiRequest<ChartAccountView>("/accounting/chart", { method: "POST", body });
}

export function patchChartAccount(code: string, body: ChartAccountPatchInput): Promise<ChartAccountView> {
  return apiRequest<ChartAccountView>(`/accounting/chart/${encodeURIComponent(code)}`, { method: "PATCH", body });
}

// ---- Ajustes --------------------------------------------------------------

export function getAccountingSettings(): Promise<AccountingSettingsView> {
  return apiRequest<AccountingSettingsView>("/accounting/settings");
}

export function patchAccountingSettings(body: AccountingSettingsPatchInput): Promise<AccountingSettingsView> {
  return apiRequest<AccountingSettingsView>("/accounting/settings", { method: "PATCH", body });
}

// ---- Proyección -------------------------------------------------------------

/** Re-projection of documents into the journal; `apply` defaults to false (dry run, writes nothing). */
export function replayProjection(body: ReplayRequestInput): Promise<ReplayReportView> {
  return apiRequest<ReplayReportView>("/accounting/replay", { method: "POST", body });
}

export function getProjectionStatus(): Promise<ProjectionStatusView> {
  return apiRequest<ProjectionStatusView>("/accounting/projection/status");
}

// ---- Errores --------------------------------------------------------------

export function accountingErrorMessage(error: unknown, fallback = "No se pudo completar la operación contable."): string {
  return financeErrorMessage(error, fallback);
}
