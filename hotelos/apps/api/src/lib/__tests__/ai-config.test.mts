// lib/ai-config.ts: único lector de AI_* del API (Tanda L6a, lote 2).
// Run: cd apps/api && node --import tsx --test src/lib/__tests__/ai-config.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiConfigSummary, describeAiHealthCheck, getAiConfig, readAiConfigInput, resetAiConfigForTests, resolveApiAiConfig } from "../ai-config.js";

const SECRET = "sk-test-not-a-real-key";

describe("lib/ai-config.ts", () => {
  it("readAiConfigInput mapea cada variable AI_* a la entrada cruda de ai-core", () => {
    const input = readAiConfigInput({
      AI_PROVIDER: "anthropic",
      AI_PROVIDER_API_KEY: SECRET,
      AI_MODEL: "claude-sonnet-5",
      AI_MODEL_CLASSIFY: "claude-haiku-4-5",
      AI_MODEL_INSIGHTS: "claude-opus-5",
      AI_REQUEST_TIMEOUT_MS: "30000",
      AI_DOCUMENT_TIMEOUT_MS: "90000",
      AI_MONTHLY_BUDGET_EUR_DEFAULT: "40",
      AI_RATE_LIMIT_PER_MINUTE: "10",
      AI_USD_EUR_RATE: "0.92",
      AI_INFERENCE_GEO: "eu"
    });
    assert.deepEqual(input, {
      provider: "anthropic",
      apiKey: SECRET,
      model: "claude-sonnet-5",
      modelClassify: "claude-haiku-4-5",
      modelInsights: "claude-opus-5",
      timeoutMs: "30000",
      documentTimeoutMs: "90000",
      monthlyBudgetEurDefault: "40",
      rateLimitPerMinute: "10",
      usdEurRate: "0.92",
      inferenceGeo: "eu"
    });
    assert.deepEqual(Object.values(readAiConfigInput({})), Array(11).fill(null));
  });

  it("entorno vacío → defectos decididos y configured:false (not_configured)", () => {
    const config = resolveApiAiConfig({});
    assert.equal(config.configured, false);
    assert.equal(config.reason, "not_configured");
    assert.equal(config.provider, "none");
    assert.deepEqual(config.models, { default: "claude-sonnet-5", classify: "claude-haiku-4-5-20251001", insights: "claude-opus-5" });
    assert.equal(config.timeoutMs, 20_000);
    assert.equal(config.documentTimeoutMs, 120_000);
    assert.equal(config.monthlyBudgetEurDefault, 25);
    assert.equal(config.rateLimitPerMinute, 60);
    assert.equal(config.usdEurRate, null);
    assert.equal("apiKey" in config, false);
  });

  it("placeholders de clave cuentan como no configurado", () => {
    for (const placeholder of ["", "change-me", "changeme", "todo", "your-key-here", "placeholder"]) {
      const config = resolveApiAiConfig({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: placeholder });
      assert.equal(config.configured, false, `placeholder «${placeholder}»`);
      assert.equal(config.reason, "not_configured");
    }
  });

  it("clave real con anthropic → configured:true con los valores del entorno", () => {
    const config = resolveApiAiConfig({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: SECRET, AI_USD_EUR_RATE: "0.92", AI_RATE_LIMIT_PER_MINUTE: "5", AI_MONTHLY_BUDGET_EUR_DEFAULT: "0" });
    assert.equal(config.configured, true);
    assert.equal(config.provider, "anthropic");
    assert.equal(config.apiKey, SECRET);
    assert.equal(config.usdEurRate, 0.92);
    assert.equal(config.rateLimitPerMinute, 5);
    assert.equal(config.monthlyBudgetEurDefault, 0, "0 bloquea (no se sustituye por el defecto)");
  });

  it("describeAiHealthCheck describe el estado sin filtrar la clave", () => {
    const check = describeAiHealthCheck(resolveApiAiConfig({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: SECRET, AI_USD_EUR_RATE: "0.92" }));
    assert.equal(check.ok, true);
    assert.equal(check.message, "provider=anthropic model=claude-sonnet-5 classify=claude-haiku-4-5-20251001 budgetDefaultEur=25 rateLimitPerMinute=60 usdEurRate=set");
    assert.equal(check.message.includes(SECRET), false);
    assert.equal(describeAiHealthCheck(resolveApiAiConfig({})).message, "provider=none model=claude-sonnet-5 classify=claude-haiku-4-5-20251001 budgetDefaultEur=25 rateLimitPerMinute=60 usdEurRate=unset reason=not_configured");
  });

  it("aiConfigSummary expone proveedor, motivo, modelos y presupuesto (nunca la clave)", () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    let summary;
    try {
      summary = aiConfigSummary(resolveApiAiConfig({ AI_PROVIDER: "openai", AI_PROVIDER_API_KEY: SECRET }));
    } finally {
      console.warn = original;
    }
    assert.deepEqual(summary, {
      provider: "none",
      configured: false,
      reason: "provider_unsupported",
      models: { default: "claude-sonnet-5", classify: "claude-haiku-4-5-20251001", insights: "claude-opus-5" },
      monthlyBudgetEurDefault: 25
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /no está soportado/);
    const ok = aiConfigSummary(resolveApiAiConfig({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: SECRET, AI_USD_EUR_RATE: "0.92" }));
    assert.equal(ok.configured, true);
    assert.equal("reason" in ok, false);
    assert.equal(JSON.stringify(ok).includes(SECRET), false);
  });

  it("sin AI_USD_EUR_RATE (o con coma decimal) → budget_unavailable con aviso; los valores no numéricos se avisan (SEC-05 / WT-02)", () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      const missing = resolveApiAiConfig({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: SECRET });
      assert.equal(missing.configured, false);
      assert.equal(missing.reason, "budget_unavailable");
      assert.match(describeAiHealthCheck(missing).message, / reason=budget_unavailable$/);
      const comma = resolveApiAiConfig({ AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: SECRET, AI_USD_EUR_RATE: "0,92", AI_MONTHLY_BUDGET_EUR_DEFAULT: "abc" });
      assert.equal(comma.configured, false);
      assert.equal(comma.reason, "budget_unavailable");
      assert.equal(comma.monthlyBudgetEurDefault, 25);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.filter((w) => /sin AI_USD_EUR_RATE utilizable/.test(w)).length, 2);
    assert.ok(warnings.some((w) => /AI_USD_EUR_RATE tiene un valor no numérico/.test(w)));
    assert.ok(warnings.some((w) => /AI_MONTHLY_BUDGET_EUR_DEFAULT tiene un valor no numérico/.test(w)));
  });

  it("getAiConfig cachea y resetAiConfigForTests reconstruye con overrides", () => {
    const first = resetAiConfigForTests({}, {});
    assert.equal(getAiConfig(), first);
    const overridden = resetAiConfigForTests({ model: "claude-sonnet-5-custom" }, {});
    assert.notEqual(getAiConfig(), first);
    assert.equal(overridden.models.default, "claude-sonnet-5-custom");
    assert.equal(getAiConfig().models.classify, "claude-haiku-4-5-20251001");
  });
});
