// USALI por centro con oficina central, «Sin asignar» y reparto informativo
// (Tanda 6b · L5 · design C5) and PyG por centro (GET /accounting/pnl/by-property)
// over the in-memory source: two hotels, one office, one society-level entry.
// Run from apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/usali-corporate.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserContext } from "../../../lib/demo-store.js";
import { buildPnlByProperty, computePnlByProperty, corporateUsaliBases } from "../pnl-by-property.service.js";
import { compareUsaliProperties, usaliCorporateAllocation, usaliRollup } from "../usali.service.js";
import { MemorySource, testIdentity, testProperty } from "./memory-source.mts";

const PERIOD = { from: "2028-03-01", to: "2028-03-31" };
const RA = "prop_ra";
const LT = "prop_lt";
const OC = "prop_oc";

const ctx: UserContext = {
  organizationId: "org_t",
  propertyId: RA,
  userId: "usr_t",
  fullName: "Directora",
  deviceId: "test",
  permissions: ["accounting.read", "accounting.entity.read"] as UserContext["permissions"]
};

/**
 * Faranda-like sociedad: RA (rooms 100 → rooms revenue 1.000, labor 300), LT
 * (rooms revenue 500, labor 200), OC office (admin labor 900, no revenue) and a
 * society-level entry without centre (bank interest 10 on 662).
 * GOP: RA 700 · LT 300 · OC −900 · unassigned 0 (interest is below EBITDA).
 */
function sociedad(): MemorySource {
  const s = new MemorySource("org_t");
  s.identity = testIdentity({ code: "FAR", legalName: "Faranda Test SA", taxId: "A58818501", legalForm: "sa" });
  s.props = [
    testProperty({ id: OC, name: "Oficina central", code: "OC", kind: "office", municipality: "Madrid" }),
    testProperty({ id: RA, name: "Hotel Rías Altas", code: "RA", municipality: "Oleiros" }),
    testProperty({ id: LT, name: "Hotel Los Tilos", code: "LT", municipality: "Teo" })
  ];
  s.occupancyByProperty.set(RA, { roomsInventory: 100, roomsOccupied: 2000 });
  s.occupancyByProperty.set(LT, { roomsInventory: 92, roomsOccupied: 1500 });
  s.peopleByProperty = [
    { propertyId: RA, headcount: 30 },
    { propertyId: LT, headcount: 20 },
    { propertyId: OC, headcount: 5 }
  ];
  s.post({ date: "2028-03-05", propertyId: RA, sourceType: "invoice", description: "Alojamiento RA", lines: [{ code: "4300", debit: "1100.00" }, { code: "705.1", credit: "1000.00" }, { code: "477.10", credit: "100.00" }] });
  s.post({ date: "2028-03-31", propertyId: RA, sourceType: "payroll_slip", description: "Nómina RA", lines: [{ code: "640.1", debit: "300.00" }, { code: "465", credit: "300.00" }] });
  s.post({ date: "2028-03-06", propertyId: LT, sourceType: "invoice", description: "Alojamiento LT", lines: [{ code: "4300", debit: "550.00" }, { code: "705.1", credit: "500.00" }, { code: "477.10", credit: "50.00" }] });
  s.post({ date: "2028-03-31", propertyId: LT, sourceType: "payroll_slip", description: "Nómina LT", lines: [{ code: "640.1", debit: "200.00" }, { code: "465", credit: "200.00" }] });
  s.post({ date: "2028-03-31", propertyId: OC, sourceType: "payroll_slip", description: "Nómina oficina", lines: [{ code: "640.3", debit: "900.00" }, { code: "465", credit: "900.00" }] });
  s.post({ date: "2028-03-31", propertyId: null, description: "Intereses bancarios (sociedad)", lines: [{ code: "662", debit: "10.00" }, { code: "572", credit: "10.00" }] });
  return s;
}

