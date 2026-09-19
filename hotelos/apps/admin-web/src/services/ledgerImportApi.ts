// Importación contable desde Sage 200 (Tanda 7c · L4). Typed client of
// apps/api/src/modules/accounting/ledger-import.routes.ts on the contracts of
// packages/shared/src/ledger-import-types.ts (design
// docs/design/FINANZAS-IMPORTACION-SAGE200.md §7; runbook
// docs/runbooks/finanzas-importacion-sage200.md):
//
//   POST /accounting/ledger-imports/preview                previewLedgerImport (never writes)            accounting.journal.post
//   POST /accounting/ledger-imports                        createLedgerImport (201; posts unless post=false) accounting.journal.post
//   GET  /accounting/ledger-imports                        listLedgerImports (newest first)               accounting.read
//   GET  /accounting/ledger-imports/:id                    getLedgerImport (lote + entradas + mapeo)      accounting.read
//   POST /accounting/ledger-imports/:id/post               postLedgerImport (draft → posted)              accounting.journal.post
//   POST /accounting/ledger-imports/:id/reverse            reverseLedgerImport (idempotente)              accounting.journal.post + ai.high_risk.confirm
//   GET  /accounting/ledger-imports/account-map            getAccountMap                                  accounting.read
//   PUT  /accounting/ledger-imports/account-map            putAccountMap (crea las subcuentas `create`)   accounting.configure
//   GET  /accounting/ledger-imports/analytics-map          getAnalyticsMap                                accounting.read
//   PUT  /accounting/ledger-imports/analytics-map          putAnalyticsMap                                accounting.configure
//   POST /accounting/ledger-imports/reconciliation         reconcileLedger (balance Sage vs diario)       accounting.journal.post
//   GET  /accounting/ledger-imports/reconciliation         listReconciliations                            accounting.read
//   GET  /accounting/ledger-imports/reconciliation/:id     getReconciliation                              accounting.read
//   GET  /accounting/ledger-imports/reconciliation/:id/csv downloadReconciliationCsv → NamedDownload      accounting.read
//   GET  /accounting/ledger-imports/template               downloadLedgerImportTemplate → NamedDownload   accounting.read
//   GET  /accounting/ledger-imports/third-parties          listLedgerThirdParties (FIX-1 · F11, directorio) accounting.read
//
// The browser ALWAYS sends the bytes as `contentBase64` (CSV included): the API
// decides the encoding (utf-8 → windows-1252) and the format (`format` >
// extension > signature > header); `file.text()` would destroy latin1, and an
// XLSX or a ZIP has no text form at all. The `content` (text) body of the
// contract is for the CLI and the tests only.
// Errors arrive as details.code (LEDGER_IMPORT_*, LEDGER_RECONCILIATION_*
// and the engine codes) and are mapped by ledgerImportErrorMessage on top of
// finance-contracts; a 413 of Fastify (bodyLimit per route) reads as «El
// fichero supera el tamaño admitido (20 MB)». Only `import type` from
// @hotelos/shared: the Spanish sentences per code are redeclared here, typed
// against the contract (a code added in L0 without a sentence fails the
// typecheck).

import type {
  LedgerAccountMapPutBody,
  LedgerAccountMapResponse,
  LedgerAnalyticsMapPutBody,
  LedgerAnalyticsMapResponse,
  LedgerImportCreateBody,
  LedgerImportCreateResult,
  LedgerImportDetail,
  LedgerImportErrorCode,
  LedgerImportKind,
  LedgerImportListQuery,
  LedgerImportPostBody,
  LedgerImportPreview,
  LedgerImportPreviewBody,
  LedgerImportRecord,
  LedgerImportReverseBody,
  LedgerReconciliationBody,
  LedgerReconciliationDto,
  LedgerReconciliationListQuery,
  LedgerThirdPartyListQuery,
  LedgerThirdPartyPage
} from "@hotelos/shared";
import { date, number, plural } from "../lib/format";
import type { NamedDownload } from "./accountingApi";
import { apiRequest, apiRequestBlob } from "./api-client";
import { compactQuery, downloadFilename, financeErrorCode, financeErrorDetails, financeErrorMessage, financeErrorStatus } from "./finance-contracts";

