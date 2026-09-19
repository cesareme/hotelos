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

// ---------------------------------------------------------------------------
// Tanda UX-1 · lote U5 · PaymentDialog como <form> (docs/design/UX-RECEPCION-FEEL.md
// §5.6, F6, §7.1 2.1.1): etiqueta con importe, método recordado en la sesión,
// ⌥1/2/3 y `closeAfter`. PaymentDialog.tsx llega a services/api-client.ts
// (`import.meta.env`): mismo gancho que hooks/__tests__/useApiData.test.mts.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const dialog = await import("../PaymentDialog.tsx");
const { money } = await import("../../../lib/format.ts");
const DIALOG_SOURCE = readFileSync(new URL("../PaymentDialog.tsx", import.meta.url), "utf8");

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
}

describe("PaymentDialog · etiqueta con importe (UX-1 · U5, §5.6)", () => {
  it("lleva el importe, «y cerrar» con closeAfter, «Cobrando…» mientras espera y «Cerrar» tras un intento", () => {
    // `money()` separa importe y símbolo con un espacio fino de no separación: se compone con la misma función.
    assert.equal(dialog.paymentConfirmLabel({ amount: 120, currency: "EUR", busy: false, intent: false }), `Cobrar ${money(120, "EUR")}`);
    assert.match(dialog.paymentConfirmLabel({ amount: 120, currency: "EUR", busy: false, intent: false }), /^Cobrar 120,00\s€$/);
    assert.equal(dialog.paymentConfirmLabel({ amount: 89.5, currency: "EUR", busy: false, intent: false, closeAfter: true }), `Cobrar ${money(89.5, "EUR")} y cerrar`);
    assert.equal(dialog.paymentConfirmLabel({ amount: null, currency: "EUR", busy: false, intent: false }), "Cobrar");
    assert.equal(dialog.paymentConfirmLabel({ amount: 0, currency: "EUR", busy: false, intent: false }), "Cobrar");
    assert.equal(dialog.paymentConfirmLabel({ amount: 120, currency: "EUR", busy: true, intent: false }), "Cobrando…");
    assert.equal(dialog.paymentConfirmLabel({ amount: 120, currency: "EUR", busy: false, intent: true }), "Cerrar");
  });
});

describe("PaymentDialog · método por defecto = último usado en la sesión", () => {
  it("recuerda el método y lo propone al abrir; efectivo si no hay ninguno o si el último necesita una pasarela ausente", () => {
    const storage = memoryStorage();
    assert.equal(dialog.readLastPaymentMethod(storage), null);
    assert.equal(dialog.defaultPaymentMethod(storage), "cash");
    dialog.rememberPaymentMethod(storage, "card_terminal");
    assert.equal(storage.map.get(dialog.LAST_PAYMENT_METHOD_KEY), "card_terminal");
    assert.equal(dialog.readLastPaymentMethod(storage), "card_terminal");
    assert.equal(dialog.defaultPaymentMethod(storage), "card_terminal");
    dialog.rememberPaymentMethod(storage, "card_online");
    assert.equal(dialog.defaultPaymentMethod(storage, { pspUnavailable: true }), "cash");
    assert.equal(dialog.defaultPaymentMethod(storage, { pspUnavailable: false }), "card_online");
  });

  it("ignora valores corruptos y almacenamientos que fallan", () => {
    assert.equal(dialog.readLastPaymentMethod(memoryStorage({ [dialog.LAST_PAYMENT_METHOD_KEY]: "bizum" })), null);
    assert.equal(dialog.readLastPaymentMethod(null), null);
    const broken = { getItem: () => { throw new Error("private mode"); }, setItem: () => { throw new Error("quota"); } };
    assert.equal(dialog.defaultPaymentMethod(broken), "cash");
    assert.doesNotThrow(() => dialog.rememberPaymentMethod(broken, "cash"));
  });
});

describe("PaymentDialog · ⌥1 / ⌥2 / ⌥3 (por `code`, R8)", () => {
  it("mapea efectivo, tarjeta (datáfono) y transferencia y no responde sin ⌥ ni con ⌘/Ctrl/⇧", () => {
    assert.deepEqual(dialog.PAYMENT_METHOD_ACCESS_KEYS, { Digit1: "cash", Digit2: "card_terminal", Digit3: "bank_transfer" });
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit1", altKey: true }), "cash");
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit2", altKey: true }), "card_terminal");
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit3", altKey: true }), "bank_transfer");
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit4", altKey: true }), null);
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit1", altKey: false }), null);
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit1", altKey: true, metaKey: true }), null);
    assert.equal(dialog.paymentMethodForAccessKey({ code: "Digit1", altKey: true, shiftKey: true }), null);
  });
});

