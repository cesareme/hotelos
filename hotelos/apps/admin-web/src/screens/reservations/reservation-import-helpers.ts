// Recepción › Reservas › Importar (Tanda 7 · L4) — pure helpers of
// ReservationImportScreen.tsx: the four steps of the wizard, the base64 of
// the picked file (the browser never reads it as text: latin1 must survive
// until the API decides the encoding, design §1.1), the column → field
// mapping the user edits in «Columnas», the Spanish vocabularies of the wire
// contract (packages/shared/src/reservation-import-types.ts), the row filter
// and KPIs of «Revisión», and the per-row report CSV of «Resultado». No React,
// no network, no import.meta: screens/reservations/__tests__/
// reservation-import-helpers.test.mts runs it under node --test.
//
// The vocabularies are redeclared here on purpose (typed against the shared
// contract, so a drift fails the typecheck): under `node --import tsx` the
// `.js` stubs of @hotelos/shared win over the sources, so a runtime import
// from the package would come back undefined in the tests.

import type {
  NormalizedReservationRow,
  ReservationImportAvailabilityByType,
  ReservationImportField,
  ReservationImportFormat,
  ReservationImportIssue,
  ReservationImportMapping,
  ReservationImportMappingSourceKind,
  ReservationImportPreview,
  ReservationImportPreviewRow,
  ReservationImportRecord,
  ReservationImportRowOutcome,
  ReservationImportRowRecord,
  ReservationImportRowStatus,
  ReservationImportStatus,
  ReservationImportSummary,
  ReservationImportUndoOutcome,
  ReservationImportUndoResult
} from "@hotelos/shared";
import type { CocoaSelectOption, CocoaTone } from "../../components/cocoa";
import { EMPTY, money, number, plural } from "../../lib/format";
import { actorLabel, type ActorSession } from "../accounting/actor-label";

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

export type ImportStepKey = "file" | "columns" | "review" | "result";

export type ImportStep = { key: ImportStepKey; label: string; description: string };

/** The four steps of the wizard, in order (design §9). */
export const IMPORT_STEPS: readonly ImportStep[] = [
  { key: "file", label: "Fichero", description: "Elige el CSV o XLSX y, si hace falta, descarga la plantilla oficial." },
  { key: "columns", label: "Columnas", description: "Confirma qué campo alimenta cada columna del fichero; el sistema propone el mapeo." },
  { key: "review", label: "Revisión", description: "Comprueba las filas válidas, los avisos, los errores, la disponibilidad y los duplicados antes de importar." },
  { key: "result", label: "Resultado", description: "Reservas creadas, filas omitidas o con error, informe descargable y deshacer." }
];

export function stepIndexOf(key: ImportStepKey): number {
  return Math.max(0, IMPORT_STEPS.findIndex((step) => step.key === key));
}

/** Tone of the step badge: done → success, current → accent, pending → neutral. */
export function stepTone(index: number, current: number): CocoaTone {
  return index < current ? "success" : index === current ? "accent" : "neutral";
}

/** «hecho» · «actual» · «pendiente». */
export function stepStateLabel(index: number, current: number): string {
  return index < current ? "hecho" : index === current ? "actual" : "pendiente";
}

/** «Paso 2 de 4 · Columnas». */
export function stepSummary(current: number): string {
  const step = IMPORT_STEPS[current] ?? IMPORT_STEPS[0];
  return `Paso ${current + 1} de ${IMPORT_STEPS.length} · ${step.label}`;
}

// ---------------------------------------------------------------------------
// File (bytes → base64, format by name)
// ---------------------------------------------------------------------------

/** Upper bound of a picked file, in bytes (RESERVATION_IMPORT_MAX_BYTES): the API refuses more. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Upper bound of data rows (RESERVATION_IMPORT_MAX_ROWS). */
export const IMPORT_MAX_ROWS = 5000;
/** From this many rows the note recommends the CLI (HTTP commits are sequential: minutes per thousand rows). */
export const IMPORT_CLI_ROWS_HINT = 1000;
/** Chunk of bytes turned into a binary string at once (btoa over 5 MB in one string would blow the argument list). */
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

