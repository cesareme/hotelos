// Stripe adapter (Checkout Sessions, hosted page) — finanzas · lote
// facturación-cobros, 2026-09-15. Real HTTPS calls to api.stripe.com happen
// ONLY when STRIPE_SECRET_KEY is set (sk_test_… = test mode, sk_live_… =
// live); every call carries an Idempotency-Key so a retry never duplicates a
// session or a refund. Webhooks are verified with STRIPE_WEBHOOK_SECRET
// (Stripe-Signature v1, HMAC-SHA256 over "<t>.<raw body>", 5-minute
// tolerance). Without the secret key the adapter reports `configured:
// false` and the service answers 409 PSP_NOT_CONFIGURED.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { headerValue, PspNotConfiguredError, type PspAdapter, type PspAdapterStatus, type PspCaptureResult, type PspMode, type PspPaymentLinkInput, type PspPaymentLinkResult, type PspRefundInput, type PspRefundResult, type PspWebhookInput, type PspWebhookVerification } from "./psp.types.js";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300;

export type StripeConfig = { secretKey: string; webhookSecret: string | null; mode: PspMode };

/** Env-driven configuration; null without a usable secret key. Pure. */
export function stripeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey || secretKey === "change-me" || !/^sk_(test|live)_/.test(secretKey)) return null;
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  return { secretKey, webhookSecret: webhookSecret && webhookSecret !== "change-me" ? webhookSecret : null, mode: secretKey.startsWith("sk_live_") ? "live" : "test" };
}

/** "125.40" → 12540 minor units (Decimal, never float). Pure. */
export function amountToMinorUnits(amount: string): number {
  return Number(new PrismaRuntime.Decimal(amount).times(100).toDecimalPlaces(0, PrismaRuntime.Decimal.ROUND_HALF_UP).toFixed(0));
}

/**
 * Verify a Stripe-Signature header against the raw body: HMAC-SHA256 of
 * "<timestamp>.<body>" with the endpoint secret, any of the v1 signatures may
 * match, and the timestamp must be within `toleranceSeconds` of `now`. Pure.
 */
