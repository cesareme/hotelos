// createAiCore: respaldo honesto sin clave, parámetros por capacidad, caché,
// PII, salidas estructuradas, refusal, truncado, rate limit, coste y telemetría.
// Sin red: fetch simulado que graba cuerpos.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAiConfig } from "../config.ts";
import { AiError } from "../errors.ts";
import { createAiCore, telemetryFromAiResult, validateJsonSchema } from "../messages.ts";
import { createRateLimiter } from "../rate-limit.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

const CTX = { organizationId: "org_test", propertyId: "prop_1", toolName: "guest_message_reply", purpose: "complete" };
const CONFIGURED = resolveAiConfig({ provider: "anthropic", apiKey: "sk-test", usdEurRate: "0.9" });

function message(content, extra = {}) {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500 }, ...extra };
}
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function fakeFetch(responders) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responders.shift();
    if (next === undefined) throw new Error("sin respuesta simulada");
    return typeof next === "function" ? next() : next;
  };
  return { impl, calls };
}
function core(responders, extra = {}, config = CONFIGURED) {
  const { impl, calls } = fakeFetch(responders.map((r) => (r instanceof Response || typeof r === "function" ? r : json(200, r))));
  let clock = 1_000;
  const ai = createAiCore({ config, fetchImpl: impl, now: () => (clock += 25), sleep: async () => undefined, ...extra });
  return { ai, calls };
}

test("sin clave: configured:false con reason y etiqueta en español, y fetch nunca invocado", async () => {
  let fetches = 0;
  const ai = createAiCore({
    config: resolveAiConfig({ provider: "anthropic", apiKey: "change-me" }),
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("no debería llamarse");
    }
  });
  assert.equal(ai.isConfigured(), false);
  assert.equal(ai.providerName(), "none");
  assert.equal(ai.modelName(), "claude-sonnet-5");
  assert.equal(ai.modelName("classify"), "claude-haiku-4-5-20251001");
  assert.equal(ai.modelName("insights"), "claude-opus-5");
  assert.equal(ai.getClient(), null);
  const result = await ai.complete({ prompt: "hola" }, CTX);
  assert.deepEqual(result, { configured: false, reason: "not_configured", message: "Sin modelo configurado" });
  assert.deepEqual(await ai.structured({ prompt: "x", schema: { type: "object" } }, CTX), result);
  assert.deepEqual(await ai.classify({ text: "x", labels: ["a", "b"] }, CTX), result);
  assert.deepEqual(await ai.insight({ prompt: "x" }, CTX), result);
  assert.deepEqual(await ai.extractIdentityDocument("data:image/png;base64,AAAA", CTX), result);
  assert.equal(telemetryFromAiResult(result), null);
  assert.equal(fetches, 0);
  const unsupported = createAiCore({ config: resolveAiConfig({ provider: "openai", apiKey: "sk-x" }) });
  assert.deepEqual(await unsupported.complete({ prompt: "hola" }, CTX), { configured: false, reason: "provider_unsupported", message: "Proveedor de IA no soportado" });
});

