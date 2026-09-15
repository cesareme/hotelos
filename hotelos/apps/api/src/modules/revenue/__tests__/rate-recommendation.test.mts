// Unit tests for the rate-grid RMS engine (pure core, no database). Run from
// apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/rate-recommendation.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRoomTypeIdsBelong,
  dayConfidence,
  learnDowFactors,
  mergeRmsConfig,
  normalizeForecastOcc,
  recommendForDay,
  RMS_DEFAULTS,
  suggestRestrictions,
  summarizeDayRecommendation,
  type DaySignals,
  type RoomTypeBase
} from "../rate-recommendation.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

function type(over: Partial<RoomTypeBase> = {}): RoomTypeBase {
  return { roomTypeId: "rt_dbl", bar: 100, minPrice: null, maxPrice: null, ladderFactor: 1, dowFactor: null, weekMeanBar: null, ...over };
}

/** Baseline day: every signal present except compset (which would pull prices toward its median) → confidence 90, missing ["compset"]. */
function signals(over: Partial<DaySignals> = {}): DaySignals {
  return {
    date: "2026-09-23",
    daysOut: 9,
    dow: 3, // Wednesday
    totalRooms: 100,
    otbRooms: 60,
    occPct: 60,
    propertyOtbEmpty: false,
    fcOccPct: 75,
    fcSource: "pms_import:opera",
    fcDeterministic: false,
    stlyOccPct: 62,
    stlyAdr: 98,
    pickup7: 2,
    compsetMedian: null,
    compsetSource: null,
    events: [],
    eventsAvailable: true,
    budgetGapPct: null,
    byRoomType: [type()],
    pricingRules: [],
    barLevels: [],
    ...over
  };
}

describe("recommendForDay — forecast bands", () => {
  it("previsión ≥ 92 % → +10 % (raise) with the band as the top reason", () => {
    const [r] = recommendForDay(signals({ fcOccPct: 93 }));
    assert.equal(r.action, "raise");
    assert.equal(r.suggestedPrice, 110);
    assert.equal(r.deltaPct, 10);
    assert.equal(r.confidence, 90);
    assert.deepEqual(r.missing, ["compset"]);
    const fc = r.reasons.find((x) => x.code === "forecast");
    assert.ok(fc && fc.weight === 10 && fc.label.startsWith("Previsión 93 %"));
  });
  it("bands: 85-92 → +6, 70-85 → 0 (hold), 50-70 → −3, < 50 → −6", () => {
    assert.equal(recommendForDay(signals({ fcOccPct: 88 }))[0].suggestedPrice, 106);
    const flat = recommendForDay(signals({ fcOccPct: 75 }))[0];
    assert.equal(flat.suggestedPrice, 100);
    assert.equal(flat.action, "hold");
    assert.ok(flat.reasons.some((x) => x.code === "immaterial"));
    assert.equal(recommendForDay(signals({ fcOccPct: 55 }))[0].suggestedPrice, 97);
    assert.equal(recommendForDay(signals({ fcOccPct: 20 }))[0].action, "lower");
    assert.equal(recommendForDay(signals({ fcOccPct: 20 }))[0].suggestedPrice, 94);
  });
});

describe("recommendForDay — pace vs STLY and pickup", () => {
  it("ritmo 15 pp por debajo de STLY dentro de 30 días → −4 %", () => {
    const [r] = recommendForDay(signals({ occPct: 40, stlyOccPct: 58, daysOut: 12 }));
    assert.equal(r.suggestedPrice, 96);
    assert.equal(r.action, "lower");
    const pace = r.reasons.find((x) => x.code === "pace");
    assert.ok(pace && pace.weight === -4 && pace.label.includes("por debajo de STLY"));
  });
  it("ritmo ≥ +15 pp → +4 %; ignored beyond 30 days out", () => {
    assert.equal(recommendForDay(signals({ occPct: 80, stlyOccPct: 60, daysOut: 12 }))[0].suggestedPrice, 104);
    const far = recommendForDay(signals({ occPct: 80, stlyOccPct: 60, daysOut: 45 }))[0];
    assert.ok(!far.reasons.some((x) => x.code === "pace"));
  });
  it("pickup7 ≥ 5 % del inventario → +3 %; pickup ≤ 0 con previsión ≥ 70 → −2 %", () => {
    assert.equal(recommendForDay(signals({ pickup7: 6 }))[0].suggestedPrice, 103);
    assert.equal(recommendForDay(signals({ pickup7: 0, fcOccPct: 75 }))[0].suggestedPrice, 98);
    // Stalled rule needs the demand forecast: no adjustment at 60 %.
    assert.equal(recommendForDay(signals({ pickup7: 0, fcOccPct: 60 }))[0].suggestedPrice, 97);
  });
});