/** `.xlsx` / `.xlsm` → xlsx; anything else (`.csv`, `.txt`, `.tsv`, no extension) → csv. The API still checks the signature. */
export function detectFormatFromName(fileName: string | null | undefined): ReservationImportFormat {
  const name = (fileName ?? "").trim().toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xlsm") ? "xlsx" : "csv";
}

export const IMPORT_FORMAT_LABELS: Readonly<Record<ReservationImportFormat, string>> = Object.freeze({ csv: "CSV", xlsx: "XLSX" });

export function formatLabel(format: ReservationImportFormat | string | null | undefined): string {
  if (!format) return EMPTY;
  return (IMPORT_FORMAT_LABELS as Record<string, string>)[format] ?? format.toUpperCase();
}

/** «1,2 MB» · «512 KB» · «0 B» (binary units, one decimal from 1 MB). */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return EMPTY;
  if (bytes >= 1024 * 1024) return `${number(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
  if (bytes >= 1024) return `${number(Math.round(bytes / 1024))} KB`;
  return `${number(bytes)} B`;
}

// ---------------------------------------------------------------------------
// Fields (mirror of RESERVATION_IMPORT_FIELDS / _LABELS_ES / _REQUIRED_FIELDS)
// ---------------------------------------------------------------------------

/** The 33 canonical fields in the order of the template header. */
export const IMPORT_FIELDS: readonly ReservationImportField[] = [
  "referencia_externa",
  "llegada",
  "salida",
  "noches",
  "tipo_habitacion",
  "tarifa",
  "habitacion",
  "habitaciones",
  "adultos",
  "ninos",
  "bebes",
  "regimen",
  "canal",
  "segmento",
  "estado",
  "nombre",
  "apellidos",
  "email",
  "telefono",
  "nacionalidad",
  "documento_tipo",
  "documento_numero",
  "empresa",
  "agencia",
  "grupo",
  "importe_total",
  "moneda",
  "deposito",
  "metodo_pago",
  "hora_llegada",
  "peticiones",
  "notas",
  "vip"
];

export const IMPORT_FIELD_LABELS: Readonly<Record<ReservationImportField, string>> = Object.freeze({
  referencia_externa: "Referencia externa",
  llegada: "Llegada",
  salida: "Salida",
  noches: "Noches",
  tipo_habitacion: "Tipo de habitación",
  tarifa: "Tarifa",
  habitacion: "Habitación",
  habitaciones: "Habitaciones",
  adultos: "Adultos",
  ninos: "Niños",
  bebes: "Bebés",
  regimen: "Régimen",
  canal: "Canal",
  segmento: "Segmento",
  estado: "Estado",
  nombre: "Nombre",
  apellidos: "Apellidos",
  email: "E-mail",
  telefono: "Teléfono",
  nacionalidad: "Nacionalidad",
  documento_tipo: "Tipo de documento",
  documento_numero: "Número de documento",
  empresa: "Empresa",
  agencia: "Agencia",
  grupo: "Grupo",
  importe_total: "Importe total",
  moneda: "Moneda",
  deposito: "Depósito",
  metodo_pago: "Método de pago",
  hora_llegada: "Hora de llegada",
  peticiones: "Peticiones",
  notas: "Notas",
  vip: "VIP"
});

/** Mandatory fields (`apellidos` is waived when the column mapped to `nombre` is a full name). */
export const IMPORT_REQUIRED_FIELDS: readonly ReservationImportField[] = ["llegada", "tipo_habitacion", "nombre", "apellidos"];
/** One of the two is mandatory. */
export const IMPORT_ONE_OF_FIELDS: readonly ReservationImportField[] = ["salida", "noches"];

const FIELD_SET: ReadonlySet<string> = new Set(IMPORT_FIELDS);

export function isImportField(value: unknown): value is ReservationImportField {
  return typeof value === "string" && FIELD_SET.has(value);
}

export function importFieldLabel(field: ReservationImportField | string | null | undefined): string {
  if (!field) return EMPTY;
  return (IMPORT_FIELD_LABELS as Record<string, string>)[field] ?? field;
}

/** Value of the «Ignorar columna» option of the field select (never a field name). */
export const IGNORE_COLUMN_VALUE = "ignorar";

/** Options of the «Campo» select of one column: «Ignorar columna» first, then the 33 fields with their obligation. */
export function fieldOptions(): CocoaSelectOption[] {
  return [
    { value: IGNORE_COLUMN_VALUE, label: "Ignorar columna" },
    ...IMPORT_FIELDS.map((field) => {
      const label = IMPORT_FIELD_LABELS[field];
      if (IMPORT_REQUIRED_FIELDS.includes(field)) return { value: field, label: `${label} (obligatorio)` };
      if (IMPORT_ONE_OF_FIELDS.includes(field)) return { value: field, label: `${label} (salida o noches)` };
      return { value: field, label };
    })
  ];
}

/** Select value of a column: its field, or «Ignorar columna» when it is null / unmapped. */
export function fieldSelectValue(field: ReservationImportField | null | undefined): string {
  return field ?? IGNORE_COLUMN_VALUE;
}

// ---------------------------------------------------------------------------
// Mapping (what the user touched → the body of preview / import)
// ---------------------------------------------------------------------------

/**
 * Mapping body of preview / import: only the columns of the header the user
 * decided (a field, or `null` = «Ignorar columna»). Columns without a
 * decision are dropped so the API keeps suggesting them; columns absent from
 * the header, empty names and unknown field names are dropped too. Empty →
 * undefined (the body carries no `mapping`).
 */
export function buildMapping(header: readonly string[], choices: Readonly<Record<string, ReservationImportField | string | null | undefined>>): ReservationImportMapping | undefined {
  const mapping: ReservationImportMapping = {};
  let count = 0;
  for (const column of header) {
    if (!column) continue;
    if (!Object.prototype.hasOwnProperty.call(choices, column)) continue;
    const choice = choices[column];
    if (choice === undefined || choice === "") continue;
    if (choice === null || choice === IGNORE_COLUMN_VALUE) {
      mapping[column] = null;
      count += 1;
      continue;
    }
    if (!isImportField(choice)) continue;
    mapping[column] = choice;
    count += 1;
  }
  return count > 0 ? mapping : undefined;
}

/**
 * The user picks `value` (a field or IGNORE_COLUMN_VALUE) for `column`: the
 * column gets it and any OTHER column that effectively held the same field is
 * set to «Ignorar» explicitly, so the API never sees a field on two columns
 * (400 RESERVATION_IMPORT_MAPPING_CONFLICT). Returns the new choices object.
 */
export function applyMappingChoice(
  effective: Readonly<Record<string, ReservationImportField | null>>,
  choices: Readonly<Record<string, ReservationImportField | null>>,
  column: string,
  value: string
): Record<string, ReservationImportField | null> {
  const next: Record<string, ReservationImportField | null> = { ...choices };
  const field = isImportField(value) ? value : null;
  if (field !== null) {
    for (const other of Object.keys(effective)) {
      if (other === column) continue;
      const current = Object.prototype.hasOwnProperty.call(choices, other) ? choices[other] : effective[other];
      if (current === field) next[other] = null;
    }
  }
  next[column] = field;
  return next;
}

/** Effective mapping the select shows: the API's proposal overridden by what the user touched. */
export function effectiveMapping(proposal: Readonly<Record<string, ReservationImportField | null>>, choices: Readonly<Record<string, ReservationImportField | null>>): Record<string, ReservationImportField | null> {
  return { ...proposal, ...choices };
}

/** Spanish labels of the missing mandatory fields («Llegada, Tipo de habitación»). */
export function missingRequiredLabels(fields: readonly (ReservationImportField | string)[]): string[] {
  return fields.map((field) => importFieldLabel(field));
}

export const MAPPING_SOURCE_LABELS: Readonly<Record<ReservationImportMappingSourceKind, string>> = Object.freeze({
  explicit: "Manual",
  synonym: "Sinónimo",
  fuzzy: "Aproximado",
  none: "Sin mapear"
});

export const MAPPING_SOURCE_TONES: Readonly<Record<ReservationImportMappingSourceKind, CocoaTone>> = Object.freeze({
  explicit: "accent",
  synonym: "success",
  fuzzy: "warning",
  none: "neutral"
});

export function mappingSourceLabel(kind: ReservationImportMappingSourceKind | string | null | undefined): string {
  if (!kind) return MAPPING_SOURCE_LABELS.none;
  return (MAPPING_SOURCE_LABELS as Record<string, string>)[kind] ?? kind;
}

export function mappingSourceTone(kind: ReservationImportMappingSourceKind | string | null | undefined): CocoaTone {
  if (!kind) return "neutral";
  return (MAPPING_SOURCE_TONES as Record<string, CocoaTone>)[kind] ?? "neutral";
}

// ---------------------------------------------------------------------------
// Sample values («Ejemplo» of the mapping table): from the normalised sample rows
// ---------------------------------------------------------------------------

/** Value of a canonical field in a normalised row, as text («» when absent). */
export function normalizedValueOf(row: NormalizedReservationRow, field: ReservationImportField): string {
  switch (field) {
    case "referencia_externa":
      return row.externalReference ?? "";
    case "llegada":
      return row.arrivalDate;
    case "salida":
      return row.departureDate;
    case "noches":
      return String(row.nights);
    case "tipo_habitacion":
      return row.roomTypeCode;
    case "tarifa":
      return row.ratePlanCode ?? "";
    case "habitacion":
      return row.roomNumber ?? "";
    case "habitaciones":
      return String(row.roomsCount);
    case "adultos":
      return String(row.adults);
    case "ninos":
      return String(row.children);
    case "bebes":
      return String(row.infants);
    case "regimen":
      return row.boardType ?? "";
    case "canal":
      return row.sourceCode ?? row.channel;
    case "segmento":
      return row.marketSegment ?? "";
    case "estado":
      return row.estado;
    case "nombre":
      return row.guest.firstName;
    case "apellidos":
      return [row.guest.surname1, row.guest.surname2].filter(Boolean).join(" ");
    case "email":
      return row.guest.email ?? "";
    case "telefono":
      return row.guest.phone ?? "";
    case "nacionalidad":
      return row.guest.nationality ?? "";
    case "documento_tipo":
      return row.guest.documentType ?? "";
    case "documento_numero":
      return row.guest.documentNumber ?? "";
    case "empresa":
      return row.companyName ?? "";
    case "agencia":
      return row.travelAgentName ?? "";
    case "grupo":
      return row.groupCode ?? "";
    case "importe_total":
      return row.totalSource === "file" ? row.totalAmount : "";
    case "moneda":
      return row.currency;
    case "deposito":
      return row.depositAmount ?? "";
    case "metodo_pago":
      return row.paymentMethod ?? "";
    case "hora_llegada":
      return row.estimatedArrivalTime ?? "";
    case "peticiones":
      return row.specialRequests ?? "";
    case "notas":
      return row.notes ?? "";
    case "vip":
      return row.vipFlag ? "sí" : "no";
    default:
      return "";
  }
}

/** «Lucía Ferreiro C…»: text capped at `max` characters with an ellipsis. */
export function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  if (max <= 1 || trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** First non-empty normalised value of `field` in the sample rows, capped at `max`; «» when the sample has none. */
export function exampleForField(rows: readonly ReservationImportPreviewRow[], field: ReservationImportField | null, max = 32): string {
  if (!field) return "";
  for (const row of rows) {
    if (!row.normalized) continue;
    const value = normalizedValueOf(row.normalized, field);
    if (value.trim() !== "") return truncateText(value, max);
  }
  return "";
}

/**
 * Example of column `columnIndex` for the «Columnas» table (FUX-04): the first
 * non-empty RAW cell of the sample (`row.cells`, what the file actually says —
 * the value the user recognises, also for an unmapped column or a row with
 * errors), falling back to the normalised value of `field` when the API sent
 * no raw sample (older process). «» when the sample has nothing.
 */
export function exampleForColumn(rows: readonly ReservationImportPreviewRow[], columnIndex: number, field: ReservationImportField | null, max = 32): string {
  let sampled = false;
  for (const row of rows) {
    if (!row.cells) continue;
    sampled = true;
    const value = row.cells[columnIndex] ?? "";
    if (value.trim() !== "") return truncateText(value, max);
  }
  return sampled ? "" : exampleForField(rows, field, max);
}

/** «Nombre Apellidos» of a normalised row. */
export function guestName(row: NormalizedReservationRow): string {
  return [row.guest.firstName, row.guest.surname1, row.guest.surname2].filter((part) => Boolean(part && part.trim())).join(" ") || EMPTY;
}

// ---------------------------------------------------------------------------
// Vocabularies (rows, lots, undo)
// ---------------------------------------------------------------------------

export const ROW_STATUS_LABELS: Readonly<Record<ReservationImportRowStatus, string>> = Object.freeze({
  valid: "Válida",
  warning: "Con avisos",
  error: "Con errores",
  skipped: "Omitida"
});

export const ROW_STATUS_TONES: Readonly<Record<ReservationImportRowStatus, CocoaTone>> = Object.freeze({
  valid: "success",
  warning: "warning",
  error: "danger",
  skipped: "neutral"
});

export function rowStatusLabel(status: ReservationImportRowStatus | string): string {
  return (ROW_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function rowStatusTone(status: ReservationImportRowStatus | string): CocoaTone {
  return (ROW_STATUS_TONES as Record<string, CocoaTone>)[status] ?? "neutral";
}

export const IMPORT_STATUS_LABELS: Readonly<Record<ReservationImportStatus, string>> = Object.freeze({
  processing: "Interrumpida",
  imported: "Importada",
  partial: "Parcial",
  failed: "Fallida",
  undone: "Deshecha"
});

export const IMPORT_STATUS_TONES: Readonly<Record<ReservationImportStatus, CocoaTone>> = Object.freeze({
  processing: "warning",
  imported: "success",
  partial: "warning",
  failed: "danger",
  undone: "neutral"
});

/** «Interrumpida» · «Importada» · «Parcial» · «Fallida» · «Deshecha»; an unknown status comes back as given. */
export function importStatusLabel(status: ReservationImportStatus | string): string {
  return (IMPORT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function importStatusTone(status: ReservationImportStatus | string): CocoaTone {
  return (IMPORT_STATUS_TONES as Record<string, CocoaTone>)[status] ?? "neutral";
}

export const ROW_OUTCOME_LABELS: Readonly<Record<ReservationImportRowOutcome, string>> = Object.freeze({
  created: "Creada",
  skipped: "Omitida",
  error: "Error"
});

export const ROW_OUTCOME_TONES: Readonly<Record<ReservationImportRowOutcome, CocoaTone>> = Object.freeze({
  created: "success",
  skipped: "neutral",
  error: "danger"
});

export function rowOutcomeLabel(outcome: ReservationImportRowOutcome | string): string {
  return (ROW_OUTCOME_LABELS as Record<string, string>)[outcome] ?? outcome;
}

export function rowOutcomeTone(outcome: ReservationImportRowOutcome | string): CocoaTone {
  return (ROW_OUTCOME_TONES as Record<string, CocoaTone>)[outcome] ?? "neutral";
}

export const UNDO_OUTCOME_LABELS: Readonly<Record<ReservationImportUndoOutcome, string>> = Object.freeze({
  cancelled: "Cancelada",
  kept: "Conservada (ya con check-in)",
  skipped: "Sin cambios (ya cancelada)"
});

export function undoOutcomeLabel(outcome: ReservationImportUndoOutcome | string | null | undefined): string {
  if (!outcome) return EMPTY;
  return (UNDO_OUTCOME_LABELS as Record<string, string>)[outcome] ?? outcome;
}

/** A lot can be undone while it is not already undone nor failed (0 reservations created). */
export function canUndoImport(record: Pick<ReservationImportRecord, "status">): boolean {
  return record.status !== "undone" && record.status !== "failed";
}

// ---------------------------------------------------------------------------
// Review: filter, KPIs, issues, availability, blockers
// ---------------------------------------------------------------------------

export type RowFilter = "all" | ReservationImportRowStatus;

export const ROW_FILTERS: readonly { value: RowFilter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "valid", label: "Válidas" },
  { value: "warning", label: "Con avisos" },
  { value: "error", label: "Con errores" },
  { value: "skipped", label: "Omitidas" }
];

export function isRowFilter(value: string): value is RowFilter {
  return ROW_FILTERS.some((filter) => filter.value === value);
}

/** Rows whose verdict matches the filter («all» keeps every row, in file order). */
export function filterRows<Row extends Pick<ReservationImportPreviewRow, "status">>(rows: readonly Row[], filter: RowFilter): Row[] {
  if (filter === "all") return [...rows];
  return rows.filter((row) => row.status === filter);
}

export type SummaryKpi = { key: keyof ReservationImportSummary; label: string; value: string; tone?: CocoaTone; caption?: string };

/** The six KPIs of «Revisión»: válidas · con avisos · con errores · omitidas · histórico · a crear. */
export function summaryKpis(summary: ReservationImportSummary): SummaryKpi[] {
  return [
    { key: "valid", label: "Válidas", value: number(summary.valid), tone: summary.valid > 0 ? "success" : undefined },
    { key: "warning", label: "Con avisos", value: number(summary.warning), tone: summary.warning > 0 ? "warning" : undefined, caption: "Se crean igualmente" },
    { key: "error", label: "Con errores", value: number(summary.error), tone: summary.error > 0 ? "danger" : undefined, caption: summary.error > 0 ? "Corrígelas u omítelas" : undefined },
    { key: "skipped", label: "Omitidas", value: number(summary.skipped), caption: "Duplicadas o descartadas" },
    { key: "historical", label: "Histórico", value: number(summary.historical), caption: "Estancias cerradas" },
    { key: "toCreate", label: "A crear", value: number(summary.toCreate), tone: "accent" }
  ];
}

/** Text of one issue: its Spanish message (column and row number already inside; never a value of the file). */
export function issueText(issue: Pick<ReservationImportIssue, "code" | "message">): string {
  const message = issue.message.trim();
  return message || issue.code;
}

/** «mensaje 1 · mensaje 2 (+3)»: the first `max` issues joined, the rest counted. */
export function issuesSummary(issues: readonly Pick<ReservationImportIssue, "code" | "message">[], max = 2): string {
  if (issues.length === 0) return EMPTY;
  const shown = issues.slice(0, max).map(issueText).join(" · ");
  return issues.length > max ? `${shown} (+${number(issues.length - max)})` : shown;
}

/** Every issue of a row, one per line (tooltip of the truncated cell). */
export function issuesTitle(issues: readonly Pick<ReservationImportIssue, "code" | "message">[]): string | undefined {
  return issues.length > 0 ? issues.map(issueText).join("\n") : undefined;
}

/** One line per room type of the availability callout: cupo, pedidas, picos, noches excedidas y filas rechazadas por la regla de rango. */
export function availabilityLine(type: ReservationImportAvailabilityByType): string {
  const parts = [
    `${type.code} · ${type.name}: cupo ${number(type.totalRooms)}`,
    `pedidas ${number(type.rowsRequested)}`,
    `pico en la base de datos ${number(type.peakBookedDb)}`,
    `pico del fichero ${number(type.peakBookedFile)}`
  ];
  if (type.nightsExceeded.length > 0) parts.push(`${plural(type.nightsExceeded.length, "noche excedida", "noches excedidas")}`);
  if (type.rangeRuleRows.length > 0) parts.push(`${plural(type.rangeRuleRows.length, "fila rechazada", "filas rechazadas")} por la regla de rango del PMS aunque quepan por noche (filas ${type.rangeRuleRows.map((row) => number(row)).join(", ")})`);
  return parts.join(" · ");
}

/** Room types whose file rows exceed the quota somewhere (they head the callout). */
export function availabilityExceeded(types: readonly ReservationImportAvailabilityByType[]): ReservationImportAvailabilityByType[] {
  return types.filter((type) => type.nightsExceeded.length > 0 || type.rangeRuleRows.length > 0);
}

/** «filas 3, 7 y 12» of a list of row numbers (capped at `max`, the rest counted). */
export function rowsLabel(rows: readonly number[], max = 8): string {
  if (rows.length === 0) return EMPTY;
  const shown = rows.slice(0, max).map((row) => number(row));
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}` : shown[0];
  const rest = rows.length - shown.length;
  return `${rows.length === 1 ? "fila" : "filas"} ${list}${rest > 0 ? ` (+${number(rest)})` : ""}`;
}

