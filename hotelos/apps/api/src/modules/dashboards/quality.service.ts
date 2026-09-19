import { prisma } from "@hotelos/database";

/**
 * Quality cases operations dashboard — read-only statistical view.
 *
 * Aggregates over QualityCase rows for a single property, optionally within a
 * rolling N-day window on createdAt (days, default 30).
 *
 * Notes / sharp edges:
 *  - Sprint 19 added `slaTargetAt` and `rootCause` columns. We use
 *    `slaTargetAt` to compute slaBreachedPct (% of cases whose resolvedAt is
 *    after slaTargetAt, or whose slaTargetAt is in the past while still open).
 *  - We surface "severity" using `priority` (the schema's severity-like
 *    column). Returned as `severity` on recentCases for UI compatibility.
 *  - `closedLast30d` counts cases with resolvedAt within the last 30 days,
 *    regardless of the `days` window for other aggregates (the spec name
 *    pins it to 30 days).
 *  - `topFailureModes` now prefers `rootCause` when populated, falling back
 *    to `caseType` distribution of RESOLVED cases otherwise.
 *  - `criticalOpen` counts open cases whose `priority` is in the critical set.
 *  - `recentCases.closedAt` mirrors `resolvedAt` when present (no separate
 *    closedAt column).
 *  - All array fields default to [] and all numeric fields default to 0 when
 *    no rows are found.
 *  - Tanda T8 (lote T8-E, aditivo): `kpis.fromReviews` cuenta los casos
 *    abiertos de tipo `review_negative` (los abre review-alerts.service.ts) y
 *    `recentCases[].reviewId` sale del marcador «[reseña:<id>]» que ese servicio
 *    escribe al principio de `description`.
 */

export type QualityDashboard = {
  kpis: {
    openCases: number;
    slaBreachedPct: number;
    avgResolutionHours: number;
    closedLast30d: number;
    criticalOpen: number;
    /** Casos abiertos abiertos por reseñas negativas (caseType `review_negative`). */
    fromReviews: number;
  };
  casesByType: Array<{ caseType: string; count: number }>;
  casesByStatus: Array<{ status: string; count: number }>;
  topFailureModes: Array<{ rootCause: string; count: number }>;
  recentCases: Array<{
    id: string;
    title: string;
    status: string;
    severity?: string;
    openedAt: string;
    closedAt?: string;
    /** Reseña que abrió el caso (marcador «[reseña:<id>]» de la descripción); ausente en el resto. */
    reviewId?: string;
  }>;
};

/** caseType de los casos que abre una reseña negativa (= REVIEW_ALERT_CASE_TYPE de reputation/review-alerts.service.ts:25). */
export const QUALITY_REVIEW_CASE_TYPE = "review_negative";

const REVIEW_MARKER = /^\s*\[reseña:([^\]\s]+)\]/u;

/** Id de la reseña enlazada por el marcador «[reseña:<id>]» al inicio de la descripción; `null` si no lo hay. */
export function reviewIdFromCaseDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = REVIEW_MARKER.exec(description);
  return match?.[1] ?? null;
}

const CRITICAL_PRIORITIES = new Set(["critical", "urgent", "high"]);
const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function buildQualityDashboard(input: {
  propertyId: string;
  days?: number;
}): Promise<QualityDashboard> {
  const empty: QualityDashboard = {
    kpis: { openCases: 0, slaBreachedPct: 0, avgResolutionHours: 0, closedLast30d: 0, criticalOpen: 0, fromReviews: 0 },
    casesByType: [],
    casesByStatus: [],
    topFailureModes: [],
    recentCases: []
  };

  if (!input.propertyId) return empty;

  const days = Number.isFinite(input.days) && (input.days as number) > 0 ? (input.days as number) : 30;
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 3_600_000);
  const last30Start = new Date(now.getTime() - 30 * 24 * 3_600_000);

  const cases = await prisma.qualityCase.findMany({
    where: {
      propertyId: input.propertyId,
      createdAt: { gte: windowStart }
    },
    orderBy: { createdAt: "desc" }
  });

  if (cases.length === 0) return empty;

  // KPI accumulators.
  let openCases = 0;
  let criticalOpen = 0;
  let fromReviews = 0;
  let closedLast30d = 0;
  let resolvedCount = 0;
  let resolutionHoursTotal = 0;
  let slaEligible = 0;
  let slaBreached = 0;

  // Bucket accumulators.
  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const failureModes = new Map<string, number>(); // rootCause (fallback caseType) of resolved cases

  for (const c of cases) {
    const priority = c.priority ?? "normal";
    const status = c.status as string;
    const isCritical = CRITICAL_PRIORITIES.has(priority);
    const isClosed = CLOSED_STATUSES.has(status);

    byType.set(c.caseType, (byType.get(c.caseType) ?? 0) + 1);
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    if (!isClosed) {
      openCases += 1;
      if (isCritical) criticalOpen += 1;
      if (c.caseType === QUALITY_REVIEW_CASE_TYPE) fromReviews += 1;
    }

    if (c.slaTargetAt) {
      slaEligible += 1;
      if (c.resolvedAt) {
        if (c.resolvedAt.getTime() > c.slaTargetAt.getTime()) slaBreached += 1;
      } else if (c.slaTargetAt.getTime() < now.getTime()) {
        slaBreached += 1;
      }
    }

    if (c.resolvedAt) {
      const ms = c.resolvedAt.getTime() - c.createdAt.getTime();
      if (Number.isFinite(ms) && ms >= 0) {
        resolvedCount += 1;
        resolutionHoursTotal += ms / 3_600_000;
      }
      if (c.resolvedAt >= last30Start) {
        closedLast30d += 1;
      }
      const mode = c.rootCause ?? c.caseType;
      failureModes.set(mode, (failureModes.get(mode) ?? 0) + 1);
    }
  }

  const avgResolutionHours = resolvedCount === 0 ? 0 : round1(resolutionHoursTotal / resolvedCount);
  const slaBreachedPct = slaEligible === 0 ? 0 : round1((slaBreached / slaEligible) * 100);

  const casesByType = Array.from(byType.entries())
    .map(([caseType, count]) => ({ caseType, count }))
    .sort((a, b) => b.count - a.count);

  const casesByStatus = Array.from(byStatus.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const topFailureModes = Array.from(failureModes.entries())
    .map(([rootCause, count]) => ({ rootCause, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentCases = cases.slice(0, 10).map((c) => {
    const reviewId = reviewIdFromCaseDescription(c.description);
    return {
      id: c.id,
      title: c.title,
      status: c.status as string,
      severity: c.priority ?? "normal",
      openedAt: c.createdAt.toISOString(),
      closedAt: c.resolvedAt ? c.resolvedAt.toISOString() : undefined,
      ...(reviewId ? { reviewId } : {})
    };
  });

  return {
    kpis: { openCases, slaBreachedPct, avgResolutionHours, closedLast30d, criticalOpen, fromReviews },
    casesByType,
    casesByStatus,
    topFailureModes,
    recentCases
  };
}