test("complete: cuerpo mínimo, temperature ausente con sonnet-5 y presente con haiku; effort solo con sonnet/opus; thinking explícito y max_tokens ≥ 2048 con razonamiento (CFC-01)", async () => {
  const { ai, calls } = core([message([{ type: "text", text: "Hola" }]), message([{ type: "text", text: "Hola" }]), message([{ type: "text", text: "Hola" }]), message([{ type: "text", text: "Hola" }])]);
  const result = await ai.complete({ system: "Sé breve.", prompt: "¿Hora de salida?", maxTokens: 50 }, CTX, { temperature: 0.2, effort: "low" });
  assert.equal(result.configured, true);
  assert.equal(result.text, "Hola");
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.toolUses, []);
  const body = calls[0].body;
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(body.model, "claude-sonnet-5");
  assert.deepEqual(body.thinking, { type: "adaptive" }, "effort pedido sin thinking → razonamiento adaptativo");
  assert.equal(body.max_tokens, 2048, "con razonamiento el tope cubre pensamiento + respuesta: se eleva a 2048");
  assert.equal(body.system, "Sé breve.");
  assert.deepEqual(body.messages, [{ role: "user", content: "¿Hora de salida?" }]);
  assert.equal("temperature" in body, false, "sonnet-5 rechaza temperature");
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal("tools" in body, false);
  assert.equal("inference_geo" in body, false);

  await ai.complete({ prompt: "clasifica" }, CTX, { model: "classify", temperature: 0.2, effort: "low" });
  assert.equal(calls[1].body.model, "claude-haiku-4-5-20251001");
  assert.equal(calls[1].body.temperature, 0.2, "haiku admite temperature");
  assert.equal("output_config" in calls[1].body, false, "haiku no admite effort");
  assert.equal("thinking" in calls[1].body, false, "haiku 4.5: sin thinking (solo budget_tokens explícito)");

  await ai.complete({ prompt: "insight" }, CTX, { model: "insights", effort: "high", inferenceGeo: "eu" });
  assert.equal(calls[2].body.model, "claude-opus-5");
  assert.deepEqual(calls[2].body.output_config, { effort: "high" });
  assert.deepEqual(calls[2].body.thinking, { type: "adaptive" });
  assert.equal(calls[2].body.inference_geo, "eu");

  await ai.complete({ prompt: "literal" }, CTX, { model: "claude-sonnet-5-20260601" });
  assert.equal(calls[3].body.model, "claude-sonnet-5-20260601");
  assert.equal(calls[3].body.max_tokens, 1024, "sin razonamiento el max_tokens pedido se respeta");
  assert.deepEqual(calls[3].body.thinking, { type: "disabled" }, "Sonnet 5 sin effort ni thinking: razonamiento desactivado (barato)");
  assert.equal("output_config" in calls[3].body, false);
});

test("razonamiento por modelo: Opus 5 sin effort → adaptativo a effort low; disabled con xhigh|max → adaptativo; inference_geo nunca a Haiku 4.5 (CFC-01/CFC-03)", async () => {
  const geo = resolveAiConfig({ provider: "anthropic", apiKey: "sk-test", usdEurRate: "0.9", inferenceGeo: "eu" });
  const { ai, calls } = core([message([{ type: "text", text: "a" }]), message([{ type: "text", text: "b" }]), message([{ type: "text", text: '{"label":"a","confidence":0.5,"rationale":"x"}' }]), message([{ type: "text", text: "c" }])], {}, geo);
  await ai.complete({ prompt: "x", maxTokens: 150 }, CTX, { model: "insights" });
  assert.deepEqual(calls[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(calls[0].body.output_config, { effort: "low" });
  assert.equal(calls[0].body.max_tokens, 2048);
  assert.equal(calls[0].body.inference_geo, "eu");
  await ai.complete({ prompt: "x", maxTokens: 150 }, CTX, { model: "insights", thinking: "disabled", effort: "max" });
  assert.deepEqual(calls[1].body.thinking, { type: "adaptive" }, "disabled solo se admite hasta effort high");
  assert.deepEqual(calls[1].body.output_config, { effort: "max" });
  await ai.classify({ text: "hola", labels: ["a", "b"] }, CTX);
  assert.equal(calls[2].body.model, "claude-haiku-4-5-20251001");
  assert.equal("inference_geo" in calls[2].body, false, "Haiku 4.5 no admite inference_geo aunque AI_INFERENCE_GEO esté definida");
  assert.equal("thinking" in calls[2].body, false);
  await ai.complete({ prompt: "x", maxTokens: 150 }, CTX, { thinking: "adaptive" });
  assert.deepEqual(calls[3].body.thinking, { type: "adaptive" });
  assert.equal("output_config" in calls[3].body, false, "thinking explícito sin effort: effort del proveedor");
  assert.equal(calls[3].body.max_tokens, 2048);
});

test("truncado por max_tokens sin texto → AiError truncated con telemetría; structured/extractJsonFromImage con JSON inválido llevan la telemetría facturada (CFC-01/CFC-02)", async () => {
  const cut = () => message([{ type: "thinking", thinking: "" }, { type: "text", text: "" }], { stop_reason: "max_tokens", usage: { input_tokens: 1200, output_tokens: 150 } });
  const { ai } = core([cut(), cut(), message([{ type: "text", text: '{"a": 1}' }], { usage: { input_tokens: 700, output_tokens: 30 } }), message([{ type: "text", text: "sin json" }], { usage: { input_tokens: 300, output_tokens: 10 } })]);
  await assert.rejects(ai.complete({ prompt: "y", maxTokens: 150 }, CTX), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "truncated");
    assert.deepEqual(error.telemetry, { model: "claude-sonnet-5", tokensInput: 1200, tokensOutput: 150, cacheReadTokens: 0, costUsd: 0.0039, costEur: 0.00351, latencyMs: 25 });
    return true;
  });
  const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
  await assert.rejects(ai.structured({ prompt: "y", schema }, CTX), (error) => error.code === "truncated" && error.telemetry.tokensInput === 1200);
  await assert.rejects(ai.structured({ prompt: "y", schema }, CTX), (error) => error.code === "invalid_output" && error.telemetry.tokensInput === 700 && error.telemetry.costEur === 0.00153);
  await assert.rejects(ai.extractJsonFromImage("data:image/png;base64,QUJD", "lee", CTX), (error) => error.code === "invalid_output" && error.telemetry.tokensInput === 300);
});

