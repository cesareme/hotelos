// USALI (11th ed.) summary operating statement (Finanzas · lote usali-cuentas).
//
// computeUsaliPnl is a pure function over the P&L movements of a period
// (AccountBalanceRow[], groups 6-7, mode `movements`), the organisation's
// mappings and the PMS occupancy facts; the service functions below fetch
// those through FinancialStatementsSource. Sign conventions: revenue lines
// are income-positive (credit − debit), every other line is cost-positive
// (debit − credit); profits subtract. An account nothing maps goes to
// `unassigned` (visible) and the `reconciliation` block proves that
// netIncome + unassigned.net equals the PGC result of the same rows.
//
// Ratios: PAR = per available room (active rooms × nights), POR = per
// occupied room (room-nights of real stays: reservations checked_in /
// checked_out). null when the denominator is 0.

import { Prisma } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { NotFoundError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { USALI_DEPARTMENTS, type UsaliDepartment, type UsaliLine } from "../accounting/chart-of-accounts.service.js";
import type { CorporateAllocationMethod, PropertyKind } from "@hotelos/shared";
import type {
  CorporateAllocationResult,
  UsaliAccountAmount,
  UsaliAmountSource,
  UsaliOperatingDepartment,
  UsaliOperatingDepartmentKey,
  UsaliPeriodComparison,
  UsaliPeriodDelta,
  UsaliPnl,
  UsaliPropertyComparison,
  UsaliRatios,
  UsaliRollupLine,
  UsaliUndistributedDepartment,
  UsaliUndistributedDepartmentKey
} from "../../../../../packages/shared/src/financial-statements-types.js";
import { ALLOCATION_LABEL, computeCorporateAllocation, corporateBaseWarnings, corporateCostFromGop, getCorporateAllocation, type AllocationFacts } from "./allocation.service.js";
import { D, ZERO, fromMoney, money, pct, ratio, sameCents, sumDec, type Dec } from "./money.js";
import {
  compareAccountBalanceRows,
  entityBadgeOf,
  isHotelCentre,
  nightsBetween,
  prismaFinancialStatementsSource,
  toWorkCentre,
  type AccountBalanceRow,
  type FinancialStatementsSource,
  type HeadcountByProperty,
  type HeadcountSource,
  type OccupancyFacts,
  type PropertyLite,
  type UsaliMappingSourceRow
} from "./source.js";
import { isAdmittedUsali, resolveUsaliForCode, type ResolvedUsali } from "./usali-mapping.service.js";

const OPERATING: UsaliOperatingDepartmentKey[] = ["rooms", "fnb", "other_operated", "misc_income"];
const UNDISTRIBUTED: UsaliUndistributedDepartmentKey[] = ["admin_general", "it", "sales_marketing", "pom", "utilities"];

type Bucket = Map<UsaliLine, Dec>;

export type UsaliComputeInput = {
  organizationId: string;
  propertyId: string | null;
  propertyName: string | null;
  /** Tanda 6b: kind / code of the centre (null for the sociedad or a subset). */
  propertyKind?: PropertyKind | null;
  propertyCode?: string | null;
  period: { from: string; to: string };
  currency: string;
  rows: AccountBalanceRow[];
  mappings: UsaliMappingSourceRow[];
  occupancy: OccupancyFacts;
  generatedAt?: string;
  /** Tanda 6c: headcount of the statement (`usaliHeadcountOf` over `source.headcountByProperty`); absent / null = sin datos. */
  headcount?: UsaliHeadcountInput | null;
};

function bucketGet(bucket: Bucket, line: UsaliLine): Dec {
  return bucket.get(line) ?? ZERO;
}

/** Resolution of a balance row after the cost-centre routing: the mapping sources plus `cost_center`. */
export type RoutedUsali = Omit<ResolvedUsali, "source"> & { source: UsaliAmountSource };

/**
 * Tanda 6c: routes the `labor` / `other_expense` amount of a partitioned row
 * (`accountBalances({ byCostCentre: true })`) to the department of its cost
 * centre — a `usali` centre whose code (upper case ROOMS, FNB…) names a
 * USALI department that admits the line. Anything else returns `resolved`
 * untouched: revenue, cost of sales, fees, non-operating and below-EBITDA
 * lines never move; `utilities.labor` is not an admitted schedule; the
 * `operating` / `cost` centres and unknown codes are ignored; an unmapped
 * account stays «Sin asignar». When the centre agrees with the mapping the
 * original source is kept (nothing was re-routed).
 */
export function routeByCostCentre(row: Pick<AccountBalanceRow, "costCentre">, resolved: ResolvedUsali | RoutedUsali): RoutedUsali {
  const centre = row.costCentre;
  if (!centre || centre.type !== "usali") return resolved;
  const department = centre.code.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(USALI_DEPARTMENTS, department)) return resolved;
  const line = resolved.usaliLine;
  if (line !== "labor" && line !== "other_expense") return resolved;
  if (!isAdmittedUsali(department, line)) return resolved;
  if (department === resolved.usaliDepartment) return resolved;
  return { ...resolved, usaliDepartment: department, source: "cost_center" };
}

