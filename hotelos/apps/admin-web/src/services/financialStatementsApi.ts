// Estados financieros: USALI, cuentas anuales PGC Pymes y exportación a
// gestoría (Tanda 6 · lote nav-services). Typed client of
// apps/api/src/modules/financial-statements/financial-statements.routes.ts on
// packages/shared/src/financial-statements-types.ts (MoneyString everywhere,
// ratios null when the denominator is 0 — never a fake 0).
//
//   GET|PATCH /accounting/usali/mappings · DELETE …/mappings/:mappingId   accounting.reports.read · accounting.configure
//   GET  /accounting/usali/coverage?from&to
//   GET  /accounting/usali/pnl?from&to&propertyId[&format]
//   GET  /accounting/usali/compare?from&to&propertyIds=a,b
//   GET  /accounting/usali/periods?periods=from..to,from..to&propertyId
//   GET  /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria]?fiscalYearId|from&to&propertyId&comparative[&format]
//   GET|POST /accounting/annual-accounts/snapshots · GET …/:snapshotId[/download?format=]
//   GET  /accounting/gestoria-exports/formats · GET|POST /accounting/gestoria-exports · GET …/:exportId[/download]   analytics.export
//
// `format=pdf|xlsx|csv` turns a statement into a download (downloadStatement).

import type {
  AnnualAccounts,
  FinancialStatementKindKey,
  FinancialStatementSnapshotDetail,
  FinancialStatementSnapshotRow,
  GestoriaExportCreateBody,
  GestoriaExportFormatInfo,
  GestoriaExportFormatKey,
  GestoriaExportRow,
  PgcBalanceSheet,
  PgcEquityChanges,
  PgcMemoria,
  PgcProfitAndLoss,
  SnapshotCreateBody,
  UsaliCoverage,
  UsaliMappingPatchBody,
  UsaliMappingsResponse,
  UsaliPeriodComparison,
  UsaliPnl,
  UsaliPropertyComparison
} from "@hotelos/shared";
import { apiRequest, apiRequestBlob } from "./api-client";
import type { NamedDownload } from "./accountingApi";
import {
  annualAccountsQuery,
  compactQuery,
  downloadFilename,
  financeErrorMessage,
  statementWindowQuery,
  usaliPeriodsParam,
  type AnnualAccountsQueryInput,
  type StatementDownloadFormat,
  type StatementWindow
} from "./finance-contracts";

export type {
  AnnualAccounts,
  FinancialStatementKindKey,
  FinancialStatementSnapshotRow,
  GestoriaExportFormatInfo,
  GestoriaExportRow,
  PgcBalanceSheet,
  PgcProfitAndLoss,
  UsaliCoverage,
  UsaliMappingsResponse,
  UsaliPnl
} from "@hotelos/shared";
export type { AnnualAccountsQueryInput, StatementDownloadFormat, StatementWindow } from "./finance-contracts";

const enc = encodeURIComponent;

// ---- USALI: mapeo ---------------------------------------------------------------

/** Mappings + coverage (+ per-period unmapped accounts with movements when `window` is given). */
export function getUsaliMappings(window: StatementWindow = {}): Promise<UsaliMappingsResponse> {
  return apiRequest<UsaliMappingsResponse>("/accounting/usali/mappings", { query: statementWindowQuery({ from: window.from, to: window.to }) });
}

export function patchUsaliMappings(body: UsaliMappingPatchBody): Promise<UsaliMappingsResponse> {
  return apiRequest<UsaliMappingsResponse>("/accounting/usali/mappings", { method: "PATCH", body });
}

export function deleteUsaliMapping(mappingId: string): Promise<UsaliMappingsResponse> {
  return apiRequest<UsaliMappingsResponse>(`/accounting/usali/mappings/${enc(mappingId)}`, { method: "DELETE" });
}

export function getUsaliCoverage(window: StatementWindow = {}): Promise<UsaliCoverage> {
  return apiRequest<UsaliCoverage>("/accounting/usali/coverage", { query: statementWindowQuery({ from: window.from, to: window.to }) });
}

// ---- USALI: estado de resultados y comparaciones ------------------------------------

export type UsaliWindow = { from: string; to: string; propertyId?: string };

/** Summary operating statement with the always-visible «Sin asignar» block and the PGC reconciliation. */
export function getUsaliPnl(window: UsaliWindow): Promise<UsaliPnl> {
  return apiRequest<UsaliPnl>("/accounting/usali/pnl", { query: statementWindowQuery(window) });
}

export function compareUsaliProperties(window: { from: string; to: string; propertyIds?: string[] }): Promise<UsaliPropertyComparison> {
  return apiRequest<UsaliPropertyComparison>("/accounting/usali/compare", {
    query: compactQuery({ from: window.from, to: window.to, propertyIds: window.propertyIds?.length ? window.propertyIds.join(",") : undefined })
  });
}

/** Two to six periods; the first one is the base of every delta. */
export function compareUsaliPeriods(periods: ReadonlyArray<{ from: string; to: string }>, propertyId?: string): Promise<UsaliPeriodComparison> {
  return apiRequest<UsaliPeriodComparison>("/accounting/usali/periods", { query: compactQuery({ periods: usaliPeriodsParam(periods), propertyId }) });
}

// ---- Cuentas anuales PGC Pymes ------------------------------------------------------

