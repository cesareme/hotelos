// Corrector Tanda CHK (SEC-1): el dispatcher NUNCA persiste el token del enlace
// mágico ni el código OTP en notification_deliveries. Funciones puras, sin BD:
//   node --import tsx --test src/modules/notifications/__tests__/dispatcher-redaction.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED_MARK, isRedactedDelivery, redactRendered, redactVariables } from "../dispatcher.service.js";

const TOKEN = "a".repeat(32) + "b".repeat(32);
const URL = `http://127.0.0.1:5189/checkin?token=${TOKEN}&property=prop_chk`;

describe("dispatcher · redacción de secretos en la copia persistida (SEC-1)", () => {
  it("redactRendered sustituye cada aparición del secreto (y su forma URL-codificada) y respeta el resto del texto", () => {
    const body = `Hola Ana, tu enlace: ${URL} · código 123456 · ${encodeURIComponent(TOKEN)}`;
    const stored = redactRendered(body, [TOKEN, "123456"]);
    assert.equal(stored, `Hola Ana, tu enlace: http://127.0.0.1:5189/checkin?token=${REDACTED_MARK}&property=prop_chk · código ${REDACTED_MARK} · ${REDACTED_MARK}`);
    assert.doesNotMatch(stored, /[0-9a-f]{64}/);
    // Secretos demasiado cortos (< 4) no se sustituyen a ciegas (romperían el texto).
    assert.equal(redactRendered("a1 a1 a1", ["a1"]), "a1 a1 a1");
  });

  it("redactVariables enmascara las variables secretas y limpia los valores secretos de las demás cadenas", () => {
    const variables = { guestFirstName: "Ana", checkInUrl: URL, note: `copia ${TOKEN}`, otpCode: "123456", expiryHours: 24 };
    const stored = redactVariables(variables, { variables: ["checkInUrl", "otpCode"], values: [TOKEN, "123456"] });
    assert.deepEqual(stored, { guestFirstName: "Ana", checkInUrl: REDACTED_MARK, note: `copia ${REDACTED_MARK}`, otpCode: REDACTED_MARK, expiryHours: 24 });
    assert.deepEqual(redactVariables(variables, undefined), variables);
    assert.doesNotMatch(JSON.stringify(stored), /[0-9a-f]{64}|123456/);
  });

  it("isRedactedDelivery lee la marca del payloadJson (una fila redactada no se reintenta desde su cuerpo guardado)", () => {
    assert.equal(isRedactedDelivery({ variables: {}, redacted: true }), true);
    assert.equal(isRedactedDelivery({ variables: {} }), false);
    assert.equal(isRedactedDelivery(null), false);
    assert.equal(isRedactedDelivery([]), false);
  });
});
