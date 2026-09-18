// Núcleo de mensajes: contrato que consumen el shim apps/api/src/lib/llm.ts
// (lote 2), el tool runner (lote 3) y los llamadores de check-in, documentos y
// reputación. Todo pasa por `createAiCore`, que recibe la configuración ya
// resuelta (nunca las variables de entorno), un cliente o `fetchImpl` inyectables, el
// limitador por organización y la fuente de prompts publicados.
//
// Garantías:
//   · sin `configured` → `{ configured:false, reason, message }` SIN fetch;
//   · `limiter.acquire(organizationId)` antes de CADA intento de fetch;
//   · PII redactada por defecto en prompt/messages (no en system ni en bytes)
//     y restaurada en text/data/toolUses.input;
//   · `temperature` solo con sampling; `output_config.effort` solo con effort;
//     `thinking` explícito en Sonnet 5 / Opus 5 (resolveReasoning): sin `effort`
//     ni `thinking` pedidos, Sonnet 5 va con `{ type:"disabled" }` y Opus 5 con
//     adaptativo a effort `low`; con thinking activo max_tokens ≥ 2 048 (el tope
//     cubre pensamiento + respuesta). Haiku 4.5 no lleva `thinking`;
//     `inference_geo` solo en modelos que lo admiten (Haiku 4.5 no);
//     `cache_control` en system solo si opts.cache.system y ≥ cacheMinTokens;
//   · documentos: guardas 10 MB/imagen, 32 MB/petición y páginas ≤ maxPdfPages
//     ANTES de fetch; la telemetría nunca lleva bytes;
//   · stop_reason refusal → configured:false; max_tokens con texto → truncated:true;
//     max_tokens SIN texto (o JSON incompleto) → AiError truncated con telemetría;
//     JSON inválido → AiError invalid_output con telemetría (CFC-01/CFC-02);
//     tool_use → toolUses.

import { createHash } from "node:crypto";

import { estimateTokens, modelCapabilities } from "./capabilities.js";
import type { ModelCapabilities } from "./capabilities.js";
import { createAnthropicClient } from "./client.js";
import type { AnthropicClient, AnthropicContentBlock, AnthropicMessageBody, AnthropicMessageResponse, AnthropicUsage } from "./client.js";
import { isForbiddenModel } from "./config.js";
import type { AiConfig, AiModelRole } from "./config.js";
import { AiError } from "./errors.js";
import type { AiErrorCode, AiErrorTelemetry } from "./errors.js";
import { labelFor } from "./labels.js";
import { costFromUsage } from "./pricing.js";
import type { RateLimiter } from "./rate-limit.js";
import { createPiiRedactor, redactDeep, restorePii, restorePiiDeep } from "./redaction.js";
import type { KnownPii, PiiKind, PiiMap, PiiRedactor } from "./redaction.js";

// --- Tipos del contrato -----------------------------------------------------

export type AiPurpose = "complete" | "classify" | "extract" | "insight";

export type AiContext = {
  organizationId: string;
  propertyId?: string;
  userId?: string;
  toolName: string;
  purpose: AiPurpose;
  correlationId?: string;
  conversationId?: string;
};

/** Subconjunto de JSON Schema aceptado por las salidas estructuradas y las herramientas. */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean;
  description?: string;
  [key: string]: unknown;
};

export type AiModelTool = { name: string; description: string; input_schema: JsonSchema };
export type AiToolUse = { id: string; name: string; input: Record<string, unknown> };
export type AiToolChoice = "auto" | "any" | "none" | { name: string };

export type AiBase64Source = { type: "base64"; media_type: string; data: string };
export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AiBase64Source }
  | { type: "document"; source: AiBase64Source }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AiContentBlock[]; is_error?: boolean };

export type AiMessage = { role: "user" | "assistant"; content: string | AiContentBlock[] };

export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Razonamiento en Sonnet 5 / Opus 5; en Haiku 4.5 y desconocidos se ignora (no se envía `thinking`). */
export type AiThinkingMode = "adaptive" | "disabled";

