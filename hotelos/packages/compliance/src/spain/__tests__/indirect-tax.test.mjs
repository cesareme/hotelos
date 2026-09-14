// Unit tests for the Spanish indirect-tax catalogue (IVA · IGIC · IPSI).
//
// Run with Node 22.6+ (type stripping is on by default in Node 23.6+):
//   node --experimental-strip-types --test packages/compliance/src/spain/__tests__/indirect-tax.test.mjs
//
// The module is dependency-free, so no loader hook is needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_PERCENTS_BY_CATEGORY,
  TAX_REGIONS,
  TAX_CATEGORIES,
  FOLIO_LINE_TYPES,
  LINE_TYPE_CATEGORY,
  INDIRECT_TAX_CATALOG,
  buildTaxCode,
  categoryForLineType,
  defaultTouristTaxTreatment,
  figureForRegion,
  normalizeTaxRegion,
  parseTaxCode,
  rateCodeFor,
  regionForProvince,
  statutoryPercents,
  statutoryRate,
  statutoryRates
} from "../indirect-tax.ts";

describe("catalogue — statutory rates per region (docs/compliance/IMPUESTOS-INDIRECTOS-ES-2026.md)", () => {
  it("lists exactly the four canonical regions and six categories", () => {
    assert.deepEqual([...TAX_REGIONS], ["ES_PENINSULA_BALEARES", "ES_CANARIAS", "ES_CEUTA", "ES_MELILLA"]);
    assert.deepEqual([...TAX_CATEGORIES], ["accommodation", "food_beverage", "general_services", "transport", "tourist_tax", "not_subject"]);
    for (const region of TAX_REGIONS) {
      assert.deepEqual(Object.keys(INDIRECT_TAX_CATALOG[region].rates).sort(), [...TAX_CATEGORIES].sort());
    }
  });

  it("IVA (Península y Baleares): 10/10/21/10, tourist tax 10 S1, not_subject 0 N1, Impuesto 01", () => {
    assert.deepEqual(figureForRegion("ES_PENINSULA_BALEARES"), { figure: "IVA", impuesto: "01" });
    const pick = (c) => statutoryRate("ES_PENINSULA_BALEARES", c);
    assert.equal(pick("accommodation").percent, 10);
    assert.equal(pick("food_beverage").percent, 10);
    assert.equal(pick("general_services").percent, 21);
    assert.equal(pick("transport").percent, 10);
    assert.deepEqual([pick("tourist_tax").percent, pick("tourist_tax").calificacion], [10, "S1"]);
    assert.deepEqual([pick("not_subject").percent, pick("not_subject").calificacion], [0, "N1"]);
    for (const c of TAX_CATEGORIES) {
      assert.equal(pick(c).verifyAgainstOrdinance, false, `${c} must not require ordinance confirmation under IVA`);
      assert.ok(pick(c).legalBasis.length > 10, `${c} carries a legal basis`);
    }
    assert.deepEqual(statutoryPercents("ES_PENINSULA_BALEARES"), [10, 21]);
  });

  it("IGIC (Canarias): 7/7/7/3 S1, tourist tax and not_subject 0 N1, Impuesto 03", () => {
    assert.deepEqual(figureForRegion("ES_CANARIAS"), { figure: "IGIC", impuesto: "03" });
    const pick = (c) => statutoryRate("ES_CANARIAS", c);
    assert.equal(pick("accommodation").percent, 7);
    assert.equal(pick("food_beverage").percent, 7);
    assert.equal(pick("general_services").percent, 7);
    assert.equal(pick("transport").percent, 3);
    assert.deepEqual([pick("tourist_tax").percent, pick("tourist_tax").calificacion], [0, "N1"]);
    assert.match(pick("tourist_tax").legalBasis, /No aplica/);
    assert.deepEqual([pick("not_subject").percent, pick("not_subject").calificacion], [0, "N1"]);
    assert.deepEqual(statutoryPercents("ES_CANARIAS"), [3, 7]);
  });

  for (const region of ["ES_CEUTA", "ES_MELILLA"]) {
    it(`IPSI (${region}): 2/2/4/4 S1 with verifyAgainstOrdinance, tourist tax 0 N1, Impuesto 02`, () => {
      assert.deepEqual(figureForRegion(region), { figure: "IPSI", impuesto: "02" });
      const pick = (c) => statutoryRate(region, c);
      assert.equal(pick("accommodation").percent, 2);
      assert.equal(pick("food_beverage").percent, 2);
      assert.equal(pick("general_services").percent, 4);
      assert.equal(pick("transport").percent, 4);
      for (const c of ["accommodation", "food_beverage", "general_services", "transport"]) {
        assert.equal(pick(c).calificacion, "S1");
        assert.equal(pick(c).verifyAgainstOrdinance, true, `${c} IPSI rate must be verified against the ordinance`);
      }
      assert.deepEqual([pick("tourist_tax").percent, pick("tourist_tax").calificacion], [0, "N1"]);
      assert.deepEqual([pick("not_subject").percent, pick("not_subject").calificacion], [0, "N1"]);
      assert.deepEqual(statutoryPercents(region), [2, 4]);
    });
  }

  it("statutoryRates returns one row per category in catalogue order", () => {
    const rows = statutoryRates("ES_PENINSULA_BALEARES");
    assert.deepEqual(rows.map((r) => r.category), [...TAX_CATEGORIES]);
    assert.deepEqual(rows.map((r) => r.percent), [10, 10, 21, 10, 10, 0]);
    assert.deepEqual(rows.map((r) => r.calificacion), ["S1", "S1", "S1", "S1", "S1", "N1"]);
  });

  it("tourist-tax default treatment: included_10 under IVA, not_subject under IGIC/IPSI", () => {
    assert.equal(defaultTouristTaxTreatment("ES_PENINSULA_BALEARES"), "included_10");
    assert.equal(defaultTouristTaxTreatment("ES_CANARIAS"), "not_subject");
    assert.equal(defaultTouristTaxTreatment("ES_CEUTA"), "not_subject");
    assert.equal(defaultTouristTaxTreatment("ES_MELILLA"), "not_subject");
  });
});