describe("PaymentDialog · fuente: <form onSubmit> y Confirm como botón de envío (F6)", () => {
  it("envuelve el cuerpo en un <form id> con onSubmit, lo asocia al Confirm del diálogo y mantiene el foco en el importe", () => {
    assert.match(DIALOG_SOURCE, /<form\s[^>]*id=\{formId\}/);
    assert.match(DIALOG_SOURCE, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);/);
    assert.match(DIALOG_SOURCE, /confirmForm=\{intent \? undefined : formId\}/);
    assert.match(DIALOG_SOURCE, /initialFocus=\{\(\) => document\.getElementById\(amountId\)\}/);
    assert.match(DIALOG_SOURCE, /closeAfter\?: boolean/);
    assert.match(DIALOG_SOURCE, /rememberPaymentMethod\(sessionStorageOrNull\(\), method\)/);
    assert.doesNotMatch(DIALOG_SOURCE, /style=\{/, "0 style= nuevos (contrato Cocoa 22)");
  });
});

describe("PaymentDialog · «Cobrar y cerrar» solo cuando el importe salda la cuenta (UX-1 · U7, §5.6)", () => {
  it("shouldCloseAfter: cierra con closeAfter e importe = saldo (a un céntimo); un anticipo o un importe distinto solo cobra", () => {
    assert.equal(dialog.shouldCloseAfter({ closeAfter: true, amount: 120, balanceDue: 120 }), true);
    assert.equal(dialog.shouldCloseAfter({ closeAfter: true, amount: 120.004, balanceDue: 120 }), true);
    assert.equal(dialog.shouldCloseAfter({ closeAfter: true, amount: 50, balanceDue: 120 }), false);
    assert.equal(dialog.shouldCloseAfter({ closeAfter: true, amount: null, balanceDue: 120 }), false);
    assert.equal(dialog.shouldCloseAfter({ closeAfter: true, amount: 0, balanceDue: 0 }), false);
    assert.equal(dialog.shouldCloseAfter({ closeAfter: false, amount: 120, balanceDue: 120 }), false);
    assert.equal(dialog.shouldCloseAfter({ amount: 120, balanceDue: 120 }), false);
  });
  it("la fuente pasa la decisión en onCaptured y la etiqueta usa willClose, no la prop a secas", () => {
    assert.match(DIALOG_SOURCE, /const willClose = shouldCloseAfter\(\{ closeAfter, amount, balanceDue \}\)/);
    assert.match(DIALOG_SOURCE, /onCaptured\?\.\(result, \{ closeAfter: willClose \}\)/);
    assert.match(DIALOG_SOURCE, /closeAfter: willClose \}\)/);
  });
});

// ---------------------------------------------------------------------------
// InvoiceFromReservationDialog (U7 · F14, WCAG 3.3.7): valores recordados,
// memoria de NIF por razón social, validación y etiqueta del botón.
// ---------------------------------------------------------------------------
const invoiceDialog = await import("../InvoiceFromReservationDialog.tsx");
const INVOICE_SOURCE = readFileSync(new URL("../InvoiceFromReservationDialog.tsx", import.meta.url), "utf8");
const { buildFolioInvoiceBody } = await import("../../../services/pmsCommerceApi.ts");