describe("recommendForDay — OTB empty in the whole property (Los Tilos, imported pilot)", () => {
  it("penalises −25, lists otb_empty, and skips pace/pickup (no data to read a rhythm from)", () => {
    const [r] = recommendForDay(signals({ propertyOtbEmpty: true, otbRooms: 0, occPct: 0, pickup7: 0, stlyOccPct: 60, fcOccPct: 88 }));
    assert.equal(r.confidence, 65);
    assert.deepEqual(r.missing, ["otb_empty", "compset"]);
    assert.ok(!r.reasons.some((x) => x.code === "pace" || x.code === "pickup"));
    assert.equal(r.suggestedPrice, 106); // only the forecast band acts
    assert.equal(r.action, "raise");
  });
  it("OTB vacía + sin compset + sin eventos + sin STLY → confianza 50 → still acts; add sin previsión → 20 → hold", () => {
    const mid = recommendForDay(signals({ propertyOtbEmpty: true, otbRooms: 0, occPct: 0, compsetMedian: null, compsetSource: null, eventsAvailable: false, stlyOccPct: null, fcOccPct: 93 }))[0];
    assert.equal(mid.confidence, 50);
    assert.deepEqual(mid.missing, ["otb_empty", "stly", "compset", "events"]);
    assert.equal(mid.action, "raise");
    const low = recommendForDay(signals({ propertyOtbEmpty: true, otbRooms: 0, occPct: 0, compsetMedian: null, compsetSource: null, eventsAvailable: false, stlyOccPct: null, fcOccPct: null }))[0];
    assert.equal(low.confidence, 20);
    assert.equal(low.action, "hold");
    assert.deepEqual(low.missing, ["forecast", "otb_empty", "stly", "compset", "events"]);
    assert.ok(low.reasons.some((x) => x.code === "low_confidence" && x.label.startsWith("Datos insuficientes")));
    // The suggested price is still reported (transparency) even though the action is hold.
    assert.equal(low.suggestedPrice, 100);
  });
});

describe("normalizeForecastOcc — imported PMS forecast re-based on totalRooms and clamped ≤ 100", () => {
  it("pms_import rows: expectedRoomsSold / totalRooms, not the PMS's own (92 − OOO) base", () => {
    const rows = [
      { forecastDate: new Date("2026-09-18T00:00:00Z"), roomTypeId: null, ratePlanId: null, channelId: null, segment: null, expectedOccupancy: 95.12, expectedRoomsSold: 79, modelVersion: "pms_import:opera_hf_2026-09-14" },
      { forecastDate: new Date("2026-09-19T00:00:00Z"), roomTypeId: null, ratePlanId: null, channelId: null, segment: null, expectedOccupancy: 130, expectedRoomsSold: 120, modelVersion: "pms_import:opera_hf_2026-09-14" }
    ];
    const fc = normalizeForecastOcc(rows, 92);
    assert.equal(fc.byDate.get("2026-09-18"), 85.87);
    assert.equal(fc.byDate.get("2026-09-19"), 100); // 120/92 = 130 % → clamp
    assert.equal(fc.modelVersion, "pms_import:opera_hf_2026-09-14");
    assert.equal(fc.deterministic, false);
  });
  it("deterministic per-type rows are aggregated per day and flagged deterministic", () => {
    const rows = ["rt_a", "rt_b"].map((rt) => ({ forecastDate: new Date("2026-09-18T00:00:00Z"), roomTypeId: rt, ratePlanId: null, channelId: null, segment: null, expectedOccupancy: 68, expectedRoomsSold: 30, modelVersion: "deterministic-v1" }));
    const fc = normalizeForecastOcc(rows, 100);
    assert.equal(fc.byDate.get("2026-09-18"), 60);
    assert.equal(fc.deterministic, true);
  });
  it("top-level native rows keep their expectedOccupancy", () => {
    const fc = normalizeForecastOcc([{ forecastDate: new Date("2026-09-18T00:00:00Z"), roomTypeId: null, ratePlanId: null, channelId: null, segment: null, expectedOccupancy: 71.5, expectedRoomsSold: null, modelVersion: "rms-v2" }], 100);
    assert.equal(fc.byDate.get("2026-09-18"), 71.5);
  });
});