test("PII: nombres sin tratamiento y PII conocida del huésped (knownPii) se redactan; redactSystem redacta el system con el mismo mapa (SEC-07)", async () => {
  const { ai, calls } = core([message([{ type: "text", text: "Hola [NOMBRE_1], su teléfono [TEL_1] queda anotado." }])]);
  const result = await ai.complete(
    { system: "Huésped: Ludmila Ferreiro, tel 612 345 678, DNI 12345678Z.", prompt: "Hola, soy Ludmila Ferreiro y mi hija Aroa Ferreiro llega mañana." },
    CTX,
    { knownPii: [{ kind: "name", value: "Ludmila Ferreiro" }, { kind: "phone", value: "+34 612 345 678" }], redactSystem: true }
  );
  const body = calls[0].body;
  assert.equal(body.system, "Huésped: [NOMBRE_1], tel [TEL_1], DNI [DOC_1].");
  assert.equal(body.messages[0].content, "Hola, soy [NOMBRE_1] y mi hija [NOMBRE_2] llega mañana.");
  assert.equal(result.text, "Hola Ludmila Ferreiro, su teléfono +34 612 345 678 queda anotado.");
  // Sin redactSystem, el system viaja tal cual (instrucciones propias).
  const plain = core([message([{ type: "text", text: "ok" }])]);
  await plain.ai.complete({ system: "Huésped: Ludmila Ferreiro", prompt: "¿Parking?" }, CTX);
  assert.equal(plain.calls[0].body.system, "Huésped: Ludmila Ferreiro");
});

test("modelo literal vetado → AiError model_forbidden sin fetch; prompt y messages a la vez → TypeError", async () => {
  const { ai, calls } = core([]);
  const forbidden = ["claude", "fable", "5", "1"].join("-");
  await assert.rejects(ai.complete({ prompt: "x" }, CTX, { model: forbidden }), (error) => error instanceof AiError && error.code === "model_forbidden");
  await assert.rejects(ai.complete({ prompt: "x", messages: [{ role: "user", content: "y" }] }, CTX), TypeError);
  await assert.rejects(ai.complete({}, CTX), TypeError);
  assert.equal(calls.length, 0);
});

