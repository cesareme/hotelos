// Stripe adapter — pagos internacionales + recurring + PSD2 SCA out-of-the-box.
//
// Para hoteles que aceptan huéspedes internacionales o quieren cobros
// pre-stay (link de pago enviado por email). Stripe se encarga del 3DS2
// automáticamente y devuelve un payment_method.id que reusamos para charges
// off-session (recurring, no-show penalty, late check-out fee).
//
// Esta implementación usa `fetch` contra la API REST de Stripe v1 — sin SDK
// para mantener el bundle ligero. Funciona en modo `stub` (sin clave),
// `test` (sk_test_*) y `live` (sk_live_*).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentAdapter,
  PaymentChargeIntent,
  PaymentChargeResult,
  PaymentRefundIntent,
  PaymentRefundResult
} from "./types.js";

// Card-data input for tokenize() — either raw PAN (sandbox/test only — production
// must collect card data through a PCI-compliant frontend like Stripe Elements)
// or a one-shot PSP token to be exchanged for a reusable payment-method id.
export type CardData = {
  pan?: string;
  expiryMonth?: number;
  expiryYear?: number;
  cvc?: string;
  /** One-shot token from a frontend SDK (e.g. Stripe Elements pm_xxx). */
  token?: string;
};

/** Result of a simple tokenization-only adapter call. */
export type TokenizeResult = {
  tokenRef: string;
  last4?: string;
  brand?: string;
};

/** Result of a simple charge against a stored token. */
export type SimpleChargeResult = {
  id: string;
  status: "succeeded" | "requires_action" | "failed";
  providerRef: string;
};

/** Result of a simple refund. */
export type SimpleRefundResult = {
  id: string;
  status: "succeeded" | "failed";
};

export type StripeConfig = {
  mode: "stub" | "test" | "live";
  /** Secret key (sk_test_… or sk_live_…). */
  secretKey?: string;
  /** Webhook signing secret (whsec_…). */
  webhookSecret?: string;
};

const STRIPE_API = "https://api.stripe.com/v1";

function basicAuth(secretKey: string): string {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

async function stripeRequest(secretKey: string, path: string, body?: URLSearchParams): Promise<unknown> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: basicAuth(secretKey),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}

