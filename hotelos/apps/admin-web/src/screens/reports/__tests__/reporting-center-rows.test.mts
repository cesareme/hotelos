import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { downloadReportExport, exportStatusMessage, uniqueByFolio } from "../reporting-center-rows.ts";

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

  it("exportStatusMessage names the file, never the URL nor «undefined»", () => {
    assert.equal(exportStatusMessage(result), "Exportación lista: informe-reservation-prop_123-2026-09-19.csv");
    assert.doesNotMatch(exportStatusMessage(result), /undefined|\/reports\/exports/);
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
    assert.match(SCREEN_SOURCE, /setStatus\(exportStatusMessage\(result\)\)/, "handleExport uses the file name");
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
