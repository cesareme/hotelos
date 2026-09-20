import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  FORMAT_OPTIONS,
  LAST_DAYS_WINDOW,
  RANGE_PRESET_OPTIONS,
  REPORT_TYPE_LABELS,
  catalogRowDetail,
  catalogRowTitle,
  downloadReportExport,
  exportFormLabel,
  exportReadyDetail,
  exportStatusMessage,
  formatLabel,
  isExportEnter,
  rangeForPreset,
  rangePresetLabel,
  uniqueByFolio
} from "../reporting-center-rows.ts";

const SCREEN_SOURCE = readFileSync(new URL("../ReportingCenterScreen.tsx", import.meta.url), "utf8");
const ROWS_SOURCE = readFileSync(new URL("../reporting-center-rows.ts", import.meta.url), "utf8");

// qa#3 (Cocoa 22 · ola 9 · lote 9-A): the billing report repeats a folio when
// its reservation has two folios; the table key is the folio id.
describe("Centro de informes · filas del informe de facturación", () => {
  const closed = { folioId: "cmu1jic6q00bjfywhnr7671sc", status: "closed", balanceDue: 0, currency: "EUR" };
  const open = { folioId: "folio-open", status: "open", balanceDue: 120.5, currency: "EUR" };

  it("keeps the first occurrence of a repeated folio and the original order", () => {
    assert.deepEqual(uniqueByFolio([open, closed, { ...closed }]), [open, closed]);
    assert.deepEqual(uniqueByFolio([closed, open, closed, open]), [closed, open]);
  });

  it("is the identity on unique rows and on an empty report", () => {
    assert.deepEqual(uniqueByFolio([open, closed]), [open, closed]);
    assert.deepEqual(uniqueByFolio([]), []);
  });

  it("yields unique table keys (folioId) for any input", () => {
    const rows = uniqueByFolio([closed, closed, open, closed, open]);
    assert.equal(new Set(rows.map((r) => r.folioId)).size, rows.length);
  });
});