describe("recommendForDay — compset", () => {
  it("sin compset → missing 'compset', −10 confidence, no compset reason", () => {
    const [r] = recommendForDay(signals({ compsetMedian: null, compsetSource: null }));
    assert.equal(r.confidence, 90);
    assert.deepEqual(r.missing, ["compset"]);
    assert.ok(!r.reasons.some((x) => x.code === "compset"));
  });
  it("compset real: closes 30 % of the gap toward the ladder-adjusted median", () => {
    // fc 75 → 0 %; median 120 × ladder 1 → target 120; price 100 + 0.3 × 20 = 106
    const [r] = recommendForDay(signals({ compsetMedian: 120, compsetSource: "real" }));
    assert.equal(r.suggestedPrice, 106);
    assert.equal(r.confidence, 100);
    assert.deepEqual(r.missing, []);
    const c = r.reasons.find((x) => x.code === "compset");
    assert.ok(c && c.weight === 6 && c.label.includes("real") && c.label.includes("peso 0.3"));
  });
  it("compset determinista: weight 0.1 and −10 confidence", () => {
    const [r] = recommendForDay(signals({ compsetMedian: 120, compsetSource: "deterministic" }));
    assert.equal(r.suggestedPrice, 102);
    assert.equal(r.confidence, 90);
    assert.deepEqual(r.missing, []); // present, just penalised
    assert.ok(r.reasons.some((x) => x.code === "compset" && x.label.includes("determinista")));
  });
  it("ladder: the median (shopped at lead level) is scaled to the type's rung", () => {
    const [lead, suite] = recommendForDay(
      signals({ compsetMedian: 110, compsetSource: "real", byRoomType: [type({ roomTypeId: "lead", bar: 100, ladderFactor: 1 }), type({ roomTypeId: "suite", bar: 200, ladderFactor: 2 })] })
    );
    assert.equal(lead.suggestedPrice, 103);
    assert.equal(suite.suggestedPrice, 206); // target 220, gap 20 × 0.3
  });
});

