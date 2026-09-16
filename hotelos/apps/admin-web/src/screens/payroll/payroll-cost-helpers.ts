// Nóminas › Coste de personal (Tanda 6c · L4) — pure helpers of the «Coste de
// personal» tab of PayrollScreen.tsx and of PayrollCostImportDrawer.tsx: month
// range pickers, Spanish vocabularies of the wire contract
// (packages/shared/src/payroll-cost-types.ts), the centres × months matrix
// rows (the API already derives every figure; here we only format through
// lib/format), the two bar charts, the import-drawer plumbing (format
// detection, mapping body, blockers of «Contabilizar») and the error mapping
// on top of finance-contracts.ts. No React, no network, no import.meta:
// screens/payroll/__tests__/payroll-cost-helpers.test.mts runs it under
// node --test.
//
// The vocabularies are redeclared here on purpose (typed against the shared
// contract): under `node --import tsx` the `.js` stubs of @hotelos/shared win
// over the sources, so a runtime import from the package would come back
// undefined in the tests (services/__tests__/finance-api-surface.test.mts).

import type {
  PayrollCostGroup,
  PayrollCostImportCreateResult,
  PayrollCostImportEntryDto,
  PayrollCostImportFormat,
  PayrollCostImportPreview,
  PayrollCostImportRecord,
  PayrollCostImportSource,
  PayrollCostImportStatus,
  PayrollCostMapping,
  PayrollCostReport,
  PayrollCostReportMetrics,
  PayrollCostSalesSource,
  PayrollCostUnmappedLabel,
  PayrollCostUsaliDepartment
} from "@hotelos/shared";
import type { CocoaBarsDatum, CocoaSelectOption, CocoaTone } from "../../components/cocoa";
import { date, money, number, percent, plural } from "../../lib/format";
import { financeErrorDetails, financeErrorMessage } from "../../services/finance-contracts";

// ---------------------------------------------------------------------------
// Vocabularies (mirror of packages/shared/src/payroll-cost-types.ts)
// ---------------------------------------------------------------------------

/** Grupos de coste del informe de RRHH, en el orden en que los lee el hotelero. */
export const PAYROLL_COST_GROUPS: readonly PayrollCostGroup[] = ["operaciones", "extras", "estructura", "mantenimiento_obra", "familia"];

export const PAYROLL_COST_GROUP_LABELS_ES: Readonly<Record<PayrollCostGroup, string>> = Object.freeze({
  operaciones: "Operaciones",
  extras: "Extras",
  estructura: "Estructura",
  mantenimiento_obra: "Mantenimiento y obra",
  familia: "Familia"
});

/** Departamentos USALI que admiten la línea `labor`: los únicos destinos de una fila de coste de personal. */
export const USALI_LABOR_DEPARTMENTS: readonly PayrollCostUsaliDepartment[] = ["rooms", "fnb", "other_operated", "admin_general", "it", "sales_marketing", "pom"];

export const USALI_LABOR_DEPARTMENT_LABELS: Readonly<Record<PayrollCostUsaliDepartment, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operados",
  admin_general: "Administración y general",
  it: "Tecnología de la información",
  sales_marketing: "Ventas y marketing",
  pom: "Mantenimiento y operación de la propiedad"
});

export const PAYROLL_COST_IMPORT_STATUS_LABELS: Readonly<Record<PayrollCostImportStatus, string>> = Object.freeze({
  draft: "Borrador",
  posted: "Contabilizado",
  reversed: "Revertido"
});

export const PAYROLL_COST_IMPORT_STATUS_TONES: Readonly<Record<PayrollCostImportStatus, CocoaTone>> = Object.freeze({
  draft: "warning",
  posted: "success",
  reversed: "neutral"
});

export const PAYROLL_COST_SOURCE_LABELS: Readonly<Record<PayrollCostImportSource, string>> = Object.freeze({
  csv: "CSV",
  json: "JSON",
  informe_rrhh: "Informe de RRHH"
});

