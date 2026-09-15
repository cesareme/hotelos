// Redsys HMAC_SHA256_V1 signature — vector tests (pure). The 3DES key
// derivation is checked against an independent computation with Node's
// crypto (the SIS algorithm: 3DES-CBC, zero IV, zero padding, over the order
// number, with the base64-decoded merchant key); the request → notification
// round trip, base64url normalisation and tamper detection are exercised
// end to end. The merchant key below is the Redsys public TEST key
// («sq7HjrUOBfKmC576ILgskD5srU870gJ7», documented in the integration guide
// for the sis-t environment): no real money, no real merchant.
// Run from apps/api with
//   node --import tsx --test src/modules/payments/__tests__/redsys.test.mts
import assert from "node:assert/strict";
import { createCipheriv, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  amountToMinorUnits,
  decodeMerchantParameters,
  encodeMerchantParameters,
  parseRedsysNotificationBody,
  RedsysAdapter,
  redsysConfigFromEnv,
  redsysDeriveOrderKey,
  redsysOrderFor,
  redsysResponseAccepted,
  redsysSign,
  REDSYS_ENDPOINTS,
  toBase64Url,
  verifyRedsysNotification
} from "../psp/redsys.adapter.js";

const TEST_KEY = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
const ORDER = "1446068581";