describe("ALLOWED_PERCENTS_BY_CATEGORY — legal tiers per figure and category", () => {
  it("lists the exact percentages an override may use", () => {
    assert.deepEqual(ALLOWED_PERCENTS_BY_CATEGORY.IVA, {
      accommodation: [10],
      food_beverage: [10],
      general_services: [10, 21],
      transport: [10, 21],
      tourist_tax: [10],
      not_subject: [0]
    });
    assert.deepEqual(ALLOWED_PERCENTS_BY_CATEGORY.IGIC, {
      accommodation: [7],
      food_beverage: [7],
      general_services: [7],
      transport: [3, 7],
      tourist_tax: [0, 7],
      not_subject: [0]
    });
    assert.deepEqual(ALLOWED_PERCENTS_BY_CATEGORY.IPSI, {
      accommodation: [1, 2, 4],
      food_beverage: [1, 2, 4],
      general_services: [1, 2, 4],
      transport: [1, 2, 4],
      tourist_tax: [0, 4],
      not_subject: [0]
    });
  });

  it("covers every figure and every category, with ascending, non-empty lists", () => {
    assert.deepEqual(Object.keys(ALLOWED_PERCENTS_BY_CATEGORY).sort(), ["IGIC", "IPSI", "IVA"]);
    for (const figure of Object.keys(ALLOWED_PERCENTS_BY_CATEGORY)) {
      assert.deepEqual(Object.keys(ALLOWED_PERCENTS_BY_CATEGORY[figure]).sort(), [...TAX_CATEGORIES].sort(), figure);
      for (const category of TAX_CATEGORIES) {
        const list = ALLOWED_PERCENTS_BY_CATEGORY[figure][category];
        assert.ok(list.length > 0, `${figure}/${category} lists at least one tier`);
        assert.deepEqual(list, [...list].sort((a, b) => a - b), `${figure}/${category} ascending`);
        assert.equal(new Set(list).size, list.length, `${figure}/${category} without duplicates`);
      }
    }
  });

  it("the statutory rate of every region is legal for its own category (S1 percent listed, N1 → 0 listed)", () => {
    for (const region of TAX_REGIONS) {
      const { figure } = figureForRegion(region);
      for (const category of TAX_CATEGORIES) {
        const spec = statutoryRate(region, category);
        const expected = spec.calificacion === "N1" ? 0 : spec.percent;
        assert.ok(ALLOWED_PERCENTS_BY_CATEGORY[figure][category].includes(expected), `${region}/${category}: ${expected} % must be allowed under ${figure}`);
      }
    }
  });

  it("0 % (not subject) is only legal where the concept can be outside the tax", () => {
    for (const figure of ["IVA", "IGIC", "IPSI"]) {
      for (const category of ["accommodation", "food_beverage", "general_services", "transport"]) {
        assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY[figure][category].includes(0), `${figure}/${category} never 0 %`);
      }
      assert.ok(ALLOWED_PERCENTS_BY_CATEGORY[figure].not_subject.includes(0));
    }
    assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY.IVA.tourist_tax.includes(0), "IVA: the tourist tax is part of the accommodation base");
    // Tiers that exist but never apply to hotel concepts are not offered.
    assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY.IVA.accommodation.includes(21));
    assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY.IVA.general_services.includes(4));
    assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY.IGIC.accommodation.includes(9.5));
    assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY.IGIC.accommodation.includes(3));
    assert.ok(!ALLOWED_PERCENTS_BY_CATEGORY.IPSI.accommodation.includes(3));
  });
});

