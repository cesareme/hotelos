// Quick check-in · cuerpo del cobro al llegar (Tanda UX-1 · lote U0b · F1/F19).
//
// Módulo PURO (sin React, sin red, sin import.meta), gemelo de
// quickCheckoutPayment.ts: lo importa QuickCheckInDrawer y lo ejecuta
// `node --test` (__tests__/quick-checkin-payment.test.mts).
//
// Por qué existe (F1, reproducido en runtime el 2026-09-19 con UXDAY-A5, saldo
// 128 €): el drawer enviaba a POST /folios/:id/payments el cuerpo
// {amount: 178, currency, method: "card", status: "pending"} —el TOTAL de la
// reserva y un `status` que el cliente no decide— y `ApplyPaymentSchema`
// (apps/api/src/schemas/folios.schemas.ts, `.strict()`) respondía 400
// «Validation failed (body): Unrecognized key(s) in object: 'status'», así que
// el check-in abortaba siempre que hubiera saldo con el modo por defecto. Aquí
// el cuerpo lleva exactamente {amount, currency, method, clientRequestId}: el
// estado del cobro lo fija el API.
//
// Importe (F19, D8): nunca el total de la reserva. «Cobrar saldo» cobra el
// saldo del folio (cargos − cobros capturados); «Cobrar depósito» cobra lo que
// falte del depósito de la política de la reserva (`depositAmount`) sin pasar
// del saldo; «Sin cobro» no registra nada. El contrato PSP no tiene `authorize`
// (D8): el drawer no ofrece una garantía que no existe ni registra cobros
// `pending` por el total.
//
// Método: solo los que el API registra como cobrados en la misma llamada (201
// `kind: "payment"`): cash · card_terminal · bank_transfer. card_online y
// payment_link responden 202 `kind: "payment_intent"` (pasarela) y un check-in
// «cobrado» no puede apoyarse en un intento pendiente. `card` (valor de estado
// del selector) se normaliza a card_terminal sin depender del alias legacy.
//
// Idempotencia (pmsCommerceApi.ts «cobros y devoluciones»): la clave
// `clientRequestId` se genera una vez por intento y se REUTILIZA mientras el
// cobro sea el mismo (folio + importe + moneda + método); si cambia alguno, es
// otro cobro y lleva otra clave.

import type { PaymentMethodCode } from "@hotelos/shared";

/** Métodos que el API registra como cobrados sin pasarela (201 `kind: "payment"`). */
export const QUICK_CHECKIN_CAPTURED_METHODS = ["cash", "card_terminal", "bank_transfer"] as const satisfies readonly PaymentMethodCode[];
export type QuickCheckinCapturedMethod = (typeof QUICK_CHECKIN_CAPTURED_METHODS)[number];

/** Valores del selector del drawer (`card` se conserva como valor de estado; el cuerpo lo normaliza). */
export type QuickCheckinMethodOption = "card" | "cash" | "bank_transfer";

export const QUICK_CHECKIN_METHOD_OPTIONS: Array<{ value: QuickCheckinMethodOption; label: string }> = [
  { value: "card", label: "Tarjeta (datáfono)" },
  { value: "cash", label: "Efectivo" },
  { value: "bank_transfer", label: "Transferencia" }
];

/** Modos de cobro del check-in (D8): saldo, depósito de la política o nada; ninguna garantía ficticia. */
export type QuickCheckinPaymentMode = "none" | "balance" | "deposit";

export const QUICK_CHECKIN_PAYMENT_MODE_LABELS: Readonly<Record<QuickCheckinPaymentMode, string>> = Object.freeze({
  balance: "Cobrar saldo",
  deposit: "Cobrar depósito",
  none: "Sin cobro"
});

/** Alias que el drawer (o un estado antiguo) puede tener guardados → código canónico. */
const METHOD_ALIASES: Readonly<Record<string, QuickCheckinCapturedMethod>> = Object.freeze({
  card: "card_terminal",
  transfer: "bank_transfer"
});

/** Claves que puede llevar el cuerpo; ninguna otra (ApplyPaymentSchema es strict). */
export const QUICK_CHECKIN_PAYMENT_BODY_KEYS = ["amount", "currency", "method", "clientRequestId"] as const;

export type QuickCheckinPaymentBody = {
  amount: number;
  currency: string;
  method: QuickCheckinCapturedMethod;
  clientRequestId: string;
};

export type QuickCheckinPaymentErrorCode = "INVALID_METHOD" | "INVALID_AMOUNT" | "INVALID_CURRENCY" | "MISSING_CLIENT_REQUEST_ID" | "PAYMENT_NOT_CAPTURED";

/** Error tipado del cuerpo o del resultado del cobro; el drawer lo muestra y aborta el check-in. */
export class QuickCheckinPaymentError extends Error {
  readonly code: QuickCheckinPaymentErrorCode;

  constructor(code: QuickCheckinPaymentErrorCode, message: string) {
    super(message);
    this.name = "QuickCheckinPaymentError";
    this.code = code;
  }
}

