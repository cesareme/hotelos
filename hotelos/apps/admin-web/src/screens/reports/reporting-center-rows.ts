// Rows, range presets and export copy of the Centro de informes (/informes).
// Pure so the dedupe rule, the date range of a preset and the catalogue
// labels are unit-testable (Tanda UX-2 · lote D6).

import { time } from "../../lib/format";

/**
 * One row per folio for the billing-report table.
 *
 * GET /reports/properties/:id/billing resolves every folio through its
 * reservation (`reporting.service.ts`: `getReservationFolio(folio.reservationId)`
 * per folio row), so a reservation with two folios yields the same folio twice
 * with identical fields (Rías Altas, 2026-09-15: 36 rows, 35 folios). Keeping
 * the first occurrence keeps the CocoaTable keys unique (React warned
 * «Encountered two children with the same key» on every load, qa#3) and the
 * «N folios» caption honest.
 */
export function uniqueByFolio<Row extends { folioId: string }>(rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  const unique: Row[] = [];
  for (const row of rows) {
    if (seen.has(row.folioId)) continue;
    seen.add(row.folioId);
    unique.push(row);
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Export download (FIX-1 · F5). The status line names the file, never the
// download URL (the old copy interpolated `export.downloadUrl`, which the API
// did not send → «Exportación lista: undefined»). Pure except for the DOM
// anchor that `saveBlobAs` needs to trigger the browser download.
// ---------------------------------------------------------------------------

export type ReportExportLike = {
  export: { filename: string; contentType: string };
  content: string;
};

/** «informe-….csv · disponible hasta 12:15» (Madrid); only the file name when the API sent no `expiresAt`. */
export function exportReadyDetail(result: { export: { filename: string; expiresAt?: string } }): string {
  const until = result.export.expiresAt ? time(result.export.expiresAt, { empty: "" }) : "";
  return until ? `${result.export.filename} · disponible hasta ${until}` : result.export.filename;
}

/** Status line and toast of a finished export: «Exportación lista: informe-….csv · disponible hasta 12:15». */
export function exportStatusMessage(result: { export: { filename: string; expiresAt?: string } }): string {
  return `Exportación lista: ${exportReadyDetail(result)}`;
}

/** Browser download of a blob under `filename` (same pattern as revenueExportApi.downloadGeneratedExport). */
export function saveBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Inline download of the export just generated (the response carries the file body). */
export function downloadReportExport(result: ReportExportLike): void {
  saveBlobAs(new Blob([result.content], { type: result.export.contentType }), result.export.filename);
}

// ---------------------------------------------------------------------------
// Range presets (UX-2 · D6, recon Δ11 / FIX-1 §1.5): the export used to post a
// fixed «2026-05-01 … 2026-05-31». The preset resolves against `today` (the
// Madrid calendar day the screen passes) with UTC arithmetic on the ISO parts,
// so there is no DST drift and the maths is testable without a clock.
// ---------------------------------------------------------------------------

export type RangePreset = "this_month" | "previous_month" | "last_30_days" | "custom";

export type DateRange = { fromDate: string; toDate: string };

export const RANGE_PRESET_OPTIONS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "this_month", label: "Este mes" },
  { value: "previous_month", label: "Mes anterior" },
  { value: "last_30_days", label: "Últimos 30 días" },
  { value: "custom", label: "Personalizado" }
];

