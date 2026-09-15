import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uniqueByFolio } from "../reporting-center-rows.ts";

// qa#3 (Cocoa 22 · ola 9 · lote 9-A): the billing report repeats a folio when
// its reservation has two folios; the table key is the folio id.
describe("Centro de informes · filas del informe de facturación", () => {
  const closed = { folioId: "cmu1jic6q00bjfywhnr7671sc", status: "closed", balanceDue: 0, currency: "EUR" };
  const open = { folioId: "folio-open", status: "open", balanceDue: 120.5, currency: "EUR" };

  it("keeps the first occurrence of a repeated folio and the original order", () => {
    assert.deepEqual(uniqueByFolio([open, closed, { ...closed }]), [open, closed]);
    assert.deepEqual(uniqueByFolio([closed, open, closed, open]), [closed, open]);
  });

  it("is the identity on unique rows and on an empty report", () => {
    assert.deepEqual(uniqueByFolio([open, closed]), [open, closed]);
    assert.deepEqual(uniqueByFolio([]), []);
  });

  it("yields unique table keys (folioId) for any input", () => {
    const rows = uniqueByFolio([closed, closed, open, closed, open]);
    assert.equal(new Set(rows.map((r) => r.folioId)).size, rows.length);
  });
});
