import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplyPaymentSchema, PaymentMethodWireSchema } from "../../../../../api/src/schemas/folios.schemas.ts";
import { LEGACY_PAYMENT_METHOD_ALIASES, PAYMENT_METHODS, PSP_PAYMENT_METHODS } from "../../../../../../packages/shared/src/payments-types.ts";
import {
  QUICK_CHECKOUT_CAPTURED_METHODS,
  QUICK_CHECKOUT_METHOD_OPTIONS,
  QUICK_CHECKOUT_PAYMENT_BODY_KEYS,
  QUICK_CHECKOUT_PAYMENT_NOT_CONFIRMED_MESSAGE,
  QuickCheckoutPaymentError,
  assertQuickCheckoutPaymentCaptured,
  buildQuickCheckoutPaymentBody,
  normalizeQuickCheckoutMethod,
  quickCheckoutAttemptFingerprint,
  resolveQuickCheckoutAttempt
} from "../quickCheckoutPayment.ts";

// Tanda L3 · lote F2: el drawer de check-out rápido enviaba `status: "captured"`
// a POST /folios/:id/payments; ApplyPaymentSchema es `.strict()` → 400 y el
// check-out abortaba. El cuerpo se construye ahora con un builder puro que solo
// emite claves admitidas y reutiliza la clave de idempotencia en los reintentos.

/** Claves que admite ApplyPaymentSchema (apps/api/src/schemas/folios.schemas.ts). */
const ALLOWED_KEYS = new Set(["folioId", "amount", "currency", "method", "reference", "pspReference", "clientRequestId", "invoiceId", "returnUrl"]);

const BASE_INPUT = { amount: 136.5, currency: "EUR", method: "card", clientRequestId: "11111111-2222-4333-8444-555555555555" };

