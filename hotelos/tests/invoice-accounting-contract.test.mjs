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

  it("exposes accounting routes in server.ts and the canonical supplier bill routes in the payables and documents modules", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/organizations/:organizationId/accounts",
      "/organizations/:organizationId/journal-entries",
      "/journal-entries/drafts",
      "/journal-entries/:id/post"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
    // Tanda T9 (lote T9-15, dosier §3.4): the legacy header-only draft
    // (POST /supplier-bills/drafts) and the property listing
    // (GET /properties/:propertyId/supplier-bills) were retired from server.ts
    // and from the manifest. Supplier bills are created with lines through
    // modules/payables (payables.routes.ts, partial :22-23) or from a digitised
    // document (POST …/documents/:id/approve, modules/documents/workflow.routes.ts).
    const payablesRoutes = readFileSync(new URL("../apps/api/src/modules/payables/payables.routes.ts", import.meta.url), "utf8");
    const payablesPartial = readFileSync(new URL("../apps/api/src/modules/payables/route-permissions.partial.ts", import.meta.url), "utf8");
    const workflowRoutes = readFileSync(new URL("../apps/api/src/modules/documents/workflow.routes.ts", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
    const escape = (route) => route.replace(/[/:]/g, "\\$&");
    assert.match(payablesRoutes, new RegExp(`app\\.get\\("${escape("/properties/:propertyId/payables/supplier-bills")}"`));
    assert.match(payablesRoutes, new RegExp(`app\\.post\\("${escape("/properties/:propertyId/payables/supplier-bills")}"`));
    assert.match(payablesPartial, /method: "GET", path: "\/properties\/:propertyId\/payables\/supplier-bills", permissions: \["payables\.read"\]/);
    assert.match(payablesPartial, /method: "POST", path: "\/properties\/:propertyId\/payables\/supplier-bills", permissions: \["payables\.create"\]/);
    assert.match(workflowRoutes, new RegExp(`app\\.post\\("${escape("/properties/:propertyId/documents/:id/approve")}"`));
    // Retired: no handler and no manifest entry (comments are not entries).
    const code = (source) => source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const retired of ["/properties/:propertyId/supplier-bills", "/supplier-bills/drafts"]) {
      assert.doesNotMatch(code(server), new RegExp(`app\\.(get|post)\\("${escape(retired)}"`), `${retired} must not be registered in server.ts`);
      assert.doesNotMatch(code(manifest), new RegExp(`path: "${escape(retired)}"`), `${retired} must not be in the manifest`);
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

