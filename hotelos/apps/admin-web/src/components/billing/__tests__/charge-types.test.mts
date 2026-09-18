import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TAX_CATEGORY, FOLIO_LINE_TYPES, LINE_TYPE_CATEGORY, TAX_CATEGORIES } from "../../../../../../packages/compliance/src/spain/indirect-tax.ts";
import {
  ANY_CHARGE_TYPE,
  CHARGE_TYPE_LABELS,
  DEFAULT_TAX_CATEGORY_BY_TYPE,
  FALLBACK_TAX_CATEGORY,
  MANUAL_CHARGE_TYPES,
  ROUTING_SOURCE_TYPES,
  chargeTypeLabel,
  defaultTaxCategoryForType,
  SUBJECT_TAX_CATEGORIES,
  compatibleTaxCategoriesForType,
  lifecycleOutcomeSummary,
  manualChargeTypeOptions,
  normalizeChargeType,
  taxCategoryOptionsForType,
  penaltyPreviewSummary,
  routingSourceOptions
} from "../charge-types.ts";

// Cocoa 22 · lote 6-A (qa#5): the folio «Tipo» column and the routing rules
// never paint a raw code. Pure module: no React, no network.
// Tanda L3 · lote F1: manual charge types, client mirror of the fiscal map and
// the Spanish summaries of the cancellation preview / outcome.

describe("charge-types · catálogo", () => {
  it("cubre todos los tipos de línea del catálogo fiscal (FOLIO_LINE_TYPES)", () => {
    const missing = FOLIO_LINE_TYPES.filter((type) => !(type in CHARGE_TYPE_LABELS));
    assert.deepEqual(missing, [], `sin etiqueta: ${missing.join(", ")}`);
  });

  it("cubre los orígenes que ofrece el selector de enrutamiento", () => {
    const missing = ROUTING_SOURCE_TYPES.filter((type) => !(type in CHARGE_TYPE_LABELS));
    assert.deepEqual(missing, []);
  });

  it("etiqueta los códigos que el folio de la demo devolvía crudos (qa#5)", () => {
    assert.equal(chargeTypeLabel("restaurant"), "Restaurante");
    assert.equal(chargeTypeLabel("no_show_fee"), "Penalización por no presentarse");
    assert.equal(chargeTypeLabel("room"), "Alojamiento");
    assert.equal(chargeTypeLabel("city_tax"), "Tasa turística");
    assert.equal(chargeTypeLabel("parking"), "Aparcamiento");
    assert.equal(chargeTypeLabel("spa"), "Spa");
    assert.equal(chargeTypeLabel("minibar"), "Minibar");
  });

  it("etiqueta las penalizaciones que asienta el motor de cancelación (L3-B)", () => {
    assert.equal(chargeTypeLabel("cancellation_fee"), "Penalización por cancelación");
    assert.equal(chargeTypeLabel("no_show_fee"), "Penalización por no presentarse");
    assert.equal(chargeTypeLabel("cancellation"), "Penalización por cancelación");
    assert.equal(chargeTypeLabel("no_show"), "Penalización por no presentarse");
    // both are «not subject» in the fiscal catalogue and here
    assert.equal(LINE_TYPE_CATEGORY.cancellation_fee, "not_subject");
    assert.equal(defaultTaxCategoryForType("cancellation_fee"), "not_subject");
    assert.equal(defaultTaxCategoryForType("no_show_fee"), "not_subject");
  });

  it("las etiquetas son español sin códigos ni guiones bajos", () => {
    for (const [code, label] of Object.entries(CHARGE_TYPE_LABELS)) {
      assert.notEqual(label, code, `${code} se pinta crudo`);
      assert.doesNotMatch(label, /_/, `${code}: ${label}`);
      assert.match(label, /^[A-ZÁÉÍÓÚÑ]/, `${code}: ${label} no empieza en mayúscula`);
    }
  });
});

describe("charge-types · normalización y fallback", () => {
  it("normaliza mayúsculas, espacios y guiones al código del catálogo", () => {
    assert.equal(normalizeChargeType(" No-Show Fee "), "no_show_fee");
    assert.equal(chargeTypeLabel(" Restaurant "), "Restaurante");
    assert.equal(chargeTypeLabel("City-Tax"), "Tasa turística");
  });

  it("humaniza un código desconocido en vez de pintarlo crudo", () => {
    assert.equal(chargeTypeLabel("cargo_extra"), "Cargo extra");
    assert.equal(chargeTypeLabel("late_checkout_fee"), "Late checkout fee");
  });

  it("comodín y vacío", () => {
    assert.equal(chargeTypeLabel(ANY_CHARGE_TYPE), "Cualquier cargo");
    assert.equal(chargeTypeLabel(""), "Sin tipo");
    assert.equal(chargeTypeLabel("   "), "Sin tipo");
    assert.equal(chargeTypeLabel(null), "Sin tipo");
    assert.equal(chargeTypeLabel(undefined), "Sin tipo");
  });
});

