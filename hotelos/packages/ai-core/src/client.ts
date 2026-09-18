// Cliente mínimo de la API de Anthropic sobre fetch (sin SDK: decisión del
// orquestador, Tanda L6a). El cuerpo se envía tal cual (tools, tool_choice,
// output_config, system con cache_control, messages multi-turno…).
//
// Reintentos: máximo 2 (3 intentos) en 429, en cualquier 5xx (500, 502, 503,
// 504, 529) y en fallos de red (TypeError de fetch); espera 500 ms·2^n más un
// jitter ≤ 250 ms, o el valor de `retry-after` (segundos o fecha HTTP), siempre
// limitado a 30 s. Un `retry-after` MAYOR que el tope no se espera ni se
// reintenta (corrección 1 · CFC-10): el error rate_limited sale al instante con
// `retryAfterMs` real para que el llamador decida. Nunca en 400/401/402/403/404/413
// → AiError provider_error no reintentable con `providerType = error.type` del
// cuerpo. Cada intento lleva su AbortController con `timeoutMs` → AiError timeout
// sin reintento (la espera total por llamada queda acotada por
// 3 × timeoutMs + 2 × RETRY_AFTER_CAP_MS).

import { AiError } from "./errors.js";

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const MAX_RETRIES = 2;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_JITTER_MS = 250;
export const RETRY_AFTER_CAP_MS = 30_000;

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Bloque de contenido tal como llega del proveedor (text, tool_use, thinking…). */
export type AnthropicContentBlock = { type: string } & Record<string, unknown>;

export type AnthropicMessageResponse = {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  stop_details?: unknown;
  usage: AnthropicUsage;
};

export type AnthropicMessageBody = { model: string; max_tokens: number; messages: unknown[] } & Record<string, unknown>;
export type AnthropicCountTokensBody = { model: string; messages: unknown[] } & Record<string, unknown>;
export type AnthropicCountTokensResponse = { input_tokens: number };
export type AnthropicModelInfo = { id: string; type?: string; display_name?: string; created_at?: string } & Record<string, unknown>;

export type AnthropicRequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Se invoca antes de CADA intento (el núcleo cuelga aquí el rate limit por organización). */
  beforeAttempt?: (attempt: number) => void | Promise<void>;
};

export type AnthropicClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  anthropicVersion?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Fuente del jitter (0..1); inyectable para tests deterministas. */
  random?: () => number;
};

export type AnthropicClient = {
  createMessage(body: AnthropicMessageBody, options: AnthropicRequestOptions): Promise<AnthropicMessageResponse>;
  countTokens(body: AnthropicCountTokensBody, options?: Partial<AnthropicRequestOptions>): Promise<AnthropicCountTokensResponse>;
  getModel(id: string, options?: Partial<AnthropicRequestOptions>): Promise<AnthropicModelInfo>;
};

/** `retry-after` en segundos o fecha HTTP → milisegundos (null si no se puede interpretar). */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return null;
}

/** Espera antes del reintento n (0-based): retry-after si viene, si no backoff exponencial con jitter; tope 30 s. */
export function retryDelayMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(random() * RETRY_MAX_JITTER_MS);
  const delay = retryAfterMs !== null && retryAfterMs !== undefined ? retryAfterMs : backoff;
  return Math.min(Math.max(0, delay), RETRY_AFTER_CAP_MS);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

type ProviderErrorBody = { providerType?: string; message: string; raw?: unknown };

