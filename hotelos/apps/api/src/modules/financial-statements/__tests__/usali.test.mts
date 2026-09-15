// USALI summary operating statement over the reference ledger: department
// buckets, GOP / EBITDA / net income, the visible «Sin asignar» line, the PGC
// reconciliation and the PAR/POR ratios from PMS occupancy. Run from apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/usali.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeUsaliPnl, mergeRows, usaliDeltas } from "../usali.service.js";
import { referenceLedger } from "./memory-source.mts";

const PERIOD = { from: "2027-01-01", to: "2027-03-31" };

async function referencePnl() {
  const source = referenceLedger();
  const rows = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", ...PERIOD, groups: [6, 7] });
  return computeUsaliPnl({ organizationId: "org_t", propertyId: "prop_t", propertyName: "Hotel Test", period: PERIOD, currency: "EUR", rows, mappings: [], occupancy: source.occupancyFacts });
}

describe("USALI statement", () => {
  it("buckets the reference ledger into departments with the canonical figures", async () => {
    const pnl = await referencePnl();
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenue, "100.00");
    assert.equal(rooms.labor, "1300.00"); // 640.1 + 642.1
    assert.equal(rooms.otherExpense, "15.00"); // 629.1 comisiones de canales → Habitaciones
    assert.equal(rooms.totalExpenses, "1315.00");
    assert.equal(rooms.departmentalProfit, "-1215.00");
    const fnb = pnl.operatingDepartments.find((d) => d.department === "fnb")!;
    assert.equal(fnb.revenue, "50.00");
    assert.equal(fnb.costOfSales, "40.00");
    assert.equal(fnb.departmentalProfit, "10.00");
    assert.equal(pnl.totalOperatingRevenue, "150.00");
    assert.equal(pnl.totalDepartmentalExpenses, "1355.00");
    assert.equal(pnl.totalDepartmentalProfit, "-1205.00");
    const utilities = pnl.undistributed.find((d) => d.department === "utilities")!;
    assert.equal(utilities.otherExpense, "80.00");
    assert.equal(pnl.totalUndistributed, "80.00");
    assert.equal(pnl.gop, "-1285.00");
    assert.equal(pnl.managementFees, "0.00");
    assert.equal(pnl.nonOperating.rent, "500.00");
    assert.equal(pnl.nonOperating.total, "500.00");
    assert.equal(pnl.ebitda, "-1785.00");
    assert.equal(pnl.belowEbitda.interest, "10.00");
    assert.equal(pnl.belowEbitda.depreciationAmortization, "100.00");
    assert.equal(pnl.netIncome, "-1895.00");
  });

  it("shows unmapped accounts in «Sin asignar» and reconciles with the PGC result", async () => {
    const pnl = await referencePnl();
    assert.deepEqual(pnl.unassigned.accounts.map((a) => a.code), ["645"]);
    assert.equal(pnl.unassigned.expense, "7.00");
    assert.equal(pnl.unassigned.net, "-7.00");
    assert.equal(pnl.reconciliation.pgcRevenue, "150.00");
    assert.equal(pnl.reconciliation.pgcExpense, "2052.00");
    assert.equal(pnl.reconciliation.pgcResult, "-1902.00");
    assert.equal(pnl.reconciliation.usaliNetIncomePlusUnassigned, "-1902.00");
    assert.equal(pnl.reconciliation.ok, true);
  });

  it("a reversed pair (annulled invoice + recalculated payroll) leaves the USALI statement and its PGC reconciliation untouched (hallazgo t6#2)", async () => {
    const source = referenceLedger();
    const sale = source.post({ date: "2027-02-10", propertyId: "prop_t", sourceType: "invoice", sourceId: "inv_x", lines: [{ code: "4300", debit: "363.00" }, { code: "705.1", credit: "300.00" }, { code: "477.21", credit: "63.00" }] });
    source.reverse(sale.id!, { date: "2027-02-11", sourceType: "invoice_cancellation", sourceId: "inv_x" });
    const slip = source.post({ date: "2027-02-28", propertyId: "prop_t", sourceType: "payroll_slip", sourceId: "slip_x", lines: [{ code: "640.1", debit: "2000.00" }, { code: "642.1", debit: "610.00" }, { code: "465", credit: "2610.00" }] });
    source.reverse(slip.id!, { sourceType: "payroll_slip_reversal", sourceId: "slip_x" });
    const rows = await source.accountBalances({ organizationId: "org_t", propertyId: "prop_t", mode: "movements", ...PERIOD, groups: [6, 7] });
    const pnl = computeUsaliPnl({ organizationId: "org_t", propertyId: "prop_t", propertyName: "Hotel Test", period: PERIOD, currency: "EUR", rows, mappings: [], occupancy: source.occupancyFacts });
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenue, "100.00"); // the buggy reader gave 100 − 300 = −200
    assert.equal(rooms.labor, "1300.00"); // and 1.300 − 2.610 = −1.310
    assert.equal(pnl.gop, "-1285.00");
    assert.equal(pnl.netIncome, "-1895.00");
    assert.equal(pnl.reconciliation.pgcRevenue, "150.00");
    assert.equal(pnl.reconciliation.pgcResult, "-1902.00");
    assert.equal(pnl.reconciliation.ok, true);
    assert.equal(pnl.ratios.revpar, "0.11");
  });

  it("computes PAR / POR ratios from the PMS occupancy and never fakes a 0 on an empty denominator", async () => {
    const pnl = await referencePnl();
    assert.equal(pnl.statistics.nights, 90);
    assert.equal(pnl.statistics.roomsInventory, 10);
    assert.equal(pnl.statistics.roomsAvailable, 900);
    assert.equal(pnl.statistics.roomsOccupied, 45);
    assert.equal(pnl.statistics.occupancyPct, "5.00");
    assert.equal(pnl.ratios.revpar, "0.11"); // 100 / 900
    assert.equal(pnl.ratios.adr, "2.22"); // 100 / 45
    assert.equal(pnl.ratios.trevpar, "0.17"); // 150 / 900
    assert.equal(pnl.ratios.goppar, "-1.43"); // −1285 / 900
    assert.equal(pnl.ratios.gopPOR, "-28.56"); // −1285 / 45
    const rooms = pnl.ratios.perDepartment.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenuePAR, "0.11");
    assert.equal(rooms.profitPOR, "-27.00"); // −1215 / 45
    const source = referenceLedger();
    const rows = await source.accountBalances({ organizationId: "org_t", mode: "movements", ...PERIOD, groups: [6, 7] });
    const empty = computeUsaliPnl({ organizationId: "org_t", propertyId: null, propertyName: null, period: PERIOD, currency: "EUR", rows, mappings: [], occupancy: { roomsInventory: 0, roomsOccupied: 0 } });
    assert.equal(empty.ratios.revpar, null);
    assert.equal(empty.ratios.adr, null);
    assert.equal(empty.statistics.occupancyPct, null);
  });

  it("an organisation mapping overrides the template (629.1 → ventas y marketing)", async () => {
    const source = referenceLedger();
    const rows = await source.accountBalances({ organizationId: "org_t", mode: "movements", ...PERIOD, groups: [6, 7] });
    const pnl = computeUsaliPnl({
      organizationId: "org_t",
      propertyId: null,
      propertyName: null,
      period: PERIOD,
      currency: "EUR",
      rows,
      mappings: [{ id: "m1", organizationId: "org_t", accountPrefix: "629.1", usaliDepartment: "sales_marketing", usaliLine: "other_expense", priority: 0, active: true, createdAt: new Date(), updatedAt: new Date() }],
      occupancy: source.occupancyFacts
    });
    assert.equal(pnl.operatingDepartments.find((d) => d.department === "rooms")!.otherExpense, "0.00");
    assert.equal(pnl.undistributed.find((d) => d.department === "sales_marketing")!.otherExpense, "15.00");
    assert.equal(pnl.gop, "-1285.00"); // moving a cost between departments never changes GOP
    assert.equal(pnl.reconciliation.ok, true);
  });

  it("period deltas compare against the base with amount and percentage", async () => {
    const base = await referencePnl();
    const compared = { ...base, gop: "-1000.00", ratios: { ...base.ratios, revpar: null } };
    const deltas = usaliDeltas(base, compared);
    const gop = deltas.find((d) => d.label === "GOP")!;
    assert.equal(gop.delta, "285.00");
    assert.equal(gop.deltaPct, "22.18"); // 285 / |−1285|
    const revpar = deltas.find((d) => d.label === "RevPAR")!;
    assert.equal(revpar.delta, null);
    assert.equal(revpar.deltaPct, null);
  });

  it("mergeRows sums row sets by account code", async () => {
    const source = referenceLedger();
    const rows = await source.accountBalances({ organizationId: "org_t", mode: "movements", ...PERIOD, groups: [6, 7] });
    const merged = mergeRows([rows, rows]);
    const rooms = merged.find((r) => r.code === "705.1")!;
    assert.equal(rooms.credit.toFixed(2), "200.00");
    assert.equal(merged.length, rows.length);
  });
});