export type {
  LedgerAccountMapDto,
  LedgerAccountMapPutBody,
  LedgerAccountMapResponse,
  LedgerAnalyticsMapDto,
  LedgerAnalyticsMapPutBody,
  LedgerAnalyticsMapResponse,
  LedgerImportCreateBody,
  LedgerImportCreateResult,
  LedgerImportDetail,
  LedgerImportEntryDto,
  LedgerImportKind,
  LedgerImportListQuery,
  LedgerImportPreview,
  LedgerImportPreviewBody,
  LedgerImportRecord,
  LedgerReconciliationBody,
  LedgerReconciliationDto,
  LedgerReconciliationListQuery,
  LedgerReconciliationRow,
  LedgerThirdPartyDto,
  LedgerThirdPartyListQuery,
  LedgerThirdPartyLotRef,
  LedgerThirdPartyPage,
  LedgerThirdPartyRole
} from "@hotelos/shared";

const enc = encodeURIComponent;

/** Base path of the sixteen routes (organisation-level: the sociedad, never a property). */
export const LEDGER_IMPORTS_PATH = "/accounting/ledger-imports";

/** File name of the canonical template per lot kind (the API names it in Content-Disposition; this is the fallback). */
export const LEDGER_IMPORT_TEMPLATE_FILE_NAMES: Readonly<Record<LedgerImportKind, string>> = Object.freeze({
  plan: "plantilla-sage200-plan.csv",
  fiscal_years: "plantilla-sage200-ejercicios.csv",
  journal: "plantilla-sage200-diario.csv",
  vat_books: "plantilla-sage200-libros-iva.csv",
  third_parties: "plantilla-sage200-terceros.csv",
  balances: "plantilla-sage200-saldos.csv"
});

/** Fallback name of the reconciliation CSV. */
export function reconciliationCsvFileName(reconciliationId: string): string {
  return `reconciliacion-sage200-${reconciliationId}.csv`;
}

// ---------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------

/** Parses, maps and validates the file without writing anything: unmapped accounts with their proposal, analytics, native documents excluded, duplicates, overlaps, totals per month and centre, `canPost` and blockers. */
export function previewLedgerImport(body: LedgerImportPreviewBody): Promise<LedgerImportPreview> {
  return apiRequest<LedgerImportPreview>(`${LEDGER_IMPORTS_PATH}/preview`, { method: "POST", body });
}

/** Creates the lot and posts it in the same transaction (`post` true by default; false leaves a `draft`). 409 LEDGER_IMPORT_DUPLICATE · 409 LEDGER_IMPORT_OVERLAP without `replace` · 400 LEDGER_IMPORT_ACCOUNT_UNMAPPED. */
export function createLedgerImport(body: LedgerImportCreateBody): Promise<LedgerImportCreateResult> {
  return apiRequest<LedgerImportCreateResult>(LEDGER_IMPORTS_PATH, { method: "POST", body });
}

/** Lots of the organisation, newest first (no entries); `limit` 1..200 (50 by default). */
export function listLedgerImports(query: LedgerImportListQuery = {}): Promise<LedgerImportRecord[]> {
  return apiRequest<LedgerImportRecord[]>(LEDGER_IMPORTS_PATH, { query: compactQuery({ kind: query.kind, status: query.status, from: query.from, to: query.to, limit: query.limit }) });
}

/** The lot with a page of its entries (ordered by date and Sage number) and the mapping applied (opaque 404 outside the organisation). */
export function getLedgerImport(importId: string): Promise<LedgerImportDetail> {
  return apiRequest<LedgerImportDetail>(`${LEDGER_IMPORTS_PATH}/${enc(importId)}`);
}

/** Posts a `draft` lot (`replace` reverses the overlapping lots first). 409 LEDGER_IMPORT_ALREADY_POSTED · 409 LEDGER_IMPORT_REVERSED. */
export function postLedgerImport(importId: string, body: LedgerImportPostBody = {}): Promise<LedgerImportCreateResult> {
  return apiRequest<LedgerImportCreateResult>(`${LEDGER_IMPORTS_PATH}/${enc(importId)}/post`, { method: "POST", body });
}

