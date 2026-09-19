// Resolución de la configuración de IA a partir de cadenas crudas. Este paquete
// NO lee variables de entorno: el API la construye en apps/api/src/lib/ai-config.ts
// (lote 2) y la inyecta en `createAiCore`. Sin clave utilizable el resultado es
// `configured:false` con un `reason` tipado y nunca se llama al proveedor.
//
// Corrección 1 (SEC-05): con proveedor y clave pero SIN tipo de cambio USD→EUR
// utilizable (ausente o no numérico, p. ej. «0,92») el resultado es
// `configured:false, reason:"budget_unavailable"`: sin él cost_eur quedaría NULL,
// el gasto del mes sería 0 y el presupuesto mensual por propiedad no se aplicaría.

import type { AiErrorCode } from "./errors.js";

export type AiProvider = "anthropic" | "none";
export type AiModelRole = "default" | "classify" | "insights";

/** Modelos por defecto (decisión del orquestador, Tanda L6a). */
export const DEFAULT_MODELS: Readonly<Record<AiModelRole, string>> = Object.freeze({
  default: "claude-sonnet-5",
  classify: "claude-haiku-4-5-20251001",
  insights: "claude-opus-5"
});

/** Misma lista que PLACEHOLDER_VALUES de apps/api/src/lib/env.ts. */
export const PLACEHOLDER_API_KEYS: readonly string[] = Object.freeze(["", "change-me", "changeme", "todo", "your-key-here", "placeholder"]);

/**
 * Familias vetadas por la política de retención (los modelos Fable exigen
 * retención de 30 días). Es una expresión regular a propósito: el literal del
 * identificador no aparece en el código.
 */
export const FORBIDDEN_MODEL_PATTERN = /^claude-(fable|mythos)/i;

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_DOCUMENT_TIMEOUT_MS = 120_000;
export const DEFAULT_MONTHLY_BUDGET_EUR = 25;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/** Entrada cruda (valores de entorno tal cual, sin validar). */
export type AiConfigInput = {
  provider?: string | null;
  apiKey?: string | null;
  model?: string | null;
  modelClassify?: string | null;
  modelInsights?: string | null;
  timeoutMs?: string | number | null;
  documentTimeoutMs?: string | number | null;
  monthlyBudgetEurDefault?: string | number | null;
  rateLimitPerMinute?: string | number | null;
  usdEurRate?: string | number | null;
  inferenceGeo?: string | null;
};

export type AiConfig = {
  provider: AiProvider;
  configured: boolean;
  /** Motivo de `configured:false` (siempre presente cuando no está configurado). */
  reason?: AiErrorCode;
  apiKey?: string;
  models: Record<AiModelRole, string>;
  timeoutMs: number;
  documentTimeoutMs: number;
  monthlyBudgetEurDefault: number;
  rateLimitPerMinute: number;
  /** Tipo de cambio USD→EUR para persistir costEur; con proveedor configurado es obligatorio (SEC-05). */
  usdEurRate: number | null;
  /** Valores crudos que no se pudieron interpretar (se avisa; nunca se aplican en silencio). */
  invalidInputs?: string[];
  inferenceGeo?: string;
};

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function positiveNumber(value: string | number | null | undefined, fallback: number, minimum = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
}

export function isPlaceholderApiKey(apiKey: string | null | undefined): boolean {
  return PLACEHOLDER_API_KEYS.includes(text(apiKey).toLowerCase());
}

export function isForbiddenModel(model: string | null | undefined): boolean {
  return FORBIDDEN_MODEL_PATTERN.test(text(model));
}

export function resolveModels(input: Pick<AiConfigInput, "model" | "modelClassify" | "modelInsights"> = {}): Record<AiModelRole, string> {
  return {
    default: text(input.model) || DEFAULT_MODELS.default,
    classify: text(input.modelClassify) || DEFAULT_MODELS.classify,
    insights: text(input.modelInsights) || DEFAULT_MODELS.insights
  };
}

/** Nombre de variable por campo crudo (para los avisos de valores no interpretables). */
const INPUT_VARIABLE_NAMES: Readonly<Record<"timeoutMs" | "documentTimeoutMs" | "monthlyBudgetEurDefault" | "rateLimitPerMinute" | "usdEurRate", string>> = Object.freeze({
  timeoutMs: "AI_REQUEST_TIMEOUT_MS",
  documentTimeoutMs: "AI_DOCUMENT_TIMEOUT_MS",
  monthlyBudgetEurDefault: "AI_MONTHLY_BUDGET_EUR_DEFAULT",
  rateLimitPerMinute: "AI_RATE_LIMIT_PER_MINUTE",
  usdEurRate: "AI_USD_EUR_RATE"
});

function isBlank(value: string | number | null | undefined): boolean {
  return value === null || value === undefined || value === "";
}

function isNumeric(value: string | number): boolean {
  return typeof value === "number" ? Number.isFinite(value) : /^\s*-?\d+(?:\.\d+)?\s*$/.test(value);
}

export function resolveAiConfig(input: AiConfigInput = {}): AiConfig {
  const models = resolveModels(input);
  const providerRaw = text(input.provider).toLowerCase();
  const apiKey = text(input.apiKey);
  const rateRaw = input.usdEurRate;
  const usdEurRate = isBlank(rateRaw) ? null : positiveNumber(rateRaw, Number.NaN);
  const inferenceGeo = text(input.inferenceGeo);
  // Valores presentes pero no interpretables (coma decimal, texto…): nunca se aplican en silencio.
  const invalidInputs = (Object.keys(INPUT_VARIABLE_NAMES) as Array<keyof typeof INPUT_VARIABLE_NAMES>)
    .filter((field) => !isBlank(input[field]) && !isNumeric(input[field] as string | number))
    .map((field) => INPUT_VARIABLE_NAMES[field]);

  const base = {
    models,
    timeoutMs: positiveNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000),
    documentTimeoutMs: positiveNumber(input.documentTimeoutMs, DEFAULT_DOCUMENT_TIMEOUT_MS, 1000),
    monthlyBudgetEurDefault: positiveNumber(input.monthlyBudgetEurDefault, DEFAULT_MONTHLY_BUDGET_EUR, 0),
    rateLimitPerMinute: positiveNumber(input.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE, 0),
    usdEurRate: usdEurRate !== null && Number.isFinite(usdEurRate) && usdEurRate > 0 ? usdEurRate : null,
    ...(inferenceGeo ? { inferenceGeo } : {}),
    ...(invalidInputs.length > 0 ? { invalidInputs } : {})
  };

  const unconfigured = (reason: AiErrorCode): AiConfig => ({ provider: "none", configured: false, reason, ...base });

  if (providerRaw === "" || providerRaw === "none") return unconfigured("not_configured");
  if (providerRaw !== "anthropic") return unconfigured("provider_unsupported");
  if ((Object.values(models) as string[]).some((model) => isForbiddenModel(model))) return unconfigured("model_forbidden");
  if (isPlaceholderApiKey(apiKey)) return unconfigured("not_configured");
  // SEC-05: sin tipo de cambio el presupuesto mensual no se puede aplicar → la IA no arranca.
  if (base.usdEurRate === null) return unconfigured("budget_unavailable");

  return { provider: "anthropic", configured: true, apiKey, ...base };
}