export type AiOptions = {
  /** Rol (default | classify | insights) o identificador literal de modelo. */
  model?: AiModelRole | string;
  maxTokens?: number;
  /** Solo se envía a modelos con sampling (Haiku 4.5); se descarta en Sonnet 5 / Opus 5. */
  temperature?: number;
  /** Solo se envía a modelos con effort (Sonnet 5 / Opus 5). Con effort y sin `thinking`, el razonamiento es adaptativo. */
  effort?: AiEffort;
  /** Razonamiento explícito (Sonnet 5 / Opus 5). Sin él ni `effort`: Sonnet 5 disabled, Opus 5 adaptativo a effort low. */
  thinking?: AiThinkingMode;
  timeoutMs?: number;
  cache?: { system: boolean; ttl?: "5m" | "1h" };
  /** Redacción de PII en prompt/messages (defecto true). */
  redactPii?: boolean;
  piiKinds?: readonly PiiKind[];
  roomNumbers?: boolean;
  /** PII conocida del huésped/reserva (nombre, correo, teléfono…) que se redacta aunque no la detecte ninguna regla. */
  knownPii?: ReadonlyArray<KnownPii>;
  /** Redactar también `system` con el mismo mapa (contexto del huésped en instrucciones; defecto false). */
  redactSystem?: boolean;
  inferenceGeo?: string;
  tools?: AiModelTool[];
  toolChoice?: AiToolChoice;
  signal?: AbortSignal;
};

export type AiUsage = { tokensInput: number; tokensOutput: number; cacheReadTokens: number; cacheWriteTokens: number };

/** Misma forma que AiErrorTelemetry (lo que viaja en un AiError tras una respuesta facturada). */
export type AiTelemetry = AiErrorTelemetry;

export type AiSuccessMeta = {
  configured: true;
  provider: "anthropic";
  model: string;
  usage: AiUsage;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number | null;
  costEur: number | null;
  latencyMs: number;
  stopReason: string | null;
  truncated: boolean;
  toolUses: AiToolUse[];
};

export type AiNotConfigured = {
  configured: false;
  reason: AiErrorCode;
  message: string;
  /** Presente cuando el modelo sí respondió (refusal): el coste se registra igualmente. */
  telemetry?: AiTelemetry;
};

export type AiResult<T> = (AiSuccessMeta & T) | AiNotConfigured;

export type CompleteInput = { system?: string; prompt?: string; messages?: AiMessage[]; maxTokens?: number };
export type StructuredInput = { system?: string; prompt: string; schema: JsonSchema; maxTokens?: number };
export type DocumentPage = { mediaType: string; base64: string };
export type ExtractFromDocumentInput = {
  pages?: DocumentPage[];
  pdfBase64?: string;
  /** Páginas del PDF si el llamador las conoce; si no, se estiman del propio fichero. */
  pageCount?: number;
  schema: JsonSchema;
  instruction: string;
  maxTokens?: number;
};
export type DocumentTelemetry = { pages: number; bytes: number; sha256: string };

/** Mismos campos que DocFields de apps/api/src/lib/llm.ts:122-132. */
export type DocFields = {
  documentType?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  firstName?: string;
  surname1?: string;
  surname2?: string;
  dateOfBirth?: string;
  nationality?: string;
  sex?: string;
};
export type DocFieldConfidence = Partial<Record<keyof DocFields, number>>;

export type ClassifyInput = { text: string; labels: readonly string[]; system?: string };
export type ClassifyOutput = { label: string; confidence: number; rationale?: string };
export type InsightInput = { system?: string; prompt: string; maxTokens?: number };

export type PromptSource = { getPublishedPrompt(code: string): Promise<string | null> };

