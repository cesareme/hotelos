// Unit tests · Tanda T8 · fusión (§13) — adaptador del puerto de IA sobre
// ai-core (reputation-ai.core-adapter.ts): PII por redactPii/restorePii,
// contexto que ai-core exige, filtrado de categorías, nota que manda sobre el
// sentimiento del modelo, respaldo por reglas (sin proveedor, sin contexto,
// cuota, excepción, borrador largo o vacío) y firma. Núcleo simulado: sin
// red, sin base de datos, sin proveedor de IA. Datos ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-ai-core-adapter.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiContext, AiCore, AiErrorCode } from "@hotelos/ai-core";
import { createAiCoreReputationPort } from "../reputation-ai.core-adapter.js";
import type { DraftResponseInput } from "../reputation-ai.port.js";

const HOTEL = "Hotel Ficticio";
const CONTEXT = { organizationId: "org_x", propertyId: "prop_x", userId: "usr_x", correlationId: "corr_x" };
const EMAIL = "ana@example.com";
const PHONE = "+34 600 000 000";
const REVIEW = `Todo perfecto y el personal muy amable. Escribidme a ${EMAIL} o al ${PHONE} para cualquier duda.`;

type Recorded = { kind: "structured" | "complete"; input: Record<string, unknown>; ctx: AiContext; opts: Record<string, unknown> | undefined };
type FakeOptions = {
  configured?: boolean;
  analysis?: Record<string, unknown> | ((input: Record<string, unknown>) => Record<string, unknown>);
  draft?: string | ((input: Record<string, unknown>) => string);
  notConfigured?: AiErrorCode;
  throws?: Error;
};

const DEFAULT_ANALYSIS = {
  language: "es",
  sentiment: "positive",
  summary: "Personal amable; contacto en [EMAIL_1].",
  categories: [{ code: "personal", sentiment: 1, confidence: 0.9, snippet: "el personal muy amable" }]
};

