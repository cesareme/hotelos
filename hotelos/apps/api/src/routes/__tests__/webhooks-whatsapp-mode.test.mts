// Corrector Tanda CHK (SEC-5): el modo sin firma del webhook de WhatsApp depende de
// una variable explícita (WHATSAPP_WEBHOOK_ALLOW_UNSIGNED) y nunca de NODE_ENV a
// secas. Funciones puras, sin BD ni red:
//   node --import tsx --test src/routes/__tests__/webhooks-whatsapp-mode.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WHATSAPP_ALLOW_UNSIGNED_ENV, parseWhatsappWebhook, signWhatsappPayload, unsignedWebhookMode, verifyWhatsappSignature } from "../webhooks-whatsapp.routes.js";

describe("unsignedWebhookMode (SEC-5)", () => {
  it("con secreto → signed en cualquier entorno (la variable no lo relaja)", () => {
    assert.equal(unsignedWebhookMode({ NODE_ENV: "production", WHATSAPP_APP_SECRET: "s3cret" }), "signed");
    assert.equal(unsignedWebhookMode({ NODE_ENV: "development", WHATSAPP_APP_SECRET: "s3cret", WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "1" }), "signed");
  });
  it("sin secreto → refused salvo la variable explícita fuera de producción", () => {
    assert.equal(unsignedWebhookMode({ NODE_ENV: "development" }), "refused");
    assert.equal(unsignedWebhookMode({ NODE_ENV: "test", WHATSAPP_APP_SECRET: "  " }), "refused");
    assert.equal(unsignedWebhookMode({ NODE_ENV: "development", WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "1" }), "simulated");
    assert.equal(unsignedWebhookMode({ NODE_ENV: "development", WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "true" }), "simulated");
    assert.equal(unsignedWebhookMode({ NODE_ENV: "development", WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "yes" }), "refused");
    assert.equal(unsignedWebhookMode({ NODE_ENV: "production", WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "1" }), "refused", "en producción la variable no tiene efecto");
    assert.equal(WHATSAPP_ALLOW_UNSIGNED_ENV, "WHATSAPP_WEBHOOK_ALLOW_UNSIGNED");
  });
  it("la firma sigue siendo HMAC-SHA256 sobre el cuerpo crudo", () => {
    const raw = JSON.stringify({ entry: [] });
    assert.equal(verifyWhatsappSignature(raw, signWhatsappPayload(raw, "k"), "k"), true);
    assert.equal(verifyWhatsappSignature(raw, signWhatsappPayload(raw, "k"), "other"), false);
    assert.deepEqual(parseWhatsappWebhook({ entry: [] }), []);
  });
});
