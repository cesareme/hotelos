// Sugerencia de mapeo asistida por IA (Tanda L6a, lote 4). Reproduce el cuerpo
// del handler POST /onboarding/ai/suggest-mapping (server.ts:6592-6672): el motor
// determinista de mapeo sigue siendo la fuente de verdad; esto solo propone un
// destino canónico para un valor de origen de baja confianza, que una persona
// aprueba. La llamada al modelo usa salida estructurada (esquema
// { target, confidence, rationale }) a través del tool runner (runAiTool →
// ai-core), que evalúa las puertas y registra la telemetría UNA sola vez con el
// nombre legado `onboarding_mapping_suggest` (fila completed | skipped | failed).
// Mismas respuestas y mensajes en español que el handler.
//
// OJO (registro, lote 3): suggestRoomTypeMapping / suggestRatePlanMapping /
// suggestChannelMapping figuran con requiresConfirmation y sin `effect`
// explícito (registry.ts:184-187), así que la heurística las trata como
// escritura y el runner las deja en awaiting_confirmation en vez de ejecutarlas.
// Hasta que el orquestador declare `effect: "read"` en esas tres definiciones, el
// comando responde de forma honesta con `suggestion: null` y el aviso de pendiente.

import type { JsonSchema } from "@hotelos/ai-core";
import type { ToolRunResult } from "@hotelos/ai-core/runner";
import { MAPPING_CATALOGS } from "@hotelos/ai-tools";
import type { HotelOsToolName } from "@hotelos/ai-tools";
import { getAiCore } from "../../lib/ai-client.js";
import type { UserContext } from "../../lib/demo-store.js";
import { ForbiddenError, TooManyRequestsError } from "../../lib/http-error.js";
import { isLlmConfigured } from "../../lib/llm.js";
import { runAiTool } from "../ai-operations/tool-runner.service.js";
import { aiContextFor, apiToolContextFromRunner, fromAiResult } from "../ai-operations/tools/context.js";
import type { NotConfiguredOutput } from "../ai-operations/tools/context.js";

export const SUGGEST_MAPPING_RECORD_AS = "onboarding_mapping_suggest" as const;
export const MAPPING_NOT_CONFIGURED_MESSAGE = "IA no configurada. Edita el destino a mano o configura un proveedor de IA.";
export const MAPPING_NO_TARGET_MESSAGE = "La IA no encontró un destino claro.";

export const MAPPING_TARGET_TYPES = ["room_type", "rate_plan", "channel"] as const;
export type MappingTargetType = (typeof MAPPING_TARGET_TYPES)[number];

const TOOL_BY_TARGET: Record<MappingTargetType, HotelOsToolName> = {
  room_type: "suggestRoomTypeMapping",
  rate_plan: "suggestRatePlanMapping",
  channel: "suggestChannelMapping"
};

type CatalogEntry = { target: string; aliases: string[] };

const CATALOG_BY_TARGET: Record<MappingTargetType, CatalogEntry[]> = {
  room_type: MAPPING_CATALOGS.ROOM_TYPE_CATALOG,
  rate_plan: MAPPING_CATALOGS.RATE_CODE_CATALOG,
  channel: MAPPING_CATALOGS.CHANNEL_CATALOG
};

/** Texto del handler (server.ts:6619-6623). */
const SUGGESTION_SYSTEM =
  "Eres un experto en mapeo de datos para un PMS hotelero. Dado un VALOR DE ORIGEN y una lista de DESTINOS " +
  "canónicos, elige el destino que mejor corresponde. Devuelve EXCLUSIVAMENTE un JSON " +
  '{"target": string, "confidence": number entre 0 y 1, "rationale": string breve en español}. ' +
  "El target DEBE ser exactamente uno de los destinos de la lista; si ninguno encaja, devuelve target vacío.";

const SUGGESTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target", "confidence", "rationale"],
  properties: {
    target: { type: "string" },
    confidence: { type: "number" },
    rationale: { type: "string" }
  }
};

export type MappingSuggestion = { target: string; confidence: number; rationale: string };

