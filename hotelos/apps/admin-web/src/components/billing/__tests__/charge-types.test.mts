import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLIO_LINE_TYPES } from "../../../../../../packages/compliance/src/spain/indirect-tax.ts";
import { ANY_CHARGE_TYPE, CHARGE_TYPE_LABELS, ROUTING_SOURCE_TYPES, chargeTypeLabel, normalizeChargeType, routingSourceOptions } from "../charge-types.ts";

// Cocoa 22 · lote 6-A (qa#5): the folio «Tipo» column and the routing rules
// never paint a raw code. Pure module: no React, no network.

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