/** Reverses every journal entry of a `posted` lot and deletes its imported VAT book rows (idempotent). Needs accounting.journal.post AND ai.high_risk.confirm; `reason` 3..500. */
export function reverseLedgerImport(importId: string, body: LedgerImportReverseBody): Promise<LedgerImportRecord> {
  return apiRequest<LedgerImportRecord>(`${LEDGER_IMPORTS_PATH}/${enc(importId)}/reverse`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Mapas
// ---------------------------------------------------------------------------

/** Persistent Sage → PGC account map of the organisation. */
export function getAccountMap(): Promise<LedgerAccountMapResponse> {
  return apiRequest<LedgerAccountMapResponse>(`${LEDGER_IMPORTS_PATH}/account-map`);
}

/** Replaces the account map (validates every `accountCode`; `create` rows create the subaccount through the chart service). accounting.configure. */
export function putAccountMap(body: LedgerAccountMapPutBody): Promise<LedgerAccountMapResponse> {
  return apiRequest<LedgerAccountMapResponse>(`${LEDGER_IMPORTS_PATH}/account-map`, { method: "PUT", body });
}

/** Persistent analytics map (dimension of the centre, of the cost centre, unassigned policy and the code → centre rows). */
export function getAnalyticsMap(): Promise<LedgerAnalyticsMapResponse> {
  return apiRequest<LedgerAnalyticsMapResponse>(`${LEDGER_IMPORTS_PATH}/analytics-map`);
}

/** Replaces the analytics map (`propertyId` of the organisation only). accounting.configure. */
export function putAnalyticsMap(body: LedgerAnalyticsMapPutBody): Promise<LedgerAnalyticsMapResponse> {
  return apiRequest<LedgerAnalyticsMapResponse>(`${LEDGER_IMPORTS_PATH}/analytics-map`, { method: "PUT", body });
}

// ---------------------------------------------------------------------------
// Reconciliación
// ---------------------------------------------------------------------------

/** Compares the Sage trial balance of the range (base64 bytes) with the ledger, by destination account and period; persists the report. */
export function reconcileLedger(body: LedgerReconciliationBody): Promise<LedgerReconciliationDto> {
  return apiRequest<LedgerReconciliationDto>(`${LEDGER_IMPORTS_PATH}/reconciliation`, { method: "POST", body });
}

/** Reconciliations of the organisation, newest first. */
export function listReconciliations(query: LedgerReconciliationListQuery = {}): Promise<LedgerReconciliationDto[]> {
  return apiRequest<LedgerReconciliationDto[]>(`${LEDGER_IMPORTS_PATH}/reconciliation`, { query: compactQuery({ from: query.from, to: query.to, propertyId: query.propertyId, limit: query.limit }) });
}

/** One reconciliation with its rows (opaque 404 outside the organisation). */
export function getReconciliation(reconciliationId: string): Promise<LedgerReconciliationDto> {
  return apiRequest<LedgerReconciliationDto>(`${LEDGER_IMPORTS_PATH}/reconciliation/${enc(reconciliationId)}`);
}

/** CSV of a reconciliation (BOM, «;», CRLF) named by the API. */
export async function downloadReconciliationCsv(reconciliationId: string): Promise<NamedDownload> {
  const response = await apiRequestBlob(`${LEDGER_IMPORTS_PATH}/reconciliation/${enc(reconciliationId)}/csv`);
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, reconciliationCsvFileName(reconciliationId)), contentType: response.contentType };
}

// ---------------------------------------------------------------------------
// Terceros importados (FIX-1 · F11)
// ---------------------------------------------------------------------------

/** Read-only directory of the imported third parties: keyset page (role, Sage code) with `total` and `nextCursor`; `q` over code / NIF / Sage account / name, `role` customer | supplier; `lote` per row; `name` null for personal accounts (465 / 460 / 555) and masked employees. accounting.read. */
export function listLedgerThirdParties(query: LedgerThirdPartyListQuery = {}): Promise<LedgerThirdPartyPage> {
  return apiRequest<LedgerThirdPartyPage>(`${LEDGER_IMPORTS_PATH}/third-parties`, { query: compactQuery({ q: query.q, role: query.role, limit: query.limit, cursor: query.cursor }) });
}

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