describe("line type → fiscal category", () => {
  it("maps every known folio line type as specified", () => {
    const expected = {
      accommodation: ["room", "extra_night", "late_checkout", "early_checkin", "night", "accommodation"],
      food_beverage: ["breakfast", "half_board", "full_board", "restaurant", "bar", "room_service", "minibar", "fb"],
      general_services: ["spa", "parking", "laundry", "phone", "internet", "phone_internet", "meeting_room", "misc", "extra", "charge", "adjustment"],
      transport: ["transport", "transfer"],
      tourist_tax: ["city_tax", "tourist_tax"],
      not_subject: ["no_show", "no_show_fee", "cancellation", "cancellation_fee"]
    };
    for (const [category, types] of Object.entries(expected)) {
      for (const type of types) {
        assert.equal(LINE_TYPE_CATEGORY[type], category, `${type} → ${category}`);
        assert.equal(categoryForLineType(type), category);
        assert.ok(FOLIO_LINE_TYPES.includes(type), `${type} listed in FOLIO_LINE_TYPES`);
      }
    }
    assert.equal(FOLIO_LINE_TYPES.length, Object.values(expected).flat().length);
  });

  it("unknown line types fall to general_services (never 0 %)", () => {
    assert.equal(categoryForLineType("unicorn"), "general_services");
    assert.equal(categoryForLineType(""), "general_services");
    assert.equal(categoryForLineType("X"), "general_services");
  });

  it("is tolerant with case, spaces and dashes", () => {
    assert.equal(categoryForLineType("Room"), "accommodation");
    assert.equal(categoryForLineType(" late-checkout "), "accommodation");
    assert.equal(categoryForLineType("City Tax"), "tourist_tax");
  });

  it("a valid category override wins; an invalid one is ignored", () => {
    assert.equal(categoryForLineType("room", "food_beverage"), "food_beverage");
    assert.equal(categoryForLineType("room", "not_subject"), "not_subject");
    assert.equal(categoryForLineType("room", "bogus"), "accommodation");
    assert.equal(categoryForLineType("room", null), "accommodation");
    assert.equal(categoryForLineType("room", undefined), "accommodation");
  });
});

