// Documentos · Tanda T9 · lote T9-06a — adaptador del puerto de IA sobre
// @hotelos/ai-core a través del tool runner
// (apps/api/src/modules/documents/documents-ai.core-adapter.ts; patrón de
// modules/reputation/reputation-ai.core-adapter.ts, diseño §5.1-§5.2).
//
// Reglas del fichero:
//   · implementa DocumentsAiPort con RunAiTool (ai-operations/tool-runner.service.ts)
//     para que TODA llamada al modelo pase por el runner: gates de módulo,
//     permisos, PropertyAiSetting, presupuesto mensual, rate limit, telemetría
//     en ai_tool_calls y auditoría actorType "ai" (nunca se llama a ai-core a
//     pelo desde aquí);
//   · classify reutiliza el ejecutor L6a classifyIncomingDocumentTool (texto
//     ≤ 20.000 caracteres, redactado por ai-core); extract pasa un `execute`
//     explícito (RunAiToolInput.execute) que llama a core.extractFromDocument
//     con el esquema por tipo (extraction-schemas.ts) y devuelve `record` SIN
//     bytes ({ pages, sha256, kind }) para outputJson;
//   · tramos de ≤ 20 páginas (imágenes); el PDF completo viaja como un solo
//     bloque document (ai-core aplica maxPdfPages, 32 MB y el timeout de
//     AI_DOCUMENT_TIMEOUT_MS);
//   · letter / administrative_notice / contract solo van al modelo si
//     DocumentSettings.aiAllowedKinds los incluye ([] = todos); si no, reglas;
//   · nunca lanza por el modelo: sin proveedor, denied (presupuesto, módulo,
//     permiso, política, tool_disabled…), awaiting_confirmation, 403/429 del
//     runner, salida inválida o excepción → RulesDocumentsAi con una nota /
//     aviso honesto (`ai_denied:<reason>`, `llm_error:<code>`…) que el pipeline
//     guarda en DocumentExtraction.warningsJson;
//   · costEur / tokens salen de la telemetría del runner (telemetryFromAiResult),
//     nunca se estiman aquí.
//
// Tests: cd apps/api && node --import tsx --test src/modules/documents/__tests__/documents-ai-core-adapter.test.mts

import { AiError } from "@hotelos/ai-core";
import type { AiCore, JsonSchema } from "@hotelos/ai-core";
import type { ExecuteResult, JsonValue, RunnerContext, ToolRunResult } from "@hotelos/ai-core/runner";
import type { IncomingDocumentKind, PermissionKey } from "@hotelos/shared";
import { getAiCore } from "../../lib/ai-client.js";
import type { UserContext } from "../../lib/demo-store.js";
import { runAiTool, type RunAiToolInput } from "../ai-operations/tool-runner.service.js";
import { aiContextFor, apiToolContextFromRunner, fromAiResult, usageOf, type ModelUsageSummary, type NotConfiguredOutput } from "../ai-operations/tools/context.js";
import type {
  ClassifyDocumentInput,
  ClassifyDocumentOutput,
  DocumentExtractedFields,
  DocumentImagePage,
  DocumentsAiContext,
  DocumentsAiDescription,
  DocumentsAiPort,
  ExtractDocumentInput,
  ExtractDocumentOutput,
  ExtractedField,
  ExtractionTelemetry
} from "./documents-ai.port.js";
import { RulesDocumentsAi } from "./documents-ai.rules.js";
import { EXTRACTION_SCHEMA_VERSION, extractionInstructionFor, schemaFieldKeys, schemaFor } from "./extraction-schemas.js";

/** Nombres del registro (packages/ai-tools/src/registry.ts) con los que el runner factura y audita. */
export const CLASSIFY_TOOL_NAME = "classifyIncomingDocument";
export const EXTRACT_TOOL_NAME = "extractIncomingDocumentFields";

export const CLASSIFY_MAX_TEXT = 20_000;
export const EXTRACT_MAX_TOKENS = 4_000;
/** Tramo máximo de imágenes por petición (§4.3: más de 20 bloques limita la dimensión a 2.000 px). */
export const PAGES_PER_CHUNK = 20;
/** Tipos que solo van al modelo cuando DocumentSettings.aiAllowedKinds los incluye. */
export const AI_RESTRICTED_KINDS: readonly IncomingDocumentKind[] = Object.freeze(["letter", "administrative_notice", "contract"]);
/** Actor del sistema para el runner cuando el disparador no es una persona (captura por correo, reintento automático). */
export const DOCUMENTS_PIPELINE_ACTOR = "documents-pipeline";
export const DOCUMENTS_PIPELINE_PERMISSIONS: readonly PermissionKey[] = Object.freeze(["ai.tool.execute"]);