/** Upper bound of a file picked in the drawer (bytes) and of the pasted text (characters): the API refuses more; larger reports go through the CLI. */
export const PAYROLL_COST_MAX_BYTES = 1_000_000;
/** Widest range GET /payroll/cost-report accepts, in months. */
export const PAYROLL_COST_REPORT_MAX_MONTHS = 24;
/** Months offered by the «Desde» / «Hasta» pickers, counted back from the current month. */
export const PAYROLL_COST_PICKER_MONTHS = 36;
/** Value of the «Todos los grupos» option of the group filter. */
export const ALL_GROUPS_VALUE = "";

/** CSV header the drawer note documents (runbook §18.2). */
export const PAYROLL_COST_CSV_HEADER_NOTE = "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados[;ventas_sin_iva;hab_disponibles;usali]";

export function costGroupOptions(): CocoaSelectOption[] {
  return [{ value: ALL_GROUPS_VALUE, label: "Todos los grupos" }, ...PAYROLL_COST_GROUPS.map((group) => ({ value: group, label: PAYROLL_COST_GROUP_LABELS_ES[group] }))];
}

export function costGroupLabel(group: PayrollCostGroup | string | null | undefined): string {
  if (!group) return "Todos los grupos";
  return (PAYROLL_COST_GROUP_LABELS_ES as Record<string, string>)[group] ?? group;
}

export function usaliLaborDepartmentOptions(): CocoaSelectOption[] {
  return USALI_LABOR_DEPARTMENTS.map((department) => ({ value: department, label: USALI_LABOR_DEPARTMENT_LABELS[department] }));
}

export function usaliDepartmentLabel(department: PayrollCostUsaliDepartment | string | null | undefined): string {
  if (!department) return "—";
  return (USALI_LABOR_DEPARTMENT_LABELS as Record<string, string>)[department] ?? department;
}

export type StatusBadge = { label: string; tone: CocoaTone };

export function importStatusBadge(status: PayrollCostImportStatus | string): StatusBadge {
  const known = (PAYROLL_COST_IMPORT_STATUS_LABELS as Record<string, string>)[status];
  return known ? { label: known, tone: (PAYROLL_COST_IMPORT_STATUS_TONES as Record<string, CocoaTone>)[status] ?? "neutral" } : { label: status, tone: "neutral" };
}

// ---------------------------------------------------------------------------
// Months («YYYY-MM»)
// ---------------------------------------------------------------------------

const MONTH_CODE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthCode(value: string | null | undefined): value is string {
  return typeof value === "string" && MONTH_CODE.test(value);
}