/** Mensaje del aborto cuando el API devuelve un intento de pasarela en lugar de un cobro. */
export const QUICK_CHECKIN_PAYMENT_NOT_CONFIRMED_MESSAGE =
  "El cobro no está confirmado: el API ha devuelto un intento de pago pendiente de la pasarela en lugar de un cobro registrado.";

const CLIENT_REQUEST_ID_MAX_LENGTH = 120;

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** `card` → card_terminal, `transfer` → bank_transfer; el resto solo si ya es un método cobrable. */
export function normalizeQuickCheckinMethod(method: string): QuickCheckinCapturedMethod {
  const raw = typeof method === "string" ? method.trim() : "";
  const candidate = METHOD_ALIASES[raw] ?? raw;
  const match = QUICK_CHECKIN_CAPTURED_METHODS.find((code) => code === candidate);
  if (!match) {
    throw new QuickCheckinPaymentError(
      "INVALID_METHOD",
      `Método de cobro no admitido en el check-in rápido: «${raw || "vacío"}». Usa efectivo, tarjeta (datáfono) o transferencia; el cobro en línea se registra desde Facturación cuando la pasarela lo confirma.`
    );
  }
  return match;
}

function normalizeAmount(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new QuickCheckinPaymentError("INVALID_AMOUNT", "El importe a cobrar no es un número válido.");
  }
  const cents = roundCents(amount);
  if (cents <= 0) {
    throw new QuickCheckinPaymentError("INVALID_AMOUNT", "El importe a cobrar debe ser mayor que cero.");
  }
  return cents;
}

function normalizeCurrency(currency: string): string {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new QuickCheckinPaymentError("INVALID_CURRENCY", `Moneda no válida para el cobro: «${currency}». Se espera un código ISO de tres letras.`);
  }
  return code;
}

function normalizeClientRequestId(clientRequestId: string): string {
  const key = typeof clientRequestId === "string" ? clientRequestId.trim() : "";
  if (!key || key.length > CLIENT_REQUEST_ID_MAX_LENGTH) {
    throw new QuickCheckinPaymentError("MISSING_CLIENT_REQUEST_ID", "Falta la clave de idempotencia del intento de cobro (clientRequestId).");
  }
  return key;
}

// ---------------------------------------------------------------------------
// Importe: saldo del folio o depósito de la política, nunca el total (F19)
// ---------------------------------------------------------------------------

export type QuickCheckinAmountInput = {
  /** Saldo del folio (`balanceDue` de GET /reservations/:id/folio): cargos − cobros capturados. */
  balanceDue: number;
  /** Cobros capturados hasta ahora (`paymentsTotal` del folio); descuenta lo ya pagado del depósito. */
  paymentsTotal?: number | null;
  /** Depósito de la política de la reserva (`depositAmount`); ausente = sin depósito. */
  depositAmount?: number | null;
};

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? roundCents(value) : null;
}

/**
 * Importe a cobrar según el modo, o `null` si no hay nada que cobrar:
 *  · "none" → null;
 *  · "balance" → el saldo del folio (null si está saldado);
 *  · "deposit" → lo que falte del depósito (depósito − cobros), acotado al saldo
 *    (null si la reserva no tiene depósito o ya está cubierto).
 * Nunca usa el total de la reserva: ignoraría los cobros ya capturados.
 */
export function resolveQuickCheckinAmount(mode: QuickCheckinPaymentMode, input: QuickCheckinAmountInput): number | null {
  if (mode === "none") return null;
  const balance = finitePositive(input.balanceDue);
  if (balance === null) return null;
  if (mode === "balance") return balance;
  const deposit = finitePositive(input.depositAmount);
  if (deposit === null) return null;
  const paid = typeof input.paymentsTotal === "number" && Number.isFinite(input.paymentsTotal) && input.paymentsTotal > 0 ? input.paymentsTotal : 0;
  const outstanding = roundCents(Math.min(deposit - paid, balance));
  return outstanding > 0 ? outstanding : null;
}

/** Modo por defecto del drawer al cargar el folio: cobrar el saldo si lo hay; si está saldado, sin cobro. */
export function defaultQuickCheckinPaymentMode(balanceDue: number | null | undefined): QuickCheckinPaymentMode {
  return finitePositive(balanceDue) !== null ? "balance" : "none";
}

// ---------------------------------------------------------------------------
// Cuerpo de POST /folios/:id/payments
// ---------------------------------------------------------------------------

export type QuickCheckinPaymentInput = {
  amount: number;
  currency: string;
  method: string;
  clientRequestId: string;
};

/**
 * Cuerpo de POST /folios/:id/payments para el check-in rápido: exactamente
 * {amount, currency, method, clientRequestId}. Nunca `status` (lo fija el API).
 */
export function buildCheckinPaymentBody(input: QuickCheckinPaymentInput): QuickCheckinPaymentBody {
  return {
    amount: normalizeAmount(input.amount),
    currency: normalizeCurrency(input.currency),
    method: normalizeQuickCheckinMethod(input.method),
    clientRequestId: normalizeClientRequestId(input.clientRequestId)
  };
}

