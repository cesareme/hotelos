// PSP adapter contract of the payments module (finanzas · lote
// facturación-cobros, 2026-09-15).
//
// A PSP adapter never invents money: `createPaymentLink` returns where the
// cardholder must go (hosted page), `capture` / `refund` talk to the
// provider only when it is configured (env credentials), and
// `verifyWebhook` is the ONLY path that turns a PaymentIntent into a
// captured Payment. Without configuration every operation answers
// `{ configured: false }` and the service maps it to 409 PSP_NOT_CONFIGURED.

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

export interface PspAdapter {
  readonly provider: PspProviderCode;
  status(): PspAdapterStatus;
  createPaymentLink(input: PspPaymentLinkInput): Promise<PspPaymentLinkResult>;
  capture(providerReference: string): Promise<PspCaptureResult>;
  refund(input: PspRefundInput): Promise<PspRefundResult>;
  verifyWebhook(input: PspWebhookInput): PspWebhookVerification;
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
