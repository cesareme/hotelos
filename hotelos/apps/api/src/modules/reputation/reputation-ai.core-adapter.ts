// Reputación · Tanda T8 · fusión (T8-MERGE-LINES §13) — adaptador del puerto
// de IA sobre @hotelos/ai-core
// (apps/api/src/modules/reputation/reputation-ai.core-adapter.ts).
//
// Reglas del fichero:
//   · implementa ReputationAiPort con el núcleo de ai-core (lib/ai-client.ts
//     getAiCore, inyectable) y RulesReputationAi como respaldo; sin variables
//     de entorno (env-partial.test.mts lo pina): quién lo registra decide si
//     se usa (server.ts, tras inicializar ai-core:
//     `if (isLlmConfigured()) setReputationAiPort(createAiCoreReputationPort())`);
//   · doble cinturón de PII: el texto llega ya enmascarado por maskReviewForLlm
//     y AUN ASÍ pasa por redactPii antes de cualquier prompt; los marcadores
//     de ai-core se restauran con restorePii en snippets, resumen y borrador
//     (los de maskReviewForLlm no se tocan: los vigila el llamador);
//   · ai-core exige organizationId y toolName en el contexto (presupuesto,
//     límite por organización, telemetría): sin `context.organizationId` ni
//     propertyId resoluble (Prisma, inyectable) → respaldo por reglas con nota
//     `context_required`; el puerto sigue sin Prisma, este adaptador sí lo usa;
//   · nunca lanza por el modelo: sin proveedor, cuota, salida inválida o
//     excepción → RulesReputationAi (etiquetas honestas `dictionary`/`rules`)
//     con `note` del motivo;
//   · análisis: categorías filtradas a REVIEW_CATEGORIES (una por categoría,
//     mezcladas con las subpuntuaciones del portal), confianza acotada 0-1,
//     snippet ≤ 160, resumen ≤ 200, `source: "llm"`; la nota sobre 10 manda
//     sobre el sentimiento del modelo (sentimentBucket);
//   · borrador: ≤ 120 palabras, sin datos de la estancia, en el idioma de la
//     reseña (es/en/fr/de/it/pt/ca/gl; `und` y otros → es), firma «Dirección
//     de <hotelName>» (o `signature`) en párrafo aparte; si el modelo se pasa
//     de palabras o devuelve vacío → plantilla por reglas.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/reputation-ai-core-adapter.test.mts

import { prisma } from "@hotelos/database";
import { AiError, redactPii, restorePii } from "@hotelos/ai-core";
import type { AiContext, AiCore, AiPurpose, JsonSchema, PiiMap } from "@hotelos/ai-core";
import { getAiCore } from "../../lib/ai-client.js";
import type {
  AnalyzeReviewInput,
  AnalyzeReviewOutput,
  DraftResponseInput,
  DraftResponseOutput,
  ReputationAiContext,
  ReputationAiDescription,
  ReputationAiPort
} from "./reputation-ai.port.js";
import { DRAFT_MAX_WORDS, RulesReputationAi, SUMMARY_MAX_LENGTH, countWords } from "./reputation-ai.rules.js";
import { REVIEW_CATEGORIES, REVIEW_CATEGORY_LABELS_ES, SENTIMENT_LABELS_ES, sentimentBucket, type CategoryMention, type ReviewCategory, type Sentiment } from "./reputation-types.js";
import { mapPortalSubscores, mergeMentions } from "./review-categories.dictionary.js";

/** Nombres de herramienta del registro (packages/ai-tools/src/registry.ts) con los que ai-core factura la llamada. */
export const ANALYZE_REVIEW_TOOL_NAME = "analyzeReviewSentiment";
export const DRAFT_REVIEW_TOOL_NAME = "draftReviewResponse";

export const SNIPPET_MAX_LENGTH = 160;
export const ANALYZE_MAX_TOKENS = 600;
export const DRAFT_MAX_TOKENS = 300;

/** Idiomas con instrucción explícita para el borrador; `und` y otros → español (como las reglas). */
export const DRAFT_LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  es: "español",
  en: "inglés",
  fr: "francés",
  de: "alemán",
  it: "italiano",
  pt: "portugués",
  ca: "catalán",
  gl: "gallego"
});

