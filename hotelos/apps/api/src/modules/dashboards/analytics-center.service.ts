import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// Read-only Analytics Center dashboard. Meta-view over the
// custom-metrics + reporting + anomalies surface for a property:
//
//   * top metrics with latest snapshot value and a coarse trend %
//   * recent anomaly events for the property (or org if the event is
//     not property-scoped)
//   * upcoming scheduled reports with derived cadence + next-run-at
//   * roll-up KPIs counting metrics, snapshots, anomalies, reports
//
// Sharp edges (see report):
//   * `MetricDefinition` is org-scoped only (no propertyId), so we
//     resolve `organizationId` once from the property and surface every
//     active metric definition under it.
//   * `AnalyticsSnapshot.propertyId` and `AnomalyEvent.propertyId` are
//     both nullable — a null value means "org-wide". We include org-wide
//     rows for the property's organization alongside property-scoped
//     rows, matching the read pattern of other dashboards.
//   * `AnalyticsSnapshot.value` is a nullable Decimal — coerced to 0
//     for ranking/trend math but exposed as the original numeric value.
//   * `MetricDefinition` has no `unit` column; `unit` is read from the
//     `formulaJson` blob when present, otherwise omitted.
//   * `ScheduledReport` has no explicit `cadence` / `nextRunAt` columns
//     — both are read from `scheduleJson` (`cadence` / `frequency` for
//     cadence; `nextRunAt` / `nextRun` for the timestamp). Recipients
//     count comes from `recipientsJson` (array length, or a `count`
//     field when the blob is an object).
//   * Trend % compares the latest snapshot value to the most recent
//     prior snapshot of the same metric inside the window. With <2
//     snapshots we omit the field rather than coerce to 0.

