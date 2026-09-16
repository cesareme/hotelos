// Cumplimiento › Modelos AEAT (Cocoa 22 · ola 8 · lote 8-B) — pure helpers
// shared by the six model screens (FiscalModelReport.tsx), the VAT books and
// the VAT settlement: period pickers, Spanish labels of the wire contract
// (packages/shared/src/fiscal-types.ts), box/total formatting through
// lib/format, the fiscal error mapping on top of finance-contracts.ts, the
// client-side CSV of a VAT book and the blob download. No React, no network:
// screens/fiscal/__tests__/fiscal-shared.test.mts runs it under node --test.

import type { FiscalBox, FiscalBoxKind, FiscalModelCode, FiscalPeriodDto, FiscalReportSources, VatBookName, VatBookRowDto, VatBookSourceTypeCode, VatPeriodicityCode, VatRegimeCode } from "@hotelos/shared";
import { UI_STATES } from "../../content/actions";
import { date, dateRange, dateTime, money, number, percent } from "../../lib/format";
import { financeErrorCode, financeErrorMessage, financeErrorStatus, isAnnualFiscalModel, monthPeriod, periodBounds, quarterPeriod, yearPeriod } from "../../services/finance-contracts";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** How a model is filed: the 303 follows the VAT periodicity of the organisation; 111/115 are quarterly; 390/347/180 are annual. */
export type FiscalModelPeriodKind = "settlement" | "quarterly" | "annual";

export function modelPeriodKind(modelo: FiscalModelCode): FiscalModelPeriodKind {
  if (isAnnualFiscalModel(modelo)) return "annual";
  return modelo === "303" ? "settlement" : "quarterly";
}

export const MODEL_SUBTITLES: Readonly<Record<FiscalModelCode, string>> = Object.freeze({
  "303": "Autoliquidación del IVA del periodo a partir de los libros registro: casillas oficiales, cotejo con el diario y resumen para la sede de la AEAT.",
  "390": "Declaración-resumen anual del IVA: suma de los periodos del ejercicio por clave del formulario (numeración de casillas pendiente de validar con la gestoría).",
  "347": "Declaración anual de operaciones con terceros: importes por NIF y trimestre por encima del umbral, a partir de los libros de IVA.",
  "111": "Retenciones e ingresos a cuenta del IRPF del periodo (trabajo, actividades económicas, premios) a partir de los registros de retención.",
  "115": "Retenciones del periodo sobre rentas de arrendamiento de inmuebles urbanos.",
  "180": "Resumen anual de las retenciones sobre arrendamientos de inmuebles urbanos, con el detalle por arrendador."
});

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export type SelectOption = { value: string; label: string };

const MONTHS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"] as const;

export const QUARTER_OPTIONS: readonly SelectOption[] = Object.freeze([
  { value: "1", label: "1T · enero a marzo" },
  { value: "2", label: "2T · abril a junio" },
  { value: "3", label: "3T · julio a septiembre" },
  { value: "4", label: "4T · octubre a diciembre" }
]);

export const MONTH_OPTIONS: readonly SelectOption[] = Object.freeze(MONTHS_ES.map((label, index) => ({ value: String(index + 1).padStart(2, "0"), label })));

/** Years offered by the pickers: the current one and the three before it (older data is read through the URL of the API). */
export function yearOptions(now: Date | string = new Date(), span = 4): SelectOption[] {
  const current = Number(yearPeriod(now));
  return Array.from({ length: span }, (_, index) => String(current - index)).map((value) => ({ value, label: value }));
}

/** Current quarter (`"3"`) and month (`"09"`) of a calendar day. */
export function currentQuarter(now: Date | string = new Date()): string {
  return quarterPeriod(now).slice(-1);
}

export function currentMonth(now: Date | string = new Date()): string {
  return monthPeriod(now).slice(-2);
}