export type RunAiToolFn = <I = unknown, O = unknown>(input: RunAiToolInput<I, O>) => Promise<ToolRunResult<O>>;

export type AiCoreDocumentsPortDeps = {
  /** Runner del API; por defecto runAiTool (tests: simulado). */
  runTool?: RunAiToolFn;
  /** Núcleo de ai-core; por defecto getAiCore de lib/ai-client.ts (perezoso). */
  core?: () => AiCore;
  /** Respaldo sin proveedor o ante cualquier fallo; por defecto RulesDocumentsAi. */
  fallback?: DocumentsAiPort;
  /** UserContext con el que corre el runner; por defecto el actor del sistema con ai.tool.execute. */
  userContext?: (ctx: DocumentsAiContext) => UserContext;
};

type ClassifyOutput = { kind: string; confidence: number; usage: ModelUsageSummary };
type ExtractOutput = { data: Record<string, unknown>; document: { pages: number; bytes: number; sha256: string }; usage: ModelUsageSummary };

/** UserContext del actor del sistema: organización/centro del documento, permisos mínimos del registro. */
export function pipelineUserContext(ctx: DocumentsAiContext): UserContext {
  return {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    userId: ctx.userId ?? DOCUMENTS_PIPELINE_ACTOR,
    fullName: "Pipeline de documentos",
    deviceId: DOCUMENTS_PIPELINE_ACTOR,
    permissions: [...DOCUMENTS_PIPELINE_PERMISSIONS]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function pageOf(value: unknown, offset: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n) + offset;
}

export function noteFor(error: unknown): string {
  if (error instanceof AiError) return `llm_error:${error.code}`;
  const details = isRecord(error) && isRecord((error as { details?: unknown }).details) ? ((error as { details: Record<string, unknown> }).details.code as string | undefined) : undefined;
  if (details) return `runner_error:${details}`;
  const message = error instanceof Error ? error.message : String(error);
  return `llm_error:${message}`.slice(0, 200);
}

/** Motivo honesto de un resultado del runner que NO ejecutó el modelo con éxito (null cuando sí lo hizo). */
export function runFailureNote<O>(result: ToolRunResult<O>): string | null {
  if (result.status === "denied") return `ai_denied:${result.reason}`;
  if (result.status === "awaiting_confirmation") return "ai_awaiting_confirmation";
  if (!result.configured) {
    const output = result.output as NotConfiguredOutput | undefined;
    return `ai_not_configured:${output?.reason ?? "not_configured"}`;
  }
  return null;
}

/** Campos del modelo → { value, confidence, page } por clave del esquema (claves ajenas fuera; `value: null` se omite). */
export function normalizeModelFields(kind: IncomingDocumentKind, data: unknown, pageOffset = 0): DocumentExtractedFields {
  const fields: DocumentExtractedFields = {};
  if (!isRecord(data)) return fields;
  for (const key of schemaFieldKeys(kind)) {
    const raw = data[key];
    if (!isRecord(raw)) continue;
    if (raw.value === null || raw.value === undefined) continue;
    if (Array.isArray(raw.value) && raw.value.length === 0) continue;
    const page = pageOf(raw.page, pageOffset);
    fields[key] = { value: raw.value, confidence: clamp01(raw.confidence), ...(page !== undefined ? { page } : {}) } as ExtractedField;
  }
  return fields;
}

/** Fusión de tramos: el primer valor leído manda; las listas (líneas, referencias) se concatenan. */
export function mergeChunkFields(chunks: DocumentExtractedFields[]): DocumentExtractedFields {
  const merged: DocumentExtractedFields = {};
  for (const chunk of chunks) {
    for (const [key, fieldValue] of Object.entries(chunk)) {
      const existing = merged[key];
      if (!existing) {
        merged[key] = fieldValue;
        continue;
      }
      if (Array.isArray(existing.value) && Array.isArray(fieldValue.value)) {
        merged[key] = { ...existing, value: [...existing.value, ...fieldValue.value], confidence: Math.min(existing.confidence, fieldValue.confidence) };
      }
    }
  }
  return merged;
}

function sumTelemetry(usages: ModelUsageSummary[]): ExtractionTelemetry | null {
  if (usages.length === 0) return null;
  const costs = usages.map((usage) => usage.costEur).filter((cost): cost is number => typeof cost === "number");
  return {
    model: usages[0]!.model,
    tokensInput: usages.reduce((acc, usage) => acc + usage.tokensInput, 0),
    tokensOutput: usages.reduce((acc, usage) => acc + usage.tokensOutput, 0),
    costEur: costs.length > 0 ? Number(costs.reduce((acc, cost) => acc + cost, 0).toFixed(4)) : null,
    latencyMs: usages.reduce((acc, usage) => acc + usage.latencyMs, 0)
  };
}

function chunkPages(pages: DocumentImagePage[]): Array<{ pages: DocumentImagePage[]; offset: number }> {
  const chunks: Array<{ pages: DocumentImagePage[]; offset: number }> = [];
  for (let start = 0; start < pages.length; start += PAGES_PER_CHUNK) {
    chunks.push({ pages: pages.slice(start, start + PAGES_PER_CHUNK), offset: start });
  }
  return chunks;
}

type ExtractChunkInput = { pages?: DocumentImagePage[]; pdfBase64?: string; pageCount?: number };

class AiCoreDocumentsAi implements DocumentsAiPort {
  constructor(
    private readonly runTool: RunAiToolFn,
    private readonly core: () => AiCore,
    private readonly fallback: DocumentsAiPort,
    private readonly userContext: (ctx: DocumentsAiContext) => UserContext
  ) {}

  describe(): DocumentsAiDescription {
    try {
      const core = this.core();
      if (!core.isConfigured()) return this.fallback.describe();
      return { configured: true, provider: core.providerName(), model: core.modelName("classify") };
    } catch {
      return this.fallback.describe();
    }
  }

  private configured(): boolean {
    try {
      return this.core().isConfigured();
    } catch {
      return false;
    }
  }

  async classify(input: ClassifyDocumentInput, ctx: DocumentsAiContext): Promise<ClassifyDocumentOutput> {
    const withNote = async (note: string): Promise<ClassifyDocumentOutput> => ({ ...(await this.fallback.classify(input, ctx)), note });
    if (!this.configured()) return this.fallback.classify(input, ctx);
    // XML (e-factura) y documentos sin texto no necesitan modelo: las reglas ya son deterministas.
    const text = (input.text ?? "").trim();
    if (text.length === 0 || /^\s*<\?xml/i.test(text) || (input.mimeType && /xml/i.test(input.mimeType))) return this.fallback.classify(input, ctx);
    try {
      const result = await this.runTool<{ text: string; fileName?: string }, ClassifyOutput>({
        context: this.userContext(ctx),
        toolName: CLASSIFY_TOOL_NAME,
        input: { text: text.slice(0, CLASSIFY_MAX_TEXT), ...(input.fileName ? { fileName: input.fileName.slice(0, 255) } : {}) },
        correlationId: ctx.correlationId,
        source: "system"
      });
      const failure = runFailureNote(result);
      if (failure || result.status !== "executed") return withNote(failure ?? "ai_not_executed");
      const output = result.output;
      if (!isRecord(output) || typeof output.kind !== "string") return withNote("llm_invalid_output");
      return { kind: output.kind as IncomingDocumentKind, confidence: clamp01(output.confidence), source: "ai", model: output.usage?.model };
    } catch (error) {
      return withNote(noteFor(error));
    }
  }

  async extract(input: ExtractDocumentInput, ctx: DocumentsAiContext): Promise<ExtractDocumentOutput> {
    const withWarning = async (warning: string): Promise<ExtractDocumentOutput> => {
      const rules = await this.fallback.extract(input, ctx);
      return { ...rules, warnings: [warning, ...rules.warnings] };
    };
    if (!this.configured()) return this.fallback.extract(input, ctx);
    if (input.xml || (input.text && /^\s*<\?xml/i.test(input.text))) return this.fallback.extract(input, ctx);
    const allowed = input.aiAllowedKinds ?? [];
    if (AI_RESTRICTED_KINDS.includes(input.kind) && allowed.length > 0 && !allowed.includes(input.kind)) return withWarning(`kind_not_allowed_for_ai:${input.kind}`);
    const hasPages = Boolean(input.pages && input.pages.length > 0);
    if (!hasPages && !input.pdfBase64) return withWarning("no_document_bytes_for_ai");

    const core = this.core();
    const user = this.userContext(ctx);
    const schema = schemaFor(input.kind);
    const instruction = extractionInstructionFor(input.kind);
    const chunks: Array<{ input: ExtractChunkInput; offset: number }> = hasPages
      ? chunkPages(input.pages!).map((chunk) => ({ input: { pages: chunk.pages, pageCount: chunk.pages.length }, offset: chunk.offset }))
      : [{ input: { pdfBase64: input.pdfBase64!, pageCount: input.pageCount }, offset: 0 }];

    const fieldsByChunk: DocumentExtractedFields[] = [];
    const usages: ModelUsageSummary[] = [];
    const toolCallIds: string[] = [];
    const warnings: string[] = [];
    for (const chunk of chunks) {
      try {
        const result = await this.runTool<ExtractChunkInput, ExtractOutput>({
          context: user,
          toolName: EXTRACT_TOOL_NAME,
          input: chunk.input,
          correlationId: ctx.correlationId,
          source: "system",
          // Como los ejecutores L6a: el runner interpreta { configured:false } (NotConfiguredOutput) además de ExecuteResult.
          execute: (value: ExtractChunkInput, runnerCtx: RunnerContext) =>
            this.executeExtract(core, value, runnerCtx, user, schema, instruction, input.kind, input.sha256) as Promise<ExecuteResult<ExtractOutput>>
        });
        if ("toolCallId" in result && result.toolCallId) toolCallIds.push(result.toolCallId);
        const failure = runFailureNote(result);
        if (failure || result.status !== "executed") {
          if (fieldsByChunk.length === 0) return withWarning(failure ?? "ai_not_executed");
          warnings.push(`chunk_${chunk.offset + 1}:${failure ?? "ai_not_executed"}`);
          continue;
        }
        const output = result.output;
        if (!isRecord(output) || !isRecord(output.data)) {
          if (fieldsByChunk.length === 0) return withWarning("llm_invalid_output");
          warnings.push(`chunk_${chunk.offset + 1}:llm_invalid_output`);
          continue;
        }
        fieldsByChunk.push(normalizeModelFields(input.kind, output.data, chunk.offset));
        if (isRecord(output.usage)) usages.push(output.usage as ModelUsageSummary);
      } catch (error) {
        if (fieldsByChunk.length === 0) return withWarning(noteFor(error));
        warnings.push(`chunk_${chunk.offset + 1}:${noteFor(error)}`);
      }
    }
    if (chunks.length > 1) warnings.push(`multi_chunk:${chunks.length}`);
    const telemetry = sumTelemetry(usages);
    return {
      fields: mergeChunkFields(fieldsByChunk),
      source: "ai",
      warnings,
      provider: core.providerName(),
      model: telemetry?.model ?? core.modelName("default"),
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      telemetry,
      toolCallIds
    };
  }

  /** `execute` explícito del runner: llama a ai-core con el esquema del tipo y devuelve `record` sin bytes. */
  private async executeExtract(
    core: AiCore,
    value: ExtractChunkInput,
    runnerCtx: RunnerContext,
    user: UserContext,
    schema: JsonSchema,
    instruction: string,
    kind: IncomingDocumentKind,
    sha256: string
  ): Promise<ExecuteResult<ExtractOutput> | NotConfiguredOutput> {
    const result = await core.extractFromDocument<Record<string, unknown>>(
      {
        ...(value.pages ? { pages: value.pages } : {}),
        ...(value.pdfBase64 ? { pdfBase64: value.pdfBase64 } : {}),
        ...(value.pageCount !== undefined ? { pageCount: value.pageCount } : {}),
        schema,
        instruction,
        maxTokens: EXTRACT_MAX_TOKENS
      },
      aiContextFor(apiToolContextFromRunner(runnerCtx, user), EXTRACT_TOOL_NAME, "extract")
    );
    const wrapped = fromAiResult(result, (success) => ({ data: success.data, document: success.document, usage: usageOf(success) }));
    if (!("output" in wrapped)) return wrapped;
    const record: JsonValue = { pages: wrapped.output.document.pages, sha256, kind, fields: Object.keys(wrapped.output.data).length };
    return { ...wrapped, record };
  }
}

/** Puerto de documentos sobre ai-core vía runAiTool; sin proveedor o ante cualquier fallo cae a `fallback` (reglas). */
export function createAiCoreDocumentsPort(deps: AiCoreDocumentsPortDeps = {}): DocumentsAiPort {
  return new AiCoreDocumentsAi(deps.runTool ?? (runAiTool as RunAiToolFn), deps.core ?? getAiCore, deps.fallback ?? new RulesDocumentsAi(), deps.userContext ?? pipelineUserContext);
}
