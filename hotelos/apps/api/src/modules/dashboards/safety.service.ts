import { prisma } from "@hotelos/database";

/**
 * Safety operations dashboard — read-only statistical view.
 *
 * Aggregates over SafetyIncident / IncidentEvidence / SafetyCheck /
 * SafetyCheckResult for a single property, optionally within a rolling N-day
 * window on SafetyIncident.createdAt (days, default 30).
 *
 * Notes / sharp edges:
 *  - SafetyIncident exposes: id, propertyId, incidentType, severity, status
 *    (default "open"), title, description?, locationEntityType?,
 *    locationEntityId?, guestId?, reservationId?, reportedBy?, assignedTo?,
 *    occurredAt?, createdAt, resolvedAt?. There is no `reportedAt` column —
 *    the spec's `reportedAt` is mapped to `createdAt` (the row creation
 *    timestamp is the closest existing signal for when the report was filed).
 *  - SafetyCheck exposes: id, propertyId, checkType, title, frequency?,
 *    locationEntityType?, locationEntityId?, assignedTo?, nextDueDate?,
 *    active, createdAt. The spec's `dueAt` is mapped to `nextDueDate` and the
 *    spec's `name` is mapped to `title`.
 *  - SafetyCheckResult exposes: id, safetyCheckId, status, notes?,
 *    completedBy?, completedAt. There is no "passed"/"failed" boolean — the
 *    `safetyChecksCompletedPct` KPI counts active checks that have ANY result
 *    completed within the window vs. total active checks, regardless of the
 *    result status. Returns 0 when there are no active checks.
 *  - `incidentsByCategory` is derived from `incidentType` (the schema's
 *    category-like column). IncidentEvidence is not surfaced directly in the
 *    response shape but is read so the service can be extended without an
 *    extra query (and to keep the model imports stable).
 *  - `nextInspections` counts active SafetyCheck rows with nextDueDate in the
 *    next 30 days (including overdue rows whose nextDueDate is past — they
 *    still need attention).
 *  - `criticalIncidents30d` counts incidents in the window whose severity is
 *    in the critical set (case-insensitive match).
 *  - `openIncidents` counts incidents with status NOT in CLOSED_STATUSES,
 *    over ALL time for the property (not bound to the window).
 *  - All array fields default to [] and all numeric fields default to 0 when
 *    no rows are found.
 */

export type SafetyDashboard = {
  kpis: {
    incidents30d: number;
    criticalIncidents30d: number;
    safetyChecksCompletedPct: number;
    nextInspections: number;
    openIncidents: number;
  };
  incidentsBySeverity: Array<{ severity: string; count: number }>;
  incidentsByCategory: Array<{ category: string; count: number }>;
  recentIncidents: Array<{
    id: string;
    title: string;
    severity?: string;
    status: string;
    occurredAt?: string;
    reportedAt?: string;
  }>;
  upcomingChecks: Array<{
    id: string;
    name: string;
    dueAt?: string;
    assignedTo?: string;
  }>;
};

