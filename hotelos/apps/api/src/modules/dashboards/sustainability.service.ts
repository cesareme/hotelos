import { prisma } from "@hotelos/database";

/**
 * Sustainability dashboard — read-only ESG / CO2 view.
 *
 * Aggregates over SustainabilityMetric / SustainabilityAction for a single
 * property, optionally within a rolling N-day window on metricDate (days,
 * default 30). Room-night denominators are derived from Reservation rows that
 * overlap the window (sum of nights per stay, clipped to the window).
 *
 * Notes / sharp edges:
 *  - SustainabilityMetric exposes: id, propertyId, metricDate, metricCode,
 *    value (Decimal? — may be null), unit?, metadataJson, createdAt. There is
 *    no `name` column — the spec's `name` is mapped to `metricCode`. There is
 *    no `recordedAt` column — the spec's `recordedAt` is mapped to
 *    `metricDate` (the business date the metric covers; falls back to
 *    `createdAt` only when both are missing, which Prisma will not allow for
 *    metricDate but is left defensive anyway). Decimal values are coerced to
 *    plain numbers via Number(value); null values are treated as 0.
 *  - SustainabilityAction exposes: id, propertyId, title, description?,
 *    category?, status (default "planned"), estimatedCost?, estimatedSavings?,
 *    linkedCapexProjectId?, createdAt. There is NO `progressPct` and NO
 *    `targetDate` column in the schema; the response shape includes those
 *    fields as optional so callers see them in the type, but the values are
 *    always undefined until the schema gains those columns. The spec's `name`
 *    is mapped to `title`.
 *  - Active actions = status NOT IN CLOSED_STATUSES, all time for the property.
 *  - KPI codes are matched case-insensitively against metricCode containing
 *    the substring (e.g. "co2", "water", "waste"). Falls back to 0 when no
 *    matching rows.
 *  - `metricsByCategory` groups by metricCode (the closest "category" signal
 *    in the schema). `latestValue` is the most recent value for that code in
 *    the window; `trendPct` compares the latest in-window value vs. the
 *    latest value strictly before the window (0 when no prior value, capped
 *    at +/- 999 to avoid runaway when the prior was tiny).
 *  - Room nights for the window come from reservations whose stay overlaps
 *    [windowStart, now]; we sum the overlap-clipped nights. When zero room
 *    nights are found, per-room-night KPIs return 0 (no division-by-zero).
 *  - All array fields default to [] and all numeric fields default to 0 when
 *    no rows are found.
 */

export type SustainabilityDashboard = {
  kpis: {
    co2KgPerRoomNight: number;
    co2Total30dKg: number;
    waterLitersPerRoomNight: number;
    wastePerRoomNightKg: number;
    activeActions: number;
  };
  metricsByCategory: Array<{
    category: string;
    latestValue: number;
    unit: string;
    trendPct: number;
  }>;
  activeActions: Array<{
    id: string;
    name: string;
    status: string;
    progressPct?: number;
    targetDate?: string;
  }>;
  recentMetrics: Array<{
    id: string;
    name: string;
    value: number;
    unit: string;
    recordedAt: string;
  }>;
};

const CLOSED_STATUSES = new Set([
  "completed",
  "done",
  "cancelled",
  "canceled",
  "archived"
]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampTrend(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct > 999) return 999;
  if (pct < -999) return -999;
  return Math.round(pct * 10) / 10;
}

function nightsInOverlap(
  arrival: Date,
  departure: Date,
  windowStart: Date,
  windowEnd: Date
): number {
  const start = arrival.getTime() < windowStart.getTime() ? windowStart : arrival;
  const end = departure.getTime() > windowEnd.getTime() ? windowEnd : departure;
  if (end.getTime() <= start.getTime()) return 0;
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.floor(ms / (24 * 3_600_000)));
}

