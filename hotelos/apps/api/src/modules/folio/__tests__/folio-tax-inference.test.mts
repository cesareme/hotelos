// L3-T (2026-09-18, decisión §6.8) — the fiscal category of a NEW folio line
// is never NULL: an explicit override (validated against the catalogue) wins,
// otherwise the line-type map of @hotelos/compliance decides, and an unknown
// type falls to the general rate. The folio_lines column stays nullable (no
// backfill of the legacy rows). Pure (no prisma, no HTTP).
// Run from apps/api with
//   node --import tsx --test src/modules/folio/__tests__/folio-tax-inference.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLIO_LINE_TYPES, categoryForLineType } from "@hotelos/compliance";
import { BadRequestError } from "../../../lib/http-error.js";
import type { FolioLineRecord } from "../../../lib/demo-store.js";
import { TAX_CATEGORY_VALUES } from "../../../schemas/folios.schemas.js";
import { compatibleTaxCategories, resolveFolioLineTaxCategory, validateFolioLineTaxCategory } from "../folio.service.js";

/** Tabla de inferencia por tipo de línea (LINE_TYPE_CATEGORY, packages/compliance/src/spain/indirect-tax.ts). */
const INFERENCE_TABLE: ReadonlyArray<readonly [type: string, expected: (typeof TAX_CATEGORY_VALUES)[number]]> = [
  ["room", "accommodation"],
  ["breakfast", "food_beverage"],
  ["minibar", "food_beverage"],
  ["restaurant", "food_beverage"],
  ["spa", "general_services"],
  ["parking", "general_services"],
  ["extra", "general_services"],
  ["adjustment", "general_services"],
  ["city_tax", "tourist_tax"],
  ["no_show_fee", "not_subject"],
  ["cancellation_fee", "not_subject"],
  // unknown / unmapped types → general rate, never 0 %
  ["tax", "general_services"],
  ["invoice_adjustment", "general_services"],
  ["concepto_desconocido", "general_services"]
];

/** Every member of the FolioLineRecord["type"] union (lib/demo-store.ts). */
const RECORD_TYPES: ReadonlyArray<FolioLineRecord["type"]> = ["room", "tax", "breakfast", "parking", "minibar", "adjustment", "invoice_adjustment"];

const NO_OVERRIDE: ReadonlyArray<string | null | undefined> = [undefined, null, "", "   "];

describe("resolveFolioLineTaxCategory · inferencia por tipo cuando no hay override", () => {
  it("resuelve la tabla de inferencia (room → accommodation … cancellation_fee → not_subject, desconocido → general_services)", () => {
    for (const [type, expected] of INFERENCE_TABLE) {
      for (const override of NO_OVERRIDE) {
        assert.equal(resolveFolioLineTaxCategory(type, override), expected, `${type} sin override (${JSON.stringify(override)})`);
      }
    }
  });

  it("nunca devuelve null: todos los tipos del catálogo y de la unión FolioLineRecord acaban en una categoría del enum", () => {
    const types = new Set<string>([...FOLIO_LINE_TYPES, ...RECORD_TYPES, "Room", "city-tax", " No Show Fee "]);
    for (const type of types) {
      const resolved = resolveFolioLineTaxCategory(type, undefined);
      assert.ok(TAX_CATEGORY_VALUES.includes(resolved), `${type} → ${resolved} no está en el enum`);
      assert.equal(resolved, categoryForLineType(type), `${type}: la inferencia coincide con categoryForLineType`);
    }
  });
});

