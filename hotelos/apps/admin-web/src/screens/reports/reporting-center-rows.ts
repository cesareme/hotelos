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
