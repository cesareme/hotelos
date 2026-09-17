// Finanzas › Contabilidad › Importar desde Sage 200 (Tanda 7c · L4) — pure
// helpers of Sage200ImportScreen.tsx: the six lot kinds with what to export
// in Sage for each one (design §2.2), the five steps of the wizard and which
// of them a kind uses, the base64 of the picked file (the browser never reads
// it as text: latin1 and binary XLSX / ZIP must survive until the API decides
// the encoding), the format inferred from the name, the Spanish vocabularies
// of the wire contract (packages/shared/src/ledger-import-types.ts: entry
// statuses, lot statuses, account map actions, analytics dimensions, USALI
// departments and cost centres, reconciliation statuses and classifications),
// the blockers of «Revisión», the rows of the month × centre tables, the
// per-entry line of «Resultado» («2026/110 · RA · 03/09/2026 · Sage 2026/1501
// · 302,50 €»), the CSV reports (BOM + CRLF, cells neutralised against
// spreadsheet formulas) and the «Autor» of a lot. No React, no network, no
// import.meta: screens/accounting/__tests__/sage200-import-helpers.test.mts
// runs it under node --test.
//
// The vocabularies are redeclared here on purpose (typed against the shared
// contract, so a drift fails the typecheck): under `node --import tsx` the
// `.js` stubs of @hotelos/shared win over the sources, so a runtime import
// from the package would come back undefined in the tests.

import type {
  LedgerAccountMapAction,
  LedgerAccountMapDto,
  LedgerAnalyticsDimension,
  LedgerImportEntryDto,
  LedgerImportEntryKind,
  LedgerImportEntryStatus,
  LedgerImportFormat,
  LedgerImportKind,
  LedgerImportPreview,
  LedgerImportRecord,
  LedgerImportStatusCode,
  LedgerReconciliationClassification,
  LedgerReconciliationDto,
  LedgerReconciliationRow,
  LedgerReconciliationStatus,
  LedgerUnassignedPolicy,
  LedgerUsaliCostCentreCode,
  UsaliDepartmentKey
} from "@hotelos/shared";
import type { CocoaSelectOption, CocoaTone } from "../../components/cocoa";
import { EMPTY, date, money, number, plural } from "../../lib/format";
import { actorLabel, type ActorSession } from "./actor-label";
import { BRAND } from "../../config/brand";

// ---------------------------------------------------------------------------
// Views of the screen (Importar · Reconciliación · Lotes)
// ---------------------------------------------------------------------------

export type ImportView = "importar" | "reconciliacion" | "lotes";

export const IMPORT_VIEWS: readonly { value: ImportView; label: string }[] = [
  { value: "importar", label: "Importar" },
  { value: "reconciliacion", label: "Reconciliación" },
  { value: "lotes", label: "Lotes" }
];

export function isImportView(value: string): value is ImportView {
  return IMPORT_VIEWS.some((view) => view.value === value);
}

// ---------------------------------------------------------------------------
// Lot kinds (mirror of LEDGER_IMPORT_KINDS / _LABELS_ES) with what to export in Sage (§2.2)
// ---------------------------------------------------------------------------

export type ImportKindOption = {
  value: LedgerImportKind;
  label: string;
  /** What the lot writes in ehotelOS. */
  description: string;
  /** Which listing to export in Sage 200 and how (design §2.2). */
  sageExport: string;
};

/** The six lot kinds in the recommended loading order (plan → ejercicios → diario → IVA → terceros → saldos). */
export const IMPORT_KIND_OPTIONS: readonly ImportKindOption[] = [
  {
    value: "plan",
    label: "Plan de cuentas",
    description: "Cuentas y subcuentas de Sage con su título y el NIF del tercero: alimenta el mapa de cuentas y da de alta las subcuentas que falten (nunca renombra ni borra).",
    sageExport: "En Sage 200: Plan de cuentas › Gestor de Exportación a Excel (cuenta, título, NIF, longitud). El XML «Datos contables» todavía no se admite: exporta a Excel o CSV."
  },
  {
    value: "fiscal_years",
    label: "Ejercicios y apertura",
    description: "Ejercicios con sus periodos mensuales y el asiento de apertura (periodo «Apertura», asiento nº 1). Exige el plan de cuentas.",
    sageExport: "En Sage 200: Diario del periodo «Apertura» con «Enviar a Excel», o Sumas y saldos con «Comparativo periodo acumulado» (saldo de apertura por cuenta)."
  },
  {
    value: "journal",
    label: "Diario",
    description: "Asientos completos de un rango (apuntes, analítica y bloque de factura e IVA): un asiento por asiento Sage y centro, con el número de Sage como referencia. Un lote por mes o trimestre.",
    sageExport: "En Sage 200: Diario del mes con «Enviar a Excel» y desglose analítico, o el CSV de asientos de 60 columnas (formato de importación) generado desde SQL."
  },
  {
    value: "vat_books",
    label: "Libros de IVA",
    description: "Libro de facturas expedidas y recibidas del periodo de liquidación: filas de libros que alimentan el 303, el 347 y el 390.",
    sageExport: "En Sage 200: Libro Registro de IVA › «Enviar a Excel / Formato Libros AEAT» (hojas EXPEDIDAS_INGRESOS y RECIBIDAS_GASTOS)."
  },
  {
    value: "third_parties",
    label: "Clientes y proveedores",
    description: "Terceros con código, cuenta contable, NIF, razón social y país: alimentan la agrupación de terceros en 4300 / 400 / 410 y el modelo 347.",
    sageExport: "En Sage 200: Clientes y Proveedores › Gestor de Exportación a Excel. El XML «Datos contables» todavía no se admite: exporta a Excel o CSV."
  },
  {
    value: "balances",
    label: "Sumas y saldos por periodo",
    description: "Saldos de apertura y Debe / Haber por cuenta y periodo (nivel 0) de ejercicios sin diario: se contabilizan como asientos resumen por periodo y centro más la apertura.",
    sageExport: "En Sage 200: Sumas y saldos trimestral, Nivel 0, «Debe/Haber/Saldo», con «Comparativo periodo acumulado» y «Hoja adicional canales/delegaciones»; por mes, el Informe de acumulados por periodos del plan de cuentas."
  }
];

