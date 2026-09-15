// Shared HTTP transport for the channel adapters (rate grid v2).
//
// One place for: injectable fetch (tests), AbortController timeouts, latency
// measurement and the sha256 request/response hashes the audit trail keeps
// instead of bodies (rates and guest data never land in logs in cleartext).
// Also converts an in-process simulator answer to the same shape, so an
// adapter's "did the provider accept it?" logic is identical in sandbox and
// real mode.

import { createHash } from "node:crypto";
import { DEFAULT_ADAPTER_TIMEOUT_MS } from "../adapter.types.js";
import type { SimulatorResponse } from "../sandbox/simulator.js";

export type HttpResult = {
  ok: boolean;
  status: number;
  body: string;
  latencyMs: number;
  requestHash: string;
  responseHash: string;
  timedOut: boolean;
  errorMessage?: string;
  /** `Retry-After` of the response (seconds or HTTP-date), in ms from now; absent when the provider sent none. */
  retryAfterMs?: number;
};

/** Parses a `Retry-After` header (delay-seconds or HTTP-date) into a wait in ms; undefined when absent/unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export type HttpRequestInput = {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function httpRequest(input: HttpRequestInput): Promise<HttpResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const requestHash = sha256(input.body ?? "");
  const start = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body !== undefined ? { body: input.body } : {}),
      signal: controller.signal
    });
    const body = await res.text();
    const retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"), Date.now());
    return {
      ok: res.ok,
      status: res.status,
      body,
      latencyMs: now() - start,
      requestHash,
      responseHash: sha256(body),
      timedOut: false,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = controller.signal.aborted || /abort/i.test(message);
    return {
      ok: false,
      status: 0,
      body: "",
      latencyMs: now() - start,
      requestHash,
      responseHash: sha256(""),
      timedOut,
      errorMessage: timedOut ? `Timeout tras ${timeoutMs} ms` : message
    };
  } finally {
    clearTimeout(timer);
  }
}

export function simulatorToHttpResult(sim: SimulatorResponse, requestBody: string, latencyMs: number): HttpResult {
  return {
    ok: sim.status >= 200 && sim.status < 300,
    status: sim.status,
    body: sim.body,
    latencyMs,
    requestHash: sha256(requestBody),
    responseHash: sha256(sim.body),
    timedOut: sim.timedOut,
    ...(sim.timedOut ? { errorMessage: sim.errors[0] ?? "Timeout simulado" } : {})
  };
}

/** Trailing-slash safe join of a base URL and a path. */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${b}${path.startsWith("/") ? path : `/${path}`}`;
}
