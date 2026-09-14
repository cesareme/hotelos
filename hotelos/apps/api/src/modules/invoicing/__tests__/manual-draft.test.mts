// Unit tests for the manual-draft tax validation (Tanda 3): rates validated
// against the property's effective profile (catalogue + N1) instead of a
// hard-coded list per figure. Pure-core only: no database. Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/manual-draft.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSummaryLine,
  categoryForRate,
  rateForCategory,
  resolveManualLineTax,
  snapToValidRate,
  subjectRates,
  type DraftTaxProfile
} from "../invoicing.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

const PENINSULA: DraftTaxProfile = {
  taxRegion: "ES_PENINSULA_BALEARES",
  figure: "IVA",
  rates: [
    { category: "accommodation", ratePercent: 10, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "food_beverage", ratePercent: 10, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "general_services", ratePercent: 21, calificacion: "S1", source: "db", verifyAgainstOrdinance: false },
    { category: "transport", ratePercent: 10, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "tourist_tax", ratePercent: 10, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "not_subject", ratePercent: 0, calificacion: "N1", source: "catalog", verifyAgainstOrdinance: false }
  ]
};

const CANARIAS: DraftTaxProfile = {
  taxRegion: "ES_CANARIAS",
  figure: "IGIC",
  rates: [
    { category: "accommodation", ratePercent: 7, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "food_beverage", ratePercent: 7, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "general_services", ratePercent: 7, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "transport", ratePercent: 3, calificacion: "S1", source: "catalog", verifyAgainstOrdinance: false },
    { category: "not_subject", ratePercent: 0, calificacion: "N1", source: "catalog", verifyAgainstOrdinance: false }
  ]
};

describe("subjectRates / rateForCategory / categoryForRate", () => {
  it("lists the distinct S1 rates descending", () => {
    assert.deepEqual(subjectRates(PENINSULA), [21, 10]);
    assert.deepEqual(subjectRates(CANARIAS), [7, 3]);
  });

  it("finds the category by preference for a rate", () => {
    assert.equal(categoryForRate(PENINSULA, 10)!.category, "accommodation");
    assert.equal(categoryForRate(PENINSULA, 21)!.category, "general_services");
    assert.equal(categoryForRate(CANARIAS, 3)!.category, "transport");
    assert.equal(categoryForRate(PENINSULA, 4), null);
    assert.equal(categoryForRate(PENINSULA, 0), null, "N1 is never matched as a subject rate");
    assert.equal(rateForCategory(CANARIAS, "tourist_tax"), null);
  });
});

describe("resolveManualLineTax — rate or category, validated against the profile", () => {
  it("accepts a statutory rate and infers the category", () => {
    const tax = resolveManualLineTax({ taxRate: 21 }, "línea 1", PENINSULA);
    assert.equal(tax.ratePercent, 21);
    assert.equal(tax.calificacion, "S1");
    assert.equal(tax.category, "general_services");
    assert.equal(tax.rate.source, "db");
  });

  it("rejects rates the figure does not have (IVA 4 %, IGIC 15 %, IVA 0 % listed in the pre-Tanda-3 table)", () => {
    assert.throws(() => resolveManualLineTax({ taxRate: 4 }, "línea 1", PENINSULA), /IVA admite 21 o 10 %/);
    assert.throws(() => resolveManualLineTax({ taxRate: 15 }, "línea 2", CANARIAS), /IGIC admite 7 o 3 %/);
    assert.throws(() => resolveManualLineTax({ taxRate: 7.94 }, "línea 3", PENINSULA), BadRequestError);
  });

  it("treats 0 % as the not_subject (N1) category when the profile has one", () => {
    const tax = resolveManualLineTax({ taxRate: 0 }, "línea 1", PENINSULA);
    assert.equal(tax.calificacion, "N1");
    assert.equal(tax.category, "not_subject");
    assert.equal(tax.ratePercent, 0);
  });

  it("derives the rate from taxCategory and checks a stated rate against it", () => {
    const fb = resolveManualLineTax({ taxCategory: "food_beverage" }, "línea 1", CANARIAS);
    assert.equal(fb.ratePercent, 7);
    assert.equal(fb.calificacion, "S1");
    const n1 = resolveManualLineTax({ taxCategory: "not_subject", taxRate: 0 }, "línea 2", PENINSULA);
    assert.equal(n1.calificacion, "N1");
    assert.throws(() => resolveManualLineTax({ taxCategory: "accommodation", taxRate: 21 }, "línea 3", PENINSULA), /no corresponde a la categoría «accommodation»/);
    assert.throws(() => resolveManualLineTax({ taxCategory: "not_subject", taxRate: 10 }, "línea 4", PENINSULA), /operación no sujeta, sin tipo/);
    assert.throws(() => resolveManualLineTax({ taxCategory: "tourist_tax" }, "línea 5", CANARIAS), /no tiene tipo configurado/);
  });
});