test("cache_control en system solo con opts.cache.system y ≥ 1024 tokens en sonnet-5 (haiku exige 4096)", async () => {
  const long = "x".repeat(5000); // ≈ 1250 tokens
  const short = "Sé breve.";
  const { ai, calls } = core([message([]), message([]), message([]), message([]), message([])]);
  await ai.complete({ system: long, prompt: "a" }, CTX, { cache: { system: true } });
  assert.deepEqual(calls[0].body.system, [{ type: "text", text: long, cache_control: { type: "ephemeral" } }]);
  await ai.complete({ system: long, prompt: "a" }, CTX, { cache: { system: true, ttl: "1h" } });
  assert.deepEqual(calls[1].body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  await ai.complete({ system: short, prompt: "a" }, CTX, { cache: { system: true } });
  assert.equal(calls[2].body.system, short, "por debajo del mínimo: cadena simple");
  await ai.complete({ system: long, prompt: "a" }, CTX);
  assert.equal(calls[3].body.system, long, "sin opts.cache: cadena simple");
  await ai.complete({ system: long, prompt: "a" }, CTX, { model: "classify", cache: { system: true } });
  assert.equal(calls[4].body.system, long, "haiku: 1250 < 4096 tokens");
});

test("PII: el cuerpo lleva [NOMBRE_1] y no el nombre; la salida restaura el nombre; redactPii:false lo desactiva", async () => {
  const { ai, calls } = core([
    message([{ type: "text", text: "Estimada Sra. NOMBRE_1, escribiremos a [EMAIL_1] hoy." }]),
    message([{ type: "text", text: "ok" }])
  ]);
  const result = await ai.complete({ system: "Trata a la Sra. Ludmila Ferreiro con respeto.", prompt: "Mensaje de la Sra. Ludmila Ferreiro (ana@example.com): ¿tienen parking?" }, CTX);
  const sent = calls[0].body.messages[0].content;
  assert.ok(sent.includes("[NOMBRE_1]"), sent);
  assert.ok(sent.includes("[EMAIL_1]"), sent);
  assert.ok(!sent.includes("Ludmila"), sent);
  assert.ok(!sent.includes("ana@example.com"), sent);
  assert.equal(calls[0].body.system, "Trata a la Sra. Ludmila Ferreiro con respeto.", "el system propio no se redacta");
  assert.equal(result.text, "Estimada Sra. Ludmila Ferreiro, escribiremos a ana@example.com hoy.");

  await ai.complete({ prompt: "Sra. Ludmila Ferreiro" }, CTX, { redactPii: false });
  assert.equal(calls[1].body.messages[0].content, "Sra. Ludmila Ferreiro");
});

test("messages multi-turno: se redactan usuario, asistente y tool_result con un único mapa", async () => {
  const { ai, calls } = core([message([{ type: "text", text: "Anotado para NOMBRE_1." }])]);
  const result = await ai.complete(
    {
      messages: [
        { role: "user", content: "Soy la Sra. Ludmila Ferreiro." },
        { role: "assistant", content: [{ type: "text", text: "Hola, Sra. Ludmila Ferreiro." }, { type: "tool_use", id: "tu_1", name: "lookup", input: { guest: "Ludmila Ferreiro" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Reserva de la Sra. Ludmila Ferreiro, tel 612 345 678" }] }
      ]
    },
    CTX
  );
  const sent = JSON.stringify(calls[0].body.messages);
  assert.ok(!sent.includes("Ludmila"), sent);
  assert.ok(!sent.includes("612 345 678"), sent);
  assert.equal((sent.match(/\[NOMBRE_1\]/g) ?? []).length, 4, "usuario, texto del asistente, tool_use.input y tool_result");
  assert.equal(result.text, "Anotado para Ludmila Ferreiro.");
});

test("structured: output_config.format json_schema, data validada y PII restaurada; inválido → AiError invalid_output", async () => {
  const schema = { type: "object", additionalProperties: false, required: ["label", "score", "guest"], properties: { label: { type: "string", enum: ["ok", "ko"] }, score: { type: "number" }, guest: { type: "string" } } };
  const { ai, calls } = core([
    message([{ type: "text", text: '{"label":"ok","score":0.9,"guest":"[NOMBRE_1]"}' }]),
    message([{ type: "text", text: '{"label":"ok"}' }]),
    message([{ type: "text", text: "no es json" }]),
    message([{ type: "text", text: '{"label":"otra","score":1,"guest":"x"}' }])
  ]);
  const result = await ai.structured({ system: "Clasifica.", prompt: "Mensaje de la Sra. Ludmila Ferreiro", schema }, CTX, { effort: "medium" });
  assert.equal(result.configured, true);
  assert.deepEqual(result.data, { label: "ok", score: 0.9, guest: "Ludmila Ferreiro" });
  assert.deepEqual(calls[0].body.output_config, { effort: "medium", format: { type: "json_schema", schema } });
  await assert.rejects(ai.structured({ prompt: "x", schema }, CTX), (error) => error instanceof AiError && error.code === "invalid_output" && /score/.test(error.message));
  await assert.rejects(ai.structured({ prompt: "x", schema }, CTX), (error) => error.code === "invalid_output");
  await assert.rejects(ai.structured({ prompt: "x", schema }, CTX), (error) => error.code === "invalid_output" && /enum/.test(error.message));
});

test("validateJsonSchema: required, tipos primitivos, enum, anyOf, items; sin minimum/maxLength", () => {
  const schema = { type: "object", required: ["a", "b"], properties: { a: { type: "integer" }, b: { anyOf: [{ type: "string" }, { type: "null" }] }, c: { type: "array", items: { type: "boolean" } }, d: { type: "number", minimum: 100 } } };
  assert.deepEqual(validateJsonSchema({ a: 1, b: null, c: [true], d: 5 }, schema), []);
  assert.deepEqual(validateJsonSchema({ a: 1.5, c: [1] }, schema), ["$.b: obligatorio", "$.a: tipo esperado integer", "$.c[0]: tipo esperado boolean"]);
  assert.deepEqual(validateJsonSchema({ a: 1, b: 2 }, schema), ["$.b: no cumple ninguna alternativa de anyOf"]);
  assert.deepEqual(validateJsonSchema("x", { type: ["string", "null"] }), []);
  assert.deepEqual(validateJsonSchema(3, { enum: [1, 2] }), ["$: valor fuera de enum"]);
});

test("stop_reason refusal → configured:false reason refusal con telemetría; max_tokens → truncated:true", async () => {
  const { ai } = core([
    message([{ type: "text", text: "" }], { stop_reason: "refusal", stop_details: { type: "safety" } }),
    message([{ type: "text", text: "Texto cortado" }], { stop_reason: "max_tokens" })
  ]);
  const refused = await ai.complete({ prompt: "x" }, CTX);
  assert.equal(refused.configured, false);
  assert.equal(refused.reason, "refusal");
  assert.equal(refused.message, "El modelo rechazó la petición");
  assert.equal(refused.telemetry.tokensInput, 1000);
  assert.equal(telemetryFromAiResult(refused).costEur, 0.0063);
  const truncated = await ai.complete({ prompt: "x" }, CTX);
  assert.equal(truncated.configured, true);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.stopReason, "max_tokens");
  assert.equal(truncated.text, "Texto cortado");
});

test("limiter agotado → AiError rate_limited con retryAfterMs y sin fetch", async () => {
  const limiter = createRateLimiter({ perMinute: 1, now: () => 0 });
  const { ai, calls } = core([message([{ type: "text", text: "uno" }]), message([{ type: "text", text: "dos" }])], { limiter });
  const first = await ai.complete({ prompt: "x" }, CTX);
  assert.equal(first.text, "uno");
  await assert.rejects(ai.complete({ prompt: "x" }, CTX), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterMs > 0);
    return true;
  });
  assert.equal(calls.length, 1);
  // Otra organización no comparte el cubo.
  const other = await ai.complete({ prompt: "x" }, { ...CTX, organizationId: "org_other" });
  assert.equal(other.text, "dos");
});

test("coste y telemetría: usage simulado con caché, rate 0,9, latencia con reloj inyectado", async () => {
  const { ai } = core([message([{ type: "text", text: "ok" }], { usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 } })]);
  const result = await ai.complete({ prompt: "x" }, CTX);
  assert.deepEqual(result.usage, { tokensInput: 1000, tokensOutput: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 });
  assert.equal(result.tokensInput, 1000);
  assert.equal(result.tokensOutput, 500);
  assert.equal(result.costUsd, 0.00765);
  assert.equal(result.costEur, 0.006885);
  assert.equal(result.latencyMs, 25);
  assert.deepEqual(telemetryFromAiResult(result), { model: "claude-sonnet-5", tokensInput: 1000, tokensOutput: 500, cacheReadTokens: 2000, costUsd: 0.00765, costEur: 0.006885, latencyMs: 25 });
  assert.equal(telemetryFromAiResult(null), null);

  // Sin tipo de cambio el núcleo no arranca (SEC-05: el presupuesto sería inaplicable).
  assert.equal(resolveAiConfig({ provider: "anthropic", apiKey: "sk-test" }).reason, "budget_unavailable");
  // Modelo fuera de la tabla de precios: coste desconocido → null, nunca 0.
  const unknown = core([message([{ type: "text", text: "ok" }])]);
  const r2 = await unknown.ai.complete({ prompt: "x" }, CTX, { model: "claude-modelo-sin-precio" });
  assert.equal(r2.costUsd, null);
  assert.equal(r2.costEur, null);
});

test("classify usa el rol classify con temperature 0, enum de etiquetas y structured; insight usa opus con effort medium", async () => {
  const { ai, calls } = core([
    message([{ type: "text", text: '{"label":"queja","confidence":1.4,"rationale":"tono negativo"}' }]),
    message([{ type: "text", text: "Resumen ejecutivo" }])
  ]);
  const classified = await ai.classify({ text: "Estoy muy descontento con la Sra. Ludmila Ferreiro", labels: ["queja", "consulta", "queja"] }, CTX);
  assert.equal(classified.configured, true);
  assert.equal(classified.label, "queja");
  assert.equal(classified.confidence, 1, "confianza acotada a [0,1]");
  assert.equal(classified.rationale, "tono negativo");
  const body = calls[0].body;
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.output_config.format.schema.properties.label.enum, ["queja", "consulta"]);
  assert.ok(body.messages[0].content.includes("[NOMBRE_1]"));
  assert.ok(!body.messages[0].content.includes("Ludmila"));

  const insight = await ai.insight({ system: "Eres director.", prompt: "Resume el día" }, CTX);
  assert.equal(insight.text, "Resumen ejecutivo");
  assert.equal(calls[1].body.model, "claude-opus-5");
  assert.deepEqual(calls[1].body.output_config, { effort: "medium" });
  assert.equal("temperature" in calls[1].body, false);
});