export type AiCoreDeps = {
  config: AiConfig;
  client?: AnthropicClient;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  promptSource?: PromptSource;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type AiCore = {
  readonly config: AiConfig;
  isConfigured(): boolean;
  providerName(): "anthropic" | "none";
  modelName(role?: AiModelRole): string;
  /** Cliente crudo (humo manual: getModel, countTokens); null sin configuración. */
  getClient(): AnthropicClient | null;
  complete(input: CompleteInput, ctx: AiContext, opts?: AiOptions): Promise<AiResult<{ text: string }>>;
  structured<T = Record<string, unknown>>(input: StructuredInput, ctx: AiContext, opts?: AiOptions): Promise<AiResult<{ data: T }>>;
  extractFromDocument<T = Record<string, unknown>>(input: ExtractFromDocumentInput, ctx: AiContext, opts?: AiOptions): Promise<AiResult<{ data: T; document: DocumentTelemetry }>>;
  extractIdentityDocument(imageDataUrl: string, ctx: AiContext, opts?: AiOptions): Promise<AiResult<{ fields: DocFields; confidence: DocFieldConfidence }>>;
  extractJsonFromImage(imageDataUrl: string, instruction: string, ctx: AiContext, opts?: AiOptions): Promise<AiResult<{ data: Record<string, unknown> }>>;
  classify(input: ClassifyInput, ctx: AiContext, opts?: AiOptions): Promise<AiResult<ClassifyOutput>>;
  insight(input: InsightInput, ctx: AiContext, opts?: AiOptions): Promise<AiResult<{ text: string }>>;
  promptFrom(code: string, fallback: string): Promise<string>;
};

// --- Constantes -------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_DOCUMENT_MAX_TOKENS = 4000;
/** Con razonamiento activo max_tokens acota pensamiento + respuesta: por debajo de esto la respuesta llega vacía. */
export const MIN_MAX_TOKENS_WITH_THINKING = 2048;
/** Effort por defecto cuando el razonamiento adaptativo se activa sin que el llamador lo pida (Opus 5). */
export const DEFAULT_ADAPTIVE_EFFORT: AiEffort = "low";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const PROMPT_CACHE_TTL_MS = 60_000;

/** Instrucción OCR en español (apps/api/src/lib/llm.ts:143-148) más confianza por campo. */
export const IDENTITY_DOCUMENT_INSTRUCTION =
  "Eres un extractor de datos de documentos de identidad. Extrae los campos del documento (DNI, NIE, " +
  "pasaporte o TIE) de la imagen y devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional, con " +
  "estas claves cuando aparezcan: documentType (uno de: DNI, NIE, PASSPORT, TIE), documentNumber, " +
  "documentSupportNumber, firstName, surname1, surname2, dateOfBirth (formato YYYY-MM-DD), nationality " +
  "(código ISO-3, p. ej. ESP), sex (M o F). Deja en null las claves que no puedas leer con seguridad. No inventes datos. " +
  "En `confidence` indica, para cada clave, tu confianza entre 0 y 1 (null si no la has leído).";

const DOC_FIELD_KEYS: ReadonlyArray<keyof DocFields> = ["documentType", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "dateOfBirth", "nationality", "sex"];

function nullableString(extra: Partial<JsonSchema> = {}): JsonSchema {
  return { anyOf: [{ type: "string", ...extra }, { type: "null" }] };
}

/** Esquema de salida estructurada para documentos de identidad (todas las claves presentes, nulas si no se leen). */
export const IDENTITY_DOCUMENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [...DOC_FIELD_KEYS, "confidence"],
  properties: {
    documentType: nullableString({ enum: ["DNI", "NIE", "PASSPORT", "TIE"] }),
    documentNumber: nullableString(),
    documentSupportNumber: nullableString(),
    firstName: nullableString(),
    surname1: nullableString(),
    surname2: nullableString(),
    dateOfBirth: nullableString(),
    nationality: nullableString(),
    sex: nullableString({ enum: ["M", "F"] }),
    confidence: {
      type: "object",
      additionalProperties: false,
      required: [...DOC_FIELD_KEYS],
      properties: Object.fromEntries(DOC_FIELD_KEYS.map((key) => [key, { anyOf: [{ type: "number" }, { type: "null" }] }]))
    }
  }
};

// --- Utilidades puras -------------------------------------------------------

export function toolResultBlock(toolUseId: string, content: string | AiContentBlock[], isError = false): AiContentBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

export function usageFromAnthropic(usage: Partial<AnthropicUsage> | undefined): AiUsage {
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    tokensInput: n(usage?.input_tokens),
    tokensOutput: n(usage?.output_tokens),
    cacheReadTokens: n(usage?.cache_read_input_tokens),
    cacheWriteTokens: n(usage?.cache_creation_input_tokens)
  };
}

export function telemetryFromAiResult(result: AiResult<unknown> | null | undefined): AiTelemetry | null {
  if (!result) return null;
  if (result.configured === false) return result.telemetry ?? null;
  return {
    model: result.model,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cacheReadTokens: result.usage.cacheReadTokens,
    costUsd: result.costUsd,
    costEur: result.costEur,
    latencyMs: result.latencyMs
  };
}