describe("normalizeTaxRegion — legacy values, front labels, province derivation", () => {
  it("accepts canonical codes as they are (even with a contradicting province)", () => {
    for (const region of TAX_REGIONS) {
      assert.equal(normalizeTaxRegion(region), region);
      assert.equal(normalizeTaxRegion(region, "Las Palmas"), region);
      assert.equal(normalizeTaxRegion(region.toLowerCase()), region);
    }
  });

  it("island / autonomous-city labels resolve on their own", () => {
    for (const raw of ["canary", "Canary Islands", "Islas Canarias", "Canarias", "CANARIAS", " canary "]) {
      assert.equal(normalizeTaxRegion(raw), "ES_CANARIAS", raw);
      assert.equal(normalizeTaxRegion(raw, "Madrid"), "ES_CANARIAS", `${raw} (label wins over province)`);
    }
    assert.equal(normalizeTaxRegion("ceuta"), "ES_CEUTA");
    assert.equal(normalizeTaxRegion("Ceuta"), "ES_CEUTA");
    assert.equal(normalizeTaxRegion("melilla"), "ES_MELILLA");
    assert.equal(normalizeTaxRegion("Melilla"), "ES_MELILLA");
  });

  it("mainland-ish legacy values resolve by province, else to ES_PENINSULA_BALEARES", () => {
    const legacy = ["mainland", "common", "Madrid", "Andalucia", "Andalucía", "Mainland Spain", "España peninsular", "Espana peninsular"];
    for (const raw of legacy) {
      assert.equal(normalizeTaxRegion(raw), "ES_PENINSULA_BALEARES", raw);
      assert.equal(normalizeTaxRegion(raw, "A Coruña"), "ES_PENINSULA_BALEARES", `${raw} + A Coruña`);
      assert.equal(normalizeTaxRegion(raw, "Las Palmas"), "ES_CANARIAS", `${raw} + Las Palmas`);
      assert.equal(normalizeTaxRegion(raw, "Santa Cruz de Tenerife"), "ES_CANARIAS", `${raw} + Santa Cruz de Tenerife`);
      assert.equal(normalizeTaxRegion(raw, "Ceuta"), "ES_CEUTA", `${raw} + Ceuta`);
      assert.equal(normalizeTaxRegion(raw, "Melilla"), "ES_MELILLA", `${raw} + Melilla`);
    }
  });

  it("foral territories are IVA territory (the reporting route lives in fiscalTerritory)", () => {
    for (const raw of ["bizkaia", "gipuzkoa", "araba", "navarra"]) {
      assert.equal(normalizeTaxRegion(raw), "ES_PENINSULA_BALEARES", raw);
      assert.equal(normalizeTaxRegion(raw, "Bizkaia"), "ES_PENINSULA_BALEARES");
    }
  });

  it("'' and null resolve by province; without province → null", () => {
    assert.equal(normalizeTaxRegion(""), null);
    assert.equal(normalizeTaxRegion(null), null);
    assert.equal(normalizeTaxRegion(undefined), null);
    assert.equal(normalizeTaxRegion("   "), null);
    assert.equal(normalizeTaxRegion("", "A Coruña"), "ES_PENINSULA_BALEARES");
    assert.equal(normalizeTaxRegion(null, "A Coruna"), "ES_PENINSULA_BALEARES");
    assert.equal(normalizeTaxRegion("", "Las Palmas"), "ES_CANARIAS");
    assert.equal(normalizeTaxRegion(null, "Santa Cruz de Tenerife"), "ES_CANARIAS");
    assert.equal(normalizeTaxRegion("", "Ceuta"), "ES_CEUTA");
    assert.equal(normalizeTaxRegion("", "Melilla"), "ES_MELILLA");
    assert.equal(normalizeTaxRegion("", ""), null);
    assert.equal(normalizeTaxRegion("", null), null);
  });

  it("unknown labels resolve by province; without province → null", () => {
    assert.equal(normalizeTaxRegion("Otro"), null);
    assert.equal(normalizeTaxRegion("Otro", "Sevilla"), "ES_PENINSULA_BALEARES");
    assert.equal(normalizeTaxRegion("Otro", "Las Palmas"), "ES_CANARIAS");
  });

  it("regionForProvince knows the Canary provinces and the autonomous cities", () => {
    assert.equal(regionForProvince("Las Palmas"), "ES_CANARIAS");
    assert.equal(regionForProvince("las palmas"), "ES_CANARIAS");
    assert.equal(regionForProvince("Santa Cruz de Tenerife"), "ES_CANARIAS");
    assert.equal(regionForProvince("Tenerife"), "ES_CANARIAS");
    assert.equal(regionForProvince("Ceuta"), "ES_CEUTA");
    assert.equal(regionForProvince("Melilla"), "ES_MELILLA");
    assert.equal(regionForProvince("Illes Balears"), "ES_PENINSULA_BALEARES");
    assert.equal(regionForProvince("Bizkaia"), "ES_PENINSULA_BALEARES");
    assert.equal(regionForProvince(""), null);
    assert.equal(regionForProvince(null), null);
  });
});

