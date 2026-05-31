import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

/**
 * Asset register dashboard — read-only overview of physical assets, fixed-asset
 * accounting, capex projects and warranty expirations for a single property.
 *
 * Aggregates over Asset, FixedAsset, CapexProject and CapexItem.
 *
 * Sharp edges / notes:
 *  - "Net book value" uses the FixedAsset accounting view when a matching
 *    FixedAsset.assetId is present: NBV = acquisitionCost − accumulatedDepreciation.
 *    When no FixedAsset row exists for a given Asset, NBV falls back to
 *    Asset.purchaseCost (best-effort) and acquisitionValue uses purchaseCost too.
 *    This keeps the KPI useful even before a full fixed-asset register is wired.
 *  - `depreciationMtdEur` is a *month-to-date straight-line estimate* derived
 *    from FixedAsset.acquisitionCost / usefulLifeMonths, prorated by elapsed
 *    days in the current month. We do not have a depreciation journal table,
 *    so this is an estimation, not a posted figure. Returns 0 when usefulLife
 *    is missing or zero.
 *  - `assetsByCategory` buckets on `Asset.assetType` (the closest taxonomy
 *    column; there's no separate "category" field in schema).
 *  - `openCapexProjects` counts projects whose status is NOT in the closed set
 *    {completed, cancelled, closed}.
 *  - CapexProject has `budget` only; "spent" is computed as the sum of
 *    CapexItem.actualCost for that project. Progress % is spent / budget,
 *    clipped to [0, 100] and rounded to 1 decimal. If budget is 0/missing,
 *    progressPct is omitted (undefined) so the UI can show "—".
 *  - `upcomingWarrantyExpirations` returns assets whose `warrantyUntil` falls
 *    in the next 90 days (inclusive), ordered ascending. `nextWarrantyExpiries`
 *    KPI counts items in the next 30 days.
 *  - All Decimal columns are coerced via Number(); empty/missing values default
 *    to 0. Array fields default to [].
 */

export type AssetsDashboard = {
  kpis: {
    totalAssets: number;
    totalNetBookValueEur: number;
    depreciationMtdEur: number;
    openCapexProjects: number;
    nextWarrantyExpiries: number;
  };
  assetsByCategory: Array<{ category: string; count: number; netBookValueEur: number }>;
  topAssets: Array<{
    id: string;
    name: string;
    category?: string;
    acquisitionValueEur: number;
    netBookValueEur: number;
    acquisitionDate?: string;
  }>;
  capexProjects: Array<{
    id: string;
    name: string;
    status: string;
    budgetEur?: number;
    spentEur?: number;
    progressPct?: number;
  }>;
  upcomingWarrantyExpirations: Array<{ id: string; assetName: string; warrantyEndsAt: string }>;
};

const CLOSED_CAPEX_STATUSES = new Set(["completed", "cancelled", "closed", "done"]);

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

