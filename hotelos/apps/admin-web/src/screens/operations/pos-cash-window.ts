// Day window of the POS cash summary (arqueo), Tanda 5 · L1c. Pure helpers so
// the rule «desde hoy hasta hoy = un día completo» is unit-testable.

/** Next calendar day of a `YYYY-MM-DD` string (pure date arithmetic, no time zone shift). */
export function nextIsoDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Query for GET /pos/cash-summary from an inclusive day range picked in the UI.
 * The API reads `from`/`to` as midnights of a half-open window and rejects
 * from >= to, so «desde hoy hasta hoy» is sent as [today, tomorrow) — one full
 * day — instead of an empty window (browser-roles#4).
 */
export function cashSummaryWindow(fromDay: string, toDay: string): { from: string; to: string } {
  return { from: fromDay, to: nextIsoDay(toDay) };
}