/** Settlement period code of a picker state: `2026-Q3` · `2026-09` · `2026`. */
export function periodCodeOf(input: { kind: "quarterly" | "monthly" | "annual"; year: string; quarter?: string; month?: string }): string {
  if (input.kind === "annual") return input.year;
  if (input.kind === "monthly") return `${input.year}-${(input.month ?? "01").padStart(2, "0")}`;
  return `${input.year}-Q${input.quarter ?? "1"}`;
}

/** Periods of a year for the VAT book picker: the whole year, its quarters and (monthly organisations) its months. */
export function bookPeriodOptions(year: string, periodicity: VatPeriodicityCode): SelectOption[] {
  const options: SelectOption[] = [{ value: year, label: `Todo el ejercicio ${year}` }];
  for (const quarter of QUARTER_OPTIONS) options.push({ value: `${year}-Q${quarter.value}`, label: quarter.label });
  if (periodicity === "monthly") for (const month of MONTH_OPTIONS) options.push({ value: `${year}-${month.value}`, label: month.label });
  return options;
}

/** «3T 2026 · 1 jul – 30 sept 2026» / «Ejercicio 2026» / «Septiembre de 2026». */
export function describePeriod(periodo: Pick<FiscalPeriodDto, "type" | "year" | "quarter" | "month" | "from" | "to" | "aeatPeriod">): string {
  const range = dateRange(periodo.from, periodo.to);
  if (periodo.type === "annual") return `Ejercicio ${periodo.year} · ${range}`;
  if (periodo.type === "monthly" && periodo.month) return `${MONTHS_ES[periodo.month - 1]} de ${periodo.year} · ${range}`;
  return `${periodo.aeatPeriod} ${periodo.year} · ${range}`;
}

/** True when the period has ended before `today` (the settlement entry is only posted at period end). */
export function periodHasEnded(periodo: Pick<FiscalPeriodDto, "to">, today: string): boolean {
  return periodo.to < today;
}

/** Calendar bounds of a period code, for the VAT book title («Del 1 de julio al 30 de septiembre de 2026»). */
export function periodRangeLabel(code: string): string | null {
  const bounds = periodBounds(code);
  return bounds ? dateRange(bounds.from, bounds.to) : null;
}

// ---------------------------------------------------------------------------
// Labels of the wire contract
// ---------------------------------------------------------------------------

export const BOX_KIND_LABELS: Readonly<Record<FiscalBoxKind, string>> = Object.freeze({
  base: "Base",
  tipo: "Tipo",
  cuota: "Cuota",
  resultado: "Resultado",
  info: "Información",
  contador: "Recuento"
});

export const NO_BOX_LABEL = "sin casilla (validar)";

export const ORIGEN_LABELS: Readonly<Record<FiscalReportSources["origen"], string>> = Object.freeze({
  libros: "Libros registro materializados",
  documentos: "Calculado desde los documentos (libros sin materializar)",
  retenciones: "Registros de retención",
  modelos_303: "Suma de los modelos 303 del ejercicio"
});

export const BOOK_LABELS: Readonly<Record<VatBookName, string>> = Object.freeze({
  emitidas: "Facturas emitidas",
  recibidas: "Facturas recibidas",
  bienes_inversion: "Bienes de inversión"
});

export const BOOK_ORDER: readonly VatBookName[] = Object.freeze(["emitidas", "recibidas", "bienes_inversion"]);

export const SOURCE_TYPE_LABELS: Readonly<Record<VatBookSourceTypeCode, string>> = Object.freeze({
  invoice: "Factura",
  rectification: "Rectificativa",
  simplified: "Factura simplificada",
  supplier_bill: "Factura recibida",
  expense: "Gasto"
});

export const PERIODICITY_LABELS: Readonly<Record<VatPeriodicityCode, string>> = Object.freeze({ quarterly: "Trimestral", monthly: "Mensual" });

