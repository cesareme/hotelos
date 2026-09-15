import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KPI_STRIP_CSS_MINS, deltaArrow, deltaColors, deltaSentiment, deltaTone, formatDelta, kpiAriaLabel } from "../CocoaKpi.tsx";

describe("CocoaKpi · delta polarity (§3.6)", () => {
  it("positive-good: ▲ success / ▼ danger", () => {
    assert.equal(deltaTone(3), "success");
    assert.equal(deltaTone(-3), "danger");
    assert.equal(deltaSentiment(3), "good");
    assert.equal(deltaSentiment(-3), "bad");
  });
  it("negative-good inverts the colours (cancellations, cost)", () => {
    assert.equal(deltaTone(3, "negative-good"), "danger");
    assert.equal(deltaTone(-3, "negative-good"), "success");
    assert.equal(deltaSentiment(-3, "negative-good"), "good");
  });
  it("neutral polarity, zero, undefined and NaN are neutral", () => {
    assert.equal(deltaTone(3, "neutral"), "neutral");
    assert.equal(deltaTone(0), "neutral");
    assert.equal(deltaTone(undefined), "neutral");
    assert.equal(deltaTone(Number.NaN), "neutral");
    assert.equal(deltaSentiment(0), "neutral");
  });
  it("arrows: ▲ ▼ •", () => {
    assert.equal(deltaArrow(1), "▲");
    assert.equal(deltaArrow(-0.1), "▼");
    assert.equal(deltaArrow(0), "•");
  });
});

describe("CocoaKpi · formatDelta (es-ES via lib/format)", () => {
  it("prints integers whole and decimals with one digit and a comma", () => {
    assert.equal(formatDelta(100), "100");
    assert.equal(formatDelta(-100), "100");
    assert.equal(formatDelta(1.75), "1,8");
    assert.equal(formatDelta(-0.04), "0,0");
    assert.equal(formatDelta(1500), "1500");
    assert.equal(formatDelta(12500), "12.500");
  });
});

describe("CocoaDelta · colours (§2.1 rule c, review#6)", () => {
  it("11 px text uses the AA tone ink; only the arrow glyph keeps the hue", () => {
    assert.deepEqual(deltaColors("success"), { text: "var(--cocoa-tone-success-text)", arrow: "var(--cocoa-tone-success)" });
    assert.deepEqual(deltaColors("danger"), { text: "var(--cocoa-tone-danger-text)", arrow: "var(--cocoa-tone-danger)" });
    assert.deepEqual(deltaColors("neutral"), { text: "var(--cocoa-label-secondary)", arrow: "var(--cocoa-label-secondary)" });
  });
});

describe("CocoaKpi · accessible name", () => {
  it("reads «etiqueta, valor unidad, +delta unidad vs LY»", () => {
    assert.equal(kpiAriaLabel({ label: "Ocupación", value: "1,7", unit: "%", delta: 100, deltaUnit: "%", deltaLabel: "vs LY" }), "Ocupación, 1,7 %, +100 % vs LY");
    assert.equal(kpiAriaLabel({ label: "ADR", value: "272,00 €", delta: -2.5, deltaUnit: "%" }), "ADR, 272,00 €, −2,5 %");
    assert.equal(kpiAriaLabel({ label: "RevPAR", value: 12 }), "RevPAR, 12");
  });
  it("announces a degraded counter as «no disponible» and never a fake value", () => {
    assert.equal(kpiAriaLabel({ label: "Ocupación", value: 0, delta: 100, degraded: true }), "Ocupación, no disponible");
  });
  it("keeps a bare delta label («datos a 08:12») when there is no delta", () => {
    assert.equal(kpiAriaLabel({ label: "Llegadas", value: 4, deltaLabel: "hoy" }), "Llegadas, 4, hoy");
  });
});

describe("CocoaKpiStrip · minimums the stylesheet knows", () => {
  it("180 (canon), 200 (ops), 240", () => {
    assert.deepEqual([...KPI_STRIP_CSS_MINS], [180, 200, 240]);
  });
});
