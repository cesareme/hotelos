import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplyPaymentSchema, PaymentMethodWireSchema } from "../../../../../api/src/schemas/folios.schemas.ts";
import { LEGACY_PAYMENT_METHOD_ALIASES, PAYMENT_METHODS, PSP_PAYMENT_METHODS } from "../../../../../../packages/shared/src/payments-types.ts";
import {
  QUICK_CHECKIN_CAPTURED_METHODS,
  QUICK_CHECKIN_METHOD_OPTIONS,
  QUICK_CHECKIN_PAYMENT_BODY_KEYS,
  QUICK_CHECKIN_PAYMENT_MODE_LABELS,
  QUICK_CHECKIN_PAYMENT_NOT_CONFIRMED_MESSAGE,
  QuickCheckinPaymentError,
  assertCheckinPaymentCaptured,
  buildCheckinPaymentBody,
  defaultQuickCheckinPaymentMode,
  normalizeQuickCheckinMethod,
  quickCheckinAttemptFingerprint,
  resolveQuickCheckinAmount,
  resolveQuickCheckinAttempt,
  type QuickCheckinPaymentMode
} from "../quickCheckinPayment.ts";

// Tanda UX-1 · lote U0b (F1/F19, D8): el drawer de check-in rápido enviaba a
// POST /folios/:id/payments {amount: <total de la reserva>, currency, method,
// status: "pending"}; ApplyPaymentSchema es `.strict()` → 400 «Unrecognized
// key(s) in object: 'status'» y el check-in abortaba siempre que hubiera saldo
// (reproducido el 2026-09-19 con UXDAY-A5: total 178 €, cobrado 50 €, saldo
// 128 €). El cuerpo lo construye ahora un builder puro gemelo del de check-out
// (solo claves admitidas, importe = saldo o depósito, clave de idempotencia
// reutilizada en los reintentos) y el check-in solo sigue si el cobro queda
// `captured`.

/** Claves que admite ApplyPaymentSchema (apps/api/src/schemas/folios.schemas.ts). */
const ALLOWED_KEYS = new Set(["folioId", "amount", "currency", "method", "reference", "pspReference", "clientRequestId", "invoiceId", "returnUrl"]);

const BASE_INPUT = { amount: 128, currency: "EUR", method: "card", clientRequestId: "11111111-2222-4333-8444-555555555555" };

/** UXDAY-A5 tal como lo devuelve GET /reservations/:id/folio (total 178, cobrado 50). */
const UXDAY_A5_FOLIO = { balanceDue: 128, paymentsTotal: 50, chargesTotal: 178 };

