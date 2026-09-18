// Reputación (Tanda L6a, lote 3): análisis semántico por categorías y
// borrador de respuesta a reseñas (REPUTACION-REVIEWS.md §4.5 y §6.2). Las dos
// son lecturas: no publican nada; la publicación la hace siempre una persona
// (§6.3). Sin clave → { configured:false } honesto. El texto de la reseña viaja
// redactado (ai-core redacta prompt/messages por defecto).

import { z } from "zod";
import type { JsonSchema } from "@hotelos/ai-core";
import { getAiCore } from "../../../lib/ai-client.js";
import { aiContextFor, defineAiTool, fromAiResult, usageOf } from "./context.js";

/** Las 12 categorías fijas de REPUTACION §4.5. */
export const REVIEW_CATEGORIES = ["limpieza", "habitacion", "personal", "desayuno", "restauracion", "ubicacion", "precio_valor", "instalaciones", "ruido", "wifi", "recepcion_checkin", "mantenimiento"] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export type ReviewCategoryMention = { code: ReviewCategory; sentiment: -1 | 0 | 1; confidence: number; snippet: string };
export type ReviewSentimentAnalysis = { categories: ReviewCategoryMention[]; language: string; summary: string };

const SENTIMENT_SYSTEM =
  "Analiza la reseña de un hotel y devuelve SOLO un objeto JSON con la forma " +
  '{"categories":[{"code":string,"sentiment":-1|0|1,"confidence":number,"snippet":string}],"language":string,"summary":string}. ' +
  `\`code\` debe ser una de estas doce categorías exactas: ${REVIEW_CATEGORIES.join(", ")}. ` +
  "`snippet` cita el fragmento (≤ 160 caracteres) y `summary` resume en ≤ 200 caracteres. No inventes categorías ni menciones que no aparezcan en el texto.";

const SENTIMENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["categories", "language", "summary"],
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "sentiment", "confidence", "snippet"],
        properties: { code: { type: "string", enum: [...REVIEW_CATEGORIES] }, sentiment: { type: "integer", enum: [-1, 0, 1] }, confidence: { type: "number" }, snippet: { type: "string" } }
      }
    },
    language: { type: "string" },
    summary: { type: "string" }
  }
};

const LANGUAGE_NAMES: Record<string, string> = { es: "español", en: "inglés", fr: "francés", de: "alemán", it: "italiano", pt: "portugués", ca: "catalán", gl: "gallego", eu: "euskera", nl: "neerlandés" };

/** Sistema de REPUTACION §6.2: sin hechos inventados, sin datos de la estancia, ≤ 120 palabras, idioma de la reseña. */
export const DRAFT_REVIEW_RESPONSE_SYSTEM =
  "Eres la dirección de un hotel en España y redactas la respuesta pública a una reseña de un huésped. " +
  "Agradece la opinión, responde a lo concreto que menciona la reseña y, si hay una queja, pide disculpas y ofrece un canal privado (correo o teléfono de recepción) e invita a volver. " +
  "No inventes hechos ni menciones el número de habitación, las fechas ni importes. No prometas compensaciones. " +
  "Máximo 120 palabras. Responde en el idioma de la reseña. Firma como «Dirección del hotel».";

export const analyzeReviewSentimentTool = defineAiTool({
  name: "analyzeReviewSentiment",
  effect: "read",
  description: "Analiza una reseña por las 12 categorías fijas (sentimiento −1/0/+1, confianza y fragmento) con el modelo de clasificación.",
  inputSchema: z.object({ text: z.string().trim().min(1).max(8_000), language: z.string().trim().min(2).max(10).optional() }).strict(),
  outputSchema: z.object({ categories: z.array(z.custom<ReviewCategoryMention>()), language: z.string(), summary: z.string(), usage: z.custom<ReturnType<typeof usageOf>>() }),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" }, language: { type: "string" } } },
  async execute(input, ctx) {
    const system = await getAiCore().promptFrom("analyze_review_sentiment", SENTIMENT_SYSTEM);
    const prompt = `${input.language ? `Idioma declarado: ${input.language}\n` : ""}Reseña:\n"""\n${input.text}\n"""`;
    const result = await getAiCore().structured<ReviewSentimentAnalysis>({ system, prompt, schema: SENTIMENT_SCHEMA, maxTokens: 600 }, aiContextFor(ctx, "analyzeReviewSentiment", "classify"), { model: "classify" });
    return fromAiResult(result, (value) => ({
      categories: value.data.categories
        .filter((mention) => (REVIEW_CATEGORIES as readonly string[]).includes(mention.code))
        .map((mention) => ({ ...mention, confidence: Math.min(1, Math.max(0, mention.confidence)), snippet: mention.snippet.slice(0, 160) })),
      language: value.data.language,
      summary: value.data.summary.slice(0, 200),
      usage: usageOf(value)
    }));
  }
});

export const draftReviewResponseTool = defineAiTool({
  name: "draftReviewResponse",
  effect: "read",
  description: "Redacta un borrador de respuesta pública a una reseña (≤ 120 palabras, idioma de la reseña). Una persona lo revisa y publica.",
  inputSchema: z
    .object({
      reviewText: z.string().trim().min(1).max(8_000),
      score10: z.number().min(0).max(10).optional(),
      language: z.string().trim().min(2).max(10).optional(),
      tone: z.string().trim().min(1).max(40).optional(),
      categories: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
      hotelName: z.string().trim().min(1).max(120).optional()
    })
    .strict(),
  outputSchema: z.object({ draft: z.string(), usage: z.custom<ReturnType<typeof usageOf>>() }),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["reviewText"], properties: { reviewText: { type: "string" }, score10: { type: "number" }, language: { type: "string" }, tone: { type: "string" }, categories: { type: "array", items: { type: "string" } }, hotelName: { type: "string" } } },
  async execute(input, ctx) {
    const base = await getAiCore().promptFrom("draft_review_response", DRAFT_REVIEW_RESPONSE_SYSTEM);
    const languageName = input.language ? LANGUAGE_NAMES[input.language.toLowerCase()] : undefined;
    const system =
      base +
      (input.hotelName ? ` El hotel se llama ${input.hotelName}.` : "") +
      (languageName ? ` Responde SIEMPRE en ${languageName}.` : "") +
      (input.tone ? ` Usa un tono ${input.tone}.` : "");
    const context = [
      input.score10 !== undefined ? `Puntuación: ${input.score10}/10` : null,
      input.categories && input.categories.length > 0 ? `Categorías mencionadas: ${input.categories.join(", ")}` : null
    ].filter((line): line is string => line !== null);
    const prompt = `${context.length > 0 ? `${context.join("\n")}\n` : ""}Reseña:\n"""\n${input.reviewText}\n"""`;
    const result = await getAiCore().complete({ system, prompt, maxTokens: 250 }, aiContextFor(ctx, "draftReviewResponse", "complete"));
    return fromAiResult(result, (value) => ({ draft: value.text.trim(), usage: usageOf(value) }));
  }
});