describe("tax codes", () => {
  it("buildTaxCode: ES_IVA_10, ES_IGIC_7, ES_IPSI_2, decimals kept, N1 without rate", () => {
    assert.equal(buildTaxCode("IVA", 10, "S1"), "ES_IVA_10");
    assert.equal(buildTaxCode("IVA", 21, "S1"), "ES_IVA_21");
    assert.equal(buildTaxCode("IGIC", 7, "S1"), "ES_IGIC_7");
    assert.equal(buildTaxCode("IGIC", 9.5, "S1"), "ES_IGIC_9.5");
    assert.equal(buildTaxCode("IPSI", 2, "S1"), "ES_IPSI_2");
    assert.equal(buildTaxCode("IVA", 0, "N1"), "ES_IVA_N1");
    assert.equal(buildTaxCode("IGIC", 0, "N1"), "ES_IGIC_N1");
    assert.equal(buildTaxCode("IVA", 10.004, "S1"), "ES_IVA_10");
  });

  it("parseTaxCode inverts buildTaxCode", () => {
    for (const [figure, percent, calificacion] of [["IVA", 10, "S1"], ["IGIC", 9.5, "S1"], ["IPSI", 4, "S1"], ["IVA", 0, "N1"]]) {
      assert.deepEqual(parseTaxCode(buildTaxCode(figure, percent, calificacion)), { figure, percent, calificacion });
    }
  });

  it("parseTaxCode tolerates legacy spellings and reports UNKNOWN otherwise", () => {
    assert.deepEqual(parseTaxCode("ES_IVA_10"), { figure: "IVA", percent: 10, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("IVA_10"), { figure: "IVA", percent: 10, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("IVA10"), { figure: "IVA", percent: 10, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("IVA21"), { figure: "IVA", percent: 21, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("es_igic_7"), { figure: "IGIC", percent: 7, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("ES_UNKNOWN_0"), { figure: "UNKNOWN", percent: 0, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("ES_UNKNOWN_10"), { figure: "UNKNOWN", percent: 0, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("X"), { figure: "UNKNOWN", percent: 0, calificacion: "S1" });
    assert.deepEqual(parseTaxCode("EXENTO"), { figure: "UNKNOWN", percent: 0, calificacion: "S1" });
    assert.deepEqual(parseTaxCode(""), { figure: "UNKNOWN", percent: 0, calificacion: "S1" });
    assert.deepEqual(parseTaxCode(null), { figure: "UNKNOWN", percent: 0, calificacion: "S1" });
  });

  it("rateCodeFor labels the statutory tiers", () => {
    assert.equal(rateCodeFor("IVA", 21, "S1"), "general");
    assert.equal(rateCodeFor("IVA", 10, "S1"), "reducido");
    assert.equal(rateCodeFor("IGIC", 7, "S1"), "general");
    assert.equal(rateCodeFor("IGIC", 3, "S1"), "reducido");
    assert.equal(rateCodeFor("IGIC", 9.5, "S1"), "incrementado");
    assert.equal(rateCodeFor("IPSI", 4, "S1"), "general");
    assert.equal(rateCodeFor("IPSI", 2, "S1"), "reducido");
    assert.equal(rateCodeFor("IVA", 0, "N1"), "no_sujeto");
    assert.equal(rateCodeFor("IVA", 0, "S1"), "zero");
    assert.equal(rateCodeFor("IVA", 13, "S1"), "custom");
  });
});
