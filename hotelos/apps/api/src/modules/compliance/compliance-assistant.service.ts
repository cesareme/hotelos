// Compliance AI assistant — turns the live compliance picture into a prioritized
// list of "next best actions" and a short executive narrative.
//
// HONESTY: the suggestion list is always DETERMINISTIC and grounded in real data
// (applicable controls, their status, dates and documents on file). The narrative
// is enriched by the LLM only when a provider is configured; otherwise a
// rules-based narrative is returned. Every response declares its `narrativeSource`
// ("ai" | "rules") so the UI can label it truthfully.
//
// Tanda L6a (lote 4): la llamada al modelo pasa por el tool runner (runAiTool →
// ai-core): summarizeComplianceStatus para la narrativa y extractIncomingDocumentFields
// para las fechas por OCR. El runner evalúa las puertas (aiEnabled, módulo, permisos,
// matriz de riesgo, gate, presupuesto) y registra la telemetría; una denegación mantiene
// la narrativa por reglas (`narrativeSource: "rules"`) con la misma forma de respuesta.
// Ambas funciones aceptan el contexto del usuario como segundo argumento opcional
// (server.ts:5782 y :5787 todavía llaman solo con propertyId / imageDataUrl; sin
// contexto no hay runner y, por tanto, no se llama al modelo).
import { parseDataUrl } from "@hotelos/ai-core";
import type { JsonSchema } from "@hotelos/ai-core";
import { getAiCore } from "../../lib/ai-client.js";
import type { UserContext } from "../../lib/demo-store.js";
import { ForbiddenError, TooManyRequestsError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { isLlmConfigured, llmProviderName } from "../../lib/llm.js";
import { runAiTool } from "../ai-operations/tool-runner.service.js";
import { aiContextFor, apiToolContextFromRunner, fromAiResult } from "../ai-operations/tools/context.js";
import type { NotConfiguredOutput } from "../ai-operations/tools/context.js";
import { getComplianceCenter } from "./compliance-center.service.js";

/** Contexto opcional para que la llamada al modelo pase por el tool runner. */
export type ComplianceAiOptions = { context?: UserContext; correlationId?: string };

function isRunnerDenial(error: unknown): boolean {
  if (error instanceof TooManyRequestsError) return true;
  return error instanceof ForbiddenError && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "AI_BUDGET_EXCEEDED";
}

export type SuggestionKind = "MISSING_DOCUMENT" | "RENEW" | "CORRECT" | "REVIEW";
export type SuggestionPriority = "HIGH" | "MEDIUM" | "LOW";

export type ComplianceSuggestion = {
  id: string;
  kind: SuggestionKind;
  priority: SuggestionPriority;
  requirementCode: string;
  controlTitle: string;
  areaName: string;
  action: string;
  taskTitle: string;
  taskPriority: SuggestionPriority;
};

const PRIO_RANK: Record<SuggestionPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const NARRATIVE_SYSTEM =
  "Eres un asesor de cumplimiento normativo de hoteles en España. Responde en español, en 3-4 frases, tono claro y accionable. No inventes obligaciones; usa solo los datos proporcionados.";

export async function getComplianceAssistant(propertyId: string, options: ComplianceAiOptions = {}) {
  const center = await getComplianceCenter(propertyId);
  const suggestions: ComplianceSuggestion[] = [];

  for (const raw of center.controls) {
    if (!raw.applies) continue;
    const c = { code: raw.code, title: raw.title, areaName: raw.areaName };
    const critical = raw.riskLevel === "CRITICAL";
    const high = raw.riskLevel === "HIGH";
    if (raw.status === "EXPIRED") {
      suggestions.push(mk("RENEW", critical ? "HIGH" : "MEDIUM", c, `Renueva «${c.title}»: el documento está caducado${raw.expiryDate ? ` desde ${fmt(raw.expiryDate)}` : ""}.`, `Renovar ${c.title}`));
    } else if (raw.status === "EXPIRING_SOON") {
      suggestions.push(mk("RENEW", critical ? "HIGH" : "MEDIUM", c, `Programa la renovación de «${c.title}» antes de su caducidad${raw.expiryDate ? ` (${fmt(raw.expiryDate)})` : ""}.`, `Renovar ${c.title}`));
    } else if (raw.status === "NON_COMPLIANT") {
      suggestions.push(mk("CORRECT", critical ? "HIGH" : "MEDIUM", c, raw.correctiveAction?.trim() || `Define y ejecuta la acción correctiva para «${c.title}».`, `Corregir ${c.title}`));
    }
    if (raw.requiredDocuments.length && raw.documentsCount === 0 && raw.status !== "NOT_APPLICABLE") {
      suggestions.push(mk("MISSING_DOCUMENT", critical ? "HIGH" : high ? "MEDIUM" : "LOW", c, `Registra el documento que justifica «${c.title}»: ${raw.requiredDocuments.join(", ")}.`, `Conseguir documento: ${c.title}`));
    } else if (raw.status === "PENDING") {
      suggestions.push(mk("REVIEW", critical ? "MEDIUM" : "LOW", c, `Revisa «${c.title}» y actualiza su estado cuando esté resuelto.`, `Revisar ${c.title}`));
    }
  }

  // de-duplicate by id, sort by priority then critical-first already encoded
  const seen = new Set<string>();
  const unique = suggestions.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  unique.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
  const top = unique.slice(0, 40);

  const k = center.kpis;
  let narrative = rulesNarrative(k, top);
  let narrativeSource: "ai" | "rules" = "rules";
  if (isLlmConfigured() && options.context) {
    const context: UserContext = { ...options.context, propertyId };
    const correlationId = options.correlationId ?? createId("corr");
    try {
      const result = await runAiTool<{ propertyId: string; suggestions: number }, { text: string } | NotConfiguredOutput>({
        context,
        toolName: "summarizeComplianceStatus",
        input: { propertyId, suggestions: top.length },
        correlationId,
        execute: async (_value, ctx) => {
          // temperature: ai-core la reenvía solo a los modelos con sampling (Haiku 4.5) y la descarta en Sonnet 5.
          const aiResult = await getAiCore().complete(
            { system: NARRATIVE_SYSTEM, prompt: buildPrompt(k, top), maxTokens: 320 },
            aiContextFor(apiToolContextFromRunner(ctx, context), "summarizeComplianceStatus", "complete"),
            { temperature: 0.3 }
          );
          return fromAiResult(aiResult, (value) => ({ text: value.text.trim() }));
        }
      });
      if (result.status === "executed" && result.configured && (result.output as { text: string }).text) {
        narrative = (result.output as { text: string }).text;
        narrativeSource = "ai";
      } else if (result.status === "denied") {
        console.warn("[compliance.assistant] runner denied the model call, rules fallback", { propertyId, reason: result.reason, correlationId });
      }
    } catch (err) {
      // Presupuesto agotado / límite de peticiones (denegación tipada del runner) y cualquier otro
      // fallo mantienen la narrativa por reglas (narrativeSource "rules"); el fallo se registra
      // para que un proveedor caído sea visible. La fila de telemetría ya la escribió el runner.
      console.warn("[compliance.assistant] llm failed, rules fallback", {
        propertyId,
        denied: isRunnerDenial(err),
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else if (isLlmConfigured()) {
    console.warn("[compliance.assistant] sin contexto de usuario: la narrativa se genera por reglas (pase { context } para usar el tool runner)", { propertyId });
  }

  const byPriority = top.reduce<Record<string, number>>((acc, s) => { acc[s.priority] = (acc[s.priority] ?? 0) + 1; return acc; }, {});
  return {
    propertyId,
    generatedAt: new Date().toISOString(),
    provider: llmProviderName(),
    narrativeSource,
    narrative,
    count: top.length,
    byPriority,
    suggestions: top
  };
}

function mk(kind: SuggestionKind, priority: SuggestionPriority, c: { code: string; title: string; areaName: string }, action: string, taskTitle: string): ComplianceSuggestion {
  return { id: `${kind}-${c.code}`, kind, priority, requirementCode: c.code, controlTitle: c.title, areaName: c.areaName, action, taskTitle, taskPriority: priority };
}

function fmt(v: string | Date): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-ES");
}

function rulesNarrative(k: { compliancePct: number; applicable: number; criticalOpen: number; expired: number; expiringSoon: number; nonCompliant: number }, top: ComplianceSuggestion[]): string {
  const parts: string[] = [];
  parts.push(`El nivel de cumplimiento es del ${k.compliancePct}% sobre ${k.applicable} obligaciones aplicables.`);
  if (k.criticalOpen > 0) parts.push(`Hay ${k.criticalOpen} control(es) crítico(s) sin resolver: priorízalos.`);
  if (k.expired > 0) parts.push(`${k.expired} documento(s) están caducados y deben renovarse de inmediato.`);
  if (k.expiringSoon > 0) parts.push(`${k.expiringSoon} vencerán pronto; conviene programar su renovación.`);
  if (k.nonCompliant > 0) parts.push(`${k.nonCompliant} control(es) figuran como no conformes.`);
  if (top[0]) parts.push(`Acción recomendada ahora: ${top[0].action}`);
  if (parts.length === 1) parts.push("No hay acciones urgentes pendientes.");
  return parts.join(" ");
}

function buildPrompt(k: { compliancePct: number; applicable: number; criticalOpen: number; expired: number; expiringSoon: number; nonCompliant: number; pending: number }, top: ComplianceSuggestion[]): string {
  const lines = top.slice(0, 12).map((s) => `- [${s.priority}] ${s.kind}: ${s.action}`);
  return [
    `Datos de cumplimiento del hotel:`,
    `- Cumplimiento: ${k.compliancePct}% de ${k.applicable} obligaciones aplicables`,
    `- Críticos abiertos: ${k.criticalOpen} · Vencidos: ${k.expired} · Vencen pronto: ${k.expiringSoon} · No cumple: ${k.nonCompliant} · Pendientes: ${k.pending}`,
    `Acciones detectadas (no inventes otras):`,
    ...lines,
    ``,
    `Redacta un resumen ejecutivo breve (3-4 frases) que priorice qué hacer primero y por qué, basándote únicamente en estos datos.`
  ].join("\n");
}

// --- OCR: read issue/expiry dates off a document image ----------------------
const DATE_OCR_INSTRUCTION =
  "Eres un extractor de datos de documentos de cumplimiento de un hotel (licencias, certificados, pólizas, " +
  "actas de revisión, contratos). Lee el documento de la imagen y devuelve EXCLUSIVAMENTE un objeto JSON válido, " +
  "sin texto adicional, con estas claves cuando aparezcan: documentType (descripción corta del tipo de documento), " +
  "issuingAuthority (organismo o empresa emisora), issueDate (fecha de emisión, formato YYYY-MM-DD), " +
  "expiryDate (fecha de caducidad o próxima revisión, formato YYYY-MM-DD). Omite las claves que no puedas leer con seguridad. No inventes datos.";

const DATE_FIELD_KEYS = ["documentType", "issuingAuthority", "issueDate", "expiryDate"] as const;

/** Salida estructurada de las fechas (todas las claves presentes, nulas si no se leen). */
const DATE_OCR_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [...DATE_FIELD_KEYS],
  properties: Object.fromEntries(DATE_FIELD_KEYS.map((key) => [key, { anyOf: [{ type: "string" }, { type: "null" }] }]))
};

export type ComplianceDocumentDates = {
  aiGenerated: boolean;
  provider: string;
  model?: string;
  reason?: string;
  fields: Record<string, string | undefined>;
};

export async function extractComplianceDocumentDates(imageDataUrl: string, options: ComplianceAiOptions = {}): Promise<ComplianceDocumentDates> {
  const core = getAiCore();
  if (!core.isConfigured()) {
    return { aiGenerated: false, provider: llmProviderName(), reason: core.config.reason ?? "not_configured", fields: {} };
  }
  const image = parseDataUrl(imageDataUrl);
  if (!image) {
    // Misma respuesta que el envoltorio lib/llm.ts ante una imagen que no es una URL de datos.
    return { aiGenerated: false, provider: llmProviderName(), reason: "invalid_image", fields: {} };
  }
  if (!options.context) {
    console.warn("[compliance.assistant] sin contexto de usuario: el OCR de fechas no se ejecuta (pase { context } para usar el tool runner)");
    return { aiGenerated: false, provider: llmProviderName(), reason: "context_required", fields: {} };
  }
  const context = options.context;
  type DatesOutput = { data: Record<string, unknown>; model: string };
  try {
    const result = await runAiTool<{ hasImage: true }, DatesOutput | NotConfiguredOutput>({
      context,
      toolName: "extractIncomingDocumentFields",
      input: { hasImage: true },
      correlationId: options.correlationId ?? createId("corr"),
      source: "image",
      execute: async (_value, ctx) => {
        const aiResult = await core.extractFromDocument<Record<string, unknown>>(
          { pages: [{ mediaType: image.mediaType, base64: image.base64 }], schema: DATE_OCR_SCHEMA, instruction: DATE_OCR_INSTRUCTION, maxTokens: 400 },
          aiContextFor(apiToolContextFromRunner(ctx, context), "extractIncomingDocumentFields", "extract"),
          // CFC-08: visión sobre un documento → timeout de documentos (120 s), no el de texto (20 s).
          { timeoutMs: core.config.documentTimeoutMs }
        );
        const wrapped = fromAiResult(aiResult, (value) => ({ data: value.data, model: value.model }));
        if (!("output" in wrapped)) return wrapped;
        // La imagen y los valores leídos no se persisten: solo las claves con dato.
        return { ...wrapped, record: { fieldsRead: Object.keys(wrapped.output.data).filter((key) => typeof wrapped.output.data[key] === "string"), pages: 1 } };
      }
    });
    if (result.status === "executed" && result.configured) {
      const output = result.output as DatesOutput;
      const pick = (key: string): string | undefined => {
        const v = output.data[key];
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      };
      return {
        aiGenerated: true,
        provider: llmProviderName(),
        model: output.model,
        fields: {
          documentType: pick("documentType"),
          issuingAuthority: pick("issuingAuthority"),
          issueDate: pick("issueDate"),
          expiryDate: pick("expiryDate")
        }
      };
    }
    if (result.status === "executed") {
      return { aiGenerated: false, provider: llmProviderName(), reason: (result.output as NotConfiguredOutput | undefined)?.reason ?? "not_configured", fields: {} };
    }
    return { aiGenerated: false, provider: llmProviderName(), reason: result.status === "denied" ? result.reason : "awaiting_confirmation", fields: {} };
  } catch (error) {
    if (isRunnerDenial(error)) {
      return { aiGenerated: false, provider: llmProviderName(), reason: error instanceof TooManyRequestsError ? "rate_limited" : "budget_exceeded", fields: {} };
    }
    throw error;
  }
}