describe("recommendForDay — no BAR, rules, ladder, clamps, events", () => {
  it("sin BAR del tipo → action no_data, never a price", () => {
    const [r] = recommendForDay(signals({ byRoomType: [type({ bar: null })] }));
    assert.equal(r.action, "no_data");
    assert.equal(r.suggestedPrice, null);
    assert.equal(r.currentPrice, null);
    assert.equal(r.confidence, 0);
    assert.ok(r.missing.includes("bar"));
  });
  it("PricingRule by occupancy band applies after the signals and honours its own min/max", () => {
    const [r] = recommendForDay(signals({ fcOccPct: 93, pricingRules: [{ name: "Alta ocupación", minOccupancy: 50, maxOccupancy: 100, adjustType: "percent", adjustValue: 5, minPrice: null, maxPrice: 112 }] }));
    // 100 × 1.10 = 110 → rule +5 % = 115.5 → rule max 112
    assert.equal(r.suggestedPrice, 112);
    assert.ok(r.reasons.some((x) => x.code === "rule" && x.value === "Alta ocupación"));
  });
  it("snapping BarLevel: the final price lands on the nearest rung", () => {
    const [r] = recommendForDay(signals({ fcOccPct: 93, barLevels: [{ name: "L1", price: 95 }, { name: "L2", price: 108 }, { name: "L3", price: 125 }] }));
    assert.equal(r.suggestedPrice, 108);
    assert.ok(r.reasons.some((x) => x.code === "bar_level" && x.value === "L2"));
  });
  it("clamp to the cell's min/max and the global floor", () => {
    const capped = recommendForDay(signals({ fcOccPct: 93, byRoomType: [type({ maxPrice: 105 })] }))[0];
    assert.equal(capped.suggestedPrice, 105);
    assert.ok(capped.reasons.some((x) => x.code === "clamp_max"));
    const floored = recommendForDay(signals({ fcOccPct: 20, byRoomType: [type({ minPrice: 99 })] }))[0];
    assert.equal(floored.suggestedPrice, 99);
    assert.equal(floored.action, "lower");
    const global = recommendForDay(signals({ fcOccPct: 20, byRoomType: [type({ bar: 41 })] }))[0];
    assert.equal(global.suggestedPrice, RMS_DEFAULTS.floorPrice);
    assert.ok(global.reasons.some((x) => x.code === "floor"));
  });
  it("events: high +8 %, medium +4 %, the strongest wins; property without a calendar → missing events −5", () => {
    const high = recommendForDay(signals({ events: [{ name: "Feria", impact: "medium" }, { name: "Concierto", impact: "high" }] }))[0];
    assert.equal(high.suggestedPrice, 108);
    assert.ok(high.reasons.some((x) => x.code === "event" && x.value === "Concierto"));
    assert.equal(recommendForDay(signals({ events: [{ name: "Feria", impact: "medium" }] }))[0].suggestedPrice, 104);
    const none = recommendForDay(signals({ eventsAvailable: false }))[0];
    assert.equal(none.confidence, 85);
    assert.deepEqual(none.missing, ["compset", "events"]);
  });
  it("|Δ| < 1 % → hold; daysOut > 90 → −10 confidence", () => {
    const tiny = recommendForDay(signals({ compsetMedian: 102, compsetSource: "real" }))[0]; // +0.6 %
    assert.equal(tiny.action, "hold");
    assert.equal(tiny.deltaPct, 0.6);
    assert.equal(recommendForDay(signals({ daysOut: 120 }))[0].confidence, 80);
  });
});

describe("DOW — learned weekly shape", () => {
  it("learnDowFactors: mean DOW / mean week per type, null under 14 dates or with a weekday missing", () => {
    const rows: Array<{ roomTypeId: string; date: string; price: number }> = [];
    // 4 weeks starting Monday 2026-08-31: Fri/Sat at 120, the rest at 100.
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 7, 31 + i));
      const dow = d.getUTCDay();
      rows.push({ roomTypeId: "rt", date: d.toISOString().slice(0, 10), price: dow === 5 || dow === 6 ? 120 : 100 });
    }
    const f = learnDowFactors(rows);
    const rt = f.get("rt");
    assert.ok(rt);
    const mean = (5 * 100 + 2 * 120) / 7; // 105.71
    assert.equal(rt[5], Math.round((120 / mean) * 100) / 100);
    assert.equal(rt[1], Math.round((100 / mean) * 100) / 100);
    assert.equal(learnDowFactors(rows.slice(0, 10)).size, 0);
  });
  it("a Friday priced flat against a ×1.14 learned premium is nudged up (damped ×0.5, capped ±5 %)", () => {
    const [r] = recommendForDay(signals({ dow: 5, byRoomType: [type({ bar: 100, dowFactor: 1.14, weekMeanBar: 100 })] }));
    // raw = (1.14 / 1 − 1) × 100 × 0.5 = 7 → capped 5
    assert.equal(r.suggestedPrice, 105);
    const d = r.reasons.find((x) => x.code === "dow");
    assert.ok(d && d.weight === 5 && d.label.includes("vie"));
    // Already carrying the premium (bar 114 on a 100 week) → no nudge.
    const ok = recommendForDay(signals({ dow: 5, byRoomType: [type({ bar: 114, dowFactor: 1.14, weekMeanBar: 100 })] }))[0];
    assert.ok(!ok.reasons.some((x) => x.code === "dow"));
  });
});