/**
 * Why «Importar» is disabled, in Spanish (empty when the preview can import).
 * The API already names the blockers it found (`preview.blockers`); the local
 * reasons are added only for a condition the API did not report under its own
 * code, so no blocker is listed twice (FUX-07).
 */
export function previewBlockers(preview: ReservationImportPreview | null): string[] {
  if (!preview) return ["carga un fichero y previsualízalo antes de importar"];
  const out: string[] = [];
  const reported = new Set(preview.blockers.map((blocker) => blocker.code));
  for (const blocker of preview.blockers) if (blocker.message.trim()) out.push(blocker.message.trim().replace(/\.$/, ""));
  if (preview.missingRequired.length > 0 && !reported.has("RESERVATION_IMPORT_MAPPING_INCOMPLETE")) {
    out.push(`faltan columnas obligatorias por mapear: ${missingRequiredLabels(preview.missingRequired).join(", ")}`);
  }
  if (preview.summary.error > 0 && !preview.options.omitirInvalidas && !reported.has("RESERVATION_IMPORT_INVALID")) {
    out.push(`${plural(preview.summary.error, "fila con errores", "filas con errores")}: corrígelas o activa «Omitir filas inválidas»`);
  }
  if (preview.duplicates.ofImport && !preview.options.force && !reported.has("RESERVATION_IMPORT_DUPLICATE")) {
    const lot = preview.duplicates.ofImport.fileName ?? preview.duplicates.ofImport.importId;
    out.push(`este fichero ya se importó (lote ${lot}): deshaz el anterior o activa «Importar de todos modos»`);
  }
  if (preview.summary.toCreate === 0 && preview.rowCount > 0 && out.length === 0) out.push("no hay ninguna reserva que crear");
  if (preview.rowCount === 0 && out.length === 0) out.push("el fichero no tiene filas de datos");
  return out;
}