export class StripeAdapter implements PaymentAdapter {
  providerCode = "stripe" as const;

  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof config !== "object" || !config) return { ok: false, reason: "config must be object" };
    const c = config as Partial<StripeConfig>;
    if (!c.mode || !["stub", "test", "live"].includes(c.mode)) {
      return { ok: false, reason: "mode must be stub|test|live" };
    }
    if (c.mode !== "stub" && !c.secretKey) {
      return { ok: false, reason: "secretKey required for test/live" };
    }
    return { ok: true };
  }

  async charge(config: unknown, intent: PaymentChargeIntent): Promise<PaymentChargeResult> {
    const c = config as StripeConfig;
    if (c.mode === "stub") {
      // Local dev path — no network, deterministic id.
      return {
        status: "succeeded",
        providerTransactionId: `pi_stub_${intent.idempotencyKey.slice(0, 16)}`,
        capturedAt: new Date().toISOString(),
        cardTokenRef: intent.saveCardForLater ? `pm_stub_${intent.idempotencyKey.slice(0, 16)}` : undefined
      };
    }
    const secret = c.secretKey ?? "";
    // Create a PaymentIntent. If saveCardForLater, attach setup_future_usage.
    const body = new URLSearchParams();
    body.set("amount", String(amountToCents(intent.amount)));
    body.set("currency", intent.currency.toLowerCase());
    body.set("description", intent.description);
    body.set("statement_descriptor_suffix", intent.reference.slice(0, 22));
    if (intent.enforceSca) body.set("payment_method_options[card][request_three_d_secure]", "challenge");
    if (intent.saveCardForLater) body.set("setup_future_usage", "off_session");
    if (intent.cardTokenRef) {
      body.set("payment_method", intent.cardTokenRef);
      body.set("confirm", "true");
      body.set("off_session", "true");
    }
    if (intent.customer?.email) body.set("receipt_email", intent.customer.email);

    try {
      const pi = (await stripeRequest(secret, "/payment_intents", body)) as {
        id: string;
        status: string;
        next_action?: { type: string; redirect_to_url?: { url: string } };
        payment_method?: string;
        client_secret?: string;
      };

      if (pi.status === "succeeded") {
        return {
          status: "succeeded",
          providerTransactionId: pi.id,
          capturedAt: new Date().toISOString(),
          cardTokenRef: pi.payment_method
        };
      }
      if (pi.status === "requires_action" || pi.status === "requires_confirmation") {
        const actionUrl = pi.next_action?.redirect_to_url?.url
          ?? (intent.returnUrl ? `${intent.returnUrl}?pi=${pi.id}&cs=${pi.client_secret ?? ""}` : "");
        return { status: "requires_action", actionUrl, providerTransactionId: pi.id };
      }
      return { status: "failed", providerTransactionId: pi.id, permanent: false, reason: `Stripe status: ${pi.status}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: "failed", permanent: msg.includes("card_declined"), reason: msg };
    }
  }

  async refund(config: unknown, intent: PaymentRefundIntent): Promise<PaymentRefundResult> {
    const c = config as StripeConfig;
    if (c.mode === "stub") {
      return {
        status: "succeeded",
        providerTransactionId: intent.providerTransactionId,
        refundedAmount: intent.amount
      };
    }
    const body = new URLSearchParams();
    body.set("payment_intent", intent.providerTransactionId);
    if (intent.amount) body.set("amount", String(amountToCents(intent.amount)));
    if (intent.reason) body.set("reason", "requested_by_customer");
    try {
      const r = (await stripeRequest(c.secretKey ?? "", "/refunds", body)) as { id: string; amount: number };
      return {
        status: "succeeded",
        providerTransactionId: r.id,
        refundedAmount: r.amount / 100
      };
    } catch (e) {
      return {
        status: "failed",
        providerTransactionId: intent.providerTransactionId,
        reason: e instanceof Error ? e.message : "unknown"
      };
    }
  }

  verifyWebhook(payload: string, headers: Record<string, string>, secret: string): boolean {
    // Stripe sig header: "t=<ts>,v1=<hex>". Compute HMAC-SHA256 of "<ts>.<payload>"
    // with secret and compare against v1.
    const sigHeader = headers["stripe-signature"] ?? headers["Stripe-Signature"];
    if (!sigHeader) return false;
    const parts = Object.fromEntries(
      sigHeader.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k.trim(), v.trim()];
      })
    );
    const ts = parts["t"];
    const sig = parts["v1"];
    if (!ts || !sig) return false;
    const expected = createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
    if (sig.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  // ---------------------------------------------------------------------------
  // Simple convenience methods (Sprint 38) — used by the /payment-tokens
  // endpoint and any service that just wants "save card, charge later" without
  // building a full PaymentChargeIntent. Sandbox/stub paths return deterministic
  // hashes so tests can assert exact values; the test/live paths exchange the
  // one-shot token (pm_xxx) for a reusable payment-method id.
  // ---------------------------------------------------------------------------

  async tokenize(cardData: CardData, config?: StripeConfig): Promise<TokenizeResult> {
    const mode = config?.mode ?? "stub";
    const last4 = cardData.pan?.slice(-4);
    if (mode === "stub") {
      // Deterministic hash so the same card produces the same tokenRef across
      // restarts — useful for tests that idempotently re-tokenize.
      const seed = cardData.token ?? cardData.pan ?? "sandbox";
      const hash = createHash("sha256").update(`stripe:${seed}`).digest("hex").slice(0, 24);
      return { tokenRef: `pm_stub_${hash}`, last4: last4 ?? "4242", brand: "visa" };
    }
    // test/live: if the caller already has a pm_xxx, return it as-is. If they
    // passed a raw PAN, we cannot tokenize it here without violating PCI scope
    // — the frontend must use Stripe Elements / Checkout. We surface a clear
    // error rather than silently storing the PAN.
    if (cardData.token && cardData.token.startsWith("pm_")) {
      return { tokenRef: cardData.token, last4, brand: "visa" };
    }
    throw new Error(
      "stripe.tokenize: raw PAN tokenization not supported in test/live — pass a pm_xxx token from Stripe Elements"
    );
  }

  async chargeWithToken(
    tokenRef: string,
    amount: number,
    currency: string,
    config?: StripeConfig
  ): Promise<SimpleChargeResult> {
    const mode = config?.mode ?? "stub";
    if (mode === "stub") {
      const hash = createHash("sha256")
        .update(`stripe:charge:${tokenRef}:${amount}:${currency}`)
        .digest("hex")
        .slice(0, 24);
      const id = `pi_stub_${hash}`;
      return { id, status: "succeeded", providerRef: id };
    }
    const secret = config?.secretKey ?? "";
    const body = new URLSearchParams();
    body.set("amount", String(amountToCents(amount)));
    body.set("currency", currency.toLowerCase());
    body.set("payment_method", tokenRef);
    body.set("confirm", "true");
    body.set("off_session", "true");
    try {
      const pi = (await stripeRequest(secret, "/payment_intents", body)) as { id: string; status: string };
      const status: SimpleChargeResult["status"] =
        pi.status === "succeeded"
          ? "succeeded"
          : pi.status === "requires_action" || pi.status === "requires_confirmation"
            ? "requires_action"
            : "failed";
      return { id: pi.id, status, providerRef: pi.id };
    } catch {
      return { id: "", status: "failed", providerRef: "" };
    }
  }

  async refundCharge(chargeId: string, amount?: number, config?: StripeConfig): Promise<SimpleRefundResult> {
    const mode = config?.mode ?? "stub";
    if (mode === "stub") {
      const hash = createHash("sha256")
        .update(`stripe:refund:${chargeId}:${amount ?? "full"}`)
        .digest("hex")
        .slice(0, 24);
      return { id: `re_stub_${hash}`, status: "succeeded" };
    }
    const body = new URLSearchParams();
    body.set("payment_intent", chargeId);
    if (amount !== undefined) body.set("amount", String(amountToCents(amount)));
    try {
      const r = (await stripeRequest(config?.secretKey ?? "", "/refunds", body)) as { id: string };
      return { id: r.id, status: "succeeded" };
    } catch {
      return { id: chargeId, status: "failed" };
    }
  }
}

export const stripe = new StripeAdapter();