/** Copia en español del sistema de análisis de ai-operations/tools/reputation.tools.ts más el sentimiento global. */
export const ANALYZE_REVIEW_SYSTEM =
  "Analiza la reseña de un hotel y devuelve SOLO un objeto JSON con la forma " +
  '{"language":string,"sentiment":"positive"|"neutral"|"negative","summary":string,"categories":[{"code":string,"sentiment":-1|0|1,"confidence":number,"snippet":string}]}. ' +
  `\`code\` debe ser una de estas doce categorías exactas: ${REVIEW_CATEGORIES.join(", ")}. ` +
  "`language` es el código ISO 639-1 del idioma de la reseña (es, en, fr, de, it, pt…). " +
  "`snippet` cita el fragmento literal (≤ 160 caracteres) que justifica la mención y `summary` resume en ≤ 200 caracteres, en español. " +
  "Conserva tal cual los marcadores entre corchetes (p. ej. [EMAIL_1]). No inventes categorías ni menciones que no aparezcan en el texto.";

export const ANALYZE_REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["language", "sentiment", "summary", "categories"],
  properties: {
    language: { type: "string" },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    summary: { type: "string" },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "sentiment", "confidence", "snippet"],
        properties: {
          code: { type: "string", enum: [...REVIEW_CATEGORIES] },
          sentiment: { type: "integer", enum: [-1, 0, 1] },
          confidence: { type: "number" },
          snippet: { type: "string" }
        }
      }
    }
  }
};

/** Copia en español del sistema de borrador (REPUTACION §6.2) sin la firma fija: la firma se añade por hotel. */
export const DRAFT_RESPONSE_SYSTEM =
  "Eres la dirección de un hotel en España y redactas la respuesta pública a una reseña de un huésped. " +
  "Agradece la opinión, responde a lo concreto que menciona la reseña y, si hay una queja, pide disculpas y ofrece un canal privado (correo o teléfono de recepción) e invita a volver. " +
  "No inventes hechos ni menciones el número de habitación, las fechas ni importes. No prometas compensaciones. " +
  "No repitas marcadores entre corchetes ni datos personales del huésped. Máximo 120 palabras. Responde en el idioma de la reseña.";

export type AiCoreReputationPortDeps = {
  /** Núcleo de ai-core; por defecto getAiCore de lib/ai-client.ts (perezoso). */
  core?: () => AiCore;
  /** Organización de una propiedad cuando el contexto solo trae propertyId; por defecto Prisma. */
  resolveOrganizationId?: (propertyId: string) => Promise<string | null>;
  /** Respaldo sin proveedor, sin contexto o con fallo del modelo; por defecto RulesReputationAi. */
  fallback?: ReputationAiPort;
};

type ResolvedContext = { organizationId: string; propertyId?: string; userId?: string; correlationId?: string };

type LlmAnalysis = { language: string; sentiment: Sentiment; summary: string; categories: Array<{ code: string; sentiment: -1 | 0 | 1; confidence: number; snippet: string }> };

async function organizationOfProperty(propertyId: string): Promise<string | null> {
  const row = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  return row?.organizationId ?? null;
}