const CRITICAL_SEVERITIES = new Set(["critical", "urgent", "high", "severe"]);
const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function buildSafetyDashboard(input: {
  propertyId: string;
  days?: number;
}): Promise<SafetyDashboard> {
  const empty: SafetyDashboard = {
    kpis: {
      incidents30d: 0,
      criticalIncidents30d: 0,
      safetyChecksCompletedPct: 0,
      nextInspections: 0,
      openIncidents: 0
    },
    incidentsBySeverity: [],
    incidentsByCategory: [],
    recentIncidents: [],
    upcomingChecks: []
  };

  if (!input.propertyId) return empty;

  const days =
    Number.isFinite(input.days) && (input.days as number) > 0
      ? (input.days as number)
      : 30;
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 3_600_000);
  const next30End = new Date(now.getTime() + 30 * 24 * 3_600_000);

  const [windowIncidents, allOpenIncidents, checks, checkResults, evidence] =
    await Promise.all([
      prisma.safetyIncident.findMany({
        where: {
          propertyId: input.propertyId,
          createdAt: { gte: windowStart }
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.safetyIncident.findMany({
        where: { propertyId: input.propertyId },
        select: { id: true, status: true }
      }),
      prisma.safetyCheck.findMany({
        where: { propertyId: input.propertyId, active: true },
        orderBy: { nextDueDate: "asc" }
      }),
      prisma.safetyCheckResult.findMany({
        where: { completedAt: { gte: windowStart } },
        select: { safetyCheckId: true, completedAt: true }
      }),
      prisma.incidentEvidence.findMany({
        where: { createdAt: { gte: windowStart } },
        select: { incidentId: true }
      })
    ]);

  if (
    windowIncidents.length === 0 &&
    allOpenIncidents.length === 0 &&
    checks.length === 0
  ) {
    // evidence is read but not surfaced; ignore its presence for empty-shortcut.
    void evidence;
    return empty;
  }
  void evidence;
  void checkResults;

  // KPI accumulators.
  const incidents30d = windowIncidents.length;
  let criticalIncidents30d = 0;

  // Bucket accumulators.
  const bySeverity = new Map<string, number>();
  const byCategory = new Map<string, number>();

  for (const incident of windowIncidents) {
    const severity = incident.severity ?? "unknown";
    const category = incident.incidentType ?? "unknown";

    bySeverity.set(severity, (bySeverity.get(severity) ?? 0) + 1);
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);

    if (CRITICAL_SEVERITIES.has(severity.toLowerCase())) {
      criticalIncidents30d += 1;
    }
  }

  let openIncidents = 0;
  for (const inc of allOpenIncidents) {
    if (!CLOSED_STATUSES.has(inc.status)) openIncidents += 1;
  }

  // safetyChecksCompletedPct: active checks with at least one completion in
  // the window over total active checks.
  const completedCheckIds = new Set<string>();
  for (const result of checkResults) {
    completedCheckIds.add(result.safetyCheckId);
  }
  const activeCheckIdSet = new Set(checks.map((c) => c.id));
  let completedInWindow = 0;
  for (const id of completedCheckIds) {
    if (activeCheckIdSet.has(id)) completedInWindow += 1;
  }
  const safetyChecksCompletedPct =
    activeCheckIdSet.size === 0
      ? 0
      : round1((completedInWindow / activeCheckIdSet.size) * 100);

  // nextInspections: active checks due within next 30 days (including overdue).
  let nextInspections = 0;
  for (const check of checks) {
    if (!check.nextDueDate) continue;
    if (check.nextDueDate.getTime() <= next30End.getTime()) nextInspections += 1;
  }

  const incidentsBySeverity = Array.from(bySeverity.entries())
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => b.count - a.count);

  const incidentsByCategory = Array.from(byCategory.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentIncidents = windowIncidents.slice(0, 10).map((incident) => ({
    id: incident.id,
    title: incident.title,
    severity: incident.severity ?? undefined,
    status: incident.status,
    incidentType: incident.incidentType ?? undefined,
    description: incident.description ?? undefined,
    assignedTo: incident.assignedTo ?? undefined,
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : undefined,
    occurredAt: incident.occurredAt
      ? incident.occurredAt.toISOString()
      : undefined,
    reportedAt: incident.createdAt.toISOString()
  }));

  // Upcoming checks: soonest-due first, up to 10. `dueAt` mirrors nextDueDate.
  const upcomingChecks = checks
    .filter((c) => c.nextDueDate !== null && c.nextDueDate !== undefined)
    .slice(0, 10)
    .map((check) => ({
      id: check.id,
      name: check.title,
      dueAt: check.nextDueDate ? check.nextDueDate.toISOString() : undefined,
      assignedTo: check.assignedTo ?? undefined
    }));

  return {
    kpis: {
      incidents30d,
      criticalIncidents30d,
      safetyChecksCompletedPct,
      nextInspections,
      openIncidents
    },
    incidentsBySeverity,
    incidentsByCategory,
    recentIncidents,
    upcomingChecks
  };
}
