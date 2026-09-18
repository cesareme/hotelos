// Unit tests · cancellation-policy engine (Tanda L3 · lote B). Pure: no
// database — `computeChargeForPolicy`, `wallClockInstant` and
// `resolvePolicyFromCandidates` take everything as arguments.
//   · the free-cancel window closes at 14:00 HOTEL time of the arrival day
//     (Europe/Madrid), not 14:00 UTC — the same cancellation is late in Madrid
//     and still free under the old UTC reading;
//   · DST day: 14:00 local is 12:00Z in summer time, 13:00Z in winter time;
//   · freeCancelHours 0 = non-refundable; first_night / percent / fixed_amount /
//     all_stay / none; no-show never free;
//   · resolution id → code → active default → null, never «first active by code».
// Run from apps/api with
//   node --import tsx --test src/modules/cancellation-policy/__tests__/cancellation-charge.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARRIVAL_CUTOFF_HOUR,
  computeChargeForPolicy,
  resolvePolicyFromCandidates,
  wallClockInstant,
  type CancellationPolicyRecord,
  type PolicyForCharge
} from "../cancellation-policy.service.js";

const MADRID = "Europe/Madrid";

function policy(overrides: Partial<PolicyForCharge> & { code: string }): PolicyForCharge {
  return {
    name: overrides.code,
    freeCancelHours: 24,
    penaltyType: "first_night",
    penaltyValue: null,
    noShowPenaltyType: "first_night",
    noShowPenaltyValue: null,
    ...overrides
  };
}

function record(overrides: Partial<CancellationPolicyRecord> & { id: string; code: string }): CancellationPolicyRecord {
  return {
    propertyId: "prop_test",
    name: overrides.code,
    description: null,
    freeCancelHours: 24,
    penaltyType: "first_night",
    penaltyValue: null,
    noShowPenaltyType: "first_night",
    noShowPenaltyValue: null,
    active: true,
    isDefault: false,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides
  };
}

const FLEX = policy({ code: "FLEX", freeCancelHours: 24 });
const SEMI = policy({ code: "SEMI", freeCancelHours: 72 });
const NREF = policy({ code: "NREF", freeCancelHours: 0, penaltyType: "all_stay", noShowPenaltyType: "all_stay" });

/** 3 nights, 300 € → first night 100 €. Arrival 2026-10-10 (CEST). */
const STAY = { totalAmount: 300, arrivalDate: new Date("2026-10-10T00:00:00.000Z"), departureDate: new Date("2026-10-13T00:00:00.000Z") };

describe("wallClockInstant · 14:00 in the hotel's time zone", () => {
  it("Europe/Madrid summer time: 14:00 CEST = 12:00Z; winter time: 14:00 CET = 13:00Z", () => {
    assert.equal(ARRIVAL_CUTOFF_HOUR, 14);
    assert.equal(wallClockInstant("2026-10-10", 14, MADRID).toISOString(), "2026-10-10T12:00:00.000Z");
    assert.equal(wallClockInstant(new Date("2026-12-10T00:00:00.000Z"), 14, MADRID).toISOString(), "2026-12-10T13:00:00.000Z");
    assert.equal(wallClockInstant("2026-10-10", 14, "UTC").toISOString(), "2026-10-10T14:00:00.000Z");
  });

  it("DST switch day (2026-03-29 → CEST) and the day before (CET)", () => {
    assert.equal(wallClockInstant("2026-03-29", 14, MADRID).toISOString(), "2026-03-29T12:00:00.000Z");
    assert.equal(wallClockInstant("2026-03-28", 14, MADRID).toISOString(), "2026-03-28T13:00:00.000Z");
    assert.equal(wallClockInstant("2026-10-25", 14, MADRID).toISOString(), "2026-10-25T13:00:00.000Z");
  });
});

