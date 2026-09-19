// Configuración de IA del API (Tanda L6a, lote 2). ÚNICO fichero de apps/api que lee
// las variables AI_* (el censo de scripts/env-census.mjs apunta readBy aquí): las
// convierte en el AiConfigInput crudo que resuelve @hotelos/ai-core, que a su vez
// nunca toca process.env. Sin clave utilizable el resultado es `configured:false`
// con motivo tipado y el API responde por reglas, nunca simulando un modelo.

import { resolveAiConfig } from "@hotelos/ai-core";
import type { AiConfig, AiConfigInput, AiErrorCode, AiModelRole, AiProvider } from "@hotelos/ai-core";

export type AiConfigSummary = {
  provider: AiProvider;
  configured: boolean;
  reason?: AiErrorCode;
  models: Record<AiModelRole, string>;
  monthlyBudgetEurDefault: number;
};

/** Lectura cruda de las variables AI_* (sin validar; la validación vive en env.ts y en ai-core). */
export function readAiConfigInput(env: NodeJS.ProcessEnv = process.env): AiConfigInput {
  return {
    provider: env.AI_PROVIDER ?? null,
    apiKey: env.AI_PROVIDER_API_KEY ?? null,
    model: env.AI_MODEL ?? null,
    modelClassify: env.AI_MODEL_CLASSIFY ?? null,
    modelInsights: env.AI_MODEL_INSIGHTS ?? null,
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS ?? null,
    documentTimeoutMs: env.AI_DOCUMENT_TIMEOUT_MS ?? null,
    monthlyBudgetEurDefault: env.AI_MONTHLY_BUDGET_EUR_DEFAULT ?? null,
    rateLimitPerMinute: env.AI_RATE_LIMIT_PER_MINUTE ?? null,
    usdEurRate: env.AI_USD_EUR_RATE ?? null,
    inferenceGeo: env.AI_INFERENCE_GEO ?? null
  };
}

function warnIfDegraded(config: AiConfig, input: AiConfigInput): void {
  // WT-02: un valor presente pero no numérico (p. ej. «0,92») nunca se aplica en silencio.
  for (const name of config.invalidInputs ?? []) {
    console.warn(`[ai.config] ${name} tiene un valor no numérico: se ignora (usa punto decimal, p. ej. 0.92).`);
  }
  if (config.reason === "provider_unsupported") {
    console.warn(`[ai.config] AI_PROVIDER=${String(input.provider).trim()} no está soportado en la Tanda L6a (solo none | anthropic): se trata como none y los asistentes responden por reglas.`);
  } else if (config.reason === "model_forbidden") {
    console.warn("[ai.config] Un modelo AI_MODEL* pertenece a una familia vetada por la política de retención (claude-fable-* / claude-mythos-*): la IA queda desactivada hasta corregirlo.");
  } else if (config.reason === "budget_unavailable") {
    // SEC-05: sin tipo de cambio el presupuesto mensual por propiedad no se puede aplicar → IA desactivada.
    console.warn("[ai.config] AI_PROVIDER=anthropic sin AI_USD_EUR_RATE utilizable: el presupuesto mensual por propiedad no se podría aplicar, así que la IA queda desactivada (respuestas por reglas) hasta definirlo.");
  }
}

/** Resuelve la configuración desde un entorno dado (sin caché). */
export function resolveApiAiConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AiConfigInput> = {}): AiConfig {
  const input: AiConfigInput = { ...readAiConfigInput(env), ...overrides };
  const config = resolveAiConfig(input);
  warnIfDegraded(config, input);
  return config;
}

let cached: AiConfig | null = null;

/** Configuración cacheada por proceso (se resuelve una vez, en la primera lectura). */
export function getAiConfig(): AiConfig {
  cached ??= resolveApiAiConfig();
  return cached;
}

/** Reconstruye la caché desde `env` (defecto process.env) con `overrides` opcionales. Solo tests. */
export function resetAiConfigForTests(overrides: Partial<AiConfigInput> = {}, env: NodeJS.ProcessEnv = process.env): AiConfig {
  cached = resolveApiAiConfig(env, overrides);
  return cached;
}

/** Bloque para GET /health (lo cuelga el orquestador en server.ts): nunca incluye la clave. */
export function describeAiHealthCheck(config: AiConfig = getAiConfig()): { ok: true; message: string } {
  const message = [
    `provider=${config.provider}`,
    `model=${config.models.default}`,
    `classify=${config.models.classify}`,
    `budgetDefaultEur=${config.monthlyBudgetEurDefault}`,
    `rateLimitPerMinute=${config.rateLimitPerMinute}`,
    `usdEurRate=${config.usdEurRate === null ? "unset" : "set"}`,
    ...(config.configured ? [] : [`reason=${config.reason ?? "not_configured"}`])
  ].join(" ");
  return { ok: true, message };
}

/** Resumen sin secretos para el readiness de propiedad (lote 4) y los paneles. */
export function aiConfigSummary(config: AiConfig = getAiConfig()): AiConfigSummary {
  return {
    provider: config.provider,
    configured: config.configured,
    ...(config.reason !== undefined ? { reason: config.reason } : {}),
    models: { ...config.models },
    monthlyBudgetEurDefault: config.monthlyBudgetEurDefault
  };
}
