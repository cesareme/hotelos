// Tanda ACT · correcciones de revisión · tenencia (puro, sin BD):
//   · ibiTaxpayerFor (ACT-REV-08, diseño §5.1): sujeto pasivo del IBI que propone una tenencia;
//   · auditProjection (ACT-REV-08): sin nombre de contraparte ni notas y con el NIF enmascarado.
//   node --import tsx --test src/modules/real-estate/__tests__/tenure.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealEstateTenureRecord } from "@hotelos/shared";
import { auditProjection, ibiTaxpayerFor } from "../tenure.service.js";

describe("ACT-REV-08 · taxpayer del IBI según la tenencia", () => {
  it("propietaria: sociedad; propietaria que repercute al inquilino: arrendatario; inmueble de un tercero: propietario_tercero", () => {
    assert.equal(ibiTaxpayerFor({ kind: "propiedad", ibiPayer: "propietario" }), "sociedad");
    assert.equal(ibiTaxpayerFor({ kind: "propiedad", ibiPayer: "arrendatario" }), "arrendatario");
    for (const kind of ["arrendamiento_local", "arrendamiento_industria", "gestion", "franquicia", "usufructo", "concesion"]) {
      assert.equal(ibiTaxpayerFor({ kind, ibiPayer: "propietario" }), "propietario_tercero", `${kind} · propietario`);
      // La repercusión del IBI a la sociedad arrendataria llega por factura del arrendador, nunca por el recibo municipal.
      assert.equal(ibiTaxpayerFor({ kind, ibiPayer: "arrendatario" }), "propietario_tercero", `${kind} · arrendatario`);
    }
  });
});

describe("ACT-REV-08 · proyección auditable de la tenencia", () => {
  it("excluye counterpartyName y notes y enmascara counterpartyTaxId", () => {
    const record = { kind: "arrendamiento_industria", counterpartyName: "Inmuebles Demo Sur SL", counterpartyTaxId: "B87654321", notes: "texto libre", status: "vigente", ibiPayer: "arrendatario" } as unknown as RealEstateTenureRecord;
    const projected = auditProjection(record, ["kind", "counterpartyName", "counterpartyTaxId", "notes", "status", "ibiPayer"]);
    assert.deepEqual(projected, { kind: "arrendamiento_industria", counterpartyTaxId: "***321", status: "vigente", ibiPayer: "arrendatario" });
    assert.equal("counterpartyName" in projected, false);
    assert.equal("notes" in projected, false);
    assert.equal(auditProjection(record).counterpartyTaxId, "***321", "también con la lista por defecto");
  });
});