export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec((dataUrl ?? "").trim());
  if (!match) return null;
  return { mediaType: match[1]!, base64: match[2]! };
}

/** Bytes que codifica una cadena base64 (sin decodificarla). */
export function base64ByteLength(base64: string): number {
  const length = base64.length;
  if (length === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

/** Estimación de páginas de un PDF por objetos `/Type /Page` (mínimo 1). */
export function estimatePdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return Math.max(1, matches ? matches.length : 1);
}

/** Extrae el primer objeto JSON de un texto (tolera prosa o cercas ``` alrededor). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // siguiente candidato
    }
  }
  return null;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Validación local mínima de una salida frente al esquema: `required`, tipos
 * primitivos, `enum`, `anyOf`, `properties` e `items`. Sin minimum/maxLength
 * (el proveedor tampoco los admite). Devuelve la lista de incumplimientos.
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const ok = schema.anyOf.some((branch) => validateJsonSchema(value, branch, path).length === 0);
    if (!ok) errors.push(`${path}: no cumple ninguna alternativa de anyOf`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(`${path}: valor fuera de enum`);
    return errors;
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${path}: tipo esperado ${types.join("|")}`);
    return errors;
  }
  if (types.includes("object") || (types.length === 0 && schema.properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return errors;
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key}: obligatorio`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) errors.push(...validateJsonSchema(record[key], child, `${path}.${key}`));
    }
  }
  if (types.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items!, `${path}[${index}]`)));
  }
  return errors;
}

function redactMessages(messages: AiMessage[], redactor: PiiRedactor | null): AiMessage[] {
  if (!redactor) return messages;
  const redactBlocks = (blocks: AiContentBlock[]): AiContentBlock[] =>
    blocks.map((block) => {
      switch (block.type) {
        case "text":
          return { ...block, text: redactor.redact(block.text) };
        case "tool_use":
          return { ...block, input: redactDeep(block.input, redactor) };
        case "tool_result":
          return { ...block, content: typeof block.content === "string" ? redactor.redact(block.content) : redactBlocks(block.content) };
        default:
          return block; // image / document: nunca sobre bytes
      }
    });
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? redactor.redact(message.content) : redactBlocks(message.content)
  }));
}

function textFrom(content: AnthropicContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

function toolUsesFrom(content: AnthropicContentBlock[], map: PiiMap): AiToolUse[] {
  return content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : "",
      name: typeof block.name === "string" ? block.name : "",
      input: restorePiiDeep((block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>, map)
    }));
}

function toolChoiceBody(choice: AiToolChoice | undefined): Record<string, unknown> | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return { type: choice };
  return { type: "tool", name: choice.name };
}

export type ResolvedReasoning = { thinking?: { type: AiThinkingMode }; effort?: AiEffort };

/**
 * Qué `thinking` / `effort` viajan en el cuerpo (CFC-01). Sonnet 5 y Opus 5 razonan por defecto
 * (effort high) cuando se omite `thinking` y max_tokens acota pensamiento + respuesta, así que las
 * llamadas cortas del catálogo (150-800 tokens) volverían vacías y facturadas. Regla:
 *   · sin `thinking` ni `effort` → Sonnet 5 `disabled` (barato y seguro); Opus 5 adaptativo con
 *     effort `low` (desactivarlo ahí tiene modos de fallo documentados);
 *   · `effort` pedido sin `thinking` → adaptativo con ese effort;
 *   · `disabled` solo se admite hasta effort high → con xhigh|max pasa a adaptativo;
 *   · Haiku 4.5 y desconocidos: nada (ni thinking ni effort).
 */
export function resolveReasoning(caps: ModelCapabilities, opts: Pick<AiOptions, "thinking" | "effort">): ResolvedReasoning {
  if (caps.thinking !== "adaptive") return {};
  let mode: AiThinkingMode = opts.thinking ?? (opts.effort !== undefined ? "adaptive" : caps.thinkingOffSafe ? "disabled" : "adaptive");
  if (mode === "disabled" && (opts.effort === "xhigh" || opts.effort === "max")) mode = "adaptive";
  const effort = opts.effort ?? (mode === "adaptive" && opts.thinking === undefined ? DEFAULT_ADAPTIVE_EFFORT : undefined);
  return { thinking: { type: mode }, ...(effort !== undefined && caps.effort ? { effort } : {}) };
}

function systemBody(system: string | undefined, caps: ModelCapabilities, opts: AiOptions): string | Array<Record<string, unknown>> | undefined {
  if (!system) return undefined;
  if (opts.cache?.system && estimateTokens(system) >= caps.cacheMinTokens) {
    const cacheControl: Record<string, unknown> = { type: "ephemeral", ...(opts.cache.ttl === "1h" ? { ttl: "1h" } : {}) };
    return [{ type: "text", text: system, cache_control: cacheControl }];
  }
  return system;
}

// --- Núcleo -----------------------------------------------------------------

type SendParams = {
  ctx: AiContext;
  opts: AiOptions;
  model: string;
  system?: string;
  messages: AiMessage[];
  maxTokens: number;
  format?: JsonSchema;
  /** Redactar PII en `messages` (false para bytes/instrucciones propias). */
  redact: boolean;
  defaultTimeoutMs: number;
};

type SendOutcome = { response: AnthropicMessageResponse; latencyMs: number; map: PiiMap };

export function createAiCore(deps: AiCoreDeps): AiCore {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? null;
  const client: AnthropicClient | null =
    deps.client ??
    (config.configured && config.apiKey
      ? createAnthropicClient({
          apiKey: config.apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.random ? { random: deps.random } : {}),
          now
        })
      : null);
  const promptCache = new Map<string, { value: string | null; expiresAt: number }>();

  function notConfigured(reason: AiErrorCode = config.reason ?? "not_configured"): AiNotConfigured {
    return { configured: false, reason, message: labelFor(reason) };
  }

  function resolveModel(option: AiOptions["model"]): string {
    if (option === undefined || option === "default") return config.models.default;
    if (option === "classify" || option === "insights") return config.models[option];
    const literal = option.trim();
    if (!literal) return config.models.default;
    if (isForbiddenModel(literal)) {
      throw new AiError("model_forbidden", `${labelFor("model_forbidden")}: ${literal}`, { retryable: false });
    }
    return literal;
  }

  function acquireOrThrow(ctx: AiContext): void {
    if (!limiter) return;
    const decision = limiter.acquire(ctx.organizationId);
    if (!decision.ok) {
      throw new AiError("rate_limited", `${labelFor("rate_limited")} para la organización; reintente en ${Math.ceil(decision.retryAfterMs / 1000)} s.`, {
        retryable: true,
        status: 429,
        retryAfterMs: decision.retryAfterMs
      });
    }
  }

  async function send(params: SendParams): Promise<SendOutcome> {
    if (!client) throw new AiError("not_configured", labelFor("not_configured"), { retryable: false });
    const { opts, ctx, model } = params;
    const caps = modelCapabilities(model);
    const redactor =
      params.redact && opts.redactPii !== false
        ? createPiiRedactor({ ...(opts.piiKinds ? { kinds: opts.piiKinds } : {}), ...(opts.roomNumbers ? { roomNumbers: true } : {}), ...(opts.knownPii ? { knownPii: opts.knownPii } : {}) })
        : null;
    const messages = redactMessages(params.messages, redactor);
    const systemText = params.system !== undefined && opts.redactSystem && redactor ? redactor.redact(params.system) : params.system;

    const reasoning = resolveReasoning(caps, opts);
    const outputConfig: Record<string, unknown> = {};
    if (reasoning.effort) outputConfig.effort = reasoning.effort;
    if (params.format) outputConfig.format = { type: "json_schema", schema: params.format };
    const system = systemBody(systemText, caps, opts);
    // CFC-03: Haiku 4.5 no admite inference_geo (400 no reintentable en toda clasificación).
    const inferenceGeo = caps.inferenceGeo ? (opts.inferenceGeo ?? config.inferenceGeo) : undefined;
    const toolChoice = toolChoiceBody(opts.toolChoice);
    const maxTokens = reasoning.thinking?.type === "adaptive" ? Math.max(params.maxTokens, MIN_MAX_TOKENS_WITH_THINKING) : params.maxTokens;

    const body: AnthropicMessageBody = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(caps.sampling && typeof opts.temperature === "number" ? { temperature: opts.temperature } : {}),
      ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })) } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(inferenceGeo ? { inference_geo: inferenceGeo } : {})
    };

    const started = now();
    const response = await client.createMessage(body, {
      timeoutMs: opts.timeoutMs ?? params.defaultTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      beforeAttempt: () => acquireOrThrow(ctx)
    });
    return { response, latencyMs: Math.max(0, now() - started), map: redactor?.map ?? {} };
  }

  function meta(outcome: SendOutcome, model: string, opts: AiOptions): AiSuccessMeta {
    const usage = usageFromAnthropic(outcome.response.usage);
    const cost = costFromUsage({ ...usage, ...(opts.cache?.ttl ? { cacheWriteTtl: opts.cache.ttl } : {}) }, model, config.usdEurRate);
    const stopReason = outcome.response.stop_reason ?? null;
    return {
      configured: true,
      provider: "anthropic",
      model,
      usage,
      tokensInput: usage.tokensInput,
      tokensOutput: usage.tokensOutput,
      costUsd: cost.usd,
      costEur: cost.eur,
      latencyMs: outcome.latencyMs,
      stopReason,
      truncated: stopReason === "max_tokens",
      toolUses: toolUsesFrom(outcome.response.content, outcome.map)
    };
  }

  function refusal(base: AiSuccessMeta): AiNotConfigured {
    return { configured: false, reason: "refusal", message: labelFor("refusal"), telemetry: telemetryFromAiResult(base)! };
  }

  function messagesFrom(input: CompleteInput): AiMessage[] {
    const hasPrompt = typeof input.prompt === "string";
    const hasMessages = Array.isArray(input.messages);
    if (hasPrompt === hasMessages) throw new TypeError("complete(): indique `prompt` o `messages`, no ambos ni ninguno.");
    return hasPrompt ? [{ role: "user", content: input.prompt as string }] : (input.messages as AiMessage[]);
  }

  /** Respuesta cortada por max_tokens sin contenido útil: fallo con la telemetría de la llamada facturada. */
  function truncatedError(base: AiSuccessMeta, what: string): AiError {
    return new AiError("truncated", `${labelFor("truncated")} (max_tokens): ${what}.`, { retryable: false, telemetry: telemetryFromAiResult(base)! });
  }

  function structuredData<T>(outcome: SendOutcome, schema: JsonSchema, base: AiSuccessMeta): T {
    const text = textFrom(outcome.response.content);
    const parsed = parseJsonObject(text);
    const telemetry = telemetryFromAiResult(base)!;
    if (!parsed) {
      if (base.truncated) throw truncatedError(base, "el JSON llegó incompleto");
      throw new AiError("invalid_output", `${labelFor("invalid_output")}: no contiene un objeto JSON.`, { retryable: false, details: { text: text.slice(0, 500) }, telemetry });
    }
    const errors = validateJsonSchema(parsed, schema);
    if (errors.length > 0) {
      throw new AiError("invalid_output", `${labelFor("invalid_output")}: ${errors.slice(0, 5).join("; ")}`, { retryable: false, details: { errors }, telemetry });
    }
    return restorePiiDeep(parsed, outcome.map) as T;
  }

  const core: AiCore = {
    config,
    isConfigured: () => config.configured,
    providerName: () => (config.configured ? "anthropic" : "none"),
    modelName: (role = "default") => config.models[role],
    getClient: () => client,

    async complete(input, ctx, opts = {}) {
      if (!config.configured) return notConfigured();
      const model = resolveModel(opts.model);
      const outcome = await send({
        ctx,
        opts,
        model,
        ...(input.system !== undefined ? { system: input.system } : {}),
        messages: messagesFrom(input),
        maxTokens: input.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        redact: true,
        defaultTimeoutMs: config.timeoutMs
      });
      const base = meta(outcome, model, opts);
      if (base.stopReason === "refusal") return refusal(base);
      const text = restorePii(textFrom(outcome.response.content), outcome.map);
      // CFC-01: cortado por max_tokens sin texto (solo pensamiento) es un fallo facturado, no un éxito.
      if (base.truncated && !text) throw truncatedError(base, "sin texto de respuesta");
      return { ...base, text };
    },

    async structured(input, ctx, opts = {}) {
      if (!config.configured) return notConfigured();
      const model = resolveModel(opts.model);
      const outcome = await send({
        ctx,
        opts,
        model,
        ...(input.system !== undefined ? { system: input.system } : {}),
        messages: [{ role: "user", content: input.prompt }],
        maxTokens: input.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        format: input.schema,
        redact: true,
        defaultTimeoutMs: config.timeoutMs
      });
      const base = meta(outcome, model, opts);
      if (base.stopReason === "refusal") return refusal(base);
      return { ...base, data: structuredData(outcome, input.schema, base) };
    },

    async extractFromDocument(input, ctx, opts = {}) {
      if (!config.configured) return notConfigured();
      const model = resolveModel(opts.model);
      const caps = modelCapabilities(model);
      const blocks: AiContentBlock[] = [];
      const hash = createHash("sha256");
      let bytes = 0;
      let pages = 0;

      for (const page of input.pages ?? []) {
        const size = base64ByteLength(page.base64);
        if (size > MAX_IMAGE_BYTES) {
          throw new AiError("payload_too_large", `${labelFor("payload_too_large")}: una imagen supera ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, { retryable: false, details: { bytes: size } });
        }
        bytes += size;
        pages += 1;
        hash.update(Buffer.from(page.base64, "base64"));
        blocks.push({ type: "image", source: { type: "base64", media_type: page.mediaType, data: page.base64 } });
      }
      if (input.pdfBase64) {
        const size = base64ByteLength(input.pdfBase64);
        bytes += size;
        if (bytes > MAX_REQUEST_BYTES) {
          throw new AiError("payload_too_large", `${labelFor("payload_too_large")}: la petición supera ${MAX_REQUEST_BYTES / (1024 * 1024)} MB.`, { retryable: false, details: { bytes } });
        }
        const decoded = Buffer.from(input.pdfBase64, "base64");
        hash.update(decoded);
        pages += input.pageCount ?? estimatePdfPages(decoded);
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } });
      }
      if (blocks.length === 0) throw new TypeError("extractFromDocument(): indique `pages` o `pdfBase64`.");
      if (bytes > MAX_REQUEST_BYTES) {
        throw new AiError("payload_too_large", `${labelFor("payload_too_large")}: la petición supera ${MAX_REQUEST_BYTES / (1024 * 1024)} MB.`, { retryable: false, details: { bytes } });
      }
      if (pages > caps.maxPdfPages) {
        throw new AiError("payload_too_large", `${labelFor("payload_too_large")}: ${pages} páginas superan el máximo de ${caps.maxPdfPages} del modelo ${model}.`, {
          retryable: false,
          details: { pages, maxPdfPages: caps.maxPdfPages }
        });
      }
      blocks.push({ type: "text", text: input.instruction });
      const document: DocumentTelemetry = { pages, bytes, sha256: hash.digest("hex") };

      const outcome = await send({
        ctx,
        opts,
        model,
        messages: [{ role: "user", content: blocks }],
        maxTokens: input.maxTokens ?? opts.maxTokens ?? DEFAULT_DOCUMENT_MAX_TOKENS,
        format: input.schema,
        redact: false,
        defaultTimeoutMs: config.documentTimeoutMs
      });
      const base = meta(outcome, model, opts);
      if (base.stopReason === "refusal") return refusal(base);
      return { ...base, data: structuredData(outcome, input.schema, base), document };
    },

    async extractIdentityDocument(imageDataUrl, ctx, opts = {}) {
      if (!config.configured) return notConfigured();
      const parsed = parseDataUrl(imageDataUrl);
      if (!parsed) throw new TypeError("extractIdentityDocument(): la imagen debe ser una URL de datos base64 (data:<tipo>;base64,…).");
      const result = await core.extractFromDocument<Record<string, unknown>>(
        { pages: [{ mediaType: parsed.mediaType, base64: parsed.base64 }], schema: IDENTITY_DOCUMENT_SCHEMA, instruction: IDENTITY_DOCUMENT_INSTRUCTION, maxTokens: 800 },
        { ...ctx, purpose: "extract" },
        // CFC-08: un documento de identidad es visión → timeout de documentos (120 s), no el de texto.
        { timeoutMs: opts.timeoutMs ?? config.documentTimeoutMs, ...opts }
      );
      if (result.configured === false) return result;
      const { data, document: _document, ...base } = result;
      const fields: DocFields = {};
      const confidence: DocFieldConfidence = {};
      const rawConfidence = (data.confidence && typeof data.confidence === "object" ? data.confidence : {}) as Record<string, unknown>;
      for (const key of DOC_FIELD_KEYS) {
        const value = data[key];
        if (typeof value === "string" && value.trim()) fields[key] = value.trim();
        const score = rawConfidence[key];
        if (typeof score === "number" && Number.isFinite(score)) confidence[key] = Math.min(1, Math.max(0, score));
      }
      return { ...base, fields, confidence };
    },

    async extractJsonFromImage(imageDataUrl, instruction, ctx, opts = {}) {
      if (!config.configured) return notConfigured();
      const parsed = parseDataUrl(imageDataUrl);
      if (!parsed) throw new TypeError("extractJsonFromImage(): la imagen debe ser una URL de datos base64 (data:<tipo>;base64,…).");
      const size = base64ByteLength(parsed.base64);
      if (size > MAX_IMAGE_BYTES) {
        throw new AiError("payload_too_large", `${labelFor("payload_too_large")}: la imagen supera ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`, { retryable: false, details: { bytes: size } });
      }
      const model = resolveModel(opts.model);
      const outcome = await send({
        ctx,
        opts,
        model,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.base64 } }, { type: "text", text: instruction }] }],
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        redact: false,
        defaultTimeoutMs: config.documentTimeoutMs
      });
      const base = meta(outcome, model, opts);
      if (base.stopReason === "refusal") return refusal(base);
      const data = parseJsonObject(textFrom(outcome.response.content));
      if (!data) {
        if (base.truncated) throw truncatedError(base, "el JSON llegó incompleto");
        throw new AiError("invalid_output", `${labelFor("invalid_output")}: no contiene un objeto JSON.`, { retryable: false, telemetry: telemetryFromAiResult(base)! });
      }
      return { ...base, data };
    },

    async classify(input, ctx, opts = {}) {
      if (!config.configured) return notConfigured();
      const labels = [...new Set(input.labels.map((label) => label.trim()).filter(Boolean))];
      if (labels.length === 0) throw new TypeError("classify(): `labels` no puede estar vacío.");
      const schema: JsonSchema = {
        type: "object",
        additionalProperties: false,
        required: ["label", "confidence", "rationale"],
        properties: {
          label: { type: "string", enum: labels },
          confidence: { type: "number" },
          rationale: { type: "string" }
        }
      };
      const system =
        input.system ??
        `Eres un clasificador. Elige exactamente una etiqueta de esta lista: ${labels.join(", ")}. ` +
          "Indica en `confidence` tu confianza entre 0 y 1 y en `rationale` una justificación breve en español. No inventes etiquetas.";
      const result = await core.structured<{ label: string; confidence: number; rationale?: string }>(
        { system, prompt: `Texto a clasificar:\n"""\n${input.text}\n"""`, schema, maxTokens: opts.maxTokens ?? 300 },
        { ...ctx, purpose: "classify" },
        { model: "classify", temperature: 0, ...opts }
      );
      if (result.configured === false) return result;
      const { data, ...base } = result;
      const confidence = typeof data.confidence === "number" ? Math.min(1, Math.max(0, data.confidence)) : 0;
      return { ...base, label: data.label, confidence, ...(data.rationale ? { rationale: data.rationale } : {}) };
    },

    insight(input, ctx, opts = {}) {
      return core.complete(
        { ...(input.system !== undefined ? { system: input.system } : {}), prompt: input.prompt, ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}) },
        { ...ctx, purpose: "insight" },
        { model: "insights", effort: "medium", ...opts }
      );
    },

    async promptFrom(code, fallback) {
      const source = deps.promptSource;
      if (!source) return fallback;
      const at = now();
      const cached = promptCache.get(code);
      if (cached && cached.expiresAt > at) return cached.value ?? fallback;
      let value: string | null = null;
      try {
        const published = await source.getPublishedPrompt(code);
        value = typeof published === "string" && published.trim() ? published : null;
      } catch {
        value = null; // la fuente falló: respaldo honesto al prompt en código
      }
      promptCache.set(code, { value, expiresAt: at + PROMPT_CACHE_TTL_MS });
      return value ?? fallback;
    }
  };

  return core;
}