describe("Quick check-in · cuerpo del cobro", () => {
  it("solo lleva claves admitidas por ApplyPaymentSchema y nunca `status`", () => {
    const body = buildCheckinPaymentBody(BASE_INPUT);
    const keys = Object.keys(body);
    assert.deepEqual(keys.sort(), [...QUICK_CHECKIN_PAYMENT_BODY_KEYS].sort());
    for (const key of keys) assert.ok(ALLOWED_KEYS.has(key), `clave no admitida por el API: ${key}`);
    assert.equal("status" in body, false, "el estado del cobro lo fija el API, nunca el cliente");
    // El esquema real del API acepta el cuerpo tal cual…
    const parsed = ApplyPaymentSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
    // …y rechaza lo que el drawer enviaba antes (reproducido en runtime: 400 «Unrecognized key(s) in object: 'status'»).
    const legacy = ApplyPaymentSchema.safeParse({ amount: 178, currency: "EUR", method: "card", status: "pending" });
    assert.equal(legacy.success, false, "ApplyPaymentSchema es strict: `status` debe ser un 400");
    assert.ok(!legacy.success && legacy.error.issues.some((issue) => issue.code === "unrecognized_keys" && "keys" in issue && (issue.keys as string[]).includes("status")));
    assert.ok(!("status" in ApplyPaymentSchema.shape), "ApplyPaymentSchema no conoce `status`");
  });

  it("el cuerpo que se envía ahora para UXDAY-A5 es {amount: 128 (saldo), currency, method: card_terminal, clientRequestId}", () => {
    const amount = resolveQuickCheckinAmount("balance", UXDAY_A5_FOLIO);
    assert.equal(amount, 128, "importe = saldo del folio, no el total de la reserva (178)");
    const body = buildCheckinPaymentBody({ amount: amount!, currency: "EUR", method: "card", clientRequestId: "req-a5" });
    assert.deepEqual(body, { amount: 128, currency: "EUR", method: "card_terminal", clientRequestId: "req-a5" });
    assert.equal(ApplyPaymentSchema.safeParse(body).success, true);
  });

  it("normaliza `card` → card_terminal (sin depender del alias legacy) y acepta los códigos canónicos", () => {
    assert.equal(buildCheckinPaymentBody(BASE_INPUT).method, "card_terminal");
    assert.equal(normalizeQuickCheckinMethod("card"), LEGACY_PAYMENT_METHOD_ALIASES.card, "misma normalización que el API");
    assert.equal(normalizeQuickCheckinMethod("  card "), "card_terminal");
    assert.equal(normalizeQuickCheckinMethod("cash"), "cash");
    assert.equal(normalizeQuickCheckinMethod("card_terminal"), "card_terminal");
    assert.equal(normalizeQuickCheckinMethod("bank_transfer"), "bank_transfer");
    assert.equal(normalizeQuickCheckinMethod("transfer"), LEGACY_PAYMENT_METHOD_ALIASES.transfer);
    for (const method of QUICK_CHECKIN_CAPTURED_METHODS) {
      assert.ok(PAYMENT_METHODS.includes(method), `${method} no está en PAYMENT_METHODS`);
      assert.ok(!PSP_PAYMENT_METHODS.includes(method), `${method} exige pasarela: no vale para un check-in cobrado`);
      assert.equal(PaymentMethodWireSchema.safeParse(method).success, true);
    }
  });

  it("todas las opciones del selector del drawer se normalizan a un método cobrable en la misma llamada", () => {
    for (const option of QUICK_CHECKIN_METHOD_OPTIONS) {
      const method = normalizeQuickCheckinMethod(option.value);
      assert.ok(QUICK_CHECKIN_CAPTURED_METHODS.includes(method), `${option.value} → ${method}`);
      assert.match(option.label, /^[A-ZÁÉÍÓÚ]/, "etiqueta en español con mayúscula inicial");
    }
    assert.ok(QUICK_CHECKIN_METHOD_OPTIONS.some((option) => option.value === "card"), "el valor de estado inicial del drawer sigue siendo válido");
  });

  it("rechaza métodos fuera del conjunto cobrable (pasarela, desconocidos, vacío)", () => {
    for (const method of ["card_online", "payment_link", "link", "online", "other", "bitcoin", "", "CARD"]) {
      assert.throws(
        () => buildCheckinPaymentBody({ ...BASE_INPUT, method }),
        (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "INVALID_METHOD" && /no admitido/.test(err.message),
        `método «${method}» debería rechazarse`
      );
    }
  });

  it("importe = saldo del folio («Cobrar saldo») o lo que falte del depósito («Cobrar depósito»); nunca el total; null si no hay nada que cobrar", () => {
    // Saldo: cargos − cobros capturados (UXDAY-A5: 178 − 50).
    assert.equal(resolveQuickCheckinAmount("balance", UXDAY_A5_FOLIO), 128);
    assert.equal(resolveQuickCheckinAmount("balance", { balanceDue: 0.1 + 0.2 }), 0.3);
    // Saldado (UXDAY-T1: 178 cobrados de 178) o saldo negativo (sobrepago): nada que cobrar.
    assert.equal(resolveQuickCheckinAmount("balance", { balanceDue: 0, paymentsTotal: 178 }), null);
    assert.equal(resolveQuickCheckinAmount("balance", { balanceDue: -20 }), null);
    assert.equal(resolveQuickCheckinAmount("balance", { balanceDue: Number.NaN }), null);
    // «Sin cobro» nunca cobra, haya saldo o no.
    assert.equal(resolveQuickCheckinAmount("none", UXDAY_A5_FOLIO), null);
    // Depósito de la política: lo que falte (depósito − cobros), acotado al saldo.
    assert.equal(resolveQuickCheckinAmount("deposit", { ...UXDAY_A5_FOLIO, depositAmount: 89 }), 39, "89 de depósito − 50 ya cobrados");
    assert.equal(resolveQuickCheckinAmount("deposit", { balanceDue: 128, paymentsTotal: 0, depositAmount: 89 }), 89);
    assert.equal(resolveQuickCheckinAmount("deposit", { balanceDue: 30, paymentsTotal: 0, depositAmount: 89 }), 30, "nunca más que el saldo");
    assert.equal(resolveQuickCheckinAmount("deposit", { balanceDue: 128, paymentsTotal: 50, depositAmount: 50 }), null, "depósito ya cubierto");
    for (const depositAmount of [undefined, null, 0, -5, Number.NaN]) {
      assert.equal(resolveQuickCheckinAmount("deposit", { ...UXDAY_A5_FOLIO, depositAmount }), null, `sin depósito (${depositAmount})`);
    }
    // El total de la reserva no es un dato de entrada: no puede colarse como importe.
    const input = { ...UXDAY_A5_FOLIO, totalAmount: 178 } as Record<string, number>;
    assert.equal(resolveQuickCheckinAmount("balance", input as unknown as Parameters<typeof resolveQuickCheckinAmount>[1]), 128);
  });

  it("modo por defecto: «Cobrar saldo» con saldo > 0, «Sin cobro» si está saldado; etiquetas sin garantías ficticias", () => {
    assert.equal(defaultQuickCheckinPaymentMode(128), "balance");
    assert.equal(defaultQuickCheckinPaymentMode(0.01), "balance");
    for (const balance of [0, -1, null, undefined, Number.NaN]) assert.equal(defaultQuickCheckinPaymentMode(balance), "none", `saldo ${balance}`);
    const modes: QuickCheckinPaymentMode[] = ["balance", "deposit", "none"];
    assert.deepEqual(Object.keys(QUICK_CHECKIN_PAYMENT_MODE_LABELS).sort(), [...modes].sort());
    assert.equal(QUICK_CHECKIN_PAYMENT_MODE_LABELS.balance, "Cobrar saldo");
    assert.equal(QUICK_CHECKIN_PAYMENT_MODE_LABELS.deposit, "Cobrar depósito");
    assert.equal(QUICK_CHECKIN_PAYMENT_MODE_LABELS.none, "Sin cobro");
    for (const label of Object.values(QUICK_CHECKIN_PAYMENT_MODE_LABELS)) assert.doesNotMatch(label, /preaut/i, "D8: sin la palabra «preautorizar»");
  });

  it("mantiene `clientRequestId` estable entre reintentos del mismo cobro y la cambia si cambia el cobro", () => {
    let seq = 0;
    const generate = () => `req-${++seq}`;
    const first = resolveQuickCheckinAttempt(null, { folioId: "folio_uxday_a5", amount: 128, currency: "EUR", method: "card" }, generate);
    assert.equal(first.clientRequestId, "req-1");
    // Reintento tras un fallo (misma huella): misma clave, no se genera otra.
    const retry = resolveQuickCheckinAttempt(first, { folioId: "folio_uxday_a5", amount: 128.0000001, currency: "eur", method: "card_terminal" }, generate);
    assert.equal(retry.clientRequestId, "req-1");
    assert.equal(seq, 1, "no se consume un uuid nuevo en el reintento");
    assert.equal(buildCheckinPaymentBody({ ...BASE_INPUT, clientRequestId: retry.clientRequestId }).clientRequestId, "req-1");
    // Otro importe (p. ej. el modo pasa de saldo a depósito) es otro cobro: otra clave.
    const otherAmount = resolveQuickCheckinAttempt(retry, { folioId: "folio_uxday_a5", amount: 39, currency: "EUR", method: "card" }, generate);
    assert.equal(otherAmount.clientRequestId, "req-2");
    // Otro método o folio también.
    const otherMethod = resolveQuickCheckinAttempt(otherAmount, { folioId: "folio_uxday_a5", amount: 39, currency: "EUR", method: "cash" }, generate);
    assert.equal(otherMethod.clientRequestId, "req-3");
    const otherFolio = resolveQuickCheckinAttempt(otherMethod, { folioId: "folio_2", amount: 39, currency: "EUR", method: "cash" }, generate);
    assert.equal(otherFolio.clientRequestId, "req-4");
    assert.equal(quickCheckinAttemptFingerprint({ folioId: "folio_uxday_a5", amount: 128, currency: "EUR", method: "card" }), "folio_uxday_a5|128.00|EUR|card_terminal");
  });

  it("importe a dos decimales y mayor que cero, moneda ISO en mayúsculas, clave de idempotencia obligatoria", () => {
    assert.equal(buildCheckinPaymentBody({ ...BASE_INPUT, amount: 12.300000000001 }).amount, 12.3);
    assert.equal(buildCheckinPaymentBody({ ...BASE_INPUT, amount: 0.1 + 0.2 }).amount, 0.3);
    assert.equal(ApplyPaymentSchema.safeParse(buildCheckinPaymentBody({ ...BASE_INPUT, amount: 0.1 + 0.2 })).success, true);
    assert.equal(buildCheckinPaymentBody({ ...BASE_INPUT, currency: " eur " }).currency, "EUR");
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.004]) {
      assert.throws(() => buildCheckinPaymentBody({ ...BASE_INPUT, amount }), (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "INVALID_AMOUNT");
    }
    assert.throws(() => buildCheckinPaymentBody({ ...BASE_INPUT, currency: "euros" }), (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "INVALID_CURRENCY");
    for (const clientRequestId of ["", "   ", "x".repeat(121)]) {
      assert.throws(() => buildCheckinPaymentBody({ ...BASE_INPUT, clientRequestId }), (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "MISSING_CLIENT_REQUEST_ID");
    }
  });

  it("aborta si el cobro no queda `captured`: un 202 `kind: payment_intent` o un estado distinto de captured", () => {
    assert.throws(
      () => assertCheckinPaymentCaptured({ kind: "payment_intent" }),
      (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "PAYMENT_NOT_CAPTURED" && err.message === QUICK_CHECKIN_PAYMENT_NOT_CONFIRMED_MESSAGE
    );
    assert.match(QUICK_CHECKIN_PAYMENT_NOT_CONFIRMED_MESSAGE, /el cobro no está confirmado/i);
    for (const status of ["pending", "failed", "refunded"]) {
      assert.throws(
        () => assertCheckinPaymentCaptured({ kind: "payment", status }),
        (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "PAYMENT_NOT_CAPTURED" && err.message.includes(status),
        `estado «${status}» debería abortar`
      );
    }
    assert.throws(() => assertCheckinPaymentCaptured(null as unknown as { kind: string }), (err: unknown) => err instanceof QuickCheckinPaymentError && err.code === "PAYMENT_NOT_CAPTURED");
    // Respuesta real del API (201 / 200 en réplica idempotente): sigue adelante.
    assert.doesNotThrow(() => assertCheckinPaymentCaptured({ kind: "payment", status: "captured", idempotent: false }));
    assert.doesNotThrow(() => assertCheckinPaymentCaptured({ kind: "payment", status: "captured", idempotent: true }));
    assert.doesNotThrow(() => assertCheckinPaymentCaptured({ kind: "payment" }));
  });
});