describe("compareUsaliProperties · includeCorporate (C5)", () => {
  it("without the flag the response is the pre-6b one (every centre + consolidated) plus the entity badge", async () => {
    const comparison = await compareUsaliProperties({ context: ctx, ...PERIOD, source: sociedad() });
    // Hotels by name (Los Tilos < Rías Altas), then the office.
    assert.deepEqual(comparison.properties.map((p) => [p.propertyId, p.propertyKind]), [[LT, "hotel"], [RA, "hotel"], [OC, "office"]]);
    assert.equal(comparison.corporate, undefined);
    assert.equal(comparison.rollup, undefined);
    assert.equal(comparison.allocation, undefined);
    assert.equal(comparison.entity?.legalName, "Faranda Test SA");
    assert.equal(comparison.entity?.taxId, "A58818501");
    assert.equal(comparison.consolidated.gop, "100.00"); // 700 + 300 − 900
    assert.equal(comparison.consolidated.netIncome, "90.00"); // − 10 interest of the sociedad
  });

  it("with the flag: hotels only, «Oficina central» column, «Sin asignar» and Total sociedad = Σ hoteles + Oficina + sin asignar", async () => {
    const comparison = await compareUsaliProperties({ context: ctx, ...PERIOD, includeCorporate: true, source: sociedad() });
    assert.deepEqual(comparison.properties.map((p) => [p.propertyId, p.propertyCode, p.pnl.gop]), [[LT, "LT", "300.00"], [RA, "RA", "700.00"]]);
    assert.ok(comparison.corporate, "corporate column present");
    assert.deepEqual(comparison.corporate!.centres.map((c) => [c.code, c.kind]), [["OC", "office"]]);
    assert.equal(comparison.corporate!.pnl.propertyKind, "office");
    assert.equal(comparison.corporate!.pnl.gop, "-900.00");
    // Per-room KPIs of the office are DegradedValue (null), never 0 (R6).
    assert.equal(comparison.corporate!.pnl.ratios.goppar, null);
    assert.equal(comparison.corporate!.pnl.statistics.roomsAvailable, 0);
    assert.ok(comparison.unassigned, "unassigned column present when every centre is selected");
    assert.equal(comparison.unassigned!.propertyName, "Sociedad (sin centro)");
    assert.equal(comparison.unassigned!.belowEbitda.interest, "10.00");
    assert.equal(comparison.unassigned!.netIncome, "-10.00");
    const gop = comparison.rollup!.find((r) => r.metric === "gop")!;
    assert.deepEqual([gop.hotels, gop.corporate, gop.unassigned, gop.total, gop.ok], ["1000.00", "-900.00", "0.00", "100.00", true]);
    const net = comparison.rollup!.find((r) => r.metric === "netIncome")!;
    assert.deepEqual([net.hotels, net.corporate, net.unassigned, net.total, net.ok], ["1000.00", "-900.00", "-10.00", "90.00", true]);
    assert.ok(comparison.rollup!.every((r) => r.ok), "every rollup metric reconciles");
    // Stored key is none → allocation block absent.
    assert.equal(comparison.allocation, null);
  });

  it("allocation=rooms_available adds the informative row: 100 % of the office GOP-level cost, no journal entry", async () => {
    const source = sociedad();
    const entriesBefore = source.entries.length;
    const comparison = await compareUsaliProperties({ context: ctx, ...PERIOD, includeCorporate: true, allocation: "rooms_available", source });
    assert.ok(comparison.allocation);
    const allocation = comparison.allocation!;
    assert.equal(allocation.method, "rooms_available");
    assert.equal(allocation.corporateCost, "900.00");
    assert.equal(allocation.allocated, "900.00");
    assert.equal(allocation.applied, true);
    assert.equal(allocation.posted, false);
    assert.equal(allocation.label, "Reparto corporativo (informativo · no contabilizado)");
    // 31 nights: LT 2.852 rooms · RA 3.100 rooms → 431,25 / 468,75 (hotels by name)
    assert.deepEqual(allocation.shares.map((s) => [s.propertyId, s.basis, s.amount]), [[LT, "2852.00", "431.25"], [RA, "3100.00", "468.75"]]);
    const ra = comparison.properties.find((p) => p.propertyId === RA)!;
    assert.deepEqual(ra.allocation, { allocated: "468.75", gopAfterAllocation: "231.25", ebitdaAfterAllocation: "231.25" });
    const lt = comparison.properties.find((p) => p.propertyId === LT)!;
    assert.deepEqual(lt.allocation, { allocated: "431.25", gopAfterAllocation: "-131.25", ebitdaAfterAllocation: "-131.25" });
    // Σ GOP after allocation = Σ GOP hotels − office cost = consolidated GOP (100,00).
    assert.equal(Number(ra.allocation!.gopAfterAllocation) + Number(lt.allocation!.gopAfterAllocation), 100);
    assert.equal(source.entries.length, entriesBefore, "cero asientos nuevos en el diario");
    // The headcount key reads the per-centre payroll facts (LT 20 / RA 30 → 360 / 540).
    const byHeadcount = await compareUsaliProperties({ context: ctx, ...PERIOD, includeCorporate: true, allocation: "headcount", source });
    assert.deepEqual(byHeadcount.allocation!.shares.map((s) => [s.propertyId, s.amount]), [[LT, "360.00"], [RA, "540.00"]]);
    // The stored key applies when the query does not name one.
    source.configuration = { corporateAllocation: { method: "manual", weights: [{ propertyId: RA, weight: 75 }, { propertyId: LT, weight: 25 }] } };
    const stored = await compareUsaliProperties({ context: ctx, ...PERIOD, includeCorporate: true, source });
    assert.equal(stored.allocation!.method, "manual");
    assert.deepEqual(stored.allocation!.shares.map((s) => [s.propertyId, s.amount]), [[RA, "675.00"], [LT, "225.00"]]);
  });

  it("a sociedad without office: corporate null, allocation requested → not applied with a Spanish warning", async () => {
    const source = sociedad();
    source.props = source.props.filter((p) => p.id !== OC);
    const comparison = await compareUsaliProperties({ context: ctx, ...PERIOD, includeCorporate: true, allocation: "revenue", source });
    assert.equal(comparison.corporate, null);
    assert.equal(comparison.allocation!.applied, false);
    assert.match(comparison.allocation!.warnings.at(-1)!, /no tiene oficina central/);
    // The office entry is still in the ledger but its centre is no longer a property of the sociedad: the rollup shows the gap honestly.
    const gop = comparison.rollup!.find((r) => r.metric === "gop")!;
    assert.equal(gop.ok, false);
  });

  it("usaliRollup and usaliCorporateAllocation are pure over the statements", async () => {
    const comparison = await compareUsaliProperties({ context: ctx, ...PERIOD, includeCorporate: true, source: sociedad() });
    const hotels = comparison.properties.map((p) => p.pnl);
    const rollup = usaliRollup(hotels, comparison.corporate!.pnl, comparison.unassigned!, comparison.consolidated);
    assert.equal(rollup.length, 6);
    const revenue = rollup.find((r) => r.metric === "totalOperatingRevenue")!;
    assert.deepEqual([revenue.hotels, revenue.corporate, revenue.unassigned, revenue.total], ["1500.00", "0.00", "0.00", "1500.00"]);
    const manual = usaliCorporateAllocation({ method: "manual", hotels, corporate: comparison.corporate!.pnl, headcount: new Map(), manualWeights: [{ propertyId: RA, weight: 50 }, { propertyId: LT, weight: 50 }] });
    assert.deepEqual(manual.allocation.shares.map((s) => s.amount), ["450.00", "450.00"]);
    assert.equal(manual.perHotel.get(LT)!.gopAfterAllocation, "-150.00");
  });
});