/** Canonical CSV template of a lot kind (BOM, «;», CRLF, header + example rows) named by the API. */
export async function downloadLedgerImportTemplate(kind: LedgerImportKind): Promise<NamedDownload> {
  const response = await apiRequestBlob(`${LEDGER_IMPORTS_PATH}/template`, { query: { kind, format: "csv" } });
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, LEDGER_IMPORT_TEMPLATE_FILE_NAMES[kind]), contentType: response.contentType };
}

// ---------------------------------------------------------------------------
// Errors (details.code → Spanish; mirror of LEDGER_IMPORT_ERROR_LABELS_ES)
// ---------------------------------------------------------------------------

export const LEDGER_IMPORT_ERROR_MESSAGES: Readonly<Record<LedgerImportErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: "La petición no es válida.",
  LEDGER_IMPORT_INVALID: "El fichero tiene errores: revisa las líneas indicadas.",
  LEDGER_IMPORT_FORMAT_UNKNOWN: "No se reconoce el formato del fichero: indícalo o revisa la cabecera.",
  LEDGER_IMPORT_XML_UNSUPPORTED: "El XML «Datos contables» de Sage 200 aún no se puede importar: exporta a Excel o CSV.",
  LEDGER_IMPORT_KIND_MISMATCH: "El contenido del fichero no corresponde al tipo de lote elegido.",
  LEDGER_IMPORT_EMPTY: "El fichero no contiene filas de datos.",
  LEDGER_IMPORT_TOO_LARGE: "El fichero supera el tamaño admitido (20 MB): trocéalo por meses o impórtalo con la herramienta de línea de comandos.",
  LEDGER_IMPORT_TOO_MANY_ROWS: "El fichero tiene demasiadas filas: trocéalo por meses.",
  LEDGER_IMPORT_TOO_MANY_ENTRIES: "El lote tiene demasiados asientos: trocéalo por meses.",
  LEDGER_IMPORT_COMPANY_MISMATCH: "La empresa del fichero no es la sociedad de esta organización.",
  LEDGER_IMPORT_ACCOUNT_UNMAPPED: "Hay cuentas de Sage sin mapear: complétalas en el paso «Cuentas» antes de contabilizar.",
  LEDGER_IMPORT_ACCOUNT_CODE_INVALID: "La cuenta destino no existe en el plan o no admite apuntes.",
  LEDGER_IMPORT_ANALYTICS_UNMAPPED: "Hay códigos analíticos de Sage sin centro asignado: complétalos en el paso «Analítica».",
  LEDGER_IMPORT_CENTRE_REQUIRED: "Hay asientos con gastos o ingresos sin centro de trabajo: asigna un centro o cambia la política de apuntes sin analítica.",
  LEDGER_IMPORT_UNBALANCED: "Hay asientos de Sage descuadrados: revisa la exportación.",
  LEDGER_IMPORT_YEAR_CODE_INVALID: "El código del ejercicio debe ser el año natural (por ejemplo 2026).",
  LEDGER_IMPORT_MAP_INVALID: "El mapa enviado no es válido: revisa las filas indicadas.",
  LEDGER_IMPORT_DUPLICATE: "Este fichero ya se importó: revierte el lote anterior o activa «Sustituir los lotes anteriores».",
  LEDGER_IMPORT_OVERLAP: "Otros lotes ya cubren asientos de este fichero: activa «Sustituir los lotes anteriores» (reverso + lote nuevo).",
  LEDGER_IMPORT_ENTRY_EXISTS: "Ya existe un asiento importado con esa clave de Sage.",
  LEDGER_IMPORT_ALREADY_POSTED: "El lote ya está contabilizado.",
  LEDGER_IMPORT_REVERSED: "El lote está revertido: crea uno nuevo.",
  LEDGER_IMPORT_NOT_POSTED: "El lote no está contabilizado: no hay nada que revertir.",
  LEDGER_IMPORT_VAT_SETTINGS_MISSING: "Falta la configuración de IVA de la organización (periodicidad y régimen): configúrala en Ajustes contables antes de importar libros.",
  LEDGER_IMPORT_NOT_FOUND: "Lote de importación no encontrado.",
  LEDGER_RECONCILIATION_NOT_FOUND: "Reconciliación no encontrada.",
  FISCAL_YEAR_CLOSED_FROM_IMPORT: "El ejercicio se cerró con el cierre importado de Sage 200: para reabrirlo, revierte ese lote.",
  ACCOUNT_NOT_FOUND: "La cuenta no existe en el plan.",
  ACCOUNT_NOT_POSTABLE: "La cuenta no admite apuntes (es una cabecera).",
  WORK_CENTER_REQUIRED: "Las líneas de gasto e ingreso exigen un centro de trabajo.",
  PROPERTY_NOT_FOUND: "Centro de trabajo no encontrado.",
  FISCAL_PERIOD_CLOSED: "El periodo contable está cerrado.",
  FISCAL_YEAR_CLOSED: "El ejercicio está cerrado: no se puede contabilizar ni revertir en él.",
  JOURNAL_UNBALANCED: "El asiento no cuadra (debe ≠ haber)."
});