export const REGIME_LABELS: Readonly<Record<VatRegimeCode, string>> = Object.freeze({
  general: "Régimen general",
  redeme: "REDEME (devolución mensual)",
  recargo: "Recargo de equivalencia"
});

/** `totales` keys of the six models → Spanish label; unknown keys fall back to the key itself. */
export const TOTALES_LABELS: Readonly<Record<string, string>> = Object.freeze({
  baseDevengada: "Base imponible devengada",
  cuotaDevengada: "Cuota devengada",
  baseDeducible: "Base deducible",
  cuotaDeducible: "Cuota deducible",
  resultadoRegimenGeneral: "Resultado del régimen general",
  compensacionPendienteInicial: "Compensación pendiente inicial",
  compensacionAplicada: "Compensación aplicada",
  compensacionPendienteFinal: "Compensación pendiente final",
  compensacionPendienteFin: "Compensación pendiente al cierre",
  resultado: "Resultado",
  aIngresar: "A ingresar",
  aCompensar: "A compensar",
  resultadoLiquidaciones: "Resultado de las liquidaciones",
  volumenOperaciones: "Volumen de operaciones",
  periodos: "Periodos del ejercicio",
  periodosLiquidados: "Periodos liquidados",
  declarados: "Terceros declarados",
  importeTotal: "Importe total declarado",
  tercerosBajoUmbral: "Terceros bajo el umbral",
  filasSinNif: "Filas sin NIF",
  importeSinNif: "Importe sin NIF",
  filasConRetencion: "Filas con retención",
  importeConRetencion: "Importe con retención",
  perceptores: "Perceptores",
  base: "Base",
  retenciones: "Retenciones",
  registros: "Registros leídos"
});

/** `detalle[]` keys (390 per period · 347 per third party · 180 per lessor · 111 per row) → Spanish column label. */
export const DETALLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  periodo: "Periodo",
  periodoAeat: "Periodo AEAT",
  baseDevengada: "Base devengada",
  cuotaDevengada: "Cuota devengada",
  cuotaDeducible: "Cuota deducible",
  resultado: "Resultado",
  liquidado: "Liquidado",
  nif: "NIF",
  nombre: "Nombre o razón social",
  clave: "Clave",
  importeAnual: "Importe anual",
  t1: "1T",
  t2: "2T",
  t3: "3T",
  t4: "4T",
  filas: "Filas",
  concepto: "Concepto",
  perceptores: "Perceptores",
  base: "Base",
  retenciones: "Retenciones",
  registros: "Registros",
  direccion: "Dirección del inmueble",
  referenciaCatastral: "Referencia catastral",
  importeIntegro: "Importe íntegro",
  retencion: "Retención"
});

const COUNTER_KEY = /^(periodos|periodosLiquidados|declarados|tercerosBajoUmbral|filasSinNif|filasConRetencion|perceptores|registros|filas)$/;

/** Counters (people, rows, periods) are painted as integers; every other total is money. */
export function isCounterKey(key: string): boolean {
  return COUNTER_KEY.test(key);
}

export function formatTotal(key: string, value: number): string {
  return isCounterKey(key) ? number(value, { maximumFractionDigits: 0 }) : money(value);
}

/** Value of a box as printed: rates as «21 %», counters as integers, everything else as money. */
export function formatBoxValue(box: Pick<FiscalBox, "tipo" | "importe">): string {
  if (box.tipo === "tipo") return percent(box.importe, { maximumFractionDigits: 2 });
  if (box.tipo === "contador") return number(box.importe, { maximumFractionDigits: 0 });
  return money(box.importe);
}

/** A box worth hiding behind «Ocultar casillas a cero»: zero amount that is neither a rate nor a result line. */
export function isZeroBox(box: Pick<FiscalBox, "tipo" | "importe">): boolean {
  return box.importe === 0 && box.tipo !== "tipo" && box.tipo !== "resultado";
}

