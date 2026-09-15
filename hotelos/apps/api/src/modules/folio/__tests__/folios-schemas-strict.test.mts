// t6#14 — the legacy money bodies (folio line, invoice draft, close folio,
// cancel invoice) are strict: an unknown key is a validation error with the
// Spanish message, while the documented shapes (the ones admin-web sends)
// still parse. Pure (zod only).
// Run from apps/api with
//   node --import tsx --test src/modules/folio/__tests__/folios-schemas-strict.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApplyPaymentSchema,
  CancelInvoiceSchema,
  CloseFolioSchema,
  CreateChargeSchema,
  CreateFolioLineSchema,
  IssueInvoiceSchema,
  MarkInvoicePaidSchema,
  RefundPaymentSchema,
  STRICT_BODY_MESSAGE
} from "../../../schemas/folios.schemas.js";

function unrecognized(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ code: string; message: string; keys?: string[] }> } } }, value: unknown): string[] {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `expected ${JSON.stringify(value)} to be rejected`);
  const issues = result.error!.issues.filter((issue) => issue.code === "unrecognized_keys");
  assert.ok(issues.length > 0, `expected an unrecognized_keys issue, got ${JSON.stringify(result.error!.issues)}`);
  for (const issue of issues) assert.equal(issue.message, STRICT_BODY_MESSAGE);
  return issues.flatMap((issue) => issue.keys ?? []);
}

describe("CreateFolioLineSchema (POST /folios/:id/lines)", () => {
  it("accepts the admin-web body (type, description, quantity, unitPrice, taxCode?, taxCategory?)", () => {
    assert.equal(CreateFolioLineSchema.safeParse({ type: "minibar", description: "Agua", quantity: 1, unitPrice: 2 }).success, true);
    assert.equal(CreateFolioLineSchema.safeParse({ type: "room", description: "Habitación", quantity: 1, unitPrice: 100, taxCode: "IVA10", taxCategory: "accommodation" }).success, true);
  });
  it("rejects an unknown key with the Spanish message", () => {
    assert.deepEqual(unrecognized(CreateFolioLineSchema, { type: "minibar", description: "Agua", quantity: 1, unitPrice: 2, foo: 1 }), ["foo"]);
  });
});

describe("IssueInvoiceSchema (POST /folios/:id/invoice)", () => {
  it("accepts the documented body, including manual lines", () => {
    assert.equal(IssueInvoiceSchema.safeParse({ customerType: "guest" }).success, true);
    assert.equal(IssueInvoiceSchema.safeParse({ customerType: "company", customerName: "ACME SL", customerTaxId: "B12345674", invoiceType: "F1", currency: "EUR", currencyCode: "EUR", lines: [{ description: "x", amount: 10, quantity: 1, taxCode: "IVA21" }] }).success, true);
    assert.equal(IssueInvoiceSchema.safeParse({}).success, true);
  });
  it("rejects unknown keys at the top level and inside lines", () => {
    assert.deepEqual(unrecognized(IssueInvoiceSchema, { customerType: "guest", customerName: "X", foo: 1 }), ["foo"]);
    assert.deepEqual(unrecognized(IssueInvoiceSchema, { lines: [{ description: "x", amount: 1, discount: 5 }] }), ["discount"]);
  });
});

describe("CloseFolioSchema / CancelInvoiceSchema / CreateChargeSchema", () => {
  it("keep accepting an empty body and their documented keys", () => {
    assert.equal(CloseFolioSchema.safeParse({}).success, true);
    assert.equal(CloseFolioSchema.safeParse({ reason: "check-out" }).success, true);
    assert.equal(CancelInvoiceSchema.safeParse({}).success, true);
    assert.equal(CancelInvoiceSchema.safeParse({ reason: "error", refundPayments: true }).success, true);
    assert.equal(CreateChargeSchema.safeParse({ description: "Parking", amount: 12.1 }).success, true);
  });
  it("reject unknown keys", () => {
    assert.deepEqual(unrecognized(CloseFolioSchema, { reason: "x", force: true }), ["force"]);
    assert.deepEqual(unrecognized(CancelInvoiceSchema, { reason: "x", deleteJournal: true }), ["deleteJournal"]);
    assert.deepEqual(unrecognized(CreateChargeSchema, { description: "Parking", amount: 12.1, foo: 1 }), ["foo"]);
  });
});

describe("the newer money schemas stay strict (regression guard)", () => {
  it("ApplyPaymentSchema / RefundPaymentSchema / MarkInvoicePaidSchema reject unknown keys", () => {
    assert.equal(ApplyPaymentSchema.safeParse({ amount: 10, method: "cash", foo: 1 }).success, false);
    assert.equal(RefundPaymentSchema.safeParse({ reason: "x", foo: 1 }).success, false);
    assert.equal(MarkInvoicePaidSchema.safeParse({ method: "bank_transfer", reference: "TRF-1", foo: 1 }).success, false);
  });
});
