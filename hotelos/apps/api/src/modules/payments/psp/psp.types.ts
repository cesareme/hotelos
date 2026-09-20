// PSP adapter contract of the payments module (finanzas · lote
// facturación-cobros, 2026-09-15; preautorización Tanda CHK · lote W5-A).
//
// A PSP adapter never invents money: `createPaymentLink` returns where the
// cardholder must go (hosted page), `capture` / `refund` talk to the
// provider only when it is configured (env credentials), and
// `verifyWebhook` is the ONLY path that turns a PaymentIntent into a
// captured Payment. Without configuration every operation answers
// `{ configured: false }` and the service maps it to 409 PSP_NOT_CONFIGURED.
//
// Preautorización (garantía) — CHECKIN-AUTOMATIZADO-IA §1.7, §2.4, §9 L8,
// D3: `authorize` / `captureAuthorization` / `releaseAuthorization` /
// `tokenizeFromReference` son OPCIONALES en la interfaz (un adaptador de
// prueba que solo hace enlaces sigue siendo válido) y el servicio del
// check-in solo los usa si `pspSupportsAuthorization(adapter)`. Stripe:
// capture_method=manual + request_extended_authorization=if_available
// (hasta 30 días en hostelería); Redsys: DS_MERCHANT_TRANSACTIONTYPE 1
// (preautorización) / 2 (confirmación) / 9 (anulación). Sin credenciales
// `authorize` responde `{ status: "failed", error }` con `configured:false`
// en el status del adaptador: nunca se inventa una autorización. Las
// respuestas deterministas de demo solo existen con el transporte sandbox
// explícito de cada adaptador (createStripeSandbox / createRedsysSandbox),
// nunca por defecto. `tokenizeFromReference` devuelve un token del PSP
// (pm_… / Ds_Merchant_Identifier), marca, últimos 4 y caducidad; jamás un PAN
// (`looksLikePan` lo comprueba en las dos implementaciones).

import type { PspProviderCode } from "../../../../../../packages/shared/src/payments-types.js";

export type PspMode = "test" | "live";

export type PspPaymentLinkInput = {
  /** PaymentIntent.id — travels to the provider as the client reference / merchant data. */
  intentId: string;
  /** Decimal string with 2 decimals ("125.40"). */
  amount: string;
  currency: string;
  description: string;
  /** Short reference shown to the customer (folio / reservation code). */
  reference: string;
  returnUrl: string;
  cancelUrl: string;
  /** Provider notification (webhook) URL. */
  notifyUrl: string;
  customerEmail?: string | null;
};

export type PspPaymentLinkResult = {
  providerReference: string;
  /** GET link (Stripe Checkout) or POST form (Redsys SIS). */
  redirect: { method: "GET"; url: string } | { method: "POST"; url: string; fields: Record<string, string> };
  expiresAt: string | null;
};

export type PspCaptureResult = { status: "captured" | "pending" | "failed"; providerReference: string; capturedAt: string | null; error: string | null };

export type PspRefundInput = {
  providerReference: string;
  /** Decimal string; the full amount when the whole payment is refunded. */
  amount: string;
  currency: string;
  reason: string;
  /** Idempotency key sent to the provider (Stripe Idempotency-Key / Redsys DS_MERCHANT_ORDER derivative). */
  idempotencyKey: string;
};

export type PspRefundResult = { status: "refunded" | "pending" | "failed"; providerReference: string; error: string | null };

export type PspWebhookEvent =
  | { type: "payment.captured"; intentId: string | null; providerReference: string; amount: string | null; currency: string | null; raw: unknown }
  | { type: "payment.failed"; intentId: string | null; providerReference: string; reason: string; raw: unknown }
  | { type: "refund.completed"; providerReference: string; amount: string | null; raw: unknown }
  | { type: "ignored"; reason: string; raw: unknown };