export function verifyStripeSignature(input: { rawBody: string; signatureHeader: string | null; secret: string; now?: Date; toleranceSeconds?: number }): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!input.signatureHeader) return { ok: false, reason: "Falta la cabecera Stripe-Signature." };
  const parts = input.signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestampPart || signatures.length === 0) return { ok: false, reason: "Stripe-Signature sin t= o v1=." };
  const timestamp = Number.parseInt(timestampPart.slice(2), 10);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Stripe-Signature con marca de tiempo no numérica." };
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "Stripe-Signature fuera de la ventana de tolerancia (5 min)." };
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.${input.rawBody}`, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const matches = signatures.some((signature) => {
    const candidate = Buffer.from(signature, "utf8");
    return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
  });
  return matches ? { ok: true, timestamp } : { ok: false, reason: "Stripe-Signature no coincide con la firma calculada." };
}

/** Build a Stripe-Signature header for tests / local simulation. Pure. */
export function signStripePayload(rawBody: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}

type StripeEvent = { id?: string; type?: string; data?: { object?: Record<string, unknown> } };

/** Map a verified Stripe event to the neutral webhook event. Pure. */
export function mapStripeEvent(event: StripeEvent): PspWebhookVerification {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  const money = (minor: unknown): string | null => (typeof minor === "number" ? new PrismaRuntime.Decimal(minor).div(100).toFixed(2) : null);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (object.payment_status !== "paid") return { ok: true, event: { type: "ignored", reason: `checkout.session con payment_status ${String(object.payment_status)}`, raw: event } };
      return {
        ok: true,
        event: {
          type: "payment.captured",
          intentId: str(object.client_reference_id) ?? str(metadata.intentId),
          providerReference: str(object.payment_intent) ?? str(object.id) ?? "",
          amount: money(object.amount_total),
          currency: str(object.currency)?.toUpperCase() ?? null,
          raw: event
        }
      };
    }
    case "payment_intent.succeeded":
      return { ok: true, event: { type: "payment.captured", intentId: str(metadata.intentId), providerReference: str(object.id) ?? "", amount: money(object.amount_received ?? object.amount), currency: str(object.currency)?.toUpperCase() ?? null, raw: event } };
    case "payment_intent.payment_failed":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const error = (object.last_payment_error ?? {}) as Record<string, unknown>;
      return { ok: true, event: { type: "payment.failed", intentId: str(object.client_reference_id) ?? str(metadata.intentId), providerReference: str(object.payment_intent) ?? str(object.id) ?? "", reason: str(error.message) ?? event.type ?? "failed", raw: event } };
    }
    case "charge.refunded":
      return { ok: true, event: { type: "refund.completed", providerReference: str(object.payment_intent) ?? str(object.id) ?? "", amount: money(object.amount_refunded), raw: event } };
    default:
      return { ok: true, event: { type: "ignored", reason: `Evento Stripe no manejado: ${event.type ?? "?"}`, raw: event } };
  }
}

export class StripeAdapter implements PspAdapter {
  readonly provider = "stripe" as const;

  constructor(
    private readonly config: StripeConfig | null = stripeConfigFromEnv(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  status(): PspAdapterStatus {
    if (!this.config) {
      return { configured: false, provider: "stripe", mode: null, webhookSecretConfigured: false, message: "Stripe no está configurado: falta STRIPE_SECRET_KEY (sk_test_… para el sandbox)." };
    }
    return {
      configured: true,
      provider: "stripe",
      mode: this.config.mode,
      webhookSecretConfigured: this.config.webhookSecret !== null,
      message: `Stripe configurado en modo ${this.config.mode}${this.config.webhookSecret ? "" : " (sin STRIPE_WEBHOOK_SECRET: los webhooks se rechazan hasta configurarlo)"}.`
    };
  }

  private require(): StripeConfig {
    if (!this.config) throw new PspNotConfiguredError("stripe", this.status().message);
    return this.config;
  }

  private async request<T>(path: string, options: { method: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string }): Promise<T> {
    const config = this.require();
    const headers: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}` };
    if (options.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const response = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, { method: options.method, headers, body: options.body });
    const text = await response.text();
    if (!response.ok) throw new Error(`Stripe ${options.method} ${path} → HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async createPaymentLink(input: PspPaymentLinkInput): Promise<PspPaymentLinkResult> {
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("client_reference_id", input.intentId);
    body.set("success_url", input.returnUrl);
    body.set("cancel_url", input.cancelUrl);
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
    body.set("line_items[0][price_data][unit_amount]", String(amountToMinorUnits(input.amount)));
    body.set("line_items[0][price_data][product_data][name]", input.description.slice(0, 250));
    body.set("metadata[intentId]", input.intentId);
    body.set("metadata[reference]", input.reference.slice(0, 200));
    body.set("payment_intent_data[metadata][intentId]", input.intentId);
    body.set("payment_intent_data[description]", `${input.reference} · ${input.description}`.slice(0, 250));
    if (input.customerEmail) body.set("customer_email", input.customerEmail);
    const session = await this.request<{ id: string; url: string | null; expires_at?: number }>("/checkout/sessions", { method: "POST", body, idempotencyKey: `intent:${input.intentId}` });
    if (!session.url) throw new Error("Stripe no devolvió la URL de la sesión de Checkout.");
    return { providerReference: session.id, redirect: { method: "GET", url: session.url }, expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null };
  }

  async capture(providerReference: string): Promise<PspCaptureResult> {
    if (providerReference.startsWith("cs_")) {
      const session = await this.request<{ id: string; payment_status: string; payment_intent: string | null }>(`/checkout/sessions/${encodeURIComponent(providerReference)}`, { method: "GET" });
      if (session.payment_status === "paid") return { status: "captured", providerReference: session.payment_intent ?? session.id, capturedAt: new Date().toISOString(), error: null };
      return { status: "pending", providerReference: session.payment_intent ?? session.id, capturedAt: null, error: null };
    }
    const intent = await this.request<{ id: string; status: string }>(`/payment_intents/${encodeURIComponent(providerReference)}`, { method: "GET" });
    if (intent.status === "succeeded") return { status: "captured", providerReference: intent.id, capturedAt: new Date().toISOString(), error: null };
    if (intent.status === "canceled") return { status: "failed", providerReference: intent.id, capturedAt: null, error: "PaymentIntent cancelado" };
    return { status: "pending", providerReference: intent.id, capturedAt: null, error: null };
  }

  async refund(input: PspRefundInput): Promise<PspRefundResult> {
    const body = new URLSearchParams();
    body.set("payment_intent", input.providerReference);
    body.set("amount", String(amountToMinorUnits(input.amount)));
    body.set("metadata[reason]", input.reason.slice(0, 500));
    try {
      const refund = await this.request<{ id: string; status: string }>("/refunds", { method: "POST", body, idempotencyKey: `refund:${input.idempotencyKey}` });
      if (refund.status === "succeeded") return { status: "refunded", providerReference: refund.id, error: null };
      if (refund.status === "pending") return { status: "pending", providerReference: refund.id, error: null };
      return { status: "failed", providerReference: refund.id, error: `Stripe refund status ${refund.status}` };
    } catch (error) {
      return { status: "failed", providerReference: input.providerReference, error: error instanceof Error ? error.message : String(error) };
    }
  }

  verifyWebhook(input: PspWebhookInput): PspWebhookVerification {
    if (!this.config) return { ok: false, reason: this.status().message };
    if (!this.config.webhookSecret) return { ok: false, reason: "STRIPE_WEBHOOK_SECRET no configurado: el webhook no se puede verificar." };
    const verified = verifyStripeSignature({ rawBody: input.rawBody, signatureHeader: headerValue(input.headers, "stripe-signature"), secret: this.config.webhookSecret });
    if (!verified.ok) return verified;
    let event: StripeEvent;
    try {
      event = JSON.parse(input.rawBody) as StripeEvent;
    } catch {
      return { ok: false, reason: "El cuerpo del webhook no es JSON válido." };
    }
    return mapStripeEvent(event);
  }
}
