// Unit tests for the pure invoicing helpers of Tanda 2 · oleada 2 (issuer
// preview FISC-03, DUP-FOLIO-INVOICE guard, tax warnings, folio backfill).
// No database. Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/issuer.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ISSUER_TAX_ID_MISSING_CODE,
  ISSUER_TAX_ID_PLACEHOLDER,
  issuerIdentityWarnings,
  previewIssuerTaxId
} from "../issuer-identity.service.js";
import {
  FOLIO_ALREADY_INVOICED_CODE,
  findBlockingFolioInvoice,
  folioAlreadyInvoicedError,
  resolveFolioLinkCandidates,
  taxResolutionWarnings,
  type FolioInvoiceRow
} from "../invoice.service.js";
import { ConflictError } from "../../../lib/http-error.js";

describe("previewIssuerTaxId — FISC-03 preview never shows an invalid NIF as printable", () => {
  it("passes a valid NIF through untouched", () => {
    const preview = previewIssuerTaxId({ taxId: "B12345674", taxIdValid: true }, "sandbox");
    assert.deepEqual(preview, { taxId: "B12345674", placeholder: false, configured: "B12345674", warnings: [] });
  });

  it("swaps an invalid NIF for the flagged placeholder and keeps the configured value", () => {
    const preview = previewIssuerTaxId({ taxId: "B99999999", taxIdValid: false }, "sandbox");
    assert.equal(preview.taxId, ISSUER_TAX_ID_PLACEHOLDER);
    assert.equal(preview.placeholder, true);
    assert.equal(preview.configured, "B99999999");
    assert.equal(preview.warnings.length, 1);
    assert.match(preview.warnings[0]!, /«B99999999»/);
    assert.match(preview.warnings[0]!, /no es válido/);
    assert.match(preview.warnings[0]!, new RegExp(ISSUER_TAX_ID_PLACEHOLDER));
    // Finanzas (2026-09-15): issuance is blocked in every mode, never stamped with the placeholder.
    assert.match(preview.warnings[0]!, /se bloquea \(ISSUER_TAX_ID_MISSING\) en cualquier modo fiscal/);
    assert.match(preview.warnings[0]!, /ninguna factura nueva sale con el NIF de relleno/);
  });

  it("reports a missing NIF with configured = null", () => {
    const preview = previewIssuerTaxId({ taxId: null, taxIdValid: false }, "production");
    assert.equal(preview.taxId, ISSUER_TAX_ID_PLACEHOLDER);
    assert.equal(preview.placeholder, true);
    assert.equal(preview.configured, null);
    assert.match(preview.warnings[0]!, /no tiene NIF emisor configurado/);
    assert.match(preview.warnings[0]!, /Modo fiscal actual: production/);
    assert.match(preview.warnings[0]!, new RegExp(ISSUER_TAX_ID_MISSING_CODE));
  });

  it("issuerIdentityWarnings is empty for a valid identity", () => {
    assert.deepEqual(issuerIdentityWarnings({ taxId: "12345678Z", taxIdValid: true }, "sandbox"), []);
  });
});

function row(partial: Partial<FolioInvoiceRow> & { id: string }): FolioInvoiceRow {
  return { invoiceNumber: null, status: "issued", total: 100, rectifyingForId: null, ...partial };
}

describe("findBlockingFolioInvoice — DUP-FOLIO-INVOICE guard", () => {
  it("returns null for a folio with no invoices", () => {
    assert.equal(findBlockingFolioInvoice([]), null);
  });

  it("blocks on an issued invoice and on a draft", () => {
    const issued = row({ id: "i1", invoiceNumber: "FAC-2026-000008", status: "issued" });
    assert.equal(findBlockingFolioInvoice([issued]), issued);
    const draft = row({ id: "d1", status: "draft" });
    assert.equal(findBlockingFolioInvoice([draft]), draft);
  });

  it("reports the first live row in the caller's order (most recent first)", () => {
    const newer = row({ id: "i2", invoiceNumber: "FAC-2026-000009" });
    const older = row({ id: "i1", invoiceNumber: "FAC-2026-000008" });
    assert.equal(findBlockingFolioInvoice([newer, older]), newer);
  });

  it("allows re-invoicing when every previous invoice is cancelled or rectified", () => {
    const rows = [row({ id: "c1", status: "cancelled" }), row({ id: "r1", status: "rectified" })];
    assert.equal(findBlockingFolioInvoice(rows), null);
  });

  it("does not block on a rectificativa that fully reverses its original", () => {
    const original = row({ id: "o1", invoiceNumber: "FAC-2026-000002", status: "rectified", total: 10 });
    const creditNote = row({ id: "rec1", invoiceNumber: "REC-2026-000001", status: "issued", total: -10, rectifyingForId: "o1" });
    assert.equal(findBlockingFolioInvoice([creditNote, original]), null);
  });

  it("blocks on a partial rectificativa (original + delta are still the live invoice)", () => {
    const original = row({ id: "o1", status: "rectified", total: 100 });
    const partial = row({ id: "rec1", invoiceNumber: "REC-2026-000002", status: "issued", total: -25, rectifyingForId: "o1" });
    assert.equal(findBlockingFolioInvoice([partial, original]), partial);
  });

  it("blocks on a rectificativa whose original is not in the folio's rows (conservative)", () => {
    const orphan = row({ id: "rec1", status: "issued", total: -10, rectifyingForId: "elsewhere" });
    assert.equal(findBlockingFolioInvoice([orphan]), orphan);
  });

  it("ignores a cancelled rectificativa", () => {
    const original = row({ id: "o1", status: "rectified", total: 100 });
    const cancelledRec = row({ id: "rec1", status: "cancelled", total: -25, rectifyingForId: "o1" });
    assert.equal(findBlockingFolioInvoice([cancelledRec, original]), null);
  });
});

