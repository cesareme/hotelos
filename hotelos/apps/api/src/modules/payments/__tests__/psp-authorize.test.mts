// Unit tests · Tanda CHK · lote W5-A — extensión de preautorización del
// contrato PSP (psp.types.ts) en Stripe y Redsys: sin credenciales `authorize`
// responde failed con configured:false y sin tocar la red; los sandboxes
// (createStripeSandbox / createRedsysSandbox) son deterministas y respetan la
// máquina de estados autorizar → capturar | anular; tokenizeFromReference y los
// mapeos puros nunca devuelven un PAN; el modo test real envía
// capture_method=manual + request_extended_authorization=if_available (Stripe)
// y DS_MERCHANT_TRANSACTIONTYPE 1/2/9 (Redsys). Sin base de datos, sin red.
// Desde apps/api:
//   node --import tsx --test src/modules/payments/__tests__/psp-authorize.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sandboxPspRegistry } from "../psp/index.js";
import {
  authorizationNotConfigured,
  clampCaptureWindowDays,
  looksLikePan,
  PSP_AUTHORIZATION_MAX_DAYS,
  PSP_AUTHORIZATION_MIN_DAYS,
  pspSupportsAuthorization,
  type PspAdapter,
  type PspAuthorizationInput
} from "../psp/psp.types.js";
import {
  cardTokenFromRedsysParams,
  createRedsysSandbox,
  decodeMerchantParameters,
  encodeMerchantParameters,
  RedsysAdapter,
  REDSYS_SANDBOX_SECRET_KEY,
  REDSYS_TRANSACTION_TYPES,
  redsysResponseAccepted,
  redsysSign,
  REDSYS_SIGNATURE_VERSION,
  verifyRedsysRequest
} from "../psp/redsys.adapter.js";
import { cardTokenFromPaymentMethod, createStripeSandbox, mapStripeAuthorization, mapStripeEvent, sandboxLast4, StripeAdapter } from "../psp/stripe.adapter.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const fixedNow = () => NOW;

function authorizationInput(overrides: Partial<PspAuthorizationInput> = {}): PspAuthorizationInput {
  return { folioId: "folio_w5a_1", intentId: "pi_local_w5a_1", amount: "100.00", currency: "EUR", reservationCode: "CHK-W5A-1", captureWindowDays: 3, returnUrl: "https://portal.example.test/ok", cancelUrl: "https://portal.example.test/ko", notifyUrl: "https://api.example.test/payments/webhooks/x", ...overrides };
}

const neverFetch = (async () => {
  throw new Error("la red no debe tocarse");
}) as unknown as typeof fetch;

describe("W5-A · sin configuración: authorize devuelve failed y el adaptador sigue configured:false", () => {
  it("Stripe sin STRIPE_SECRET_KEY: failed + error, sin red, y pspSupportsAuthorization false", async () => {
    const adapter = new StripeAdapter(null, neverFetch);
    assert.equal(adapter.status().configured, false);
    const result = await adapter.authorize(authorizationInput());
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /STRIPE_SECRET_KEY/);
    assert.equal(result.providerReference, "");
    assert.equal(result.card, null);
    assert.equal(pspSupportsAuthorization(adapter), false, "sin credenciales no hay preautorización aunque el método exista");
    await assert.rejects(() => adapter.captureAuthorization("pi_x"), /STRIPE_SECRET_KEY/);
    await assert.rejects(() => adapter.releaseAuthorization("pi_x"), /STRIPE_SECRET_KEY/);
    await assert.rejects(() => adapter.tokenizeFromReference("pi_x"), /STRIPE_SECRET_KEY/);
  });

  it("Redsys sin REDSYS_MERCHANT_CODE / REDSYS_SECRET_KEY: failed + error, sin red", async () => {
    const adapter = new RedsysAdapter(null, neverFetch);
    assert.equal(adapter.status().configured, false);
    const result = await adapter.authorize(authorizationInput({ paymentMethodRef: "tok_ref_1" }));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /REDSYS_MERCHANT_CODE/);
    assert.equal(pspSupportsAuthorization(adapter), false);
    assert.deepEqual(authorizationNotConfigured("redsys", "x").status, "failed");
  });

  it("un adaptador de solo enlaces (sin la extensión) no soporta preautorización aunque esté configurado", () => {
    const linkOnly: PspAdapter = {
      provider: "stripe",
      status: () => ({ configured: true, provider: "stripe", mode: "test", webhookSecretConfigured: true, message: "fake" }),
      async createPaymentLink() {
        return { providerReference: "cs_1", redirect: { method: "GET", url: "https://x" }, expiresAt: null };
      },
      async capture(ref) {
        return { status: "pending", providerReference: ref, capturedAt: null, error: null };
      },
      async refund(input) {
        return { status: "refunded", providerReference: input.idempotencyKey, error: null };
      },
      verifyWebhook() {
        return { ok: false, reason: "fake" };
      }
    };
    assert.equal(pspSupportsAuthorization(linkOnly), false);
    assert.equal(pspSupportsAuthorization(null), false);
    assert.equal(pspSupportsAuthorization(createStripeSandbox().adapter), true);
    assert.equal(pspSupportsAuthorization(createRedsysSandbox().adapter), true);
  });

  it("clampCaptureWindowDays acota a [7, 30]", () => {
    assert.equal(clampCaptureWindowDays(1), PSP_AUTHORIZATION_MIN_DAYS);
    assert.equal(clampCaptureWindowDays(12.2), 13);
    assert.equal(clampCaptureWindowDays(90), PSP_AUTHORIZATION_MAX_DAYS);
    assert.equal(clampCaptureWindowDays(Number.NaN), PSP_AUTHORIZATION_MIN_DAYS);
  });
});