function fakeCore(options: FakeOptions = {}): { core: AiCore; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const configured = options.configured ?? true;
  const success = {
    configured: true as const,
    provider: "anthropic" as const,
    model: "modelo-ficticio",
    usage: { tokensInput: 10, tokensOutput: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    tokensInput: 10,
    tokensOutput: 5,
    costUsd: 0,
    costEur: 0,
    latencyMs: 1,
    stopReason: "end_turn",
    truncated: false,
    toolUses: []
  };
  const notConfigured = options.notConfigured ? { configured: false as const, reason: options.notConfigured, message: "simulado" } : null;
  const core = {
    isConfigured: () => configured,
    providerName: () => (configured ? "anthropic" : "none"),
    modelName: (role?: string) => `modelo-${role ?? "default"}`,
    async structured(input: Record<string, unknown>, ctx: AiContext, opts?: Record<string, unknown>) {
      calls.push({ kind: "structured", input, ctx, opts });
      if (options.throws) throw options.throws;
      if (notConfigured) return notConfigured;
      const analysis = typeof options.analysis === "function" ? options.analysis(input) : (options.analysis ?? DEFAULT_ANALYSIS);
      return { ...success, data: analysis };
    },
    async complete(input: Record<string, unknown>, ctx: AiContext, opts?: Record<string, unknown>) {
      calls.push({ kind: "complete", input, ctx, opts });
      if (options.throws) throw options.throws;
      if (notConfigured) return notConfigured;
      const text = typeof options.draft === "function" ? options.draft(input) : (options.draft ?? `Muchas gracias por su opinión.\n\nDirección de ${HOTEL}`);
      return { ...success, text };
    }
  };
  return { core: core as unknown as AiCore, calls };
}

function port(options: FakeOptions = {}, resolve?: (propertyId: string) => Promise<string | null>) {
  const fake = fakeCore(options);
  const ai = createAiCoreReputationPort({ core: () => fake.core, resolveOrganizationId: resolve ?? (async () => null) });
  return { ai, calls: fake.calls };
}

function draftInput(extra: Partial<DraftResponseInput> = {}): DraftResponseInput {
  return { score10: 9, sentiment: "positive", language: "es", categories: [], body: REVIEW, hotelName: HOTEL, context: CONTEXT, ...extra };
}

describe("analyzeReview · PII, contexto y normalización", () => {
  it("(a) el prompt lleva marcadores y nunca el correo ni el teléfono; el contexto llega completo a ai-core", async () => {
    const { ai, calls } = port();
    const out = await ai.analyzeReview({ text: REVIEW, title: "Genial", context: CONTEXT });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.kind, "structured");
    const prompt = String(call.input.prompt);
    assert.doesNotMatch(prompt, /ana@example\.com/);
    assert.doesNotMatch(prompt, /600 000 000|600000000/);
    assert.match(prompt, /\[EMAIL_1\]/);
    assert.match(prompt, /\[TEL_1\]/);
    assert.match(prompt, /Genial/);
    assert.equal(call.input.maxTokens, 600);
    assert.equal(call.ctx.organizationId, "org_x");
    assert.equal(call.ctx.propertyId, "prop_x");
    assert.equal(call.ctx.userId, "usr_x");
    assert.equal(call.ctx.correlationId, "corr_x");
    assert.equal(call.ctx.toolName, "analyzeReviewSentiment");
    assert.equal(call.ctx.purpose, "classify");
    assert.equal(call.opts?.model, "classify");
    assert.equal(out.source, "llm");
    assert.equal(out.model, "modelo-ficticio");
    assert.equal(out.language, "es");
    assert.equal(out.sentiment, "positive");
    assert.equal(out.note, undefined);
    assert.match(out.summary ?? "", /ana@example\.com/, "restorePii en el resumen");
    assert.deepEqual(
      out.categories.map((mention) => [mention.category, mention.source]),
      [["personal", "llm"]]
    );
  });

  it("(b) categorías con code inválido se descartan, la confianza se acota a 0-1 y el snippet se restaura y recorta a 160", async () => {
    const { ai } = port({
      analysis: {
        language: "es",
        sentiment: "neutral",
        summary: "s",
        categories: [
          { code: "limpieza", sentiment: 1, confidence: 1.7, snippet: "muy limpio" },
          { code: "piscina", sentiment: 1, confidence: 0.9, snippet: "piscina" },
          { code: "ruido", sentiment: -1, confidence: -0.3, snippet: "r".repeat(300) },
          { code: "personal", sentiment: 1, confidence: 0.8, snippet: "Escribidme a [EMAIL_1]" }
        ]
      }
    });
    const out = await ai.analyzeReview({ text: REVIEW, context: CONTEXT });
    assert.deepEqual(
      out.categories.map((mention) => [mention.category, mention.sentiment, mention.confidence, mention.source]),
      [
        ["limpieza", 1, 1, "llm"],
        ["personal", 1, 0.8, "llm"],
        ["ruido", -1, 0, "llm"]
      ]
    );
    assert.equal(out.categories.find((mention) => mention.category === "ruido")!.snippet!.length, 160);
    assert.match(out.categories.find((mention) => mention.category === "personal")!.snippet!, /ana@example\.com/);
  });

  it("(c) la nota manda sobre el modelo: score10 = 3 → negative aunque diga positive; 9 → positive aunque diga negative; sin nota, la del modelo", async () => {
    const positive = port();
    assert.equal((await positive.ai.analyzeReview({ text: REVIEW, score10: 3, context: CONTEXT })).sentiment, "negative");
    const negative = port({ analysis: { ...DEFAULT_ANALYSIS, sentiment: "negative" } });
    assert.equal((await negative.ai.analyzeReview({ text: REVIEW, score10: 9, context: CONTEXT })).sentiment, "positive");
    assert.equal((await negative.ai.analyzeReview({ text: REVIEW, score10: null, context: CONTEXT })).sentiment, "negative");
  });

  it("idioma: el del modelo (subetiqueta primaria), si no el declarado, si no und; el resumen se recorta a 200", async () => {
    const model = port({ analysis: { ...DEFAULT_ANALYSIS, language: "en-GB", summary: "x".repeat(250) } });
    const fromModel = await model.ai.analyzeReview({ text: REVIEW, language: "de", context: CONTEXT });
    assert.equal(fromModel.language, "en");
    assert.equal(fromModel.summary!.length, 200);
    const declared = port({ analysis: { ...DEFAULT_ANALYSIS, language: "" } });
    assert.equal((await declared.ai.analyzeReview({ text: REVIEW, language: "pt-BR", context: CONTEXT })).language, "pt");
    assert.equal((await declared.ai.analyzeReview({ text: REVIEW, context: CONTEXT })).language, "und");
  });

  it("las subpuntuaciones del portal se mezclan con las menciones del modelo (portal_subscore)", async () => {
    const { ai } = port({ analysis: { ...DEFAULT_ANALYSIS, categories: [] } });
    const out = await ai.analyzeReview({ text: REVIEW, subscores: { clean: 3 }, context: CONTEXT });
    assert.deepEqual(
      out.categories.map((mention) => [mention.category, mention.source]),
      [["limpieza", "portal_subscore"]]
    );
    assert.equal(out.source, "llm");
  });
});