describe("restrictions, confidence and config", () => {
  it("previsión ≥ 92 && daysOut ≤ 14 → minLos 2 only on Fri/Sat; occ ≥ 95 → cta", () => {
    assert.deepEqual(suggestRestrictions(signals({ fcOccPct: 95, daysOut: 10, dow: 5 }), RMS_DEFAULTS), { minLos: 2 });
    assert.equal(suggestRestrictions(signals({ fcOccPct: 95, daysOut: 10, dow: 3 }), RMS_DEFAULTS), null);
    assert.equal(suggestRestrictions(signals({ fcOccPct: 95, daysOut: 20, dow: 6 }), RMS_DEFAULTS), null);
    assert.deepEqual(suggestRestrictions(signals({ occPct: 96, otbRooms: 96, fcOccPct: 95, daysOut: 3, dow: 6 }), RMS_DEFAULTS), { minLos: 2, cta: true });
  });
  it("dayConfidence lists every penalty with its Spanish label", () => {
    const c = dayConfidence(signals({ fcDeterministic: true, compsetMedian: 100, compsetSource: "deterministic", daysOut: 100 }), RMS_DEFAULTS);
    assert.equal(c.confidence, 65);
    assert.deepEqual(c.penalties.map((p) => p.code), ["forecast_deterministic", "compset_deterministic", "far_out"]);
    assert.deepEqual(c.missing, []);
  });
  it("mergeRmsConfig: per-section override, invalid keys ignored, bands re-sorted", () => {
    const cfg = mergeRmsConfig({ confidence: { holdBelow: 55, penalties: { otbEmpty: 40, bogus: 1 } }, compset: { weight: "x" }, forecastBands: [{ minFcPct: 50, adjPct: -1 }, { minFcPct: 90, adjPct: 12 }], floorPrice: 55 });
    assert.equal(cfg.confidence.holdBelow, 55);
    assert.equal(cfg.confidence.penalties.otbEmpty, 40);
    assert.equal(cfg.confidence.penalties.noStly, 10);
    assert.equal(cfg.compset.weight, 0.3);
    assert.deepEqual(cfg.forecastBands.map((b) => b.minFcPct), [90, 50]);
    assert.equal(cfg.floorPrice, 55);
    assert.equal(mergeRmsConfig(null), RMS_DEFAULTS);
    // With the override (otbEmpty −40, hold below 55) a Los Tilos-style day (OTB empty, no compset) drops to 50 → hold.
    const [r] = recommendForDay(signals({ propertyOtbEmpty: true, otbRooms: 0, occPct: 0, fcOccPct: 93 }), cfg);
    assert.equal(r.confidence, 50);
    assert.equal(r.action, "hold");
    assert.equal(recommendForDay(signals({ propertyOtbEmpty: true, otbRooms: 0, occPct: 0, fcOccPct: 93 }))[0].action, "raise");
  });
});

