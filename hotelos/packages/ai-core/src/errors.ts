// Errores tipados del núcleo de IA. Cada fallo que llega a un llamador (API,
// runner, front) lleva un `code` estable; el texto en español vive en
// ./labels.ts (`labelFor`). Nunca se lanza un `Error` genérico desde ai-core.
//
// Corrección 1 (CFC-02): un error producido DESPUÉS de una respuesta facturada
// (`invalid_output`, `truncated`) lleva `telemetry` con el modelo, los tokens y
// el coste reales para que el runner los persista en la fila `failed`.

export type AiErrorCode =
  | "not_configured"
  | "provider_unsupported"
  | "model_forbidden"
  | "budget_unavailable"
  | "ai_disabled_for_property"
  | "budget_exceeded"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "invalid_output"
  | "truncated"
  | "refusal"
  | "pii_redaction_failed"
  | "tool_unknown"
  | "tool_not_implemented"
  | "tool_denied"
  | "confirmation_expired"
  | "payload_too_large";

export const AI_ERROR_CODES: readonly AiErrorCode[] = Object.freeze([
  "not_configured",
  "provider_unsupported",
  "model_forbidden",
  "budget_unavailable",
  "ai_disabled_for_property",
  "budget_exceeded",
  "rate_limited",
  "provider_error",
  "timeout",
  "invalid_output",
  "truncated",
  "refusal",
  "pii_redaction_failed",
  "tool_unknown",
  "tool_not_implemented",
  "tool_denied",
  "confirmation_expired",
  "payload_too_large"
]);

/** Telemetría de una respuesta ya facturada (misma forma que AiTelemetry de ./messages.ts). */
export type AiErrorTelemetry = {
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cacheReadTokens: number;
  costUsd: number | null;
  costEur: number | null;
  latencyMs: number;
};

export type AiErrorOptions = {
  /** Si el llamador puede reintentar la misma petición más tarde. */
  retryable?: boolean;
  /** Código HTTP del proveedor cuando procede. */
  status?: number;
  /** `error.type` del cuerpo de error del proveedor (p. ej. `overloaded_error`). */
  providerType?: string;
  /** Milisegundos que conviene esperar antes de reintentar (rate limit, 429). */
  retryAfterMs?: number;
  /** Detalle libre, sin bytes ni PII, para diagnóstico y auditoría. */
  details?: unknown;
  /** Modelo, tokens y coste de la respuesta que provocó el error (ya facturada). */
  telemetry?: AiErrorTelemetry;
  cause?: unknown;
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
  readonly details?: unknown;
  readonly telemetry?: AiErrorTelemetry;

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AiError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
    if (options.providerType !== undefined) this.providerType = options.providerType;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.details !== undefined) this.details = options.details;
    if (options.telemetry !== undefined) this.telemetry = options.telemetry;
  }

  /** Forma serializable (sin `cause`) para respuestas HTTP y auditoría. */
  toJSON(): { code: AiErrorCode; message: string; retryable: boolean; status?: number; providerType?: string; retryAfterMs?: number } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.providerType !== undefined ? { providerType: this.providerType } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {})
    };
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError || (typeof value === "object" && value !== null && (value as { name?: unknown }).name === "AiError" && typeof (value as { code?: unknown }).code === "string");
}

/** Código HTTP sugerido para cada error (lo aplica el API, no este paquete). */
export function httpStatusForAiError(code: AiErrorCode): number {
  switch (code) {
    case "rate_limited":
      return 429;
    case "budget_exceeded":
    case "ai_disabled_for_property":
    case "tool_denied":
    case "model_forbidden":
      return 403;
    case "confirmation_expired":
      return 409;
    case "payload_too_large":
      return 413;
    case "timeout":
      return 504;
    case "provider_error":
      return 502;
    case "not_configured":
    case "provider_unsupported":
    case "budget_unavailable":
    case "tool_not_implemented":
      return 503;
    case "tool_unknown":
      return 404;
    case "invalid_output":
    case "truncated":
    case "refusal":
    case "pii_redaction_failed":
      return 422;
    default:
      return 500;
  }
}