export async function buildAssetsDashboard(input: { propertyId: string; limit?: number }): Promise<AssetsDashboard> {
  const empty: AssetsDashboard = {
    kpis: {
      totalAssets: 0,
      totalNetBookValueEur: 0,
      depreciationMtdEur: 0,
      openCapexProjects: 0,
      nextWarrantyExpiries: 0
    },
    assetsByCategory: [],
    topAssets: [],
    capexProjects: [],
    upcomingWarrantyExpirations: []
  };

  if (!input.propertyId) return empty;

  // Pagination guard rails. Default 100, caller may override within [1, 500].
  const rawLimit = input.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;

  const [assets, fixedAssets, capexProjects, capexItems] = await Promise.all([
    prisma.asset.findMany({
      where: { propertyId: input.propertyId },
      orderBy: { name: "asc" },
      take
    }),
    prisma.fixedAsset.findMany({
      where: { propertyId: input.propertyId },
      take
    }),
    prisma.capexProject.findMany({
      where: { propertyId: input.propertyId },
      orderBy: { startDate: "desc" },
      take
    }),
    prisma.capexItem.findMany({ take: Math.max(take, 500) })
  ]);

  if (
    assets.length === 0 &&
    fixedAssets.length === 0 &&
    capexProjects.length === 0
  ) {
    return empty;
  }

  // FixedAsset lookup by assetId (Asset.id -> FixedAsset row)
  const fixedByAssetId = new Map<string, (typeof fixedAssets)[number]>();
  for (const fa of fixedAssets) {
    if (fa.assetId) fixedByAssetId.set(fa.assetId, fa);
  }

  const now = new Date();
  const elapsedDaysInMonth = now.getUTCDate();

  // KPI: depreciation MTD — straight-line estimate from FixedAsset register.
  let depreciationMtdEur = 0;
  for (const fa of fixedAssets) {
    const life = fa.usefulLifeMonths ?? 0;
    if (life <= 0) continue;
    const cost = dec(fa.acquisitionCost);
    if (cost <= 0) continue;
    const monthly = cost / life;
    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
    ).getUTCDate();
    depreciationMtdEur += monthly * (elapsedDaysInMonth / daysInMonth);
  }
  depreciationMtdEur = round2(depreciationMtdEur);

  // Per-asset NBV and acquisition value (FixedAsset preferred, fallback to Asset.purchaseCost).
  type AssetRow = (typeof assets)[number];
  const valuation = new Map<string, { acquisition: number; nbv: number }>();
  let totalNetBookValueEur = 0;
  for (const asset of assets) {
    const fa = fixedByAssetId.get(asset.id);
    let acquisition: number;
    let nbv: number;
    if (fa) {
      acquisition = dec(fa.acquisitionCost);
      nbv = Math.max(0, acquisition - dec(fa.accumulatedDepreciation));
    } else {
      acquisition = dec(asset.purchaseCost);
      nbv = acquisition; // no accumulated depreciation known
    }
    valuation.set(asset.id, { acquisition, nbv });
    totalNetBookValueEur += nbv;
  }
  totalNetBookValueEur = round2(totalNetBookValueEur);

  // Buckets by assetType (category proxy).
  const byCategory = new Map<string, { count: number; netBookValueEur: number }>();
  for (const asset of assets) {
    const cat = asset.assetType || "uncategorized";
    const val = valuation.get(asset.id);
    const bucket = byCategory.get(cat) ?? { count: 0, netBookValueEur: 0 };
    bucket.count += 1;
    bucket.netBookValueEur += val?.nbv ?? 0;
    byCategory.set(cat, bucket);
  }
  const assetsByCategory = Array.from(byCategory.entries())
    .map(([category, v]) => ({
      category,
      count: v.count,
      netBookValueEur: round2(v.netBookValueEur)
    }))
    .sort((a, b) => b.netBookValueEur - a.netBookValueEur || b.count - a.count);

  // Top assets by net book value.
  const topAssets = assets
    .map((asset: AssetRow) => {
      const v = valuation.get(asset.id) ?? { acquisition: 0, nbv: 0 };
      const fa = fixedByAssetId.get(asset.id);
      const acquisitionDate =
        fa?.acquisitionDate?.toISOString() ?? asset.installationDate?.toISOString();
      return {
        id: asset.id,
        name: asset.name,
        category: asset.assetType || undefined,
        acquisitionValueEur: round2(v.acquisition),
        netBookValueEur: round2(v.nbv),
        acquisitionDate
      };
    })
    .sort((a, b) => b.netBookValueEur - a.netBookValueEur)
    .slice(0, 10);

  // Capex projects with spent (sum of CapexItem.actualCost).
  const spentByProject = new Map<string, number>();
  for (const item of capexItems) {
    spentByProject.set(
      item.capexProjectId,
      (spentByProject.get(item.capexProjectId) ?? 0) + dec(item.actualCost)
    );
  }

  let openCapexProjects = 0;
  const capexOut = capexProjects.map((p) => {
    const status = p.status;
    if (!CLOSED_CAPEX_STATUSES.has(status)) openCapexProjects += 1;
    const budget = dec(p.budget);
    const spent = spentByProject.get(p.id) ?? 0;
    const hasBudget = budget > 0;
    return {
      id: p.id,
      name: p.name,
      status,
      budgetEur: hasBudget ? round2(budget) : undefined,
      spentEur: round2(spent),
      progressPct: hasBudget ? round1(clampPct((spent / budget) * 100)) : undefined
    };
  });

  // Warranty expirations: assets with warrantyUntil in [today, +90d], sorted asc.
  const ninetyDays = 90;
  const thirtyDays = 30;
  let nextWarrantyExpiries = 0;
  const upcomingWarrantyExpirations = assets
    .filter((a) => !!a.warrantyUntil)
    .map((a) => ({ id: a.id, assetName: a.name, warrantyUntil: a.warrantyUntil as Date }))
    .filter((a) => {
      const d = daysBetween(a.warrantyUntil, now);
      return d >= 0 && d <= ninetyDays;
    })
    .sort((a, b) => a.warrantyUntil.getTime() - b.warrantyUntil.getTime())
    .map((a) => {
      const d = daysBetween(a.warrantyUntil, now);
      if (d <= thirtyDays) nextWarrantyExpiries += 1;
      return {
        id: a.id,
        assetName: a.assetName,
        warrantyEndsAt: a.warrantyUntil.toISOString()
      };
    });

  return {
    kpis: {
      totalAssets: assets.length,
      totalNetBookValueEur,
      depreciationMtdEur,
      openCapexProjects,
      nextWarrantyExpiries
    },
    assetsByCategory,
    topAssets,
    capexProjects: capexOut,
    upcomingWarrantyExpirations
  };
}
