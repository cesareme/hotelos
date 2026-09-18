// Quick check-out · cuerpo del cobro del saldo (Tanda L3 · lote F2).
//
// Módulo PURO (sin React, sin red, sin import.meta): lo importa
// QuickCheckOutDrawer y lo ejecuta `node --test`
// (__tests__/quick-checkout-payment.test.mts).
//
// Por qué existe: `ApplyPaymentSchema` (apps/api/src/schemas/folios.schemas.ts,
// `.strict()`) solo admite {folioId, amount, currency, method, reference,
// pspReference, clientRequestId, invoiceId, returnUrl}. El drawer enviaba además
// `status: "captured"` → 400 «Campo no admitido en el cuerpo de la petición» y
// el check-out abortaba con el folio abierto. Aquí se construye el cuerpo con
// las claves admitidas y nada más: el estado del cobro lo decide el API.
//
// Método: el selector del drawer ofrece `card` · `cash` · `bank_transfer`. El
// API todavía acepta el alias legacy `card` (LEGACY_PAYMENT_METHOD_ALIASES →
// card_terminal), pero el cuerpo se envía ya normalizado al código canónico
// para no depender de ese alias. Solo se admiten métodos que el API registra
// como cobrados en la misma llamada (201 `kind: "payment"`): card_online y
// payment_link responden 202 `kind: "payment_intent"` (pasarela) y un
// check-out «cobrado y cerrado» no puede apoyarse en un intento pendiente.
//
// Idempotencia (pmsCommerceApi.ts «cobros y devoluciones»): POST
// /folios/:id/payments es idempotente por `clientRequestId` (única por folio):
// la misma petición repite el mismo cobro (200 `idempotent: true`); la misma
// clave con datos distintos es 409 IDEMPOTENCY_CONFLICT. Por eso la clave se
// genera una vez por intento y se REUTILIZA mientras el cobro sea el mismo
// (folio + importe + moneda + método); si cambia alguno, es otro cobro y lleva
// otra clave.

import type { PaymentMethodCode } from "@hotelos/shared";

/** Métodos que el API registra como cobrados sin pasarela (201 `kind: "payment"`). */
export const QUICK_CHECKOUT_CAPTURED_METHODS = ["cash", "card_terminal", "bank_transfer"] as const satisfies readonly PaymentMethodCode[];
export type QuickCheckoutCapturedMethod = (typeof QUICK_CHECKOUT_CAPTURED_METHODS)[number];

/** Valores del selector del drawer (`card` se conserva como valor de estado; el cuerpo lo normaliza). */
export type QuickCheckoutMethodOption = "card" | "cash" | "bank_transfer";

export const QUICK_CHECKOUT_METHOD_OPTIONS: Array<{ value: QuickCheckoutMethodOption; label: string }> = [
  { value: "card", label: "Tarjeta (datáfono)" },
  { value: "cash", label: "Efectivo" },
  { value: "bank_transfer", label: "Transferencia" }
];

/** Alias que el drawer (o un estado antiguo) puede tener guardados → código canónico. */
const METHOD_ALIASES: Readonly<Record<string, QuickCheckoutCapturedMethod>> = Object.freeze({
  card: "card_terminal",
  transfer: "bank_transfer"
});

/** Claves que puede llevar el cuerpo; ninguna otra (ApplyPaymentSchema es strict). */
export const QUICK_CHECKOUT_PAYMENT_BODY_KEYS = ["amount", "currency", "method", "clientRequestId"] as const;

export type QuickCheckoutPaymentBody = {
  amount: number;
  currency: string;
  method: QuickCheckoutCapturedMethod;
  clientRequestId: string;
};

export type QuickCheckoutPaymentErrorCode = "INVALID_METHOD" | "INVALID_AMOUNT" | "INVALID_CURRENCY" | "MISSING_CLIENT_REQUEST_ID" | "PAYMENT_NOT_CAPTURED";

/** Error tipado del cuerpo o del resultado del cobro; el drawer lo muestra y aborta el check-out. */
export class QuickCheckoutPaymentError extends Error {
  readonly code: QuickCheckoutPaymentErrorCode;

  constructor(code: QuickCheckoutPaymentErrorCode, message: string) {
    super(message);
    this.name = "QuickCheckoutPaymentError";
    this.code = code;
  }
}

/** Mensaje del aborto cuando el API devuelve un intento de pasarela en lugar de un cobro. */
export const QUICK_CHECKOUT_PAYMENT_NOT_CONFIRMED_MESSAGE =
  "El cobro no está confirmado: el API ha devuelto un intento de pago pendiente de la pasarela en lugar de un cobro registrado.";

