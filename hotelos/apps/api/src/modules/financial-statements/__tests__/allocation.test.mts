// Reparto informativo de la oficina central (Tanda 6b · L5 · R5): pure helpers
// of allocation.service.ts. No database. Run from apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/allocation.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { ALLOCATION_BASIS_LABEL, ALLOCATION_LABEL, allocateAmount, computeCorporateAllocation, corporateBaseWarnings, corporateCostFromGop, parseCorporateAllocation, weightsFor, type AllocationFacts } from "../allocation.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);

const facts: AllocationFacts = {
  revenue: new Map([
    ["ra", D("1000.00")],
    ["lt", D("500.00")]
  ]),
  roomsAvailable: new Map([
    ["ra", 3100],
    ["lt", 2852]
  ]),
  headcount: new Map([["ra", 12]])
};

describe("allocateAmount", () => {
  it("splits to the cent and the rounding remainder lands on the largest weight", () => {
    const shares = allocateAmount(D("100.00"), [
      { propertyId: "a", weight: D(1) },
      { propertyId: "b", weight: D(1) },
      { propertyId: "c", weight: D(1) }
    ]);
    assert.deepEqual(shares.map((s) => [s.propertyId, s.amount, s.share]), [["a", "33.34", "0.3333"], ["b", "33.33", "0.3333"], ["c", "33.33", "0.3333"]]);
    const total = shares.reduce((sum, s) => sum.plus(D(s.amount)), D(0));
    assert.equal(total.toFixed(2), "100.00");
  });

  it("zero and negative weights are ignored; all-zero → no shares", () => {
    assert.deepEqual(allocateAmount(D("10.00"), [{ propertyId: "a", weight: D(0) }]), []);
    const shares = allocateAmount(D("10.00"), [
      { propertyId: "a", weight: D(0) },
      { propertyId: "b", weight: D(-3) },
      { propertyId: "c", weight: D(4) }
    ]);
    assert.deepEqual(shares.map((s) => [s.propertyId, s.amount, s.share]), [["c", "10.00", "1.0000"]]);
  });
});

describe("weightsFor", () => {
  it("revenue / rooms_available / headcount read the facts (missing hotel = 0; negative revenue = 0)", () => {
    assert.deepEqual(weightsFor("revenue", ["ra", "lt", "new"], { ...facts, revenue: new Map([...facts.revenue, ["new", D("-5.00")]]) }).weights.map((w) => [w.propertyId, w.weight.toString()]), [["ra", "1000"], ["lt", "500"], ["new", "0"]]);
    assert.deepEqual(weightsFor("rooms_available", ["ra", "lt"], facts).weights.map((w) => [w.propertyId, w.weight.toString()]), [["ra", "3100"], ["lt", "2852"]]);
    const headcount = weightsFor("headcount", ["ra", "lt"], facts);
    assert.deepEqual(headcount.weights.map((w) => [w.propertyId, w.weight.toString()]), [["ra", "12"], ["lt", "0"]]);
    assert.deepEqual(headcount.warnings, []);
    assert.match(weightsFor("headcount", ["ra"], { ...facts, headcount: new Map() }).warnings[0]!, /sin nóminas por centro/);
  });

  it("manual keeps only the hotels of the sociedad and warns about the rest", () => {
    const manual = weightsFor("manual", ["ra", "lt"], facts, [
      { propertyId: "ra", weight: 70 },
      { propertyId: "oc", weight: 30 }
    ]);
    assert.deepEqual(manual.weights.map((w) => [w.propertyId, w.weight.toString()]), [["ra", "70"]]);
    assert.match(manual.warnings[0]!, /1 peso\(s\) de centros que no son hoteles/);
    assert.match(weightsFor("manual", ["ra"], facts, []).warnings[0]!, /sin pesos válidos/);
    assert.deepEqual(weightsFor("none", ["ra"], facts).weights, []);
  });
});