describe("computePnlByProperty (GET /accounting/pnl/by-property)", () => {
  async function matrix(allocation: "none" | "revenue" = "none", source: MemorySource = sociedad()) {
    const properties = await source.properties("org_t");
    const rowsByProperty = new Map<string, Awaited<ReturnType<typeof source.accountBalances>>>();
    for (const p of properties) rowsByProperty.set(p.id, await source.accountBalances({ organizationId: "org_t", propertyId: p.id, mode: "movements", ...PERIOD, groups: [6, 7] }));
    const unassignedRows = await source.accountBalances({ organizationId: "org_t", propertyId: null, unassignedOnly: true, mode: "movements", ...PERIOD, groups: [6, 7] });
    const totalRows = await source.accountBalances({ organizationId: "org_t", propertyId: null, mode: "movements", ...PERIOD, groups: [6, 7] });
    // Revenue key = Σ (credit − debit) of the income rows of each hotel: RA 1.000 · LT 500.
    const revenueOf = (id: string) => (rowsByProperty.get(id) ?? []).filter((r) => r.kind === "income").reduce((sum, r) => sum.plus(r.credit.minus(r.debit)), totalRows[0]!.debit.minus(totalRows[0]!.debit));
    return computePnlByProperty({
      organizationId: "org_t",
      entity: { legalEntityId: "le_t", code: "FAR", legalName: "Faranda Test SA", taxId: "A58818501", taxIdValid: true, legalForm: "sa", source: "legal_entity", pgcVariant: "pymes", largeCompany: false, siiEnabled: false },
      period: PERIOD,
      properties,
      rowsByProperty,
      unassignedRows,
      totalRows,
      allocation:
        allocation === "none"
          ? null
          : {
              method: allocation,
              facts: { revenue: new Map([[RA, revenueOf(RA)], [LT, revenueOf(LT)]]), roomsAvailable: new Map(), headcount: new Map() },
              // Same base as the USALI comparison: the office's USALI statement over the same rows and mappings.
              corporate: corporateUsaliBases({ organizationId: "org_t", period: PERIOD, corporate: properties.filter((p) => p.kind !== "hotel"), rowsByProperty, mappings: await source.usaliMappings("org_t") })
            }
    });
  }

  it("rows cuenta × centro with «Sin asignar» and the sociedad total; every row reconciles", async () => {
    const pnl = await matrix();
    assert.equal(pnl.kind, "pnl_by_property");
    // Hotels first, then the office.
    assert.deepEqual(pnl.properties.map((p) => [p.code, p.kind]), [["LT", "hotel"], ["RA", "hotel"], ["OC", "office"]]);
    const rooms = pnl.rows.find((r) => r.accountCode === "705.1")!;
    assert.deepEqual([rooms.kind, rooms.byProperty[RA], rooms.byProperty[LT], rooms.byProperty[OC], rooms.unassigned, rooms.total], ["income", "1000.00", "500.00", "0.00", "0.00", "1500.00"]);
    const officeLabor = pnl.rows.find((r) => r.accountCode === "640.3")!;
    assert.deepEqual([officeLabor.kind, officeLabor.byProperty[OC], officeLabor.byProperty[RA], officeLabor.total], ["expense", "-900.00", "0.00", "-900.00"]);
    const interest = pnl.rows.find((r) => r.accountCode === "662")!;
    assert.deepEqual([interest.unassigned, interest.total, interest.byProperty[RA]], ["-10.00", "-10.00", "0.00"]);
    assert.deepEqual(pnl.netResult, { byProperty: { [RA]: "700.00", [LT]: "300.00", [OC]: "-900.00" }, unassigned: "-10.00", total: "90.00" });
    assert.deepEqual(pnl.revenue.total, "1500.00");
    assert.deepEqual(pnl.expense.total, "1410.00");
    assert.deepEqual(pnl.reconciliation, { ok: true, rowsOff: [] });
    assert.equal(pnl.allocation, null);
    assert.deepEqual(pnl.warnings, []);
  });

  it("allocation=revenue splits the operating cost of the office (−GOP = 900) 2:1 and moves it to 0 — informative, never posted", async () => {
    const pnl = await matrix("revenue");
    assert.ok(pnl.allocation);
    assert.equal(pnl.allocation!.corporateCost, "900.00");
    assert.deepEqual(pnl.allocation!.shares.map((s) => [s.propertyId, s.amount]), [[LT, "300.00"], [RA, "600.00"]]);
    assert.deepEqual(pnl.allocation!.netResultAfterAllocation, { [RA]: "100.00", [LT]: "0.00", [OC]: "0.00" });
    assert.equal(pnl.allocation!.posted, false);
    assert.equal(pnl.allocation!.label, "Reparto corporativo (informativo · no contabilizado)");
    assert.deepEqual([pnl.allocation!.basis, pnl.allocation!.applied, pnl.allocation!.warnings], ["usali_corporate_gop", true, []]);
  });
});

