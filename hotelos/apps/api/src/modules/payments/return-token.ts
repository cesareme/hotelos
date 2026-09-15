// Return-page token (finanzas · fix facturación-cobros t6#15, 2026-09-16).
//
// GET /payments/return/:intentId is public: the customer lands there from the
// PSP's hosted page without any staff session. Before this fix anybody who
// knew a PaymentIntent id (they travel in PSP URLs and logs) could read the
// amount of a captured payment. The URLs we hand to the PSP (Stripe
// success_url / cancel_url, Redsys DS_MERCHANT_URLOK / URLKO) now carry a
// short token bound to the intent: HMAC-SHA256 over `<intentId>.<exp>` with a
// key derived from JWT_SECRET (domain-separated, so a return token is never
// a session token and vice versa). Without a valid token the page is neutral
// — no amount, no hint of whether the intent exists — and the database is
// not even consulted.
//
// Wire format: `<exp unix seconds>.<base64url(HMAC)>` in query param `t`.
// The TTL (7 days) covers the life of an emailed payment link: Stripe
// Checkout sessions expire after 24 h at most and the Redsys form is rebuilt
// (with a fresh token) every time the intent is read. An expired token only
// degrades the landing page to the neutral text; the capture itself is
// recorded by the signed webhook, never by this page.
//
// Pure module: every function takes the key / clock explicitly so the unit
// tests need no environment; the defaults read JWT_SECRET.

import { createHmac, timingSafeEqual } from "node:crypto";

export const RETURN_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RETURN_TOKEN_QUERY_PARAM = "t";

/** Domain-separation label of the derived key (bump the suffix to invalidate every outstanding token). */
const KEY_CONTEXT = "hotelos.payments.return.v1";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Key of the return tokens, derived from JWT_SECRET. Null when the secret is
 * missing or still the example value: then no token can be signed and the
 * landing page stays neutral (the API refuses logins in that state anyway).
 */
export function returnTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = (env.JWT_SECRET ?? "").trim();
  if (secret.length === 0 || secret === "change-me") return null;
  return createHmac("sha256", secret).update(KEY_CONTEXT, "utf8").digest();
}

function mac(key: Buffer, intentId: string, exp: number): string {
  return base64url(createHmac("sha256", key).update(`${intentId}.${exp}`, "utf8").digest());
}

export type ReturnTokenOptions = {
  /** Explicit key (tests); `undefined` → derived from the environment; `null` → no key available. */
  key?: Buffer | null;
  /** Clock in ms since the epoch (default Date.now()). */
  now?: number;
  ttlMs?: number;
};

/** Signs a token for `intentId`; null when no key is available. */
export function signReturnToken(intentId: string, options: ReturnTokenOptions = {}): string | null {
  const key = options.key === undefined ? returnTokenKey() : options.key;
  if (!key || typeof intentId !== "string" || intentId.length === 0) return null;
  const now = options.now ?? Date.now();
  const exp = Math.floor((now + (options.ttlMs ?? RETURN_TOKEN_TTL_MS)) / 1000);
  return `${exp}.${mac(key, intentId, exp)}`;
}

export type ReturnTokenVerification =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "invalid" | "no_key" };

/**
 * Verifies `token` for `intentId`: constant-time comparison of the MAC, then
 * the expiry. A token signed for another intent is `invalid`; a missing or
 * malformed one never touches the key.
 */
export function verifyReturnToken(intentId: string, token: string | string[] | null | undefined, options: Pick<ReturnTokenOptions, "key" | "now"> = {}): ReturnTokenVerification {
  const raw = Array.isArray(token) ? token[0] : token;
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "missing" };
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!match || typeof intentId !== "string" || intentId.length === 0) return { ok: false, reason: "malformed" };
  const key = options.key === undefined ? returnTokenKey() : options.key;
  if (!key) return { ok: false, reason: "no_key" };
  const exp = Number(match[1]);
  const expected = Buffer.from(mac(key, intentId, exp), "utf8");
  const provided = Buffer.from(match[2] ?? "", "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: "invalid" };
  const now = options.now ?? Date.now();
  if (exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, expiresAt: new Date(exp * 1000) };
}

/** Appends the return token to a URL that already carries its query string (no-op when no key is available). */
export function withReturnToken(url: string, intentId: string, options: ReturnTokenOptions = {}): string {
  const token = signReturnToken(intentId, options);
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${RETURN_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}
