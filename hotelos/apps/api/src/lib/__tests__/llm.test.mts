// Shim lib/llm.ts sobre @hotelos/ai-core (Tanda L6a, lote 2). Sin red: fetch
// simulado inyectado con resetAiCoreForTests; el entorno se pasa explícito para
// no depender del .env del desarrollador.
// Run: cd apps/api && node --import tsx --test src/lib/__tests__/llm.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resetAiCoreForTests } from "../ai-client.js";
import {
  isLlmConfigured,
  llmClassify,
  llmComplete,
  llmExtractDocument,
  llmExtractJsonFromDocument,
  llmExtractJsonFromImage,
  llmModelName,
  llmProviderName,
  llmStructured
} from "../llm.js";

type Captured = { url: string; body: Record<string, unknown> };

function fakeFetch(captured: Captured[], responder: (body: Record<string, unknown>) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url: String(input), body });
    return new Response(JSON.stringify(responder(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function anthropicText(text: string, model = "claude-sonnet-5", usage = { input_tokens: 100, output_tokens: 50 }) {
  return { id: "msg_test", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage };
}

const CONFIGURED: NodeJS.ProcessEnv = { AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-test-not-a-real-key", AI_USD_EUR_RATE: "0.9" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const FORBIDDEN_MODEL = ["claude", "fable", "5-1"].join("-"); // el literal no puede aparecer en el código
/** Corrección 1 (CFC-06/SEC-01): con clave, toda llamada lleva la organización (ámbito de límite y presupuesto). */
const CTX = { organizationId: "org_test", propertyId: "prop_test" };

describe("lib/llm.ts · shim sobre ai-core", () => {
  it("sin clave: configured:false con motivo tipado y fetch nunca invocado", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: {}, fetchImpl: fakeFetch(captured, () => anthropicText("nunca")) });
    assert.equal(isLlmConfigured(), false);
    assert.equal(llmProviderName(), "none");
    assert.equal(llmModelName(), "claude-sonnet-5");
    assert.equal(llmModelName("classify"), "claude-haiku-4-5-20251001");
    assert.equal(llmModelName("insights"), "claude-opus-5");
    const result = await llmComplete({ prompt: "hola" });
    assert.deepEqual(result, { configured: false, reason: "not_configured", message: "Sin modelo configurado" });
    assert.equal((await llmExtractDocument(PNG)).configured, false);
    assert.equal((await llmExtractJsonFromImage(PNG, "lee")).configured, false);
    assert.equal((await llmClassify({ text: "x", labels: ["a", "b"] })).configured, false);
    assert.equal(captured.length, 0);
  });

  it("placeholder de clave (change-me) cuenta como no configurado", async () => {
    resetAiCoreForTests({ env: { AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "change-me" } });
    assert.equal(isLlmConfigured(), false);
    assert.equal((await llmComplete({ prompt: "hola" })).configured, false);
  });

  it("AI_PROVIDER=openai → provider_unsupported (sin rama OpenAI)", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      resetAiCoreForTests({ env: { AI_PROVIDER: "openai", AI_PROVIDER_API_KEY: "sk-test-openai" } });
    } finally {
      console.warn = original;
    }
    assert.equal(isLlmConfigured(), false);
    assert.equal(llmProviderName(), "none");
    const result = await llmComplete({ prompt: "hola" });
    assert.equal(result.configured, false);
    if (!result.configured) assert.equal(result.reason, "provider_unsupported");
    assert.ok(warnings.some((w) => /AI_PROVIDER=openai/.test(w)), "aviso en el arranque");
  });

  it("modelo de la familia vetada → model_forbidden aunque haya clave", async () => {
    const original = console.warn;
    console.warn = () => undefined;
    try {
      resetAiCoreForTests({ env: { ...CONFIGURED, AI_MODEL: FORBIDDEN_MODEL } });
    } finally {
      console.warn = original;
    }
    assert.equal(isLlmConfigured(), false);
    const result = await llmComplete({ prompt: "hola" });
    assert.equal(result.configured, false);
    if (!result.configured) assert.equal(result.reason, "model_forbidden");
  });

  it("llmComplete devuelve text/model/tokens y el coste en USD y EUR (AI_USD_EUR_RATE=0.9)", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText("Buenos días")) });
    assert.equal(isLlmConfigured(), true);
    assert.equal(llmProviderName(), "anthropic");
    const result = await llmComplete({ system: "Eres útil", prompt: "saluda", maxTokens: 64, temperature: 0.1, ctx: CTX });
    assert.equal(result.configured, true);
    if (!result.configured) return;
    assert.equal(result.text, "Buenos días");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude-sonnet-5");
    assert.equal(result.tokensInput, 100);
    assert.equal(result.tokensOutput, 50);
    // sonnet-5: 100 × 2 $/M + 50 × 10 $/M = 0,0007 $ → 0,00063 €
    assert.equal(result.costUsd, 0.0007);
    assert.equal(result.costEur, 0.00063);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(typeof result.latencyMs, "number");
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.url, /\/v1\/messages$/);
    assert.equal(captured[0]!.body.model, "claude-sonnet-5");
    assert.equal(captured[0]!.body.max_tokens, 64);
    assert.equal(captured[0]!.body.system, "Eres útil");
    assert.equal("temperature" in captured[0]!.body, false, "sonnet-5 no admite temperature: se descarta");
    assert.deepEqual(captured[0]!.body.thinking, { type: "disabled" }, "CFC-01: sin effort, Sonnet 5 no razona (max_tokens pequeños no truncan)");
  });

  it("con clave pero sin organización en ctx → context_required y fetch NUNCA invocado (CFC-06 / SEC-01: sin cubo `unscoped`)", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText("nunca")) });
    assert.equal(isLlmConfigured(), true);
    for (const result of [await llmComplete({ prompt: "hola" }), await llmExtractDocument(PNG), await llmExtractJsonFromImage(PNG, "lee"), await llmClassify({ text: "x", labels: ["a", "b"] }), await llmStructured({ prompt: "x", schema: { type: "object" } }), await llmComplete({ prompt: "hola", ctx: { organizationId: "  " } })]) {
      assert.equal(result.configured, false);
      if (!result.configured) {
        assert.equal(result.reason, "context_required");
        assert.match(String(result.message), /organización/);
      }
    }
    assert.equal(captured.length, 0, "sin organización no hay llamada al proveedor");
  });

  it("temperature sí viaja a un modelo con sampling (rol classify = Haiku 4.5)", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText("ok", "claude-haiku-4-5-20251001")) });
    const result = await llmComplete({ prompt: "clasifica", model: "classify", temperature: 0.2, ctx: CTX });
    assert.equal(result.configured, true);
    assert.equal(captured[0]!.body.model, "claude-haiku-4-5-20251001");
    assert.equal(captured[0]!.body.temperature, 0.2);
  });

  it("sin tipo de cambio la IA no arranca: budget_unavailable y fetch nunca invocado (SEC-05: el presupuesto sería inaplicable)", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: { AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-test-not-a-real-key" }, fetchImpl: fakeFetch(captured, () => anthropicText("x")) });
    assert.equal(isLlmConfigured(), false);
    const result = await llmComplete({ prompt: "x", ctx: CTX });
    assert.equal(result.configured, false);
    if (!result.configured) assert.equal(result.reason, "budget_unavailable");
    assert.equal(captured.length, 0);
    // Coma decimal (error típico es-ES): mismo resultado, nunca un tipo de cambio fabricado.
    resetAiCoreForTests({ env: { ...CONFIGURED, AI_USD_EUR_RATE: "0,92" }, fetchImpl: fakeFetch(captured, () => anthropicText("x")) });
    assert.equal(isLlmConfigured(), false);
  });

  it("llmExtractDocument devuelve DocFields con confianza por campo", async () => {
    const captured: Captured[] = [];
    const payload = {
      documentType: "DNI",
      documentNumber: "00000000T",
      documentSupportNumber: null,
      firstName: "Prueba",
      surname1: "Ficticia",
      surname2: null,
      dateOfBirth: "1990-01-01",
      nationality: "ESP",
      sex: "F",
      confidence: { documentType: 0.99, documentNumber: 0.7, documentSupportNumber: null, firstName: 0.9, surname1: 0.9, surname2: null, dateOfBirth: 0.8, nationality: 0.95, sex: 0.6 }
    };
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText(JSON.stringify(payload))) });
    const result = await llmExtractDocument(PNG, CTX);
    assert.equal(result.configured, true);
    if (!result.configured) return;
    assert.deepEqual(result.fields, { documentType: "DNI", documentNumber: "00000000T", firstName: "Prueba", surname1: "Ficticia", dateOfBirth: "1990-01-01", nationality: "ESP", sex: "F" });
    assert.equal(result.confidence?.documentNumber, 0.7);
    assert.equal(result.confidence?.surname2, undefined);
    assert.equal(result.tokensInput, 100);
    assert.equal(result.costEur, 0.00063);
    const content = (captured[0]!.body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content;
    assert.deepEqual(content.map((block) => block.type), ["image", "text"]);
    assert.equal((captured[0]!.body.output_config as { format?: { type: string } }).format?.type, "json_schema");
  });

  it("llmExtractDocument con una URL de datos inválida no llama al proveedor", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText("{}")) });
    const result = await llmExtractDocument("not-a-data-url", CTX);
    assert.equal(result.configured, false);
    if (!result.configured) assert.equal(result.reason, "invalid_image");
    assert.equal(captured.length, 0);
  });

  it("llmExtractJsonFromImage devuelve el objeto JSON de la respuesta (y {} sin JSON, como antes)", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText('Aquí tienes: {"issueDate":"2026-01-02","expiryDate":"2027-01-02"}')) });
    const result = await llmExtractJsonFromImage(PNG, "lee las fechas", CTX);
    assert.equal(result.configured, true);
    if (result.configured) assert.deepEqual(result.data, { issueDate: "2026-01-02", expiryDate: "2027-01-02" });
    assert.equal(captured[0]!.body.max_tokens, 400);

    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch([], () => anthropicText("no veo ninguna fecha")) });
    const empty = await llmExtractJsonFromImage(PNG, "lee las fechas", CTX);
    assert.equal(empty.configured, true);
    if (empty.configured) {
      assert.deepEqual(empty.data, {});
      // CFC-02: la llamada se facturó; los tokens y el coste son los reales, nunca ceros fabricados.
      assert.equal(empty.tokensInput, 100);
      assert.equal(empty.tokensOutput, 50);
      assert.equal(empty.costEur, 0.00063);
      assert.equal(empty.model, "claude-sonnet-5");
    }
  });

  it("llmExtractJsonFromDocument envía un bloque document y devuelve telemetría sin bytes", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => anthropicText('{"total": 120.5}')) });
    const pdfBase64 = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n").toString("base64");
    const result = await llmExtractJsonFromDocument({
      pdfBase64,
      schema: { type: "object", additionalProperties: false, required: ["total"], properties: { total: { type: "number" } } },
      instruction: "Extrae el total"
    }, CTX);
    assert.equal(result.configured, true);
    if (!result.configured) return;
    assert.deepEqual(result.data, { total: 120.5 });
    assert.equal(result.document?.pages, 1);
    assert.match(result.document?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(captured[0]!.body.max_tokens, 4000);
    const content = (captured[0]!.body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content;
    assert.deepEqual(content.map((block) => block.type), ["document", "text"]);
  });

  it("llmStructured valida la salida contra el esquema y llmClassify usa el rol classify", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, (body) => anthropicText(String(body.model).startsWith("claude-haiku") ? '{"label":"queja","confidence":0.8,"rationale":"tono"}' : '{"ok":true}')) });
    const structured = await llmStructured<{ ok: boolean }>({ prompt: "di ok", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } }, CTX);
    assert.equal(structured.configured, true);
    if (structured.configured) assert.deepEqual(structured.data, { ok: true });
    const classified = await llmClassify({ text: "La habitación estaba sucia", labels: ["queja", "elogio"] }, CTX);
    assert.equal(classified.configured, true);
    if (classified.configured) {
      assert.equal(classified.label, "queja");
      assert.equal(classified.confidence, 0.8);
      assert.equal(classified.model, "claude-haiku-4-5-20251001");
    }
    assert.equal(captured[1]!.body.model, "claude-haiku-4-5-20251001");
  });
});