export type SuggestMappingResult =
  | { configured: false; message: string }
  | { configured: true; suggestion: MappingSuggestion }
  | { configured: true; suggestion: null; message: string };

export type SuggestMappingCommandInput = {
  context: UserContext;
  sourceValue: string;
  targetType: string;
  correlationId: string;
};

type RawSuggestion = { target?: unknown; confidence?: unknown; rationale?: unknown };

export function isMappingTargetType(value: string): value is MappingTargetType {
  return (MAPPING_TARGET_TYPES as readonly string[]).includes(value);
}

/** Normaliza la salida del modelo como el handler (server.ts:6639-6643): target válido del catálogo o vacío. */
export function normalizeSuggestion(raw: RawSuggestion, candidates: readonly string[]): MappingSuggestion {
  const target = typeof raw.target === "string" ? raw.target.trim() : "";
  const valid = candidates.find((candidate) => candidate.toLowerCase() === target.toLowerCase()) ?? "";
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const rationale = typeof raw.rationale === "string" ? raw.rationale : "";
  return { target: valid, confidence: valid ? confidence : 0, rationale };
}

function isBudgetDenial(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "AI_BUDGET_EXCEEDED";
}

export async function suggestMappingCommand(input: SuggestMappingCommandInput): Promise<SuggestMappingResult> {
  const targetType = input.targetType;
  if (!isMappingTargetType(targetType)) {
    return { configured: false, message: `No hay catálogo de destinos para "${targetType}".` };
  }
  if (!isLlmConfigured()) {
    return { configured: false, message: MAPPING_NOT_CONFIGURED_MESSAGE };
  }
  const candidates = CATALOG_BY_TARGET[targetType].map((entry) => entry.target);
  const toolName = TOOL_BY_TARGET[targetType];

  let result: ToolRunResult<MappingSuggestion | NotConfiguredOutput>;
  try {
    result = await runAiTool<{ sourceValue: string; targetType: MappingTargetType }, MappingSuggestion | NotConfiguredOutput>({
      context: input.context,
      toolName,
      recordAs: SUGGEST_MAPPING_RECORD_AS,
      legacyStatus: { succeeded: "completed", notConfigured: "skipped" },
      input: { sourceValue: input.sourceValue, targetType },
      correlationId: input.correlationId,
      execute: async (value, ctx) => {
        const aiResult = await getAiCore().structured<RawSuggestion>(
          {
            system: SUGGESTION_SYSTEM,
            prompt: `VALOR DE ORIGEN: ${value.sourceValue}\nDESTINOS DISPONIBLES: ${candidates.join(", ")}`,
            schema: SUGGESTION_SCHEMA,
            maxTokens: 150
          },
          aiContextFor(apiToolContextFromRunner(ctx, input.context), toolName, "complete")
        );
        const wrapped = fromAiResult(aiResult, (value) => normalizeSuggestion(value.data, candidates));
        if (!("output" in wrapped)) return wrapped;
        return { ...wrapped, record: { suggestion: wrapped.output } };
      }
    });
  } catch (error) {
    if (isBudgetDenial(error) || error instanceof TooManyRequestsError) return { configured: true, suggestion: null, message: error.message };
    throw error;
  }

  if (result.status === "executed") {
    if (result.configured) {
      const suggestion = result.output as MappingSuggestion;
      if (!suggestion.target) return { configured: true, suggestion: null, message: MAPPING_NO_TARGET_MESSAGE };
      return { configured: true, suggestion };
    }
    const output = result.output as NotConfiguredOutput | undefined;
    if (output?.reason === "refusal") return { configured: true, suggestion: null, message: output.message };
    return { configured: false, message: MAPPING_NOT_CONFIGURED_MESSAGE };
  }
  if (result.status === "awaiting_confirmation") {
    return { configured: true, suggestion: null, message: `La sugerencia ha quedado pendiente de confirmación de una persona (llamada ${result.toolCallId}).` };
  }
  return { configured: true, suggestion: null, message: result.message };
}