// ---------------------------------------------------------------------------
// Result: title, tone, KPIs, report CSV, undo summary
// ---------------------------------------------------------------------------

export type ResultTone = "success" | "warning" | "danger" | "neutral";

/** Tone of the result callout by lot status. */
export function resultTone(status: ReservationImportStatus | string): ResultTone {
  switch (status) {
    case "imported":
      return "success";
    case "partial":
    case "processing":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

/** Title of the result callout: «30 reservas importadas» · «Importación parcial: …» · «Importación fallida: …» · «Importación deshecha …» · «Importación interrumpida …». */
export function resultTitle(record: Pick<ReservationImportRecord, "status" | "createdCount" | "skippedCount" | "errorCount" | "undoneCount" | "undoKeptCount">): string {
  const created = plural(record.createdCount, "reserva creada", "reservas creadas");
  switch (record.status) {
    case "imported":
      return `${plural(record.createdCount, "reserva importada", "reservas importadas")}`;
    case "partial":
      return `Importación parcial: ${created}, ${plural(record.skippedCount, "omitida", "omitidas")}, ${plural(record.errorCount, "con error", "con error")}`;
    case "failed":
      return `Importación fallida: ninguna reserva creada (${plural(record.errorCount, "fila con error", "filas con error")}, ${plural(record.skippedCount, "omitida", "omitidas")})`;
    case "undone":
      return `Importación deshecha: ${plural(record.undoneCount, "reserva cancelada", "reservas canceladas")}, ${plural(record.undoKeptCount, "conservada", "conservadas")}`;
    case "processing":
      return `Importación interrumpida: ${created} hasta el corte; se puede deshacer`;
    default:
      return created;
  }
}

export type ResultKpi = { key: string; label: string; value: string; tone?: CocoaTone };

/** The five KPIs of «Resultado»: creadas · omitidas · errores · avisos · importe. */
export function resultKpis(record: Pick<ReservationImportRecord, "createdCount" | "skippedCount" | "errorCount" | "warningCount" | "totalAmount" | "currency">): ResultKpi[] {
  return [
    { key: "created", label: "Creadas", value: number(record.createdCount), tone: record.createdCount > 0 ? "success" : undefined },
    { key: "skipped", label: "Omitidas", value: number(record.skippedCount) },
    { key: "errors", label: "Con error", value: number(record.errorCount), tone: record.errorCount > 0 ? "danger" : undefined },
    { key: "warnings", label: "Con avisos", value: number(record.warningCount), tone: record.warningCount > 0 ? "warning" : undefined },
    { key: "amount", label: "Importe creado", value: money(record.totalAmount, record.currency) }
  ];
}

/**
 * «Autor» of a lot (FUX-02, qa#10): never the raw `createdBy`. A system actor
 * (the CLI, also under its legacy "cli:import-reservations") → «Sistema ·
 * importación masiva de reservas»; the viewer → own name (or «tú»); anybody
 * else → «otro usuario»; nothing recorded → «—».
 */
export function importAuthorLabel(createdBy: string | null | undefined, session: ActorSession): string {
  const actor = actorLabel(createdBy, session);
  if (!actor) return EMPTY;
  return actor.kind === "self" && actor.label === "ti" ? "tú" : actor.label;
}

/** Header of the per-row report CSV (design §9). */
export const IMPORT_REPORT_HEADER = ["fila", "resultado", "codigo_reserva", "referencia_externa", "llegada", "salida", "tipo_habitacion", "tarifa", "habitaciones", "codigo_error", "mensaje", "avisos"] as const;

/**
 * First characters Excel / LibreOffice read as a formula (`=`, `+`, `-`, `@`,
 * tab, CR), leading blanks included. A text cell that starts with one of them
 * (`referencia_externa` comes from a third-party file: `=cmd|…`, `=HYPERLINK(…)`)
 * is prefixed with an apostrophe and quoted, so the spreadsheet shows it as
 * text and never evaluates it (SEC-T7-02, OWASP CSV injection). Numbers are
 * never touched: they are ours (row number, units) and must stay numeric.
 */
const CSV_FORMULA_START = /^[\s ]*[=+\-@\t\r]/;

/** RFC 4180 cell for a «;» CSV: quoted (quotes doubled) when it carries «;», a quote or a line break; formula starters neutralised. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = CSV_FORMULA_START.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(text) || text !== value ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Report of a lot: BOM UTF-8, «;», CRLF, one line per persisted row (no personal data: the rows never carry any). */
export function buildImportReportCsv(rows: readonly ReservationImportRowRecord[]): string {
  const lines: string[] = [IMPORT_REPORT_HEADER.join(";")];
  for (const row of rows) {
    lines.push(
      [
        row.rowNumber,
        rowOutcomeLabel(row.outcome),
        row.reservationCode,
        row.externalReference,
        row.arrivalDate,
        row.departureDate,
        row.roomTypeCode,
        row.ratePlanCode,
        row.roomsCount,
        row.errorCode,
        row.errorMessage,
        row.warnings.map((warning) => issueText(warning)).join(" | ")
      ]
        .map(csvCell)
        .join(";")
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** «informe-importacion-<id>.csv». */
export function reportFileName(record: Pick<ReservationImportRecord, "id">): string {
  return `informe-importacion-${record.id}.csv`;
}

/** «5 reservas canceladas · 1 conservada (ya con check-in)» · «La importación ya estaba deshecha.». */
export function undoSummary(result: Pick<ReservationImportUndoResult, "alreadyUndone" | "undoneCount" | "undoKeptCount">): string {
  if (result.alreadyUndone) return "La importación ya estaba deshecha: no se ha cambiado nada.";
  const parts = [plural(result.undoneCount, "reserva cancelada", "reservas canceladas")];
  if (result.undoKeptCount > 0) parts.push(`${plural(result.undoKeptCount, "conservada", "conservadas")} (ya con check-in)`);
  return parts.join(" · ");
}

/** Row label of the imports list: file name, else the lot id. */
export function importFileLabel(record: Pick<ReservationImportRecord, "fileName" | "id">): string {
  return record.fileName?.trim() || record.id;
}