describe("respaldo por reglas", () => {
  it("(d) sin proveedor: describe() honesto, análisis `dictionary`, borrador `rules`, el núcleo no se llama", async () => {
    const { ai, calls } = port({ configured: false });
    assert.deepEqual(ai.describe(), { configured: false, provider: "none" });
    const analysis = await ai.analyzeReview({ text: REVIEW, score10: 9, context: CONTEXT });
    assert.equal(analysis.source, "dictionary");
    assert.equal(analysis.note, "llm_not_configured");
    assert.equal((await ai.draftResponse(draftInput())).source, "rules");
    assert.equal(calls.length, 0);
  });

  it("describe() con proveedor: provider y modelo de clasificación", () => {
    const { ai } = port();
    assert.deepEqual(ai.describe(), { configured: true, provider: "anthropic", model: "modelo-classify" });
  });

  it("(e) sin context ni propertyId → reglas con nota context_required; el núcleo no se llama", async () => {
    const { ai, calls } = port();
    const out = await ai.analyzeReview({ text: REVIEW, score10: 9 });
    assert.equal(out.source, "dictionary");
    assert.equal(out.note, "context_required");
    assert.equal(out.sentiment, "positive");
    const { context: _omitted, ...withoutContext } = draftInput();
    assert.equal((await ai.draftResponse(withoutContext)).source, "rules");
    assert.equal(calls.length, 0);
  });

  it("solo propertyId: la organización se resuelve por la propiedad; si no existe → context_required", async () => {
    const seen: string[] = [];
    const resolved = port({}, async (propertyId) => {
      seen.push(propertyId);
      return propertyId === "prop_ok" ? "org_from_prop" : null;
    });
    const ok = await resolved.ai.analyzeReview({ text: REVIEW, context: { organizationId: "", propertyId: "prop_ok" } });
    assert.equal(ok.source, "llm");
    assert.equal(resolved.calls[0]!.ctx.organizationId, "org_from_prop");
    assert.equal(resolved.calls[0]!.ctx.propertyId, "prop_ok");
    const missing = await resolved.ai.analyzeReview({ text: REVIEW, context: { organizationId: "", propertyId: "prop_missing" } });
    assert.equal(missing.note, "context_required");
    assert.deepEqual(seen, ["prop_ok", "prop_missing"]);
  });

  it("ai-core responde configured:false (cuota) → reglas con su motivo; una excepción del modelo → reglas con nota llm_error", async () => {
    const quota = port({ notConfigured: "budget_exceeded" });
    const out = await quota.ai.analyzeReview({ text: REVIEW, context: CONTEXT });
    assert.equal(out.source, "dictionary");
    assert.equal(out.note, "budget_exceeded");
    assert.equal((await quota.ai.draftResponse(draftInput())).source, "rules");
    const broken = port({ throws: new Error("boom") });
    const failed = await broken.ai.analyzeReview({ text: REVIEW, context: CONTEXT });
    assert.equal(failed.source, "dictionary");
    assert.match(failed.note ?? "", /^llm_error:/);
    assert.equal((await broken.ai.draftResponse(draftInput())).source, "rules");
  });
});