/** «2026-09» of a calendar instant (UTC). */
export function monthCodeOf(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** «2026-01» + 7 → «2026-08»; invalid codes come back unchanged. */
export function addMonths(code: string, delta: number): string {
  const match = MONTH_CODE.exec(code);
  if (!match) return code;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + delta;
  return monthCodeOf(new Date(Date.UTC(year, month, 1)));
}

/** Number of months from `from` to `to`, both inclusive (0 when either code is invalid or `to` precedes `from`). */
export function monthSpan(from: string, to: string): number {
  if (!isMonthCode(from) || !isMonthCode(to)) return 0;
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const span = (ty - fy) * 12 + (tm - fm) + 1;
  return span > 0 ? span : 0;
}

/** Every month between `from` and `to`, inclusive and in order ([] for an invalid or inverted range). */
export function monthsBetween(from: string, to: string): string[] {
  const span = monthSpan(from, to);
  const out: string[] = [];
  for (let index = 0; index < span; index += 1) out.push(addMonths(from, index));
  return out;
}

/** «ene 2026» (es-ES, lib/format) of a month code; the code itself when it is not one. */
export function monthLabel(code: string): string {
  if (!isMonthCode(code)) return code;
  return date(`${code}-01`, "monthYear");
}

/** «ene 2026 – ago 2026»; one month paints once. */
export function monthRangeLabel(from: string, to: string): string {
  if (from === to) return monthLabel(from);
  return `${monthLabel(from)} – ${monthLabel(to)}`;
}

/** Default window of the tab: January of the current year → the current month. */
export function defaultCostRange(now: Date = new Date()): { from: string; to: string } {
  const to = monthCodeOf(now);
  return { from: `${to.slice(0, 4)}-01`, to };
}

/** Options of the «Desde» / «Hasta» pickers: the last `count` months up to the current one, newest last. */
export function monthPickerOptions(now: Date = new Date(), count = PAYROLL_COST_PICKER_MONTHS, extra: readonly string[] = []): CocoaSelectOption[] {
  const current = monthCodeOf(now);
  const codes = new Set<string>();
  for (let index = count - 1; index >= 0; index -= 1) codes.add(addMonths(current, -index));
  for (const code of extra) if (isMonthCode(code)) codes.add(code);
  return [...codes].sort().map((code) => ({ value: code, label: monthLabel(code) }));
}

/**
 * A valid report window: `to` never before `from`, and never wider than
 * `max` months (the API answers 400 past PAYROLL_COST_REPORT_MAX_MONTHS). The
 * month the user just touched wins: moving «Desde» past «Hasta» drags «Hasta»
 * along, and vice versa.
 */
export function clampCostRange(from: string, to: string, touched: "from" | "to" = "from", max = PAYROLL_COST_REPORT_MAX_MONTHS): { from: string; to: string } {
  if (!isMonthCode(from) || !isMonthCode(to)) return { from, to };
  let next = { from, to };
  if (monthSpan(from, to) === 0) next = touched === "from" ? { from, to: from } : { from: to, to };
  if (monthSpan(next.from, next.to) > max) next = touched === "from" ? { from: next.from, to: addMonths(next.from, max - 1) } : { from: addMonths(next.to, -(max - 1)), to: next.to };
  return next;
}

// ---------------------------------------------------------------------------
// Figures (the API derives; the tab only formats)
// ---------------------------------------------------------------------------

/** «12,5» · «16» · «—»: employees or FTE with up to two decimals, no unit. */
export function formatHeadcount(value: string | number | null | undefined): string {
  return number(value, { maximumFractionDigits: 2 });
}

/** «35,1 %» de un porcentaje en puntos («35.12», como lo entrega el API); «—» when null. */
export function formatLaborPct(value: string | null | undefined): string {
  // El API entrega puntos porcentuales con dos decimales («56.34»), no un ratio 0-1.
  return percent(value, { maximumFractionDigits: 1 });
}

export function salesSourceLabel(source: PayrollCostSalesSource | null | undefined): string {
  if (source === "ledger") return "ventas del libro";
  if (source === "reference") return "ventas de referencia del informe";
  return "sin ventas";
}

/**
 * Labor % of a cell or aggregate: the ratio of the PRIMARY sales source the API chose
 * (`salesSource`, ledger coverage rule of contable-6C-03 — the ledger only when it
 * covers the period; 10,33 € of ledger sales no longer paint 23.645.296,81 %). A
 * payload without `salesSource` (older API) falls back to ledger-then-reference.
 */
export function laborPctOf(metrics: Pick<PayrollCostReportMetrics, "laborPctLedger" | "laborPctReference"> & { salesSource?: PayrollCostSalesSource | null }): { value: string | null; source: PayrollCostSalesSource | null } {
  if (metrics.salesSource === "ledger") return { value: metrics.laborPctLedger, source: metrics.laborPctLedger !== null ? "ledger" : null };
  if (metrics.salesSource === "reference") return { value: metrics.laborPctReference, source: metrics.laborPctReference !== null ? "reference" : null };
  if (metrics.salesSource === null) return { value: null, source: null };
  if (metrics.laborPctLedger !== null) return { value: metrics.laborPctLedger, source: "ledger" };
  if (metrics.laborPctReference !== null) return { value: metrics.laborPctReference, source: "reference" };
  return { value: null, source: null };
}

/** «35,1 %» · «35,1 % (ref.)» when the figure comes from the report, · «—». */
export function formatLaborPctCell(metrics: Pick<PayrollCostReportMetrics, "laborPctLedger" | "laborPctReference"> & { salesSource?: PayrollCostSalesSource | null }): string {
  const pct = laborPctOf(metrics);
  if (pct.value === null) return "—";
  return pct.source === "reference" ? `${formatLaborPct(pct.value)} (ref.)` : formatLaborPct(pct.value);
}

// ---------------------------------------------------------------------------
// Matrix centres × months
// ---------------------------------------------------------------------------

export type CostMatrixMetric = "headcount" | "cost" | "costPerEmployee" | "laborPct" | "department";

export type CostMatrixRow = {
  key: string;
  /** Centre of the block (null for the sociedad rows). */
  propertyId: string | null;
  /** Painted on the first row of a block only (the centre name and the expand control). */
  centreLabel: string | null;
  /** Departments the centre could expand into (first row of a centre block; [] otherwise). */
  departments: PayrollCostUsaliDepartment[];
  metric: CostMatrixMetric;
  label: string;
  /** Month code → formatted figure. */
  values: Record<string, string>;
  total: string;
  /** Bold figures (cost rows). */
  emphasis: boolean;
  /** Department rows (indented label). */
  indent: boolean;
  /** Sociedad block (footer rows). */
  society: boolean;
};

function departmentsOf(metrics: PayrollCostReportMetrics): PayrollCostUsaliDepartment[] {
  const present = new Set(metrics.byDepartment.map((row) => row.usaliDepartment));
  return USALI_LABOR_DEPARTMENTS.filter((department) => present.has(department));
}

function departmentCost(metrics: PayrollCostReportMetrics, department: PayrollCostUsaliDepartment): string {
  const row = metrics.byDepartment.find((candidate) => candidate.usaliDepartment === department);
  return row ? money(row.totalCost) : "—";
}

/** The centre label the matrix paints: «Rías Altas (RA)» or the name alone. */
export function centreMatrixLabel(centre: { name: string; code: string | null }): string {
  return centre.code ? `${centre.name} (${centre.code})` : centre.name;
}

/**
 * Rows of the CocoaTable: per centre «Empleados» · «Coste» · «Coste por
 * empleado» · «% s/ ventas», then one row per USALI department when the
 * centre is in `expanded`, then the four rows of the sociedad (or of the
 * filtered centre). Every figure is already derived by the API.
 */
export function costMatrixRows(report: PayrollCostReport, expanded: ReadonlySet<string>): CostMatrixRow[] {
  const rows: CostMatrixRow[] = [];
  for (const centre of report.centres) {
    const byMonth = new Map(centre.cells.map((cell) => [cell.periodCode, cell]));
    const values = (pick: (metrics: PayrollCostReportMetrics) => string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const month of report.months) {
        const cell = byMonth.get(month);
        out[month] = cell ? pick(cell) : "—";
      }
      return out;
    };
    const departments = departmentsOf(centre.totals);
    const label = centreMatrixLabel(centre);
    rows.push({ key: `${centre.propertyId}:headcount`, propertyId: centre.propertyId, centreLabel: label, departments, metric: "headcount", label: "Empleados", values: values((m) => formatHeadcount(m.headcountEffective)), total: formatHeadcount(centre.totals.headcountEffective), emphasis: false, indent: false, society: false });
    rows.push({ key: `${centre.propertyId}:cost`, propertyId: centre.propertyId, centreLabel: null, departments: [], metric: "cost", label: "Coste", values: values((m) => money(m.totalCost)), total: money(centre.totals.totalCost), emphasis: true, indent: false, society: false });
    rows.push({ key: `${centre.propertyId}:costPerEmployee`, propertyId: centre.propertyId, centreLabel: null, departments: [], metric: "costPerEmployee", label: "Coste por empleado", values: values((m) => money(m.costPerEmployee)), total: money(centre.totals.costPerEmployee), emphasis: false, indent: false, society: false });
    rows.push({ key: `${centre.propertyId}:laborPct`, propertyId: centre.propertyId, centreLabel: null, departments: [], metric: "laborPct", label: "% s/ ventas", values: values(formatLaborPctCell), total: formatLaborPctCell(centre.totals), emphasis: false, indent: false, society: false });
    if (expanded.has(centre.propertyId)) {
      for (const department of departments) {
        rows.push({
          key: `${centre.propertyId}:department:${department}`,
          propertyId: centre.propertyId,
          centreLabel: null,
          departments: [],
          metric: "department",
          label: `· ${USALI_LABOR_DEPARTMENT_LABELS[department]}`,
          values: values((m) => departmentCost(m, department)),
          total: departmentCost(centre.totals, department),
          emphasis: false,
          indent: true,
          society: false
        });
      }
    }
  }
  const societyLabel = report.propertyId ? "Total del centro" : "Sociedad";
  const monthly = new Map(report.byMonth.map((month) => [month.periodCode, month]));
  const societyValues = (pick: (metrics: PayrollCostReportMetrics) => string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const month of report.months) {
      const cell = monthly.get(month);
      out[month] = cell ? pick(cell) : "—";
    }
    return out;
  };
  rows.push({ key: "society:headcount", propertyId: null, centreLabel: societyLabel, departments: [], metric: "headcount", label: "Empleados", values: societyValues((m) => formatHeadcount(m.headcountEffective)), total: formatHeadcount(report.totals.headcountAverage), emphasis: false, indent: false, society: true });
  rows.push({ key: "society:cost", propertyId: null, centreLabel: null, departments: [], metric: "cost", label: "Coste", values: societyValues((m) => money(m.totalCost)), total: money(report.totals.totalCost), emphasis: true, indent: false, society: true });
  rows.push({ key: "society:costPerEmployee", propertyId: null, centreLabel: null, departments: [], metric: "costPerEmployee", label: "Coste por empleado", values: societyValues((m) => money(m.costPerEmployee)), total: money(report.totals.costPerEmployeeAverage), emphasis: false, indent: false, society: true });
  rows.push({ key: "society:laborPct", propertyId: null, centreLabel: null, departments: [], metric: "laborPct", label: "% s/ ventas", values: societyValues(formatLaborPctCell), total: formatLaborPctCell(report.totals), emphasis: false, indent: false, society: true });
  return rows;
}