/** Boxes grouped by form section, in the order the API lists them. */
export function groupBoxesBySection<T extends Pick<FiscalBox, "seccion">>(boxes: readonly T[]): Array<{ seccion: string; boxes: T[] }> {
  const groups: Array<{ seccion: string; boxes: T[] }> = [];
  for (const box of boxes) {
    const last = groups[groups.length - 1];
    if (last && last.seccion === box.seccion) last.boxes.push(box);
    else groups.push({ seccion: box.seccion, boxes: [box] });
  }
  return groups;
}

/** One `detalle[]` cell: money for amounts, integers for counters, «Sí»/«No» for the 390 flag, «—» for null. */
export function formatDetalleCell(key: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return isCounterKey(key) ? number(value, { maximumFractionDigits: 0 }) : money(value);
  if (key === "liquidado") return value === "si" || value === "sí" ? "Sí" : value === "no" ? "No" : value;
  return value;
}

/** Headline totals per model, in KPI order (missing keys are skipped). */
export const KPI_KEYS: Readonly<Record<FiscalModelCode, readonly string[]>> = Object.freeze({
  "303": ["resultado", "cuotaDevengada", "cuotaDeducible", "baseDevengada"],
  "390": ["resultadoLiquidaciones", "cuotaDevengada", "cuotaDeducible", "volumenOperaciones", "periodosLiquidados"],
  "347": ["declarados", "importeTotal", "tercerosBajoUmbral", "importeSinNif"],
  "111": ["resultado", "retenciones", "base", "perceptores"],
  "115": ["resultado", "retenciones", "base", "perceptores"],
  "180": ["retenciones", "base", "perceptores", "registros"]
});

/**
 * Longest KPI headline that fits a six-tile CocoaKpiStrip at 1440 px (tile ≈ 163 px,
 * 11 px uppercase label with wide tracking, nowrap + ellipsis by design).
 */
export const KPI_LABEL_MAX_CHARS = 24;

/** Short headlines for KPI tiles only; the «Totales» table keeps the full TOTALES_LABELS wording (qa#7). */
export const KPI_LABELS: Readonly<Record<string, string>> = Object.freeze({
  resultadoLiquidaciones: "Resultado liquidaciones"
});

/** Label of a headline total on a KPI tile: the short form when one exists, otherwise the table wording. */
export function kpiLabel(key: string): string {
  return KPI_LABELS[key] ?? TOTALES_LABELS[key] ?? key;
}

/** Caption under the 303 result: what the sign means for the return. */
export function resultadoCaption(totales: Record<string, number>): string | undefined {
  if ((totales.aIngresar ?? 0) > 0) return "a ingresar";
  if ((totales.aCompensar ?? 0) > 0) return "a compensar";
  if (totales.resultado === 0) return "sin resultado";
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const FISCAL_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PERIOD_NOT_ENDED: "El periodo no ha terminado: la liquidación se contabiliza al cierre del periodo.",
  ALREADY_SETTLED: "El periodo ya está liquidado: anula el asiento vigente antes de volver a contabilizarlo.",
  NOTHING_TO_SETTLE: "Sin cuotas de IVA en el periodo: no hay nada que liquidar.",
  ALREADY_REVERSED: "El asiento de liquidación ya está anulado.",
  PERIOD_CLOSED: "El periodo contable de la fecha del asiento está cerrado: reábrelo o cambia la fecha.",
  PERIOD_MISMATCH: "El periodo no coincide con la periodicidad del IVA de la organización: elige un trimestre o un mes según sus ajustes.",
  REDEME_REQUIRES_MONTHLY: "El régimen REDEME (devolución mensual) exige periodicidad mensual."
});

/** Spanish message of a fiscal error: local codes first, then finance-contracts.ts (code → API message → fallback); 403 explains the missing permission. */
export function fiscalErrorText(error: unknown, fallback = "No se pudo completar la operación. Inténtalo de nuevo."): string {
  const code = financeErrorCode(error);
  if (code && FISCAL_ERROR_MESSAGES[code]) return FISCAL_ERROR_MESSAGES[code];
  if (financeErrorStatus(error) === 403) return UI_STATES.forbidden.message;
  return financeErrorMessage(error, fallback);
}

