// Unit tests · POS taxation core (IVA per line, group breakdown, cent squaring).
// Pure: no database. Run from apps/api with
//   node --import tsx --test src/modules/pos/__tests__/pos-tax.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseFromGross,
  computePosTicketTax,
  folioLineTypeForOutlet,
  isAlcoholProduct,
  posLineTaxCategory,
  type PosRateTable
} from "../pos-tax.js";
import { Prisma } from "@prisma/client";

const IVA: PosRateTable = {
  food_beverage: { ratePercent: 10, canonicalTaxCode: "ES_IVA_10", rateCode: "10", figure: "IVA", impuesto: "01", calificacion: "S1" },
  general_services: { ratePercent: 21, canonicalTaxCode: "ES_IVA_21", rateCode: "21", figure: "IVA", impuesto: "01", calificacion: "S1" }
};
const IGIC: PosRateTable = {
  food_beverage: { ratePercent: 7, canonicalTaxCode: "ES_IGIC_7", rateCode: "7", figure: "IGIC", impuesto: "03", calificacion: "S1" },
  general_services: { ratePercent: 7, canonicalTaxCode: "ES_IGIC_7", rateCode: "7", figure: "IGIC", impuesto: "03", calificacion: "S1" }
};

describe("posLineTaxCategory — category per line", () => {
  it("restaurant / bar / café / room service consumption is food_beverage (10 %)", () => {
    for (const outlet of ["restaurant", "bar", "cafe", "roomservice", "minibar", "Restaurant"]) {
      assert.deepEqual(posLineTaxCategory(outlet, { name: "Menú", quantity: 1, unitPrice: 18.5, total: 18.5 }), { taxCategory: "food_beverage", alcohol: false });
    }
  });
  it("spa / shop / unknown outlets are general_services (21 %)", () => {
    for (const outlet of ["spa", "shop", "parking", "", null, undefined]) {
      assert.equal(posLineTaxCategory(outlet, { name: "Masaje", quantity: 1, unitPrice: 60, total: 60 }).taxCategory, "general_services");
    }
  });
  it("an alcoholic beverage marked in the catalogue takes the general rate even in a restaurant", () => {
    assert.ok(isAlcoholProduct({ productCategory: "Bebidas alcohólicas" }));
    assert.ok(isAlcoholProduct({ productCategory: "vinos" }));
    assert.ok(isAlcoholProduct({ productCategory: "cerveza / alcohol" }));
    assert.ok(isAlcoholProduct({ productTaxCode: "ES_IVA_21" }));
    assert.ok(isAlcoholProduct({ productTaxCode: "21" }));
    assert.equal(isAlcoholProduct({ productCategory: "refrescos", productTaxCode: "ES_IVA_10" }), false);
    assert.equal(isAlcoholProduct(null), false);
    assert.deepEqual(posLineTaxCategory("restaurant", { name: "Copa de vino", quantity: 2, unitPrice: 4.5, total: 9, productCategory: "vinos" }), { taxCategory: "general_services", alcohol: true });
  });
});

describe("baseFromGross — gross → base", () => {
  it("rounds half away from zero to cents", () => {
    assert.equal(baseFromGross(new Prisma.Decimal("9.00"), 10).toFixed(2), "8.18");
    assert.equal(baseFromGross(new Prisma.Decimal("9.00"), 21).toFixed(2), "7.44");
    assert.equal(baseFromGross(new Prisma.Decimal("1.21"), 21).toFixed(2), "1.00");
    assert.equal(baseFromGross(new Prisma.Decimal("10.00"), 0).toFixed(2), "10.00");
  });
});

describe("computePosTicketTax — a bar ticket with food and alcohol", () => {
  const lines = [
    { name: "Caña", quantity: 3, unitPrice: 3, total: 9 },
    { name: "Copa de vino", quantity: 2, unitPrice: 4.5, total: 9, productCategory: "vinos" }
  ];
  const tax = computePosTicketTax(lines, "bar", IVA);

  it("taxes 9,00 € at 10 % as 8,18 + 0,82 and 9,00 € at 21 % as 7,44 + 1,56", () => {
    const fb = tax.groups.find((g) => g.taxCategory === "food_beverage");
    const gs = tax.groups.find((g) => g.taxCategory === "general_services");
    assert.ok(fb && gs);
    assert.deepEqual([fb.base, fb.quota, fb.total, fb.ratePercent, fb.rateCode], ["8.18", "0.82", "9.00", 10, "10"]);
    assert.deepEqual([gs.base, gs.quota, gs.total, gs.ratePercent, gs.rateCode], ["7.44", "1.56", "9.00", 21, "21"]);
  });

  it("squares to the cent: Σ base + Σ quota = total (15,62 + 2,38 = 18,00)", () => {
    assert.equal(tax.baseTotal, "15.62");
    assert.equal(tax.taxTotal, "2.38");
    assert.equal(tax.total, "18.00");
    assert.equal(tax.allFoodBeverage, false);
    assert.equal(tax.lines[1]?.alcohol, true);
    assert.equal(tax.lines[1]?.taxCode, "ES_IVA_21");
  });

  it("per-group rounding never drifts from the gross sum on many small lines", () => {
    const many = Array.from({ length: 37 }, (_, i) => ({ name: `Café ${i}`, quantity: 1, unitPrice: 1.35, total: 1.35 }));
    const t = computePosTicketTax(many, "cafe", IVA);
    // 37 × 1,35 = 49,95 gross; base 45,41; quota 4,54.
    assert.equal(t.total, "49.95");
    assert.equal(t.groups.length, 1);
    assert.equal(new Prisma.Decimal(t.baseTotal).plus(t.taxTotal).toFixed(2), t.total);
    assert.equal(t.baseTotal, "45.41");
    assert.equal(t.taxTotal, "4.54");
    assert.equal(t.allFoodBeverage, true);
  });

  it("IGIC properties tax both categories at 7 % and still square", () => {
    const t = computePosTicketTax(lines, "bar", IGIC);
    assert.equal(t.groups.length, 2);
    assert.equal(new Prisma.Decimal(t.baseTotal).plus(t.taxTotal).toFixed(2), "18.00");
    for (const g of t.groups) assert.equal(g.ratePercent, 7);
    // 9,00 at 7 % → 8,41 + 0,59 each.
    assert.deepEqual(t.groups.map((g) => [g.base, g.quota]), [["8.41", "0.59"], ["8.41", "0.59"]]);
  });

  it("refuses a ticket without lines or with an invalid amount", () => {
    assert.throws(() => computePosTicketTax([], "bar", IVA), /no lines/);
    assert.throws(() => computePosTicketTax([{ name: "x", quantity: 1, unitPrice: -1, total: -1 }], "bar", IVA), /invalid line total/);
  });
});

describe("folio line type", () => {
  it("follows the outlet (never always «minibar»)", () => {
    assert.equal(folioLineTypeForOutlet("restaurant"), "restaurant");
    assert.equal(folioLineTypeForOutlet("bar"), "bar");
    assert.equal(folioLineTypeForOutlet("roomservice"), "room_service");
    assert.equal(folioLineTypeForOutlet("minibar"), "minibar");
    assert.equal(folioLineTypeForOutlet("spa"), "spa");
    assert.equal(folioLineTypeForOutlet("whatever"), "misc");
  });
});