export function getAnnualAccounts(input: AnnualAccountsQueryInput = {}): Promise<AnnualAccounts> {
  return apiRequest<AnnualAccounts>("/accounting/annual-accounts", { query: annualAccountsQuery(input) });
}

export function getBalanceSheet(input: AnnualAccountsQueryInput = {}): Promise<PgcBalanceSheet> {
  return apiRequest<PgcBalanceSheet>("/accounting/annual-accounts/balance", { query: annualAccountsQuery(input) });
}

export function getProfitAndLoss(input: AnnualAccountsQueryInput = {}): Promise<PgcProfitAndLoss> {
  return apiRequest<PgcProfitAndLoss>("/accounting/annual-accounts/pyg", { query: annualAccountsQuery(input) });
}

export function getEquityChanges(input: AnnualAccountsQueryInput = {}): Promise<PgcEquityChanges> {
  return apiRequest<PgcEquityChanges>("/accounting/annual-accounts/ecpn", { query: annualAccountsQuery(input) });
}

export function getMemoria(input: AnnualAccountsQueryInput = {}): Promise<PgcMemoria> {
  return apiRequest<PgcMemoria>("/accounting/annual-accounts/memoria", { query: annualAccountsQuery(input) });
}

export type StatementRoute = "usali" | "annual-accounts" | "balance" | "pyg" | "ecpn" | "memoria";

const STATEMENT_PATHS: Record<StatementRoute, string> = {
  usali: "/accounting/usali/pnl",
  "annual-accounts": "/accounting/annual-accounts",
  balance: "/accounting/annual-accounts/balance",
  pyg: "/accounting/annual-accounts/pyg",
  ecpn: "/accounting/annual-accounts/ecpn",
  memoria: "/accounting/annual-accounts/memoria"
};

/** The same statement as a file (`pdf` · `xlsx` · `csv`), named by the API (`<stem>_<from>_<to>.<ext>`). */
export async function downloadStatement(statement: StatementRoute, input: AnnualAccountsQueryInput, format: Exclude<StatementDownloadFormat, "json">): Promise<NamedDownload> {
  const query = statement === "usali" ? statementWindowQuery(input, format) : annualAccountsQuery(input, format);
  const response = await apiRequestBlob(STATEMENT_PATHS[statement], { query });
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, `${statement}.${format}`), contentType: response.contentType };
}

// ---- Instantáneas ---------------------------------------------------------------------

export function listSnapshots(input: { kind?: FinancialStatementKindKey; fiscalYearId?: string; limit?: number } = {}): Promise<FinancialStatementSnapshotRow[]> {
  return apiRequest<FinancialStatementSnapshotRow[]>("/accounting/annual-accounts/snapshots", { query: compactQuery(input) });
}

/** 201: freezes the statement as generated today (accounting.configure). */
export function createSnapshot(body: SnapshotCreateBody): Promise<FinancialStatementSnapshotRow> {
  return apiRequest<FinancialStatementSnapshotRow>("/accounting/annual-accounts/snapshots", { method: "POST", body });
}

export function getSnapshot(snapshotId: string): Promise<FinancialStatementSnapshotDetail> {
  return apiRequest<FinancialStatementSnapshotDetail>(`/accounting/annual-accounts/snapshots/${enc(snapshotId)}`);
}

export async function downloadSnapshot(snapshotId: string, format: Exclude<StatementDownloadFormat, "json">): Promise<NamedDownload> {
  const response = await apiRequestBlob(`/accounting/annual-accounts/snapshots/${enc(snapshotId)}/download`, { query: { format } });
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, `instantanea-${snapshotId}.${format}`), contentType: response.contentType };
}

// ---- Exportación a gestoría --------------------------------------------------------------

/** Formats with `implemented` and `validateWithAdvisor` flags (csv_universal always; a3 not implemented). */
export function listGestoriaFormats(): Promise<GestoriaExportFormatInfo[]> {
  return apiRequest<{ formats: GestoriaExportFormatInfo[] }>("/accounting/gestoria-exports/formats").then((response) => response.formats);
}

export function listGestoriaExports(input: { format?: GestoriaExportFormatKey; limit?: number } = {}): Promise<GestoriaExportRow[]> {
  return apiRequest<GestoriaExportRow[]>("/accounting/gestoria-exports", { query: compactQuery(input) });
}

/** 201; `a3` answers 409 EXPORT_FORMAT_NOT_IMPLEMENTED. */
export function createGestoriaExport(body: GestoriaExportCreateBody): Promise<GestoriaExportRow> {
  return apiRequest<GestoriaExportRow>("/accounting/gestoria-exports", { method: "POST", body });
}

export function getGestoriaExport(exportId: string): Promise<GestoriaExportRow> {
  return apiRequest<GestoriaExportRow>(`/accounting/gestoria-exports/${enc(exportId)}`);
}

export async function downloadGestoriaExport(exportRow: Pick<GestoriaExportRow, "id" | "fileName">): Promise<NamedDownload> {
  const response = await apiRequestBlob(`/accounting/gestoria-exports/${enc(exportRow.id)}/download`);
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, exportRow.fileName), contentType: response.contentType };
}

// ---- Errores ------------------------------------------------------------------

export function statementsErrorMessage(error: unknown, fallback = "No se pudo generar el estado contable. Inténtalo de nuevo."): string {
  return financeErrorMessage(error, fallback);
}
