import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PSP_NOT_CONFIGURED_MESSAGE,
  amountToInput,
  isPspMethod,
  parseAmount,
  paymentIntentPlan,
  paymentIntentSummary,
  paymentKind,
  paymentMethodLabel,
  paymentMethodOptions,
  paymentStatusLabel,
  paymentStatusTone,
  refundableAmount,
  refundablePayments,
  resolveMethodCode
} from "../payment-flow.ts";

// Cocoa 22 · lote 6-A: pure helpers behind PaymentDialog / RefundDialog. No
// React, no network: the module must load under `node --test`.

describe("payment-flow · métodos", () => {
  it("resolves the canonical method from the enum, from a legacy label or from nothing", () => {
    assert.equal(resolveMethodCode("card", null), "card_terminal");
    assert.equal(resolveMethodCode("transfer"), "bank_transfer");
    assert.equal(resolveMethodCode("cash"), "cash");
    assert.equal(resolveMethodCode("card", "card_online"), "card_online");
    assert.equal(resolveMethodCode("bizum"), null);
  });

  it("labels methods in Spanish and keeps an unknown legacy label as typed", () => {
    assert.equal(paymentMethodLabel("card"), "Tarjeta (datáfono)");
    assert.equal(paymentMethodLabel("payment_link"), "Enlace de pago");
    assert.equal(paymentMethodLabel("bizum"), "bizum");
    assert.equal(paymentMethodLabel(""), "Sin método");
  });

  it("flags the PSP methods and can leave them out of a selector", () => {
    assert.equal(isPspMethod("card_online"), true);
    assert.equal(isPspMethod("link"), true);
    assert.equal(isPspMethod("cash"), false);
    const all = paymentMethodOptions();
    assert.equal(all.length, 6);
    assert.deepEqual(all.filter((option) => option.psp).map((option) => option.value), ["card_online", "payment_link"]);
    assert.deepEqual(
      paymentMethodOptions({ includePsp: false }).map((option) => option.value),
      ["cash", "card_terminal", "bank_transfer", "other"]
    );
  });
});

describe("payment-flow · estados y devoluciones", () => {
  it("labels and tones the payment statuses; refund rows read as info", () => {
    assert.equal(paymentStatusLabel("captured"), "Cobrado");
    assert.equal(paymentStatusLabel("requires_action"), "Pendiente de la pasarela");
    assert.equal(paymentStatusLabel(undefined), "Desconocido");
    assert.equal(paymentStatusTone("captured"), "success");
    assert.equal(paymentStatusTone("failed"), "danger");
    assert.equal(paymentStatusTone("captured", "refund"), "info");
  });

  it("infers the kind from reversalOfId when the API flag is missing", () => {
    assert.equal(paymentKind({ reversalOfId: "pay_1" }), "refund");
    assert.equal(paymentKind({ reversalOfId: null }), "capture");
    assert.equal(paymentKind({ kind: "refund", reversalOfId: null }), "refund");
  });

  it("computes what can still be refunded and filters the refundable rows", () => {
    const rows = [
      { id: "a", amount: 100, method: "cash", status: "captured", refundedAmount: 40, kind: "capture" as const },
      { id: "b", amount: 50, method: "card", status: "captured", refundedAmount: 50, kind: "capture" as const },
      { id: "c", amount: 20, method: "cash", status: "captured", kind: "refund" as const, reversalOfId: "a" },
      { id: "d", amount: 30, method: "cash", status: "pending" },
      { id: "e", amount: 10.005, method: "cash", status: "captured" }
    ];
    assert.equal(refundableAmount(rows[0]), 60);
    assert.equal(refundableAmount(rows[1]), 0);
    assert.equal(refundableAmount(rows[2]), 0);
    assert.equal(refundableAmount(rows[3]), 0);
    assert.equal(refundableAmount(rows[4]), 10.01);
    assert.deepEqual(refundablePayments(rows).map((row) => row.id), ["a", "e"]);
  });

  it("parses the amounts the operator types (comma or dot), rejecting anything else", () => {
    assert.equal(parseAmount("12,50"), 12.5);
    assert.equal(parseAmount(" 12.5 "), 12.5);
    assert.equal(parseAmount("1 234,567"), 1234.57);
    assert.equal(parseAmount("1.234,56"), 1234.56);
    assert.equal(parseAmount("1,234.56"), 1234.56);
    assert.equal(amountToInput(1234.5), "1234,50");
    assert.equal(amountToInput(null), "");
    assert.equal(parseAmount(""), null);
    assert.equal(parseAmount("12,5,0"), null);
    assert.equal(parseAmount("abc"), null);
  });
});

describe("payment-flow · intento de cobro (202)", () => {
  const intent = {
    id: "pi_1",
    propertyId: "prop_123",
    folioId: "fol_1",
    reservationId: null,
    amount: 50,
    currency: "EUR",
    status: "requires_action" as const,
    provider: "redsys" as const,
    providerReference: null,
    paymentLinkUrl: "https://sis-t.redsys.es/sis/realizarPago",
    paymentId: null,
    createdAt: "2026-09-16T10:00:00.000Z"
  };

  it("describes a GET redirect (hosted checkout link)", () => {
    const plan = paymentIntentPlan({ intent: { ...intent, provider: "stripe" }, redirect: { method: "GET", url: "https://checkout.stripe.com/c/pay/cs_test" } });
    assert.deepEqual(plan, { mode: "get", url: "https://checkout.stripe.com/c/pay/cs_test" });
  });

  it("describes a POST redirect with its signed fields", () => {
    const plan = paymentIntentPlan({
      intent,
      redirect: { method: "POST", url: "https://sis-t.redsys.es/sis/realizarPago", fields: { Ds_SignatureVersion: "HMAC_SHA256_V1", Ds_MerchantParameters: "eyJ", Ds_Signature: "abc" } }
    });
    assert.equal(plan.mode, "post");
    if (plan.mode === "post") {
      assert.equal(plan.url, "https://sis-t.redsys.es/sis/realizarPago");
      assert.deepEqual(plan.fields.map((field) => field.name), ["Ds_SignatureVersion", "Ds_MerchantParameters", "Ds_Signature"]);
    }
  });

  it("never says «cobrado» while the PSP has not confirmed", () => {
    const summary = paymentIntentSummary({ intent, idempotent: false });
    assert.match(summary, /Redsys/);
    assert.doesNotMatch(summary, /cobrado/i);
    assert.match(paymentIntentSummary({ intent, idempotent: true }), /ya existía/);
    assert.match(paymentIntentSummary({ intent: { ...intent, status: "captured" }, idempotent: false }), /ya confirmó/);
  });

  it("tells the operator how to get out of a missing PSP", () => {
    assert.match(PSP_NOT_CONFIGURED_MESSAGE, /otro método/);
    assert.match(PSP_NOT_CONFIGURED_MESSAGE, /Ajustes/);
  });
});
