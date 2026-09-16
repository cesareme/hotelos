// PyG por centro de trabajo (Tanda 6b · L5 · design §5.4 GET /accounting/pnl/by-property).
//
// One matrix «cuenta × centro» over the P&L movements of a period: every
// hotel of the sociedad, the corporate centres («Oficina central» / other),
// the entries booked without a centre («Sin asignar», society-level) and the
// whole-sociedad total, which is the SAME ledger read the PyG of the cuentas
// anuales uses (source.accountBalances, mode movements, groups 6-7), so the
// last column equals the PGC result and the reconciliation proves that
// total = Σ centres + sin asignar for every account. PGC presentation sign:
// income positive, expenses negative. The optional allocation (R5) splits the
// OPERATING cost of the corporate centres over the hotels for reporting only —
// no entry is posted, the diario is never touched.
//
// Base of the allocation (fix t6b#16): the same as the USALI comparison. The
// corporate centres' rows go through `computeUsaliPnl` with the organisation's
// mappings and the amount split is −GOP (`corporateCostFromGop`), never their
// PGC net result: a financial income of the office (769) or its depreciation
// stays in the office column and is not handed to the hotels, and an office
// with an operating profit allocates nothing (warning). `netResultAfterAllocation`
// therefore moves exactly the allocated operating cost: hotels net − share,
// corporate centres net + their own operating cost (their below-GOP items stay).

import type { CorporateAllocationMethod, FinanceEntityBadge, PnlByProperty, PnlByPropertyRow, PnlByPropertyTotals, UsaliPnl } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { computeCorporateAllocation, corporateBaseWarnings, corporateCostFromGop, getCorporateAllocation, type AllocationFacts } from "./allocation.service.js";
import { D, ZERO, fromMoney, money, sameCents, sumDec, type Dec } from "./money.js";
import { entityBadgeOf, isHotelCentre, nightsBetween, prismaFinancialStatementsSource, toWorkCentre, type AccountBalanceRow, type FinancialStatementsSource, type PropertyLite } from "./source.js";
import { computeUsaliPnl } from "./usali.service.js";

const creditNatural = (row: { debit: Dec; credit: Dec }): Dec => row.credit.minus(row.debit);

export type PnlByPropertyComputeInput = {
  organizationId: string;
  entity: FinanceEntityBadge;
  period: { from: string; to: string };
  /** Hotels first, then corporate centres (source.properties order). */
  properties: PropertyLite[];
  rowsByProperty: ReadonlyMap<string, AccountBalanceRow[]>;
  unassignedRows: AccountBalanceRow[];
  totalRows: AccountBalanceRow[];
  allocation: PnlByPropertyAllocationInput | null;
  generatedAt?: string;
};

/** The part of a corporate centre's USALI statement the allocation base reads (GOP and the unmapped accounts). */
export type CorporateUsaliBase = Pick<UsaliPnl, "gop" | "unassigned">;

export type PnlByPropertyAllocationInput = {
  method: CorporateAllocationMethod;
  facts: AllocationFacts;
  manualWeights?: Array<{ propertyId: string; weight: number }>;
  /** USALI statement of EACH corporate centre over the same rows (`corporateUsaliBases`): the base is Σ −GOP, as in the USALI comparison. */
  corporate: ReadonlyMap<string, CorporateUsaliBase>;
};

/** USALI statement of every corporate centre from the rows already read for the matrix (no occupancy: the office has no rooms). */
export function corporateUsaliBases(input: { organizationId: string; period: { from: string; to: string }; corporate: readonly PropertyLite[]; rowsByProperty: ReadonlyMap<string, AccountBalanceRow[]>; mappings: Parameters<typeof computeUsaliPnl>[0]["mappings"] }): Map<string, CorporateUsaliBase> {
  const bases = new Map<string, CorporateUsaliBase>();
  for (const centre of input.corporate) {
    const pnl = computeUsaliPnl({
      organizationId: input.organizationId,
      propertyId: centre.id,
      propertyName: centre.name,
      propertyKind: centre.kind,
      propertyCode: centre.code,
      period: input.period,
      currency: centre.currency,
      rows: input.rowsByProperty.get(centre.id) ?? [],
      mappings: input.mappings,
      occupancy: { roomsInventory: 0, roomsOccupied: 0 }
    });
    bases.set(centre.id, { gop: pnl.gop, unassigned: pnl.unassigned });
  }
  return bases;
}

type Column = { propertyId: string | null; rows: AccountBalanceRow[] };

function amountsByCode(rows: AccountBalanceRow[]): Map<string, { row: AccountBalanceRow; amount: Dec }> {
  const out = new Map<string, { row: AccountBalanceRow; amount: Dec }>();
  for (const row of rows) {
    if (row.kind !== "income" && row.kind !== "expense") continue;
    out.set(row.code, { row, amount: creditNatural(row) });
  }
  return out;
}