/** Tanda 6c: the headcount a statement shows (`statistics.headcount`) and where it came from. */
export type UsaliHeadcountInput = { value: number; source: HeadcountSource };

/**
 * Pure (Tanda 6c): the headcount of one statement from the per-centre rows
 * of `source.headcountByProperty`, read ONCE per request and reused for the
 * `headcount` allocation key. `propertyIds` null = the whole sociedad (rows
 * without centre included); a null inside the list selects the rows booked
 * without centre («Sociedad (sin centro)»). Σ of the selected rows rounded
 * to whole people; null when no selected centre has data (never 0).
 */
export function usaliHeadcountOf(rows: HeadcountByProperty, propertyIds: readonly (string | null)[] | null): UsaliHeadcountInput | null {
  const selected = propertyIds === null ? rows : rows.filter((row) => propertyIds.includes(row.propertyId));
  if (selected.length === 0) return null;
  const total = sumDec(selected.map((row) => D(row.headcount))).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  if (total <= 0) return null;
  return { value: total, source: selected.every((row) => row.source === "payroll_cost_import") ? "payroll_cost_import" : "payroll_slips" };
}

type AccountAccumulator = { code: string; name: string; line: UsaliLine; amount: Dec; source: UsaliAmountSource };
type UnassignedAccumulator = { code: string; name: string; kind: "income" | "expense"; amount: Dec };

