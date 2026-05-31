// Thin HTTP client for the Airbnb Software Partner API (REST/JSON).
//
// Every Airbnb call needs BOTH a Bearer token AND the X-Airbnb-API-Key header
// (the public client id) — see auth.ts. We thread the apiKey through so the
// adapter can't forget it. Writes are PUT (calendar/pricing are idempotent
// upserts over a date window); reservations are pulled with GET. We use the
// global fetch (Node 20+); timeout via AbortController.
//
// Audit: SHA-256 hashes of request/response bodies are logged so the audit
// trail captures payload shape without storing rate/guest data in cleartext.

import { createHash } from "node:crypto";

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

export type PutJsonInput = {
  url: string;
  token: string;
  apiKey: string;
  json: string; // already-serialized JSON body
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests
  logger?: (event: string, fields: Record<string, unknown>) => void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function putJson({
  url,
  token,
  apiKey,
  json,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  logger
}: PutJsonInput): Promise<JsonHttpResult> {
  const doFetch = fetchImpl ?? fetch;
  const requestHash = sha256(json);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const log = logger ?? defaultLogger;
  log("airbnb.http.request", { url, method: "PUT", requestHash, bytes: json.length });

  try {
    const res = await doFetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Airbnb-API-Key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: json,
      signal: controller.signal
    });
    const body = await res.text();
    const latencyMs = Date.now() - start;
    const responseHash = sha256(body);
    log("airbnb.http.response", {
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
    log("airbnb.http.error", { url, latencyMs, requestHash, error: message });
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

// GET helper for reservations (poll fallback) and the test-credentials listing
// probe. Same auth posture as the writes.
export async function getJson({
  url,
  token,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  logger
}: Omit<PutJsonInput, "json">): Promise<JsonHttpResult> {
  const doFetch = fetchImpl ?? fetch;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const log = logger ?? defaultLogger;
  log("airbnb.http.request", { url, method: "GET" });

  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Airbnb-API-Key": apiKey,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    const body = await res.text();
    const latencyMs = Date.now() - start;
    const responseHash = sha256(body);
    log("airbnb.http.response", { url, status: res.status, latencyMs, responseHash, bytes: body.length });
    return { ok: res.ok, status: res.status, body, latencyMs, requestHash: sha256(""), responseHash };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log("airbnb.http.error", { url, latencyMs, error: message });
    return {
      ok: false,
      status: 0,
      body: "",
      latencyMs,
      requestHash: sha256(""),
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