describe("computeChargeForPolicy · cancellation window", () => {
  it("FLEX 24 h: 24,5 h before 14:00 Madrid → free; 23,5 h before → first night (100 €)", () => {
    const free = computeChargeForPolicy(FLEX, STAY, new Date("2026-10-09T11:30:00.000Z"), MADRID, "cancellation");
    assert.deepEqual([free.amount, free.basis, free.withinFreeWindow, free.policyCode, free.cutoffAt], [0, "none", true, "FLEX", "2026-10-10T12:00:00.000Z"]);
    assert.match(free.label, /gratuita/);

    const late = computeChargeForPolicy(FLEX, STAY, new Date("2026-10-09T12:30:00.000Z"), MADRID, "cancellation");
    assert.deepEqual([late.amount, late.basis, late.withinFreeWindow, late.policyCode], [100, "first_night", false, "FLEX"]);
    assert.match(late.label, /tardía/);
    assert.match(late.label, /primera noche/);
  });

  it("the same instant is late in Madrid but free under a UTC reading of 14:00 (the old behaviour)", () => {
    const cancelAt = new Date("2026-10-09T12:30:00.000Z");
    assert.equal(computeChargeForPolicy(FLEX, STAY, cancelAt, MADRID, "cancellation").amount, 100);
    assert.equal(computeChargeForPolicy(FLEX, STAY, cancelAt, "UTC", "cancellation").amount, 0);
  });

  it("exactly 24 h before the cutoff is still free (≥); one second later is late", () => {
    assert.equal(computeChargeForPolicy(FLEX, STAY, new Date("2026-10-09T12:00:00.000Z"), MADRID, "cancellation").amount, 0);
    assert.equal(computeChargeForPolicy(FLEX, STAY, new Date("2026-10-09T12:00:01.000Z"), MADRID, "cancellation").amount, 100);
  });

  it("SEMI 72 h: 3 days + 1 h before → free; 71 h before → first night", () => {
    assert.equal(computeChargeForPolicy(SEMI, STAY, new Date("2026-10-07T11:00:00.000Z"), MADRID, "cancellation").amount, 0);
    assert.equal(computeChargeForPolicy(SEMI, STAY, new Date("2026-10-07T13:00:00.000Z"), MADRID, "cancellation").amount, 100);
  });

  it("freeCancelHours 0 (non-refundable): never free, even months ahead; all_stay = 300 €", () => {
    const early = computeChargeForPolicy(NREF, STAY, new Date("2026-01-01T00:00:00.000Z"), MADRID, "cancellation");
    assert.deepEqual([early.amount, early.basis, early.withinFreeWindow], [300, "all_stay", false]);
  });

  it("after arrival (cancelAt past the cutoff) the penalty applies", () => {
    assert.equal(computeChargeForPolicy(FLEX, STAY, new Date("2026-10-11T08:00:00.000Z"), MADRID, "cancellation").amount, 100);
  });
});

describe("computeChargeForPolicy · penalty types", () => {
  const late = new Date("2026-10-10T10:00:00.000Z");

  it("percent 50 % of the total → 150 €; fixed_amount 30 → 30 €; all_stay → 300 €; none → 0 €", () => {
    const pct = computeChargeForPolicy(policy({ code: "PCT", penaltyType: "percent", penaltyValue: 50 }), STAY, late, MADRID, "cancellation");
    assert.deepEqual([pct.amount, pct.basis], [150, "percent"]);
    assert.match(pct.label, /50% del total/);
    const fixed = computeChargeForPolicy(policy({ code: "FIX", penaltyType: "fixed_amount", penaltyValue: 30 }), STAY, late, MADRID, "cancellation");
    assert.deepEqual([fixed.amount, fixed.basis], [30, "fixed_amount"]);
    assert.match(fixed.label, /30\.00 €/);
    const all = computeChargeForPolicy(policy({ code: "ALL", penaltyType: "all_stay" }), STAY, late, MADRID, "cancellation");
    assert.deepEqual([all.amount, all.basis], [300, "all_stay"]);
    const none = computeChargeForPolicy(policy({ code: "NONE", penaltyType: "none" }), STAY, late, MADRID, "cancellation");
    assert.deepEqual([none.amount, none.basis, none.withinFreeWindow], [0, "none", false]);
    assert.match(none.label, /sin cargo/);
  });

  it("first night = total / nights, rounded to cents (100 € / 3 nights → 33,33 €); a 1-night stay charges the total", () => {
    const thirds = computeChargeForPolicy(FLEX, { ...STAY, totalAmount: 100 }, late, MADRID, "cancellation");
    assert.equal(thirds.amount, 33.33);
    const one = computeChargeForPolicy(FLEX, { totalAmount: 120, arrivalDate: "2026-10-10", departureDate: "2026-10-11" }, late, MADRID, "cancellation");
    assert.equal(one.amount, 120);
  });

  it("percent / fixed_amount without a value charge 0", () => {
    assert.equal(computeChargeForPolicy(policy({ code: "P0", penaltyType: "percent", penaltyValue: null }), STAY, late, MADRID, "cancellation").amount, 0);
    assert.equal(computeChargeForPolicy(policy({ code: "F0", penaltyType: "fixed_amount", penaltyValue: null }), STAY, late, MADRID, "cancellation").amount, 0);
  });
});