describe("W5-A · sandbox Stripe: authorize → capture → release deterministas", () => {
  it("token guardado: authorized con pi_sandbox_ determinista, capture_before a 30 días y captura total", async () => {
    const { adapter, state } = createStripeSandbox({ now: fixedNow });
    assert.equal(adapter.status().configured, true);
    assert.match(adapter.status().message, /SANDBOX/);
    const first = await adapter.authorize(authorizationInput({ paymentMethodRef: "pm_sandbox_titular" }));
    assert.equal(first.status, "authorized", JSON.stringify(first));
    assert.match(first.providerReference, /^pi_sandbox_[0-9a-f]{12}$/);
    assert.equal(first.expiresAt, new Date(NOW.getTime() + PSP_AUTHORIZATION_MAX_DAYS * 86_400_000).toISOString(), "extended authorization: 30 días");
    assert.ok(first.card, "el sandbox expande payment_method");
    assert.equal(first.card!.tokenRef, "pm_sandbox_titular");
    assert.equal(first.card!.brand, "visa");
    assert.match(first.card!.last4, /^[0-9]{4}$/);
    const again = await adapter.authorize(authorizationInput({ paymentMethodRef: "pm_sandbox_titular" }));
    assert.equal(again.providerReference, first.providerReference, "misma clave de idempotencia → mismo PaymentIntent");
    assert.equal(state.intents.size, 1);
    const request = state.calls.find((call) => call.method === "POST" && call.path === "/payment_intents");
    assert.ok(request);
    assert.equal(request!.body.capture_method, "manual");
    assert.equal(request!.body["payment_method_options[card][request_extended_authorization]"], "if_available");
    assert.equal(request!.body.confirm, "true");
    assert.equal(request!.body.off_session, "true");

    const partial = await adapter.captureAuthorization(first.providerReference, "40.00");
    assert.equal(partial.status, "captured");
    assert.equal(state.intents.get(first.providerReference)!.amount_received, 4000);
    const twice = await adapter.captureAuthorization(first.providerReference);
    assert.equal(twice.status, "failed", "una autorización ya capturada no se captura otra vez");
    const release = await adapter.releaseAuthorization(first.providerReference);
    assert.equal(release.status, "failed", "capturada → no se puede anular");
  });

  it("release libera la autorización y la deja incapturable; tokenizeFromReference devuelve pm_… y nunca un PAN", async () => {
    const { adapter } = createStripeSandbox({ now: fixedNow });
    const auth = await adapter.authorize(authorizationInput({ paymentMethodRef: "pm_sandbox_otro", idempotencyKey: "w5a-release" }));
    assert.equal(auth.status, "authorized");
    const token = await adapter.tokenizeFromReference(auth.providerReference);
    assert.ok(token);
    assert.equal(token!.tokenRef, "pm_sandbox_otro");
    assert.equal(looksLikePan(token!.tokenRef), false);
    assert.equal(looksLikePan(token!.last4), false);
    assert.equal(token!.last4, sandboxLast4("pm_sandbox_otro"));
    assert.equal(token!.expiryYear, NOW.getUTCFullYear() + 3);
    const release = await adapter.releaseAuthorization(auth.providerReference);
    assert.deepEqual(release, { status: "released", providerReference: auth.providerReference, error: null });
    const capture = await adapter.captureAuthorization(auth.providerReference);
    assert.equal(capture.status, "failed");
  });

  it("sin token: pending + página alojada (cs_sandbox_); al completarla el titular, la captura y el token funcionan por cs_", async () => {
    const { adapter, state } = createStripeSandbox({ now: fixedNow });
    const pending = await adapter.authorize(authorizationInput({ idempotencyKey: "w5a-hosted" }));
    assert.equal(pending.status, "pending");
    assert.match(pending.providerReference, /^cs_sandbox_/);
    assert.deepEqual(pending.redirect, { method: "GET", url: `https://checkout.stripe.com/sandbox/${pending.providerReference}` });
    const request = state.calls.find((call) => call.path === "/checkout/sessions");
    assert.equal(request!.body["payment_intent_data[capture_method]"], "manual");
    assert.equal(request!.body["payment_method_options[card][request_extended_authorization]"], "if_available");
    assert.equal(request!.body.client_reference_id, "pi_local_w5a_1");
    assert.equal(await adapter.tokenizeFromReference(pending.providerReference), null, "antes de completar la página no hay tarjeta: null, no un token inventado");
    assert.equal((await adapter.captureAuthorization(pending.providerReference)).status, "failed", "sin completar no hay nada que capturar");
    const intent = state.completeCheckout(pending.providerReference);
    assert.ok(intent && intent.status === "requires_capture");
    const token = await adapter.tokenizeFromReference(pending.providerReference);
    assert.ok(token && /^pm_sandbox_/.test(token.tokenRef));
    const captured = await adapter.captureAuthorization(pending.providerReference);
    assert.equal(captured.status, "captured");
    assert.equal(captured.providerReference, intent!.id);
  });

  it("modo test real (fetch inyectado): PaymentIntent con captura manual, autorización extendida e Idempotency-Key", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new StripeAdapter({ secretKey: "sk_test_abc", webhookSecret: null, mode: "test" }, (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "pi_real_1", status: "requires_capture", amount: 10000, currency: "eur", payment_method: { id: "pm_real_1", type: "card", card: { brand: "mastercard", last4: "4444", exp_month: 3, exp_year: 2029 } }, latest_charge: { id: "ch_1", payment_method_details: { card: { capture_before: 1790000000 } } } }), { status: 200 });
    }) as typeof fetch);
    const result = await adapter.authorize(authorizationInput({ paymentMethodRef: "pm_real_1", idempotencyKey: "pi_local_w5a_1" }));
    assert.equal(result.status, "authorized");
    assert.equal(result.expiresAt, new Date(1790000000 * 1000).toISOString());
    assert.deepEqual(result.card, { tokenRef: "pm_real_1", last4: "4444", brand: "mastercard", expiryMonth: 3, expiryYear: 2029 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://api.stripe.com/v1/payment_intents");
    const headers = requests[0]!.init.headers as Record<string, string>;
    assert.equal(headers["Idempotency-Key"], "auth:pi_local_w5a_1");
    const form = new URLSearchParams(String(requests[0]!.init.body));
    assert.equal(form.get("capture_method"), "manual");
    assert.equal(form.get("payment_method_options[card][request_extended_authorization]"), "if_available");
    assert.equal(form.get("amount"), "10000");
    assert.equal(form.get("metadata[intentId]"), "pi_local_w5a_1");
    assert.equal(form.get("expand[]"), "latest_charge");
  });

  it("mapeos puros: succeeded en la creación no es una garantía; amount_capturable_updated y Checkout «unpaid» se ignoran (no son cobros)", () => {
    assert.equal(mapStripeAuthorization({ id: "pi_1", status: "succeeded" }).status, "failed");
    assert.equal(mapStripeAuthorization({ id: "pi_1", status: "requires_action" }).status, "pending");
    assert.equal(mapStripeAuthorization({ id: "pi_1", status: "canceled", last_payment_error: { message: "card_declined" } }).error, "card_declined");
    const capturable = mapStripeEvent({ type: "payment_intent.amount_capturable_updated", data: { object: { id: "pi_1" } } });
    assert.ok(capturable.ok && capturable.event.type === "ignored" && /no es un cobro/.test(capturable.event.reason));
    const unpaid = mapStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "unpaid" } } });
    assert.ok(unpaid.ok && unpaid.event.type === "ignored");
  });
});