async function resolveContext(context: ReputationAiContext | undefined, resolveOrganizationId: (propertyId: string) => Promise<string | null>): Promise<ResolvedContext | null> {
  if (!context) return null;
  let organizationId = typeof context.organizationId === "string" ? context.organizationId.trim() : "";
  if (!organizationId && context.propertyId) {
    try {
      organizationId = (await resolveOrganizationId(context.propertyId))?.trim() ?? "";
    } catch {
      organizationId = "";
    }
  }
  if (!organizationId) return null;
  return {
    organizationId,
    ...(context.propertyId ? { propertyId: context.propertyId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {})
  };
}

function aiContextFor(ctx: ResolvedContext, toolName: string, purpose: AiPurpose): AiContext {
  return { ...ctx, toolName, purpose };
}

function noteFor(error: unknown): string {
  if (error instanceof AiError) return `llm_error:${error.code}`;
  const message = error instanceof Error ? error.message : String(error);
  return `llm_error:${message}`.slice(0, 200);
}

function withNote(output: AnalyzeReviewOutput, note: string): AnalyzeReviewOutput {
  return { ...output, note };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewCategory(value: unknown): value is ReviewCategory {
  return typeof value === "string" && (REVIEW_CATEGORIES as readonly string[]).includes(value);
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function mentionSentiment(value: unknown): -1 | 0 | 1 {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function sentimentOf(value: unknown): Sentiment | null {
  return value === "positive" || value === "negative" || value === "neutral" ? value : null;
}

/** Subetiqueta primaria en minúsculas (`en-GB` → `en`); `und`, vacío o raro → null. */
function languageOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(code) && code !== "und" ? code : null;
}

function formatScore(score10: number): string {
  return Number.isInteger(score10) ? String(score10) : score10.toFixed(1);
}

function hasScore(score10: number | null | undefined): score10 is number {
  return typeof score10 === "number" && Number.isFinite(score10);
}

/** Menciones del modelo: solo categorías del vocabulario, confianza 0-1, snippet restaurado y ≤ 160, `source: "llm"`. */
function readCategories(raw: unknown, map: PiiMap): CategoryMention[] {
  if (!Array.isArray(raw)) return [];
  const out: CategoryMention[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isReviewCategory(item.code)) continue;
    const snippet = typeof item.snippet === "string" ? restorePii(item.snippet.trim(), map).slice(0, SNIPPET_MAX_LENGTH) : "";
    out.push({ category: item.code, sentiment: mentionSentiment(item.sentiment), confidence: clamp01(item.confidence), ...(snippet ? { snippet } : {}), source: "llm" });
  }
  return out;
}

function capSummary(summary: string): string | undefined {
  if (!summary) return undefined;
  return summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : summary;
}

function describeCategories(categories: ReadonlyArray<CategoryMention>): string {
  return categories
    .map((mention) => {
      const label = REVIEW_CATEGORY_LABELS_ES[mention.category] ?? mention.category;
      const sign = mention.sentiment > 0 ? "positiva" : mention.sentiment < 0 ? "negativa" : "neutra";
      return `${label} (${sign})`;
    })
    .join(", ");
}

function endsWithSignature(body: string, signature: string): boolean {
  const tail = body.replace(/[\s.,;:!]+$/u, "").toLowerCase();
  return tail.endsWith(signature.toLowerCase());
}

class AiCoreReputationAi implements ReputationAiPort {
  constructor(
    private readonly core: () => AiCore,
    private readonly resolveOrganizationId: (propertyId: string) => Promise<string | null>,
    private readonly fallback: ReputationAiPort
  ) {}

  describe(): ReputationAiDescription {
    try {
      const core = this.core();
      if (!core.isConfigured()) return this.fallback.describe();
      return { configured: true, provider: core.providerName(), model: core.modelName("classify") };
    } catch {
      return this.fallback.describe();
    }
  }

  async analyzeReview(input: AnalyzeReviewInput): Promise<AnalyzeReviewOutput> {
    let core: AiCore;
    try {
      core = this.core();
      if (!core.isConfigured()) return await this.fallback.analyzeReview(input);
    } catch (error) {
      return withNote(await this.fallback.analyzeReview(input), noteFor(error));
    }
    const ctx = await resolveContext(input.context, this.resolveOrganizationId);
    if (!ctx) return withNote(await this.fallback.analyzeReview(input), "context_required");

    try {
      // El texto ya llega enmascarado (maskReviewForLlm) y AUN ASÍ pasa por redactPii.
      const fullText = [input.title?.trim(), input.text?.trim()].filter((part): part is string => Boolean(part)).join(". ");
      const redacted = redactPii(fullText);
      const declared = languageOf(input.language);
      const header = [declared ? `Idioma declarado: ${declared}` : null, hasScore(input.score10) ? `Nota del huésped: ${formatScore(input.score10)}/10` : null].filter((line): line is string => line !== null);
      const prompt = `${header.map((line) => `${line}\n`).join("")}Reseña:\n"""\n${redacted.text}\n"""`;
      const result = await core.structured<LlmAnalysis>(
        { system: ANALYZE_REVIEW_SYSTEM, prompt, schema: ANALYZE_REVIEW_SCHEMA, maxTokens: ANALYZE_MAX_TOKENS },
        aiContextFor(ctx, ANALYZE_REVIEW_TOOL_NAME, "classify"),
        { model: "classify" }
      );
      if (!result.configured) return withNote(await this.fallback.analyzeReview(input), result.reason);
      const data: Record<string, unknown> = isRecord(result.data) ? result.data : {};
      const categories = mergeMentions(mapPortalSubscores(input.subscores), readCategories(data.categories, redacted.map));
      const language = languageOf(data.language) ?? declared ?? "und";
      const sentiment: Sentiment = sentimentBucket(input.score10) ?? sentimentOf(data.sentiment) ?? "neutral";
      const summary = capSummary(restorePii(typeof data.summary === "string" ? data.summary.trim() : "", redacted.map));
      return { language, sentiment, ...(summary ? { summary } : {}), categories, source: "llm", model: result.model };
    } catch (error) {
      return withNote(await this.fallback.analyzeReview(input), noteFor(error));
    }
  }

  async draftResponse(input: DraftResponseInput): Promise<DraftResponseOutput> {
    let core: AiCore;
    try {
      core = this.core();
      if (!core.isConfigured()) return await this.fallback.draftResponse(input);
    } catch {
      return this.fallback.draftResponse(input);
    }
    const ctx = await resolveContext(input.context, this.resolveOrganizationId);
    if (!ctx) return this.fallback.draftResponse(input);

    try {
      const hotelName = input.hotelName.trim() || "nuestro hotel";
      const signature = input.signature?.trim() || `Dirección de ${hotelName}`;
      const requested = languageOf(input.language);
      const language = requested && DRAFT_LANGUAGE_NAMES[requested] ? requested : "es";
      const tone = input.tone === "cercano" ? "cercano y cálido" : "formal";
      const system =
        `${DRAFT_RESPONSE_SYSTEM} El hotel se llama ${hotelName}. Responde SIEMPRE en ${DRAFT_LANGUAGE_NAMES[language]}. ` +
        `Usa un tono ${tone}. Termina con la firma «${signature}» en un párrafo aparte.`;

      const reviewText = [input.title?.trim() ? `Título: ${input.title.trim()}` : null, input.body?.trim() || null].filter((part): part is string => part !== null).join("\n");
      const redacted = redactPii(reviewText);
      const header = [
        hasScore(input.score10) ? `Nota del huésped: ${formatScore(input.score10)}/10` : null,
        `Sentimiento: ${SENTIMENT_LABELS_ES[input.sentiment] ?? input.sentiment}`,
        input.categories.length > 0 ? `Categorías mencionadas: ${describeCategories(input.categories)}` : null
      ].filter((line): line is string => line !== null);
      const prompt = `${header.map((line) => `${line}\n`).join("")}Reseña:\n"""\n${redacted.text || "(sin texto: solo la nota)"}\n"""`;

      const result = await core.complete({ system, prompt, maxTokens: DRAFT_MAX_TOKENS }, aiContextFor(ctx, DRAFT_REVIEW_TOOL_NAME, "complete"));
      if (!result.configured) return await this.fallback.draftResponse(input);
      let body = restorePii(result.text.trim(), redacted.map);
      if (body.length === 0) return await this.fallback.draftResponse(input);
      if (!endsWithSignature(body, signature)) body = `${body}\n\n${signature}`;
      if (countWords(body) > DRAFT_MAX_WORDS) return await this.fallback.draftResponse(input);
      return { body, source: "ai", model: result.model, language };
    } catch {
      return this.fallback.draftResponse(input);
    }
  }
}

/** Puerto de reputación sobre ai-core; sin proveedor, sin contexto o con fallo del modelo cae a `fallback` (reglas). */
export function createAiCoreReputationPort(deps: AiCoreReputationPortDeps = {}): ReputationAiPort {
  return new AiCoreReputationAi(deps.core ?? getAiCore, deps.resolveOrganizationId ?? organizationOfProperty, deps.fallback ?? new RulesReputationAi());
}
