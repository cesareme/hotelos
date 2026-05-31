// Thin HTTP client for the Expedia EQC REST/JSON endpoints.
//
// EQC v3 ("Quick Connect") accepts application/json with a Bearer token. We use
// the global fetch (Node 20+) so there are no extra dependencies. Timeout is
// enforced via AbortController so a hanging Expedia endpoint can't pin a worker
// forever.
//
// Audit: we log a SHA-256 hash of the outgoing JSON body and the response body
// so the platform's audit log knows *what* shape of payload went out without
// storing rate or guest data in cleartext. The full payload is kept only in
// per-job debug logs (not implemented here — left for a future sprint).

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

export type PostJsonInput = {
  url: string;
  token: string;
  json: string; // already-serialized JSON body
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests
  logger?: (event: string, fields: Record<string, unknown>) => void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function postJson({
  url,
  token,
  json,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  logger
}: PostJsonInput): Promise<JsonHttpResult> {
  const doFetch = fetchImpl ?? fetch;
  const requestHash = sha256(json);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const log = logger ?? defaultLogger;
  log("expedia.http.request", { url, requestHash, bytes: json.length });

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: json,
      signal: controller.signal
    });
    const body = await res.text();
    const latencyMs = Date.now() - start;
    const responseHash = sha256(body);
    log("expedia.http.response", {
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
    log("expedia.http.error", { url, latencyMs, requestHash, error: message });
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

// GET helper for the bookings pull. Same auth + timeout posture as the POSTs.
export async function getJson({
  url,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  logger
}: Omit<PostJsonInput, "json">): Promise<JsonHttpResult> {
  const doFetch = fetchImpl ?? fetch;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const log = logger ?? defaultLogger;
  log("expedia.http.request", { url, method: "GET" });

  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    const body = await res.text();
    const latencyMs = Date.now() - start;
    const responseHash = sha256(body);
    log("expedia.http.response", { url, status: res.status, latencyMs, responseHash, bytes: body.length });
    return { ok: res.ok, status: res.status, body, latencyMs, requestHash: sha256(""), responseHash };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log("expedia.http.error", { url, latencyMs, error: message });
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
