// Signature-based auth for the Hotelbeds APItude API.
//
// Hotelbeds does NOT use OAuth. Every request is signed per-call with:
//   X-Signature = SHA256( apiKey + secret + currentUNIXTimeInSeconds )
//   Api-key:     <apiKey>
//   Accept:      application/json
//   Docs: https://developer.hotelbeds.com/documentation/getting-started/
//
// There is therefore NO token to cache — the signature is cheap and is
// recomputed for every request from the current epoch second.
//
// SHARP EDGE — TIMESTAMP DRIFT: Hotelbeds validates the timestamp embedded in
// the signature against their server clock. If our host clock drifts more than
// a few minutes the signature is rejected with a 403 that looks like a bad key.
// The signature MUST use SECONDS (not milliseconds) and the host clock should be
// NTP-synced. We expose buildSignature(now) so tests can pin the clock; in
// production `now` defaults to Date.now().

import { createHash } from "node:crypto";
import type { ChannelContext } from "../../adapter.types.js";

export class HotelbedsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HotelbedsAuthError";
  }
}

function extractApiCreds(channel: ChannelContext): { apiKey: string; secret: string } | null {
  const creds = channel.credentialsJson;
  if (!creds) return null;
  const apiKey = creds.apiKey ?? creds.api_key ?? creds.publicKey;
  const secret = creds.secret ?? creds.apiSecret ?? creds.privateKey;
  if (typeof apiKey === "string" && apiKey === "INVALID") return null; // shared stub sentinel
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  if (typeof secret !== "string" || secret.length === 0) return null;
  return { apiKey, secret };
}

export type HotelbedsSignature = {
  apiKey: string;
  signature: string;
  timestamp: number; // epoch SECONDS used in the signature
};

// Compute X-Signature = SHA256(apiKey + secret + epochSeconds). `now` is epoch
// MILLISECONDS (defaults to Date.now()); we floor to seconds before hashing.
export function buildSignature(channel: ChannelContext, now: number = Date.now()): HotelbedsSignature {
  const creds = extractApiCreds(channel);
  if (!creds) {
    throw new HotelbedsAuthError("Hotelbeds credentials missing apiKey or secret");
  }
  const timestamp = Math.floor(now / 1000);
  const signature = createHash("sha256")
    .update(`${creds.apiKey}${creds.secret}${timestamp}`, "utf8")
    .digest("hex");
  return { apiKey: creds.apiKey, signature, timestamp };
}

// Convenience guard mirroring the OAuth credential checks used elsewhere so the
// adapter can short-circuit before attempting to sign / hit the network.
export function hasCredentials(channel: ChannelContext): boolean {
  return extractApiCreds(channel) !== null;
}