/**
 * Fix t6b#16: USALI and the PyG por centro must show the SAME corporate cost
 * for the same period, and that cost is the operating cost of the office
 * (−GOP USALI) — never its PGC net result, which would hand a financial income
 * of the sociedad to the hotels as a negative «cost».
 */
describe("t6b#16 · USALI y PyG por centro comparten la base del reparto (−GOP de los centros corporativos)", () => {
  const JUNE = { from: "2028-06-01", to: "2028-06-30" };
  const JULY = { from: "2028-07-01", to: "2028-07-31" };
  const AUGUST = { from: "2028-08-01", to: "2028-08-31" };

  /** June: office asesoría 100 (623, admin_general) + financial income 250 (769, below EBITDA) → GOP −100, net +150. */
  function officeWithFinancialIncome(): MemorySource {
    const s = sociedad();
    s.post({ date: "2028-06-10", propertyId: OC, sourceType: "supplier_bill", description: "Asesoría fiscal (oficina)", lines: [{ code: "623", debit: "100.00" }, { code: "410", credit: "100.00" }] });
    s.post({ date: "2028-06-30", propertyId: OC, description: "Intereses a favor de la sociedad", lines: [{ code: "572", debit: "250.00" }, { code: "769", credit: "250.00" }] });
    // July: the office bills more than it spends above the GOP line (misc income 300 vs asesoría 100) → GOP +200.
    s.post({ date: "2028-07-10", propertyId: OC, sourceType: "supplier_bill", description: "Asesoría fiscal (oficina)", lines: [{ code: "623", debit: "100.00" }, { code: "410", credit: "100.00" }] });
    s.post({ date: "2028-07-20", propertyId: OC, sourceType: "invoice", description: "Servicios centrales facturados a terceros", lines: [{ code: "4300", debit: "300.00" }, { code: "759", credit: "300.00" }] });
    // August: an office account nobody mapped (636, template group 63 carries no USALI line) + asesoría 100.
    s.account("636", { usaliDepartment: null, usaliLine: null });
    s.post({ date: "2028-08-10", propertyId: OC, sourceType: "supplier_bill", description: "Asesoría fiscal (oficina)", lines: [{ code: "623", debit: "100.00" }, { code: "410", credit: "100.00" }] });
    s.post({ date: "2028-08-12", propertyId: OC, description: "Devolución de impuestos (sin mapeo USALI)", lines: [{ code: "636", debit: "50.00" }, { code: "572", credit: "50.00" }] });
    return s;
  }

  it("June: a financial income of the office stays in the office — both statements split −GOP (100), not the net result (−150)", async () => {
    const source = officeWithFinancialIncome();
    const usali = await compareUsaliProperties({ context: ctx, ...JUNE, includeCorporate: true, allocation: "rooms_available", source });
    assert.equal(usali.corporate!.pnl.gop, "-100.00");
    assert.equal(usali.corporate!.pnl.netIncome, "150.00");
    assert.deepEqual([usali.allocation!.corporateCost, usali.allocation!.allocated, usali.allocation!.applied, usali.allocation!.basis], ["100.00", "100.00", true, "usali_corporate_gop"]);

    const pnl = await buildPnlByProperty({ context: ctx, ...JUNE, allocation: "rooms_available", source });
    const financial = pnl.rows.find((r) => r.accountCode === "769")!;
    assert.deepEqual([financial.byProperty[OC], financial.byProperty[RA], financial.total], ["250.00", "0.00", "250.00"]);
    assert.deepEqual(pnl.netResult.byProperty, { [RA]: "0.00", [LT]: "0.00", [OC]: "150.00" });
    // The SAME base and the SAME shares as USALI (30 nights: LT 2.760 · RA 3.000 rooms → 47,92 / 52,08).
    assert.deepEqual([pnl.allocation!.corporateCost, pnl.allocation!.allocated, pnl.allocation!.applied, pnl.allocation!.basis, pnl.allocation!.basisLabel], ["100.00", "100.00", true, usali.allocation!.basis, usali.allocation!.basisLabel]);
    assert.deepEqual(pnl.allocation!.shares, usali.allocation!.shares);
    assert.deepEqual(pnl.allocation!.shares.map((s) => [s.propertyId, s.amount]), [[LT, "47.92"], [RA, "52.08"]]);
    // The hotels absorb the operating cost; the office keeps its financial income (150 + 100 = 250); Σ after = Σ before.
    assert.deepEqual(pnl.allocation!.netResultAfterAllocation, { [RA]: "-52.08", [LT]: "-47.92", [OC]: "250.00" });
    const sumAfter = Object.values(pnl.allocation!.netResultAfterAllocation).reduce((sum, v) => sum + Number(v), 0);
    assert.equal(sumAfter.toFixed(2), "150.00");
    assert.deepEqual(pnl.allocation!.warnings, []);
    assert.equal(pnl.allocation!.posted, false);
    assert.equal(source.entries.filter((e) => e.date >= JUNE.from && e.date <= JUNE.to).length, 2, "cero asientos nuevos");
  });

  it("July: an office with an operating profit (GOP +200) allocates nothing in either statement — warning, never a negative «cost» as income", async () => {
    const source = officeWithFinancialIncome();
    const usali = await compareUsaliProperties({ context: ctx, ...JULY, includeCorporate: true, allocation: "rooms_available", source });
    assert.equal(usali.corporate!.pnl.gop, "200.00");
    assert.deepEqual([usali.allocation!.applied, usali.allocation!.corporateCost, usali.allocation!.allocated, usali.allocation!.shares], [false, "-200.00", "0.00", []]);
    assert.match(usali.allocation!.warnings[0]!, /resultado operativo positivo en el periodo \(GOP 200\.00\): no hay coste que repartir/);
    for (const property of usali.properties) assert.deepEqual(property.allocation, { allocated: "0.00", gopAfterAllocation: property.pnl.gop, ebitdaAfterAllocation: property.pnl.ebitda });

    const pnl = await buildPnlByProperty({ context: ctx, ...JULY, allocation: "rooms_available", source });
    assert.deepEqual([pnl.allocation!.applied, pnl.allocation!.corporateCost, pnl.allocation!.shares], [false, "-200.00", []]);
    assert.match(pnl.allocation!.warnings[0]!, /resultado operativo positivo/);
    // Nothing moves: after = before in every column.
    assert.deepEqual(pnl.allocation!.netResultAfterAllocation, pnl.netResult.byProperty);
    assert.equal(pnl.netResult.byProperty[OC], "200.00");
  });

  it("August: an office account without USALI mapping is outside the base in both statements and both say so", async () => {
    const source = officeWithFinancialIncome();
    const usali = await compareUsaliProperties({ context: ctx, ...AUGUST, includeCorporate: true, allocation: "rooms_available", source });
    assert.equal(usali.corporate!.pnl.gop, "-100.00");
    assert.deepEqual(usali.corporate!.pnl.unassigned.accounts.map((a) => a.code), ["636"]);
    assert.equal(usali.allocation!.corporateCost, "100.00");
    assert.ok(usali.allocation!.warnings.some((w) => /sin mapeo USALI \(636\)/.test(w)), usali.allocation!.warnings.join("\n"));

    const pnl = await buildPnlByProperty({ context: ctx, ...AUGUST, allocation: "rooms_available", source });
    assert.equal(pnl.netResult.byProperty[OC], "-150.00", "the PGC column still shows the whole office result");
    assert.deepEqual([pnl.allocation!.corporateCost, pnl.allocation!.applied], ["100.00", true]);
    assert.deepEqual(pnl.allocation!.shares, usali.allocation!.shares);
    assert.ok(pnl.allocation!.warnings.some((w) => /sin mapeo USALI \(636\)/.test(w)), pnl.allocation!.warnings.join("\n"));
    // −150 + 100 = −50: the unmapped 50 stays in the office column after the allocation.
    assert.equal(pnl.allocation!.netResultAfterAllocation[OC], "-50.00");
  });

  it("a corporate centre missing from the USALI bases counts as 0,00 and is reported (pure function)", async () => {
    const source = sociedad();
    const properties = await source.properties("org_t");
    const rowsByProperty = new Map<string, Awaited<ReturnType<typeof source.accountBalances>>>();
    for (const p of properties) rowsByProperty.set(p.id, await source.accountBalances({ organizationId: "org_t", propertyId: p.id, mode: "movements", ...PERIOD, groups: [6, 7] }));
    const pnl = computePnlByProperty({
      organizationId: "org_t",
      entity: testIdentity({ code: "FAR" }),
      period: PERIOD,
      properties,
      rowsByProperty,
      unassignedRows: [],
      totalRows: await source.accountBalances({ organizationId: "org_t", propertyId: null, mode: "movements", ...PERIOD, groups: [6, 7] }),
      allocation: { method: "manual", facts: { revenue: new Map(), roomsAvailable: new Map(), headcount: new Map() }, manualWeights: [{ propertyId: RA, weight: 100 }], corporate: new Map() }
    });
    assert.deepEqual([pnl.allocation!.corporateCost, pnl.allocation!.applied], ["0.00", true]);
    assert.ok(pnl.allocation!.warnings.some((w) => /1 centro\(s\) corporativo\(s\) sin estado USALI \(OC\)/.test(w)), pnl.allocation!.warnings.join("\n"));
  });
});
