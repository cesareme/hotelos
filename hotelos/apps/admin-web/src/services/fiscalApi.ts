// IVA y modelos AEAT (Tanda 6 · lote nav-services). Typed client of
// apps/api/src/modules/accounting/fiscal.routes.ts on
// packages/shared/src/fiscal-types.ts (FiscalModelReport: casillas · totales ·
// avisos · fuentes · detalle · presentacion.modo = manual).
//
//   GET  /fiscal/models/:modelo?period=2026-Q3|2026-09 · ?year=2026   getFiscalModel      accounting.reports.read
//        (303: `{ informativo: true }` → &informativo=1, monthly view of a quarterly sociedad · FIX-1 · F3)
//   GET  /fiscal/models/:modelo/pdf                                  downloadFiscalModelPdf
//   GET  /fiscal/vat-books?book=&period=|from&to                     getVatBook
//   GET  /fiscal/vat-books/periods                                   getVatBookPeriods   (FIX-1 · F3: default period)
//   POST /fiscal/vat-books/rebuild                                   rebuildVatBooks     accounting.configure (alto riesgo)
//   GET|PUT /fiscal/vat-settings                                     getVatSettings · putVatSettings
//   GET  /fiscal/vat-settlement?period=                              previewVatSettlement
//   POST /fiscal/vat-settlement · POST /fiscal/vat-settlement/reverse  postVatSettlement · reverseVatSettlement  accounting.journal.post (crítico)

import type {
  FiscalModelCode,
  FiscalModelReport,
  VatBookPeriodsResponse,
  VatBookResponse,
  VatBooksRebuildResponse,
  VatSettingsDto,
  VatSettlementPreview,
  VatSettlementResult,
  VatSettlementReversalResult
} from "@hotelos/shared";
import { apiRequest, apiRequestBlob } from "./api-client";
import { compactQuery, downloadFilename, financeErrorMessage, fiscalModelQuery, vatBookQuery, type FiscalModelParams, type VatBookQueryInput } from "./finance-contracts";
import type { NamedDownload } from "./accountingApi";

export type { FiscalModelCode, FiscalModelReport, VatBookPeriodsResponse, VatBookResponse, VatSettingsDto, VatSettlementPreview, VatSettlementResult } from "@hotelos/shared";
export type { FiscalModelParams, VatBookQueryInput } from "./finance-contracts";

// ---- Modelos ----------------------------------------------------------------

export type FiscalModelOptions = {
  /** FIX-1 · F3 (E-02): 303 only — read a month of a quarterly sociedad as an informative view (no compensation, not filable). */
  informativo?: boolean;
};

/** One envelope for every model (303 · 390 · 347 · 111 · 115 · 180). Annual models need `year` (or `period: "2026"`). */
export function getFiscalModel(modelo: FiscalModelCode, params: FiscalModelParams = {}, options: FiscalModelOptions = {}): Promise<FiscalModelReport> {
  return apiRequest<FiscalModelReport>(`/fiscal/models/${modelo}`, { query: { ...fiscalModelQuery(modelo, params), ...(options.informativo ? { informativo: "1" } : {}) } });
}

/** «Descargar resumen»: the PDF summary meant for the AEAT sede or the gestoría (presentación manual). */
export async function downloadFiscalModelPdf(modelo: FiscalModelCode, params: FiscalModelParams = {}): Promise<NamedDownload> {
  const response = await apiRequestBlob(`/fiscal/models/${modelo}/pdf`, { query: fiscalModelQuery(modelo, params) });
  const period = params.period ?? (params.year !== undefined ? String(params.year) : "periodo");
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, `modelo-${modelo}-${period}.pdf`), contentType: response.contentType };
}

// ---- Libros registro ----------------------------------------------------------

export function getVatBook(input: VatBookQueryInput): Promise<VatBookResponse> {
  return apiRequest<VatBookResponse>("/fiscal/vat-books", { query: vatBookQuery(input) });
}

/** FIX-1 · F3 (E-04): the settlement periods with materialised book rows (newest first) and the latest one — the default period of the pickers. */
export function getVatBookPeriods(): Promise<VatBookPeriodsResponse> {
  return apiRequest<VatBookPeriodsResponse>("/fiscal/vat-books/periods");
}

export type VatBooksRebuildInput = { period?: string; from?: string; to?: string; propertyId?: string };

/** Rebuilds the materialised rows of a period from the documents (deletes and recreates; high risk). */
export function rebuildVatBooks(body: VatBooksRebuildInput): Promise<VatBooksRebuildResponse> {
  return apiRequest<VatBooksRebuildResponse>("/fiscal/vat-books/rebuild", { method: "POST", body: compactQuery(body) });
}

// ---- Ajustes de IVA -----------------------------------------------------------

export type VatSettingsPatch = {
  periodicity?: "quarterly" | "monthly";
  regime?: "general" | "redeme" | "recargo";
  prorrataPct?: number | null;
  taxFigure?: "IVA" | "IGIC" | "IPSI";
  /** FIX-1 · F3 (B-2): saldo inicial a compensar (casilla 110), ≥ 0, and the settlement period it applies from (`2025-Q1` · `2025-01`; null = none). */
  openingCompensation?: number;
  openingCompensationPeriod?: string | null;
};

export function getVatSettings(): Promise<VatSettingsDto> {
  return apiRequest<VatSettingsDto>("/fiscal/vat-settings");
}

export function putVatSettings(body: VatSettingsPatch): Promise<VatSettingsDto> {
  return apiRequest<VatSettingsDto>("/fiscal/vat-settings", { method: "PUT", body });
}

// ---- Liquidación --------------------------------------------------------------

/** Preview of the settlement entry of a period (`2026-Q3` · `2026-09`): result, compensation and balanced lines. */
export function previewVatSettlement(period: string): Promise<VatSettlementPreview> {
  return apiRequest<VatSettlementPreview>("/fiscal/vat-settlement", { query: { period } });
}

/** Posts the settlement entry (D 477 / H 472 / H 4750 or D 4700). Critical: confirm before calling. */
export function postVatSettlement(body: { period: string; entryDate?: string }): Promise<VatSettlementResult> {
  return apiRequest<VatSettlementResult>("/fiscal/vat-settlement", { method: "POST", body });
}

export function reverseVatSettlement(body: { period: string; reason?: string; entryDate?: string }): Promise<VatSettlementReversalResult> {
  return apiRequest<VatSettlementReversalResult>("/fiscal/vat-settlement/reverse", { method: "POST", body });
}

// ---- Errores ------------------------------------------------------------------

export function fiscalErrorMessage(error: unknown, fallback = "No se pudo generar el modelo. Inténtalo de nuevo."): string {
  return financeErrorMessage(error, fallback);
}