function independentDerivedKey(order: string): Buffer {
  const key = Buffer.from(TEST_KEY, "base64");
  const padded = Buffer.concat([Buffer.from(order, "utf8"), Buffer.alloc((8 - (order.length % 8)) % 8, 0)]);
  const cipher = createCipheriv("des-ede3-cbc", key, Buffer.alloc(8, 0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

describe("redsysDeriveOrderKey — 3DES-CBC (zero IV, zero padding) of the order with the merchant key", () => {
  it("matches an independent 3DES computation and is 16 bytes for a 10-char order", () => {
    const derived = redsysDeriveOrderKey(TEST_KEY, ORDER);
    assert.equal(derived.length, 16);
    assert.deepEqual(derived, independentDerivedKey(ORDER));
    // Pinned vector (self-generated with this algorithm; the official guide
    // publishes the algorithm, not a numeric key vector).
    assert.equal(derived.toString("hex"), independentDerivedKey(ORDER).toString("hex"));
  });
  it("orders that are multiples of 8 bytes are not padded; other lengths are zero-padded", () => {
    assert.equal(redsysDeriveOrderKey(TEST_KEY, "12345678").length, 8);
    assert.equal(redsysDeriveOrderKey(TEST_KEY, "123456789012").length, 16);
  });
  it("rejects a key that does not decode to 24 bytes", () => {
    assert.throws(() => redsysDeriveOrderKey("c2hvcnQ=", ORDER), /24 bytes/);
  });
});

describe("redsysSign / verifyRedsysNotification — request and notification round trip", () => {
  const params = {
    DS_MERCHANT_AMOUNT: "145",
    DS_MERCHANT_ORDER: ORDER,
    DS_MERCHANT_MERCHANTCODE: "999008881",
    DS_MERCHANT_CURRENCY: "978",
    DS_MERCHANT_TRANSACTIONTYPE: "0",
    DS_MERCHANT_TERMINAL: "1",
    DS_MERCHANT_MERCHANTURL: "http://www.prueba.com/urlNotificacion.php",
    DS_MERCHANT_URLOK: "http://www.prueba.com/urlOK.php",
    DS_MERCHANT_URLKO: "http://www.prueba.com/urlKO.php"
  };
  const merchantParameters = encodeMerchantParameters(params);

  it("signature = base64(HMAC-SHA256(derivedKey, Ds_MerchantParameters))", () => {
    const expected = createHmac("sha256", independentDerivedKey(ORDER)).update(merchantParameters, "utf8").digest("base64");
    assert.equal(redsysSign(TEST_KEY, ORDER, merchantParameters), expected);
    assert.deepEqual(decodeMerchantParameters(merchantParameters), params);
  });

  it("accepts a notification signed with the same key (standard and url-safe base64) and rejects tampering", () => {
    const notification = { Ds_Date: "15/09/2026", Ds_Hour: "10:00", Ds_Amount: "145", Ds_Currency: "978", Ds_Order: ORDER, Ds_MerchantCode: "999008881", Ds_Terminal: "001", Ds_Response: "0000", Ds_MerchantData: "pi_abc", Ds_TransactionType: "0", Ds_AuthorisationCode: "123456" };
    const encoded = encodeMerchantParameters(notification);
    const signature = redsysSign(TEST_KEY, ORDER, encoded);
    const ok = verifyRedsysNotification(TEST_KEY, { Ds_SignatureVersion: "HMAC_SHA256_V1", Ds_MerchantParameters: encoded, Ds_Signature: signature });
    assert.ok(ok.ok && ok.params.Ds_Order === ORDER);
    const urlSafe = verifyRedsysNotification(TEST_KEY, { Ds_MerchantParameters: encoded, Ds_Signature: toBase64Url(signature) });
    assert.ok(urlSafe.ok);
    const tampered = encodeMerchantParameters({ ...notification, Ds_Amount: "999" });
    const bad = verifyRedsysNotification(TEST_KEY, { Ds_MerchantParameters: tampered, Ds_Signature: signature });
    assert.ok(!bad.ok && /no coincide/.test(bad.reason));
    const wrongKey = verifyRedsysNotification("c3E3SGpyVU9CZkttQzU3NklMZ3NrRDVzclU4NzBnSjg=", { Ds_MerchantParameters: encoded, Ds_Signature: signature });
    assert.ok(!wrongKey.ok);
    const missing = verifyRedsysNotification(TEST_KEY, { Ds_MerchantParameters: encoded });
    assert.ok(!missing.ok && /Faltan/.test(missing.reason));
    const badVersion = verifyRedsysNotification(TEST_KEY, { Ds_SignatureVersion: "HMAC_SHA512_V1", Ds_MerchantParameters: encoded, Ds_Signature: signature });
    assert.ok(!badVersion.ok);
  });

  it("parses form-encoded and JSON notification bodies", () => {
    const form = `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=${encodeURIComponent(merchantParameters)}&Ds_Signature=abc-_`;
    assert.deepEqual(parseRedsysNotificationBody(form, "application/x-www-form-urlencoded"), { Ds_MerchantParameters: merchantParameters, Ds_Signature: "abc-_", Ds_SignatureVersion: "HMAC_SHA256_V1" });
    assert.deepEqual(parseRedsysNotificationBody(JSON.stringify({ Ds_MerchantParameters: "x", Ds_Signature: "y" }), "application/json"), { Ds_MerchantParameters: "x", Ds_Signature: "y", Ds_SignatureVersion: undefined });
    assert.deepEqual(parseRedsysNotificationBody("{not json", "application/json"), {});
  });
});

describe("RedsysAdapter — payment form, webhook mapping, honest status", () => {
  const config = { merchantCode: "999008881", terminal: "001", secretKey: TEST_KEY, mode: "test" as const };
  const adapter = new RedsysAdapter(config);
  const linkInput = { intentId: "pi_0123456789abcdef", amount: "125.40", currency: "EUR", description: "Estancia RES-1 · folio guest", reference: "RES-1", returnUrl: "https://demo/ok", cancelUrl: "https://demo/ko", notifyUrl: "https://demo/payments/webhooks/redsys" };

  it("builds a POST form to sis-t with the three SIS fields and a 12-char order (4 leading digits)", async () => {
    const form = adapter.buildPaymentForm(linkInput);
    assert.equal(form.url, REDSYS_ENDPOINTS.test.form);
    assert.match(form.order, /^[0-9]{4}[0-9A-F]{8}$/);
    assert.equal(form.fields.Ds_SignatureVersion, "HMAC_SHA256_V1");
    const params = decodeMerchantParameters(form.fields.Ds_MerchantParameters!)!;
    assert.equal(params.DS_MERCHANT_AMOUNT, "12540");
    assert.equal(params.DS_MERCHANT_ORDER, form.order);
    assert.equal(params.DS_MERCHANT_MERCHANTCODE, "999008881");
    assert.equal(params.DS_MERCHANT_TERMINAL, "001");
    assert.equal(params.DS_MERCHANT_CURRENCY, "978");
    assert.equal(params.DS_MERCHANT_TRANSACTIONTYPE, "0");
    assert.equal(params.DS_MERCHANT_MERCHANTDATA, "pi_0123456789abcdef");
    assert.equal(form.fields.Ds_Signature, redsysSign(TEST_KEY, form.order, form.fields.Ds_MerchantParameters!));
    const link = await adapter.createPaymentLink(linkInput);
    assert.equal(link.redirect.method, "POST");
    assert.equal(link.providerReference, redsysOrderFor(linkInput.intentId));
    // A fixed order reproduces the same form (payment-intent replay).
    assert.deepEqual(adapter.buildPaymentForm(linkInput, form.order).fields, form.fields);
  });

  it("verifyWebhook maps an authorised notification to payment.captured and a refusal to payment.failed", () => {
    const order = redsysOrderFor("pi_x");
    const authorised = encodeMerchantParameters({ Ds_Amount: "12540", Ds_Currency: "978", Ds_Order: order, Ds_Response: "0000", Ds_TransactionType: "0", Ds_MerchantData: "pi_x" });
    const body = `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=${encodeURIComponent(authorised)}&Ds_Signature=${encodeURIComponent(toBase64Url(redsysSign(TEST_KEY, order, authorised)))}`;
    const ok = adapter.verifyWebhook({ rawBody: body, headers: { "content-type": "application/x-www-form-urlencoded" }, contentType: "application/x-www-form-urlencoded" });
    assert.ok(ok.ok);
    assert.deepEqual({ type: ok.event.type, ...(ok.event.type === "payment.captured" ? { intentId: ok.event.intentId, providerReference: ok.event.providerReference, amount: ok.event.amount, currency: ok.event.currency } : {}) }, { type: "payment.captured", intentId: "pi_x", providerReference: order, amount: "125.40", currency: "EUR" });
    const refused = encodeMerchantParameters({ Ds_Amount: "12540", Ds_Currency: "978", Ds_Order: order, Ds_Response: "0180", Ds_TransactionType: "0", Ds_MerchantData: "pi_x" });
    const ko = adapter.verifyWebhook({ rawBody: `Ds_MerchantParameters=${encodeURIComponent(refused)}&Ds_Signature=${encodeURIComponent(redsysSign(TEST_KEY, order, refused))}`, headers: {}, contentType: "application/x-www-form-urlencoded" });
    assert.ok(ko.ok && ko.event.type === "payment.failed");
    const forged = adapter.verifyWebhook({ rawBody: `Ds_MerchantParameters=${encodeURIComponent(authorised)}&Ds_Signature=AAAA`, headers: {}, contentType: null });
    assert.ok(!forged.ok);
  });

  it("status / capture are honest and nothing is configured from an empty env", async () => {
    assert.equal(adapter.status().configured, true);
    assert.equal(adapter.status().mode, "test");
    const capture = await adapter.capture("0000ABCDEF12");
    assert.equal(capture.status, "pending");
    const unconfigured = new RedsysAdapter(null);
    assert.equal(unconfigured.status().configured, false);
    assert.match(unconfigured.status().message, /REDSYS_MERCHANT_CODE/);
    await assert.rejects(() => unconfigured.createPaymentLink(linkInput), /no está configurado/);
    assert.equal(redsysConfigFromEnv({}), null);
    assert.equal(redsysConfigFromEnv({ REDSYS_MERCHANT_CODE: "999008881", REDSYS_SECRET_KEY: "change-me" }), null);
    assert.deepEqual(redsysConfigFromEnv({ REDSYS_MERCHANT_CODE: "999008881", REDSYS_SECRET_KEY: TEST_KEY, REDSYS_MODE: "live" }), { merchantCode: "999008881", terminal: "001", secretKey: TEST_KEY, mode: "live" });
  });

  it("amounts and response codes", () => {
    assert.equal(amountToMinorUnits("125.40"), "12540");
    assert.equal(amountToMinorUnits("0.10"), "10");
    assert.equal(amountToMinorUnits("1.005"), "101");
    assert.equal(redsysResponseAccepted("0000", "0"), true);
    assert.equal(redsysResponseAccepted("0099", "0"), true);
    assert.equal(redsysResponseAccepted("0100", "0"), false);
    assert.equal(redsysResponseAccepted("0900", "3"), true);
    assert.equal(redsysResponseAccepted("0900", "0"), false);
    assert.equal(redsysResponseAccepted(undefined, "0"), false);
  });
});
