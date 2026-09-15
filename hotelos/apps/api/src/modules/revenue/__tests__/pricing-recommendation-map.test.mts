// Unitarios de la lectura de RevenueRecommendation para «Reglas y
// recomendaciones de BAR» (pricing.service mapCurrentValue /
// mapRecommendedValue, sin BD). Las filas del RMS de la parrilla guardan
// `price` en vez de `bar` y la pantalla decía «sin tarifario» (browser-ux#11).
//   node --import tsx --test src/modules/revenue/__tests__/pricing-recommendation-map.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapCurrentValue, mapRecommendedValue } from "../pricing.service.js";

describe("mapCurrentValue — bar por procedencia", () => {
  it("fila del motor de BAR (bar + barSource rate_grid) → bar tal cual", () => {
    const v = mapCurrentValue({ bar: 95, barSource: "rate_grid", occupancyPct: 40 });
    assert.equal(v.bar, 95);
    assert.equal(v.barSource, "rate_grid");
    assert.equal(v.occupancyPct, 40);
  });
  it("fila del RMS de la parrilla (price + barSource rate_grid, sin bar) → bar = price", () => {
    const v = mapCurrentValue({ price: 85.64, enginePrice: 86, priceSource: "client", barSource: "rate_grid", occupancyPct: 12.5, compsetMedian: 90 });
    assert.equal(v.bar, 85.64);
    assert.equal(v.enginePrice, 86);
    assert.equal(v.compsetMedian, 90);
  });
  it("bar explícito gana sobre price cuando coexisten; price no numérico o null → bar null", () => {
    assert.equal(mapCurrentValue({ bar: 100, price: 90, barSource: "rate_grid" }).bar, 100);
    assert.equal(mapCurrentValue({ price: null, barSource: "rate_grid" }).bar, null);
    assert.equal(mapCurrentValue({ price: "abc", barSource: "rate_grid" }).bar, null);
  });
  it("sin procedencia rate_grid nunca se expone un precio (filas legadas, barSource none/unknown)", () => {
    assert.deepEqual(mapCurrentValue({ bar: 120 }), { bar: null, barSource: "unknown" });
    assert.equal(mapCurrentValue({ price: 120, barSource: "none" }).bar, null);
    assert.deepEqual(mapCurrentValue(null), { bar: null, barSource: "unknown" });
    assert.deepEqual(mapCurrentValue([1, 2]), { bar: null, barSource: "unknown" });
  });
});

describe("mapRecommendedValue — bar sugerido por procedencia", () => {
  it("motor de BAR: bar tal cual, independientemente de la procedencia", () => {
    assert.equal(mapRecommendedValue({ bar: 104 }, "rate_grid").bar, 104);
    assert.equal(mapRecommendedValue({ bar: 104 }, "unknown").bar, 104);
  });
  it("RMS de la parrilla: appliedPrice (lo publicado) antes que price (sugerencia del motor); reject → price", () => {
    const applied = mapRecommendedValue({ price: 121, shownPrice: 110, appliedPrice: 110, decision: "accept" }, "rate_grid");
    assert.equal(applied.bar, 110);
    assert.equal(applied.shownPrice, 110);
    const rejected = mapRecommendedValue({ price: 121, shownPrice: 110, appliedPrice: null, decision: "reject" }, "rate_grid");
    assert.equal(rejected.bar, 121);
  });
  it("sin procedencia rate_grid no se deriva nada de price/appliedPrice; JSON no objeto → bar null", () => {
    assert.equal(mapRecommendedValue({ price: 121, appliedPrice: 110 }, "unknown").bar, null);
    assert.deepEqual(mapRecommendedValue(null, "rate_grid"), { bar: null });
    assert.deepEqual(mapRecommendedValue("x", "rate_grid"), { bar: null });
  });
});