// ---------------------------------------------------------------------------
// Intento de cobro: una clave por cobro, reutilizada en los reintentos
// ---------------------------------------------------------------------------

export type QuickCheckinAttemptInput = {
  folioId: string;
  amount: number;
  currency: string;
  method: string;
};

export type QuickCheckinPaymentAttempt = {
  /** Identifica el cobro (folio + importe + moneda + método normalizados). */
  fingerprint: string;
  /** Clave de idempotencia enviada al API; la misma en cada reintento del mismo cobro. */
  clientRequestId: string;
};

/** Huella del cobro: dos intentos con la misma huella son el MISMO cobro y comparten clave. */
export function quickCheckinAttemptFingerprint(input: QuickCheckinAttemptInput): string {
  return [input.folioId, normalizeAmount(input.amount).toFixed(2), normalizeCurrency(input.currency), normalizeQuickCheckinMethod(input.method)].join("|");
}

/**
 * Devuelve el intento a usar: el anterior si el cobro no ha cambiado (mismo
 * folio, importe, moneda y método → misma `clientRequestId`, el API repite el
 * cobro en vez de duplicarlo), o uno nuevo con otra clave si es otro cobro.
 */
export function resolveQuickCheckinAttempt(
  previous: QuickCheckinPaymentAttempt | null,
  input: QuickCheckinAttemptInput,
  generateId: () => string
): QuickCheckinPaymentAttempt {
  const fingerprint = quickCheckinAttemptFingerprint(input);
  if (previous && previous.fingerprint === fingerprint && previous.clientRequestId) {
    return previous;
  }
  return { fingerprint, clientRequestId: normalizeClientRequestId(generateId()) };
}

// ---------------------------------------------------------------------------
// Memoria del intento entre aperturas del cajón (corrector CHK · REV3-03)
// ---------------------------------------------------------------------------

/**
 * El intento de cobro vivía solo en un `useRef` del cajón abierto: si el cobro
 * se registró y el check-in completo falló (409 firmas), cerrar y reabrir el
 * cajón olvidaba la clave de idempotencia y un nuevo «Cobrar y hacer check-in»
 * cobraba OTRA vez. El intento se guarda por reserva en sessionStorage (misma
 * pestaña; nunca el importe ni datos de tarjeta: solo huella + clave).
 */
export const QUICK_CHECKIN_ATTEMPT_STORAGE_PREFIX = "hotelos-checkin-payment-attempt:";

type AttemptStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function attemptStore(store?: AttemptStore | null): AttemptStore | null {
  if (store !== undefined) return store;
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readStoredCheckinAttempt(reservationId: string, store?: AttemptStore | null): QuickCheckinPaymentAttempt | null {
  const target = attemptStore(store);
  if (!target) return null;
  try {
    const raw = target.getItem(`${QUICK_CHECKIN_ATTEMPT_STORAGE_PREFIX}${reservationId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuickCheckinPaymentAttempt>;
    return typeof parsed.fingerprint === "string" && typeof parsed.clientRequestId === "string" && parsed.clientRequestId ? { fingerprint: parsed.fingerprint, clientRequestId: parsed.clientRequestId } : null;
  } catch {
    return null;
  }
}

/** Guarda el intento (o lo borra con null, tras un check-in hecho). Nunca lanza. */
export function storeCheckinAttempt(reservationId: string, attempt: QuickCheckinPaymentAttempt | null, store?: AttemptStore | null): void {
  const target = attemptStore(store);
  if (!target) return;
  try {
    const key = `${QUICK_CHECKIN_ATTEMPT_STORAGE_PREFIX}${reservationId}`;
    if (attempt) target.setItem(key, JSON.stringify({ fingerprint: attempt.fingerprint, clientRequestId: attempt.clientRequestId }));
    else target.removeItem(key);
  } catch {
    // Almacenamiento no disponible (modo privado, cuota): el useRef del cajón sigue valiendo.
  }
}

// ---------------------------------------------------------------------------
// Resultado: solo un cobro registrado permite seguir con el check-in
// ---------------------------------------------------------------------------

/**
 * El check-in con cobro exige un cobro registrado: `kind: "payment"` con estado
 * capturado. Un 202 `kind: "payment_intent"` (card_online / payment_link) o un
 * cobro no capturado abortan con mensaje claro: el check-in NO se hace.
 */
export function assertCheckinPaymentCaptured<T extends { kind: string; status?: string }>(result: T): asserts result is T & { kind: "payment" } {
  if (!result || typeof result !== "object" || result.kind !== "payment") {
    throw new QuickCheckinPaymentError("PAYMENT_NOT_CAPTURED", QUICK_CHECKIN_PAYMENT_NOT_CONFIRMED_MESSAGE);
  }
  if (typeof result.status === "string" && result.status !== "captured") {
    throw new QuickCheckinPaymentError(
      "PAYMENT_NOT_CAPTURED",
      `El cobro no está confirmado: el API lo ha registrado con estado «${result.status}», no como capturado.`
    );
  }
}
