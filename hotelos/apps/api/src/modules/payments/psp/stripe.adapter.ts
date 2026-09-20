// Stripe adapter (Checkout Sessions, hosted page) — finanzas · lote
// facturación-cobros, 2026-09-15. Real HTTPS calls to api.stripe.com happen
// ONLY when STRIPE_SECRET_KEY is set (sk_test_… = test mode, sk_live_… =
// live); every call carries an Idempotency-Key so a retry never duplicates a
// session or a refund. Webhooks are verified with STRIPE_WEBHOOK_SECRET
// (Stripe-Signature v1, HMAC-SHA256 over "<t>.<raw body>", 5-minute
// tolerance). Without the secret key the adapter reports `configured:
// false` and the service answers 409 PSP_NOT_CONFIGURED.
//
// Preautorización (Tanda CHK · W5-A, diseño §2.4 «Pagos»): `authorize` crea
// un PaymentIntent con `capture_method=manual` y
// `payment_method_options[card][request_extended_authorization]=if_available`
// (autorización extendida hasta 30 días en hostelería). Con un token guardado
// (pm_… de Stripe Elements / PaymentToken.tokenRef) se confirma off-session
// en la misma llamada → `requires_capture` = `authorized`; sin token se abre
// una Checkout Session (mode=payment, payment_intent_data[capture_method]
// =manual) → `pending` + `redirect` hasta que el titular la complete.
// `captureAuthorization` = POST /payment_intents/:id/capture (parcial con
// amount_to_capture), `releaseAuthorization` = POST /payment_intents/:id/cancel,
// `tokenizeFromReference` = GET /payment_intents/:id?expand[]=payment_method
// (pm_…, marca, últimos 4, caducidad; nunca el PAN: Stripe no lo devuelve y
// looksLikePan lo comprueba igualmente). El webhook de una Checkout con
// captura manual llega con payment_status «unpaid» y
// payment_intent.amount_capturable_updated: ambos se IGNORAN a propósito (no
// son cobros); el estado se lee con captureAuthorization/tokenizeFromReference.
//
// Sandbox (createStripeSandbox): mismo adaptador con un `fetch` en memoria que
// responde de forma determinista (ids pi_sandbox_/pm_sandbox_/cs_sandbox_
// derivados por hash, tarjeta ficticia visa ****NNNN) y sin red. Solo se
// activa cuando el llamador lo construye (tests, demo); STRIPE_SECRET_KEY
// ausente sigue siendo `configured:false`.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma as PrismaRuntime } from "@prisma/client";
import {
  authorizationNotConfigured,
  clampCaptureWindowDays,
  headerValue,
  looksLikePan,
  PSP_AUTHORIZATION_MAX_DAYS,
  PSP_AUTHORIZATION_MIN_DAYS,
  PspNotConfiguredError,
  type PspAdapter,
  type PspAdapterStatus,
  type PspAuthorizationInput,
  type PspAuthorizationReleaseResult,
  type PspAuthorizationResult,
  type PspCaptureResult,
  type PspCardToken,
  type PspMode,
  type PspPaymentLinkInput,
  type PspPaymentLinkResult,
  type PspRefundInput,
  type PspRefundResult,
  type PspWebhookInput,
  type PspWebhookVerification
} from "./psp.types.js";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300;

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string | null;
  mode: PspMode;
  /** Solo lo pone createStripeSandbox: transporte en memoria, respuestas deterministas, sin red. Nunca desde el entorno. */
  sandbox?: true;
};

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
    case "payment_intent.amount_capturable_updated":
      // Preautorización viva (capture_method=manual): NO es un cobro. Se confirma
      // con captureAuthorization; el webhook payment_intent.succeeded llegará entonces.
      return { ok: true, event: { type: "ignored", reason: `Preautorización ${str(object.id) ?? "?"} lista para capturar (amount_capturable_updated): no es un cobro.`, raw: event } };
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
    if (this.config.sandbox) {
      return { configured: true, provider: "stripe", mode: "test", webhookSecretConfigured: false, message: "Stripe en SANDBOX local (respuestas deterministas en memoria, sin red): solo demos y tests; ninguna tarjeta real." };
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

  // ── Preautorización (Tanda CHK · W5-A) ────────────────────────────────────

  /** Resuelve cs_… → pi_… (una Checkout Session completada lleva su PaymentIntent). */
  private async paymentIntentIdFor(providerReference: string): Promise<string> {
    if (!providerReference.startsWith("cs_")) return providerReference;
    const session = await this.request<{ id: string; payment_intent: string | null }>(`/checkout/sessions/${encodeURIComponent(providerReference)}`, { method: "GET" });
    if (!session.payment_intent) throw new Error(`La Checkout Session ${providerReference} aún no tiene PaymentIntent (el titular no la ha completado).`);
    return session.payment_intent;
  }

  async authorize(input: PspAuthorizationInput): Promise<PspAuthorizationResult> {
    if (!this.config) return authorizationNotConfigured("stripe", this.status().message);
    if (input.paymentMethodRef && looksLikePan(input.paymentMethodRef)) {
      return { status: "failed", providerReference: "", expiresAt: null, error: "paymentMethodRef parece un número de tarjeta: solo se aceptan tokens pm_… de Stripe.", redirect: null, card: null };
    }
    const amount = String(amountToMinorUnits(input.amount));
    const currency = input.currency.toLowerCase();
    const description = `${input.reservationCode} · ${input.description ?? "Garantía de la estancia"}`.slice(0, 250);
    try {
      if (input.paymentMethodRef) {
        // Token guardado: PaymentIntent confirmado off-session con captura manual.
        const body = new URLSearchParams();
        body.set("amount", amount);
        body.set("currency", currency);
        body.set("capture_method", "manual");
        body.set("payment_method_options[card][request_extended_authorization]", "if_available");
        body.set("payment_method", input.paymentMethodRef);
        body.set("confirm", "true");
        body.set("off_session", "true");
        body.set("description", description);
        body.set("metadata[folioId]", input.folioId);
        body.set("metadata[reservationCode]", input.reservationCode.slice(0, 200));
        if (input.intentId) body.set("metadata[intentId]", input.intentId);
        // latest_charge → capture_before (caducidad real); payment_method → marca / últimos 4 / caducidad de la tarjeta.
        body.append("expand[]", "latest_charge");
        body.append("expand[]", "payment_method");
        const intent = await this.request<StripePaymentIntent>("/payment_intents", { method: "POST", body, idempotencyKey: `auth:${input.idempotencyKey ?? `${input.folioId}:${input.amount}:${input.currency.toUpperCase()}`}` });
        return mapStripeAuthorization(intent);
      }
      // Sin token: página alojada (Checkout) con captura manual; el titular la completa.
      const body = new URLSearchParams();
      body.set("mode", "payment");
      if (input.intentId) body.set("client_reference_id", input.intentId);
      body.set("success_url", input.returnUrl ?? "");
      body.set("cancel_url", input.cancelUrl ?? input.returnUrl ?? "");
      body.set("line_items[0][quantity]", "1");
      body.set("line_items[0][price_data][currency]", currency);
      body.set("line_items[0][price_data][unit_amount]", amount);
      body.set("line_items[0][price_data][product_data][name]", description);
      body.set("payment_intent_data[capture_method]", "manual");
      body.set("payment_intent_data[description]", description);
      body.set("payment_intent_data[metadata][folioId]", input.folioId);
      if (input.intentId) body.set("payment_intent_data[metadata][intentId]", input.intentId);
      body.set("payment_method_options[card][request_extended_authorization]", "if_available");
      body.set("metadata[folioId]", input.folioId);
      body.set("metadata[reservationCode]", input.reservationCode.slice(0, 200));
      if (input.customerEmail) body.set("customer_email", input.customerEmail);
      const session = await this.request<{ id: string; url: string | null; payment_intent?: string | null }>("/checkout/sessions", { method: "POST", body, idempotencyKey: `auth-session:${input.idempotencyKey ?? `${input.folioId}:${input.amount}:${input.currency.toUpperCase()}`}` });
      if (!session.url) return { status: "failed", providerReference: session.id, expiresAt: null, error: "Stripe no devolvió la URL de la sesión de Checkout.", redirect: null, card: null };
      return { status: "pending", providerReference: session.id, expiresAt: null, error: null, redirect: { method: "GET", url: session.url }, card: null };
    } catch (error) {
      return { status: "failed", providerReference: "", expiresAt: null, error: error instanceof Error ? error.message : String(error), redirect: null, card: null };
    }
  }

  async captureAuthorization(providerReference: string, amount?: string | null): Promise<PspCaptureResult> {
    this.require();
    try {
      const intentId = await this.paymentIntentIdFor(providerReference);
      const body = new URLSearchParams();
      if (amount) body.set("amount_to_capture", String(amountToMinorUnits(amount)));
      const intent = await this.request<StripePaymentIntent>(`/payment_intents/${encodeURIComponent(intentId)}/capture`, { method: "POST", body, idempotencyKey: `capture:${intentId}:${amount ?? "full"}` });
      if (intent.status === "succeeded") return { status: "captured", providerReference: intent.id, capturedAt: new Date().toISOString(), error: null };
      if (intent.status === "processing") return { status: "pending", providerReference: intent.id, capturedAt: null, error: null };
      return { status: "failed", providerReference: intent.id, capturedAt: null, error: `PaymentIntent en estado ${intent.status} tras la captura.` };
    } catch (error) {
      return { status: "failed", providerReference, capturedAt: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async releaseAuthorization(providerReference: string): Promise<PspAuthorizationReleaseResult> {
    this.require();
    try {
      const intentId = await this.paymentIntentIdFor(providerReference);
      const body = new URLSearchParams();
      body.set("cancellation_reason", "requested_by_customer");
      const intent = await this.request<StripePaymentIntent>(`/payment_intents/${encodeURIComponent(intentId)}/cancel`, { method: "POST", body, idempotencyKey: `release:${intentId}` });
      if (intent.status === "canceled") return { status: "released", providerReference: intent.id, error: null };
      return { status: "failed", providerReference: intent.id, error: `PaymentIntent en estado ${intent.status} tras la anulación.` };
    } catch (error) {
      return { status: "failed", providerReference, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async tokenizeFromReference(providerReference: string): Promise<PspCardToken | null> {
    this.require();
    const intentId = await this.paymentIntentIdFor(providerReference);
    const intent = await this.request<StripePaymentIntent>(`/payment_intents/${encodeURIComponent(intentId)}?expand[]=payment_method`, { method: "GET" });
    return cardTokenFromPaymentMethod(intent.payment_method);
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

// ── Preautorización: mapeo puro de la respuesta de Stripe ────────────────────

type StripeCard = { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
type StripePaymentMethod = string | { id?: string; type?: string; card?: StripeCard } | null | undefined;
type StripeCharge = string | { id?: string; payment_method_details?: { card?: { capture_before?: number; extended_authorization?: { status?: string } } } } | null | undefined;
export type StripePaymentIntent = {
  id: string;
  status: string;
  amount?: number;
  amount_capturable?: number;
  amount_received?: number;
  currency?: string;
  payment_method?: StripePaymentMethod;
  latest_charge?: StripeCharge;
  last_payment_error?: { message?: string } | null;
};

/** PaymentIntent (capture_method=manual) → resultado neutro de autorización. Pure. */
export function mapStripeAuthorization(intent: StripePaymentIntent): PspAuthorizationResult {
  const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const captureBefore = charge?.payment_method_details?.card?.capture_before;
  const expiresAt = typeof captureBefore === "number" ? new Date(captureBefore * 1000).toISOString() : null;
  const card = cardTokenFromPaymentMethod(intent.payment_method);
  switch (intent.status) {
    case "requires_capture":
      return { status: "authorized", providerReference: intent.id, expiresAt, error: null, redirect: null, card };
    case "requires_action":
    case "requires_confirmation":
    case "requires_payment_method":
    case "processing":
      return { status: "pending", providerReference: intent.id, expiresAt: null, error: null, redirect: null, card };
    case "canceled":
      return { status: "failed", providerReference: intent.id, expiresAt: null, error: intent.last_payment_error?.message ?? "PaymentIntent cancelado", redirect: null, card: null };
    case "succeeded":
      // Con capture_method=manual no ocurre en la creación; si ocurre, el dinero ya está cobrado: no es una garantía.
      return { status: "failed", providerReference: intent.id, expiresAt: null, error: "El PaymentIntent quedó capturado (succeeded) en vez de autorizado: revisa capture_method.", redirect: null, card };
    default:
      return { status: "pending", providerReference: intent.id, expiresAt: null, error: `Estado de Stripe no previsto: ${intent.status}`, redirect: null, card };
  }
}

/** payment_method expandido → token de tarjeta (pm_…, marca, últimos 4, caducidad); null si no es tarjeta. Pure. */
export function cardTokenFromPaymentMethod(paymentMethod: StripePaymentMethod): PspCardToken | null {
  if (!paymentMethod || typeof paymentMethod !== "object" || !paymentMethod.id || !paymentMethod.card) return null;
  const card = paymentMethod.card;
  if (typeof card.last4 !== "string" || !/^[0-9]{4}$/.test(card.last4) || typeof card.exp_month !== "number" || typeof card.exp_year !== "number") return null;
  if (looksLikePan(paymentMethod.id) || looksLikePan(card.brand)) return null;
  return { tokenRef: paymentMethod.id, last4: card.last4, brand: (card.brand ?? "card").toLowerCase(), expiryMonth: card.exp_month, expiryYear: card.exp_year };
}

// ── Sandbox determinista (sin red) ───────────────────────────────────────────

/** Clave del sandbox: pasa el patrón sk_test_ pero nunca llega a api.stripe.com (el transporte es en memoria). */
export const STRIPE_SANDBOX_SECRET_KEY = "sk_test_sandboxlocal";

type SandboxIntent = { id: string; status: string; amount: number; amount_capturable: number; amount_received: number; currency: string; payment_method: string | null; capture_before: number | null; metadata: Record<string, string>; created: number };
type SandboxSession = { id: string; url: string; payment_intent: string; payment_status: "unpaid" | "paid"; status: "open" | "complete" | "expired"; client_reference_id: string | null; expires_at: number };

export type StripeSandboxState = {
  intents: Map<string, SandboxIntent>;
  sessions: Map<string, SandboxSession>;
  /** Peticiones recibidas (método + ruta), para las aserciones de los tests. */
  calls: Array<{ method: string; path: string; body: Record<string, string> }>;
  /** Simula que el titular completó la Checkout Session: el PaymentIntent pasa a requires_capture. */
  completeCheckout(sessionId: string): SandboxIntent | null;
};

function sandboxHash(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 12);
}

/** Últimos 4 dígitos ficticios derivados de un hash (nunca un PAN: solo 4 dígitos). Pure. */
export function sandboxLast4(seed: string): string {
  return String(Number.parseInt(sandboxHash(seed).slice(0, 8), 16) % 10000).padStart(4, "0");
}

function sandboxPaymentMethodObject(id: string, now: Date): { id: string; type: string; card: StripeCard } {
  return { id, type: "card", card: { brand: "visa", last4: sandboxLast4(id), exp_month: 12, exp_year: now.getUTCFullYear() + 3 } };
}

/**
 * Transporte de Stripe en memoria: responde a las rutas que usa el adaptador
 * (checkout/sessions, payment_intents[/capture|/cancel], refunds) con ids
 * deterministas (hash de la Idempotency-Key o del cuerpo) y estados
 * coherentes (requires_capture → succeeded | canceled). Cualquier otra ruta
 * es 404. Pure salvo el estado del propio sandbox.
 */
export function createStripeSandboxFetch(options: { now?: () => Date } = {}): { fetch: typeof fetch; state: StripeSandboxState } {
  const now = options.now ?? (() => new Date());
  const intents = new Map<string, SandboxIntent>();
  const sessions = new Map<string, SandboxSession>();
  const calls: StripeSandboxState["calls"] = [];
  const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const withPaymentMethod = (intent: SandboxIntent, expand: boolean): Record<string, unknown> => ({
    ...intent,
    payment_method: expand && intent.payment_method ? sandboxPaymentMethodObject(intent.payment_method, now()) : intent.payment_method,
    latest_charge: intent.status === "requires_capture" || intent.status === "succeeded" ? { id: `ch_sandbox_${sandboxHash(intent.id)}`, payment_method_details: { card: { capture_before: intent.capture_before, extended_authorization: { status: "enabled" } } } } : null
  });
  const completeCheckout = (sessionId: string): SandboxIntent | null => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const intent = intents.get(session.payment_intent);
    if (!intent) return null;
    session.status = "complete";
    intent.status = "requires_capture";
    intent.amount_capturable = intent.amount;
    intent.payment_method = `pm_sandbox_${sandboxHash(`pm:${intent.id}`)}`;
    intent.capture_before = Math.floor(now().getTime() / 1000) + PSP_AUTHORIZATION_MAX_DAYS * 86_400;
    return intent;
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url instanceof Request ? url.url : url);
    const path = href.startsWith(STRIPE_API_BASE) ? href.slice(STRIPE_API_BASE.length) : href;
    const [route, query = ""] = path.split("?", 2) as [string, string?];
    const method = (init?.method ?? "GET").toUpperCase();
    const body = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "").entries());
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const idempotencyKey = headers["Idempotency-Key"] ?? null;
    calls.push({ method, path: route, body });
    const at = now();
    const seconds = Math.floor(at.getTime() / 1000);

    if (method === "POST" && route === "/payment_intents") {
      const id = `pi_sandbox_${sandboxHash(idempotencyKey ?? JSON.stringify(body))}`;
      const existing = intents.get(id);
      if (existing) return json(200, withPaymentMethod(existing, query.includes("expand") || Boolean(body["expand[]"])));
      const manual = body.capture_method === "manual";
      const extended = body["payment_method_options[card][request_extended_authorization]"] === "if_available";
      const confirmed = body.confirm === "true" && Boolean(body.payment_method);
      const intent: SandboxIntent = {
        id,
        status: confirmed ? (manual ? "requires_capture" : "succeeded") : "requires_payment_method",
        amount: Number(body.amount ?? "0"),
        amount_capturable: confirmed && manual ? Number(body.amount ?? "0") : 0,
        amount_received: confirmed && !manual ? Number(body.amount ?? "0") : 0,
        currency: body.currency ?? "eur",
        payment_method: confirmed ? body.payment_method! : null,
        capture_before: confirmed && manual ? seconds + (extended ? PSP_AUTHORIZATION_MAX_DAYS : PSP_AUTHORIZATION_MIN_DAYS) * 86_400 : null,
        metadata: Object.fromEntries(Object.entries(body).filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value])),
        created: seconds
      };
      intents.set(id, intent);
      return json(200, withPaymentMethod(intent, Boolean(body["expand[]"])));
    }
    if (method === "POST" && route === "/checkout/sessions") {
      const id = `cs_sandbox_${sandboxHash(idempotencyKey ?? JSON.stringify(body))}`;
      const existing = sessions.get(id);
      if (existing) return json(200, existing);
      const intentId = `pi_sandbox_${sandboxHash(`cs:${id}`)}`;
      const manual = body["payment_intent_data[capture_method]"] === "manual";
      intents.set(intentId, {
        id: intentId,
        status: "requires_payment_method",
        amount: Number(body["line_items[0][price_data][unit_amount]"] ?? "0"),
        amount_capturable: 0,
        amount_received: 0,
        currency: body["line_items[0][price_data][currency]"] ?? "eur",
        payment_method: null,
        capture_before: null,
        metadata: { ...(manual ? { capture_method: "manual" } : {}), ...(body["payment_intent_data[metadata][intentId]"] ? { intentId: body["payment_intent_data[metadata][intentId]"] } : {}) },
        created: seconds
      });
      const session: SandboxSession = { id, url: `https://checkout.stripe.com/sandbox/${id}`, payment_intent: intentId, payment_status: "unpaid", status: "open", client_reference_id: body.client_reference_id ?? null, expires_at: seconds + 86_400 };
      sessions.set(id, session);
      return json(200, session);
    }
    const sessionMatch = /^\/checkout\/sessions\/([^/]+)$/.exec(route);
    if (method === "GET" && sessionMatch) {
      const session = sessions.get(decodeURIComponent(sessionMatch[1]!));
      return session ? json(200, session) : json(404, { error: { message: "No such checkout.session" } });
    }
    const intentMatch = /^\/payment_intents\/([^/]+)(\/capture|\/cancel)?$/.exec(route);
    if (intentMatch) {
      const intent = intents.get(decodeURIComponent(intentMatch[1]!));
      if (!intent) return json(404, { error: { message: "No such payment_intent" } });
      const action = intentMatch[2];
      if (method === "GET" && !action) return json(200, withPaymentMethod(intent, query.includes("expand")));
      if (method === "POST" && action === "/capture") {
        if (intent.status !== "requires_capture") return json(400, { error: { message: `PaymentIntent ${intent.id} no está en requires_capture (${intent.status}).` } });
        const toCapture = body.amount_to_capture ? Number(body.amount_to_capture) : intent.amount;
        if (toCapture > intent.amount_capturable) return json(400, { error: { message: "amount_to_capture supera lo autorizado." } });
        intent.status = "succeeded";
        intent.amount_received = toCapture;
        intent.amount_capturable = 0;
        return json(200, withPaymentMethod(intent, false));
      }
      if (method === "POST" && action === "/cancel") {
        if (intent.status !== "requires_capture" && intent.status !== "requires_payment_method") return json(400, { error: { message: `PaymentIntent ${intent.id} no se puede anular en estado ${intent.status}.` } });
        intent.status = "canceled";
        intent.amount_capturable = 0;
        return json(200, withPaymentMethod(intent, false));
      }
    }
    if (method === "POST" && route === "/refunds") {
      return json(200, { id: `re_sandbox_${sandboxHash(idempotencyKey ?? JSON.stringify(body))}`, status: "succeeded" });
    }
    return json(404, { error: { message: `Ruta no soportada por el sandbox de Stripe: ${method} ${route}` } });
  }) as typeof fetch;
  return { fetch: fetchImpl, state: { intents, sessions, calls, completeCheckout } };
}

/** Adaptador de Stripe en sandbox local (demo/tests): configurado, determinista, sin red. */
export function createStripeSandbox(options: { now?: () => Date } = {}): { adapter: StripeAdapter; state: StripeSandboxState } {
  const transport = createStripeSandboxFetch(options);
  return { adapter: new StripeAdapter({ secretKey: STRIPE_SANDBOX_SECRET_KEY, webhookSecret: null, mode: "test", sandbox: true }, transport.fetch), state: transport.state };
}