describe("summarizeDayRecommendation — board line for the lead type", () => {
  const day = (over: Partial<DaySignals>) => {
    const s = signals(over);
    return { date: s.date, daysOut: s.daysOut, signals: { date: s.date, otbRooms: s.otbRooms, occPct: s.occPct, fcOccPct: s.fcOccPct, fcSource: s.fcSource, stlyOccPct: s.stlyOccPct, stlyAdr: s.stlyAdr, pickup7: s.pickup7, compsetMedian: s.compsetMedian, events: s.events }, byRoomType: recommendForDay(s) };
  };
  it("raise → text with suggested/current price and the strongest reason", () => {
    const out = summarizeDayRecommendation(day({ fcOccPct: 93 }), "rt_dbl");
    assert.equal(out.recommendation, "BAR recomendada 110,00 € (actual 100,00 €, +10 %) · Previsión 93 % de ocupación");
    assert.equal(out.recommendationMissing, null);
    assert.equal(out.compsetMedian, null);
    assert.equal(out.compsetMissing, "sin compset");
  });
  it("hold by low confidence → recommendationMissing explains; no BAR → 'sin BAR publicado'; no day → 'sin datos'", () => {
    const low = summarizeDayRecommendation(day({ propertyOtbEmpty: true, fcOccPct: null, compsetMedian: null, compsetSource: null, eventsAvailable: false, stlyOccPct: null }));
    assert.equal(low.recommendation, null);
    assert.equal(low.recommendationMissing, "datos insuficientes (sin previsión, OTB vacía, sin STLY, sin compset, sin eventos)");
    assert.equal(low.compsetMissing, "sin compset");
    assert.equal(summarizeDayRecommendation(day({ byRoomType: [type({ bar: null })] })).recommendationMissing, "sin BAR publicado");
    assert.equal(summarizeDayRecommendation(undefined).recommendationMissing, "sin datos");
    const hold = summarizeDayRecommendation(day({ fcOccPct: 75 }));
    assert.equal(hold.recommendation, "Mantener BAR 100,00 € (Δ 0 %)");
  });
});

describe("assertRoomTypeIdsBelong — roomTypeIds outside the property's catalogue (api-live-contract#6)", () => {
  const known = new Set(["rt_dbl", "rt_twin", "rt_suite"]);
  const details = (fn: () => void): { code: string; roomTypeIds: string[] } => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof BadRequestError, "expected a BadRequestError");
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, "roomTypeIds contienen ids que no pertenecen a la propiedad.");
      return err.details as { code: string; roomTypeIds: string[] };
    }
    assert.fail("expected assertRoomTypeIdsBelong to throw");
  };

  it("passes when nothing is requested or every id is an active type of the property", () => {
    assert.doesNotThrow(() => assertRoomTypeIdsBelong(undefined, known));
    assert.doesNotThrow(() => assertRoomTypeIdsBelong(null, known));
    assert.doesNotThrow(() => assertRoomTypeIdsBelong([], known));
    assert.doesNotThrow(() => assertRoomTypeIdsBelong(["rt_dbl"], known));
    assert.doesNotThrow(() => assertRoomTypeIdsBelong(["rt_suite", "rt_dbl", "rt_dbl"], known));
  });

  it("a type of another property → 400 UNKNOWN_IDS listing ONLY the foreign ids (same contract as GET /rate-grid)", () => {
    const d = details(() => assertRoomTypeIdsBelong(["rt_dbl", "rt_a7dc1781"], known));
    assert.deepEqual(d, { code: "UNKNOWN_IDS", roomTypeIds: ["rt_a7dc1781"] });
  });

  it("de-duplicates the offending ids and caps details at 20 (like the rate-grid engine)", () => {
    const dup = details(() => assertRoomTypeIdsBelong(["rt_x", "rt_x", "rt_y"], known));
    assert.deepEqual(dup.roomTypeIds, ["rt_x", "rt_y"]);
    const many = Array.from({ length: 25 }, (_, i) => `rt_foreign_${i}`);
    const capped = details(() => assertRoomTypeIdsBelong(many, known));
    assert.equal(capped.code, "UNKNOWN_IDS");
    assert.equal(capped.roomTypeIds.length, 20);
    assert.equal(capped.roomTypeIds[0], "rt_foreign_0");
  });

  it("an inactive type is unknown too: the catalogue passed in is the ACTIVE set, as in loadPropertyCatalog", () => {
    // The caller builds `known` from `roomType where { propertyId, active: true }`; an inactive id is simply not there.
    const d = details(() => assertRoomTypeIdsBelong(["rt_inactive"], known));
    assert.deepEqual(d.roomTypeIds, ["rt_inactive"]);
  });
});
