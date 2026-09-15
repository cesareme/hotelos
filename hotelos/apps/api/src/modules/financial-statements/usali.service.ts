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

import type { UserContext } from "../../lib/demo-store.js";
import { NotFoundError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { USALI_DEPARTMENTS, type UsaliDepartment, type UsaliLine } from "../accounting/chart-of-accounts.service.js";
import type {
  UsaliAccountAmount,
  UsaliOperatingDepartment,
  UsaliOperatingDepartmentKey,
  UsaliPeriodComparison,
  UsaliPeriodDelta,
  UsaliPnl,
  UsaliPropertyComparison,
  UsaliRatios,
  UsaliUndistributedDepartment,
  UsaliUndistributedDepartmentKey
} from "../../../../../packages/shared/src/financial-statements-types.js";
import { D, ZERO, fromMoney, money, pct, ratio, sameCents, type Dec } from "./money.js";
import { nightsBetween, prismaFinancialStatementsSource, type AccountBalanceRow, type FinancialStatementsSource, type OccupancyFacts, type UsaliMappingSourceRow } from "./source.js";
import { resolveUsaliForCode } from "./usali-mapping.service.js";

const OPERATING: UsaliOperatingDepartmentKey[] = ["rooms", "fnb", "other_operated", "misc_income"];
const UNDISTRIBUTED: UsaliUndistributedDepartmentKey[] = ["admin_general", "it", "sales_marketing", "pom", "utilities"];

type Bucket = Map<UsaliLine, Dec>;

export type UsaliComputeInput = {
  organizationId: string;
  propertyId: string | null;
  propertyName: string | null;
  period: { from: string; to: string };
  currency: string;
  rows: AccountBalanceRow[];
  mappings: UsaliMappingSourceRow[];
  occupancy: OccupancyFacts;
  generatedAt?: string;
};

function bucketGet(bucket: Bucket, line: UsaliLine): Dec {
  return bucket.get(line) ?? ZERO;
}

export function computeUsaliPnl(input: UsaliComputeInput): UsaliPnl {
  const buckets = new Map<UsaliDepartment, Bucket>();
  const accountsByDepartment = new Map<UsaliDepartment, UsaliAccountAmount[]>();
  const unassignedAccounts: UsaliPnl["unassigned"]["accounts"] = [];
  let unassignedRevenue = ZERO;
  let unassignedExpense = ZERO;
  let pgcRevenue = ZERO;
  let pgcExpense = ZERO;

  for (const row of input.rows) {
    if (row.kind !== "income" && row.kind !== "expense") continue;
    if (row.debit.isZero() && row.credit.isZero()) continue;
    if (row.kind === "income") pgcRevenue = pgcRevenue.plus(row.credit.minus(row.debit));
    else pgcExpense = pgcExpense.plus(row.debit.minus(row.credit));

    const resolved = resolveUsaliForCode(row.code, row, input.mappings);
    if (!resolved.usaliDepartment || !resolved.usaliLine) {
      const amount = row.kind === "income" ? row.credit.minus(row.debit) : row.debit.minus(row.credit);
      if (row.kind === "income") unassignedRevenue = unassignedRevenue.plus(amount);
      else unassignedExpense = unassignedExpense.plus(amount);
      unassignedAccounts.push({ code: row.code, name: row.name, kind: row.kind, amount: money(amount) });
      continue;
    }
    const amount = resolved.usaliLine === "revenue" ? row.credit.minus(row.debit) : row.debit.minus(row.credit);
    const bucket = buckets.get(resolved.usaliDepartment) ?? new Map<UsaliLine, Dec>();
    bucket.set(resolved.usaliLine, bucketGet(bucket, resolved.usaliLine).plus(amount));
    buckets.set(resolved.usaliDepartment, bucket);
    const list = accountsByDepartment.get(resolved.usaliDepartment) ?? [];
    list.push({ code: row.code, name: row.name, line: resolved.usaliLine, amount: money(amount), source: resolved.source });
    accountsByDepartment.set(resolved.usaliDepartment, list);
  }

  const dept = (key: UsaliDepartment): Bucket => buckets.get(key) ?? new Map<UsaliLine, Dec>();
  const accountsOf = (key: UsaliDepartment): UsaliAccountAmount[] => (accountsByDepartment.get(key) ?? []).sort((a, b) => a.code.localeCompare(b.code));

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
      accounts: unassignedAccounts.sort((a, b) => a.code.localeCompare(b.code))
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
      source: "pms_stays"
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
  const [rows, mappings, occupancy] = await Promise.all([
    source.accountBalances({ organizationId, propertyId: property?.id ?? null, mode: "movements", from: input.from, to: input.to, groups: [6, 7] }),
    source.usaliMappings(organizationId),
    source.occupancy(propertyIds, input.from, input.to)
  ]);
  return computeUsaliPnl({
    organizationId,
    propertyId: property?.id ?? null,
    propertyName: property?.name ?? null,
    period: { from: input.from, to: input.to },
    currency: property?.currency ?? properties[0]?.currency ?? "EUR",
    rows,
    mappings,
    occupancy
  });
}

export async function compareUsaliProperties(input: {
  context: UserContext;
  from: string;
  to: string;
  propertyIds?: string[] | null;
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
  const mappings = await source.usaliMappings(organizationId);
  const period = { from: input.from, to: input.to };
  const generatedAt = new Date().toISOString();
  const properties: UsaliPropertyComparison["properties"] = [];
  const rowsByProperty: AccountBalanceRow[][] = [];
  for (const property of selected) {
    const [rows, occupancy] = await Promise.all([
      source.accountBalances({ organizationId, propertyId: property.id, mode: "movements", from: input.from, to: input.to, groups: [6, 7] }),
      source.occupancy([property.id], input.from, input.to)
    ]);
    rowsByProperty.push(rows);
    properties.push({
      propertyId: property.id,
      propertyName: property.name,
      pnl: computeUsaliPnl({ organizationId, propertyId: property.id, propertyName: property.name, period, currency: property.currency, rows, mappings, occupancy, generatedAt })
    });
  }
  // Consolidated = the whole organisation ledger (entries without propertyId included) when every property is
  // selected; otherwise the per-property rows summed by account code.
  const everyProperty = selected.length === all.length;
  const [consolidatedRows, occupancy] = await Promise.all([
    everyProperty
      ? source.accountBalances({ organizationId, propertyId: null, mode: "movements", from: input.from, to: input.to, groups: [6, 7] })
      : Promise.resolve(mergeRows(rowsByProperty)),
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
    generatedAt
  });
  return { kind: "usali_compare_properties", organizationId, period, generatedAt, properties, consolidated };
}

/** Sums row sets by account code (a subset of properties consolidated). */
export function mergeRows(rowSets: AccountBalanceRow[][]): AccountBalanceRow[] {
  const byCode = new Map<string, AccountBalanceRow>();
  for (const rows of rowSets) {
    for (const row of rows) {
      const existing = byCode.get(row.code);
      if (existing) {
        existing.debit = existing.debit.plus(row.debit);
        existing.credit = existing.credit.plus(row.credit);
      } else {
        byCode.set(row.code, { ...row });
      }
    }
  }
  return Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code));
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