async function readErrorBody(response: Response): Promise<ProviderErrorBody> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { message: `HTTP ${response.status}` };
  }
  try {
    const parsed = JSON.parse(text) as { type?: unknown; error?: { type?: unknown; message?: unknown } };
    const providerType = typeof parsed?.error?.type === "string" ? parsed.error.type : undefined;
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : text.slice(0, 300);
    return { ...(providerType ? { providerType } : {}), message, raw: parsed };
  } catch {
    return { message: text.slice(0, 300) || `HTTP ${response.status}` };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAnthropicClient(options: AnthropicClientOptions): AnthropicClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
  const anthropicVersion = options.anthropicVersion ?? ANTHROPIC_API_VERSION;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  if (typeof fetchImpl !== "function") {
    throw new AiError("provider_error", "No hay implementación de fetch disponible para el cliente de IA.", { retryable: false });
  }

  async function request<T>(method: "GET" | "POST", path: string, body: unknown, requestOptions: AnthropicRequestOptions): Promise<T> {
    const timeoutMs = Math.max(1, Math.floor(requestOptions.timeoutMs));
    const headers: Record<string, string> = {
      "x-api-key": options.apiKey,
      "anthropic-version": anthropicVersion,
      accept: "application/json"
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;
    let lastError: AiError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (requestOptions.beforeAttempt) await requestOptions.beforeAttempt(attempt);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const external = requestOptions.signal;
      const onExternalAbort = (): void => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener("abort", onExternalAbort, { once: true });
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      };

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers,
          ...(serialized !== undefined ? { body: serialized } : {}),
          signal: controller.signal
        });
      } catch (error) {
        cleanup();
        if (timedOut) {
          throw new AiError("timeout", `Tiempo de espera agotado (${timeoutMs} ms) al contactar con el proveedor de IA.`, { retryable: false, cause: error });
        }
        if (external?.aborted) {
          throw new AiError("timeout", "Petición al proveedor de IA cancelada por el llamador.", { retryable: false, cause: error });
        }
        if (error instanceof TypeError) {
          lastError = new AiError("provider_error", `Fallo de red al contactar con el proveedor de IA: ${error.message}`, { retryable: true, cause: error });
          if (attempt < MAX_RETRIES) {
            await sleep(retryDelayMs(attempt, null, random));
            continue;
          }
          throw lastError;
        }
        throw new AiError("provider_error", `Error inesperado al contactar con el proveedor de IA: ${error instanceof Error ? error.message : String(error)}`, {
          retryable: false,
          cause: error
        });
      }

      if (response.ok) {
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch (error) {
          cleanup();
          if (timedOut) throw new AiError("timeout", `Tiempo de espera agotado (${timeoutMs} ms) leyendo la respuesta del proveedor de IA.`, { retryable: false, cause: error });
          throw new AiError("provider_error", "El proveedor de IA devolvió un cuerpo que no es JSON.", { retryable: false, status: response.status, cause: error });
        }
        cleanup();
        return parsed as T;
      }

      const errorBody = await readErrorBody(response);
      cleanup();
      const status = response.status;
      const providerType = errorBody.providerType;
      const requestId = response.headers.get("request-id") ?? undefined;
      const details = { ...(requestId ? { requestId } : {}), path };
      const description = `El proveedor de IA respondió HTTP ${status}${providerType ? ` (${providerType})` : ""}: ${errorBody.message}`;

      if (isRetryableStatus(status)) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
        lastError = new AiError(status === 429 ? "rate_limited" : "provider_error", description, {
          retryable: true,
          status,
          ...(providerType ? { providerType } : {}),
          ...(retryAfterMs !== null ? { retryAfterMs } : {}),
          details
        });
        // CFC-10: un retry-after por encima del tope no se recorta ni se reintenta dentro de la petición.
        if (attempt < MAX_RETRIES && (retryAfterMs === null || retryAfterMs <= RETRY_AFTER_CAP_MS)) {
          await sleep(retryDelayMs(attempt, retryAfterMs, random));
          continue;
        }
        throw lastError;
      }

      throw new AiError("provider_error", description, { retryable: false, status, ...(providerType ? { providerType } : {}), details });
    }

    throw lastError ?? new AiError("provider_error", "El proveedor de IA no respondió.", { retryable: true });
  }

  function withDefaults(partial: Partial<AnthropicRequestOptions> | undefined): AnthropicRequestOptions {
    return { timeoutMs: partial?.timeoutMs ?? 20_000, ...(partial?.signal ? { signal: partial.signal } : {}), ...(partial?.beforeAttempt ? { beforeAttempt: partial.beforeAttempt } : {}) };
  }

  return {
    async createMessage(body, requestOptions) {
      const response = await request<AnthropicMessageResponse>("POST", "/v1/messages", body, requestOptions);
      if (!response || typeof response !== "object" || !Array.isArray(response.content) || !response.usage || typeof response.usage !== "object") {
        throw new AiError("provider_error", "La respuesta del proveedor de IA no tiene la forma esperada (content/usage).", { retryable: false });
      }
      return response;
    },
    countTokens(body, requestOptions) {
      return request<AnthropicCountTokensResponse>("POST", "/v1/messages/count_tokens", body, withDefaults(requestOptions));
    },
    getModel(id, requestOptions) {
      return request<AnthropicModelInfo>("GET", `/v1/models/${encodeURIComponent(id)}`, undefined, withDefaults(requestOptions));
    }
  };
}