export type PspWebhookInput = {
  /** Original request bytes (utf8): the signature is computed over them. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  contentType: string | null;
};

export type PspWebhookVerification = { ok: true; event: PspWebhookEvent } | { ok: false; reason: string };

export type PspAdapterStatus = { configured: boolean; provider: PspProviderCode; mode: PspMode | null; webhookSecretConfigured: boolean; message: string };

// ── Preautorización (Tanda CHK · W5-A) ───────────────────────────────────────

/** Días máximos de una autorización extendida en hostelería (Stripe extended authorization / Redsys preautorización): 30. */
export const PSP_AUTHORIZATION_MAX_DAYS = 30;
/** Ventana mínima que se pide al proveedor (una autorización online estándar dura 7 días). */
export const PSP_AUTHORIZATION_MIN_DAYS = 7;

export type PspAuthorizationInput = {
  /** Folio garantizado (viaja como referencia/metadata del proveedor). */
  folioId: string;
  /** PaymentIntent.id propio (client_reference_id / DS_MERCHANT_MERCHANTDATA de la variante alojada). */
  intentId?: string | null;
  /** Decimal string with 2 decimals ("125.40"). */
  amount: string;
  currency: string;
  /** Código de reserva mostrado al titular y al proveedor. */
  reservationCode: string;
  /** Página de vuelta cuando la autorización exige una página alojada (sin token en fichero). */
  returnUrl?: string | null;
  cancelUrl?: string | null;
  /** Notificación del proveedor (webhook) para la variante alojada. */
  notifyUrl?: string | null;
  /** Días que la autorización debe seguir viva (se acota a [7, 30]). */
  captureWindowDays: number;
  /**
   * Token del PSP ya guardado (PaymentToken.tokenRef: Stripe pm_… / Redsys
   * Ds_Merchant_Identifier): autoriza sin página alojada (off-session, pago por
   * referencia). Sin él el adaptador devuelve `pending` + `redirect`.
   */
  paymentMethodRef?: string | null;
  customerEmail?: string | null;
  description?: string | null;
  /** Clave de idempotencia (misma clave → misma autorización en el proveedor). */
  idempotencyKey?: string | null;
};

export type PspAuthorizationStatus = "authorized" | "pending" | "failed";

/** Tarjeta tokenizada por el PSP: referencia reutilizable + datos del Anexo I A.4 (marca, últimos 4, caducidad). NUNCA el PAN. */
export type PspCardToken = { tokenRef: string; last4: string; brand: string; expiryMonth: number; expiryYear: number };

export type PspAuthorizationResult = {
  status: PspAuthorizationStatus;
  /** PaymentIntent (pi_…) / Checkout Session (cs_…) de Stripe o DS_MERCHANT_ORDER de Redsys. */
  providerReference: string;
  /** Cuándo deja de poder capturarse (null si el proveedor no lo dice o la autorización no existe). */
  expiresAt: string | null;
  error: string | null;
  /** Página alojada que el titular debe completar cuando `status` es `pending` (sin token guardado). */
  redirect?: PspPaymentLinkResult["redirect"] | null;
  /** Tarjeta tokenizada si el proveedor la devolvió en la propia autorización (Redsys REST); si no, `tokenizeFromReference`. */
  card?: PspCardToken | null;
};

export type PspAuthorizationReleaseResult = { status: "released" | "pending" | "failed"; providerReference: string; error: string | null };

export interface PspAdapter {
  readonly provider: PspProviderCode;
  status(): PspAdapterStatus;
  createPaymentLink(input: PspPaymentLinkInput): Promise<PspPaymentLinkResult>;
  capture(providerReference: string): Promise<PspCaptureResult>;
  refund(input: PspRefundInput): Promise<PspRefundResult>;
  verifyWebhook(input: PspWebhookInput): PspWebhookVerification;
  /** Preautorización (garantía) sin cobro; `failed` + `error` sin credenciales. */
  authorize?(input: PspAuthorizationInput): Promise<PspAuthorizationResult>;
  /** Confirma (captura) una autorización viva, total o parcial (`amount` decimal string). */
  captureAuthorization?(providerReference: string, amount?: string | null): Promise<PspCaptureResult>;
  /** Anula la autorización y libera el importe retenido (`amount`: importe original cuando el proveedor lo exige, Redsys). */
  releaseAuthorization?(providerReference: string, amount?: string | null): Promise<PspAuthorizationReleaseResult>;
  /** Token reutilizable + marca/últimos 4/caducidad de la tarjeta de una autorización; null si el proveedor no lo da. */
  tokenizeFromReference?(providerReference: string): Promise<PspCardToken | null>;
}

/** Adaptador con la extensión de preautorización completa. */
export type PspAuthorizingAdapter = PspAdapter & Required<Pick<PspAdapter, "authorize" | "captureAuthorization" | "releaseAuthorization" | "tokenizeFromReference">>;

/** True cuando el adaptador implementa la extensión de preautorización Y tiene credenciales. Pure. */
export function pspSupportsAuthorization(adapter: PspAdapter | null | undefined): adapter is PspAuthorizingAdapter {
  if (!adapter) return false;
  return (
    typeof adapter.authorize === "function" &&
    typeof adapter.captureAuthorization === "function" &&
    typeof adapter.releaseAuthorization === "function" &&
    typeof adapter.tokenizeFromReference === "function" &&
    adapter.status().configured
  );
}

/** Acota la ventana de captura pedida a [PSP_AUTHORIZATION_MIN_DAYS, PSP_AUTHORIZATION_MAX_DAYS]. Pure. */
export function clampCaptureWindowDays(days: number): number {
  if (!Number.isFinite(days)) return PSP_AUTHORIZATION_MIN_DAYS;
  return Math.min(PSP_AUTHORIZATION_MAX_DAYS, Math.max(PSP_AUTHORIZATION_MIN_DAYS, Math.ceil(days)));
}

/**
 * True cuando un valor parece un número de tarjeta completo (12-19 dígitos,
 * con o sin espacios/guiones). Los adaptadores y el servicio del check-in lo
 * usan para no persistir jamás un PAN como token, identificador o últimos 4.
 * Misma regla que POST /payment-tokens (server.ts). Pure.
 */
export function looksLikePan(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^[0-9 -]{12,23}$/.test(trimmed) && trimmed.replace(/\D/g, "").length >= 12;
}

/** Resultado honesto de `authorize` sin credenciales: nunca se inventa una autorización. Pure. */
export function authorizationNotConfigured(provider: PspProviderCode, message: string): PspAuthorizationResult {
  return { status: "failed", providerReference: "", expiresAt: null, error: `${provider === "stripe" ? "Stripe" : "Redsys"} no está configurado: ${message}`, redirect: null, card: null };
}

/** Thrown by an adapter operation that needs credentials the environment does not carry. */
export class PspNotConfiguredError extends Error {
  constructor(
    readonly provider: PspProviderCode | null,
    message: string
  ) {
    super(message);
    this.name = "PspNotConfiguredError";
  }
}

/** First header value, lower-case lookup. Pure. */
export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}