describe("computeChargeForPolicy · no-show", () => {
  it("never free: FLEX no-show months ahead → first night; NREF → all stay; label «No-show»", () => {
    const early = new Date("2026-01-01T00:00:00.000Z");
    const flex = computeChargeForPolicy(FLEX, STAY, early, MADRID, "no_show");
    assert.deepEqual([flex.amount, flex.basis, flex.withinFreeWindow, flex.cutoffAt], [100, "first_night", false, null]);
    assert.match(flex.label, /^No-show — FLEX/);
    const nref = computeChargeForPolicy(NREF, STAY, early, MADRID, "no_show");
    assert.deepEqual([nref.amount, nref.basis], [300, "all_stay"]);
  });

  it("uses the no-show penalty, not the cancellation one; «none» → 0 € with its own label", () => {
    const mixed = policy({ code: "MIX", penaltyType: "all_stay", noShowPenaltyType: "fixed_amount", noShowPenaltyValue: 45 });
    const charge = computeChargeForPolicy(mixed, STAY, new Date("2026-10-12T00:00:00.000Z"), MADRID, "no_show");
    assert.deepEqual([charge.amount, charge.basis], [45, "fixed_amount"]);
    const none = computeChargeForPolicy(policy({ code: "NN", noShowPenaltyType: "none" }), STAY, new Date(), MADRID, "no_show");
    assert.equal(none.amount, 0);
    assert.match(none.label, /No-show sin cargo/);
  });
});

describe("resolvePolicyFromCandidates · id → code → active default → null", () => {
  const A = record({ id: "pol_a", code: "AAA" });
  const B = record({ id: "pol_b", code: "BBB", isDefault: true });
  const C = record({ id: "pol_c", code: "CCC", active: false });
  const candidates = [A, B, C];

  it("without id or code the ACTIVE DEFAULT rules, not the first by code", () => {
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: null, cancellationPolicyCode: null }, candidates)?.code, "BBB");
  });

  it("an explicit id wins over the code and the default; the code wins over the default", () => {
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: "pol_c", cancellationPolicyCode: "AAA" }, candidates)?.id, "pol_c");
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: null, cancellationPolicyCode: "AAA" }, candidates)?.id, "pol_a");
  });

  it("unknown id / code fall through to the default; no default (or an inactive one) → null, never alphabetical", () => {
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: "pol_zzz", cancellationPolicyCode: "ZZZ" }, candidates)?.code, "BBB");
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: null, cancellationPolicyCode: null }, [A, C]), null);
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: null, cancellationPolicyCode: null }, [A, record({ id: "pol_d", code: "DDD", isDefault: true, active: false })]), null);
    assert.equal(resolvePolicyFromCandidates({ cancellationPolicyId: null, cancellationPolicyCode: null }, []), null);
  });
});