describe("W5-A · sandbox Redsys: tipo 1 → 2 | 9 deterministas y firmados", () => {
  it("pago por referencia: authorized (0000) con token, capture (0900) y una segunda confirmación falla", async () => {
    const { adapter, state } = createRedsysSandbox({ now: fixedNow });
    assert.equal(adapter.status().configured, true);
    assert.match(adapter.status().message, /SANDBOX/);
    const auth = await adapter.authorize(authorizationInput({ paymentMethodRef: "sandbox_redsys_tok1" }));
    assert.equal(auth.status, "authorized", JSON.stringify(auth));
    assert.match(auth.providerReference, /^[0-9]{4}[0-9A-F]{8}$/, "DS_MERCHANT_ORDER de 12 caracteres, 4 numéricos");
    assert.equal(auth.expiresAt, null, "el SIS no comunica la caducidad: null, honesto");
    assert.ok(auth.card);
    assert.equal(auth.card!.tokenRef, "sandbox_redsys_tok1");
    assert.equal(auth.card!.brand, "visa");
    assert.match(auth.card!.last4, /^[0-9]{4}$/);
    assert.equal(auth.card!.expiryYear, NOW.getUTCFullYear() + 3);
    assert.equal(auth.card!.expiryMonth, 12);
    const request = state.calls[0]!;
    assert.equal(request.DS_MERCHANT_TRANSACTIONTYPE, REDSYS_TRANSACTION_TYPES.authorization);
    assert.equal(request.DS_MERCHANT_IDENTIFIER, "sandbox_redsys_tok1");
    assert.equal(request.DS_MERCHANT_DIRECTPAYMENT, "true");
    assert.equal(request.DS_MERCHANT_AMOUNT, "10000");
    const same = await adapter.authorize(authorizationInput({ paymentMethodRef: "sandbox_redsys_tok1" }));
    assert.equal(same.providerReference, auth.providerReference, "el mismo intento deriva el mismo pedido");
    assert.equal(same.status, "failed", "el SIS rechaza el pedido repetido (SIS0051): nunca se inventa una segunda autorización");
    assert.deepEqual(await adapter.tokenizeFromReference(auth.providerReference), auth.card);

    const captured = await adapter.captureAuthorization(auth.providerReference);
    assert.equal(captured.status, "captured");
    assert.equal(state.calls.at(-1)!.DS_MERCHANT_TRANSACTIONTYPE, REDSYS_TRANSACTION_TYPES.confirmation);
    assert.equal(state.calls.at(-1)!.DS_MERCHANT_AMOUNT, "10000", "confirmación por el importe preautorizado");
    const twice = await adapter.captureAuthorization(auth.providerReference);
    assert.equal(twice.status, "failed");
    assert.match(twice.error ?? "", /SIS0054/);
    const release = await adapter.releaseAuthorization(auth.providerReference);
    assert.equal(release.status, "failed", "confirmada → no se anula");
  });

  it("release (tipo 9, 0400) libera la preautorización; sin importe conocido la anulación es un failed honesto", async () => {
    const { adapter, state } = createRedsysSandbox({ now: fixedNow });
    const auth = await adapter.authorize(authorizationInput({ paymentMethodRef: "sandbox_redsys_tok2", idempotencyKey: "w5a-redsys-release" }));
    assert.equal(auth.status, "authorized");
    const release = await adapter.releaseAuthorization(auth.providerReference);
    assert.deepEqual(release, { status: "released", providerReference: auth.providerReference, error: null });
    assert.equal(state.calls.at(-1)!.DS_MERCHANT_TRANSACTIONTYPE, REDSYS_TRANSACTION_TYPES.release);
    assert.equal((await adapter.captureAuthorization(auth.providerReference)).status, "failed");

    const fresh = createRedsysSandbox({ now: fixedNow }).adapter;
    const unknown = await fresh.releaseAuthorization("0000ABCDEF12");
    assert.equal(unknown.status, "failed");
    assert.match(unknown.error ?? "", /importe original/);
    const withAmount = await fresh.releaseAuthorization("0000ABCDEF12", "10.00");
    assert.equal(withAmount.status, "failed");
    assert.match(withAmount.error ?? "", /SIS0054/, "el sandbox no conoce ese pedido");
    assert.equal(await fresh.tokenizeFromReference("0000ABCDEF12"), null, "sin respuesta ni notificación no hay token: null");
  });

  it("sin token: pending + formulario alojado tipo 1 con DS_MERCHANT_IDENTIFIER=REQUIRED; la notificación tipo 1 se ignora (no es un cobro) y entrega el token", async () => {
    const { adapter } = createRedsysSandbox({ now: fixedNow });
    const pending = await adapter.authorize(authorizationInput({ idempotencyKey: "w5a-redsys-hosted" }));
    assert.equal(pending.status, "pending");
    assert.equal(pending.redirect?.method, "POST");
    assert.match(pending.redirect!.url, /sis-t\.redsys\.es/);
    const fields = (pending.redirect as { fields: Record<string, string> }).fields;
    const verified = verifyRedsysRequest(REDSYS_SANDBOX_SECRET_KEY, fields);
    assert.ok(verified.ok, "el formulario alojado va firmado con la clave del comercio");
    assert.equal(verified.params.DS_MERCHANT_TRANSACTIONTYPE, "1");
    assert.equal(verified.params.DS_MERCHANT_IDENTIFIER, "REQUIRED");
    assert.equal(verified.params.DS_MERCHANT_ORDER, pending.providerReference);
    assert.equal(verified.params.DS_MERCHANT_MERCHANTDATA, "pi_local_w5a_1");

    // Notificación online del SIS para esa preautorización, firmada como lo hace el SIS.
    const params = { Ds_Amount: "10000", Ds_Currency: "978", Ds_Order: pending.providerReference, Ds_MerchantCode: "999008881", Ds_Terminal: "001", Ds_Response: "0000", Ds_TransactionType: "1", Ds_MerchantData: "pi_local_w5a_1", Ds_Merchant_Identifier: "sandbox_redsys_hosted", Ds_ExpiryDate: "2912", Ds_Card_Number: "454881******0004", Ds_Card_Brand: "2" };
    const merchantParameters = encodeMerchantParameters(params);
    const body = new URLSearchParams({ Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: merchantParameters, Ds_Signature: redsysSign(REDSYS_SANDBOX_SECRET_KEY, pending.providerReference, merchantParameters) }).toString();
    const event = adapter.verifyWebhook({ rawBody: body, headers: {}, contentType: "application/x-www-form-urlencoded" });
    assert.ok(event.ok);
    assert.equal(event.event.type, "ignored", "una preautorización aceptada NO es payment.captured");
    assert.match((event.event as { reason: string }).reason, /Preautorización/);
    assert.deepEqual(await adapter.tokenizeFromReference(pending.providerReference), { tokenRef: "sandbox_redsys_hosted", last4: "0004", brand: "mastercard", expiryMonth: 12, expiryYear: 2029 });

    const confirmation = { ...params, Ds_Response: "0900", Ds_TransactionType: "2" };
    const confirmationParameters = encodeMerchantParameters(confirmation);
    const confirmed = adapter.verifyWebhook({ rawBody: new URLSearchParams({ Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION, Ds_MerchantParameters: confirmationParameters, Ds_Signature: redsysSign(REDSYS_SANDBOX_SECRET_KEY, pending.providerReference, confirmationParameters) }).toString(), headers: {}, contentType: "application/x-www-form-urlencoded" });
    assert.ok(confirmed.ok && confirmed.event.type === "payment.captured", "la confirmación (tipo 2, 0900) sí es el cobro");
    assert.equal((confirmed.event as { amount: string | null }).amount, "100.00");
  });

  it("redsysResponseAccepted por tipo: 0-99 (0/1), 0900 (2/3), 0400 (9)", () => {
    assert.equal(redsysResponseAccepted("0000", "1"), true);
    assert.equal(redsysResponseAccepted("0099", "0"), true);
    assert.equal(redsysResponseAccepted("0180", "1"), false);
    assert.equal(redsysResponseAccepted("0900", "2"), true);
    assert.equal(redsysResponseAccepted("0000", "2"), false);
    assert.equal(redsysResponseAccepted("0400", "9"), true);
    assert.equal(redsysResponseAccepted("0900", "9"), false);
    assert.equal(redsysResponseAccepted("0900", "3"), true);
    assert.equal(redsysResponseAccepted(undefined, "1"), false);
  });

  it("sandboxPspRegistry devuelve una instancia estable por proveedor (el estado sobrevive entre llamadas)", async () => {
    const registry = sandboxPspRegistry({ now: fixedNow });
    const stripe = registry.stripe();
    assert.equal(registry.stripe(), stripe);
    const auth = await stripe.authorize!(authorizationInput({ paymentMethodRef: "pm_sandbox_reg", idempotencyKey: "w5a-registry" }));
    assert.equal(auth.status, "authorized");
    assert.equal((await registry.stripe().captureAuthorization!(auth.providerReference)).status, "captured");
    assert.equal(registry.stripeState.intents.get(auth.providerReference)!.status, "succeeded");
    assert.equal(registry.redsys(), registry.redsys());
  });
});

