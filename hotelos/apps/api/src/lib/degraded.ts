// Degraded-KPI helper (QC-06, audit 2026-09-14).
//
// Dashboards and health reports used to hide storage failures behind
// `.catch(() => 0 | [] | null)`: a broken table rendered as "0 arrivals" or
// "0 rejected submissions" (green) and nobody could tell a quiet day from a
// dead query. `createDegradedCollector` keeps the fallback value (so payload
// shapes do not change) but records WHICH counters fell back in `degraded[]`,
// which the caller spreads into its response, and logs one warning per failed
// counter with the scope and correlation id.
//
// Convention (CLAUDE.md · Convenciones): KPI fallbacks go through `safe()` and
// mark `degraded`; job/money-path catch blocks log with correlation and return
// failure counters instead of swallowing.

export type DegradedCollector = {
  /** Labels of every counter that fell back to its default in this request. */
  degraded: string[];
  /** Await `promise`; on failure log, record `label` and resolve to `fallback`. */
  safe<T>(label: string, promise: Promise<T>, fallback: T): Promise<T>;
};

/**
 * @param scope   log prefix, e.g. "dashboards.operations-director"
 * @param context correlation fields for the warning (propertyId, correlationId…)
 */
export function createDegradedCollector(scope: string, context: Record<string, unknown> = {}): DegradedCollector {
  const degraded: string[] = [];
  return {
    degraded,
    async safe<T>(label: string, promise: Promise<T>, fallback: T): Promise<T> {
      try {
        return await promise;
      } catch (err) {
        degraded.push(label);
        console.warn(`[${scope}] ${label} failed → degraded fallback`, {
          ...context,
          error: err instanceof Error ? err.message : String(err)
        });
        return fallback;
      }
    }
  };
}