export async function buildSustainabilityDashboard(input: {
  propertyId: string;
  days?: number;
}): Promise<SustainabilityDashboard> {
  const empty: SustainabilityDashboard = {
    kpis: {
      co2KgPerRoomNight: 0,
      co2Total30dKg: 0,
      waterLitersPerRoomNight: 0,
      wastePerRoomNightKg: 0,
      activeActions: 0
    },
    metricsByCategory: [],
    activeActions: [],
    recentMetrics: []
  };

  if (!input.propertyId) return empty;

  const days =
    Number.isFinite(input.days) && (input.days as number) > 0
      ? (input.days as number)
      : 30;
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 3_600_000);
  const priorStart = new Date(windowStart.getTime() - days * 24 * 3_600_000);

  const [
    windowMetrics,
    priorMetrics,
    actions,
    overlappingReservations
  ] = await Promise.all([
    prisma.sustainabilityMetric.findMany({
      where: {
        propertyId: input.propertyId,
        metricDate: { gte: windowStart }
      },
      orderBy: { metricDate: "desc" }
    }),
    prisma.sustainabilityMetric.findMany({
      where: {
        propertyId: input.propertyId,
        metricDate: { gte: priorStart, lt: windowStart }
      },
      orderBy: { metricDate: "desc" }
    }),
    prisma.sustainabilityAction.findMany({
      where: { propertyId: input.propertyId },
      orderBy: { createdAt: "desc" }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId: input.propertyId,
        arrivalDate: { lt: now },
        departureDate: { gt: windowStart }
      },
      select: { arrivalDate: true, departureDate: true }
    })
  ]);

  if (
    windowMetrics.length === 0 &&
    actions.length === 0 &&
    priorMetrics.length === 0
  ) {
    return empty;
  }

  // Total room nights inside the window (overlap-clipped). Each reservation
  // contributes nights for one room; multi-room stays would need a more
  // granular table that is not modeled here.
  let totalRoomNights = 0;
  for (const r of overlappingReservations) {
    totalRoomNights += nightsInOverlap(
      r.arrivalDate,
      r.departureDate,
      windowStart,
      now
    );
  }

  // KPI accumulators by substring match on metricCode.
  let co2Total30dKg = 0;
  let waterLitersTotal = 0;
  let wasteKgTotal = 0;

  // Latest-by-code in window (for metricsByCategory and recentMetrics).
  // windowMetrics is ordered metricDate desc, so the first occurrence per
  // metricCode is the latest.
  const latestInWindow = new Map<
    string,
    { value: number; unit: string }
  >();

  for (const m of windowMetrics) {
    const code = m.metricCode;
    const value = toNumber(m.value);
    const unit = m.unit ?? "";
    const codeLower = code.toLowerCase();

    if (!latestInWindow.has(code)) {
      latestInWindow.set(code, { value, unit });
    }

    if (codeLower.includes("co2")) {
      co2Total30dKg += value;
    } else if (codeLower.includes("water")) {
      waterLitersTotal += value;
    } else if (codeLower.includes("waste")) {
      wasteKgTotal += value;
    }
  }

  // Latest-by-code strictly before the window, for trend computation.
  const latestBefore = new Map<string, number>();
  for (const m of priorMetrics) {
    if (!latestBefore.has(m.metricCode)) {
      latestBefore.set(m.metricCode, toNumber(m.value));
    }
  }

  const metricsByCategory: SustainabilityDashboard["metricsByCategory"] =
    Array.from(latestInWindow.entries())
      .map(([category, { value, unit }]) => {
        const prior = latestBefore.get(category);
        let trendPct = 0;
        if (prior !== undefined && prior !== 0) {
          trendPct = clampTrend(((value - prior) / Math.abs(prior)) * 100);
        }
        return {
          category,
          latestValue: round2(value),
          unit,
          trendPct
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category));

  const recentMetrics: SustainabilityDashboard["recentMetrics"] = windowMetrics
    .slice(0, 10)
    .map((m) => ({
      id: m.id,
      name: m.metricCode,
      value: round2(toNumber(m.value)),
      unit: m.unit ?? "",
      recordedAt: m.metricDate.toISOString()
    }));

  const activeActionRows = actions.filter(
    (a) => !CLOSED_STATUSES.has(a.status.toLowerCase())
  );

  const activeActions: SustainabilityDashboard["activeActions"] =
    activeActionRows.slice(0, 20).map((a) => ({
      id: a.id,
      name: a.title,
      status: a.status,
      // progressPct / targetDate are not modeled in the schema; left undefined
      // so the response shape stays stable for future column additions.
      progressPct: undefined,
      targetDate: undefined
    }));

  const co2KgPerRoomNight =
    totalRoomNights > 0 ? round2(co2Total30dKg / totalRoomNights) : 0;
  const waterLitersPerRoomNight =
    totalRoomNights > 0 ? round2(waterLitersTotal / totalRoomNights) : 0;
  const wastePerRoomNightKg =
    totalRoomNights > 0 ? round2(wasteKgTotal / totalRoomNights) : 0;

  return {
    kpis: {
      co2KgPerRoomNight,
      co2Total30dKg: round2(co2Total30dKg),
      waterLitersPerRoomNight,
      wastePerRoomNightKg,
      activeActions: activeActionRows.length
    },
    metricsByCategory,
    activeActions,
    recentMetrics
  };
}
