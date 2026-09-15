// Unit tests · derived rate plans (pure). Run from apps/api with
//   node --import tsx --test src/modules/rate-manager/__tests__/derivation.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDerivation, derivationFloorIssue, derivationSchema, parseDerivation, roundPrice, round2 } from "../derivation.js";

describe("applyDerivation", () => {
  it("percent: BAR −10 % on 100 → 90", () => {
    assert.equal(applyDerivation(100, { mode: "percent", value: -10 }), 90);
  });
  it("percent keeps cents (89.99 −10 % → 80.99)", () => {
    assert.equal(applyDerivation(89.99, { mode: "percent", value: -10 }), 80.99);
  });
  it("amount: +15 on 120.5 → 135.5", () => {
    assert.equal(applyDerivation(120.5, { mode: "amount", value: 15 }), 135.5);
  });
  it("none copies the parent (rounded to cents)", () => {
    assert.equal(applyDerivation(101.005, { mode: "none", value: 0 }), 101.01);
  });
  it("negative results are clamped to 0", () => {
    assert.equal(applyDerivation(10, { mode: "amount", value: -25 }), 0);
    assert.equal(applyDerivation(10, { mode: "percent", value: -150 }), 0);
  });
  it("roundTo 0 → integer, 1 → one decimal, 2 → cents", () => {
    assert.equal(applyDerivation(89.6, { mode: "none", value: 0, roundTo: 0 }), 90);
    assert.equal(applyDerivation(89.66, { mode: "none", value: 0, roundTo: 1 }), 89.7);
    assert.equal(applyDerivation(89.666, { mode: "none", value: 0, roundTo: 2 }), 89.67);
  });
  it("roundTo 0.99 → nearest integer minus one cent (BAR-NR: 100 −10 % → 89.99)", () => {
    assert.equal(applyDerivation(100, { mode: "percent", value: -10, roundTo: 0.99 }), 89.99);
    assert.equal(applyDerivation(89.6, { mode: "none", value: 0, roundTo: 0.99 }), 89.99);
    assert.equal(applyDerivation(89.4, { mode: "none", value: 0, roundTo: 0.99 }), 88.99);
  });
  it("roundTo 0.99 never yields a negative price", () => {
    assert.equal(roundPrice(0.2, 0.99), 0);
    assert.equal(applyDerivation(0.3, { mode: "none", value: 0, roundTo: 0.99 }), 0);
  });
  it("rejects a non-finite base", () => {
    assert.throws(() => applyDerivation(Number.NaN, { mode: "none", value: 0 }), TypeError);
  });
});

describe("parseDerivation / derivationSchema", () => {
  it("{} and garbage → none", () => {
    assert.deepEqual(parseDerivation({}), { mode: "none", value: 0 });
    assert.deepEqual(parseDerivation(null), { mode: "none", value: 0 });
    assert.deepEqual(parseDerivation("x"), { mode: "none", value: 0 });
    assert.deepEqual(parseDerivation({ mode: "weird", value: 3 }), { mode: "none", value: 0 });
  });
  it("valid payload round-trips (roundTo kept only when valid)", () => {
    assert.deepEqual(parseDerivation({ mode: "percent", value: -10, roundTo: 0.99 }), { mode: "percent", value: -10, roundTo: 0.99 });
    assert.deepEqual(parseDerivation({ mode: "amount", value: 5, roundTo: 3 }), { mode: "amount", value: 5 });
  });
  it("schema is strict on write", () => {
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: -10 }).success, true);
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: -10, roundTo: 5 }).success, false);
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: "x" }).success, false);
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: -10, extra: 1 }).success, false);
  });
  it("round2 avoids float artefacts", () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(2.675), 2.68);
  });
});

describe("derivation guards against a fake 0 € (api-fix, 2026-09-15)", () => {
  it("derivationSchema rejects percent ≤ -100 (always 0 €) and > 1000", () => {
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: -100 }).success, false);
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: -150 }).success, false);
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: 1001 }).success, false);
    assert.equal(derivationSchema.safeParse({ mode: "percent", value: -99 }).success, true);
    assert.equal(derivationSchema.safeParse({ mode: "amount", value: -500 }).success, true);
  });
  it("derivationFloorIssue explains when the rule yields 0 € on the parent's minimum price", () => {
    assert.equal(derivationFloorIssue({ mode: "amount", value: -30 }, 25), "la regla (-30 €) produce 0 € sobre la tarifa mínima actual del plan padre (25 €): revisa el valor");
    assert.equal(derivationFloorIssue({ mode: "amount", value: -30 }, 30), "la regla (-30 €) produce 0 € sobre la tarifa mínima actual del plan padre (30 €): revisa el valor");
    assert.match(derivationFloorIssue({ mode: "amount", value: -30, roundTo: 0.99 }, 30.3) ?? "", /produce 0 €/);
    assert.equal(derivationFloorIssue({ mode: "amount", value: -30 }, 31), null);
    assert.equal(derivationFloorIssue({ mode: "percent", value: -100 }, null), "un descuento del 100 % o más produce siempre 0 €");
    // No parent rates yet → nothing to compare (the engine still refuses to materialise ≤ 0 €).
    assert.equal(derivationFloorIssue({ mode: "amount", value: -999 }, null), null);
    assert.equal(derivationFloorIssue({ mode: "none", value: 0 }, 10), null);
  });
});
