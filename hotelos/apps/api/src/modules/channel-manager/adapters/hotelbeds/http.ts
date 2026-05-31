// Thin HTTP client for the Hotelbeds APItude endpoints (REST/JSON).
//
// Auth is signature-based, NOT bearer: every request carries `Api-key` and an
// `X-Signature` header (see auth.ts). The signature is recomputed per call so we
// accept a HotelbedsSignature struct rather than a long-lived token. We use the
// global fetch (Node 20+); timeout via AbortController.
//
// Audit: SHA-256 hashes of request/response bodies are logged so the audit trail
// captures payload shape without storing rate/guest data in cleartext. Note the
// request *signature* itself is NOT logged (it embeds the secret material).

import { createHash } from "node:crypto";
import type { HotelbedsSignature } from "./auth.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export type JsonHttpResult = {
  ok: boolean;
  status: number;
  body: string;
  latencyMs: number;
  requestHash: string;
  responseHash: string;
  errorMessage?: string;
};

export type SignedRequestInput = {
  url: string;
  auth: HotelbedsSignature;
  json?: string; // omit for GET
  method?: "GET" | "POST";
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests
  logger?: (event: string, fields: Record<string, unknown>) => void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function signedRequest({
  url,
  auth,
  json,
  method = json !== undefined ? "POST" : "GET",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  logger
}: SignedRequestInput): Promise<JsonHttpResult> {
  const doFetch = fetchImpl ?? fetch;
  const requestHash = json !== undefined ? sha256(json) : sha256("");
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const log = logger ?? defaultLogger;
  log("hotelbeds.http.request", { url, method, requestHash, bytes: json?.length ?? 0 });

  const headers: Record<string, string> = {
    "Api-key": auth.apiKey,
    "X-Signature": auth.signature,
    Accept: "application/json"
  };
  if (json !== undefined) headers["Content-Type"] = "application/json";

  try {
    const res = await doFetch(url, {
      method,
      headers,
      body: json,
      signal: controller.signal
    });
    const body = await res.text();
    const latencyMs = Date.now() - start;
    const responseHash = sha256(body);
    log("hotelbeds.http.response", {
      url,
      status: res.status,
      latencyMs,
      requestHash,
      responseHash,
      bytes: body.length
    });
    return { ok: res.ok, status: res.status, body, latencyMs, requestHash, responseHash };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log("hotelbeds.http.error", { url, latencyMs, requestHash, error: message });
    return {
      ok: false,
      status: 0,
      body: "",
      latencyMs,
      requestHash,
      responseHash: sha256(""),
      errorMessage: message
    };
  } finally {
    clearTimeout(timer);
  }
}

function defaultLogger(event: string, fields: Record<string, unknown>): void {
  // Console only — production wires this to the platform's structured logger.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...fields }));
}