describe("folioAlreadyInvoicedError — 409 payload", () => {
  it("is a ConflictError with the machine payload for an issued invoice", () => {
    const error = folioAlreadyInvoicedError(row({ id: "i1", invoiceNumber: "FAC-2026-000009", status: "issued" }));
    assert.ok(error instanceof ConflictError);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /FAC-2026-000009/);
    assert.match(error.message, /emitida/);
    assert.match(error.message, /anúlala o rectifícala/);
    assert.deepEqual(error.details, {
      code: FOLIO_ALREADY_INVOICED_CODE,
      invoiceId: "i1",
      invoiceNumber: "FAC-2026-000009",
      status: "issued"
    });
  });

  it("names a draft by id and tells the user to issue it instead of creating another", () => {
    const error = folioAlreadyInvoicedError(row({ id: "d1", status: "draft" }));
    assert.match(error.message, /borrador d1/);
    assert.match(error.message, /emítela/);
    assert.equal((error.details as { status: string }).status, "draft");
    assert.equal((error.details as { invoiceNumber: string | null }).invoiceNumber, null);
  });
});

describe("taxResolutionWarnings — lines invoiced without VAT are reported, not blocked", () => {
  it("is empty when every line has a rate", () => {
    assert.deepEqual(taxResolutionWarnings([{ lineType: "room", taxCode: "IVA", ratePercent: 10 }]), []);
  });

  it("warns once per line type for UNKNOWN (no Tax for the region)", () => {
    const warnings = taxResolutionWarnings([
      { lineType: "room", taxCode: "UNKNOWN", ratePercent: 0 },
      { lineType: "room", taxCode: "UNKNOWN", ratePercent: 0 },
      { lineType: "extra", taxCode: "UNKNOWN", ratePercent: 0 }
    ]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /«room»/);
    assert.match(warnings[0]!, /ES_UNKNOWN_0/);
    assert.match(warnings[0]!, /sin IVA/);
    assert.match(warnings[1]!, /«extra»/);
  });

  it("warns for a 0 % rate on a known tax (no rate row for that concept, or explicit zero)", () => {
    const warnings = taxResolutionWarnings([{ lineType: "charge", taxCode: "IVA", ratePercent: 0 }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /«charge»/);
    assert.match(warnings[0]!, /IVA/);
  });
});

describe("resolveFolioLinkCandidates — backfill of Invoice.folioId", () => {
  it("links from the audit and lets a rectificativa inherit the original's folio from the database", () => {
    const resolved = new Map<string, string>();
    const candidates = resolveFolioLinkCandidates({
      rows: [
        { id: "fac1", rectifyingForId: null },
        { id: "rec1", rectifyingForId: "facDb" },
        { id: "manual", rectifyingForId: null }
      ],
      auditFolioByInvoice: new Map([["fac1", "folioA"]]),
      originalFolioById: new Map([["facDb", "folioB"]]),
      resolved
    });
    assert.deepEqual(candidates.get("fac1"), { folioId: "folioA", source: "audit" });
    assert.deepEqual(candidates.get("rec1"), { folioId: "folioB", source: "rectified" });
    assert.equal(candidates.has("manual"), false);
    assert.equal(resolved.get("rec1"), "folioB");
  });

  it("resolves a rectificativa whose original is linked in the same batch, and REC-of-REC chains", () => {
    const candidates = resolveFolioLinkCandidates({
      rows: [
        { id: "rec2", rectifyingForId: "rec1" }, // out of order on purpose
        { id: "rec1", rectifyingForId: "fac1" },
        { id: "fac1", rectifyingForId: null }
      ],
      auditFolioByInvoice: new Map([["fac1", "folioA"]]),
      originalFolioById: new Map([["fac1", null], ["rec1", null]]),
      resolved: new Map()
    });
    assert.deepEqual(candidates.get("rec1"), { folioId: "folioA", source: "rectified" });
    assert.deepEqual(candidates.get("rec2"), { folioId: "folioA", source: "rectified" });
  });

  it("uses a link resolved in an earlier batch (dry-run parity with a real run)", () => {
    const candidates = resolveFolioLinkCandidates({
      rows: [{ id: "rec1", rectifyingForId: "fac0" }],
      auditFolioByInvoice: new Map(),
      originalFolioById: new Map([["fac0", null]]),
      resolved: new Map([["fac0", "folioZ"]])
    });
    assert.deepEqual(candidates.get("rec1"), { folioId: "folioZ", source: "rectified" });
  });

  it("skips a rectificativa whose original has no folio anywhere", () => {
    const candidates = resolveFolioLinkCandidates({
      rows: [{ id: "rec1", rectifyingForId: "fac0" }],
      auditFolioByInvoice: new Map(),
      originalFolioById: new Map([["fac0", null]]),
      resolved: new Map()
    });
    assert.equal(candidates.size, 0);
  });
});
