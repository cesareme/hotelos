// Stripe adapter — signature verification vectors and event mapping (pure,
// no network: the adapter's fetch is injected). Run from apps/api with
//   node --import tsx --test src/modules/payments/__tests__/stripe.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amountToMinorUnits, mapStripeEvent, signStripePayload, StripeAdapter, stripeConfigFromEnv, verifyStripeSignature } from "../psp/stripe.adapter.js";

const SECRET = "whsec_test_secret_0123456789";

describe("verifyStripeSignature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const now = new Date("2026-09-15T10:00:00.000Z");
  const ts = Math.floor(now.getTime() / 1000);

  it("accepts a fresh v1 signature and rejects a wrong secret, a stale timestamp or a tampered body", () => {
    const header = signStripePayload(body, SECRET, ts);
    assert.deepEqual(verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now }), { ok: true, timestamp: ts });
    assert.equal(verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: "whsec_other", now }).ok, false);
    assert.equal(verifyStripeSignature({ rawBody: `${body} `, signatureHeader: header, secret: SECRET, now }).ok, false);
    const stale = verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now: new Date(now.getTime() + 10 * 60 * 1000) });
    assert.ok(!stale.ok && /tolerancia/.test(stale.reason));
    assert.ok(!verifyStripeSignature({ rawBody: body, signatureHeader: null, secret: SECRET, now }).ok);
    assert.ok(!verifyStripeSignature({ rawBody: body, signatureHeader: "t=abc,v1=00", secret: SECRET, now }).ok);
    // Several v1 entries (key rotation): any valid one passes.
    assert.ok(verifyStripeSignature({ rawBody: body, signatureHeader: `${header},v1=deadbeef`, secret: SECRET, now }).ok);
  });
});

describe("mapStripeEvent", () => {
  it("checkout.session.completed (paid) → payment.captured with the client reference and the PaymentIntent id", () => {
    const mapped = mapStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", client_reference_id: "pi_abc", payment_intent: "pi_stripe_1", amount_total: 12540, currency: "eur", payment_status: "paid" } } });
    assert.ok(mapped.ok);
    assert.deepEqual({ ...mapped.event, raw: undefined }, { type: "payment.captured", intentId: "pi_abc", providerReference: "pi_stripe_1", amount: "125.40", currency: "EUR", raw: undefined });
  });
  it("unpaid sessions and unknown events are ignored; failures and refunds map", () => {
    const unpaid = mapStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "unpaid" } } });
    assert.ok(unpaid.ok && unpaid.event.type === "ignored");
    const other = mapStripeEvent({ type: "customer.created", data: { object: {} } });
    assert.ok(other.ok && other.event.type === "ignored");
    const failed = mapStripeEvent({ type: "payment_intent.payment_failed", data: { object: { id: "pi_s", metadata: { intentId: "pi_abc" }, last_payment_error: { message: "card_declined" } } } });
    assert.ok(failed.ok && failed.event.type === "payment.failed" && failed.event.reason === "card_declined" && failed.event.intentId === "pi_abc");
    const refund = mapStripeEvent({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_s", amount_refunded: 500 } } });
    assert.ok(refund.ok && refund.event.type === "refund.completed" && refund.event.amount === "5.00");
  });
});

describe("StripeAdapter — configuration gate and injected HTTP", () => {
  it("is not configured without a sk_ key and never calls the network then", async () => {
    assert.equal(stripeConfigFromEnv({}), null);
    assert.equal(stripeConfigFromEnv({ STRIPE_SECRET_KEY: "not-a-key" }), null);
    assert.deepEqual(stripeConfigFromEnv({ STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: SECRET }), { secretKey: "sk_test_abc", webhookSecret: SECRET, mode: "test" });
    assert.equal(stripeConfigFromEnv({ STRIPE_SECRET_KEY: "sk_live_abc" })!.mode, "live");
    let calls = 0;
    const adapter = new StripeAdapter(null, async () => {
      calls++;
      throw new Error("must not be called");
    });
    assert.equal(adapter.status().configured, false);
    await assert.rejects(() => adapter.createPaymentLink({ intentId: "pi_1", amount: "10.00", currency: "EUR", description: "x", reference: "r", returnUrl: "https://a", cancelUrl: "https://b", notifyUrl: "https://c" }), /STRIPE_SECRET_KEY/);
    assert.equal(calls, 0);
    assert.equal(adapter.verifyWebhook({ rawBody: "{}", headers: {}, contentType: "application/json" }).ok, false);
  });

  it("creates a Checkout Session with an Idempotency-Key and maps the hosted URL", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new StripeAdapter({ secretKey: "sk_test_abc", webhookSecret: SECRET, mode: "test" }, (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: 1789999999 }), { status: 200 });
    }) as typeof fetch);
    const link = await adapter.createPaymentLink({ intentId: "pi_1", amount: "125.40", currency: "EUR", description: "Estancia", reference: "RES-1", returnUrl: "https://a/ok", cancelUrl: "https://a/ko", notifyUrl: "https://a/hook", customerEmail: "g@example.com" });
    assert.equal(link.providerReference, "cs_test_1");
    assert.deepEqual(link.redirect, { method: "GET", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://api.stripe.com/v1/checkout/sessions");
    const headers = requests[0]!.init.headers as Record<string, string>;
    assert.equal(headers["Idempotency-Key"], "intent:pi_1");
    assert.match(headers.Authorization!, /^Basic /);
    const form = new URLSearchParams(String(requests[0]!.init.body));
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), "12540");
    assert.equal(form.get("client_reference_id"), "pi_1");
    assert.equal(form.get("customer_email"), "g@example.com");
    assert.equal(amountToMinorUnits("0.29"), 29);
  });

  it("verifyWebhook needs the webhook secret and returns the mapped event", () => {
    const body = JSON.stringify({ id: "evt", type: "payment_intent.succeeded", data: { object: { id: "pi_s", amount_received: 100, currency: "eur", metadata: { intentId: "pi_1" } } } });
    const ts = Math.floor(Date.now() / 1000);
    const withSecret = new StripeAdapter({ secretKey: "sk_test_abc", webhookSecret: SECRET, mode: "test" });
    const ok = withSecret.verifyWebhook({ rawBody: body, headers: { "stripe-signature": signStripePayload(body, SECRET, ts) }, contentType: "application/json" });
    assert.ok(ok.ok && ok.event.type === "payment.captured" && ok.event.amount === "1.00");
    const noSecret = new StripeAdapter({ secretKey: "sk_test_abc", webhookSecret: null, mode: "test" });
    const refused = noSecret.verifyWebhook({ rawBody: body, headers: { "stripe-signature": signStripePayload(body, SECRET, ts) }, contentType: "application/json" });
    assert.ok(!refused.ok && /STRIPE_WEBHOOK_SECRET/.test(refused.reason));
  });
});