/** Toggle a centre in the expanded set (a new Set: React state). */
export function toggleExpanded(expanded: ReadonlySet<string>, propertyId: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(propertyId)) next.delete(propertyId);
  else next.add(propertyId);
  return next;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** «Coste de personal por mes»: one bar per month of the range; a month without headcount says so instead of «0 empleados» (front-ux-FU-08). */
export function costBars(report: Pick<PayrollCostReport, "byMonth">): CocoaBarsDatum[] {
  return report.byMonth.map((month) => ({
    label: monthLabel(month.periodCode),
    value: Number(month.totalCost) || 0,
    hint: `${monthLabel(month.periodCode)} · bruto ${money(month.gross)} · Seguridad Social ${money(month.employerSs)} · ${month.headcountEffective === null ? "sin dato de empleados" : plural(month.headcountEffective, "empleado", "empleados")}`
  }));
}

/** «Ventas netas por mes»: the primary source of the month (`salesSource`: the ledger when it covers the month, else the reference of the report); the hint names it. */
export function salesBars(report: Pick<PayrollCostReport, "byMonth">): CocoaBarsDatum[] {
  return report.byMonth.map((month) => {
    const ledger = Number(month.ledgerNetSales) || 0;
    const reference = Number(month.netSalesReported ?? 0) || 0;
    const source: PayrollCostSalesSource | null = month.salesSource ?? (ledger > 0 ? "ledger" : reference > 0 ? "reference" : null);
    const value = source === "ledger" ? ledger : source === "reference" ? reference : 0;
    const pct = laborPctOf(month);
    return {
      label: monthLabel(month.periodCode),
      value,
      hint: `${monthLabel(month.periodCode)} · ${salesSourceLabel(source)}${pct.value !== null ? ` · personal ${formatLaborPct(pct.value)}` : ""}`
    };
  });
}

