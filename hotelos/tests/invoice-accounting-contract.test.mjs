import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Invoicing and accounting contracts", () => {
  it("exposes invoice lifecycle routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    // Invoice drafts are created from a folio (POST /folios/:id/invoice)
    // rather than a standalone POST /invoices/drafts, and the rectifying
    // route is now /invoices/:id/rectify. The set still covers the full
    // invoice lifecycle (create draft → read → issue → cancel → rectify).
    for (const route of [
      "/properties/:propertyId/invoices",
      "/folios/:id/invoice",
      "/invoices/:id",
      "/invoices/:id/issue",
      "/invoices/:id/cancel",
      "/invoices/:id/rectify"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("exposes accounting and supplier bill draft routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/organizations/:organizationId/accounts",
      "/organizations/:organizationId/journal-entries",
      "/journal-entries/drafts",
      "/journal-entries/:id/post",
      "/properties/:propertyId/supplier-bills",
      "/supplier-bills/drafts"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("keeps issued invoice edits behind correction workflows", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/invoicing/invoice.service.ts", import.meta.url), "utf8");
    assert.match(service, /assertInvoiceMutable/);
    assert.match(service, /createRectifyingInvoice/);
    // The rectifying invoice audit action was renamed to INVOICE_RECTIFIED so
    // it matches the canonical past-tense convention used by the rest of the
    // invoice lifecycle (INVOICE_ISSUED, INVOICE_CANCELLED, INVOICE_RECTIFIED).
    assert.match(service, /INVOICE_RECTIFIED/);
    assert.match(service, /verifactuHash/);
    assert.match(service, /qrPayload/);
  });

  it("requires balanced journals and approval-gated posting", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/accounting/accounting.service.ts", import.meta.url), "utf8");
    assert.match(service, /assertBalancedJournal/);
    assert.match(service, /accounting\.journal\.post/);
    assert.match(service, /ai\.high_risk\.confirm/);
    assert.match(service, /SUPPLIER_BILL_DRAFT_CREATED/);
  });
});

