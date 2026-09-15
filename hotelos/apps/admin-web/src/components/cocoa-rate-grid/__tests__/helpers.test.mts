import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateSyncStatus,
  applyRestrictionsPatch,
  cellKey,
  computeDerivedPrice,
  derivationLabel,
  derivationLongLabel,
  describeSync,
  eachDay,
  effectivePriceForChannel,
  formatDateHeader,
  formatDateRange,
  formatMoney,
  formatPercent,
  isWeekend,
  isoWeekday,
  parseCellKey,
  resolveViewCell,
  restrictionChips,
  restrictionsEqual
} from "../helpers.ts";

const NBSP = "\u00a0";

describe("helpers · cellKey", () => {
  it("round-trips base and channel keys", () => {
    assert.equal(cellKey("bar", "dbl", "2026-03-12"), "bar|dbl|2026-03-12");
    assert.equal(cellKey("bar", "dbl", "2026-03-12", "ch1"), "bar|dbl|2026-03-12|ch1");
    assert.deepEqual(parseCellKey("bar|dbl|2026-03-12"), { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-12" });
    assert.deepEqual(parseCellKey("bar|dbl|2026-03-12|ch1"), { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-12", channelId: "ch1" });
  });
  it("throws on malformed keys", () => {
    assert.throws(() => parseCellKey("bar|dbl"));
    assert.throws(() => parseCellKey("|dbl|2026-03-12"));
  });
});

describe("helpers · es-ES money", () => {
  it("formats integers without decimals and others with two, NBSP before €", () => {
    assert.equal(formatMoney(132), `132${NBSP}€`);
    assert.equal(formatMoney(132.5), `132,50${NBSP}€`);
    assert.equal(formatMoney(1250), `1250${NBSP}€`);
    assert.equal(formatMoney(12500), `12.500${NBSP}€`);
    assert.equal(formatMoney(0), `0${NBSP}€`);
  });
  it("shows 'sin tarifa' for null, never a dash or 0", () => {
    assert.equal(formatMoney(null), "sin tarifa");
    assert.equal(formatMoney(undefined), "sin tarifa");
    assert.equal(formatMoney(Number.NaN), "sin tarifa");
  });
  it("formats percentages with sign", () => {
    assert.equal(formatPercent(10), `+10${NBSP}%`);
    assert.equal(formatPercent(-12.5, 1), `−12,5${NBSP}%`);
    assert.equal(formatPercent(0), `0${NBSP}%`);
  });
});

describe("helpers · dates", () => {
  it("computes ISO weekday, weekends and ranges", () => {
    assert.equal(isoWeekday("2026-03-09"), 1); // Monday
    assert.equal(isoWeekday("2026-03-15"), 7); // Sunday
    assert.equal(isWeekend("2026-03-14"), true);
    assert.equal(isWeekend("2026-03-11"), false);
    assert.deepEqual(eachDay("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    assert.deepEqual(eachDay("2026-03-02", "2026-03-01"), []);
  });
  it("formats headers and ranges in Spanish", () => {
    assert.deepEqual(formatDateHeader("2026-03-01"), { weekday: "dom", day: "1", month: "mar", isFirstOfMonth: true });
    assert.equal(formatDateRange("2026-03-12", "2026-03-18"), "12–18 mar");
    assert.equal(formatDateRange("2026-02-28", "2026-03-03"), "28 feb – 3 mar");
    assert.equal(formatDateRange("2026-03-12", "2026-03-12"), "12 mar");
  });
});

describe("helpers · restrictions", () => {
  it("builds chips in priority order", () => {
    const chips = restrictionChips({ minLos: 2, cta: true, closed: true, stopSell: false, maxLos: 0 });
    assert.deepEqual(chips.map((c) => c.text), ["CERR", "CTA", "MÍN2"]);
    assert.deepEqual(restrictionChips({ minLos: 1 }), []);
  });
  it("applies tri-state patches (undefined keep, null clear, value set)", () => {
    const next = applyRestrictionsPatch({ minLos: 2, cta: true }, { cta: null, ctd: true });
    assert.deepEqual(next, { minLos: 2, ctd: true });
    assert.equal(restrictionsEqual({ cta: false }, {}), true);
    assert.equal(restrictionsEqual({ minLos: 2 }, {}), false);
  });
});

describe("helpers · derivation & channel price", () => {
  it("computes derived prices with rounding modes", () => {
    assert.equal(computeDerivedPrice(120, { mode: "percent", value: -10 }), 108);
    assert.equal(computeDerivedPrice(120, { mode: "amount", value: -15 }), 105);
    assert.equal(computeDerivedPrice(120, { mode: "percent", value: -12.5, roundTo: 0 }), 105);
    assert.equal(computeDerivedPrice(120, { mode: "percent", value: -12.5, roundTo: 0.99 }), 104.99);
    assert.equal(computeDerivedPrice(null, { mode: "percent", value: -10 }), null);
    assert.equal(computeDerivedPrice(120, { mode: "none", value: 0 }), 120);
  });
  it("labels derivations in Spanish", () => {
    assert.equal(derivationLabel("BAR", { mode: "percent", value: -10 }), `BAR −10${NBSP}%`);
    assert.equal(derivationLongLabel("BAR", { mode: "percent", value: -10 }), `Derivado de BAR (−10${NBSP}%)`);
    assert.equal(derivationLongLabel("BAR", { mode: "amount", value: -15 }), `Derivado de BAR (−15${NBSP}€)`);
  });
  it("applies channel markup", () => {
    assert.equal(effectivePriceForChannel(100, 15), 115);
    assert.equal(effectivePriceForChannel(null, 15), null);
  });
});

describe("helpers · sync", () => {
  it("aggregates the worst status and describes it", () => {
    assert.equal(aggregateSyncStatus({ a: { status: "confirmed" }, b: { status: "rejected" } }), "rejected");
    assert.equal(aggregateSyncStatus({ a: { status: "confirmed" }, b: { status: "queued" } }), "queued");
    assert.equal(aggregateSyncStatus({}), "never");
    assert.match(describeSync("Booking.com", { status: "confirmed", at: "2026-03-12T10:42:00" }), /^Confirmado por Booking\.com a las \d\d:\d\d$/);
    assert.equal(describeSync("Expedia", { status: "rejected", error: "RATE_TOO_LOW" }), "Rechazado por Expedia: RATE_TOO_LOW");
    assert.equal(describeSync("Expedia", { status: "timeout" }), "Expedia: sin respuesta (tiempo agotado)");
  });
});

describe("helpers · resolveViewCell", () => {
  const cell = {
    ratePlanId: "nr",
    roomTypeId: "dbl",
    date: "2026-03-12",
    basePrice: 108,
    effectivePrice: 108,
    currency: "EUR",
    restrictions: { minLos: 2 },
    source: "derived" as const,
    derivedFrom: { ratePlanId: "bar", ratePlanCode: "BAR", derivation: { mode: "percent" as const, value: -10 } }
  };
  it("marks derived cells as locked and applies draft patches", () => {
    const v = resolveViewCell("nr|dbl|2026-03-12", cell, null);
    assert.equal(v.derivedLocked, true);
    assert.equal(v.modified, false);
    const edited = resolveViewCell("nr|dbl|2026-03-12", cell, {
      key: "nr|dbl|2026-03-12",
      patch: { ratePlanId: "nr", roomTypeId: "dbl", date: "2026-03-12", price: 115, convertToManual: true },
      before: { basePrice: 108, effectivePrice: 108, restrictions: { minLos: 2 }, source: "derived" },
      origin: "cell",
      at: "2026-03-12T00:00:00Z"
    });
    assert.equal(edited.basePrice, 115);
    assert.equal(edited.modified, true);
    assert.equal(edited.derivedLocked, false);
    assert.equal(edited.manualOverride, true);
  });
});