// ---------------------------------------------------------------------------
// Import drawer
// ---------------------------------------------------------------------------

/** CSV or JSON by the file extension, else by the first non-blank character (`{` / `[` → JSON). */
export function detectImportFormat(fileName: string | null | undefined, content: string): PayrollCostImportFormat {
  const name = (fileName ?? "").trim().toLowerCase();
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".csv") || name.endsWith(".txt")) return "csv";
  const first = content.replace(/^\uFEFF/, "").trimStart().charAt(0);
  return first === "{" || first === "[" ? "json" : "csv";
}

/** Documentary source of the lot: the JSON of the RRHH report (carries `fuente`) → informe_rrhh; otherwise the format. */
export function importSourceOf(format: PayrollCostImportFormat, content: string): PayrollCostImportSource {
  if (format === "json" && /"fuente"\s*:/.test(content)) return "informe_rrhh";
  return format;
}

/** Mapping body of preview / create: only the labels the user resolved (empty selections dropped); undefined when nothing was chosen. */
export function buildImportMapping(centres: Readonly<Record<string, string>>, departments: Readonly<Record<string, string>>): PayrollCostMapping | undefined {
  const mapping: PayrollCostMapping = {};
  const chosenCentres = Object.entries(centres).filter(([, propertyId]) => propertyId !== "");
  if (chosenCentres.length > 0) mapping.centres = Object.fromEntries(chosenCentres);
  const chosenDepartments = Object.entries(departments).filter(([, department]) => department !== "");
  if (chosenDepartments.length > 0) mapping.departments = Object.fromEntries(chosenDepartments) as Record<string, PayrollCostUsaliDepartment>;
  return mapping.centres || mapping.departments ? mapping : undefined;
}

