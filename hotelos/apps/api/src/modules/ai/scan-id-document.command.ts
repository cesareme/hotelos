// Escaneo de documento de identidad (Tanda L6a, lote 4). Reproduce el cuerpo del
// handler POST /ai/commands/scan-id-document (server.ts:6544-6586) pasando la
// llamada al modelo por el tool runner (runAiTool → ai-core): las puertas
// (aiEnabled, módulo, permisos, matriz de riesgo, gate, presupuesto) las evalúa
// el runner y solo él registra la telemetría y la auditoría (actorType "ai").
// Formas de respuesta idénticas a las que fijan
// tests/integration/l2-modulos-ia.test.mts:140-148 y docs/api-contracts.md:365:
//   · sin proveedor  → { configured:false, fields:{}, source:"manual", message:"OCR no configurado…" }
//                      y fila scan_id_document `skipped`;
//   · error/rechazo  → { …, message:"El escaneo con IA no está disponible ahora…" } y fila `failed`;
//   · éxito          → { configured:true, fields, source:"ai" } y fila `completed` con modelo,
//                      tokens y coste real.
// La imagen nunca se persiste: inputJson { hasImage:true } y outputJson solo las
// claves leídas y su confianza (nunca los valores del documento).

import { AiError, labelFor, parseDataUrl } from "@hotelos/ai-core";
import type { AiErrorCode, DocFieldConfidence, DocFields } from "@hotelos/ai-core";
import type { ToolRunResult } from "@hotelos/ai-core/runner";
import { getAiCore } from "../../lib/ai-client.js";
import type { UserContext } from "../../lib/demo-store.js";
import { ForbiddenError, TooManyRequestsError } from "../../lib/http-error.js";
import { runAiTool } from "../ai-operations/tool-runner.service.js";
import { aiContextFor, apiToolContextFromRunner, fromAiResult } from "../ai-operations/tools/context.js";
import type { NotConfiguredOutput } from "../ai-operations/tools/context.js";

/** Nombre canónico del registro; la fila se persiste con el nombre legado (l2-modulos-ia.test.mts:144). */
export const SCAN_ID_TOOL_NAME = "extractGuestIdentityFieldsTemporary" as const;
export const SCAN_ID_RECORD_AS = "scan_id_document" as const;

export const SCAN_NOT_CONFIGURED_MESSAGE = "OCR no configurado. Introduzca los datos manualmente o configure un proveedor de IA.";
export const SCAN_UNAVAILABLE_MESSAGE = "El escaneo con IA no está disponible ahora; introduzca los datos manualmente.";
export const SCAN_PENDING_MESSAGE = "El escaneo con IA ha quedado pendiente de aprobación; introduzca los datos manualmente.";

/** Códigos que significan «el proveedor falló» (fila failed): el mensaje es el de indisponibilidad. */
const PROVIDER_FAILURE_CODES: ReadonlySet<string> = new Set<AiErrorCode>(["provider_error", "timeout", "invalid_output", "payload_too_large", "refusal", "pii_redaction_failed"]);

export type ScanIdDocumentResult =
  | { configured: false; fields: Record<string, never>; source: "manual"; message: string }
  | { configured: true; fields: DocFields; source: "ai" };

type ScanOutput = { fields: DocFields; confidence: DocFieldConfidence };

export type ScanIdDocumentCommandInput = {
  context: UserContext;
  imageDataUrl: string;
  correlationId: string;
};

function manual(message: string): ScanIdDocumentResult {
  return { configured: false, fields: {}, source: "manual", message };
}

/** «<motivo>; introduzca los datos manualmente.» (la regex del test L2 exige la coletilla). */
function manualBecause(reason: string): ScanIdDocumentResult {
  return manual(`${reason.trim().replace(/[.;]+$/, "")}; introduzca los datos manualmente.`);
}

function isBudgetDenial(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "AI_BUDGET_EXCEEDED";
}

export async function scanIdDocumentCommand(input: ScanIdDocumentCommandInput): Promise<ScanIdDocumentResult> {
  let result: ToolRunResult<ScanOutput | NotConfiguredOutput>;
  try {
    result = await runAiTool<{ hasImage: true }, ScanOutput | NotConfiguredOutput>({
      context: input.context,
      toolName: SCAN_ID_TOOL_NAME,
      recordAs: SCAN_ID_RECORD_AS,
      legacyStatus: { succeeded: "completed", notConfigured: "skipped" },
      input: { hasImage: true },
      correlationId: input.correlationId,
      source: "image",
      execute: async (_value, ctx) => {
        const core = getAiCore();
        if (!core.isConfigured()) {
          const reason = core.config.reason ?? "not_configured";
          return { configured: false, reason, message: labelFor(reason) };
        }
        if (!parseDataUrl(input.imageDataUrl)) {
          throw new AiError("invalid_output", "La imagen debe ser una URL de datos base64 (data:<tipo>;base64,…).", { retryable: false, status: 400 });
        }
        const aiResult = await core.extractIdentityDocument(input.imageDataUrl, aiContextFor(apiToolContextFromRunner(ctx, input.context), SCAN_ID_TOOL_NAME, "extract"));
        const wrapped = fromAiResult(aiResult, (value) => ({ fields: value.fields, confidence: value.confidence }));
        if (!("output" in wrapped)) return wrapped;
        // La fila de telemetría nunca lleva los datos del documento: solo las claves leídas y su confianza.
        return { ...wrapped, record: { fieldsRead: Object.keys(wrapped.output.fields), confidence: wrapped.output.confidence } };
      }
    });
  } catch (error) {
    // Presupuesto agotado (403) y límite de peticiones (429) son denegaciones del runner:
    // el comando responde por reglas con la misma forma (la fila ya quedó registrada).
    if (isBudgetDenial(error) || error instanceof TooManyRequestsError) return manualBecause(error.message);
    throw error;
  }

  if (result.status === "executed") {
    if (result.configured) {
      const output = result.output as ScanOutput;
      return { configured: true, fields: output.fields, source: "ai" };
    }
    const reason = (result.output as NotConfiguredOutput | undefined)?.reason;
    return manual(reason === "refusal" ? SCAN_UNAVAILABLE_MESSAGE : SCAN_NOT_CONFIGURED_MESSAGE);
  }
  if (result.status === "awaiting_confirmation") return manual(SCAN_PENDING_MESSAGE);
  if (PROVIDER_FAILURE_CODES.has(result.reason)) return manual(SCAN_UNAVAILABLE_MESSAGE);
  return manualBecause(result.message);
}