export type AnalyticsCenterDashboard = {
  kpis: {
    totalMetrics: number;
    snapshotsLast24h: number;
    anomalies30d: number;
    criticalAnomalies: number;
    scheduledReportsActive: number;
  };
  topMetrics: Array<{
    id: string;
    name: string;
    latestValue: number;
    unit?: string;
    recordedAt: string;
    trendPct?: number;
  }>;
  recentAnomalies: Array<{
    id: string;
    metricName?: string;
    severity?: string;
    description?: string;
    detectedAt: string;
    status?: string;
  }>;
  upcomingReports: Array<{
    id: string;
    name: string;
    cadence?: string;
    nextRunAt?: string;
    recipients?: number;
  }>;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readStringFromJson(record: Record<string, unknown>, key: string): string | undefined {
  const raw = record[key];
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return undefined;
}

function readNumberFromJson(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readDateFromJson(record: Record<string, unknown>, key: string): Date | undefined {
  const raw = record[key];
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function emptyDashboard(): AnalyticsCenterDashboard {
  return {
    kpis: {
      totalMetrics: 0,
      snapshotsLast24h: 0,
      anomalies30d: 0,
      criticalAnomalies: 0,
      scheduledReportsActive: 0
    },
    topMetrics: [],
    recentAnomalies: [],
    upcomingReports: []
  };
}

export async function buildAnalyticsCenterDashboard(input: {
  propertyId: string;
  days?: number;
}): Promise<AnalyticsCenterDashboard> {
  const propertyId = input.propertyId;
  if (!propertyId) return emptyDashboard();
  const days =
    Number.isFinite(input.days) && (input.days as number) > 0
      ? Math.floor(input.days as number)
      : 30;
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const last24hStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1) Resolve organizationId — MetricDefinition + ScheduledReport are
  //    org-scoped; AnalyticsSnapshot/AnomalyEvent expose both fields.
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true }
  });
  if (!property) return emptyDashboard();
  const organizationId = property.organizationId;

  // 2) Parallel fetch.
  const [metricDefs, snapshotsInWindow, anomalies, scheduledReports] = await Promise.all([
    prisma.metricDefinition.findMany({
      where: { organizationId, active: true }
    }),
    prisma.analyticsSnapshot.findMany({
      where: {
        organizationId,
        OR: [{ propertyId }, { propertyId: null }],
        snapshotDate: { gte: windowStart, lte: now }
      },
      orderBy: { snapshotDate: "desc" }
    }),
    prisma.anomalyEvent.findMany({
      where: {
        organizationId,
        OR: [{ propertyId }, { propertyId: null }],
        detectedAt: { gte: windowStart, lte: now }
      },
      orderBy: { detectedAt: "desc" },
      take: 50
    }),
    prisma.scheduledReport.findMany({
      where: {
        organizationId,
        OR: [{ propertyId }, { propertyId: null }]
      },
      orderBy: { createdAt: "desc" }
    })
  ]);

  // 3) Definition lookup.
  const defByCode = new Map(metricDefs.map((m) => [m.metricCode, m] as const));

  // 4) KPIs.
  const snapshotsLast24h = snapshotsInWindow.filter((s) => s.snapshotDate >= last24hStart).length;
  const anomalies30d = anomalies.length;
  const criticalAnomalies = anomalies.filter((a) => {
    const sev = (a.severity ?? "").toLowerCase();
    return sev === "critical" || sev === "high";
  }).length;
  const scheduledReportsActive = scheduledReports.filter((r) => r.active).length;

  // 5) Top metrics — group snapshots by metricCode. snapshotsInWindow is
  //    already sorted desc by snapshotDate, so the first row per code is
  //    the latest snapshot. Trend % compares it to the next row (the
  //    most recent prior snapshot inside the window).
  type LatestEntry = {
    latest: typeof snapshotsInWindow[number];
    prior?: typeof snapshotsInWindow[number];
  };
  const latestByCode = new Map<string, LatestEntry>();
  for (const snap of snapshotsInWindow) {
    const existing = latestByCode.get(snap.metricCode);
    if (!existing) {
      latestByCode.set(snap.metricCode, { latest: snap });
    } else if (!existing.prior) {
      existing.prior = snap;
    }
  }

  const topMetrics = Array.from(latestByCode.entries())
    .map(([code, entry]) => {
      const def = defByCode.get(code);
      const formula = def ? readJsonRecord(def.formulaJson) : {};
      const unit = readStringFromJson(formula, "unit");
      const latestValue = dec(entry.latest.value);
      const priorValue = entry.prior ? dec(entry.prior.value) : undefined;
      const out: AnalyticsCenterDashboard["topMetrics"][number] = {
        id: entry.latest.id,
        name: def?.name ?? code,
        latestValue,
        recordedAt: entry.latest.snapshotDate.toISOString()
      };
      if (unit) out.unit = unit;
      if (priorValue !== undefined && priorValue !== 0) {
        out.trendPct = round1(((latestValue - priorValue) / Math.abs(priorValue)) * 100);
      }
      return out;
    })
    .sort((a, b) => {
      // Prefer most-recently-recorded metrics; tie-break by absolute trend
      // magnitude so movers float above stale-but-flat metrics.
      const tDelta = new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime();
      if (tDelta !== 0) return tDelta;
      const aMag = a.trendPct !== undefined ? Math.abs(a.trendPct) : 0;
      const bMag = b.trendPct !== undefined ? Math.abs(b.trendPct) : 0;
      return bMag - aMag;
    })
    .slice(0, 10);

  // 6) Recent anomalies — most recent 10. metricName resolved via the
  //    MetricDefinition lookup; raw metricCode falls through when no
  //    definition matches.
  const recentAnomalies = anomalies.slice(0, 10).map((a) => {
    const def = a.metricCode ? defByCode.get(a.metricCode) : undefined;
    const metricName = def?.name ?? a.metricCode ?? undefined;
    const out: AnalyticsCenterDashboard["recentAnomalies"][number] = {
      id: a.id,
      detectedAt: a.detectedAt.toISOString()
    };
    if (metricName) out.metricName = metricName;
    if (a.severity) out.severity = a.severity;
    if (a.description ?? a.title) out.description = a.description ?? a.title;
    if (a.status) out.status = a.status;
    return out;
  });

  // 7) Upcoming reports — active reports, ordered by nextRunAt asc (no
  //    nextRunAt sinks to the bottom but stays visible). Cadence and
  //    nextRunAt are best-effort reads from scheduleJson.
  const upcomingReports = scheduledReports
    .filter((r) => r.active)
    .map((r) => {
      const schedule = readJsonRecord(r.scheduleJson);
      const cadence =
        readStringFromJson(schedule, "cadence") ?? readStringFromJson(schedule, "frequency");
      const nextRunAt =
        readDateFromJson(schedule, "nextRunAt") ?? readDateFromJson(schedule, "nextRun");
      const recipientsRaw = r.recipientsJson as unknown;
      let recipients: number | undefined;
      if (Array.isArray(recipientsRaw)) {
        recipients = recipientsRaw.length;
      } else if (recipientsRaw && typeof recipientsRaw === "object") {
        recipients = readNumberFromJson(recipientsRaw as Record<string, unknown>, "count");
      }
      const out: AnalyticsCenterDashboard["upcomingReports"][number] = {
        id: r.id,
        name: r.name
      };
      if (cadence) out.cadence = cadence;
      if (nextRunAt) out.nextRunAt = nextRunAt.toISOString();
      if (recipients !== undefined) out.recipients = recipients;
      return out;
    })
    .sort((a, b) => {
      if (a.nextRunAt && b.nextRunAt) {
        return new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime();
      }
      if (a.nextRunAt) return -1;
      if (b.nextRunAt) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 10);

  return {
    kpis: {
      totalMetrics: metricDefs.length,
      snapshotsLast24h,
      anomalies30d,
      criticalAnomalies,
      scheduledReportsActive
    },
    topMetrics,
    recentAnomalies,
    upcomingReports
  };
}