export function computeUsaliPnl(input: UsaliComputeInput): UsaliPnl {
  const buckets = new Map<UsaliDepartment, Bucket>();
  // Tanda 6c: a partitioned ledger brings one row per (account, cost centre); the drawer shows ONE line per account and USALI line.
  const accountsByDepartment = new Map<UsaliDepartment, Map<string, AccountAccumulator>>();
  const unassignedAccounts = new Map<string, UnassignedAccumulator>();
  let unassignedRevenue = ZERO;
  let unassignedExpense = ZERO;
  let pgcRevenue = ZERO;
  let pgcExpense = ZERO;

  for (const row of input.rows) {
    if (row.kind !== "income" && row.kind !== "expense") continue;
    if (row.debit.isZero() && row.credit.isZero()) continue;
    if (row.kind === "income") pgcRevenue = pgcRevenue.plus(row.credit.minus(row.debit));
    else pgcExpense = pgcExpense.plus(row.debit.minus(row.credit));

    // The PGC totals above are accumulated BEFORE the routing: reconciliation, GOP, EBITDA and net income never depend on it.
    const resolved = routeByCostCentre(row, resolveUsaliForCode(row.code, row, input.mappings));
    if (!resolved.usaliDepartment || !resolved.usaliLine) {
      const amount = row.kind === "income" ? row.credit.minus(row.debit) : row.debit.minus(row.credit);
      if (row.kind === "income") unassignedRevenue = unassignedRevenue.plus(amount);
      else unassignedExpense = unassignedExpense.plus(amount);
      const existing = unassignedAccounts.get(row.code);
      if (existing) existing.amount = existing.amount.plus(amount);
      else unassignedAccounts.set(row.code, { code: row.code, name: row.name, kind: row.kind, amount });
      continue;
    }
    const amount = resolved.usaliLine === "revenue" ? row.credit.minus(row.debit) : row.debit.minus(row.credit);
    const bucket = buckets.get(resolved.usaliDepartment) ?? new Map<UsaliLine, Dec>();
    bucket.set(resolved.usaliLine, bucketGet(bucket, resolved.usaliLine).plus(amount));
    buckets.set(resolved.usaliDepartment, bucket);
    const accounts = accountsByDepartment.get(resolved.usaliDepartment) ?? new Map<string, AccountAccumulator>();
    const key = `${row.code}|${resolved.usaliLine}`;
    const existing = accounts.get(key);
    if (existing) {
      existing.amount = existing.amount.plus(amount);
      if (resolved.source === "cost_center") existing.source = "cost_center";
    } else {
      accounts.set(key, { code: row.code, name: row.name, line: resolved.usaliLine, amount, source: resolved.source });
    }
    accountsByDepartment.set(resolved.usaliDepartment, accounts);
  }

  const dept = (key: UsaliDepartment): Bucket => buckets.get(key) ?? new Map<UsaliLine, Dec>();
  const accountsOf = (key: UsaliDepartment): UsaliAccountAmount[] =>
    Array.from((accountsByDepartment.get(key) ?? new Map<string, AccountAccumulator>()).values())
      .map((a) => ({ code: a.code, name: a.name, line: a.line, amount: money(a.amount), source: a.source }))
      .sort((a, b) => a.code.localeCompare(b.code) || a.line.localeCompare(b.line));

  const operating: UsaliOperatingDepartment[] = OPERATING.map((key) => {
    const b = dept(key);
    const revenue = bucketGet(b, "revenue");
    const costOfSales = bucketGet(b, "cost_of_sales");
    const labor = bucketGet(b, "labor");
    const otherExpense = bucketGet(b, "other_expense");
    const totalExpenses = costOfSales.plus(labor).plus(otherExpense);
    return {
      department: key,
      label: USALI_DEPARTMENTS[key],
      revenue: money(revenue),
      costOfSales: money(costOfSales),
      labor: money(labor),
      otherExpense: money(otherExpense),
      totalExpenses: money(totalExpenses),
      departmentalProfit: money(revenue.minus(totalExpenses)),
      accounts: accountsOf(key)
    };
  });
  const totalOperatingRevenue = OPERATING.reduce((sum, key) => sum.plus(bucketGet(dept(key), "revenue")), ZERO);
  const totalDepartmentalExpenses = OPERATING.reduce(
    (sum, key) => sum.plus(bucketGet(dept(key), "cost_of_sales")).plus(bucketGet(dept(key), "labor")).plus(bucketGet(dept(key), "other_expense")),
    ZERO
  );
  const totalDepartmentalProfit = totalOperatingRevenue.minus(totalDepartmentalExpenses);

  const undistributed: UsaliUndistributedDepartment[] = UNDISTRIBUTED.map((key) => {
    const b = dept(key);
    const labor = bucketGet(b, "labor");
    const otherExpense = bucketGet(b, "other_expense");
    return { department: key, label: USALI_DEPARTMENTS[key], labor: money(labor), otherExpense: money(otherExpense), total: money(labor.plus(otherExpense)), accounts: accountsOf(key) };
  });
  const totalUndistributed = UNDISTRIBUTED.reduce((sum, key) => sum.plus(bucketGet(dept(key), "labor")).plus(bucketGet(dept(key), "other_expense")), ZERO);
  // Tanda 6c: Σ labor of every department — the numerator of «coste de personal por empleado».
  const totalLabor = [...OPERATING, ...UNDISTRIBUTED].reduce((sum, key) => sum.plus(bucketGet(dept(key), "labor")), ZERO);
  const gop = totalDepartmentalProfit.minus(totalUndistributed);
  const managementFees = bucketGet(dept("management_fees"), "management_fee");
  const incomeBeforeNonOperating = gop.minus(managementFees);
  const nonOp = dept("non_operating");
  const rent = bucketGet(nonOp, "rent");
  const propertyTaxes = bucketGet(nonOp, "property_taxes");
  const insurance = bucketGet(nonOp, "insurance");
  const nonOpOther = bucketGet(nonOp, "other");
  const nonOperatingTotal = rent.plus(propertyTaxes).plus(insurance).plus(nonOpOther);
  const ebitda = incomeBeforeNonOperating.minus(nonOperatingTotal);
  const below = dept("below_ebitda");
  const interest = bucketGet(below, "interest");
  const depreciation = bucketGet(below, "depreciation_amortization");
  const incomeTax = bucketGet(below, "income_tax");
  const netIncome = ebitda.minus(interest).minus(depreciation).minus(incomeTax);
  const unassignedNet = unassignedRevenue.minus(unassignedExpense);
  const pgcResult = pgcRevenue.minus(pgcExpense);

  const nights = nightsBetween(input.period.from, input.period.to);
  const roomsAvailable = input.occupancy.roomsInventory * nights;
  const roomsOccupied = input.occupancy.roomsOccupied;
  const roomsRevenue = bucketGet(dept("rooms"), "revenue");

  const perDepartment: UsaliRatios["perDepartment"] = [
    ...operating.map((d) => {
      const revenue = fromMoney(d.revenue);
      const profit = fromMoney(d.departmentalProfit);
      const expense = fromMoney(d.totalExpenses);
      return {
        department: d.department,
        revenuePAR: ratio(revenue, roomsAvailable),
        revenuePOR: ratio(revenue, roomsOccupied),
        profitPAR: ratio(profit, roomsAvailable),
        profitPOR: ratio(profit, roomsOccupied),
        expensePAR: ratio(expense, roomsAvailable),
        expensePOR: ratio(expense, roomsOccupied)
      };
    }),
    ...undistributed.map((d) => {
      const expense = fromMoney(d.total);
      return {
        department: d.department,
        revenuePAR: null,
        revenuePOR: null,
        profitPAR: null,
        profitPOR: null,
        expensePAR: ratio(expense, roomsAvailable),
        expensePOR: ratio(expense, roomsOccupied)
      };
    })
  ];

  return {
    kind: "usali",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    propertyName: input.propertyName,
    propertyKind: input.propertyKind ?? null,
    propertyCode: input.propertyCode ?? null,
    period: input.period,
    currency: input.currency,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    operatingDepartments: operating,
    totalOperatingRevenue: money(totalOperatingRevenue),
    totalDepartmentalExpenses: money(totalDepartmentalExpenses),
    totalDepartmentalProfit: money(totalDepartmentalProfit),
    undistributed,
    totalUndistributed: money(totalUndistributed),
    gop: money(gop),
    managementFees: money(managementFees),
    managementFeeAccounts: accountsOf("management_fees"),
    incomeBeforeNonOperating: money(incomeBeforeNonOperating),
    nonOperating: {
      rent: money(rent),
      propertyTaxes: money(propertyTaxes),
      insurance: money(insurance),
      other: money(nonOpOther),
      total: money(nonOperatingTotal),
      accounts: accountsOf("non_operating")
    },
    ebitda: money(ebitda),
    belowEbitda: { interest: money(interest), depreciationAmortization: money(depreciation), incomeTax: money(incomeTax), accounts: accountsOf("below_ebitda") },
    netIncome: money(netIncome),
    unassigned: {
      revenue: money(unassignedRevenue),
      expense: money(unassignedExpense),
      net: money(unassignedNet),
      accounts: Array.from(unassignedAccounts.values())
        .map((a) => ({ code: a.code, name: a.name, kind: a.kind, amount: money(a.amount) }))
        .sort((a, b) => a.code.localeCompare(b.code))
    },
    reconciliation: {
      pgcRevenue: money(pgcRevenue),
      pgcExpense: money(pgcExpense),
      pgcResult: money(pgcResult),
      usaliNetIncomePlusUnassigned: money(netIncome.plus(unassignedNet)),
      ok: sameCents(pgcResult, netIncome.plus(unassignedNet))
    },
    statistics: {
      nights,
      roomsInventory: input.occupancy.roomsInventory,
      roomsAvailable,
      roomsOccupied,
      occupancyPct: pct(D(roomsOccupied), roomsAvailable),
      source: "pms_stays",
      headcount: input.headcount?.value ?? null,
      headcountSource: input.headcount?.source ?? null
    },
    ratios: {
      revpar: ratio(roomsRevenue, roomsAvailable),
      trevpar: ratio(totalOperatingRevenue, roomsAvailable),
      goppar: ratio(gop, roomsAvailable),
      adr: ratio(roomsRevenue, roomsOccupied),
      totalRevenuePOR: ratio(totalOperatingRevenue, roomsOccupied),
      gopPOR: ratio(gop, roomsOccupied),
      ebitdaPAR: ratio(ebitda, roomsAvailable),
      undistributedPAR: ratio(totalUndistributed, roomsAvailable),
      laborPerEmployee: ratio(totalLabor, input.headcount?.value ?? 0),
      perDepartment
    }
  };
}