describe("snapToValidRate", () => {
  it("snaps within half a point or when the cent arithmetic matches", () => {
    assert.equal(snapToValidRate(9.8, 110, 10, [21, 10]), 10);
    assert.equal(snapToValidRate(20.7, 121, 21, [21, 10]), 21);
    assert.equal(snapToValidRate(12.5, 100, 11.11, [21, 10]), null);
    // Tiny invoice: implied 33 % but the 21 % tax on 1.21 is 0.21 to the cent.
    assert.equal(snapToValidRate(33.3, 1.21, 0.21, [21, 10]), 21);
  });
});

describe("buildSummaryLine — 'Servicios hoteleros' with the rate implied by the totals", () => {
  it("defaults to accommodation at the implied statutory rate", () => {
    const summary = buildSummaryLine(PENINSULA, 110, 10);
    assert.equal(summary.data.taxRate, 10);
    assert.equal(summary.data.taxCategory, "accommodation");
    assert.equal(summary.data.taxCalificacion, "S1");
    assert.equal(summary.data.taxCode, "ES_IVA_10");
    assert.equal(summary.data.total, 110);
    assert.equal(summary.data.unitPrice, 110);
    assert.equal(summary.resolved.category, "accommodation");
  });

  it("falls back to the first category carrying the implied rate when the requested one does not", () => {
    const summary = buildSummaryLine(PENINSULA, 121, 21, "accommodation");
    assert.equal(summary.data.taxRate, 21);
    assert.equal(summary.data.taxCategory, "general_services");
    assert.equal(summary.data.taxCode, "ES_IVA_21");
  });

  it("honours an explicit category whose rate matches", () => {
    const summary = buildSummaryLine(PENINSULA, 110, 10, "food_beverage");
    assert.equal(summary.data.taxCategory, "food_beverage");
  });

  it("IGIC 7 % for Canarias, ES_IGIC_7 code", () => {
    const summary = buildSummaryLine(CANARIAS, 107, 7);
    assert.equal(summary.data.taxCode, "ES_IGIC_7");
    assert.equal(summary.data.taxFigure, "IGIC");
  });

  it("not_subject produces an N1 line and requires taxTotal 0", () => {
    const summary = buildSummaryLine(PENINSULA, 50, 0, "not_subject");
    assert.equal(summary.data.taxCalificacion, "N1");
    assert.equal(summary.data.taxCode, "ES_IVA_N1");
    assert.equal(summary.data.taxRate, 0);
    assert.throws(() => buildSummaryLine(PENINSULA, 50, 5, "not_subject"), /no lleva cuota/);
  });

  it("rejects an implied rate that is not statutory (0 % without not_subject, 12.5 %)", () => {
    assert.throws(() => buildSummaryLine(PENINSULA, 100, 0), /no es un tipo de IVA válido \(21 o 10 %\)/);
    assert.throws(() => buildSummaryLine(PENINSULA, 112.5, 12.5), BadRequestError);
    assert.throws(() => buildSummaryLine(PENINSULA, 10, 10), /base imponible en cero/);
  });
});
