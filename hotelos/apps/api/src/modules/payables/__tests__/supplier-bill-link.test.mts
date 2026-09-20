// Unit tests · Tanda T9 · corrector SEC-01 — el enlace factura ↔ documento entrante
// (supplier-bills.service.ts assertLinkedDocumentFieldsAllowed): por HTTP no se
// admite incomingDocumentId ni source ≠ manual; solo el flujo de documentos los fija.
// Puro, sin Postgres. Desde apps/api:
//   node --import tsx --test src/modules/payables/__tests__/supplier-bill-link.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpError } from "../../../lib/http-error.js";
import { assertLinkedDocumentFieldsAllowed } from "../supplier-bills.service.js";

const bad = (error: HttpError, field: string): boolean => error.statusCode === 400 && (error.details as { code: string; field: string }).code === "VALIDATION_ERROR" && (error.details as { field: string }).field === field;

describe("assertLinkedDocumentFieldsAllowed", () => {
  it("por HTTP (sin origen): incomingDocumentId → 400; source digitized / e_invoice → 400; manual o ausente → ok", () => {
    assert.throws(() => assertLinkedDocumentFieldsAllowed({ incomingDocumentId: "doc_ajeno" }, undefined), (error: HttpError) => bad(error, "incomingDocumentId"));
    assert.throws(() => assertLinkedDocumentFieldsAllowed({ source: "digitized" }, undefined), (error: HttpError) => bad(error, "source"));
    assert.throws(() => assertLinkedDocumentFieldsAllowed({ source: "e_invoice" }, undefined), (error: HttpError) => bad(error, "source"));
    assert.doesNotThrow(() => assertLinkedDocumentFieldsAllowed({ source: "manual" }, undefined));
    assert.doesNotThrow(() => assertLinkedDocumentFieldsAllowed({ incomingDocumentId: null }, undefined));
    assert.doesNotThrow(() => assertLinkedDocumentFieldsAllowed({}, undefined));
  });

  it("desde el flujo de documentos (origin documents) los dos campos se aceptan (la tenencia la recomprueba la transacción)", () => {
    assert.doesNotThrow(() => assertLinkedDocumentFieldsAllowed({ incomingDocumentId: "doc_propio", source: "digitized" }, "documents"));
    assert.doesNotThrow(() => assertLinkedDocumentFieldsAllowed({ incomingDocumentId: "doc_propio", source: "e_invoice" }, "documents"));
  });
});
