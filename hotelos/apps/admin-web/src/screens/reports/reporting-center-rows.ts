// Rows of the Centro de informes tables (/informes). Pure so the dedupe rule
// is unit-testable.

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

/** Status line of a finished export: «Exportación lista: informe-….csv». */
export function exportStatusMessage(result: { export: { filename: string } }): string {
  return `Exportación lista: ${result.export.filename}`;
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
