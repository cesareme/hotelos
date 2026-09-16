// qa#6 — the primary folio is stored with the technical label "guest"; every
// human-readable reference the API composes must paint it in Spanish while
// operator-typed labels («Empresa») pass through. Pure (no prisma).
// Run from apps/api with
//   node --import tsx --test src/modules/folio/__tests__/folio-labels.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRIMARY_FOLIO_LABEL, folioDisplayLabel } from "../folio-labels.js";

describe("folio labels · technical value → Spanish text", () => {
  it("keeps the stored sentinel of the primary folio unchanged", () => {
    assert.equal(PRIMARY_FOLIO_LABEL, "guest");
  });

  it("translates the system labels and leaves free text untouched", () => {
    assert.equal(folioDisplayLabel("guest"), "Huésped");
    assert.equal(folioDisplayLabel("company"), "Empresa");
    assert.equal(folioDisplayLabel("travel_agent"), "Agencia de viajes");
    assert.equal(folioDisplayLabel("Empresa"), "Empresa");
    assert.equal(folioDisplayLabel("Agencia Viajes Norte"), "Agencia Viajes Norte");
  });

  it("falls back to «Folio» when the label is empty", () => {
    assert.equal(folioDisplayLabel(""), "Folio");
    assert.equal(folioDisplayLabel("   "), "Folio");
    assert.equal(folioDisplayLabel(null), "Folio");
    assert.equal(folioDisplayLabel(undefined), "Folio");
  });
});
