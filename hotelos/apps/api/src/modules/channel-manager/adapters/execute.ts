// Shared "send one push and classify the answer" step for the adapters.
//
// stub / sandbox → the in-process simulator validates the body against the
// provider schema and answers like the provider would; real → HTTPS. Either
// way the provider response is PARSED by the adapter's own parser, so a
// sandbox run exercises exactly the code path a real one will.
//
// Classification (drain.service relies on it):
//   timeout / 429 / 5xx / network → ok=false, retryable (backoff, Retry-After honoured);
//   401 / 403                     → ok=false, not retryable (credentials);
//   400 / 422 / provider <Error>  → per-item rejections when the provider
//                                   names the item, otherwise request-level
//                                   errors — not retryable unless the parser
//                                   says so (EQC 4xxx "system error, please
//                                   retry" comes with HTTP 200).
// Provider warnings travel in `warnings` (top level, also under raw) so the
// sync job keeps them next to the outcome.

import type { AdapterDeps, AdapterRejection, AdapterResult, ChannelContext } from "../adapter.types.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS, failedResult } from "../adapter.types.js";
import { runSimulator, type SimulatorProvider } from "../sandbox/simulator.js";
import { httpRequest, simulatorToHttpResult, type HttpResult } from "./transport.js";

export type ParsedProviderResponse = {
  ok: boolean;
  accepted: number;
  rejected: AdapterRejection[];
  errors: string[];
  warnings?: string[];
  /** Request-level failure the provider marks as transient (retry with backoff). Default: definitive. */
  retryable?: boolean;
};

export async function executePush(input: {
  channel: ChannelContext;
  provider: SimulatorProvider;
  /** Simulator endpoint id (booking: OTA_* name · channex: api path · expedia: ar). */
  endpoint: string;
  url: string;
  method?: "POST" | "PUT";
  headers: Record<string, string>;
  body: string;
  itemCount: number;
  deps?: AdapterDeps;
  parse: (body: string, itemCount: number) => ParsedProviderResponse;
}): Promise<AdapterResult> {
  const deps = input.deps ?? {};
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  let http: HttpResult;
  if (input.channel.mode === "real") {
    http = await httpRequest({
      url: input.url,
      method: input.method ?? "POST",
      headers: input.headers,
      body: input.body,
      timeoutMs,
      fetchImpl: deps.fetchImpl,
      now
    });
  } else {
    const start = now();
    const sim = await runSimulator({
      provider: input.provider,
      endpoint: input.endpoint,
      body: input.body,
      channelId: input.channel.id,
      options: input.channel.simulator,
      timeoutMs
    });
    http = simulatorToHttpResult(sim, input.body, now() - start);
  }
  const base = { latencyMs: http.latencyMs, requestHash: http.requestHash, responseHash: http.responseHash };
  const raw = { provider: input.provider, mode: input.channel.mode, status: http.status, url: input.url };
  if (http.timedOut) {
    return failedResult({ ...base, errors: [http.errorMessage ?? "Timeout"], timedOut: true, retryable: true, raw });
  }
  if (http.status === 0) {
    return failedResult({ ...base, errors: [http.errorMessage ?? "Error de red"], retryable: true, raw });
  }
  const retryAfter = http.retryAfterMs !== undefined ? { retryAfterMs: http.retryAfterMs } : {};
  if (http.status === 429) {
    return failedResult({ ...base, errors: ["El proveedor limitó la petición (HTTP 429)."], rateLimited: true, retryable: true, ...retryAfter, raw });
  }
  if (http.status >= 500) {
    return failedResult({ ...base, errors: [`El proveedor respondió HTTP ${http.status}.`], retryable: true, ...retryAfter, raw });
  }
  if (http.status === 401 || http.status === 403) {
    return failedResult({ ...base, errors: [`Credenciales rechazadas por el proveedor (HTTP ${http.status}).`], retryable: false, raw });
  }
  let parsed: ParsedProviderResponse;
  try {
    parsed = input.parse(http.body, input.itemCount);
  } catch (err) {
    return failedResult({ ...base, errors: [`Respuesta del proveedor no interpretable: ${err instanceof Error ? err.message : String(err)}`], retryable: false, raw });
  }
  const warnings = parsed.warnings ?? [];
  if (!parsed.ok && parsed.rejected.length === 0) {
    return failedResult({
      ...base,
      errors: parsed.errors.length ? parsed.errors : [`El proveedor respondió HTTP ${http.status} sin detalle.`],
      retryable: parsed.retryable ?? false,
      warnings,
      raw: { ...raw, warnings }
    });
  }
  return {
    ok: true,
    accepted: parsed.accepted,
    rejected: parsed.rejected,
    errors: parsed.errors,
    ...base,
    warnings,
    raw: { ...raw, warnings }
  };
}