export function computePnlByProperty(input: PnlByPropertyComputeInput): PnlByProperty {
  const warnings: string[] = [];
  const columns: Column[] = [...input.properties.map((p) => ({ propertyId: p.id, rows: input.rowsByProperty.get(p.id) ?? [] })), { propertyId: null, rows: input.unassignedRows }];
  const perColumn = columns.map((column) => ({ propertyId: column.propertyId, amounts: amountsByCode(column.rows) }));
  const total = amountsByCode(input.totalRows);

  const codes = new Set<string>(total.keys());
  for (const column of perColumn) for (const code of column.amounts.keys()) codes.add(code);

  const rows: PnlByPropertyRow[] = [];
  const rowsOff: string[] = [];
  const columnTotals = { revenue: new Map<string | null, Dec>(), expense: new Map<string | null, Dec>() };
  const add = (bucket: Map<string | null, Dec>, key: string | null, amount: Dec): void => {
    bucket.set(key, (bucket.get(key) ?? ZERO).plus(amount));
  };
  let totalRevenue = ZERO;
  let totalExpense = ZERO;

  for (const code of Array.from(codes).sort((a, b) => a.localeCompare(b))) {
    const sample = total.get(code)?.row ?? perColumn.map((c) => c.amounts.get(code)?.row).find((r): r is AccountBalanceRow => Boolean(r))!;
    const kind: PnlByPropertyRow["kind"] = sample.kind === "income" ? "income" : "expense";
    const byProperty: Record<string, string> = {};
    let unassigned = ZERO;
    let sumColumns = ZERO;
    for (const column of perColumn) {
      const amount = column.amounts.get(code)?.amount ?? ZERO;
      sumColumns = sumColumns.plus(amount);
      if (column.propertyId === null) unassigned = amount;
      else byProperty[column.propertyId] = money(amount);
      add(columnTotals[kind === "income" ? "revenue" : "expense"], column.propertyId, kind === "income" ? amount : amount.negated());
    }
    const totalAmount = total.get(code)?.amount ?? ZERO;
    if (kind === "income") totalRevenue = totalRevenue.plus(totalAmount);
    else totalExpense = totalExpense.plus(totalAmount.negated());
    if (!sameCents(sumColumns, totalAmount)) rowsOff.push(code);
    rows.push({ accountCode: code, label: sample.name, kind, byProperty, unassigned: money(unassigned), total: money(totalAmount) });
  }
  if (rowsOff.length > 0) warnings.push(`${rowsOff.length} cuenta(s) cuya suma por centros no coincide con el total de la sociedad: ${rowsOff.slice(0, 5).join(", ")}${rowsOff.length > 5 ? "…" : ""}.`);

  const totals = (bucket: Map<string | null, Dec>, total: Dec): PnlByPropertyTotals => ({
    byProperty: Object.fromEntries(input.properties.map((p) => [p.id, money(bucket.get(p.id) ?? ZERO)])),
    unassigned: money(bucket.get(null) ?? ZERO),
    total: money(total)
  });
  const revenue = totals(columnTotals.revenue, totalRevenue);
  const expense = totals(columnTotals.expense, totalExpense);
  const net = new Map<string | null, Dec>();
  for (const column of perColumn) net.set(column.propertyId, (columnTotals.revenue.get(column.propertyId) ?? ZERO).minus(columnTotals.expense.get(column.propertyId) ?? ZERO));
  const netResult = totals(net, totalRevenue.minus(totalExpense));

  let allocation: PnlByProperty["allocation"] = null;
  if (input.allocation && input.allocation.method !== "none") {
    const hotels = input.properties.filter(isHotelCentre);
    const corporate = input.properties.filter((p) => !isHotelCentre(p));
    if (corporate.length === 0) {
      warnings.push("La sociedad no tiene oficina central ni centros no alojativos: no hay coste corporativo que repartir.");
    } else {
      // Same base as the USALI comparison: Σ −GOP of the corporate centres (operating cost), never their PGC net result.
      const missing = corporate.filter((p) => !input.allocation!.corporate.has(p.id));
      const costOf = (centre: PropertyLite): Dec => {
        const base = input.allocation!.corporate.get(centre.id);
        return base ? corporateCostFromGop(fromMoney(base.gop)) : ZERO;
      };
      const corporateCost = sumDec(corporate.map(costOf));
      const result = computeCorporateAllocation({ method: input.allocation.method, corporateCost, hotelIds: hotels.map((h) => h.id), facts: input.allocation.facts, manualWeights: input.allocation.manualWeights });
      result.warnings.push(...corporateBaseWarnings({ unassigned: { accounts: corporate.flatMap((p) => input.allocation!.corporate.get(p.id)?.unassigned.accounts ?? []) } }));
      if (missing.length > 0) result.warnings.push(`${missing.length} centro(s) corporativo(s) sin estado USALI (${missing.map((p) => p.code ?? p.name).join(", ")}): su coste operativo cuenta como 0,00 en la base del reparto.`);
      const after: Record<string, string> = {};
      for (const hotel of hotels) {
        const share = result.shares.find((s) => s.propertyId === hotel.id);
        after[hotel.id] = money((net.get(hotel.id) ?? ZERO).minus(share ? D(share.amount) : ZERO));
      }
      // The allocated operating cost leaves each corporate centre (net + its −GOP); its below-GOP items stay. Untouched when nothing was allocated.
      for (const centre of corporate) after[centre.id] = money(result.applied ? (net.get(centre.id) ?? ZERO).plus(costOf(centre)) : (net.get(centre.id) ?? ZERO));
      allocation = { ...result, netResultAfterAllocation: after };
    }
  }

  return {
    kind: "pnl_by_property",
    organizationId: input.organizationId,
    entity: input.entity,
    period: input.period,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    properties: input.properties.map(toWorkCentre),
    rows,
    revenue,
    expense,
    netResult,
    reconciliation: { ok: rowsOff.length === 0, rowsOff },
    allocation,
    warnings
  };
}

