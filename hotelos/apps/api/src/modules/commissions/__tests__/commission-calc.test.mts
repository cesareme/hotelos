// Unit tests · commission arithmetic and channel attribution (no database).
//   node --import tsx --test src/modules/commissions/__tests__/commission-calc.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCommission, isOtaChannel } from "../commission-accrual.service.js";
import { parseRatePct } from "../commission-rules.service.js";

describe("computeCommission", () => {
  it("15 % of 100.00 → 15.00; 18 % of 123.45 → 22.22 (22.221 HALF_UP); 12.5 % of 0.10 → 0.01", () => {
    assert.equal(computeCommission("100.00", "15.00").toFixed(2), "15.00");
    assert.equal(computeCommission(123.45, 18).toFixed(2), "22.22");
    assert.equal(computeCommission("0.10", "12.5").toFixed(2), "0.01");
    assert.equal(computeCommission("1000", "17.5").toFixed(2), "175.00");
  });

  it("never drifts on float-hostile inputs (0.1 + 0.2 style bases)", () => {
    assert.equal(computeCommission(0.3, 10).toFixed(2), "0.03");
    assert.equal(computeCommission("2999.99", "15").toFixed(2), "450.00");
  });
});

describe("isOtaChannel / parseRatePct", () => {
  it("direct-like codes never accrue; OTA codes do", () => {
    for (const code of ["direct", "Walk_In", "phone", "email", "web", "", null, undefined]) assert.equal(isOtaChannel(code), false, String(code));
    for (const code of ["booking", "expedia", "channex", "group"]) assert.equal(isOtaChannel(code), true, code);
  });

  it("rates are normalised to 2 decimals and bounded to (0, 100]", () => {
    assert.equal(parseRatePct("15"), "15.00");
    assert.equal(parseRatePct("17,5"), "17.50");
    assert.equal(parseRatePct(100), "100.00");
    assert.throws(() => parseRatePct(0));
    assert.throws(() => parseRatePct("101"));
    assert.throws(() => parseRatePct("-5"));
  });
});