const CLIENT_REQUEST_ID_MAX_LENGTH = 120;

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** `card` → card_terminal, `transfer` → bank_transfer; el resto solo si ya es un método cobrable. */
export function normalizeQuickCheckoutMethod(method: string): QuickCheckoutCapturedMethod {
  const raw = typeof method === "string" ? method.trim() : "";
  const candidate = METHOD_ALIASES[raw] ?? raw;
  const match = QUICK_CHECKOUT_CAPTURED_METHODS.find((code) => code === candidate);
  if (!match) {
    throw new QuickCheckoutPaymentError(
      "INVALID_METHOD",
      `Método de cobro no admitido en el check-out rápido: «${raw || "vacío"}». Usa efectivo, tarjeta (datáfono) o transferencia; el cobro en línea se registra desde Facturación cuando la pasarela lo confirma.`
    );
  }
  return match;
}

function normalizeAmount(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new QuickCheckoutPaymentError("INVALID_AMOUNT", "El importe a cobrar no es un número válido.");
  }
  const cents = roundCents(amount);
  if (cents <= 0) {
    throw new QuickCheckoutPaymentError("INVALID_AMOUNT", "El importe a cobrar debe ser mayor que cero.");
  }
  return cents;
}

function normalizeCurrency(currency: string): string {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new QuickCheckoutPaymentError("INVALID_CURRENCY", `Moneda no válida para el cobro: «${currency}». Se espera un código ISO de tres letras.`);
  }
  return code;
}

function normalizeClientRequestId(clientRequestId: string): string {
  const key = typeof clientRequestId === "string" ? clientRequestId.trim() : "";
  if (!key || key.length > CLIENT_REQUEST_ID_MAX_LENGTH) {
    throw new QuickCheckoutPaymentError("MISSING_CLIENT_REQUEST_ID", "Falta la clave de idempotencia del intento de cobro (clientRequestId).");
  }
  return key;
}

export type QuickCheckoutPaymentInput = {
  amount: number;
  currency: string;
  method: string;
  clientRequestId: string;
};

/**
 * Cuerpo de POST /folios/:id/payments para el check-out rápido: exactamente
 * {amount, currency, method, clientRequestId}. Nunca `status` (lo fija el API).
 */
export function buildQuickCheckoutPaymentBody(input: QuickCheckoutPaymentInput): QuickCheckoutPaymentBody {
  return {
    amount: normalizeAmount(input.amount),
    currency: normalizeCurrency(input.currency),
    method: normalizeQuickCheckoutMethod(input.method),
    clientRequestId: normalizeClientRequestId(input.clientRequestId)
  };
}

// ---------------------------------------------------------------------------
// Intento de cobro: una clave por cobro, reutilizada en los reintentos
// ---------------------------------------------------------------------------

export type QuickCheckoutAttemptInput = {
  folioId: string;
  amount: number;
  currency: string;
  method: string;
};

export type QuickCheckoutPaymentAttempt = {
  /** Identifica el cobro (folio + importe + moneda + método normalizados). */
  fingerprint: string;
  /** Clave de idempotencia enviada al API; la misma en cada reintento del mismo cobro. */
  clientRequestId: string;
};

/** Huella del cobro: dos intentos con la misma huella son el MISMO cobro y comparten clave. */
export function quickCheckoutAttemptFingerprint(input: QuickCheckoutAttemptInput): string {
  return [input.folioId, normalizeAmount(input.amount).toFixed(2), normalizeCurrency(input.currency), normalizeQuickCheckoutMethod(input.method)].join("|");
}

/**
 * Devuelve el intento a usar: el anterior si el cobro no ha cambiado (mismo
 * folio, importe, moneda y método → misma `clientRequestId`, el API repite el
 * cobro en vez de duplicarlo), o uno nuevo con otra clave si es otro cobro.
 */
export function resolveQuickCheckoutAttempt(
  previous: QuickCheckoutPaymentAttempt | null,
  input: QuickCheckoutAttemptInput,
  generateId: () => string
): QuickCheckoutPaymentAttempt {
  const fingerprint = quickCheckoutAttemptFingerprint(input);
  if (previous && previous.fingerprint === fingerprint && previous.clientRequestId) {
    return previous;
  }
  return { fingerprint, clientRequestId: normalizeClientRequestId(generateId()) };
}

// ---------------------------------------------------------------------------
// Resultado: solo un cobro registrado permite cerrar
// ---------------------------------------------------------------------------

/**
 * El check-out «cobrar y cerrar» exige un cobro registrado: `kind: "payment"`
 * con estado capturado. Un 202 `kind: "payment_intent"` (card_online /
 * payment_link) o un cobro no capturado abortan con mensaje claro.
 */
export function assertQuickCheckoutPaymentCaptured<T extends { kind: string; status?: string }>(result: T): asserts result is T & { kind: "payment" } {
  if (!result || typeof result !== "object" || result.kind !== "payment") {
    throw new QuickCheckoutPaymentError("PAYMENT_NOT_CAPTURED", QUICK_CHECKOUT_PAYMENT_NOT_CONFIRMED_MESSAGE);
  }
  if (typeof result.status === "string" && result.status !== "captured") {
    throw new QuickCheckoutPaymentError(
      "PAYMENT_NOT_CAPTURED",
      `El cobro no está confirmado: el API lo ha registrado con estado «${result.status}», no como capturado.`
    );
  }
}