// FIX-1 · F5: «Generar exportación» ended with «Exportación lista: undefined»
// because the status line interpolated `export.downloadUrl`, which the API did
// not send. The status names the file; the download is inline (Blob) plus the
// authenticated GET /reports/exports/:id/download behind a Cocoa button.
describe("Centro de informes · exportación descargable (F5)", () => {
  const result = {
    export: {
      id: "report_export_abc",
      filename: "informe-reservation-prop_123-2026-09-19.csv",
      contentType: "text/csv;charset=utf-8",
      downloadUrl: "/reports/exports/report_export_abc/download",
      expiresAt: "2026-09-19T10:15:00.000Z"
    },
    content: "code;guestName\nRES-1;Huésped"
  };

  it("exportStatusMessage names the file and the expiry (Madrid time), never the URL nor «undefined»", () => {
    // 10:15Z on 2026-09-19 is 12:15 in Madrid (CEST).
    assert.equal(exportStatusMessage(result), "Exportación lista: informe-reservation-prop_123-2026-09-19.csv · disponible hasta 12:15");
    assert.equal(exportReadyDetail(result), "informe-reservation-prop_123-2026-09-19.csv · disponible hasta 12:15");
    assert.doesNotMatch(exportStatusMessage(result), /undefined|\/reports\/exports/);
    // Without `expiresAt` (older API) the message is still the file name.
    assert.equal(exportStatusMessage({ export: { filename: "x.csv" } }), "Exportación lista: x.csv");
  });

  it("downloadReportExport is a DOM download of the response body (fails only when there is no document)", () => {
    // Node has Blob and URL.createObjectURL but no document: the helper must
    // reach the anchor step (it does not throw before touching the DOM).
    assert.throws(() => downloadReportExport(result), /document is not defined/);
  });

  it("source contract: the screen never interpolates export.downloadUrl in the status nor renders an inline-styled anchor", () => {
    assert.doesNotMatch(SCREEN_SOURCE, /Exportación lista: \$\{/, "the status line goes through exportStatusMessage()");
    assert.doesNotMatch(SCREEN_SOURCE, /\$\{[^}]*export\.downloadUrl[^}]*\}/, "export.downloadUrl is never interpolated into copy");
    assert.doesNotMatch(SCREEN_SOURCE, /href=\{[^}]*downloadUrl/, "no anchor to the download URL (it is an authenticated route)");
    assert.doesNotMatch(SCREEN_SOURCE, /linkStyle/, "the inline-styled link is gone");
    assert.match(SCREEN_SOURCE, /const message = exportStatusMessage\(result\);[\s\S]{0,40}setStatus\(message\)/, "handleExport uses the file name");
    assert.match(SCREEN_SOURCE, /showToast\(message, \{ variant: "success", announce: false \}\)/, "the same text goes to the toast (silent: the status callout announces)");
    assert.match(SCREEN_SOURCE, /<span>\{exportReadyDetail\(reports\.exportResult\)\}<\/span>/, "the callout body is «<fichero> · disponible hasta HH:MM»");
    assert.match(SCREEN_SOURCE, /downloadReportExport\(result\)/, "inline download right after the export");
    assert.match(SCREEN_SOURCE, /fetchReportExportFile\(result\.export\.downloadUrl\)/, "second download goes through the authenticated route");
    assert.match(SCREEN_SOURCE, /<CocoaButton[^>]*onClick=\{\(\) => void handleDownloadAgain\([\s\S]{0,200}Descargar exportación/, "Cocoa button «Descargar exportación»");
    assert.equal((SCREEN_SOURCE.match(/style=\{/g) ?? []).length, 3, "no new inline style= (subStyle span + the two CocoaSection overflow props predate F5)");
  });

  it("the download helpers live in reporting-center-rows and follow the revenueExportApi Blob pattern", () => {
    assert.match(ROWS_SOURCE, /export function saveBlobAs\(blob: Blob, filename: string\): void/);
    assert.match(ROWS_SOURCE, /URL\.createObjectURL\(blob\)[\s\S]*anchor\.download = filename[\s\S]*URL\.revokeObjectURL\(url\)/);
  });
});

// Tanda UX-2 · lote D6 (F-D6, recon Δ11): the export used to post a fixed
// «2026-05-01 … 2026-05-31»; the range now comes from a preset resolved
// against today, the format labels say what the API delivers and the
// catalogue titles come from REPORT_TYPE_LABELS.
describe("Centro de informes · rango de la exportación (rangeForPreset)", () => {
  it("«Este mes»: from the 1st up to today (also on the last day of the month)", () => {
    assert.deepEqual(rangeForPreset("this_month", "2026-09-20"), { fromDate: "2026-09-01", toDate: "2026-09-20" });
    assert.deepEqual(rangeForPreset("this_month", "2026-09-30"), { fromDate: "2026-09-01", toDate: "2026-09-30" });
    assert.deepEqual(rangeForPreset("this_month", "2026-01-01"), { fromDate: "2026-01-01", toDate: "2026-01-01" });
  });

  it("«Mes anterior»: whole previous month with its real end (31, 30, 28 or 29) and the year change in January", () => {
    assert.deepEqual(rangeForPreset("previous_month", "2026-09-20"), { fromDate: "2026-08-01", toDate: "2026-08-31" });
    assert.deepEqual(rangeForPreset("previous_month", "2026-10-05"), { fromDate: "2026-09-01", toDate: "2026-09-30" });
    assert.deepEqual(rangeForPreset("previous_month", "2026-03-15"), { fromDate: "2026-02-01", toDate: "2026-02-28" });
    assert.deepEqual(rangeForPreset("previous_month", "2028-03-15"), { fromDate: "2028-02-01", toDate: "2028-02-29" });
    assert.deepEqual(rangeForPreset("previous_month", "2026-01-10"), { fromDate: "2025-12-01", toDate: "2025-12-31" });
  });

  it("«Últimos 30 días»: today included, across month and year boundaries", () => {
    assert.equal(LAST_DAYS_WINDOW, 30);
    assert.deepEqual(rangeForPreset("last_30_days", "2026-09-20"), { fromDate: "2026-08-22", toDate: "2026-09-20" });
    assert.deepEqual(rangeForPreset("last_30_days", "2026-03-01"), { fromDate: "2026-01-31", toDate: "2026-03-01" });
    assert.deepEqual(rangeForPreset("last_30_days", "2026-01-15"), { fromDate: "2025-12-17", toDate: "2026-01-15" });
  });

  it("«Personalizado» starts from this month (the pickers then edit it); a malformed today never throws", () => {
    assert.deepEqual(rangeForPreset("custom", "2026-09-20"), rangeForPreset("this_month", "2026-09-20"));
    const fallback = rangeForPreset("this_month", "hoy");
    assert.match(fallback.fromDate, /^\d{4}-\d{2}-01$/);
    assert.match(fallback.toDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("Enter on a field exports; buttons, links, modifiers and a consumed keydown (date arithmetic) do not", () => {
    assert.equal(isExportEnter({ key: "Enter", tagName: "INPUT" }), true, "date input");
    assert.equal(isExportEnter({ key: "Enter", tagName: "select" }), true, "select (lower case tag)");
    assert.equal(isExportEnter({ key: "Enter" }), true, "unknown target");
    assert.equal(isExportEnter({ key: "Enter", tagName: "BUTTON" }), false, "the submit button submits by itself; «Abrir histórico» must not export");
    assert.equal(isExportEnter({ key: "Enter", tagName: "A" }), false);
    assert.equal(isExportEnter({ key: "Enter", tagName: "TEXTAREA" }), false);
    assert.equal(isExportEnter({ key: "Enter", tagName: "INPUT", defaultPrevented: true }), false, "the picker resolved «+7» / «hoy» on this keystroke");
    assert.equal(isExportEnter({ key: "Enter", tagName: "INPUT", metaKey: true }), false);
    assert.equal(isExportEnter({ key: "Enter", tagName: "INPUT", shiftKey: true }), false);
    assert.equal(isExportEnter({ key: " ", tagName: "INPUT" }), false);
    assert.equal(isExportEnter({ key: "e", tagName: "INPUT", altKey: true }), false, "⌥E is the access key, not Enter");
  });

  it("the four presets are offered in Spanish and labelled", () => {
    assert.deepEqual(
      RANGE_PRESET_OPTIONS.map((option) => [option.value, option.label]),
      [
        ["this_month", "Este mes"],
        ["previous_month", "Mes anterior"],
        ["last_30_days", "Últimos 30 días"],
        ["custom", "Personalizado"]
      ]
    );
    assert.equal(rangePresetLabel("previous_month"), "Mes anterior");
    assert.equal(exportFormLabel("reservation", "this_month"), "Exportar informe de reservas (este mes)");
    assert.equal(exportFormLabel("billing", "custom"), "Exportar informe de facturación (personalizado)");
  });

  it("source contract: no literal date in the screen; the range state feeds the POST; the form submits with Enter and ⌥E; ⌘K exports by type", () => {
    assert.doesNotMatch(SCREEN_SOURCE, /\d{4}-\d{2}-\d{2}/, "0 literal dates (the old fixed May 2026 range)");
    assert.match(SCREEN_SOURCE, /query: \{ fromDate: range\.fromDate, toDate: range\.toDate \}/, "the export posts the preset range");
    assert.match(SCREEN_SOURCE, /<form onSubmit=\{handleExportSubmit\} onKeyDown=\{handleExportKeyDown\} aria-label=\{exportFormLabel\(reportType, preset\)\}/, "«Exportar informe» is a form (Enter exports)");
    assert.match(SCREEN_SOURCE, /if \(!isExportEnter\(\{ \.\.\.event, tagName: \(event\.target as HTMLElement\)\.tagName \}\)\) return;/, "Enter on a field goes through isExportEnter");
    assert.match(SCREEN_SOURCE, /<CocoaButton type="submit"[^>]*accessKey="E"[^>]*>\s*Generar exportación/, "«Generar exportación» is the submit with ⌥E");
    assert.match(SCREEN_SOURCE, /<CocoaSelect id="reporting-center-range" value=\{preset\} onChange=\{handlePresetChange\} options=\{RANGE_OPTIONS\}/, "preset select");
    assert.match(SCREEN_SOURCE, /<CocoaDatePicker id="reporting-center-from" value=\{range\.fromDate\}/, "«Desde» picker");
    assert.match(SCREEN_SOURCE, /<CocoaDatePicker id="reporting-center-to" value=\{range\.toDate\}/, "«Hasta» picker");
    assert.match(SCREEN_SOURCE, /label: "Exportar informe de reservas", run: \(\) => void handleExport\("reservation"\)/, "⌘K reservas");
    assert.match(SCREEN_SOURCE, /label: "Exportar informe de facturación", run: \(\) => void handleExport\("billing"\)/, "⌘K facturación");
    assert.match(SCREEN_SOURCE, /label: "Generar exportación de informe", run: \(\) => void handleExport\(\)/, "the generic command of the measure spec d5 stays");
    assert.match(SCREEN_SOURCE, /options=\{FORMAT_SELECT_OPTIONS\}/, "the format select uses the honest labels");
    assert.match(SCREEN_SOURCE, /<strong>\{catalogRowTitle\(report\)\}<\/strong>/, "catalogue titles come from REPORT_TYPE_LABELS");
    assert.doesNotMatch(SCREEN_SOURCE, /meta="PDF · CSV · XLSX · JSON"/, "no format promise in the section meta");
  });
});

describe("Centro de informes · formatos honestos y títulos del catálogo", () => {
  it("the format options say what the API delivers (printable HTML for PDF, CSV for XLSX)", () => {
    assert.deepEqual(
      FORMAT_OPTIONS.map((option) => [option.value, option.label]),
      [
        ["pdf", "PDF (HTML imprimible)"],
        ["csv", "CSV"],
        ["xlsx", "XLSX (se entrega CSV)"],
        ["json", "JSON"]
      ]
    );
    assert.equal(formatLabel("pdf"), "PDF (HTML imprimible)");
    assert.equal(formatLabel("xlsx"), "XLSX (se entrega CSV)");
    assert.equal(formatLabel("ods"), "ODS");
  });

  it("REPORT_TYPE_LABELS is the source of the catalogue titles (by code prefix), with the API title as fallback", () => {
    assert.deepEqual(REPORT_TYPE_LABELS, { reservation: "Reservas", billing: "Facturación", revenue: "Revenue", owner: "Propietario" });
    assert.equal(catalogRowTitle({ code: "reservation_arrivals_departures", title: "Reservation arrivals and departures" }), "Reservas");
    assert.equal(catalogRowTitle({ code: "billing_invoice_payment", title: "Billing, invoices and payments" }), "Facturación");
    assert.equal(catalogRowTitle({ code: "revenue_history_forecast", title: "Revenue History & Forecast" }), "Revenue");
    assert.equal(catalogRowTitle({ code: "housekeeping_daily", title: "Pisos del día" }), "Pisos del día");
    assert.equal(catalogRowTitle({ code: "housekeeping_daily" }), "housekeeping_daily");
  });

  it("the secondary line is the description, else the API title without the «Título: » prefix, and nothing when it would repeat the title", () => {
    assert.equal(catalogRowDetail({ code: "reservation_arrivals_departures", title: "Reservas: llegadas y salidas" }), "Llegadas y salidas");
    assert.equal(catalogRowDetail({ code: "billing_invoice_payment", title: "Facturación, facturas y cobros" }), "Facturación, facturas y cobros");
    assert.equal(catalogRowDetail({ code: "revenue_history_forecast", title: "Revenue: histórico y previsión", description: "Snapshots diarios" }), "Snapshots diarios");
    assert.equal(catalogRowDetail({ code: "revenue_history_forecast", title: "Revenue" }), undefined);
    assert.equal(catalogRowDetail({ code: "revenue_history_forecast", title: "Revenue:" }), undefined);
  });
});