/** Preselection of an unmapped centre: its first suggestion, else nothing. */
export function suggestedCentreId(label: PayrollCostUnmappedLabel): string {
  return label.suggestions[0]?.propertyId ?? "";
}

/** Why «Contabilizar» is disabled, in Spanish (empty when the preview can post). */
export function previewBlockers(preview: PayrollCostImportPreview | null): string[] {
  if (!preview) return ["Previsualiza el fichero antes de contabilizar."];
  const out: string[] = [];
  if (preview.errors.length > 0) out.push(plural(preview.errors.length, "fila con error", "filas con error"));
  if (preview.unmappedCentres.length > 0) out.push(plural(preview.unmappedCentres.length, "centro sin asignar", "centros sin asignar"));
  if (preview.unmappedDepartments.length > 0) out.push(plural(preview.unmappedDepartments.length, "departamento sin asignar", "departamentos sin asignar"));
  if (preview.unmappedGroups.length > 0) out.push(plural(preview.unmappedGroups.length, "grupo sin reconocer", "grupos sin reconocer"));
  if (!preview.replace && preview.duplicateOf) out.push("el mismo informe ya está importado");
  if (!preview.replace && preview.overlaps.length > 0) out.push(plural(preview.overlaps.length, "centro y mes ya contabilizado", "centros y meses ya contabilizados"));
  if (out.length === 0 && preview.rowCount === 0) out.push("el fichero no tiene líneas de coste");
  return out;
}

/** Lots `replace: true` would reverse ENTIRELY (duplicate + overlaps, once each), with their range. */
export function replacedImportsSummary(preview: Pick<PayrollCostImportPreview, "duplicateOf" | "overlaps">): string[] {
  const seen = new Map<string, string>();
  if (preview.duplicateOf) seen.set(preview.duplicateOf.importId, `${preview.duplicateOf.fileName ?? preview.duplicateOf.importId} (${monthRangeLabel(preview.duplicateOf.periodFrom, preview.duplicateOf.periodTo)})`);
  for (const overlap of preview.overlaps) {
    if (!seen.has(overlap.importId)) seen.set(overlap.importId, `${overlap.fileName ?? overlap.importId} (${monthRangeLabel(overlap.periodFrom, overlap.periodTo)})`);
  }
  return [...seen.values()];
}

/** «2026/62 · RA · ene 2026 · 45.123,00 €» of an entry of the lot. */
export function entrySummaryLabel(entry: Pick<PayrollCostImportEntryDto, "fiscalYearCode" | "entryNumber" | "propertyCode" | "propertyId" | "periodCode" | "totalDebit">): string {
  const numberLabel = entry.entryNumber !== null ? `${entry.fiscalYearCode ?? "—"}/${entry.entryNumber}` : "sin número";
  return `${numberLabel} · ${entry.propertyCode ?? entry.propertyId} · ${monthLabel(entry.periodCode)} · ${money(entry.totalDebit)}`;
}