// ---------------------------------------------------------------------------
// Period deltas (pure)
// ---------------------------------------------------------------------------

function delta(label: string, base: string | null, compared: string | null): UsaliPeriodDelta {
  if (base === null || compared === null) return { label, base, compared, delta: null, deltaPct: null };
  const diff = fromMoney(compared).minus(fromMoney(base));
  return { label, base, compared, delta: money(diff), deltaPct: fromMoney(base).isZero() ? null : pct(diff, fromMoney(base).abs()) };
}

export function usaliDeltas(base: UsaliPnl, compared: UsaliPnl): UsaliPeriodDelta[] {
  const lines: UsaliPeriodDelta[] = [delta("Ingresos operativos totales", base.totalOperatingRevenue, compared.totalOperatingRevenue)];
  for (const dept of base.operatingDepartments) {
    const other = compared.operatingDepartments.find((d) => d.department === dept.department);
    lines.push(delta(`${dept.label} · ingresos`, dept.revenue, other?.revenue ?? null));
    lines.push(delta(`${dept.label} · beneficio departamental`, dept.departmentalProfit, other?.departmentalProfit ?? null));
  }
  lines.push(delta("Beneficio departamental total", base.totalDepartmentalProfit, compared.totalDepartmentalProfit));
  lines.push(delta("Gastos no distribuidos", base.totalUndistributed, compared.totalUndistributed));
  lines.push(delta("GOP", base.gop, compared.gop));
  lines.push(delta("Honorarios de gestión", base.managementFees, compared.managementFees));
  lines.push(delta("No operativos", base.nonOperating.total, compared.nonOperating.total));
  lines.push(delta("EBITDA", base.ebitda, compared.ebitda));
  lines.push(delta("Resultado neto", base.netIncome, compared.netIncome));
  lines.push(delta("Sin asignar (neto)", base.unassigned.net, compared.unassigned.net));
  lines.push(delta("Ocupación %", base.statistics.occupancyPct, compared.statistics.occupancyPct));
  lines.push(delta("ADR", base.ratios.adr, compared.ratios.adr));
  lines.push(delta("RevPAR", base.ratios.revpar, compared.ratios.revpar));
  lines.push(delta("TRevPAR", base.ratios.trevpar, compared.ratios.trevpar));
  lines.push(delta("GOPPAR", base.ratios.goppar, compared.ratios.goppar));
  return lines;
}

