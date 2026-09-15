// Payment method normalisation and idempotency helpers (pure). Run from apps/api with
//   node --import tsx --test src/modules/payments/__tests__/payment-method.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { legacyMethodLabel, methodCodeOfRow, methodRequiresPsp, normalizePaymentMethod } from "../payment-method.js";
import { idempotencyConflictError, paymentIntentIdFor, paymentRequestDifferences } from "../payments.service.js";
import { PAYMENT_METHOD_ACCOUNT_CODES } from "../../../../../../packages/shared/src/payments-types.js";

const D = PrismaRuntime.Decimal;

describe("normalizePaymentMethod", () => {
  it("accepts the enum and the legacy aliases, refuses anything else", () => {
    assert.deepEqual(normalizePaymentMethod("cash"), { methodCode: "cash", legacyMethod: "cash" });
    assert.deepEqual(normalizePaymentMethod("card"), { methodCode: "card_terminal", legacyMethod: "card" });
    assert.deepEqual(normalizePaymentMethod("card_terminal"), { methodCode: "card_terminal", legacyMethod: "card" });
    assert.deepEqual(normalizePaymentMethod("ota_virtual_card"), { methodCode: "card_terminal", legacyMethod: "ota_virtual_card" });
    assert.deepEqual(normalizePaymentMethod(" Bank_Transfer "), { methodCode: "bank_transfer", legacyMethod: "bank_transfer" });
    assert.deepEqual(normalizePaymentMethod("payment_link"), { methodCode: "payment_link", legacyMethod: "payment_link" });
    assert.throws(() => normalizePaymentMethod("bitcoin"), /Método de cobro no válido/);
    assert.throws(() => normalizePaymentMethod(undefined), /Método de cobro no válido/);
  });
  it("PSP methods and account mapping", () => {
    assert.equal(methodRequiresPsp("card_online"), true);
    assert.equal(methodRequiresPsp("payment_link"), true);
    assert.equal(methodRequiresPsp("cash"), false);
    assert.deepEqual(PAYMENT_METHOD_ACCOUNT_CODES, { cash: "570", card_terminal: "5721", card_online: "5722", bank_transfer: "572", payment_link: "5722", other: "572" });
    assert.equal(legacyMethodLabel("card_online"), "card");
    assert.equal(methodCodeOfRow({ methodCode: null, method: "card" }), "card_terminal");
    assert.equal(methodCodeOfRow({ methodCode: "cash", method: "card" }), "cash");
    assert.equal(methodCodeOfRow({ methodCode: null, method: "weird" }), "other");
  });
});

describe("idempotency helpers", () => {
  it("paymentRequestDifferences lists what changed for the same clientRequestId", () => {
    const existing = { amount: new D("110.00"), currency: "EUR", methodCode: "cash" as const, method: "cash", pspReference: null };
    assert.deepEqual(paymentRequestDifferences(existing, { amount: new D("110"), currency: "EUR", methodCode: "cash", reference: null }), []);
    const diffs = paymentRequestDifferences(existing, { amount: new D("120"), currency: "USD", methodCode: "card_terminal", reference: "T-1" });
    assert.equal(diffs.length, 4);
    assert.match(diffs[0]!, /110\.00 ≠ 120\.00/);
    const error = idempotencyConflictError({ clientRequestId: "req-1", existingPaymentId: "pay_1", differences: diffs });
    assert.equal(error.statusCode, 409);
    assert.equal((error.details as { code: string }).code, "IDEMPOTENCY_CONFLICT");
  });
  it("paymentIntentIdFor is deterministic per (folio, key)", () => {
    assert.equal(paymentIntentIdFor("f1", "k1"), paymentIntentIdFor("f1", "k1"));
    assert.notEqual(paymentIntentIdFor("f1", "k1"), paymentIntentIdFor("f2", "k1"));
    assert.match(paymentIntentIdFor("f1", "k1"), /^pi_[0-9a-f]{24}$/);
  });
});
