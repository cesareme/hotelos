// Thin HTTP client for the Vrbo (Expedia Group) REST/JSON endpoints.
//
// Vrbo's software-partner endpoints accept application/json with a Bearer token,
// mirroring EQC. We keep a Vrbo-specific copy (rather than importing Expedia's)
// so the audit log event names disambiguate the two providers and so a future
// Vrbo-only header/quirk doesn't bleed back into Expedia. We use the global
// fetch (Node 20+); timeout is enforced via AbortController.
//
// Audit: SHA-256 hash of the request/response bodies is logged so the audit
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
  log("vrbo.http.request", { url, requestHash, bytes: json.length });

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
    log("vrbo.http.response", {
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
    log("vrbo.http.error", { url, latencyMs, requestHash, error: message });
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

// GET helper for the reservations pull. Same auth + timeout posture as the POSTs.
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
  log("vrbo.http.request", { url, method: "GET" });

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
    log("vrbo.http.response", { url, status: res.status, latencyMs, responseHash, bytes: body.length });
    return { ok: res.ok, status: res.status, body, latencyMs, requestHash: sha256(""), responseHash };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log("vrbo.http.error", { url, latencyMs, error: message });
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
