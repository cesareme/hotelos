import { prisma } from "@hotelos/database";

/**
 * Sales pipeline dashboard — read-only B2B opportunities & accounts overview.
 *
 * Aggregates over SalesOpportunity (scoped by propertyId) and SalesAccount
 * (joined via SalesOpportunity.accountId). Optional date window applies to
 * SalesOpportunity.createdAt (used for KPI period boundaries and recent list).
 *
 * Sharp edges / schema observations:
 *  - SalesOpportunity exposes both `expectedValue` (Sprint 19) and
 *    `estimatedValue` (legacy). We prefer expectedValue when present, falling
 *    back to estimatedValue. Both surface as `expectedValue` in the response.
 *  - SalesOpportunity exposes `probability` (Sprint 19, Decimal 0..100). When
 *    null we fall back to the static stage→probability map (industry-standard
 *    CRM defaults). The map's values are 0..1, so probability/100 is used for
 *    weighting when present.
 *  - Stage values are free-form strings in the schema. We treat anything
 *    whose lower-cased form matches "won"/"closed_won"/"closed-won" as won,
 *    "lost"/"closed_lost"/"closed-lost" as lost, and everything else as
 *    OPEN (open / qualified / proposal / negotiation / discovery / etc.).
 *  - SalesAccount has no propertyId — it's scoped by organizationId. We
 *    resolve account names via SalesOpportunity.accountId -> SalesAccount.id
 *    and never query SalesAccount directly by property.
 *  - closedWonMtdEur uses the **calendar month-to-date** window of the
 *    server's current UTC date, independent of the from/to inputs (which
 *    drive the period for conversionRatePct and recentOpportunities).
 *  - conversionRatePct = won / (won + lost) inside the [from,to) window,
 *    rounded to 1 decimal; falls back to 0 when denominator is 0.
 *  - All Decimal values are coerced to Number via toNumber(); null/undefined
 *    becomes 0. All arrays default to [].
 */

export type SalesPipelineDashboardInput = {
  propertyId: string;
  from?: string;
  to?: string;
};

export type SalesPipelineDashboard = {
  kpis: {
    openOpportunities: number;
    pipelineValueEur: number;
    weightedPipelineEur: number;
    closedWonMtdEur: number;
    conversionRatePct: number;
  };
  opportunitiesByStage: Array<{ stage: string; count: number; totalValue: number }>;
  topAccounts: Array<{ accountName: string; openOpps: number; totalValue: number }>;
  recentOpportunities: Array<{
    id: string;
    name: string;
    stage: string;
    expectedValue?: number;
    probability?: number;
    accountName?: string;
    expectedCloseDate?: string;
  }>;
};

const WON_STAGES = new Set(["won", "closed_won", "closed-won", "closedwon"]);
const LOST_STAGES = new Set(["lost", "closed_lost", "closed-lost", "closedlost"]);

// Industry-standard CRM probability table. Lookup is case/punct insensitive
// via normaliseStage. Anything not listed and not won/lost defaults to 0.5.
const STAGE_PROBABILITY: Record<string, number> = {
  prospect: 0.1,
  discovery: 0.15,
  open: 0.2,
  qualified: 0.3,
  qualification: 0.3,
  proposal: 0.5,
  negotiation: 0.7,
  verbal: 0.85,
  won: 1,
  closed_won: 1,
  lost: 0,
  closed_lost: 0
};

function normaliseStage(stage: string | null | undefined): string {
  return (stage ?? "").toLowerCase().replace(/[\s-]+/g, "_").trim();
}

function isWon(stage: string | null | undefined): boolean {
  return WON_STAGES.has(normaliseStage(stage));
}

function isLost(stage: string | null | undefined): boolean {
  return LOST_STAGES.has(normaliseStage(stage));
}

function isOpen(stage: string | null | undefined): boolean {
  return !isWon(stage) && !isLost(stage);
}

function probabilityFor(stage: string | null | undefined): number {
  const key = normaliseStage(stage);
  if (key in STAGE_PROBABILITY) return STAGE_PROBABILITY[key];
  if (isWon(stage)) return 1;
  if (isLost(stage)) return 0;
  return 0.5;
}

/**
 * Resolve the probability for an opportunity in the 0..1 range. Uses the
 * stored probability (treated as a 0..100 percent) when present, falling back
 * to the static stage map otherwise.
 */
function resolveProbability(
  storedProbability: unknown,
  stage: string | null | undefined
): number {
  if (storedProbability !== null && storedProbability !== undefined) {
    const pct = toNumber(storedProbability);
    if (Number.isFinite(pct) && pct > 0) {
      return Math.min(1, Math.max(0, pct / 100));
    }
  }
  return probabilityFor(stage);
}

/**
 * Prefer expectedValue (Sprint 19) when present, falling back to
 * estimatedValue. Returns 0 when both are null/undefined.
 */