/** The ledger refused the date because the fiscal year is closed: the screen offers the year-end screen. */
export function isFiscalYearClosed(error: unknown): boolean {
  return financeErrorCode(error) === "FISCAL_YEAR_CLOSED";
}

// ---------------------------------------------------------------------------
// VAT book helpers
// ---------------------------------------------------------------------------

export type VatBookTotals = { filas: number; base: number; cuota: number; total: number; retencion: number };

/** Totals of the rows on screen (after the search filter), rounded to cents. */
export function sumVatBookRows(rows: readonly Pick<VatBookRowDto, "base" | "quota" | "total" | "retention">[]): VatBookTotals {
  const round = (value: number) => Math.round(value * 100) / 100;
  let base = 0;
  let cuota = 0;
  let total = 0;
  let retencion = 0;
  for (const row of rows) {
    base += row.base;
    cuota += row.quota;
    total += row.total;
    retencion += row.retention;
  }
  return { filas: rows.length, base: round(base), cuota: round(cuota), total: round(total), retencion: round(retencion) };
}

/** Case- and accent-insensitive match of the search text against number, series, NIF and name. */
export function matchesVatBookSearch(row: Pick<VatBookRowDto, "number" | "series" | "counterpartyNif" | "counterpartyName">, search: string): boolean {
  const needle = normalise(search);
  if (!needle) return true;
  return [row.number, row.series, row.counterpartyNif, row.counterpartyName].some((field) => normalise(field ?? "").includes(needle));
}

function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const CSV_HEADER = ["Libro", "Fecha", "Serie", "Número", "NIF", "Nombre", "Base", "Tipo (%)", "Cuota", "Total", "Retención", "Recargo (%)", "Cuota recargo", "Figura", "Deducible", "Origen", "Identificador", "Periodo", "Establecimiento"] as const;

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value.toFixed(2).replace(".", ",");
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV of a VAT book as shown on screen: `;` separated, decimal comma, UTF-8 with BOM (the convention of the gestoría exports). */
export function vatBookCsv(rows: readonly VatBookRowDto[]): string {
  const lines = [CSV_HEADER.join(";")];
  for (const row of rows) {
    lines.push(
      [
        BOOK_LABELS[row.book],
        row.date,
        row.series,
        row.number,
        row.counterpartyNif,
        row.counterpartyName,
        row.base,
        row.rate,
        row.quota,
        row.total,
        row.retention,
        row.surchargeRate,
        row.surchargeQuota,
        row.taxFigure,
        row.deductible,
        SOURCE_TYPE_LABELS[row.sourceType] ?? row.sourceType,
        row.sourceId,
        row.period,
        row.propertyId
      ]
        .map(csvCell)
        .join(";")
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Hands a blob to the browser as a named file (object URL revoked once the click has been consumed). */
export function saveDownload(download: { blob: Blob; filename: string }): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = download.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** «Generado el 16/09/2026, 10:42». */
export function generatedAtLabel(generatedAt: string): string {
  return `Generado el ${dateTime(generatedAt)}`;
}

/** «Asiento n.º 12 · 30/09/2026 · ejercicio 2026» of a settlement entry. */
export function settlementEntryLabel(entry: { entryNumber: number | null; journalEntryId: string; entryDate: string; fiscalYearCode?: string | null }): string {
  const numero = entry.entryNumber !== null ? `Asiento n.º ${number(entry.entryNumber, { maximumFractionDigits: 0 })}` : `Asiento ${entry.journalEntryId}`;
  const year = entry.fiscalYearCode ? ` · ejercicio ${entry.fiscalYearCode}` : "";
  return `${numero} · ${date(entry.entryDate, "short")}${year}`;
}
