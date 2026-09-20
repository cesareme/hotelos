// Unit tests · Tanda CHK · lote W2-A — emparejamiento de kioscos
// (kiosk.service.ts, funciones puras): código de 8 dígitos, hash, caducidad y
// claim una sola vez. Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/kiosk.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  PAIRING_CODE_LENGTH,
  applyPairingClaim,
  evaluatePairingClaim,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
  hashPairingCode,
  isPairingExpired,
  normalizePairingCode,
  pairingExpiresAt,
  type PairingState
} from "../kiosk.service.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const TTL = 600_000;

describe("código de emparejamiento", () => {
  it("tiene 8 dígitos con ceros a la izquierda y usa el generador inyectado", () => {
    assert.equal(PAIRING_CODE_LENGTH, 8);
    assert.equal(generatePairingCode(() => 42), "00000042");
    assert.equal(generatePairingCode(() => 99_999_999), "99999999");
    const real = generatePairingCode();
    assert.match(real, /^\d{8}$/);
    // El generador por defecto pide un entero en [0, 10^8).
    let seenMax = 0;
    generatePairingCode((max) => {
      seenMax = max;
      return 7;
    });
    assert.equal(seenMax, 100_000_000);
  });

  it("el hash es sha256 hex del código normalizado (espacios y guiones fuera) y nunca el código en claro", () => {
    assert.equal(normalizePairingCode("1234-5678"), "12345678");
    assert.equal(hashPairingCode("1234 5678"), hashPairingCode("12345678"));
    assert.equal(hashPairingCode("12345678"), createHash("sha256").update("12345678").digest("hex"));
    assert.match(hashPairingCode("00000042"), /^[0-9a-f]{64}$/);
    assert.notEqual(hashPairingCode("00000042"), "00000042");
  });

  it("caduca a los KIOSK_PAIRING_TTL_MS: antes no, en el instante sí, sin fecha siempre", () => {
    const expiresAt = pairingExpiresAt(NOW, TTL);
    assert.equal(expiresAt.toISOString(), "2026-09-19T12:10:00.000Z");
    assert.equal(isPairingExpired(expiresAt, new Date(NOW.getTime() + TTL - 1)), false);
    assert.equal(isPairingExpired(expiresAt, expiresAt), true);
    assert.equal(isPairingExpired(null, NOW), true);
  });
});

describe("claim una sola vez", () => {
  const pending = (): PairingState => ({ pairingCodeHash: hashPairingCode("00000042"), pairingExpiresAt: pairingExpiresAt(NOW, TTL), status: "unpaired" });

  it("acepta el código correcto y vigente; rechaza el equivocado, el caducado y el kiosco desactivado", () => {
    assert.deepEqual(evaluatePairingClaim({ device: pending(), code: "00000042", now: NOW }), { ok: true });
    assert.deepEqual(evaluatePairingClaim({ device: pending(), code: "0000-0042", now: NOW }), { ok: true }, "el claim normaliza como el hash");
    assert.deepEqual(evaluatePairingClaim({ device: pending(), code: "00000043", now: NOW }), { ok: false, reason: "mismatch" });
    assert.deepEqual(evaluatePairingClaim({ device: pending(), code: "00000042", now: new Date(NOW.getTime() + TTL) }), { ok: false, reason: "expired" });
    assert.deepEqual(evaluatePairingClaim({ device: { ...pending(), status: "disabled" }, code: "00000042", now: NOW }), { ok: false, reason: "disabled" });
    assert.deepEqual(evaluatePairingClaim({ device: { ...pending(), pairingCodeHash: null }, code: "00000042", now: NOW }), { ok: false, reason: "no_pending_code" });
  });

  it("tras el claim el código se consume, queda solo el hash del token y un segundo claim falla", () => {
    const device = pending();
    const token = generateDeviceToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    const transition = applyPairingClaim(NOW, token);
    assert.equal(transition.deviceTokenHash, hashDeviceToken(token));
    assert.notEqual(transition.deviceTokenHash, token, "el token nunca se guarda en claro");
    assert.equal(transition.status, "online");
    assert.equal(transition.pairedAt, NOW);
    assert.equal(transition.pairingCodeHash, null);
    assert.equal(transition.pairingExpiresAt, null);
    const after: PairingState = { ...device, ...transition };
    assert.deepEqual(evaluatePairingClaim({ device: after, code: "00000042", now: NOW }), { ok: false, reason: "no_pending_code" });
  });

  it("dos tokens distintos nunca comparten hash y el hash ignora espacios exteriores", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    assert.notEqual(a, b);
    assert.notEqual(hashDeviceToken(a), hashDeviceToken(b));
    assert.equal(hashDeviceToken(` ${a} `), hashDeviceToken(a));
  });
});