function resolveExpectedValue(opp: {
  expectedValue?: unknown;
  estimatedValue?: unknown;
}): { value: number; hasValue: boolean } {
  if (opp.expectedValue !== null && opp.expectedValue !== undefined) {
    return { value: toNumber(opp.expectedValue), hasValue: true };
  }
  if (opp.estimatedValue !== null && opp.estimatedValue !== undefined) {
    return { value: toNumber(opp.estimatedValue), hasValue: true };
  }
  return { value: 0, hasValue: false };
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  // Prisma Decimal exposes toNumber()
  if (typeof (value as { toNumber?: () => number }).toNumber === "function") {
    try {
      const n = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export async function buildSalesPipelineDashboard(
  input: SalesPipelineDashboardInput
): Promise<SalesPipelineDashboard> {
  const empty: SalesPipelineDashboard = {
    kpis: {
      openOpportunities: 0,
      pipelineValueEur: 0,
      weightedPipelineEur: 0,
      closedWonMtdEur: 0,
      conversionRatePct: 0
    },
    opportunitiesByStage: [],
    topAccounts: [],
    recentOpportunities: []
  };

  if (!input.propertyId) return empty;

  const from = parseDate(input.from, startOfCurrentMonthUtc());
  const to = parseDate(input.to, new Date());
  const monthStart = startOfCurrentMonthUtc();

  // We need ALL opportunities for the property to compute the open-pipeline
  // KPIs (which are not period-bound), then apply the date window for the
  // period-bound metrics. Pulling once and partitioning in-memory is cheaper
  // than running multiple aggregate queries for the typical opp volume.
  const opportunities = await prisma.salesOpportunity.findMany({
    where: { propertyId: input.propertyId },
    orderBy: { createdAt: "desc" }
  });

  if (opportunities.length === 0) return empty;

  const accountIds = Array.from(
    new Set(opportunities.map((o) => o.accountId).filter((v): v is string => Boolean(v)))
  );
  const accounts = accountIds.length
    ? await prisma.salesAccount.findMany({ where: { id: { in: accountIds } } })
    : [];
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name] as const));

  // --- Pipeline-wide KPIs (open opportunities are not date-windowed) ---
  let openOpportunities = 0;
  let pipelineValueEur = 0;
  let weightedPipelineEur = 0;
  let closedWonMtdEur = 0;

  // Period-bound counters (inside [from, to))
  let wonInPeriod = 0;
  let lostInPeriod = 0;

  // Bucket: stage -> { count, totalValue }
  const stageBucket = new Map<string, { count: number; totalValue: number }>();
  // Bucket: accountId -> { name, openOpps, totalValue (open only) }
  const accountBucket = new Map<string, { accountName: string; openOpps: number; totalValue: number }>();

  for (const opp of opportunities) {
    const { value: valueEur } = resolveExpectedValue(opp);
    const open = isOpen(opp.stage);
    const won = isWon(opp.stage);
    const lost = isLost(opp.stage);
    const probability = resolveProbability(opp.probability, opp.stage);

    // Stage roll-up: count ALL opps in property, value sums their expectedValue.
    const stageKey = opp.stage ?? "unknown";
    const sb = stageBucket.get(stageKey) ?? { count: 0, totalValue: 0 };
    sb.count += 1;
    sb.totalValue = round2(sb.totalValue + valueEur);
    stageBucket.set(stageKey, sb);

    if (open) {
      openOpportunities += 1;
      pipelineValueEur += valueEur;
      weightedPipelineEur += valueEur * probability;

      if (opp.accountId) {
        const name = accountNameById.get(opp.accountId) ?? "Unknown account";
        const ab = accountBucket.get(opp.accountId) ?? { accountName: name, openOpps: 0, totalValue: 0 };
        ab.openOpps += 1;
        ab.totalValue = round2(ab.totalValue + valueEur);
        accountBucket.set(opp.accountId, ab);
      }
    }

    // MTD won — uses calendar-month start regardless of from/to.
    if (won && opp.createdAt && opp.createdAt >= monthStart) {
      closedWonMtdEur += valueEur;
    }

    // Conversion rate uses the from/to window.
    const inWindow = opp.createdAt >= from && opp.createdAt < to;
    if (inWindow) {
      if (won) wonInPeriod += 1;
      if (lost) lostInPeriod += 1;
    }
  }

  const conversionDenom = wonInPeriod + lostInPeriod;
  const conversionRatePct = conversionDenom === 0 ? 0 : round1((wonInPeriod / conversionDenom) * 100);

  const opportunitiesByStage = Array.from(stageBucket.entries())
    .map(([stage, v]) => ({ stage, count: v.count, totalValue: round2(v.totalValue) }))
    .sort((a, b) => b.count - a.count);

  const topAccounts = Array.from(accountBucket.values())
    .map((a) => ({ accountName: a.accountName, openOpps: a.openOpps, totalValue: round2(a.totalValue) }))
    .sort((a, b) => b.totalValue - a.totalValue || b.openOpps - a.openOpps)
    .slice(0, 10);

  const recentOpportunities = opportunities.slice(0, 10).map((opp) => {
    const { value: expectedValueRaw, hasValue } = resolveExpectedValue(opp);
    const out: SalesPipelineDashboard["recentOpportunities"][number] = {
      id: opp.id,
      name: opp.name,
      stage: opp.stage
    };
    if (hasValue) out.expectedValue = round2(expectedValueRaw);
    out.probability = resolveProbability(opp.probability, opp.stage);
    if (opp.accountId) {
      const accountName = accountNameById.get(opp.accountId);
      if (accountName) out.accountName = accountName;
    }
    if (opp.expectedCloseDate) {
      out.expectedCloseDate = opp.expectedCloseDate.toISOString();
    }
    return out;
  });

  return {
    kpis: {
      openOpportunities,
      pipelineValueEur: round2(pipelineValueEur),
      weightedPipelineEur: round2(weightedPipelineEur),
      closedWonMtdEur: round2(closedWonMtdEur),
      conversionRatePct
    },
    opportunitiesByStage,
    topAccounts,
    recentOpportunities
  };
}