describe("Quick check-out · cuerpo del cobro", () => {
  it("solo lleva claves admitidas por ApplyPaymentSchema y nunca `status`", () => {
    const body = buildQuickCheckoutPaymentBody(BASE_INPUT);
    const keys = Object.keys(body);
    assert.deepEqual(keys.sort(), [...QUICK_CHECKOUT_PAYMENT_BODY_KEYS].sort());
    for (const key of keys) assert.ok(ALLOWED_KEYS.has(key), `clave no admitida por el API: ${key}`);
    assert.equal("status" in body, false, "el estado del cobro lo fija el API, nunca el cliente");
    // El esquema real del API acepta el cuerpo tal cual…
    const parsed = ApplyPaymentSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
    // …y rechaza lo que el drawer enviaba antes (la clave desconocida `status`).
    const legacy = ApplyPaymentSchema.safeParse({ ...body, status: "captured" });
    assert.equal(legacy.success, false, "ApplyPaymentSchema es strict: `status` debe ser un 400");
    assert.ok(!("status" in ApplyPaymentSchema.shape), "ApplyPaymentSchema no conoce `status`");
  });

  it("normaliza `card` → card_terminal (sin depender del alias legacy) y acepta los códigos canónicos", () => {
    assert.equal(buildQuickCheckoutPaymentBody(BASE_INPUT).method, "card_terminal");
    assert.equal(normalizeQuickCheckoutMethod("card"), LEGACY_PAYMENT_METHOD_ALIASES.card, "misma normalización que el API");
    assert.equal(normalizeQuickCheckoutMethod("  card "), "card_terminal");
    assert.equal(normalizeQuickCheckoutMethod("cash"), "cash");
    assert.equal(normalizeQuickCheckoutMethod("card_terminal"), "card_terminal");
    assert.equal(normalizeQuickCheckoutMethod("bank_transfer"), "bank_transfer");
    assert.equal(normalizeQuickCheckoutMethod("transfer"), LEGACY_PAYMENT_METHOD_ALIASES.transfer);
    for (const method of QUICK_CHECKOUT_CAPTURED_METHODS) {
      assert.ok(PAYMENT_METHODS.includes(method), `${method} no está en PAYMENT_METHODS`);
      assert.ok(!PSP_PAYMENT_METHODS.includes(method), `${method} exige pasarela: no vale para «cobrar y cerrar»`);
      assert.equal(PaymentMethodWireSchema.safeParse(method).success, true);
    }
  });

  it("todas las opciones del selector del drawer se normalizan a un método cobrable", () => {
    for (const option of QUICK_CHECKOUT_METHOD_OPTIONS) {
      const method = normalizeQuickCheckoutMethod(option.value);
      assert.ok(QUICK_CHECKOUT_CAPTURED_METHODS.includes(method), `${option.value} → ${method}`);
      assert.match(option.label, /^[A-ZÁÉÍÓÚ]/, "etiqueta en español con mayúscula inicial");
    }
    assert.ok(QUICK_CHECKOUT_METHOD_OPTIONS.some((option) => option.value === "card"), "el valor de estado inicial del drawer sigue siendo válido");
  });

  it("rechaza métodos fuera del conjunto cobrable (pasarela, desconocidos, vacío)", () => {
    for (const method of ["card_online", "payment_link", "link", "online", "other", "bitcoin", "", "CARD"]) {
      assert.throws(
        () => buildQuickCheckoutPaymentBody({ ...BASE_INPUT, method }),
        (err: unknown) => err instanceof QuickCheckoutPaymentError && err.code === "INVALID_METHOD" && /no admitido/.test(err.message),
        `método «${method}» debería rechazarse`
      );
    }
  });

  it("mantiene `clientRequestId` estable entre reintentos del mismo cobro y la cambia si cambia el cobro", () => {
    let seq = 0;
    const generate = () => `req-${++seq}`;
    const first = resolveQuickCheckoutAttempt(null, { folioId: "folio_1", amount: 80, currency: "EUR", method: "card" }, generate);
    assert.equal(first.clientRequestId, "req-1");
    // Reintento tras un fallo (misma huella): misma clave, no se genera otra.
    const retry = resolveQuickCheckoutAttempt(first, { folioId: "folio_1", amount: 80.0000001, currency: "eur", method: "card_terminal" }, generate);
    assert.equal(retry.clientRequestId, "req-1");
    assert.equal(seq, 1, "no se consume un uuid nuevo en el reintento");
    assert.equal(buildQuickCheckoutPaymentBody({ ...BASE_INPUT, amount: 80, clientRequestId: retry.clientRequestId }).clientRequestId, "req-1");
    // Otro importe (p. ej. el saldo que devuelve el 409 BALANCE_DUE) es otro cobro: otra clave.
    const otherAmount = resolveQuickCheckoutAttempt(retry, { folioId: "folio_1", amount: 95, currency: "EUR", method: "card" }, generate);
    assert.equal(otherAmount.clientRequestId, "req-2");
    // Otro método o folio también.
    const otherMethod = resolveQuickCheckoutAttempt(otherAmount, { folioId: "folio_1", amount: 95, currency: "EUR", method: "cash" }, generate);
    assert.equal(otherMethod.clientRequestId, "req-3");
    const otherFolio = resolveQuickCheckoutAttempt(otherMethod, { folioId: "folio_2", amount: 95, currency: "EUR", method: "cash" }, generate);
    assert.equal(otherFolio.clientRequestId, "req-4");
    assert.equal(quickCheckoutAttemptFingerprint({ folioId: "folio_1", amount: 80, currency: "EUR", method: "card" }), "folio_1|80.00|EUR|card_terminal");
  });

  it("importe a dos decimales y mayor que cero, moneda ISO en mayúsculas, clave de idempotencia obligatoria", () => {
    assert.equal(buildQuickCheckoutPaymentBody({ ...BASE_INPUT, amount: 12.300000000001 }).amount, 12.3);
    assert.equal(buildQuickCheckoutPaymentBody({ ...BASE_INPUT, amount: 0.1 + 0.2 }).amount, 0.3);
    assert.equal(ApplyPaymentSchema.safeParse(buildQuickCheckoutPaymentBody({ ...BASE_INPUT, amount: 0.1 + 0.2 })).success, true);
    assert.equal(buildQuickCheckoutPaymentBody({ ...BASE_INPUT, currency: " eur " }).currency, "EUR");
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.004]) {
      assert.throws(() => buildQuickCheckoutPaymentBody({ ...BASE_INPUT, amount }), (err: unknown) => err instanceof QuickCheckoutPaymentError && err.code === "INVALID_AMOUNT");
    }
    assert.throws(() => buildQuickCheckoutPaymentBody({ ...BASE_INPUT, currency: "euros" }), (err: unknown) => err instanceof QuickCheckoutPaymentError && err.code === "INVALID_CURRENCY");
    for (const clientRequestId of ["", "   ", "x".repeat(121)]) {
      assert.throws(() => buildQuickCheckoutPaymentBody({ ...BASE_INPUT, clientRequestId }), (err: unknown) => err instanceof QuickCheckoutPaymentError && err.code === "MISSING_CLIENT_REQUEST_ID");
    }
  });

  it("un 202 `kind: payment_intent` aborta: «el cobro no está confirmado»", () => {
    assert.throws(
      () => assertQuickCheckoutPaymentCaptured({ kind: "payment_intent" }),
      (err: unknown) => err instanceof QuickCheckoutPaymentError && err.code === "PAYMENT_NOT_CAPTURED" && err.message === QUICK_CHECKOUT_PAYMENT_NOT_CONFIRMED_MESSAGE
    );
    assert.match(QUICK_CHECKOUT_PAYMENT_NOT_CONFIRMED_MESSAGE, /el cobro no está confirmado/i);
    assert.throws(
      () => assertQuickCheckoutPaymentCaptured({ kind: "payment", status: "pending" }),
      (err: unknown) => err instanceof QuickCheckoutPaymentError && err.code === "PAYMENT_NOT_CAPTURED" && /pending/.test(err.message)
    );
    assert.doesNotThrow(() => assertQuickCheckoutPaymentCaptured({ kind: "payment", status: "captured" }));
    assert.doesNotThrow(() => assertQuickCheckoutPaymentCaptured({ kind: "payment" }));
  });
});