describe("resolveFolioLineTaxCategory · override explícito", () => {
  it("un override válido y COMPATIBLE con el tipo gana sobre la inferencia (se recorta el espacio en blanco)", () => {
    assert.equal(resolveFolioLineTaxCategory("misc", "food_beverage"), "food_beverage");
    assert.equal(resolveFolioLineTaxCategory("room", "accommodation"), "accommodation");
    assert.equal(resolveFolioLineTaxCategory("adjustment", "accommodation"), "accommodation");
    assert.equal(resolveFolioLineTaxCategory("minibar", "  general_services  "), "general_services");
    // Un concepto genérico admite cualquier categoría SUJETA; nunca «no sujeto» ni tasa turística (corrector L3 · FC-4).
    for (const category of ["accommodation", "food_beverage", "general_services", "transport"] as const) {
      assert.equal(resolveFolioLineTaxCategory("extra", category), category);
      assert.equal(validateFolioLineTaxCategory("extra", category), category);
    }
  });

  it("corrector L3 (FC-4 / DS-08): la categoría debe ser compatible con el tipo de cargo — «Habitación» nunca es no sujeta ni tasa turística", () => {
    const incompatible = (error: unknown) =>
      error instanceof BadRequestError && error.statusCode === 400 && /incompatible con el tipo de cargo/.test(error.message) && /Admitidas para este tipo:/.test(error.message);
    // alojamiento → solo accommodation
    assert.deepEqual([...compatibleTaxCategories("room")], ["accommodation"]);
    for (const bad of ["not_subject", "tourist_tax", "food_beverage", "general_services", "transport"]) {
      assert.throws(() => validateFolioLineTaxCategory("room", bad), incompatible, `room + ${bad}`);
    }
    // restauración → 10 % o general (bebidas alcohólicas al 21 %)
    assert.deepEqual([...compatibleTaxCategories("minibar")], ["food_beverage", "general_services"]);
    assert.throws(() => validateFolioLineTaxCategory("minibar", "tourist_tax"), incompatible);
    assert.throws(() => validateFolioLineTaxCategory("restaurant", "not_subject"), incompatible);
    // transporte de viajeros
    assert.deepEqual([...compatibleTaxCategories("transfer")], ["transport", "general_services"]);
    assert.throws(() => validateFolioLineTaxCategory("transfer", "accommodation"), incompatible);
    // tasa turística → solo tourist_tax; penalizaciones → no sujeto o alojamiento (decisión §6.4)
    assert.deepEqual([...compatibleTaxCategories("city_tax")], ["tourist_tax"]);
    assert.throws(() => validateFolioLineTaxCategory("city_tax", "accommodation"), incompatible);
    assert.deepEqual([...compatibleTaxCategories("cancellation_fee")], ["not_subject", "accommodation"]);
    assert.equal(validateFolioLineTaxCategory("no_show_fee", "accommodation"), "accommodation");
    assert.throws(() => validateFolioLineTaxCategory("no_show_fee", "food_beverage"), incompatible);
    // servicios concretos → solo general; genéricos y desconocidos → cualquier categoría sujeta
    assert.deepEqual([...compatibleTaxCategories("spa")], ["general_services"]);
    assert.throws(() => validateFolioLineTaxCategory("spa", "food_beverage"), incompatible);
    assert.deepEqual([...compatibleTaxCategories("adjustment")], ["accommodation", "food_beverage", "general_services", "transport"]);
    assert.deepEqual([...compatibleTaxCategories("spa_day")], ["accommodation", "food_beverage", "general_services", "transport"]);
    assert.equal(validateFolioLineTaxCategory("spa_day", "accommodation"), "accommodation");
    assert.throws(() => validateFolioLineTaxCategory("spa_day", "not_subject"), incompatible);
    assert.throws(() => validateFolioLineTaxCategory("adjustment", "tourist_tax"), incompatible);
    // sin override la inferencia sigue mandando y nunca falla
    assert.equal(validateFolioLineTaxCategory("room", undefined), null);
    assert.equal(resolveFolioLineTaxCategory("room", null), "accommodation");
  });

  it("un override incoherente con el catálogo es un 400 «Categoría fiscal no válida» (y validateFolioLineTaxCategory sigue devolviendo null sin override)", () => {
    for (const bogus of ["bogus", "IVA_10", "ACCOMMODATION", "food beverage"]) {
      assert.throws(
        () => resolveFolioLineTaxCategory("minibar", bogus),
        (error: unknown) =>
          error instanceof BadRequestError &&
          error.statusCode === 400 &&
          /^Categoría fiscal no válida: «.+»\. Valores admitidos: /.test(error.message) &&
          TAX_CATEGORY_VALUES.every((category) => error.message.includes(category)),
        `override ${JSON.stringify(bogus)} debe rechazarse con 400`
      );
    }
    for (const override of NO_OVERRIDE) assert.equal(validateFolioLineTaxCategory("minibar", override), null);
  });
});
