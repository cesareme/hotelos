// Envoltorio fino sobre @hotelos/ai-core (Tanda L6a, lote 2). Conserva el contrato de los seis
// llamadores históricos (server.ts, mapper, governance, reservation-agent, compliance, messaging):
// mismos seis nombres exportados y mismos tipos. Sin fetch directo, sin proveedor OpenAI (se
// trata como `provider_unsupported`) y sin leer variables de entorno (eso vive en lib/ai-config.ts).
// Sin clave → { configured:false, reason } y el llamador responde por reglas; nunca se simula.
// `temperature` se acepta y se reenvía: ai-core la descarta en los modelos sin sampling.
//
// Corrección 1 (CFC-06 / SEC-01): con clave, una llamada SIN `ctx.organizationId` no tiene ámbito
// de rate limit ni de presupuesto ni interruptor aiEnabled → no se llama al modelo y se responde
// `{ configured:false, reason:"context_required" }` (honesto: los handlers deben pasar por el
// tool runner). Antes esos llamadores compartían el cubo `unscoped` entre organizaciones.
// Corrección 1 (CFC-02 / CFC-07): `LlmNotConfigured.telemetry` conserva el coste de un rechazo y
// `llmExtractJsonFromImage` devuelve los tokens/coste reales cuando el JSON no valida (nunca ceros).

import type { AiContext, AiResult, AiSuccessMeta, AiTelemetry, ClassifyInput, ClassifyOutput, DocFieldConfidence, DocumentTelemetry, ExtractFromDocumentInput, StructuredInput } from "@hotelos/ai-core";
import { isAiError, parseDataUrl } from "@hotelos/ai-core";
import { getAiCore } from "./ai-client.js";

export type { DocFields } from "@hotelos/ai-core";
import type { DocFields } from "@hotelos/ai-core";

export type LlmModelRole = "default" | "classify" | "insights";
export type LlmContext = Partial<AiContext>;
type LlmMeta = {
  configured: true;
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costEur?: number | null;
  costUsd?: number | null;
  cacheReadTokens?: number;
  latencyMs?: number;
};
export type LlmSuccess = LlmMeta & { text: string };
export type LlmNotConfigured = { configured: false; reason: string; message?: string; telemetry?: AiTelemetry };
export type LlmResult = LlmSuccess | LlmNotConfigured;
export type LlmDocSuccess = LlmMeta & { fields: DocFields; confidence?: DocFieldConfidence };
export type LlmDocResult = LlmDocSuccess | LlmNotConfigured;
export type LlmJsonSuccess = LlmMeta & { data: Record<string, unknown>; document?: DocumentTelemetry };
export type LlmJsonResult = LlmJsonSuccess | LlmNotConfigured;
export type LlmStructuredResult<T> = (LlmMeta & { data: T }) | LlmNotConfigured;
export type LlmClassifyResult = (LlmMeta & ClassifyOutput) | LlmNotConfigured;

type CompleteInput = { system?: string; prompt: string; maxTokens?: number; temperature?: number; ctx?: LlmContext; model?: LlmModelRole };
type CallOptions = { model?: LlmModelRole; temperature?: number; maxTokens?: number; timeoutMs?: number };

const INVALID_IMAGE: LlmNotConfigured = { configured: false, reason: "invalid_image", message: "La imagen debe ser una URL de datos base64 (data:<tipo>;base64,…)." };
export const CONTEXT_REQUIRED_MESSAGE = "Sin contexto de organización no se llama al modelo: pase { organizationId, propertyId } o use el tool runner.";
const CONTEXT_REQUIRED: LlmNotConfigured = { configured: false, reason: "context_required", message: CONTEXT_REQUIRED_MESSAGE };

/** Contexto para ai-core; null cuando falta la organización (sin ámbito de límite ni presupuesto). */
function toCtx(ctx: LlmContext | undefined, toolName: string, purpose: AiContext["purpose"]): AiContext | null {
  const organizationId = ctx?.organizationId?.trim();
  if (!organizationId) return null;
  return { ...ctx, organizationId, toolName: ctx?.toolName ?? toolName, purpose: ctx?.purpose ?? purpose };
}
function callOptions(opts: CallOptions = {}) {
  return { model: opts.model ?? "default", temperature: opts.temperature, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs };
}
function metaOf(r: AiSuccessMeta): LlmMeta {
  return { configured: true, provider: r.provider, model: r.model, tokensInput: r.tokensInput, tokensOutput: r.tokensOutput, costEur: r.costEur, costUsd: r.costUsd, cacheReadTokens: r.usage.cacheReadTokens, latencyMs: r.latencyMs };
}
function notConfigured(r: { reason: string; message: string; telemetry?: AiTelemetry }): LlmNotConfigured {
  return { configured: false, reason: r.reason, message: r.message, ...(r.telemetry ? { telemetry: r.telemetry } : {}) };
}
function unwrap<T>(r: AiResult<T>): { ok: true; meta: LlmMeta; value: AiSuccessMeta & T } | { ok: false; result: LlmNotConfigured } {
  return r.configured ? { ok: true, meta: metaOf(r), value: r } : { ok: false, result: notConfigured(r) };
}
/** Sin proveedor → motivo tipado; con proveedor pero sin organización → context_required. */
function gate(ctx: LlmContext | undefined, toolName: string, purpose: AiContext["purpose"]): { ok: true; ctx: AiContext } | { ok: false; result: LlmNotConfigured } {
  const core = getAiCore();
  if (!core.isConfigured()) return { ok: false, result: notConfigured({ reason: core.config.reason ?? "not_configured", message: "Sin modelo configurado" }) };
  const aiCtx = toCtx(ctx, toolName, purpose);
  return aiCtx ? { ok: true, ctx: aiCtx } : { ok: false, result: CONTEXT_REQUIRED };
}