describe("computeCorporateAllocation", () => {
  it("none → nothing allocated; applied keys split 100 % of the corporate cost and are never posted", () => {
    const none = computeCorporateAllocation({ method: "none", corporateCost: D("900.00"), hotelIds: ["ra", "lt"], facts });
    assert.deepEqual([none.applied, none.allocated, none.shares, none.posted, none.label], [false, "0.00", [], false, ALLOCATION_LABEL]);
    const byRooms = computeCorporateAllocation({ method: "rooms_available", corporateCost: D("900.00"), hotelIds: ["ra", "lt"], facts });
    assert.equal(byRooms.applied, true);
    assert.equal(byRooms.corporateCost, "900.00");
    assert.equal(byRooms.allocated, "900.00");
    // 3100 / 5952 · 900 = 468,75 → RA 468,75 · LT 431,25
    assert.deepEqual(byRooms.shares.map((s) => [s.propertyId, s.amount, s.basis]), [["ra", "468.75", "3100.00"], ["lt", "431.25", "2852.00"]]);
    assert.equal(byRooms.posted, false);
    assert.equal(byRooms.label, "Reparto corporativo (informativo · no contabilizado)");
    assert.deepEqual(byRooms.warnings, []);
  });

  it("a key without basis is reported and not applied; a zero corporate cost allocates 0,00 with a note", () => {
    const empty = computeCorporateAllocation({ method: "headcount", corporateCost: D("900.00"), hotelIds: ["ra", "lt"], facts: { ...facts, headcount: new Map() } });
    assert.equal(empty.applied, false);
    assert.equal(empty.shares.length, 0);
    assert.ok(empty.warnings.some((w) => /sin base en el periodo/.test(w)), empty.warnings.join("\n"));
    const zero = computeCorporateAllocation({ method: "revenue", corporateCost: D("0.00"), hotelIds: ["ra", "lt"], facts });
    assert.equal(zero.applied, true);
    assert.deepEqual(zero.shares.map((s) => s.amount), ["0.00", "0.00"]);
    assert.match(zero.warnings[0]!, /no tienen coste neto/);
  });

  it("t6b#16: a negative corporate cost (operating profit of the office) is never split as income; the base is the USALI −GOP", () => {
    const profit = computeCorporateAllocation({ method: "revenue", corporateCost: D("-150.00"), hotelIds: ["ra", "lt"], facts });
    assert.deepEqual([profit.applied, profit.allocated, profit.shares, profit.corporateCost, profit.posted], [false, "0.00", [], "-150.00", false]);
    assert.equal(profit.warnings.length, 1);
    assert.match(profit.warnings[0]!, /resultado operativo positivo en el periodo \(GOP 150\.00\): no hay coste que repartir/);
    // Every result names the shared base (USALI comparison and PyG por centro print the same corporateCost).
    assert.equal(profit.basis, "usali_corporate_gop");
    assert.equal(profit.basisLabel, ALLOCATION_BASIS_LABEL);
    assert.match(ALLOCATION_BASIS_LABEL, /−GOP USALI/);
    const applied = computeCorporateAllocation({ method: "revenue", corporateCost: D("900.00"), hotelIds: ["ra", "lt"], facts });
    assert.deepEqual([applied.basis, applied.basisLabel], ["usali_corporate_gop", ALLOCATION_BASIS_LABEL]);
    // −GOP → cost-positive; a positive GOP → negative «cost».
    assert.equal(corporateCostFromGop(D("-900.00")).toFixed(2), "900.00");
    assert.equal(corporateCostFromGop(D("200.00")).toFixed(2), "-200.00");
    // Unmapped corporate accounts are outside the base and reported once.
    assert.deepEqual(corporateBaseWarnings(null), []);
    assert.deepEqual(corporateBaseWarnings({ unassigned: { accounts: [] } }), []);
    const warnings = corporateBaseWarnings({ unassigned: { accounts: [{ code: "636" }, { code: "637" }] } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /2 cuenta\(s\) de los centros corporativos sin mapeo USALI \(636, 637\) quedan fuera de la base del reparto/);
  });

  it("manual weights must add up to 100 through weightsFor + allocateAmount (70/30 of 900 = 630/270)", () => {
    const manual = computeCorporateAllocation({ method: "manual", corporateCost: D("900.00"), hotelIds: ["ra", "lt"], facts, manualWeights: [{ propertyId: "ra", weight: 70 }, { propertyId: "lt", weight: 30 }] });
    assert.deepEqual(manual.shares.map((s) => [s.propertyId, s.amount, s.share]), [["ra", "630.00", "0.7000"], ["lt", "270.00", "0.3000"]]);
  });
});

describe("parseCorporateAllocation", () => {
  it("reads the stored contract and degrades anything malformed to none", () => {
    assert.deepEqual(parseCorporateAllocation({}), { method: "none" });
    assert.deepEqual(parseCorporateAllocation(null), { method: "none" });
    assert.deepEqual(parseCorporateAllocation({ corporateAllocation: { method: "rooms_available" } }), { method: "rooms_available" });
    assert.deepEqual(parseCorporateAllocation({ corporateAllocation: { method: "banana" } }), { method: "none" });
    assert.deepEqual(parseCorporateAllocation({ corporateAllocation: { method: "manual" } }), { method: "none" });
    assert.deepEqual(parseCorporateAllocation({ corporateAllocation: { method: "manual", weights: [{ propertyId: "ra", weight: 60 }, { propertyId: 3, weight: 40 }, { propertyId: "lt", weight: "x" }] } }), { method: "manual", weights: [{ propertyId: "ra", weight: 60 }] });
  });
});
