// Return-page token (t6#15) — pure vector tests: sign / verify round trip,
// tamper, expiry, cross-intent reuse, missing key, URL helper.
// Run from apps/api with
//   node --import tsx --test src/modules/payments/__tests__/return-token.test.mts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  RETURN_TOKEN_QUERY_PARAM,
  RETURN_TOKEN_TTL_MS,
  returnTokenKey,
  signReturnToken,
  verifyReturnToken,
  withReturnToken
} from "../return-token.js";

const KEY = createHmac("sha256", "unit-test-secret-32chars-minimum-xxxxxxxx").update("hotelos.payments.return.v1", "utf8").digest();
const OTHER_KEY = createHmac("sha256", "another-secret").update("x").digest();
const NOW = Date.parse("2026-09-16T10:00:00Z");
const INTENT = "pi_0123456789abcdef01234567";

describe("returnTokenKey — derived from JWT_SECRET, domain-separated", () => {
  it("is null without a usable secret (missing, blank, example value)", () => {
    assert.equal(returnTokenKey({}), null);
    assert.equal(returnTokenKey({ JWT_SECRET: "   " }), null);
    assert.equal(returnTokenKey({ JWT_SECRET: "change-me" }), null);
  });
  it("is a 32-byte key that differs from the raw secret and matches the documented derivation", () => {
    const key = returnTokenKey({ JWT_SECRET: "unit-test-secret-32chars-minimum-xxxxxxxx" });
    assert.ok(key);
    assert.equal(key.length, 32);
    assert.deepEqual(key, KEY);
    assert.notEqual(key.toString("utf8"), "unit-test-secret-32chars-minimum-xxxxxxxx");
  });
});

describe("signReturnToken / verifyReturnToken", () => {
  it("round-trips: `<exp>.<43-char base64url mac>`, valid until exp, bound to the intent", () => {
    const token = signReturnToken(INTENT, { key: KEY, now: NOW });
    assert.ok(token);
    const [exp, mac] = token.split(".");
    assert.equal(Number(exp), Math.floor((NOW + RETURN_TOKEN_TTL_MS) / 1000));
    assert.match(mac ?? "", /^[A-Za-z0-9_-]{43}$/);
    const ok = verifyReturnToken(INTENT, token, { key: KEY, now: NOW });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.expiresAt.getTime(), Number(exp) * 1000);
    // Still valid one second before expiry, expired at expiry.
    assert.equal(verifyReturnToken(INTENT, token, { key: KEY, now: Number(exp) * 1000 - 1000 }).ok, true);
    assert.deepEqual(verifyReturnToken(INTENT, token, { key: KEY, now: Number(exp) * 1000 }), { ok: false, reason: "expired" });
  });
  it("rejects a token of another intent, a tampered mac, a tampered exp and another key", () => {
    const token = signReturnToken(INTENT, { key: KEY, now: NOW })!;
    assert.deepEqual(verifyReturnToken("pi_other", token, { key: KEY, now: NOW }), { ok: false, reason: "invalid" });
    const [exp, mac] = token.split(".");
    const flipped = `${exp}.${(mac!.endsWith("A") ? "B" : "A") + mac!.slice(1)}`;
    assert.deepEqual(verifyReturnToken(INTENT, flipped, { key: KEY, now: NOW }), { ok: false, reason: "invalid" });
    assert.deepEqual(verifyReturnToken(INTENT, `${Number(exp) + 3600}.${mac}`, { key: KEY, now: NOW }), { ok: false, reason: "invalid" });
    assert.deepEqual(verifyReturnToken(INTENT, token, { key: OTHER_KEY, now: NOW }), { ok: false, reason: "invalid" });
  });
  it("never touches the key for a missing or malformed token, and reports no_key without a secret", () => {
    assert.deepEqual(verifyReturnToken(INTENT, undefined, { key: KEY }), { ok: false, reason: "missing" });
    assert.deepEqual(verifyReturnToken(INTENT, "", { key: KEY }), { ok: false, reason: "missing" });
    assert.deepEqual(verifyReturnToken(INTENT, "not-a-token", { key: KEY }), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyReturnToken(INTENT, "123.short", { key: KEY }), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyReturnToken(INTENT, ["a", "b"], { key: KEY }), { ok: false, reason: "malformed" });
    const token = signReturnToken(INTENT, { key: KEY, now: NOW })!;
    assert.deepEqual(verifyReturnToken(INTENT, token, { key: null, now: NOW }), { ok: false, reason: "no_key" });
    assert.equal(signReturnToken(INTENT, { key: null }), null);
    assert.equal(signReturnToken("", { key: KEY }), null);
  });
  it("takes the first value when the query parameter is repeated", () => {
    const token = signReturnToken(INTENT, { key: KEY, now: NOW })!;
    assert.equal(verifyReturnToken(INTENT, [token, "garbage"], { key: KEY, now: NOW }).ok, true);
  });
});

describe("withReturnToken — appends `t=` to the PSP return URLs", () => {
  it("appends with & after an existing query string and ? otherwise; no-op without a key", () => {
    const withQuery = withReturnToken(`https://api.example.com/payments/return/${INTENT}?resultado=ok`, INTENT, { key: KEY, now: NOW });
    const url = new URL(withQuery);
    assert.equal(url.searchParams.get("resultado"), "ok");
    const token = url.searchParams.get(RETURN_TOKEN_QUERY_PARAM);
    assert.ok(token);
    assert.equal(verifyReturnToken(INTENT, token, { key: KEY, now: NOW }).ok, true);
    const bare = withReturnToken(`https://api.example.com/payments/return/${INTENT}`, INTENT, { key: KEY, now: NOW });
    assert.ok(bare.includes(`/payments/return/${INTENT}?${RETURN_TOKEN_QUERY_PARAM}=`));
    assert.equal(withReturnToken("https://api.example.com/x?a=1", INTENT, { key: null }), "https://api.example.com/x?a=1");
  });
});