/** «48 asientos contabilizados (nº 62–109, ejercicio 2026)». */
export function postedEntriesSummary(entries: readonly Pick<PayrollCostImportEntryDto, "entryNumber" | "fiscalYearCode">[]): string {
  const count = plural(entries.length, "asiento contabilizado", "asientos contabilizados");
  const numbers = entries.map((entry) => entry.entryNumber).filter((value): value is number => value !== null);
  if (numbers.length === 0) return count;
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const years = [...new Set(entries.map((entry) => entry.fiscalYearCode).filter((value): value is string => value !== null))];
  const range = first === last ? `nº ${first}` : `nº ${first}–${last}`;
  return years.length > 0 ? `${count} (${range}, ejercicio ${years.join(", ")})` : `${count} (${range})`;
}

/** Title of the success callout of the drawer. */
export function importResultTitle(result: Pick<PayrollCostImportCreateResult, "entries" | "replacedImportIds">): string {
  const base = postedEntriesSummary(result.entries);
  return result.replacedImportIds.length > 0 ? `${base} · ${plural(result.replacedImportIds.length, "lote anterior revertido", "lotes anteriores revertidos")}` : base;
}

/** Row label of the imports list: file name, else the documentary source. */
export function importFileLabel(record: Pick<PayrollCostImportRecord, "fileName" | "source">): string {
  return record.fileName?.trim() || PAYROLL_COST_SOURCE_LABELS[record.source] || record.source;
}

/** Validation of the reversal reason (3..500, the API contract). */
export function reverseReasonError(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length < 3) return "Indica el motivo del reverso (al menos 3 caracteres).";
  if (trimmed.length > 500) return "El motivo no puede superar los 500 caracteres.";
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const DEFAULT_IMPORT_ERROR = "No se pudo completar la importación del coste de personal.";

function detailStrings(details: Record<string, unknown> | null, key: string): string[] {
  const value = details?.[key];
  return Array.isArray(value) ? value.filter((row): row is string => typeof row === "string" && row.trim() !== "") : [];
}

/**
 * Spanish message of an import error: the finance-contracts sentence of
 * `details.code`, plus the datum the code carries — the unmapped `labels`,
 * the first parse `errors` with their line, the duplicate lot, the number of
 * overlapping cells.
 */
export function payrollCostErrorMessage(error: unknown, fallback: string = DEFAULT_IMPORT_ERROR): string {
  const base = financeErrorMessage(error, fallback);
  const details = financeErrorDetails(error);
  const code = typeof details?.code === "string" ? details.code : null;
  switch (code) {
    case "PAYROLL_IMPORT_CENTRE_UNMAPPED":
    case "PAYROLL_IMPORT_DEPARTMENT_UNMAPPED":
    case "PAYROLL_IMPORT_GROUP_INVALID": {
      const labels = detailStrings(details, "labels");
      return labels.length > 0 ? `${base} Etiquetas: ${labels.join(", ")}.` : base;
    }
    case "PAYROLL_IMPORT_INVALID": {
      const errors = Array.isArray(details?.errors) ? (details.errors as Array<{ line?: unknown; message?: unknown }>) : [];
      const lines = errors
        .filter((row) => typeof row?.message === "string")
        .slice(0, 3)
        .map((row) => (typeof row.line === "number" ? `línea ${row.line}: ${String(row.message)}` : String(row.message)));
      return lines.length > 0 ? `${base} ${lines.join(" · ")}${errors.length > 3 ? ` (y ${errors.length - 3} más)` : ""}.` : base;
    }
    case "PAYROLL_IMPORT_DUPLICATE": {
      const fileName = typeof details?.fileName === "string" && details.fileName.trim() ? details.fileName.trim() : null;
      const importId = typeof details?.importId === "string" ? details.importId : null;
      const lot = fileName ?? importId;
      return lot ? `${base} Lote: ${lot}.` : base;
    }
    case "PAYROLL_IMPORT_OVERLAP": {
      const overlaps = Array.isArray(details?.overlaps) ? details.overlaps.length : 0;
      return overlaps > 0 ? `${base} ${plural(overlaps, "celda afectada", "celdas afectadas")}.` : base;
    }
    default:
      return base;
  }
}