// ---------------------------------------------------------------------------
// Service (source-backed)
// ---------------------------------------------------------------------------

async function resolveProperty(source: FinancialStatementsSource, organizationId: string, propertyId: string | null | undefined) {
  const properties = await source.properties(organizationId);
  if (!propertyId) return { properties, property: null };
  const property = properties.find((p) => p.id === propertyId);
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return { properties, property };
}

export async function buildUsaliPnl(input: {
  context: UserContext;
  propertyId?: string | null;
  from: string;
  to: string;
  source?: FinancialStatementsSource;
}): Promise<UsaliPnl> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  const { properties, property } = await resolveProperty(source, organizationId, input.propertyId);
  const propertyIds = property ? [property.id] : properties.map((p) => p.id);
  const [rows, mappings, occupancy, headcountRows] = await Promise.all([
    source.accountBalances({ organizationId, propertyId: property?.id ?? null, mode: "movements", from: input.from, to: input.to, groups: [6, 7], byCostCentre: true }),
    source.usaliMappings(organizationId),
    source.occupancy(propertyIds, input.from, input.to),
    source.headcountByProperty(organizationId, input.from, input.to)
  ]);
  return computeUsaliPnl({
    organizationId,
    propertyId: property?.id ?? null,
    propertyName: property?.name ?? null,
    propertyKind: property?.kind ?? null,
    propertyCode: property?.code ?? null,
    period: { from: input.from, to: input.to },
    currency: property?.currency ?? properties[0]?.currency ?? "EUR",
    rows,
    mappings,
    occupancy,
    headcount: usaliHeadcountOf(headcountRows, property ? [property.id] : null)
  });
}

// ---------------------------------------------------------------------------
// Comparison by work centre (+ Oficina central · Sin asignar · reparto, Tanda 6b)
// ---------------------------------------------------------------------------

type CentrePnl = { property: PropertyLite; rows: AccountBalanceRow[]; pnl: UsaliPnl };