describe("draftResponse", () => {
  it("prompt con PII redactada y sistema con hotel, idioma, tono y firma; contexto complete/draftReviewResponse; salida ai restaurada", async () => {
    const { ai, calls } = port({ draft: `Gracias por escribirnos a [EMAIL_1].\n\nDirección de ${HOTEL}` });
    const out = await ai.draftResponse(draftInput({ tone: "cercano", language: "en", title: "Great", categories: [{ category: "personal", sentiment: 1, confidence: 0.9, source: "llm" }] }));
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.kind, "complete");
    const prompt = String(call.input.prompt);
    const system = String(call.input.system);
    assert.doesNotMatch(prompt, /ana@example\.com|600 000 000|600000000/);
    assert.match(prompt, /\[EMAIL_1\]/);
    assert.match(prompt, /\[TEL_1\]/);
    assert.match(prompt, /9\/10/);
    assert.match(prompt, /Personal \(positiva\)/);
    assert.match(prompt, /Título: Great/);
    assert.match(system, /El hotel se llama Hotel Ficticio\./);
    assert.match(system, /Responde SIEMPRE en inglés/);
    assert.match(system, /cercano y cálido/);
    assert.match(system, /«Dirección de Hotel Ficticio»/);
    assert.match(system, /Máximo 120 palabras/);
    assert.equal(call.input.maxTokens, 300);
    assert.equal(call.ctx.toolName, "draftReviewResponse");
    assert.equal(call.ctx.purpose, "complete");
    assert.equal(call.ctx.organizationId, "org_x");
    assert.equal(call.ctx.userId, "usr_x");
    assert.equal(out.source, "ai");
    assert.equal(out.model, "modelo-ficticio");
    assert.equal(out.language, "en");
    assert.match(out.body, /ana@example\.com/, "restorePii en el borrador");
    assert.ok(out.body.endsWith(`Dirección de ${HOTEL}`));
    assert.equal((out.body.match(/Dirección de Hotel Ficticio/g) ?? []).length, 1, "la firma no se duplica");
  });

  it("(f) borrador de más de 120 palabras → plantilla por reglas; vacío → reglas", async () => {
    const long = port({ draft: Array.from({ length: 130 }, () => "palabra").join(" ") });
    const out = await long.ai.draftResponse(draftInput());
    assert.equal(out.source, "rules");
    assert.ok(out.body.endsWith(`Dirección de ${HOTEL}`));
    const empty = port({ draft: "   " });
    assert.equal((await empty.ai.draftResponse(draftInput())).source, "rules");
  });

  it("(g) borrador sin firma → se añade «Dirección de Hotel Ficticio» en párrafo aparte; `signature` explícita manda", async () => {
    const { ai } = port({ draft: "Muchas gracias por su opinión. Esperamos verle pronto." });
    const out = await ai.draftResponse(draftInput());
    assert.equal(out.source, "ai");
    assert.ok(out.body.endsWith("\n\nDirección de Hotel Ficticio"), out.body);
    const custom = port({ draft: "Gracias por su visita." });
    const signed = await custom.ai.draftResponse(draftInput({ signature: "Equipo de Recepción" }));
    assert.ok(signed.body.endsWith("\n\nEquipo de Recepción"), signed.body);
    const punctuated = port({ draft: "Gracias por su visita.\n\nDirección de Hotel Ficticio." });
    const kept = await punctuated.ai.draftResponse(draftInput());
    assert.equal((kept.body.match(/Dirección de Hotel Ficticio/g) ?? []).length, 1, "firma con punto final: no se duplica");
  });

  it("idioma `und` o no soportado → instrucción en español y language es; tono por defecto formal", async () => {
    const { ai, calls } = port();
    const out = await ai.draftResponse(draftInput({ language: "und" }));
    assert.match(String(calls[0]!.input.system), /Responde SIEMPRE en español/);
    assert.match(String(calls[0]!.input.system), /Usa un tono formal/);
    assert.equal(out.language, "es");
    const other = port();
    assert.equal((await other.ai.draftResponse(draftInput({ language: "nl" }))).language, "es");
  });
});