/** True cuando hay proveedor y clave utilizables (nunca con placeholders, modelos vetados ni sin tipo de cambio). */
export function isLlmConfigured(): boolean {
  return getAiCore().isConfigured();
}
/** Nombre del proveedor para /health y telemetría ("none" sin configuración). */
export function llmProviderName(): string {
  return getAiCore().providerName();
}
/** Modelo del rol (defecto claude-sonnet-5; classify → Haiku 4.5; insights → Opus 5). */
export function llmModelName(role: LlmModelRole = "default"): string {
  return getAiCore().modelName(role);
}

/** Una completación. Sin proveedor u organización devuelve { configured:false }; con proveedor lanza AiError solo ante fallo real. */
export async function llmComplete(input: CompleteInput): Promise<LlmResult> {
  const g = gate(input.ctx, "llmComplete", "complete");
  if (!g.ok) return g.result;
  const u = unwrap(await getAiCore().complete({ system: input.system, prompt: input.prompt, maxTokens: input.maxTokens }, g.ctx, callOptions(input)));
  return u.ok ? { ...u.meta, text: u.value.text } : u.result;
}

/** Campos de un documento de identidad a partir de una imagen (salida estructurada con confianza por campo). */
export async function llmExtractDocument(imageDataUrl: string, ctx?: LlmContext): Promise<LlmDocResult> {
  const g = gate(ctx, "scan_id_document", "extract");
  if (!g.ok) return g.result;
  if (!parseDataUrl(imageDataUrl)) return INVALID_IMAGE;
  const u = unwrap(await getAiCore().extractIdentityDocument(imageDataUrl, g.ctx));
  return u.ok ? { ...u.meta, fields: u.value.fields, confidence: u.value.confidence } : u.result;
}

/** Imagen → objeto JSON libre (Centro de cumplimiento). Sin JSON válido devuelve data {} con los tokens y el coste reales. */
export async function llmExtractJsonFromImage(imageDataUrl: string, instruction: string, ctx?: LlmContext): Promise<LlmJsonResult> {
  const g = gate(ctx, "extractJsonFromImage", "extract");
  if (!g.ok) return g.result;
  if (!parseDataUrl(imageDataUrl)) return INVALID_IMAGE;
  try {
    const u = unwrap(await getAiCore().extractJsonFromImage(imageDataUrl, instruction, g.ctx, { maxTokens: 400 }));
    return u.ok ? { ...u.meta, data: u.value.data } : u.result;
  } catch (error) {
    if (isAiError(error) && (error.code === "invalid_output" || error.code === "truncated") && error.telemetry) {
      const t = error.telemetry;
      return { configured: true, provider: getAiCore().providerName(), model: t.model, tokensInput: t.tokensInput, tokensOutput: t.tokensOutput, costEur: t.costEur, costUsd: t.costUsd, cacheReadTokens: t.cacheReadTokens, latencyMs: t.latencyMs, data: {} };
    }
    throw error;
  }
}

/** DOCUMENTOS §5.2: páginas (image) o PDF (document) → JSON validado contra `schema`; telemetría sin bytes. */
export async function llmExtractJsonFromDocument(input: ExtractFromDocumentInput & CallOptions, ctx?: LlmContext): Promise<LlmJsonResult> {
  const g = gate(ctx, "extractJsonFromDocument", "extract");
  if (!g.ok) return g.result;
  const u = unwrap(await getAiCore().extractFromDocument<Record<string, unknown>>(input, g.ctx, callOptions(input)));
  return u.ok ? { ...u.meta, data: u.value.data, document: u.value.document } : u.result;
}

/** Salida estructurada (output_config json_schema + validación local). */
export async function llmStructured<T = Record<string, unknown>>(input: StructuredInput & CallOptions, ctx?: LlmContext): Promise<LlmStructuredResult<T>> {
  const g = gate(ctx, "llmStructured", "complete");
  if (!g.ok) return g.result;
  const u = unwrap(await getAiCore().structured<T>(input, g.ctx, callOptions(input)));
  return u.ok ? { ...u.meta, data: u.value.data } : u.result;
}

/** Clasificación con el modelo barato (rol classify, Haiku 4.5). */
export async function llmClassify(input: ClassifyInput, ctx?: LlmContext): Promise<LlmClassifyResult> {
  const g = gate(ctx, "llmClassify", "classify");
  if (!g.ok) return g.result;
  const u = unwrap(await getAiCore().classify(input, g.ctx));
  return u.ok ? { ...u.meta, label: u.value.label, confidence: u.value.confidence, ...(u.value.rationale ? { rationale: u.value.rationale } : {}) } : u.result;
}