const ROLLUP_METRICS: Array<{ metric: UsaliRollupLine["metric"]; label: string }> = [
  { metric: "totalOperatingRevenue", label: "Ingresos operativos totales" },
  { metric: "totalDepartmentalProfit", label: "Beneficio departamental total" },
  { metric: "totalUndistributed", label: "Gastos no distribuidos" },
  { metric: "gop", label: "GOP" },
  { metric: "ebitda", label: "EBITDA" },
  { metric: "netIncome", label: "Resultado neto" }
];

/**
 * Pure: «Total sociedad = Σ hoteles + Oficina central + Sin asignar» per
 * metric. `total` is the consolidated statement (the whole ledger), so the
 * identity holds by construction when the ledger is consistent; `ok` proves it.
 */
export function usaliRollup(hotels: readonly UsaliPnl[], corporate: UsaliPnl | null, unassigned: UsaliPnl | null, total: UsaliPnl): UsaliRollupLine[] {
  return ROLLUP_METRICS.map(({ metric, label }) => {
    const hotelsSum = sumDec(hotels.map((pnl) => fromMoney(pnl[metric])));
    const corporateValue = corporate ? fromMoney(corporate[metric]) : ZERO;
    const unassignedValue = unassigned ? fromMoney(unassigned[metric]) : ZERO;
    const totalValue = fromMoney(total[metric]);
    return { metric, label, hotels: money(hotelsSum), corporate: money(corporateValue), unassigned: money(unassignedValue), total: money(totalValue), ok: sameCents(hotelsSum.plus(corporateValue).plus(unassignedValue), totalValue) };
  });
}

export const CORPORATE_COLUMN_LABEL = "Oficina central";
export const UNASSIGNED_COLUMN_LABEL = "Sociedad (sin centro)";

/**
 * Pure: the informative allocation of the corporate GOP-level cost over the
 * hotels (R5). The cost split is −GOP of the corporate statement (departmental
 * expenses + undistributed − revenue): USALI's «Cluster Services / Corporate
 * Office» sits above the GOP line of each hotel. Below-GOP items of the office
 * (rent, insurance, depreciation, financial income) are not allocated; the
 * SAME base feeds the PyG por centro (`corporateCostFromGop`, fix t6b#16), and
 * a corporate GOP ≥ 0 allocates nothing. Never posted.
 */
export function usaliCorporateAllocation(input: { method: CorporateAllocationMethod; hotels: readonly UsaliPnl[]; corporate: UsaliPnl | null; headcount: ReadonlyMap<string, number>; manualWeights?: Array<{ propertyId: string; weight: number }> }): { allocation: CorporateAllocationResult; perHotel: Map<string, { allocated: string; gopAfterAllocation: string; ebitdaAfterAllocation: string }> } {
  const hotelIds = input.hotels.map((pnl) => pnl.propertyId ?? "");
  const facts: AllocationFacts = {
    revenue: new Map(input.hotels.map((pnl) => [pnl.propertyId ?? "", fromMoney(pnl.totalOperatingRevenue)])),
    roomsAvailable: new Map(input.hotels.map((pnl) => [pnl.propertyId ?? "", pnl.statistics.roomsAvailable])),
    headcount: input.headcount
  };
  const corporateCost = input.corporate ? corporateCostFromGop(fromMoney(input.corporate.gop)) : ZERO;
  const allocation = computeCorporateAllocation({ method: input.method, corporateCost, hotelIds, facts, manualWeights: input.manualWeights });
  if (input.method !== "none") allocation.warnings.push(...corporateBaseWarnings(input.corporate));
  if (!input.corporate && input.method !== "none") {
    allocation.warnings.push("La sociedad no tiene oficina central ni centros no alojativos: no hay coste corporativo que repartir.");
    allocation.applied = false;
  }
  const perHotel = new Map<string, { allocated: string; gopAfterAllocation: string; ebitdaAfterAllocation: string }>();
  for (const pnl of input.hotels) {
    const share = allocation.applied ? fromMoney(allocation.shares.find((s) => s.propertyId === pnl.propertyId)?.amount ?? "0.00") : ZERO;
    perHotel.set(pnl.propertyId ?? "", { allocated: money(share), gopAfterAllocation: money(fromMoney(pnl.gop).minus(share)), ebitdaAfterAllocation: money(fromMoney(pnl.ebitda).minus(share)) });
  }
  return { allocation, perHotel };
}