export const IMPORT_KIND_LABELS: Readonly<Record<LedgerImportKind, string>> = Object.freeze(Object.fromEntries(IMPORT_KIND_OPTIONS.map((option) => [option.value, option.label])) as Record<LedgerImportKind, string>);

export function isImportKind(value: string): value is LedgerImportKind {
  return IMPORT_KIND_OPTIONS.some((option) => option.value === value);
}

export function importKindOptions(): CocoaSelectOption[] {
  return IMPORT_KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
}

export function importKindLabel(kind: LedgerImportKind | string | null | undefined): string {
  if (!kind) return EMPTY;
  return (IMPORT_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/** What to export in Sage for the kind (the note of step 1). */
export function importKindHint(kind: LedgerImportKind): string {
  return IMPORT_KIND_OPTIONS.find((option) => option.value === kind)?.sageExport ?? "";
}

export function importKindDescription(kind: LedgerImportKind): string {
  return IMPORT_KIND_OPTIONS.find((option) => option.value === kind)?.description ?? "";
}

/** Kinds whose rows carry analytics (centre / cost centre): journal, fiscal_years (opening by centre) and balances (sheet per delegation). */
export function usesAnalytics(kind: LedgerImportKind): boolean {
  return kind === "journal" || kind === "fiscal_years" || kind === "balances";
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

export type ImportStepKey = "file" | "accounts" | "analytics" | "review" | "result";

export type ImportStep = { key: ImportStepKey; label: string; description: string };

/** The five steps of the wizard, in order (design §7.4). */
export const IMPORT_STEPS: readonly ImportStep[] = [
  { key: "file", label: "Fichero", description: "Elige el tipo de lote y el fichero exportado de Sage 200 (Excel, CSV o el canónico; el XML «Datos contables» todavía no se admite); el análisis es automático." },
  { key: "accounts", label: "Cuentas", description: "Resuelve cada cuenta de Sage sin mapear: cuenta existente, subcuenta nueva, agrupar el tercero o bloquear; guarda el mapa para los lotes siguientes." },
  { key: "analytics", label: "Analítica", description: "Elige qué dimensión de Sage identifica el hotel y cuál el departamento USALI, asigna cada código a un centro y decide qué hacer con los apuntes sin analítica." },
  { key: "review", label: "Revisión", description: "Comprueba asientos, apuntes, Debe y Haber por mes y centro, los documentos propios excluidos, los ya importados y los avisos antes de contabilizar." },
  { key: "result", label: "Resultado", description: `Asientos creados con su número de ${BRAND.name} y de Sage, omitidos, errores, la reconciliación si adjuntaste el balance e informe descargable.` }
];

/**
 * Steps a kind walks: plan, third_parties and vat_books carry no analytics;
 * balances skips «Cuentas» when the preview leaves nothing unmapped (its
 * accounts resolve through the saved map). `unmappedAccounts` is the count of
 * the current preview (0 before any analysis).
 */
export function stepsForKind(kind: LedgerImportKind, unmappedAccounts = 0): ImportStep[] {
  return IMPORT_STEPS.filter((step) => {
    if (step.key === "analytics") return usesAnalytics(kind);
    if (step.key === "accounts" && kind === "balances") return unmappedAccounts > 0;
    return true;
  });
}

export function stepIndexOf(steps: readonly ImportStep[], key: ImportStepKey): number {
  return Math.max(0, steps.findIndex((step) => step.key === key));
}

/**
 * Step that follows `key` in the kind's path. When the re-analysis dropped `key` from the path
 * (balances whose accounts are now all mapped lose «Cuentas»), the answer is the first step of
 * the path that comes later in IMPORT_STEPS, never «Fichero» again.
 */
export function stepAfter(path: readonly ImportStep[], key: ImportStepKey): ImportStepKey {
  const at = path.findIndex((step) => step.key === key);
  if (at >= 0) return path[at + 1]?.key ?? "review";
  const order = IMPORT_STEPS.findIndex((step) => step.key === key);
  return path.find((step) => IMPORT_STEPS.findIndex((candidate) => candidate.key === step.key) > order)?.key ?? "review";
}

/** Tone of the step badge: done → success, current → accent, pending → neutral. */
export function stepTone(index: number, current: number): CocoaTone {
  return index < current ? "success" : index === current ? "accent" : "neutral";
}

/** «hecho» · «actual» · «pendiente». */
export function stepStateLabel(index: number, current: number): string {
  return index < current ? "hecho" : index === current ? "actual" : "pendiente";
}

/** «Paso 2 de 5 · Cuentas». */
export function stepSummary(steps: readonly ImportStep[], current: number): string {
  const step = steps[current] ?? steps[0];
  return `Paso ${number(current + 1)} de ${number(steps.length)} · ${step?.label ?? ""}`;
}

/** «2 · Cuentas» (the section title of a step, numbered by its position in the kind's path). */
export function stepTitle(steps: readonly ImportStep[], key: ImportStepKey): string {
  const index = steps.findIndex((step) => step.key === key);
  const step = steps[index] ?? IMPORT_STEPS.find((candidate) => candidate.key === key);
  return `${number((index < 0 ? 0 : index) + 1)} · ${step?.label ?? ""}`;
}

// ---------------------------------------------------------------------------
// File (bytes → base64, format by name)
// ---------------------------------------------------------------------------

/** Upper bound of a picked file, in bytes (LEDGER_IMPORT_MAX_BYTES = 20 MiB): the API refuses more; bigger files go through the CLI. */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Upper bound of data rows (LEDGER_IMPORT_MAX_ROWS). */
export const IMPORT_MAX_ROWS = 250_000;
/** Upper bound of entries per lot (LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH). */
export const IMPORT_MAX_ENTRIES = 20_000;
/** Extensions the picker accepts (Excel, CSV / texto, JSON canónico). The XML «Datos contables» (and its ZIP) is not offered: the API still answers LEDGER_IMPORT_XML_UNSUPPORTED (design §10.3). */
export const IMPORT_ACCEPT = ".xlsx,.csv,.txt,.json";
/** Chunk of bytes turned into a binary string at once (btoa over 20 MB in one string would blow the argument list). */
const BASE64_CHUNK = 32 * 1024;

/** Standard base64 of the bytes of a file (every byte 0x00-0xFF survives; the API decodes and decides the encoding). */
export function base64OfArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

/**
 * Format inferred from the extension, or null when only the content decides:
 * `.xlsx` / `.xlsm` → sage_excel · `.xml` / `.zip` → sage_xml · `.json` →
 * canonical_json · `.csv` / `.txt` / anything else → null (a CSV is the IME
 * layout of 60 columns, an Excel listing saved as CSV or the canonical one:
 * the API tells them apart by the header, design §4.3). The API still checks
 * the signature.
 */
export function detectFormatFromName(fileName: string | null | undefined): LedgerImportFormat | null {
  const name = (fileName ?? "").trim().toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return "sage_excel";
  if (name.endsWith(".xml") || name.endsWith(".zip")) return "sage_xml";
  if (name.endsWith(".json")) return "canonical_json";
  return null;
}

export const IMPORT_FORMAT_LABELS: Readonly<Record<LedgerImportFormat, string>> = Object.freeze({
  sage_excel: "Excel o CSV de Sage 200",
  sage_ime_csv: "CSV de asientos de Sage 200 (60 columnas)",
  sage_xml: "XML «Datos contables» de Sage 200",
  canonical_csv: "CSV canónico",
  canonical_json: "JSON canónico"
});

/** Label of a format; «según la cabecera» while the API has not decided. */
export function formatLabel(format: LedgerImportFormat | string | null | undefined): string {
  if (!format) return "según la cabecera";
  return (IMPORT_FORMAT_LABELS as Record<string, string>)[format] ?? format;
}

/** «1,2 MB» · «512 KB» · «0 B» (binary units, one decimal from 1 MB). */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return EMPTY;
  if (bytes >= 1024 * 1024) return `${number(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
  if (bytes >= 1024) return `${number(Math.round(bytes / 1024))} KB`;
  return `${number(bytes)} B`;
}

// ---------------------------------------------------------------------------
// Account map (mirror of LEDGER_ACCOUNT_MAP_ACTIONS / _LABELS_ES, design §4.4)
// ---------------------------------------------------------------------------

export const ACCOUNT_ACTION_LABELS: Readonly<Record<LedgerAccountMapAction, string>> = Object.freeze({
  map: "Cuenta existente",
  map_by_rate: "Cuenta de IVA por tipo",
  create: "Crear subcuenta",
  collapse: "Agrupar tercero",
  block: "Bloquear"
});

/** The four actions a person chooses (map · create · collapse · block); `map_by_rate` only when the mapper proposed it for that account. */
export function accountActionOptions(includeByRate = false): CocoaSelectOption[] {
  const actions: LedgerAccountMapAction[] = includeByRate ? ["map", "map_by_rate", "create", "collapse", "block"] : ["map", "create", "collapse", "block"];
  return actions.map((action) => ({ value: action, label: ACCOUNT_ACTION_LABELS[action] }));
}

export function isAccountAction(value: string): value is LedgerAccountMapAction {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_ACTION_LABELS, value);
}

export function accountActionLabel(action: LedgerAccountMapAction | string | null | undefined): string {
  if (!action) return EMPTY;
  return (ACCOUNT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}

/** Mirror of ACCOUNT_CODE_PATTERN of the accounting engine (1-8 digits, optional `.ddd`). */
export const ACCOUNT_CODE_PATTERN = /^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/;

export function isValidAccountCode(code: string | null | undefined): boolean {
  return typeof code === "string" && ACCOUNT_CODE_PATTERN.test(code.trim());
}

/** A `create` in groups 6 / 7 needs a USALI department (the chart validates it). */
export function needsUsaliDepartment(dto: Pick<LedgerAccountMapDto, "action" | "accountCode">): boolean {
  return dto.action === "create" && /^[67]/.test(dto.accountCode ?? "");
}

/** «→ 477.21 · cuenta existente» · «crear 623.2» · «agrupar en 4300» · «472.<tipo> por tipo de IVA» · «bloquear» · «sin propuesta». */
export function suggestedAccountLabel(suggestion: Pick<LedgerAccountMapDto, "action" | "accountCode"> | null | undefined): string {
  if (!suggestion) return "sin propuesta: bloquear";
  switch (suggestion.action) {
    case "map":
      return suggestion.accountCode ? `→ ${suggestion.accountCode} · cuenta existente` : ACCOUNT_ACTION_LABELS.map;
    case "map_by_rate":
      return suggestion.accountCode ? `${suggestion.accountCode}.<tipo> por tipo de IVA` : ACCOUNT_ACTION_LABELS.map_by_rate;
    case "create":
      return suggestion.accountCode ? `crear ${suggestion.accountCode}` : ACCOUNT_ACTION_LABELS.create;
    case "collapse":
      return suggestion.accountCode ? `agrupar en ${suggestion.accountCode}` : ACCOUNT_ACTION_LABELS.collapse;
    default:
      return "bloquear";
  }
}

/** The row a person edits when the mapper proposed nothing: block, no destination. */
export function blockedAccountDto(sourceAccount: string, sourceName: string | null): LedgerAccountMapDto {
  return { sourceAccount, sourceName, action: "block", accountCode: null, carryCounterparty: false, suggested: false };
}

/** Origin badge of an account row: «sugerida» (the mapper), «manual» (edited here) or «guardada» (the persisted map). */
export type AccountRowOrigin = "sugerida" | "manual" | "guardada";

export const ACCOUNT_ORIGIN_LABELS: Readonly<Record<AccountRowOrigin, string>> = Object.freeze({ sugerida: "Sugerida", manual: "Manual", guardada: "Guardada" });

export function accountOriginTone(origin: AccountRowOrigin): CocoaTone {
  return origin === "manual" ? "accent" : origin === "sugerida" ? "info" : "neutral";
}

/** Why a row still blocks the lot: block action, missing or invalid destination, missing USALI in 6 / 7. */
export function accountRowIssue(dto: LedgerAccountMapDto): string | null {
  if (dto.action === "block") return "bloqueada: sus apuntes no se contabilizan";
  if (!dto.accountCode || !dto.accountCode.trim()) return "falta la cuenta destino";
  if (!isValidAccountCode(dto.accountCode)) return "cuenta destino con formato no admitido (hasta 8 dígitos y hasta 3 decimales)";
  if (needsUsaliDepartment(dto) && !dto.usaliDepartment) return "elige el departamento USALI de la subcuenta nueva";
  return null;
}

/** Spanish names of the USALI departments (UsaliDepartmentKey) for a `create` in groups 6 / 7. */
export const USALI_DEPARTMENT_LABELS: Readonly<Record<UsaliDepartmentKey, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operados",
  misc_income: "Otros ingresos",
  admin_general: "Administración y general",
  it: "Tecnología de la información",
  sales_marketing: "Ventas y marketing",
  pom: "Mantenimiento y operación de la propiedad",
  utilities: "Suministros",
  management_fees: "Honorarios de gestión",
  non_operating: "No operativo",
  below_ebitda: "Bajo el EBITDA"
});

export function usaliDepartmentOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Elegir departamento…" }, ...(Object.keys(USALI_DEPARTMENT_LABELS) as UsaliDepartmentKey[]).map((key) => ({ value: key, label: USALI_DEPARTMENT_LABELS[key] }))];
}

export function isUsaliDepartment(value: string): value is UsaliDepartmentKey {
  return Object.prototype.hasOwnProperty.call(USALI_DEPARTMENT_LABELS, value);
}

// ---------------------------------------------------------------------------
// Analytics map (mirror of LEDGER_ANALYTICS_DIMENSIONS, LEDGER_USALI_COST_CENTRE_CODES, LEDGER_UNASSIGNED_POLICIES)
// ---------------------------------------------------------------------------

export const ANALYTICS_DIMENSION_LABELS: Readonly<Record<LedgerAnalyticsDimension, string>> = Object.freeze({
  canal: "Canal",
  delegacion: "Delegación",
  departamento: "Departamento",
  seccion: "Sección",
  proyecto: "Proyecto"
});

export function analyticsDimensionOptions(): CocoaSelectOption[] {
  return (Object.keys(ANALYTICS_DIMENSION_LABELS) as LedgerAnalyticsDimension[]).map((dimension) => ({ value: dimension, label: ANALYTICS_DIMENSION_LABELS[dimension] }));
}

/** Options of the cost-centre dimension: the five plus «ninguna» (no USALI cost centre from Sage). */
export function costCentreDimensionOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Ninguna (sin centro de coste)" }, ...analyticsDimensionOptions()];
}

export function isAnalyticsDimension(value: string): value is LedgerAnalyticsDimension {
  return Object.prototype.hasOwnProperty.call(ANALYTICS_DIMENSION_LABELS, value);
}

export function analyticsDimensionLabel(dimension: LedgerAnalyticsDimension | string | null | undefined): string {
  if (!dimension) return EMPTY;
  return (ANALYTICS_DIMENSION_LABELS as Record<string, string>)[dimension] ?? dimension;
}

export const COST_CENTRE_LABELS: Readonly<Record<LedgerUsaliCostCentreCode, string>> = Object.freeze({
  ROOMS: "Habitaciones",
  FNB: "Alimentos y bebidas",
  POM: "Mantenimiento y operación",
  ADMIN_GENERAL: "Administración y general",
  SALES_MARKETING: "Ventas y marketing",
  OTHER_OPERATED: "Otros departamentos operados",
  IT: "Tecnología de la información"
});

export function costCentreOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Sin centro de coste" }, ...(Object.keys(COST_CENTRE_LABELS) as LedgerUsaliCostCentreCode[]).map((code) => ({ value: code, label: `${code} · ${COST_CENTRE_LABELS[code]}` }))];
}

export function costCentreLabel(code: string | null | undefined): string {
  if (!code) return EMPTY;
  const label = (COST_CENTRE_LABELS as Record<string, string>)[code];
  return label ? `${code} · ${label}` : code;
}

/** Options of the policy for 6 / 7 lines without analytics: block · office · one `property:<id>` per centre. */
export function unassignedPolicyOptions(centres: ReadonlyArray<{ id: string; label: string }>): CocoaSelectOption[] {
  return [
    { value: "block", label: "Bloquear el lote hasta asignar centro" },
    { value: "office", label: "Imputar a la oficina central" },
    ...centres.map((centre) => ({ value: `property:${centre.id}`, label: `Imputar a ${centre.label}` }))
  ];
}

export function isUnassignedPolicy(value: string): value is LedgerUnassignedPolicy {
  return value === "block" || value === "office" || (value.startsWith("property:") && value.length > "property:".length);
}

export function unassignedPolicyLabel(policy: LedgerUnassignedPolicy | string, centres: ReadonlyArray<{ id: string; label: string }> = []): string {
  if (policy === "block") return "Bloquear el lote hasta asignar centro";
  if (policy === "office") return "Imputar a la oficina central";
  const id = policy.startsWith("property:") ? policy.slice("property:".length) : policy;
  const centre = centres.find((candidate) => candidate.id === id);
  return centre ? `Imputar a ${centre.label}` : `Imputar al centro ${id}`;
}

/** Key of an analytics row (dimension + code) for the local edits map. */
export function analyticsRowKey(row: Pick<{ dimension: LedgerAnalyticsDimension; sourceCode: string }, "dimension" | "sourceCode">): string {
  return `${row.dimension}:${row.sourceCode}`;
}

// ---------------------------------------------------------------------------
// Entry, lot and reconciliation vocabularies
// ---------------------------------------------------------------------------

export const ENTRY_STATUS_LABELS: Readonly<Record<LedgerImportEntryStatus, string>> = Object.freeze({
  draft: "Previsualizado",
  posted: "Contabilizado",
  skipped_native: "Omitido: documento propio",
  skipped_existing: "Omitido: ya importado",
  unmapped: "Sin mapear",
  unbalanced: "Descuadrado",
  error: "Error"
});

export const ENTRY_STATUS_TONES: Readonly<Record<LedgerImportEntryStatus, CocoaTone>> = Object.freeze({
  draft: "neutral",
  posted: "success",
  skipped_native: "info",
  skipped_existing: "neutral",
  unmapped: "warning",
  unbalanced: "danger",
  error: "danger"
});

export function entryStatusLabel(status: LedgerImportEntryStatus | string | null | undefined): string {
  if (!status) return EMPTY;
  return (ENTRY_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function entryStatusTone(status: LedgerImportEntryStatus | string | null | undefined): CocoaTone {
  return (ENTRY_STATUS_TONES as Record<string, CocoaTone>)[status ?? ""] ?? "neutral";
}

export const ENTRY_KIND_LABELS: Readonly<Record<LedgerImportEntryKind, string>> = Object.freeze({
  normal: "Normal",
  opening: "Apertura",
  regularization: "Regularización",
  closing: "Cierre"
});

export function entryKindLabel(kind: LedgerImportEntryKind | string | null | undefined): string {
  if (!kind) return EMPTY;
  return (ENTRY_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export const IMPORT_STATUS_LABELS: Readonly<Record<LedgerImportStatusCode, string>> = Object.freeze({
  draft: "Borrador",
  posted: "Contabilizado",
  reversed: "Revertido"
});

export const IMPORT_STATUS_TONES: Readonly<Record<LedgerImportStatusCode, CocoaTone>> = Object.freeze({
  draft: "warning",
  posted: "success",
  reversed: "neutral"
});

export function importStatusLabel(status: LedgerImportStatusCode | string | null | undefined): string {
  if (!status) return EMPTY;
  return (IMPORT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function importStatusTone(status: LedgerImportStatusCode | string | null | undefined): CocoaTone {
  return (IMPORT_STATUS_TONES as Record<string, CocoaTone>)[status ?? ""] ?? "neutral";
}

/** A `draft` lot can be posted; a `posted` one can be reversed (the API is the judge; this only shapes the buttons). */
export function canPostImport(record: Pick<LedgerImportRecord, "status">): boolean {
  return record.status === "draft";
}

export function canReverseImport(record: Pick<LedgerImportRecord, "status">): boolean {
  return record.status === "posted";
}

export const RECON_STATUS_LABELS: Readonly<Record<LedgerReconciliationStatus, string>> = Object.freeze({
  ok: "Cuadra",
  differences: "Con diferencias",
  error: "Error"
});

export const RECON_STATUS_TONES: Readonly<Record<LedgerReconciliationStatus, CocoaTone>> = Object.freeze({
  ok: "success",
  differences: "warning",
  error: "danger"
});

export function reconciliationStatusLabel(status: LedgerReconciliationStatus | string | null | undefined): string {
  if (!status) return EMPTY;
  return (RECON_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function reconciliationStatusTone(status: LedgerReconciliationStatus | string | null | undefined): CocoaTone {
  return (RECON_STATUS_TONES as Record<string, CocoaTone>)[status ?? ""] ?? "neutral";
}

export const RECON_CLASSIFICATION_LABELS: Readonly<Record<LedgerReconciliationClassification, string>> = Object.freeze({
  amount_diff: "Importe distinto",
  native_only: `Solo en ${BRAND.name}`,
  missing_in_ledger: `Falta en ${BRAND.name}`,
  vat_diff: "Diferencia de IVA"
});

export function reconciliationClassificationLabel(classification: LedgerReconciliationClassification | string | null | undefined): string {
  if (!classification) return "Cuadra";
  return (RECON_CLASSIFICATION_LABELS as Record<string, string>)[classification] ?? classification;
}

/** Row wash of the per-account table: ok → none · amount_diff / missing_in_ledger / vat_diff → danger · native_only → warning. */
export function reconciliationRowTone(row: Pick<LedgerReconciliationRow, "ok" | "classification">): CocoaTone | undefined {
  if (row.ok || !row.classification) return undefined;
  return row.classification === "native_only" ? "warning" : "danger";
}

/** «12 cuentas cuadran · 2 con importe distinto · 1 solo en ehotelOS · 0 faltan en ehotelOS · 0 de IVA» for the section meta. */
export function reconciliationSummary(rows: readonly Pick<LedgerReconciliationRow, "ok" | "classification">[]): string {
  const ok = rows.filter((row) => row.ok || !row.classification).length;
  const count = (classification: LedgerReconciliationClassification) => rows.filter((row) => !row.ok && row.classification === classification).length;
  return [
    `${plural(ok, "cuenta cuadra", "cuentas cuadran")}`,
    `${number(count("amount_diff"))} con importe distinto`,
    `${number(count("native_only"))} solo en ${BRAND.name}`,
    `${number(count("missing_in_ledger"))} faltan en ${BRAND.name}`,
    `${number(count("vat_diff"))} de IVA`
  ].join(" · ");
}

export type Kpi = { key: string; label: string; value: string; tone?: CocoaTone; caption?: string };

/** The five KPIs of «Reconciliación»: comparadas · diferencias · solo ehotelOS · faltan · IVA. */
export function reconciliationKpis(recon: Pick<LedgerReconciliationDto, "accountsCompared" | "differenceCount" | "summary">): Kpi[] {
  return [
    { key: "compared", label: "Cuentas comparadas", value: number(recon.accountsCompared) },
    { key: "differences", label: "Diferencias", value: number(recon.differenceCount), tone: recon.differenceCount > 0 ? "danger" : "success", caption: recon.differenceCount > 0 ? "Fuera de tolerancia" : "Todo dentro de tolerancia" },
    { key: "nativeOnly", label: `Solo en ${BRAND.name}`, value: number(recon.summary.nativeOnly), tone: recon.summary.nativeOnly > 0 ? "warning" : undefined, caption: "Documentos propios" },
    { key: "missing", label: `Faltan en ${BRAND.name}`, value: number(recon.summary.missingInLedger), tone: recon.summary.missingInLedger > 0 ? "danger" : undefined },
    { key: "vat", label: "Diferencias de IVA", value: number(recon.summary.vatDiff), tone: recon.summary.vatDiff > 0 ? "danger" : undefined }
  ];
}

// ---------------------------------------------------------------------------
// Preview: KPIs, blockers, month × centre rows
// ---------------------------------------------------------------------------

/** The seven KPIs of «Revisión»: asientos · apuntes · Debe · Haber · excluidos nativos · ya existentes · avisos. */
export function previewKpis(preview: LedgerImportPreview): Kpi[] {
  const balanced = preview.totalDebit === preview.totalCredit;
  return [
    { key: "entries", label: "Asientos", value: number(preview.entryCount), tone: preview.entryCount > 0 ? "accent" : undefined },
    { key: "lines", label: "Apuntes", value: number(preview.lineCount) },
    { key: "debit", label: "Debe", value: money(preview.totalDebit), tone: balanced ? undefined : "danger" },
    { key: "credit", label: "Haber", value: money(preview.totalCredit), tone: balanced ? undefined : "danger", caption: balanced ? "Cuadra con el Debe" : "No cuadra con el Debe" },
    { key: "native", label: "Excluidos (propios)", value: number(preview.nativeSkipped.length), tone: preview.nativeSkipped.length > 0 ? "info" : undefined, caption: `Documentos emitidos por ${BRAND.name}` },
    { key: "existing", label: "Ya importados", value: number(preview.existing.length), caption: "Se omiten" },
    { key: "warnings", label: "Avisos", value: number(preview.warnings.length), tone: preview.warnings.length > 0 ? "warning" : undefined }
  ];
}

/**
 * Why «Contabilizar» is disabled, in Spanish (empty when the preview can
 * post). The API already names the blockers it found (`preview.blockers`);
 * the local reasons are added only for a condition the API did not report
 * under its own sentence, so no blocker is listed twice.
 */
export function previewBlockers(preview: LedgerImportPreview | null): string[] {
  if (!preview) return ["carga un fichero y analízalo antes de contabilizar"];
  const out: string[] = [];
  for (const blocker of preview.blockers) if (blocker.trim()) out.push(blocker.trim().replace(/\.$/, ""));
  const mentions = (needle: RegExp) => out.some((blocker) => needle.test(blocker));
  if (preview.unmappedAccounts.length > 0 && !mentions(/sin mapear|mapa de cuentas|cuentas? de Sage/i)) {
    out.push(`${plural(preview.unmappedAccounts.length, "cuenta de Sage sin mapear", "cuentas de Sage sin mapear")}: resuélvelas en «Cuentas»`);
  }
  if (preview.unmappedAnalytics.length > 0 && !mentions(/analític|centro asignado/i)) {
    out.push(`${plural(preview.unmappedAnalytics.length, "código analítico sin centro", "códigos analíticos sin centro")}: asígnalos en «Analítica»`);
  }
  if (preview.centreRequired.length > 0 && !mentions(/sin centro de trabajo|política/i)) {
    out.push(`${plural(preview.centreRequired.length, "asiento con gastos o ingresos sin centro", "asientos con gastos o ingresos sin centro")}: asigna un centro o cambia la política`);
  }
  if (preview.unbalanced.length > 0 && !mentions(/descuadr/i)) {
    out.push(`${plural(preview.unbalanced.length, "asiento descuadrado", "asientos descuadrados")}: revisa la exportación de Sage`);
  }
  if (preview.duplicateOf && !mentions(/ya se importó|duplicad/i)) {
    const lot = preview.duplicateOf.fileName ?? preview.duplicateOf.importId;
    out.push(`este fichero ya se importó (lote ${lot}, ${importStatusLabel(preview.duplicateOf.status).toLowerCase()}): revierte el anterior o activa «Sustituir los lotes anteriores»`);
  }
  if (preview.vatSettingsMissing && preview.kind === "vat_books" && !mentions(/IVA|vat_settings/i)) {
    out.push("falta la configuración de IVA de la organización (periodicidad y régimen): configúrala en Ajustes contables");
  }
  if (preview.entryCount === 0 && preview.rowCount > 0 && out.length === 0) out.push("no hay ningún asiento que contabilizar");
  if (preview.rowCount === 0 && out.length === 0) out.push("el fichero no tiene filas de datos");
  return out;
}

/** «septiembre de 2026» · «3.er trimestre de 2026» · «Ejercicio 2026» · «Apertura» (the period codes of §4.2). */
export function periodLabel(periodCode: string | null | undefined): string {
  if (!periodCode) return EMPTY;
  if (/^\d{4}-\d{2}$/.test(periodCode)) return date(`${periodCode}-01`, "monthYear");
  const quarter = /^(\d{4})-[Qq]([1-4])$/.exec(periodCode);
  if (quarter) return `${quarter[2]}.º trimestre de ${quarter[1]}`;
  if (/^\d{4}$/.test(periodCode)) return `Ejercicio ${periodCode}`;
  if (periodCode === "apertura") return "Apertura";
  return periodCode;
}

/** «septiembre de 2026» · «enero – julio de 2026» (range of month codes). */
export function periodRangeLabel(periodFrom: string | null | undefined, periodTo: string | null | undefined): string {
  if (!periodFrom && !periodTo) return EMPTY;
  if (!periodFrom || !periodTo || periodFrom === periodTo) return periodLabel(periodFrom ?? periodTo);
  return `${periodLabel(periodFrom)} – ${periodLabel(periodTo)}`;
}

/** First day of `periodFrom` and last day of `periodTo` ("YYYY-MM" codes) as ISO dates, for the reconciliation of the same range. */
export function periodRangeDates(periodFrom: string | null | undefined, periodTo: string | null | undefined): { from: string; to: string } | null {
  const first = /^(\d{4})-(\d{2})$/.exec(periodFrom ?? "");
  const last = /^(\d{4})-(\d{2})$/.exec(periodTo ?? periodFrom ?? "");
  if (!first || !last) return null;
  const lastDay = new Date(Date.UTC(Number(last[1]), Number(last[2]), 0)).getUTCDate();
  return { from: `${first[1]}-${first[2]}-01`, to: `${last[1]}-${last[2]}-${String(lastDay).padStart(2, "0")}` };
}

export type MonthRow = { key: string; label: string; entries: number; lines: number; debit: string; credit: string };

/** Rows of the «por mes» table: period label, entries, lines, Debe, Haber (MoneyString: the screen formats). */
export function formatByMonthRows(preview: Pick<LedgerImportPreview, "byMonth">): MonthRow[] {
  return preview.byMonth.map((row) => ({ key: row.periodCode, label: periodLabel(row.periodCode), entries: row.entries, lines: row.lines, debit: row.debit, credit: row.credit }));
}

export type PropertyRow = { key: string; propertyId: string | null; propertyCode: string; entries: number; debit: string; credit: string };

/** Rows of the «por centro» table («SOC» = nivel sociedad). */
export function formatByPropertyRows(preview: Pick<LedgerImportPreview, "byProperty">): PropertyRow[] {
  return preview.byProperty.map((row) => ({ key: row.propertyId ?? row.propertyCode, propertyId: row.propertyId, propertyCode: row.propertyCode, entries: row.entries, debit: row.debit, credit: row.credit }));
}

/** «Asiento 1501 (periodo 9)». */
export function sourceEntryLabel(row: { sourceEntryNumber: string; sourcePeriod: string }): string {
  return `Asiento ${row.sourceEntryNumber} (periodo ${row.sourcePeriod})`;
}

/** «Asiento 1501 (periodo 9) · FAC-2026-000012 · asiento propio invoice» (a native document excluded from the lot, §5.1). */
export function nativeSkippedLine(row: { sourceEntryNumber: string; sourcePeriod: string; series: string | null; number: string | null; invoiceNumber: string | null; sourceType: string }): string {
  const document = row.invoiceNumber ?? (row.series || row.number ? [row.series, row.number].filter(Boolean).join("-") : null);
  const parts = [sourceEntryLabel(row)];
  if (document) parts.push(document);
  parts.push(`asiento propio ${row.sourceType.replace(/_/g, " ")}`);
  return parts.join(" · ");
}

/** «Asiento 1501 (periodo 9) · ya importado como 2026/87». */
export function existingLine(row: { sourceEntryNumber: string; sourcePeriod: string; entryNumber: number | null; fiscalYearCode: string | null }): string {
  const target = row.entryNumber !== null ? `${row.fiscalYearCode ?? ""}${row.fiscalYearCode ? "/" : ""}${number(row.entryNumber)}` : null;
  return target ? `${sourceEntryLabel(row)} · ya importado como ${target}` : `${sourceEntryLabel(row)} · ya importado`;
}

/** «Asiento 1501 (periodo 9): cuentas 6280001, 6290001» (6 / 7 lines without centre). */
export function centreRequiredLine(row: { sourceEntryNumber: string; sourcePeriod: string; accounts: string[] }): string {
  return `${sourceEntryLabel(row)}: ${row.accounts.length === 1 ? "cuenta" : "cuentas"} ${row.accounts.join(", ")}`;
}

/** «Asiento 1501 (periodo 9): Debe 302,50 € · Haber 300,00 €». */
export function unbalancedLine(row: { sourceEntryNumber: string; sourcePeriod: string; debit: string; credit: string }): string {
  return `${sourceEntryLabel(row)}: Debe ${money(row.debit)} · Haber ${money(row.credit)}`;
}

/** «Asiento 1 (periodo 0) · Apertura» (opening / closing entries of Sage the user confirms). */
export function closingDetectedLine(row: { sourceEntryNumber: string; sourcePeriod: string; entryKind: LedgerImportEntryKind }): string {
  return `${sourceEntryLabel(row)} · ${entryKindLabel(row.entryKind)}`;
}

// ---------------------------------------------------------------------------
// Result: entry line, title, tone, report CSV
// ---------------------------------------------------------------------------

/** «2026/110 · RA · 03/09/2026 · Sage 2026/1501 · 302,50 €» (an entry created by the lot); without ehotelOS number when it was not posted. */
export function entryLine(entry: Pick<LedgerImportEntryDto, "fiscalYearCode" | "entryNumber" | "propertyCode" | "entryDate" | "sourceFiscalYear" | "sourceEntryNumber" | "debit">): string {
  const anfitorio = entry.entryNumber !== null ? `${entry.fiscalYearCode ?? entry.sourceFiscalYear}/${number(entry.entryNumber)}` : null;
  const parts = [anfitorio, entry.propertyCode, date(entry.entryDate), `Sage ${entry.sourceFiscalYear}/${entry.sourceEntryNumber}`, money(entry.debit)];
  return parts.filter((part): part is string => part !== null && part !== "").join(" · ");
}

export type ResultTone = "success" | "warning" | "danger" | "neutral";

/** Tone of the result callout: posted without skips → success; posted with skips / warnings or draft → warning; reversed → neutral. */
export function resultTone(record: Pick<LedgerImportRecord, "status" | "skippedCount" | "warningCount">): ResultTone {
  if (record.status === "reversed") return "neutral";
  if (record.status === "draft") return "warning";
  return record.skippedCount > 0 || record.warningCount > 0 ? "warning" : "success";
}

/** «Lote contabilizado: 38 asientos creados, 2 omitidos» · «Lote en borrador: …» · «Lote revertido …». */
/** What a lot creates: asientos (journal / fiscal_years / balances), cuentas nuevas (plan), terceros (third_parties), filas de libro (vat_books). */
export function entryNoun(kind: LedgerImportKind | string | null | undefined): { singular: string; plural: string } {
  switch (kind) {
    case "plan":
      return { singular: "cuenta nueva", plural: "cuentas nuevas" };
    case "third_parties":
      return { singular: "tercero", plural: "terceros" };
    case "vat_books":
      return { singular: "fila de libro", plural: "filas de libro" };
    default:
      return { singular: "asiento", plural: "asientos" };
  }
}

/** «38 asientos» · «12 cuentas nuevas» · «1 tercero» · «3 filas de libro». */
export function entryCountLabel(kind: LedgerImportKind | string | null | undefined, count: number): string {
  const noun = entryNoun(kind);
  return plural(count, noun.singular, noun.plural);
}

/** Primary of «Revisión»: «Contabilizar 38 asientos» for the kinds that post entries, «Importar 12 cuentas nuevas» / «Importar 3 filas de libro» for the rest. */
export function postActionLabel(kind: LedgerImportKind, count: number): string {
  const verb = kind === "journal" || kind === "fiscal_years" || kind === "balances" ? "Contabilizar" : "Importar";
  return `${verb} ${entryCountLabel(kind, count)}`;
}

export function resultTitle(record: Pick<LedgerImportRecord, "status" | "kind" | "entryCount" | "skippedCount">, created: number): string {
  const kindLabel = importKindLabel(record.kind).toLowerCase();
  const createdLabel = record.kind === "journal" || record.kind === "balances" || record.kind === "fiscal_years" ? plural(created, "asiento creado", "asientos creados") : plural(created, "fila creada", "filas creadas");
  const skipped = record.skippedCount > 0 ? `, ${plural(record.skippedCount, "omitido", "omitidos")}` : "";
  switch (record.status) {
    case "posted":
      return `Lote de ${kindLabel} contabilizado: ${createdLabel}${skipped}`;
    case "reversed":
      return `Lote de ${kindLabel} revertido`;
    default:
      return `Lote de ${kindLabel} en borrador: ${entryCountLabel(record.kind, record.entryCount)} ${record.entryCount === 1 ? (record.kind === "plan" || record.kind === "vat_books" ? "previsualizada" : "previsualizado") : record.kind === "plan" || record.kind === "vat_books" ? "previsualizadas" : "previsualizados"}${skipped}`;
  }
}

/** Header of the per-entry report CSV. */
export const IMPORT_REPORT_HEADER = ["empresa", "ejercicio_sage", "periodo_sage", "asiento_sage", "canal", "fecha", "centro", "ejercicio", "asiento", "tipo", "estado", "apuntes", "debe", "haber", "colision", "avisos"] as const;

/**
 * First characters Excel / LibreOffice read as a formula (`=`, `+`, `-`, `@`,
 * tab, CR), leading blanks included. A text cell that starts with one of them
 * (names and codes come from a third-party file) is prefixed with an
 * apostrophe and quoted, so the spreadsheet shows it as text and never
 * evaluates it (OWASP CSV injection). Numbers are never touched.
 */
const CSV_FORMULA_START = /^[\s ]*[=+\-@\t\r]/;

/** RFC 4180 cell for a «;» CSV: quoted (quotes doubled) when it carries «;», a quote or a line break; formula starters neutralised. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = CSV_FORMULA_START.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(text) || text !== value ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Report of a lot: BOM UTF-8, «;», CRLF, one line per entry (Sage key, date, centre, ehotelOS number, status, totals, collision, warnings). */
export function buildImportReportCsv(entries: readonly LedgerImportEntryDto[]): string {
  const lines: string[] = [IMPORT_REPORT_HEADER.join(";")];
  for (const entry of entries) {
    lines.push(
      [
        entry.sourceCompanyCode,
        entry.sourceFiscalYear,
        entry.sourcePeriod,
        entry.sourceEntryNumber,
        entry.sourceChannel,
        entry.entryDate,
        entry.propertyCode,
        entry.fiscalYearCode,
        entry.entryNumber,
        entryKindLabel(entry.entryKind),
        entryStatusLabel(entry.status),
        entry.lineCount,
        entry.debit,
        entry.credit,
        entry.sourceType && entry.sourceId ? `${entry.sourceType}/${entry.sourceId}` : null,
        entry.warnings.join(" | ")
      ]
        .map(csvCell)
        .join(";")
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** «informe-sage200-<id>.csv». */
export function reportFileName(record: Pick<LedgerImportRecord, "id">): string {
  return `informe-sage200-${record.id}.csv`;
}

/** Header of the reconciliation CSV. */
export const RECONCILIATION_CSV_HEADER = ["cuenta", "nombre", "cuentas_sage", "periodo_desde", "periodo_hasta", "debe_sage", "haber_sage", "debe_anfitorio", "haber_anfitorio", "dif_debe", "dif_haber", "saldo_sage", "saldo_anfitorio", "dif_saldo", "tolerancia", "clasificacion", "nota"] as const;

/** Reconciliation report: BOM UTF-8, «;», CRLF, one line per compared account (classification in Spanish). */
export function buildReconciliationCsv(recon: Pick<LedgerReconciliationDto, "periodFrom" | "periodTo" | "rows">): string {
  const lines: string[] = [RECONCILIATION_CSV_HEADER.join(";")];
  for (const row of recon.rows) {
    lines.push(
      [
        row.accountCode,
        row.accountName,
        row.sourceAccounts.join(" "),
        recon.periodFrom,
        recon.periodTo,
        row.sourceDebit,
        row.sourceCredit,
        row.ledgerDebit,
        row.ledgerCredit,
        row.diffDebit,
        row.diffCredit,
        row.sourceBalance,
        row.ledgerBalance,
        row.diffBalance,
        row.tolerance,
        row.ok ? "cuadra" : reconciliationClassificationLabel(row.classification),
        row.note ?? null
      ]
        .map(csvCell)
        .join(";")
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** «reconciliacion-sage200-<id>.csv». */
export function reconciliationFileName(recon: Pick<LedgerReconciliationDto, "id">): string {
  return `reconciliacion-sage200-${recon.id}.csv`;
}

// ---------------------------------------------------------------------------
// Lots list
// ---------------------------------------------------------------------------

/**
 * «Autor» of a lot: never the raw `createdBy`. The CLI sage200:import writes
 * `cli:import-sage200` (LEDGER_IMPORT_CLI_CREATED_BY) or its system user →
 * «Sistema · importación contable desde Sage 200»; the viewer → own name (or
 * «tú»); anybody else → «otro usuario»; nothing recorded → «—». Own helper of
 * this screen (the one of screens/reservations belongs to that wizard).
 */
export const SAGE200_CLI_CREATED_BY = "cli:import-sage200";
export const SAGE200_SYSTEM_ACTOR_LABEL = "Sistema · importación contable desde Sage 200";

export function importAuthorLabel(createdBy: string | null | undefined, session: ActorSession): string {
  const raw = createdBy?.trim() ?? "";
  if (raw === SAGE200_CLI_CREATED_BY || raw === "usr_system_sage200_import") return SAGE200_SYSTEM_ACTOR_LABEL;
  const actor = actorLabel(raw, session);
  if (!actor) return EMPTY;
  return actor.kind === "self" && actor.label === "ti" ? "tú" : actor.label;
}

/** Row label of the lots list: file name, else the lot id. */
export function importFileLabel(record: Pick<LedgerImportRecord, "fileName" | "id">): string {
  return record.fileName?.trim() || record.id;
}

export const LOT_STATUS_FILTER_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "", label: "Todos los estados" },
  { value: "draft", label: "Borradores" },
  { value: "posted", label: "Contabilizados" },
  { value: "reversed", label: "Revertidos" }
];

export function lotKindFilterOptions(): CocoaSelectOption[] {
  return [{ value: "", label: "Todos los tipos" }, ...importKindOptions()];
}

/** Reversal reason bounds (LEDGER_IMPORT_REVERSAL_REASON_MIN / _MAX). */
export const REVERSAL_REASON_MIN = 3;
export const REVERSAL_REASON_MAX = 500;

export function isReversalReasonValid(reason: string): boolean {
  const length = reason.trim().length;
  return length >= REVERSAL_REASON_MIN && length <= REVERSAL_REASON_MAX;
}
