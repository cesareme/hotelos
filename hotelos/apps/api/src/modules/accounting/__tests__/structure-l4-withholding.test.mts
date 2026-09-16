// Unit tests · Tanda 6b · L4 — the withholding projection never drops a
// retention in silence (design §5.2 R4, §4 #7). No database. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/structure-l4-withholding.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventEnvelope } from "@hotelos/shared";
import { ConflictError } from "../../../lib/http-error.js";
import { MODELO_111_ROW_DEFAULTS, WORK_CENTER_REQUIRED_CODE, draftFromEvent, workCenterRequiredError } from "../posting-rules/withholding-tax.js";

function event(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    eventId: "evt_l4_1",
    organizationId: "org_l4",
    propertyId: "prop_l4_office",
    entityType: "supplier_bill",
    entityId: "sb_l4_1",
    eventType: "SupplierBillCreated",
    payload: { grossAmount: 1000, retentionRate: 15, supplierTaxId: "12345678Z", supplierName: "Asesor" },
    actorType: "system",
    correlationId: "corr_l4",
    hashAlgorithm: "sha256",
    currentHash: "hash",
    createdAt: "2026-08-05T10:00:00.000Z",
    ...overrides
  };
}

describe("draftFromEvent · retention of the head office", () => {
  it("builds the Modelo 111 draft on the office centre (kind office is a centre like any hotel)", () => {
    const draft = draftFromEvent(event({}));
    assert.ok(draft);
    assert.equal(draft.propertyId, "prop_l4_office");
    assert.equal(draft.sourceType, "vendor_invoice");
    assert.equal(draft.grossAmount, "1000.00");
    assert.equal(draft.retentionRate, "15.00");
    assert.equal(draft.retentionAmount, "150.00");
    assert.equal(draft.rowCode, MODELO_111_ROW_DEFAULTS.vendor_invoice);
    assert.equal(draft.recipientNif, "12345678Z");
  });

  it("stays silent for events that are not withholding events or carry no retention", () => {
    assert.equal(draftFromEvent(event({ eventType: "GuestCheckedOut", propertyId: "" })), null, "irrelevant event type, even without a centre");
    assert.equal(draftFromEvent(event({ payload: { grossAmount: 1000 }, propertyId: "" })), null, "no retention → no record, no error");
    assert.equal(draftFromEvent(event({ payload: { grossAmount: 1000, retentionRate: 0, retentionAmount: 0 } })), null);
    assert.equal(draftFromEvent(event({ organizationId: "" })), null);
    assert.equal(draftFromEvent(event({ entityId: "" })), null);
  });

  it("a retention WITHOUT a work centre is a 409 WORK_CENTER_REQUIRED, never a silent null", () => {
    assert.throws(
      () => draftFromEvent(event({ propertyId: "" })),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.statusCode, 409);
        const details = error.details as Record<string, unknown>;
        assert.equal(details.code, WORK_CENTER_REQUIRED_CODE);
        assert.equal(details.eventId, "evt_l4_1");
        assert.equal(details.eventType, "SupplierBillCreated");
        assert.equal(details.sourceType, "vendor_invoice");
        assert.equal(details.retentionAmount, "150.00");
        assert.match(error.message, /centro de trabajo/);
        return true;
      }
    );
    assert.throws(() => draftFromEvent(event({ eventType: "PayrollPaymentRecorded", entityType: "payroll_period", propertyId: "", payload: { grossAmount: "2000.00", retentionAmount: "300.00" } })), ConflictError);
  });

  it("payroll events default to row 01 (rendimientos del trabajo)", () => {
    const draft = draftFromEvent(event({ eventType: "PayrollPaymentRecorded", entityType: "payroll_period", payload: { grossAmount: "2000.00", retentionAmount: "300.00" } }));
    assert.equal(draft?.sourceType, "payroll_payment");
    assert.equal(draft?.rowCode, "01");
    assert.equal(draft?.retentionAmount, "300.00");
    assert.equal(draft?.retentionRate, "0.00", "an amount-only payload keeps rate 0 (pre-L4 behaviour, unchanged: the record is still created)");
  });
});

describe("workCenterRequiredError", () => {
  it("is a 409 whose typed code always wins over extra.code and carries the caller's context", () => {
    const error = workCenterRequiredError({ code: "SOMETHING_ELSE", periodId: "per_1", contractId: "ct_1" });
    assert.equal(error.statusCode, 409);
    assert.deepEqual(error.details, { periodId: "per_1", contractId: "ct_1", code: "WORK_CENTER_REQUIRED" });
    assert.match(error.message, /Modelo 111\/115/);
  });
});
