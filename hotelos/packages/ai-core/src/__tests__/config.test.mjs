// Configuración de IA: placeholders, proveedores no soportados, lista negra
// de modelos por retención y defectos exactos. Sin red.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODELS,
  FORBIDDEN_MODEL_PATTERN,
  PLACEHOLDER_API_KEYS,
  isForbiddenModel,
  isPlaceholderApiKey,
  resolveAiConfig
} from "../config.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

// El literal del modelo vetado no aparece en el código: se construye en tiempo de ejecución.
const FORBIDDEN_ID = ["claude", "fable", "5", "1"].join("-");

test("sin proveedor: configured:false con reason not_configured y defectos exactos", () => {
  const config = resolveAiConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.provider, "none");
  assert.equal(config.reason, "not_configured");
  assert.deepEqual(config.models, { default: "claude-sonnet-5", classify: "claude-haiku-4-5-20251001", insights: "claude-opus-5" });
  assert.deepEqual(DEFAULT_MODELS, config.models);
  assert.equal(config.timeoutMs, 20000);
  assert.equal(config.documentTimeoutMs, 120000);
  assert.equal(config.monthlyBudgetEurDefault, 25);
  assert.equal(config.rateLimitPerMinute, 60);
  assert.equal(config.usdEurRate, null);
  assert.equal(config.apiKey, undefined);
  assert.equal("inferenceGeo" in config, false);
});

test("placeholders de clave (misma lista que env.ts PLACEHOLDER_VALUES) → not_configured", () => {
  assert.deepEqual([...PLACEHOLDER_API_KEYS], ["", "change-me", "changeme", "todo", "your-key-here", "placeholder"]);
  for (const key of [...PLACEHOLDER_API_KEYS, "  CHANGE-ME ", undefined, null]) {
    const config = resolveAiConfig({ provider: "anthropic", apiKey: key });
    assert.equal(config.configured, false, `clave ${JSON.stringify(key)}`);
    assert.equal(config.reason, "not_configured");
    assert.equal(config.provider, "none");
    assert.equal(isPlaceholderApiKey(key), true);
  }
  assert.equal(isPlaceholderApiKey("sk-ant-real"), false);
});

test("provider openai (u otro) → provider_unsupported aunque haya clave", () => {
  for (const provider of ["openai", "OpenAI", "azure", "gemini"]) {
    const config = resolveAiConfig({ provider, apiKey: "sk-real" });
    assert.equal(config.configured, false);
    assert.equal(config.reason, "provider_unsupported");
    assert.equal(config.provider, "none");
  }
});

test("modelos vetados por retención (fable/mythos) en cualquier rol → model_forbidden", () => {
  assert.equal(FORBIDDEN_MODEL_PATTERN.test(FORBIDDEN_ID), true);
  assert.equal(isForbiddenModel("Claude-Mythos-1"), true);
  assert.equal(isForbiddenModel("claude-sonnet-5"), false);
  assert.equal(isForbiddenModel("claude-haiku-4-5-20251001"), false);
  assert.equal(isForbiddenModel("claude-opus-5"), false);
  for (const field of ["model", "modelClassify", "modelInsights"]) {
    const config = resolveAiConfig({ provider: "anthropic", apiKey: "sk-real", [field]: FORBIDDEN_ID });
    assert.equal(config.configured, false, field);
    assert.equal(config.reason, "model_forbidden", field);
    assert.equal(config.provider, "none");
  }
  // Prevalece sobre la clave ausente: la política se ve aunque no haya clave.
  assert.equal(resolveAiConfig({ provider: "anthropic", model: FORBIDDEN_ID }).reason, "model_forbidden");
  // Con provider none la razón sigue siendo not_configured (IA apagada a propósito).
  assert.equal(resolveAiConfig({ provider: "none", model: FORBIDDEN_ID }).reason, "not_configured");
});

test("anthropic con clave real → configured:true, overrides y parseo numérico", () => {
  const config = resolveAiConfig({
    provider: " Anthropic ",
    apiKey: " sk-real ",
    model: "claude-sonnet-5-20260601",
    modelClassify: "claude-haiku-4-5",
    timeoutMs: "45000",
    documentTimeoutMs: 90000,
    monthlyBudgetEurDefault: "0",
    rateLimitPerMinute: "120",
    usdEurRate: "0.92",
    inferenceGeo: "eu"
  });
  assert.equal(config.configured, true);
  assert.equal(config.provider, "anthropic");
  assert.equal(config.reason, undefined);
  assert.equal(config.apiKey, "sk-real");
  assert.deepEqual(config.models, { default: "claude-sonnet-5-20260601", classify: "claude-haiku-4-5", insights: "claude-opus-5" });
  assert.equal(config.timeoutMs, 45000);
  assert.equal(config.documentTimeoutMs, 90000);
  assert.equal(config.monthlyBudgetEurDefault, 0);
  assert.equal(config.rateLimitPerMinute, 120);
  assert.equal(config.usdEurRate, 0.92);
  assert.equal(config.inferenceGeo, "eu");
});

test("anthropic con clave real pero sin tipo de cambio utilizable → configured:false budget_unavailable (SEC-05); coma decimal se avisa (WT-02)", () => {
  const missing = resolveAiConfig({ provider: "anthropic", apiKey: "sk-real" });
  assert.equal(missing.configured, false);
  assert.equal(missing.reason, "budget_unavailable");
  assert.equal(missing.usdEurRate, null);
  const comma = resolveAiConfig({ provider: "anthropic", apiKey: "sk-real", usdEurRate: "0,92", monthlyBudgetEurDefault: "abc" });
  assert.equal(comma.configured, false);
  assert.equal(comma.reason, "budget_unavailable");
  assert.equal(comma.monthlyBudgetEurDefault, 25, "el defecto se aplica pero queda avisado");
  assert.deepEqual(comma.invalidInputs, ["AI_MONTHLY_BUDGET_EUR_DEFAULT", "AI_USD_EUR_RATE"]);
  assert.equal("invalidInputs" in resolveAiConfig({ provider: "anthropic", apiKey: "sk-real", usdEurRate: "0.92" }), false);
});

test("valores numéricos inválidos o fuera de rango vuelven al defecto; rate inválido → null (nunca 0)", () => {
  const config = resolveAiConfig({ provider: "anthropic", apiKey: "sk-real", timeoutMs: "500", documentTimeoutMs: "abc", rateLimitPerMinute: "-5", usdEurRate: "abc" });
  assert.equal(config.configured, false);
  assert.equal(config.reason, "budget_unavailable");
  assert.deepEqual(config.invalidInputs, ["AI_DOCUMENT_TIMEOUT_MS", "AI_USD_EUR_RATE"]);
  assert.equal(config.timeoutMs, 20000);
  assert.equal(config.documentTimeoutMs, 120000);
  assert.equal(config.rateLimitPerMinute, 60);
  assert.equal(config.usdEurRate, null);
  assert.equal(resolveAiConfig({ usdEurRate: "0" }).usdEurRate, null);
  assert.equal(resolveAiConfig({ usdEurRate: "-1" }).usdEurRate, null);
});