test("promptFrom: prompt publicado con caché de 60 s; null, vacío o error → fallback", async () => {
  let clock = 0;
  const seen = [];
  const promptSource = {
    async getPublishedPrompt(code) {
      seen.push(code);
      if (code === "rompe") throw new Error("bd caída");
      if (code === "vacio") return "   ";
      return code === "publicado" ? "Texto publicado v2" : null;
    }
  };
  const ai = createAiCore({ config: resolveAiConfig({}), promptSource, now: () => clock });
  assert.equal(await ai.promptFrom("publicado", "en código"), "Texto publicado v2");
  assert.equal(await ai.promptFrom("publicado", "en código"), "Texto publicado v2");
  assert.equal(seen.length, 1, "segunda lectura servida desde caché");
  clock = 59_999;
  await ai.promptFrom("publicado", "en código");
  assert.equal(seen.length, 1);
  clock = 60_001;
  await ai.promptFrom("publicado", "en código");
  assert.equal(seen.length, 2, "expirada la caché se vuelve a consultar");
  assert.equal(await ai.promptFrom("inexistente", "en código"), "en código");
  assert.equal(await ai.promptFrom("vacio", "en código"), "en código");
  assert.equal(await ai.promptFrom("rompe", "en código"), "en código");
  assert.equal(await createAiCore({ config: resolveAiConfig({}) }).promptFrom("publicado", "sin fuente"), "sin fuente");
});