/** Days of the «Últimos 30 días» preset, `today` included (today − 29 … today). */
export const LAST_DAYS_WINDOW = 30;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDay(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/**
 * Date range of a preset for `today` («YYYY-MM-DD»): this month → 1st … today;
 * previous month → 1st … last day of the month before (28/29/30/31, December
 * of the previous year in January); last 30 days → today − 29 … today;
 * custom → this month as the starting values the pickers then edit.
 * A malformed `today` falls back to the local calendar day.
 */
export function rangeForPreset(preset: RangePreset, today: string): DateRange {
  const match = ISO_DAY.exec(today) ?? ISO_DAY.exec(new Date().toISOString().slice(0, 10))!;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  switch (preset) {
    case "previous_month":
      return { fromDate: utcDay(year, monthIndex - 1, 1), toDate: utcDay(year, monthIndex, 0) };
    case "last_30_days":
      return { fromDate: utcDay(year, monthIndex, day - (LAST_DAYS_WINDOW - 1)), toDate: utcDay(year, monthIndex, day) };
    case "this_month":
    case "custom":
    default:
      return { fromDate: utcDay(year, monthIndex, 1), toDate: utcDay(year, monthIndex, day) };
  }
}

/** Label of a preset («Este mes»); the value itself for an unknown one. */
export function rangePresetLabel(preset: string): string {
  return RANGE_PRESET_OPTIONS.find((option) => option.value === preset)?.label ?? preset;
}

// ---------------------------------------------------------------------------
// Report types, formats and catalogue labels. The API still delivers printable
// HTML for «pdf» and CSV for «xlsx» (reporting.service.ts contentTypeFor), so
// the option labels say so instead of promising a PDF or a workbook.
// ---------------------------------------------------------------------------

export type ReportFormat = "pdf" | "csv" | "xlsx" | "json";

export const REPORT_TYPE_LABELS: Record<string, string> = {
  reservation: "Reservas",
  billing: "Facturación",
  revenue: "Revenue",
  owner: "Propietario"
};

export const FORMAT_OPTIONS: ReadonlyArray<{ value: ReportFormat; label: string }> = [
  { value: "pdf", label: "PDF (HTML imprimible)" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "XLSX (se entrega CSV)" },
  { value: "json", label: "JSON" }
];

/** Honest label of a format («PDF (HTML imprimible)»); the code in upper case for an unknown one. */
export function formatLabel(format: string): string {
  return FORMAT_OPTIONS.find((option) => option.value === format)?.label ?? format.toUpperCase();
}

/**
 * Title of a catalogue row from REPORT_TYPE_LABELS: the catalogue codes start
 * with the report type (`reservation_arrivals_departures` → «Reservas»,
 * `billing_invoice_payment` → «Facturación», `revenue_history_forecast` →
 * «Revenue»); a code outside the map keeps the API title, then the code.
 */
export function catalogRowTitle(report: { code: string; title?: string }): string {
  const type = Object.keys(REPORT_TYPE_LABELS).find((key) => report.code === key || report.code.startsWith(`${key}_`));
  return (type && REPORT_TYPE_LABELS[type]) || report.title || report.code;
}

/**
 * Secondary line of a catalogue row: the description when the API sends one,
 * else the API title without the «<título>: » prefix («Reservas: llegadas y
 * salidas» → «Llegadas y salidas»); nothing when it would repeat the title.
 */
export function catalogRowDetail(report: { code: string; title?: string; description?: string }): string | undefined {
  if (report.description) return report.description;
  const title = catalogRowTitle(report);
  const apiTitle = report.title?.trim();
  if (!apiTitle || apiTitle === title) return undefined;
  const prefix = `${title}:`;
  if (!apiTitle.startsWith(prefix)) return apiTitle;
  const rest = apiTitle.slice(prefix.length).trim();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : undefined;
}

/**
 * Whether an Enter keydown inside the export form should run the export
 * (pure). Chromium does not implicitly submit a form from `<input type="date">`
 * or a `<select>`, so the form handles Enter itself: a plain Enter on a field
 * exports; buttons and links keep their own Enter (the submit button already
 * submits, «Abrir histórico…» navigates); a keydown the date picker consumed
 * (`defaultPrevented`: its arithmetic buffer resolved «+7» / «hoy» first) and
 * any modifier combination are left alone.
 */
export function isExportEnter(event: { key: string; defaultPrevented?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; tagName?: string }): boolean {
  if (event.key !== "Enter" || event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const tag = (event.tagName ?? "").toUpperCase();
  return tag !== "BUTTON" && tag !== "A" && tag !== "TEXTAREA";
}

/** Accessible name of the export form: «Exportar informe de reservas (este mes)». */
export function exportFormLabel(reportType: string, preset: string): string {
  const report = (REPORT_TYPE_LABELS[reportType] ?? reportType).toLowerCase();
  return `Exportar informe de ${report} (${rangePresetLabel(preset).toLowerCase()})`;
}
