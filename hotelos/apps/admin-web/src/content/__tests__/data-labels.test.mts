import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLIO_LABELS, folioDisplayName, folioLabelText } from "../data-labels.ts";

// qa#6: Enrutamiento de folios painted «FOLIO guest · PRINCIPAL» and Tesorería
// «RES-00081 · guest» because the API stores the primary folio with the
// technical label "guest". The screens go through this dictionary.
describe("data-labels · folio labels in Spanish", () => {
  it("translates the system labels the API stores", () => {
    assert.equal(folioLabelText("guest"), "Huésped");
    assert.equal(folioLabelText("company"), "Empresa");
    assert.equal(folioLabelText("travel_agent"), "Agencia de viajes");
    for (const [key, text] of Object.entries(FOLIO_LABELS)) {
      assert.notEqual(key, text, `${key} must not paint its technical value`);
      assert.match(text, /^[A-ZÁÉÍÓÚÑ]/, `${key} → «${text}» starts with a capital`);
    }
  });

  it("passes operator-typed labels through untouched", () => {
    assert.equal(folioLabelText("Empresa"), "Empresa");
    assert.equal(folioLabelText("Agencia Viajes Norte"), "Agencia Viajes Norte");
    assert.equal(folioLabelText("  Extras  "), "Extras");
  });

  it("uses the fallback for an empty label", () => {
    assert.equal(folioLabelText(""), "—");
    assert.equal(folioLabelText(null), "—");
    assert.equal(folioLabelText(undefined, "principal"), "principal");
    assert.equal(folioLabelText("   ", "cmu1folio"), "cmu1folio");
  });

  it("names a folio with its role for pickers and cross-references", () => {
    assert.equal(folioDisplayName({ label: "guest", isPrimary: true }), "Huésped (principal)");
    assert.equal(folioDisplayName({ label: "Empresa", isPrimary: false }), "Empresa");
    assert.equal(folioDisplayName({ label: "company" }), "Empresa");
    assert.equal(folioDisplayName({ label: "", isPrimary: true }, "sin etiqueta"), "sin etiqueta (principal)");
  });
});