export async function compareUsaliProperties(input: {
  context: UserContext;
  from: string;
  to: string;
  propertyIds?: string[] | null;
  /**
   * Tanda 6b (design §5.4): `properties` = hotels only; the office / other
   * centres go to `corporate`, the society-level entries to `unassigned`,
   * plus the rollup and the informative allocation. Without the flag the
   * response is exactly the pre-6b one (every selected centre + consolidated).
   */
  includeCorporate?: boolean;
  /** Allocation key of this response; omitted → the stored key (`none` disables). Only with `includeCorporate`. */
  allocation?: CorporateAllocationMethod | null;
  source?: FinancialStatementsSource;
}): Promise<UsaliPropertyComparison> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  const all = await source.properties(organizationId);
  const wanted = input.propertyIds && input.propertyIds.length > 0 ? input.propertyIds : all.map((p) => p.id);
  const unknown = wanted.filter((id) => !all.some((p) => p.id === id));
  if (unknown.length > 0) throw new NotFoundError("Propiedad no encontrada.");
  const selected = all.filter((p) => wanted.includes(p.id));
  // Tanda 6c: the headcount rows are read ONCE and serve every statement of the response and the allocation key.
  const [mappings, identity, headcountRows] = await Promise.all([source.usaliMappings(organizationId), source.legalIdentity(organizationId), source.headcountByProperty(organizationId, input.from, input.to)]);
  const period = { from: input.from, to: input.to };
  const generatedAt = new Date().toISOString();
  const centres: CentrePnl[] = [];
  for (const property of selected) {
    const [rows, occupancy] = await Promise.all([
      source.accountBalances({ organizationId, propertyId: property.id, mode: "movements", from: input.from, to: input.to, groups: [6, 7], byCostCentre: true }),
      source.occupancy([property.id], input.from, input.to)
    ]);
    centres.push({
      property,
      rows,
      pnl: computeUsaliPnl({ organizationId, propertyId: property.id, propertyName: property.name, propertyKind: property.kind, propertyCode: property.code, period, currency: property.currency, rows, mappings, occupancy, generatedAt, headcount: usaliHeadcountOf(headcountRows, [property.id]) })
    });
  }
  // Consolidated = the whole organisation ledger (entries without propertyId included) when every property is
  // selected; otherwise the per-property rows summed by account code.
  const everyProperty = selected.length === all.length;
  const [consolidatedRows, occupancy] = await Promise.all([
    everyProperty
      ? source.accountBalances({ organizationId, propertyId: null, mode: "movements", from: input.from, to: input.to, groups: [6, 7], byCostCentre: true })
      : Promise.resolve(mergeRows(centres.map((c) => c.rows))),
    source.occupancy(selected.map((p) => p.id), input.from, input.to)
  ]);
  const consolidated = computeUsaliPnl({
    organizationId,
    propertyId: null,
    propertyName: everyProperty ? null : selected.map((p) => p.name).join(" + "),
    period,
    currency: selected[0]?.currency ?? "EUR",
    rows: consolidatedRows,
    mappings,
    occupancy,
    generatedAt,
    headcount: usaliHeadcountOf(headcountRows, everyProperty ? null : selected.map((p) => p.id))
  });
  const entity = entityBadgeOf(identity);
  const entry = (centre: CentrePnl): UsaliPropertyComparison["properties"][number] => ({ propertyId: centre.property.id, propertyName: centre.property.name, propertyKind: centre.property.kind, propertyCode: centre.property.code, pnl: centre.pnl });
  if (!input.includeCorporate) {
    return { kind: "usali_compare_properties", organizationId, period, generatedAt, properties: centres.map(entry), consolidated, entity };
  }

  const hotels = centres.filter((c) => isHotelCentre(c.property));
  const corporateCentres = centres.filter((c) => !isHotelCentre(c.property));
  let corporate: UsaliPropertyComparison["corporate"] = null;
  if (corporateCentres.length > 0) {
    const corporateOccupancy = await source.occupancy(corporateCentres.map((c) => c.property.id), input.from, input.to);
    corporate = {
      centres: corporateCentres.map((c) => toWorkCentre(c.property)),
      pnl: computeUsaliPnl({
        organizationId,
        propertyId: corporateCentres.length === 1 ? corporateCentres[0]!.property.id : null,
        propertyName: corporateCentres.length === 1 ? corporateCentres[0]!.property.name : CORPORATE_COLUMN_LABEL,
        propertyKind: corporateCentres.length === 1 ? corporateCentres[0]!.property.kind : "office",
        propertyCode: corporateCentres.length === 1 ? corporateCentres[0]!.property.code : null,
        period,
        currency: corporateCentres[0]!.property.currency,
        rows: mergeRows(corporateCentres.map((c) => c.rows)),
        mappings,
        occupancy: corporateOccupancy,
        generatedAt,
        headcount: usaliHeadcountOf(headcountRows, corporateCentres.map((c) => c.property.id))
      })
    };
  }
  let unassigned: UsaliPnl | undefined;
  if (everyProperty) {
    const unassignedRows = await source.accountBalances({ organizationId, propertyId: null, unassignedOnly: true, mode: "movements", from: input.from, to: input.to, groups: [6, 7], byCostCentre: true });
    unassigned = computeUsaliPnl({ organizationId, propertyId: null, propertyName: UNASSIGNED_COLUMN_LABEL, period, currency: consolidated.currency, rows: unassignedRows, mappings, occupancy: { roomsInventory: 0, roomsOccupied: 0 }, generatedAt, headcount: usaliHeadcountOf(headcountRows, [null]) });
  }
  const rollup = usaliRollup(hotels.map((h) => h.pnl), corporate?.pnl ?? null, unassigned ?? null, consolidated);

  const stored = await getCorporateAllocation(organizationId, source);
  const method = input.allocation ?? stored.allocation.method;
  let allocation: CorporateAllocationResult | null = null;
  const properties: UsaliPropertyComparison["properties"] = hotels.map(entry);
  if (method !== "none") {
    const headcount = new Map<string, number>();
    for (const row of headcountRows) if (row.propertyId) headcount.set(row.propertyId, row.headcount);
    const result = usaliCorporateAllocation({ method, hotels: hotels.map((h) => h.pnl), corporate: corporate?.pnl ?? null, headcount, manualWeights: stored.allocation.method === "manual" ? stored.allocation.weights : undefined });
    allocation = result.allocation;
    for (const property of properties) {
      const lines = result.perHotel.get(property.propertyId);
      if (lines) property.allocation = lines;
    }
  }
  return { kind: "usali_compare_properties", organizationId, period, generatedAt, properties, consolidated, entity, corporate, ...(unassigned ? { unassigned } : {}), rollup, allocation };
}