const DEFAULT_IMPORT_ERROR = "No se pudo completar la importación desde Sage 200.";
/** Accounts / codes named in a message before «…»; the rest is counted. */
const LISTED_MAX = 6;

function isImportErrorCode(code: string | null): code is LedgerImportErrorCode {
  return code !== null && Object.prototype.hasOwnProperty.call(LEDGER_IMPORT_ERROR_MESSAGES, code);
}

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detailNumber(details: Record<string, unknown> | null, key: string): number | null {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function detailStrings(details: Record<string, unknown> | null, key: string): string[] {
  const value = details?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

function detailCount(details: Record<string, unknown> | null, key: string): number | null {
  const value = details?.[key];
  return Array.isArray(value) ? value.length : detailNumber(details, key);
}

/** «4770021, 6230002 y 3 más» (never more than LISTED_MAX names). */
function listed(values: readonly string[]): string {
  if (values.length === 0) return "";
  const shown = values.slice(0, LISTED_MAX);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} y ${plural(rest, "más", "más")}` : shown.join(", ");
}

/**
 * Spanish message of an import error: the sentence of `details.code` plus the
 * datum the code carries — the duplicate lot (file name, date), the number of
 * unmapped accounts (with the first ones named), the overlapping lots, the
 * analytics codes, the entries without centre or unbalanced, the size limits,
 * the first invalid line — and the 413 of the body limit as the «20 MB»
 * sentence. Anything else falls back to finance-contracts (API message, then
 * `fallback`).
 */
export function ledgerImportErrorMessage(error: unknown, fallback: string = DEFAULT_IMPORT_ERROR): string {
  if (financeErrorStatus(error) === 413) return LEDGER_IMPORT_ERROR_MESSAGES.LEDGER_IMPORT_TOO_LARGE;
  const code = financeErrorCode(error);
  const details = financeErrorDetails(error);
  const base = isImportErrorCode(code) ? LEDGER_IMPORT_ERROR_MESSAGES[code] : financeErrorMessage(error, fallback);
  switch (code) {
    case "LEDGER_IMPORT_DUPLICATE": {
      const lot = detailString(details, "fileName") ?? detailString(details, "importId");
      const when = detailString(details, "createdAt");
      const whenLabel = when ? date(when, "medium") : null;
      const suffix = lot ? ` (lote ${lot}${whenLabel && whenLabel !== "—" ? `, ${whenLabel}` : ""})` : "";
      return `Este fichero ya se importó${suffix}. Revierte el lote anterior o activa «Sustituir los lotes anteriores».`;
    }
    case "LEDGER_IMPORT_ACCOUNT_UNMAPPED": {
      const accounts = detailStrings(details, "accounts");
      const count = accounts.length > 0 ? accounts.length : detailCount(details, "accounts");
      if (count === null || count === 0) return base;
      const names = accounts.length > 0 ? ` (${listed(accounts)})` : "";
      return `Hay ${plural(count, "cuenta de Sage sin mapear", "cuentas de Sage sin mapear")}${names}: complétalas en el paso «Cuentas» antes de contabilizar.`;
    }
    case "LEDGER_IMPORT_OVERLAP": {
      const count = detailCount(details, "overlaps");
      return count !== null && count > 0 ? `${plural(count, "lote anterior ya cubre", "lotes anteriores ya cubren")} asientos de este fichero: activa «Sustituir los lotes anteriores» (reverso + lote nuevo).` : base;
    }
    case "LEDGER_IMPORT_ANALYTICS_UNMAPPED": {
      const codes = detailStrings(details, "codes");
      const count = codes.length > 0 ? codes.length : detailCount(details, "codes");
      if (count === null || count === 0) return base;
      const names = codes.length > 0 ? ` (${listed(codes)})` : "";
      return `Hay ${plural(count, "código analítico de Sage sin centro asignado", "códigos analíticos de Sage sin centro asignado")}${names}: complétalos en el paso «Analítica».`;
    }
    case "LEDGER_IMPORT_CENTRE_REQUIRED": {
      const count = detailCount(details, "entries");
      return count !== null && count > 0 ? `Hay ${plural(count, "asiento con gastos o ingresos sin centro de trabajo", "asientos con gastos o ingresos sin centro de trabajo")}: asigna un centro o cambia la política de apuntes sin analítica.` : base;
    }
    case "LEDGER_IMPORT_UNBALANCED": {
      const count = detailCount(details, "entries");
      return count !== null && count > 0 ? `Hay ${plural(count, "asiento de Sage descuadrado", "asientos de Sage descuadrados")}: revisa la exportación.` : base;
    }
    case "LEDGER_IMPORT_INVALID": {
      const errors = details?.errors;
      if (!Array.isArray(errors) || errors.length === 0) return base;
      const first = errors[0] as { line?: unknown; message?: unknown };
      const line = typeof first.line === "number" ? `línea ${number(first.line)}: ` : "";
      const message = typeof first.message === "string" && first.message.trim() ? first.message.trim() : null;
      const rest = errors.length > 1 ? ` (+${number(errors.length - 1)})` : "";
      return message ? `El fichero tiene errores — ${line}${message}${rest}.` : `El fichero tiene ${plural(errors.length, "error", "errores")}: revisa las líneas indicadas.`;
    }
    case "LEDGER_IMPORT_XML_UNSUPPORTED": {
      const blocks = detailStrings(details, "blocks");
      return blocks.length > 0 ? `${base} Bloques encontrados: ${listed(blocks)}.` : base;
    }
    case "LEDGER_IMPORT_TOO_MANY_ROWS": {
      const rows = detailNumber(details, "rows");
      const max = detailNumber(details, "max");
      return rows !== null && max !== null ? `El fichero tiene ${number(rows)} filas de datos y el máximo es ${number(max)}: trocéalo por meses.` : base;
    }
    case "LEDGER_IMPORT_TOO_MANY_ENTRIES": {
      const entries = detailNumber(details, "entries");
      const max = detailNumber(details, "max");
      return entries !== null && max !== null ? `El lote tiene ${number(entries)} asientos y el máximo por lote es ${number(max)}: trocéalo por meses.` : base;
    }
    case "LEDGER_IMPORT_COMPANY_MISMATCH": {
      const fileCompany = detailString(details, "fileCompany");
      const entity = detailString(details, "entity");
      return fileCompany && entity ? `La empresa del fichero (${fileCompany}) no es la sociedad de esta organización (${entity}).` : base;
    }
    case "LEDGER_IMPORT_ACCOUNT_CODE_INVALID": {
      const accountCode = detailString(details, "accountCode");
      return accountCode ? `La cuenta destino ${accountCode} no existe en el plan o no admite apuntes.` : base;
    }
    case "LEDGER_IMPORT_YEAR_CODE_INVALID": {
      const yearCode = detailString(details, "code");
      return yearCode ? `El código del ejercicio «${yearCode}» no es un año natural (por ejemplo 2026).` : base;
    }
    default:
      return base;
  }
}