/** Facts of the automatic allocation keys for a set of hotels (revenue from the rows read here, rooms and headcount from the source). */
export async function allocationFactsFor(source: FinancialStatementsSource, organizationId: string, hotels: PropertyLite[], period: { from: string; to: string }, revenueOf: (propertyId: string) => Dec): Promise<AllocationFacts> {
  const nights = nightsBetween(period.from, period.to);
  const roomsAvailable = new Map<string, number>();
  for (const hotel of hotels) {
    const occupancy = await source.occupancy([hotel.id], period.from, period.to);
    roomsAvailable.set(hotel.id, occupancy.roomsInventory * nights);
  }
  const headcount = new Map<string, number>();
  for (const row of await source.headcountByProperty(organizationId, period.from, period.to)) if (row.propertyId) headcount.set(row.propertyId, row.headcount);
  return { revenue: new Map(hotels.map((h) => [h.id, revenueOf(h.id)])), roomsAvailable, headcount };
}

export async function buildPnlByProperty(input: {
  context: UserContext;
  from: string;
  to: string;
  /** Overrides the stored key for this response (`none` disables it). */
  allocation?: CorporateAllocationMethod | null;
  source?: FinancialStatementsSource;
}): Promise<PnlByProperty> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  const period = { from: input.from, to: input.to };
  const [properties, identity, stored] = await Promise.all([source.properties(organizationId), source.legalIdentity(organizationId), getCorporateAllocation(organizationId, source)]);
  const rowsByProperty = new Map<string, AccountBalanceRow[]>();
  for (const property of properties) {
    rowsByProperty.set(property.id, await source.accountBalances({ organizationId, propertyId: property.id, mode: "movements", from: input.from, to: input.to, groups: [6, 7] }));
  }
  const [unassignedRows, totalRows] = await Promise.all([
    source.accountBalances({ organizationId, propertyId: null, unassignedOnly: true, mode: "movements", from: input.from, to: input.to, groups: [6, 7] }),
    source.accountBalances({ organizationId, propertyId: null, mode: "movements", from: input.from, to: input.to, groups: [6, 7] })
  ]);
  const method = input.allocation ?? stored.allocation.method;
  let allocation: PnlByPropertyComputeInput["allocation"] = null;
  if (method !== "none") {
    const hotels = properties.filter(isHotelCentre);
    const corporate = properties.filter((p) => !isHotelCentre(p));
    const revenueOf = (propertyId: string): Dec => sumDec((rowsByProperty.get(propertyId) ?? []).filter((r) => r.kind === "income").map(creditNatural));
    // The base of the split is the USALI −GOP of the corporate centres (same rows, same mappings as /accounting/usali/compare).
    const mappings = corporate.length > 0 ? await source.usaliMappings(organizationId) : [];
    allocation = {
      method,
      facts: await allocationFactsFor(source, organizationId, hotels, period, revenueOf),
      manualWeights: stored.allocation.method === "manual" ? stored.allocation.weights : undefined,
      corporate: corporateUsaliBases({ organizationId, period, corporate, rowsByProperty, mappings })
    };
  }
  return computePnlByProperty({ organizationId, entity: entityBadgeOf(identity), period, properties, rowsByProperty, unassignedRows, totalRows, allocation });
}