/** Label of the informative allocation row (re-exported for renderers and tests). */
export { ALLOCATION_LABEL };

/**
 * Sums row sets by account code (a subset of properties consolidated) — and,
 * for the partitioned rows of Tanda 6c, by `code|cost centre type|cost centre
 * code`, keeping `costCentre` so the routing still applies to the merge
 * (RA/ROOMS and LT/ROOMS fuse into one ROOMS row of the consolidated).
 */
export function mergeRows(rowSets: AccountBalanceRow[][]): AccountBalanceRow[] {
  const byKey = new Map<string, AccountBalanceRow>();
  for (const rows of rowSets) {
    for (const row of rows) {
      const key = row.costCentre ? `${row.code}|${row.costCentre.type}|${row.costCentre.code}` : row.code;
      const existing = byKey.get(key);
      if (existing) {
        existing.debit = existing.debit.plus(row.debit);
        existing.credit = existing.credit.plus(row.credit);
      } else {
        byKey.set(key, { ...row });
      }
    }
  }
  return Array.from(byKey.values()).sort(compareAccountBalanceRows);
}

export async function compareUsaliPeriods(input: {
  context: UserContext;
  propertyId?: string | null;
  periods: Array<{ from: string; to: string }>;
  source?: FinancialStatementsSource;
}): Promise<UsaliPeriodComparison> {
  requirePermissions(input.context, ["accounting.read"]);
  const pnls: UsaliPnl[] = [];
  for (const period of input.periods) {
    pnls.push(await buildUsaliPnl({ context: input.context, propertyId: input.propertyId, from: period.from, to: period.to, source: input.source }));
  }
  const base = pnls[0]!;
  return {
    kind: "usali_compare_periods",
    organizationId: input.context.organizationId,
    propertyId: input.propertyId ?? null,
    generatedAt: new Date().toISOString(),
    periods: pnls.map((pnl) => ({ from: pnl.period.from, to: pnl.period.to, pnl })),
    deltas: pnls.slice(1).map((pnl) => ({ from: pnl.period.from, to: pnl.period.to, lines: usaliDeltas(base, pnl) }))
  };
}