describe("W5-A · tokenizeFromReference nunca devuelve un PAN", () => {
  it("looksLikePan detecta números de tarjeta completos y deja pasar tokens y últimos 4", () => {
    assert.equal(looksLikePan("4242424242424242"), true);
    assert.equal(looksLikePan("4242 4242 4242 4242"), true);
    assert.equal(looksLikePan("4242-4242-4242-4242"), true);
    assert.equal(looksLikePan("4242"), false);
    assert.equal(looksLikePan("pm_1NxYz4242424242424242"), false);
    assert.equal(looksLikePan("sandbox_redsys_abc"), false);
    assert.equal(looksLikePan(4242424242424242), false, "solo cadenas");
  });

  it("Stripe: un payment_method con id o last4 con forma de PAN se descarta; sin tarjeta → null", () => {
    assert.equal(cardTokenFromPaymentMethod({ id: "4242424242424242", card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 } }), null);
    assert.equal(cardTokenFromPaymentMethod({ id: "pm_1", card: { brand: "visa", last4: "4242424242424242", exp_month: 1, exp_year: 2030 } }), null);
    assert.equal(cardTokenFromPaymentMethod({ id: "pm_1", type: "sepa_debit" }), null);
    assert.equal(cardTokenFromPaymentMethod("pm_1"), null, "sin expandir no hay datos de tarjeta");
    assert.deepEqual(cardTokenFromPaymentMethod({ id: "pm_1", card: { brand: "Visa", last4: "0004", exp_month: 2, exp_year: 2031 } }), { tokenRef: "pm_1", last4: "0004", brand: "visa", expiryMonth: 2, expiryYear: 2031 });
  });

  it("Redsys: Ds_Card_Number completo o Ds_Merchant_Identifier con forma de PAN → null; enmascarado → solo últimos 4", () => {
    const base = { Ds_Merchant_Identifier: "tok_abc", Ds_ExpiryDate: "2806", Ds_Card_Number: "454881******0004", Ds_Card_Brand: "1" };
    assert.deepEqual(cardTokenFromRedsysParams(base), { tokenRef: "tok_abc", last4: "0004", brand: "visa", expiryMonth: 6, expiryYear: 2028 });
    assert.equal(cardTokenFromRedsysParams({ ...base, Ds_Card_Number: "4548810000000004" }), null, "un PAN completo se descarta entero");
    assert.equal(cardTokenFromRedsysParams({ ...base, Ds_Merchant_Identifier: "4548810000000004" }), null);
    assert.equal(cardTokenFromRedsysParams({ ...base, Ds_Merchant_Identifier: "REQUIRED" }), null, "REQUIRED es la petición, no un token");
    assert.equal(cardTokenFromRedsysParams({ ...base, Ds_ExpiryDate: "28/06" }), null);
    assert.equal(cardTokenFromRedsysParams({ ...base, Ds_Card_Brand: "77" })!.brand, "card");
    assert.equal(cardTokenFromRedsysParams({}), null);
  });

  it("los sandboxes solo emiten tokens sandbox_/pm_sandbox_ y 4 dígitos; ninguna respuesta lleva 12+ dígitos seguidos", async () => {
    const stripe = createStripeSandbox({ now: fixedNow });
    const redsys = createRedsysSandbox({ now: fixedNow });
    const stripeAuth = await stripe.adapter.authorize(authorizationInput({ paymentMethodRef: "pm_sandbox_pan" }));
    const redsysAuth = await redsys.adapter.authorize(authorizationInput({ paymentMethodRef: "sandbox_redsys_pan" }));
    for (const result of [stripeAuth, redsysAuth]) {
      assert.equal(result.status, "authorized");
      assert.doesNotMatch(JSON.stringify(result), /[0-9]{12,}/, `sin PAN en ${result.providerReference}`);
      assert.equal(looksLikePan(result.card!.tokenRef), false);
      assert.match(result.card!.last4, /^[0-9]{4}$/);
    }
    const decoded = decodeMerchantParameters(encodeMerchantParameters(redsys.state.calls[0]!));
    assert.ok(decoded && !("DS_MERCHANT_PAN" in decoded), "el adaptador nunca envía DS_MERCHANT_PAN");
  });
});