describe("InvoiceFromReservationDialog · destinatario y valores recordados (3.3.7)", () => {
  const reservation = {
    id: "res_1",
    code: "RES-1",
    companyName: "Empresa UXDAY SL",
    billingInstruction: "company_invoice",
    bookerName: "Contacto Corporativo",
    primaryGuest: { firstName: "Contacto", surname1: "Corporativo", surname2: null, documentNumber: "12345678Z" }
  };
  it("recuerda «empresa» cuando la reserva se factura a empresa o tiene razón social; «huésped» si no", () => {
    assert.equal(invoiceDialog.rememberedCustomerType(reservation), "company");
    assert.equal(invoiceDialog.rememberedCustomerType({ billingInstruction: null, companyName: "  Acme  " }), "company");
    assert.equal(invoiceDialog.rememberedCustomerType({ billingInstruction: "guest_pays", companyName: "" }), "guest");
  });
  it("empresa: razón social de la reserva y NIF recordado del navegador; huésped: nombre completo y documento", () => {
    const company = invoiceDialog.invoiceDefaultsFor(reservation, "company", memoryStorage());
    assert.deepEqual(company, { customerName: "Empresa UXDAY SL", customerTaxId: "", taxIdSource: null });
    const storage = memoryStorage();
    invoiceDialog.rememberTaxId(storage, "Empresa UXDAY SL", "B12345674");
    assert.equal(invoiceDialog.readRememberedTaxId(storage, "  empresa uxday sl "), "B12345674");
    assert.deepEqual(invoiceDialog.invoiceDefaultsFor(reservation, "company", storage), { customerName: "Empresa UXDAY SL", customerTaxId: "B12345674", taxIdSource: "memory" });
    assert.deepEqual(invoiceDialog.invoiceDefaultsFor(reservation, "guest", storage), { customerName: "Contacto Corporativo", customerTaxId: "12345678Z", taxIdSource: "guest" });
    assert.equal(invoiceDialog.guestDisplayName(null), null);
    assert.equal(invoiceDialog.guestDisplayName({ firstName: " Ana ", surname1: "", surname2: "Zeta" }), "Ana Zeta");
  });
  it("la memoria de NIF ignora valores corruptos, conserva 50 entradas y sobrevive a un almacenamiento roto", () => {
    assert.equal(invoiceDialog.readRememberedTaxId(memoryStorage({ [invoiceDialog.TAX_ID_MEMORY_KEY]: "{oops" }), "x"), null);
    assert.equal(invoiceDialog.readRememberedTaxId(null, "x"), null);
    const storage = memoryStorage();
    for (let i = 0; i < 55; i += 1) invoiceDialog.rememberTaxId(storage, `Empresa ${i}`, `B${i}`);
    assert.equal(invoiceDialog.readRememberedTaxId(storage, "Empresa 0"), null, "las más antiguas caen");
    assert.equal(invoiceDialog.readRememberedTaxId(storage, "Empresa 54"), "B54");
    const broken = { getItem: () => { throw new Error("private mode"); }, setItem: () => { throw new Error("quota"); } };
    assert.doesNotThrow(() => invoiceDialog.rememberTaxId(broken, "Acme", "B1"));
    assert.equal(invoiceDialog.readRememberedTaxId(broken, "Acme"), null);
  });
  it("una factura a empresa exige razón social y NIF; a huésped no; el botón dice lo que hará", () => {
    assert.equal(invoiceDialog.invoiceFormError({ customerType: "company", customerName: "", customerTaxId: "B1" }), "Indica la razón social de la empresa.");
    assert.equal(invoiceDialog.invoiceFormError({ customerType: "company", customerName: "Acme", customerTaxId: " " }), "Indica el NIF de la empresa.");
    assert.equal(invoiceDialog.invoiceFormError({ customerType: "company", customerName: "Acme", customerTaxId: "B1" }), null);
    assert.equal(invoiceDialog.invoiceFormError({ customerType: "guest", customerName: "", customerTaxId: "" }), null);
    assert.equal(invoiceDialog.invoiceConfirmLabel({ mode: "draft", busy: false }), "Crear borrador");
    assert.equal(invoiceDialog.invoiceConfirmLabel({ mode: "issue", busy: false }), "Emitir con número");
    assert.equal(invoiceDialog.invoiceConfirmLabel({ mode: "issue", busy: true }), "Emitiendo…");
  });
  it("buildFolioInvoiceBody: solo las claves con valor (IssueInvoiceSchema estricto)", () => {
    assert.deepEqual(buildFolioInvoiceBody({ customerType: "guest", customerName: "", customerTaxId: null }), { customerType: "guest" });
    assert.deepEqual(buildFolioInvoiceBody({ customerType: "company", customerName: " Acme ", customerTaxId: " B1 " }), { customerType: "company", customerName: "Acme", customerTaxId: "B1" });
  });
  it("fuente: <form id> con Intro, borrador por defecto, toast con número real y 0 style=", () => {
    assert.match(INVOICE_SOURCE, /<form id=\{formId\}/);
    assert.match(INVOICE_SOURCE, /confirmForm=\{formId\}/);
    assert.match(INVOICE_SOURCE, /mode: initialMode = "draft"/);
    assert.match(INVOICE_SOURCE, /FRONT_DESK_TOASTS\.invoiceIssued\(result\.invoiceNumber\)/);
    assert.match(INVOICE_SOURCE, /issueFolioInvoice\(folioId, \{ customerType, customerName, customerTaxId, issue: mode === "issue" \}\)/);
    assert.doesNotMatch(INVOICE_SOURCE, /style=\{/, "0 style= nuevos (contrato Cocoa 22)");
  });
});