describe("charge-types · opciones del selector de enrutamiento", () => {
  it("comodín primero y después los orígenes en orden, todos etiquetados", () => {
    const options = routingSourceOptions();
    assert.equal(options[0]?.value, ANY_CHARGE_TYPE);
    assert.equal(options[0]?.label, "Cualquier cargo");
    assert.deepEqual(options.slice(1).map((option) => option.value), [...ROUTING_SOURCE_TYPES]);
    for (const option of options) assert.notEqual(option.label, option.value);
  });
});

describe("charge-types · «Añadir cargo» (Tanda L3 · F1)", () => {
  it("los tipos manuales existen en el catálogo fiscal, sin duplicados ni penalizaciones", () => {
    const outside = MANUAL_CHARGE_TYPES.filter((type) => !FOLIO_LINE_TYPES.includes(type));
    assert.deepEqual(outside, [], `fuera del catálogo: ${outside.join(", ")}`);
    assert.equal(new Set(MANUAL_CHARGE_TYPES).size, MANUAL_CHARGE_TYPES.length);
    for (const type of MANUAL_CHARGE_TYPES) assert.notEqual(defaultTaxCategoryForType(type), "not_subject", `${type} no se añade a mano`);
    // the five types the reservation form offered before the lot are still there
    for (const legacy of ["minibar", "breakfast", "parking", "room", "adjustment"]) assert.ok(MANUAL_CHARGE_TYPES.includes(legacy), legacy);
  });

  it("las opciones del selector llevan la misma etiqueta que el catálogo, en el mismo orden", () => {
    const options = manualChargeTypeOptions();
    assert.deepEqual(options.map((option) => option.value), [...MANUAL_CHARGE_TYPES]);
    for (const option of options) {
      assert.equal(option.label, CHARGE_TYPE_LABELS[option.value]);
      assert.notEqual(option.label, option.value);
    }
  });

  it("el espejo de categorías coincide entrada por entrada con LINE_TYPE_CATEGORY del catálogo", () => {
    assert.deepEqual({ ...DEFAULT_TAX_CATEGORY_BY_TYPE }, { ...LINE_TYPE_CATEGORY });
    assert.equal(FALLBACK_TAX_CATEGORY, DEFAULT_TAX_CATEGORY);
    for (const category of Object.values(DEFAULT_TAX_CATEGORY_BY_TYPE)) assert.ok(TAX_CATEGORIES.includes(category), category);
  });

  it("corrector L3 (FC-4 / DS-08): las categorías compatibles por tipo espejan la regla del API — alojamiento nunca es no sujeto ni tasa turística", () => {
    // Cada tipo del catálogo admite al menos su categoría inferida.
    for (const type of FOLIO_LINE_TYPES) {
      const compatible = compatibleTaxCategoriesForType(type);
      assert.ok(compatible.includes(LINE_TYPE_CATEGORY[type]!), `${type}: ${LINE_TYPE_CATEGORY[type]} ∈ ${compatible.join(", ")}`);
      // «No sujeto» solo para las indemnizaciones; «Tasa turística» solo para las tasas.
      assert.equal(compatible.includes("not_subject"), LINE_TYPE_CATEGORY[type] === "not_subject", `${type}: not_subject`);
      assert.equal(compatible.includes("tourist_tax"), LINE_TYPE_CATEGORY[type] === "tourist_tax", `${type}: tourist_tax`);
    }
    assert.deepEqual([...compatibleTaxCategoriesForType("room")], ["accommodation"]);
    assert.deepEqual([...compatibleTaxCategoriesForType("minibar")], ["food_beverage", "general_services"]);
    assert.deepEqual([...compatibleTaxCategoriesForType("transfer")], ["transport", "general_services"]);
    assert.deepEqual([...compatibleTaxCategoriesForType("city_tax")], ["tourist_tax"]);
    assert.deepEqual([...compatibleTaxCategoriesForType("cancellation_fee")], ["not_subject", "accommodation"]);
    assert.deepEqual([...compatibleTaxCategoriesForType("spa")], ["general_services"]);
    assert.deepEqual([...compatibleTaxCategoriesForType("adjustment")], [...SUBJECT_TAX_CATEGORIES]);
    assert.deepEqual([...compatibleTaxCategoriesForType("spa_day")], [...SUBJECT_TAX_CATEGORIES], "tipo desconocido: cualquier categoría sujeta");
    assert.deepEqual([...compatibleTaxCategoriesForType(" No-Show Fee ")], ["not_subject", "accommodation"]);
    // Todo tipo manual del formulario puede llevar la categoría que preselecciona.
    for (const type of MANUAL_CHARGE_TYPES) assert.ok(compatibleTaxCategoriesForType(type).includes(defaultTaxCategoryForType(type)), type);
    const options = TAX_CATEGORIES.map((value) => ({ value, label: value.toUpperCase() }));
    assert.deepEqual(
      taxCategoryOptionsForType("room", options).map((o) => o.value),
      ["accommodation"]
    );
    assert.deepEqual(taxCategoryOptionsForType("bar", options).map((o) => o.value), ["food_beverage", "general_services"]);
    assert.ok(!taxCategoryOptionsForType("extra", options).some((o) => o.value === "not_subject" || o.value === "tourist_tax"));
  });

  it("preselecciona la categoría que inferiría el API y cae a servicios generales", () => {
    assert.equal(defaultTaxCategoryForType("minibar"), "food_beverage");
    assert.equal(defaultTaxCategoryForType("room"), "accommodation");
    assert.equal(defaultTaxCategoryForType("parking"), "general_services");
    assert.equal(defaultTaxCategoryForType("transfer"), "transport");
    assert.equal(defaultTaxCategoryForType(" No-Show Fee "), "not_subject");
    assert.equal(defaultTaxCategoryForType("cargo_inventado"), "general_services");
    assert.equal(defaultTaxCategoryForType(""), "general_services");
    assert.equal(defaultTaxCategoryForType(null), "general_services");
  });
});

describe("charge-types · penalización prevista y resultado (Tanda L3 · F1)", () => {
  const eur = (amount: number) => `${amount.toFixed(2).replace(".", ",")} €`;

  it("resume la previsualización: sin lectura, plazo gratuito, importe o sin cargo", () => {
    assert.match(penaltyPreviewSummary("cancellation", null, eur), /No se pudo calcular la penalización de cancelación/);
    assert.match(penaltyPreviewSummary("no_show", null, eur), /no-show/);
    assert.equal(
      penaltyPreviewSummary("cancellation", { amount: 0, withinFreeWindow: true, policyName: "Flexible", label: "x" }, eur),
      "Dentro del plazo de cancelación gratuita (política «Flexible»): sin penalización."
    );
    assert.equal(
      penaltyPreviewSummary("no_show", { amount: 136, withinFreeWindow: false, policyName: "Flexible", label: "x" }, eur),
      "Penalización prevista de 136,00 € (política «Flexible»): se cargará al folio como línea no sujeta a IVA."
    );
    assert.equal(penaltyPreviewSummary("cancellation", { amount: 0, withinFreeWindow: false, policyName: null, label: "x" }, eur), "Sin penalización (sin política de cancelación configurada).");
  });

  it("resume el resultado del API: penalización cargada o renunciada y estado del folio", () => {
    assert.equal(lifecycleOutcomeSummary("cancellation", null, eur), "Reserva cancelada.");
    assert.equal(lifecycleOutcomeSummary("no_show", undefined, eur), "No-show registrado.");
    assert.equal(
      lifecycleOutcomeSummary("cancellation", { applied: true, policyWaived: false, waivedAmount: 0, charge: { amount: 136 }, folio: { status: "open", balanceDue: 136 } }, eur),
      "Reserva cancelada · penalización de 136,00 € cargada al folio · folio abierto con saldo pendiente de 136,00 €."
    );
    assert.equal(
      lifecycleOutcomeSummary("no_show", { applied: true, policyWaived: false, waivedAmount: 0, charge: { amount: 0 }, folio: { status: "closed", balanceDue: 0 } }, eur),
      "No-show registrado · sin penalización · folio cerrado."
    );
    assert.equal(
      lifecycleOutcomeSummary("cancellation", { applied: false, policyWaived: true, waivedAmount: 90, charge: { amount: 90 }, folio: null }, eur),
      "Reserva cancelada · penalización de 90,00 € renunciada."
    );
    // Corrector L3 (FC-2): saldado con depósito pero sin factura → el folio queda abierto hasta emitirla.
    assert.equal(
      lifecycleOutcomeSummary("cancellation", { applied: true, policyWaived: false, waivedAmount: 0, charge: { amount: 150 }, folio: { status: "open", balanceDue: 0, pendingInvoice: true } }, eur),
      "Reserva cancelada · penalización de 150,00 € cargada al folio · folio saldado y abierto: emite la factura de la penalización para cerrarlo."
    );
    assert.equal(
      lifecycleOutcomeSummary("cancellation", { applied: false, policyWaived: true, waivedAmount: 0, charge: { amount: 0 }, folio: null }, eur),
      "Reserva cancelada · sin penalización."
    );
  });
});
