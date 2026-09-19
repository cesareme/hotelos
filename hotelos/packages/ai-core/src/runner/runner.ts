// Tool runner con HITL (Tanda L6a, lote 3). Puro: recibe los ports y nunca
// toca Prisma ni la red. Cadena de puertas (evaluateToolGates), en este orden:
//   1. definición del registro (alias legado resuelto; desconocida → tool_unknown)
//   2. canExecuteToolForModules (módulo apagado → module_disabled; permiso → missing_permission)
//   3. PropertyAiSetting.aiEnabled (false → ai_disabled_for_property)
//   4. PropertyAiToolSetting (enabled false o nivel off → tool_disabled); nivel efectivo
//      = herramienta ?? propiedad, normalizado
//   5. evaluateAiSafetyForTool (matriz de riesgo por clave mapeada; rechazo firme → safety)
//   6. evaluatePolicyGate (vocabulario del gate)
//   7. presupuesto mensual (gasto del mes ≥ presupuesto → budget_exceeded)
//   8. modo: effect "write" → SIEMPRE awaiting_confirmation (WRITE_ALWAYS_CONFIRMS);
//      effect "read" → executed si nada exige confirmación/aprobación; si no, awaiting.
// runTool registra en TODAS las ramas (ports.recordToolCall + ports.audit con
// actorType "ai"). Solo el runner registra telemetría (riesgo 7 del recon):
// los adaptadores devuelven la telemetría y aquí se persiste una sola vez.
//
// Corrección 1 (2026-09-18):
//   · SEC-06 inputJson/outputJson pasan por redactForTelemetry (sin bytes NI PII:
//     marcadores sin mapa). Solo la fila awaiting_confirmation conserva la entrada
//     ejecutable (la persona debe ver la propuesta real); confirmTool la sustituye
//     por la copia redactada al cerrarla.
//   · SEC-08 el gate con requiresConfirmation=true también detiene las lecturas.
//   · CFC-02 un AiError con `telemetry` (invalid_output/truncated tras una respuesta
//     facturada) persiste modelo, tokens y coste en la fila failed.
//   · SEC-02/03/04 confirmTool: transición de estado condicional (reclamación),
//     misma propiedad que la fila, caducidad (24 h), re-evaluación de aiEnabled /
//     ajuste por herramienta / presupuesto y rol de aprobación exigido.

import { evaluateAiSafetyForTool } from "@hotelos/ai-tools";
import type { RiskLevel } from "@hotelos/shared";

import { AiError, isAiError } from "../errors.js";
import type { AiErrorCode } from "../errors.js";
import { labelFor } from "../labels.js";
import { telemetryFromAiResult } from "../messages.js";
import type { AiResult, AiTelemetry } from "../messages.js";
import { createPiiRedactor, redactDeep } from "../redaction.js";
import type { PiiRedactor } from "../redaction.js";
import { normalizeAutomationLevel, toGateLevel } from "./automation.js";
import type { AutomationLevel } from "./automation.js";
import { budgetStatus } from "./budget.js";
import type { ToolCallStatus } from "./status.js";
import { canonicalToolName } from "./tool-names.js";
import type {
  ConfirmToolInput,
  ConfirmToolResult,
  DenyReason,
  JsonValue,
  RecordToolCallInput,
  RunnerContext,
  RunnerPorts,
  RunnerToolDefinition,
  RunToolInput,
  StoredToolCall,
  ToolCallGuard,
  ToolGateDecision,
  ToolRunResult
} from "./types.js";

/**
 * Las escrituras (effect "write") quedan SIEMPRE en awaiting_confirmation aunque el nivel
 * efectivo sea autonomous: la ejecución autónoma de escrituras es decisión del propietario (L6b).
 */
export const WRITE_ALWAYS_CONFIRMS = true;

/** Permiso adicional para confirmar llamadas high | critical (packages/shared/src/types.ts:82). */
export const HIGH_RISK_CONFIRM_PERMISSION = "ai.high_risk.confirm" as const;

export const TOOL_CALL_NOT_FOUND_MESSAGE = "Llamada de herramienta no encontrada.";

/** Caducidad de una fila awaiting_confirmation (misma ventana que AiPendingConfirmation del check-in L2). */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
export const CONFIRMATION_EXPIRED_MESSAGE = "La confirmación ha caducado (24 h): solicite la acción de nuevo.";

const HIGH_RISK: readonly RiskLevel[] = ["high", "critical"];
const MAX_ERROR_MESSAGE = 500;
const MAX_TELEMETRY_STRING = 2_000;

// --- Utilidades ---------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Like(value: string): boolean {
  return value.length > MAX_TELEMETRY_STRING && /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

/**
 * Copia serializable de un valor sin bytes ni base64 (inputJson/outputJson nunca llevan
 * imágenes ni PDF): las URLs de datos y las cadenas base64 largas se sustituyen por un
 * marcador con el tamaño; los Buffer/Uint8Array por su longitud; las cadenas muy largas se
 * recortan. Nunca lanza.
 */
export function sanitizeForTelemetry(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const dataUrl = /^data:([^;,]+);base64,/.exec(value);
    if (dataUrl) return `data:${dataUrl[1]};base64,<omitido ${value.length - dataUrl[0].length} caracteres>`;
    if (isBase64Like(value)) return `<base64 omitido, ${value.length} caracteres>`;
    return value.length > MAX_TELEMETRY_STRING * 4 ? `${value.slice(0, MAX_TELEMETRY_STRING * 4)}…<recortado, ${value.length} caracteres>` : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) return { bytes: (value as Uint8Array).byteLength };
  if (depth > 12) return "<profundidad excedida>";
  if (Array.isArray(value)) return value.map((item) => sanitizeForTelemetry(item, depth + 1));
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "function" || item === undefined) continue;
      out[key] = sanitizeForTelemetry(item, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Copia serializable SIN bytes ni PII para inputJson/outputJson (SEC-06): tras sanitizeForTelemetry,
 * cada cadena pasa por el redactor (marcadores [NOMBRE_n], [TEL_n]… sin mapa: irreversible a propósito).
 * Si el redactor fallara, la fila lleva un marcador en lugar del dato (nunca PII en crudo).
 */
export function redactForTelemetry(value: unknown, redactor: PiiRedactor = createPiiRedactor()): JsonValue {
  const sanitized = sanitizeForTelemetry(value);
  try {
    return redactDeep(sanitized, redactor);
  } catch {
    return "<sin telemetría: la redacción de PII falló>";
  }
}

function looksLikeAiResult(value: unknown): value is AiResult<unknown> {
  return isRecord(value) && typeof value.configured === "boolean";
}

export type UnwrappedExecuteResult<T> = {
  output: T;
  telemetry: AiTelemetry | null;
  record: JsonValue | undefined;
  /** Presente cuando la herramienta no pudo llamar al modelo (configured:false sin telemetría). */
  notConfigured: { reason: string; message: string } | null;
  /** Presente cuando el modelo respondió pero rechazó (configured:false con telemetría). */
  refused: { reason: string; message: string } | null;
};

/** Interpreta lo que devuelve un `execute` (desnudo o envuelto en { output, telemetry, record }). */
export function unwrapExecuteResult<T>(raw: unknown): UnwrappedExecuteResult<T> {
  let output: unknown = raw;
  let telemetry: AiTelemetry | null | undefined;
  let record: JsonValue | undefined;
  if (isRecord(raw) && "output" in raw && !("configured" in raw)) {
    output = raw.output;
    telemetry = raw.telemetry as AiTelemetry | null | undefined;
    record = raw.record as JsonValue | undefined;
  }
  if (telemetry === undefined && looksLikeAiResult(output)) telemetry = telemetryFromAiResult(output);
  const base = { output: output as T, telemetry: telemetry ?? null, record };
  if (isRecord(output) && output.configured === false) {
    const reason = typeof output.reason === "string" && output.reason ? output.reason : "not_configured";
    const message = typeof output.message === "string" && output.message ? output.message : labelFor(reason as AiErrorCode);
    if (telemetry) return { ...base, notConfigured: null, refused: { reason, message } };
    return { ...base, notConfigured: { reason, message }, refused: null };
  }
  return { ...base, notConfigured: null, refused: null };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

/** Campos de telemetría de la fila: sin llamada al modelo → tokens 0 y coste 0 (real, no fabricado). */
function telemetryColumns(telemetry: AiTelemetry | null, calledModel: boolean): Pick<RecordToolCallInput, "model" | "tokensInput" | "tokensOutput" | "costEur"> {
  if (!telemetry) return calledModel ? {} : { tokensInput: 0, tokensOutput: 0, costEur: 0 };
  return {
    model: telemetry.model,
    tokensInput: telemetry.tokensInput,
    tokensOutput: telemetry.tokensOutput,
    ...(telemetry.costEur !== null && telemetry.costEur !== undefined ? { costEur: telemetry.costEur } : {})
  };
}

function usageJson(telemetry: AiTelemetry | null): JsonValue {
  if (!telemetry) return null;
  return {
    model: telemetry.model,
    tokensInput: telemetry.tokensInput,
    tokensOutput: telemetry.tokensOutput,
    cacheReadTokens: telemetry.cacheReadTokens,
    costUsd: telemetry.costUsd,
    costEur: telemetry.costEur,
    latencyMs: telemetry.latencyMs
  };
}

function deny(base: { toolName: string; definition: RunnerToolDefinition | null; automationLevel: AutomationLevel | null }, reason: DenyReason, message: string, riskLevel: RiskLevel, details?: Record<string, unknown>): ToolGateDecision {
  return { mode: "deny", toolName: base.toolName, reason, message, riskLevel, definition: base.definition, automationLevel: base.automationLevel, ...(details ? { details } : {}) };
}

// --- Puertas -----------------------------------------------------------------------------

export async function evaluateToolGates(input: {
  toolName: string;
  ctx: RunnerContext;
  facts?: RunToolInput["facts"];
  confidence?: number;
  ports: RunnerPorts;
}): Promise<ToolGateDecision> {
  const { ctx, ports } = input;
  const toolName = canonicalToolName(input.toolName);
  const base = { toolName, definition: null as RunnerToolDefinition | null, automationLevel: null as AutomationLevel | null };

  // 1. Definición
  const definition = ports.getDefinition(toolName);
  if (!definition) return deny(base, "tool_unknown", `${labelFor("tool_unknown")}: ${toolName}.`, "medium");
  base.definition = definition;

  // 2. Módulo activo y permisos del usuario
  const gate = ports.canExecute({ toolName, enabledModules: ctx.enabledModules, userPermissions: ctx.permissions });
  if (!gate.allowed) {
    const moduleOff = /^Module\b/i.test(gate.reason);
    return deny(
      base,
      moduleOff ? "module_disabled" : "missing_permission",
      moduleOff ? `El módulo ${definition.moduleCode} no está activo en esta propiedad.` : `Faltan permisos para ejecutar ${toolName}.`,
      definition.riskLevel,
      { reason: gate.reason }
    );
  }

  // 3. Interruptor de IA de la propiedad
  const property = await ports.getPropertySetting(ctx.propertyId);
  if (!property.aiEnabled) return deny(base, "ai_disabled_for_property", `${labelFor("ai_disabled_for_property")}.`, definition.riskLevel);

  // 4. Ajuste por herramienta y nivel efectivo
  const toolSetting = await ports.getToolSetting(ctx.propertyId, toolName);
  if (toolSetting && !toolSetting.enabled) return deny(base, "tool_disabled", `La herramienta ${toolName} está desactivada en esta propiedad.`, definition.riskLevel);
  const automationLevel = normalizeAutomationLevel(toolSetting?.automationLevel ?? property.defaultAutomationLevel);
  base.automationLevel = automationLevel;
  if (automationLevel === "off") return deny(base, "tool_disabled", `La automatización de ${toolName} está apagada (nivel off).`, definition.riskLevel);

  // 5. Seguridad (matriz de riesgo por clave mapeada; nunca lanza)
  const safety = evaluateAiSafetyForTool({ toolName, definition, permissions: ctx.permissions, facts: input.facts });
  if (safety.denied) return deny(base, "safety", safety.reason ?? "La política de seguridad de IA bloquea esta acción.", safety.riskLevel, { riskKey: safety.riskKey });

  // 6. Gate de gobernanza (vocabulario normalizado)
  const policy = await ports.evaluatePolicyGate({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    toolRiskLevel: definition.riskLevel,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    automationLevel: toGateLevel(automationLevel)
  });

  // 7. Presupuesto mensual
  const spentEur = await ports.monthToDateCostEur(ctx.propertyId, ctx.organizationId);
  const budget = budgetStatus(spentEur, property.monthlyBudgetEur);
  if (budget.exceeded) {
    return deny(base, "budget_exceeded", `${labelFor("budget_exceeded")} (${budget.spentEur.toFixed(2)} € de ${(budget.budgetEur ?? 0).toFixed(2)} €).`, definition.riskLevel, {
      budgetEur: budget.budgetEur,
      spentEur: budget.spentEur,
      propertyId: ctx.propertyId
    });
  }

  // 8. Modo
  const requiresApprovalRole = safety.requiredApproval ?? toolSetting?.requiresApprovalRole ?? undefined;
  const reasons = [...policy.reasons];
  if (safety.reason) reasons.push(safety.reason);
  const requiresHumanReview = policy.requiresHumanReview || HIGH_RISK.includes(definition.riskLevel);
  const common = { toolName, definition, automationLevel, safety, gate: policy, budget: { budgetEur: budget.budgetEur, spentEur: budget.spentEur }, reasons, requiresHumanReview };

  if (definition.effect === "write" && WRITE_ALWAYS_CONFIRMS) {
    reasons.push("Las escrituras siempre requieren confirmación de una persona.");
    return { mode: "confirm", ...common, requiredConfirmation: true, ...(requiresApprovalRole ? { requiresApprovalRole } : {}) };
  }

  // Lecturas (consultas, borradores, clasificaciones): no mutan el dominio, así que se ejecutan al
  // instante salvo que el gate las bloquee o pida confirmación (SEC-08: política de confianza
  // mínima, revisión humana de alto riesgo) o exijan aprobación de un rol. `safety.allowed:false`
  // con requiresConfirmation (matriz «confirmar antes de usar») no las detiene: la persona revisa el
  // borrador después (required_confirmation = definición.requiresConfirmation en la fila).
  const mustConfirm = policy.allowed === false || policy.requiresConfirmation || requiresApprovalRole !== undefined;
  if (mustConfirm) {
    return { mode: "confirm", ...common, requiredConfirmation: true, ...(requiresApprovalRole ? { requiresApprovalRole } : {}) };
  }
  return { mode: "execute", ...common, requiredConfirmation: definition.requiresConfirmation };
}

// --- runTool -----------------------------------------------------------------------------

export async function runTool<I = unknown, O = unknown>(input: RunToolInput<I, O>): Promise<ToolRunResult<O>> {
  const { ctx, ports } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const decision = await evaluateToolGates({ toolName: input.toolName, ctx, ...(input.facts ? { facts: input.facts } : {}), ...(input.confidence !== undefined ? { confidence: input.confidence } : {}), ports });
  const recordName = input.recordAs ?? decision.toolName;
  // SEC-06: la fila lleva la entrada redactada; solo la pendiente conserva la ejecutable (inputJsonRaw).
  // Un único redactor por fila: lo aprendido en la entrada (p. ej. «Sra. X») se aplica también a la salida.
  const redactor = createPiiRedactor();
  const inputJsonRaw = sanitizeForTelemetry(input.input);
  const inputJson = redactForTelemetry(input.input, redactor);
  const rowBase: Omit<RecordToolCallInput, "status" | "inputJson" | "toolName"> = {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    userId: ctx.userId,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {})
  };
  const auditBase = { organizationId: ctx.organizationId, propertyId: ctx.propertyId, actorUserId: ctx.userId, entityType: "ai_tool_call" as const, correlationId: ctx.correlationId };

  const denied = async (reason: DenyReason, message: string, riskLevel: RiskLevel, meta: { definition: RunnerToolDefinition | null; automationLevel: AutomationLevel | null; details?: Record<string, unknown>; status?: ToolCallStatus }): Promise<ToolRunResult<O>> => {
    const row = await ports.recordToolCall({
      ...rowBase,
      toolName: recordName,
      status: meta.status ?? "rejected",
      inputJson,
      outputJson: { denied: { reason, message, riskLevel, ...(meta.details ? { details: redactForTelemetry(meta.details, redactor) } : {}) } },
      requiredConfirmation: meta.definition?.requiresConfirmation ?? false,
      ...(meta.automationLevel ? { automationLevel: meta.automationLevel } : {}),
      latencyMs: Math.max(0, now() - startedAt),
      errorMessage: reason,
      ...telemetryColumns(null, false)
    });
    await ports.audit({ ...auditBase, actorType: "ai", action: "AI_TOOL_DENIED", entityId: row.id, afterJson: { toolName: decision.toolName, recordedAs: recordName, reason, message, riskLevel } });
    return { status: "denied", toolCallId: row.id, reason, message, riskLevel, ...(meta.details ? { details: meta.details } : {}) };
  };

  if (decision.mode === "deny") {
    return denied(decision.reason, decision.message, decision.riskLevel, { definition: decision.definition, automationLevel: decision.automationLevel, ...(decision.details ? { details: decision.details } : {}) });
  }

  const { definition, automationLevel } = decision;

  if (!input.execute) {
    return denied("tool_not_implemented", `${labelFor("tool_not_implemented")}: ${decision.toolName}.`, definition.riskLevel, { definition, automationLevel });
  }

  if (decision.mode === "confirm") {
    let proposal: JsonValue | undefined;
    if (input.preview) {
      const previewed = await input.preview(input.input, ctx);
      proposal = previewed === undefined ? undefined : sanitizeForTelemetry(previewed);
    }
    const row = await ports.recordToolCall({
      ...rowBase,
      toolName: recordName,
      status: "awaiting_confirmation",
      inputJson: inputJsonRaw,
      outputJson: {
        proposal: proposal ?? null,
        effect: definition.effect,
        gate: { allowed: decision.gate.allowed, requiresHumanReview: decision.requiresHumanReview, reasons: decision.reasons },
        safety: { riskKey: decision.safety.riskKey, allowed: decision.safety.allowed, reason: decision.safety.reason ?? null },
        requiresApprovalRole: decision.requiresApprovalRole ?? null
      },
      requiredConfirmation: true,
      automationLevel,
      latencyMs: Math.max(0, now() - startedAt),
      ...telemetryColumns(null, false)
    });
    if (decision.requiresHumanReview) {
      await ports.enqueueReview({
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyId,
        reviewType: "ai_tool_call",
        relatedEntityType: "ai_tool_call",
        relatedEntityId: row.id,
        payloadJson: { toolName: decision.toolName, riskLevel: definition.riskLevel, proposal: proposal ?? null, ...(decision.requiresApprovalRole ? { requiresApprovalRole: decision.requiresApprovalRole } : {}) },
        correlationId: ctx.correlationId,
        actorUserId: ctx.userId
      });
    }
    await ports.audit({
      ...auditBase,
      actorType: "ai",
      action: "AI_TOOL_CONFIRMATION_REQUESTED",
      entityId: row.id,
      afterJson: { toolName: decision.toolName, recordedAs: recordName, riskLevel: definition.riskLevel, effect: definition.effect, automationLevel, requiresHumanReview: decision.requiresHumanReview, requiresApprovalRole: decision.requiresApprovalRole ?? null }
    });
    return { status: "awaiting_confirmation", toolCallId: row.id, ...(proposal !== undefined ? { preview: proposal } : {}), ...(decision.requiresApprovalRole ? { requiresApprovalRole: decision.requiresApprovalRole } : {}) };
  }

  // mode === "execute"
  let raw: unknown;
  try {
    raw = await input.execute(input.input, ctx);
  } catch (error) {
    const aiError = isAiError(error) ? error : null;
    const errorMessage = aiError ? `${aiError.code}: ${errorText(aiError)}` : errorText(error);
    // CFC-02: el error puede llevar la telemetría de una respuesta ya facturada (invalid_output, truncated).
    const failedTelemetry = aiError?.telemetry ?? null;
    const row = await ports.recordToolCall({
      ...rowBase,
      toolName: recordName,
      status: "failed",
      inputJson,
      outputJson: {
        error: { code: aiError?.code ?? "error", message: errorMessage, ...(aiError?.retryAfterMs !== undefined ? { retryAfterMs: aiError.retryAfterMs } : {}) },
        ...(failedTelemetry ? { usage: usageJson(failedTelemetry) } : {})
      },
      requiredConfirmation: decision.requiredConfirmation,
      automationLevel,
      latencyMs: Math.max(0, now() - startedAt),
      errorMessage,
      ...telemetryColumns(failedTelemetry, true)
    });
    await ports.audit({ ...auditBase, actorType: "ai", action: "AI_TOOL_FAILED", entityId: row.id, afterJson: { toolName: decision.toolName, recordedAs: recordName, code: aiError?.code ?? "error", message: errorMessage, model: failedTelemetry?.model ?? null } });
    if (!aiError) throw error;
    return {
      status: "denied",
      toolCallId: row.id,
      reason: aiError.code,
      message: aiError.message,
      riskLevel: definition.riskLevel,
      details: { ...(aiError.retryAfterMs !== undefined ? { retryAfterMs: aiError.retryAfterMs } : {}), ...(aiError.status !== undefined ? { providerStatus: aiError.status } : {}) }
    };
  }

  const unwrapped = unwrapExecuteResult<O>(raw);
  const latencyMs = Math.max(0, now() - startedAt);

  if (unwrapped.notConfigured) {
    const status = input.legacyStatus?.notConfigured ?? "skipped";
    const row = await ports.recordToolCall({
      ...rowBase,
      toolName: recordName,
      status,
      inputJson,
      outputJson: { configured: false, reason: unwrapped.notConfigured.reason, message: unwrapped.notConfigured.message },
      requiredConfirmation: decision.requiredConfirmation,
      automationLevel,
      latencyMs,
      errorMessage: unwrapped.notConfigured.reason,
      ...telemetryColumns(null, false)
    });
    await ports.audit({ ...auditBase, actorType: "ai", action: "AI_TOOL_EXECUTED", entityId: row.id, afterJson: { toolName: decision.toolName, recordedAs: recordName, status, configured: false, reason: unwrapped.notConfigured.reason } });
    return { status: "executed", toolCallId: row.id, output: unwrapped.output, configured: false };
  }

  if (unwrapped.refused) {
    const errorMessage = `${unwrapped.refused.reason}: ${unwrapped.refused.message}`;
    const row = await ports.recordToolCall({
      ...rowBase,
      toolName: recordName,
      status: "failed",
      inputJson,
      outputJson: { configured: false, reason: unwrapped.refused.reason, message: unwrapped.refused.message, usage: usageJson(unwrapped.telemetry) },
      requiredConfirmation: decision.requiredConfirmation,
      automationLevel,
      latencyMs,
      errorMessage,
      ...telemetryColumns(unwrapped.telemetry, true)
    });
    await ports.audit({ ...auditBase, actorType: "ai", action: "AI_TOOL_FAILED", entityId: row.id, afterJson: { toolName: decision.toolName, recordedAs: recordName, code: unwrapped.refused.reason, message: unwrapped.refused.message, model: unwrapped.telemetry?.model ?? null } });
    return { status: "executed", toolCallId: row.id, output: unwrapped.output, configured: false };
  }

  const status = input.legacyStatus?.succeeded ?? "succeeded";
  const row = await ports.recordToolCall({
    ...rowBase,
    toolName: recordName,
    status,
    inputJson,
    outputJson: { output: redactForTelemetry(unwrapped.record ?? unwrapped.output, redactor), usage: usageJson(unwrapped.telemetry) },
    requiredConfirmation: decision.requiredConfirmation,
    automationLevel,
    latencyMs,
    ...telemetryColumns(unwrapped.telemetry, false)
  });
  await ports.audit({
    ...auditBase,
    actorType: "ai",
    action: "AI_TOOL_EXECUTED",
    entityId: row.id,
    afterJson: { toolName: decision.toolName, recordedAs: recordName, status, configured: true, effect: definition.effect, automationLevel, model: unwrapped.telemetry?.model ?? null, costEur: unwrapped.telemetry?.costEur ?? (unwrapped.telemetry ? null : 0) }
  });
  return { status: "executed", toolCallId: row.id, output: unwrapped.output, configured: true };
}

// --- confirmTool -----------------------------------------------------------------------

function notFound(): AiError {
  return new AiError("tool_unknown", TOOL_CALL_NOT_FOUND_MESSAGE, { retryable: false, status: 404 });
}

function createdAtMs(row: StoredToolCall): number | null {
  const raw = row.createdAt;
  if (raw === null || raw === undefined) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/** true si la escritura condicional cambió una fila (el port debe devolver { count }). */
function claimed(result: unknown): boolean {
  return isRecord(result) && typeof result.count === "number" && result.count > 0;
}

/**
 * Decisión humana sobre una fila awaiting_confirmation. Orden: carga y ámbito (organización Y
 * propiedad, SEC-03) → caducidad (SEC-03) → definición y permisos, incluido el rol de aprobación
 * (SEC-04) → re-evaluación de aiEnabled / ajuste por herramienta / presupuesto al confirmar
 * (SEC-03) → transición de estado CONDICIONAL que reclama la fila (SEC-02) → auditoría user →
 * ejecución con la entrada guardada y con la propiedad de la fila → cierre (inputJson y proposal
 * redactados, SEC-06) → closeReview → auditoría ai.
 */
export async function confirmTool<O = unknown>(input: ConfirmToolInput<O>): Promise<ConfirmToolResult<O>> {
  const { ctx, ports } = input;
  const now = input.now ?? Date.now;
  const row = await input.loadToolCall(input.toolCallId);
  // 404 opaco: inexistente, de otra organización, de otra propiedad, ya reclamada o que no espera confirmación.
  if (!row || row.organizationId !== ctx.organizationId || row.status !== "awaiting_confirmation") throw notFound();
  if (row.propertyId && row.propertyId !== ctx.propertyId) throw notFound();
  if (row.confirmedBy) throw notFound();

  const toolName = canonicalToolName(row.toolName);
  const definition = ports.getDefinition(toolName);
  if (!definition) throw notFound();

  const redactor = createPiiRedactor();
  const previousOutput = isRecord(row.outputJson) ? (sanitizeForTelemetry(row.outputJson) as { [key: string]: JsonValue }) : {};
  const inputJsonRedacted = redactForTelemetry(row.inputJson, redactor);
  const previousRedacted: { [key: string]: JsonValue } = { ...previousOutput, ...("proposal" in previousOutput ? { proposal: redactForTelemetry(previousOutput.proposal, redactor) } : {}) };
  const decidedAt = new Date(now()).toISOString();
  const auditBase = { organizationId: ctx.organizationId, propertyId: row.propertyId ?? ctx.propertyId, entityType: "ai_tool_call" as const, entityId: row.id, correlationId: ctx.correlationId };
  const guard: ToolCallGuard = { status: "awaiting_confirmation", unclaimed: true };

  // Caducidad: una fila pendiente no es confirmable indefinidamente (createdAt + TTL).
  const created = createdAtMs(row);
  const ttlMs = input.ttlMs ?? CONFIRMATION_TTL_MS;
  if (created !== null && now() - created > ttlMs) {
    const expired = await ports.updateToolCall(
      row.id,
      { status: "rejected", errorMessage: CONFIRMATION_EXPIRED_MESSAGE, inputJson: inputJsonRedacted, outputJson: { ...previousRedacted, confirmation: { decision: "expired", decidedAt, ttlMs } } },
      guard
    );
    if (claimed(expired)) {
      await ports.closeReview(row.id, "rejected", ctx.userId, CONFIRMATION_EXPIRED_MESSAGE);
      await ports.audit({ ...auditBase, actorType: "system", action: "AI_TOOL_CONFIRMATION_REJECTED", afterJson: { toolName, decision: "expired", ttlMs, createdAt: new Date(created).toISOString() } });
    }
    throw new AiError("confirmation_expired", CONFIRMATION_EXPIRED_MESSAGE, { retryable: false, status: 409, details: { toolCallId: row.id, ttlMs } });
  }

  // Permisos: los de la definición, ai.high_risk.confirm para high|critical y, si la fila o el ajuste por
  // herramienta exigen un rol de aprobación, ese rol (ctx.roles) o, en su defecto, ai.high_risk.confirm.
  const toolSetting = await ports.getToolSetting(ctx.propertyId, toolName);
  const rowApprovalRole = isRecord(row.outputJson) && typeof row.outputJson.requiresApprovalRole === "string" && row.outputJson.requiresApprovalRole ? row.outputJson.requiresApprovalRole : null;
  const requiresApprovalRole = rowApprovalRole ?? toolSetting?.requiresApprovalRole ?? null;
  const roleSatisfied = requiresApprovalRole === null || (ctx.roles ?? []).includes(requiresApprovalRole);
  const required = new Set(definition.requiredPermissions);
  if (HIGH_RISK.includes(definition.riskLevel) || !roleSatisfied) required.add(HIGH_RISK_CONFIRM_PERMISSION);
  const missing = [...required].filter((permission) => !ctx.permissions.includes(permission));
  if (missing.length > 0) {
    const roleNote = !roleSatisfied ? ` La herramienta exige la aprobación del rol ${requiresApprovalRole}.` : "";
    throw new AiError("tool_denied", `Faltan permisos para confirmar ${toolName}: ${missing.join(", ")}.${roleNote}`, {
      retryable: false,
      status: 403,
      details: { missing, ...(requiresApprovalRole !== null ? { requiresApprovalRole } : {}) }
    });
  }

  const decisionJson = { decision: input.decision, decidedBy: ctx.userId, decidedAt, ...(input.notes ? { notes: input.notes } : {}) };

  if (input.decision === "reject") {
    // La propia transición a rejected es la reclamación: 0 filas = otra decisión llegó antes.
    const done = await ports.updateToolCall(
      row.id,
      {
        status: "rejected",
        confirmedBy: ctx.userId,
        errorMessage: input.notes?.trim() ? `Rechazada por el usuario: ${input.notes.trim()}` : "Rechazada por el usuario.",
        inputJson: inputJsonRedacted,
        outputJson: { ...previousRedacted, confirmation: decisionJson }
      },
      guard
    );
    if (!claimed(done)) throw notFound();
    await ports.audit({ ...auditBase, actorType: "user", actorUserId: ctx.userId, action: "AI_TOOL_CONFIRMATION_REJECTED", afterJson: { toolName, ...decisionJson } });
    await ports.closeReview(row.id, "rejected", ctx.userId, input.notes);
    return { status: "rejected", toolCallId: row.id };
  }

  // Re-evaluación al confirmar: la propiedad, la herramienta o el presupuesto pueden haber cambiado.
  const property = await ports.getPropertySetting(ctx.propertyId);
  if (!property.aiEnabled) {
    throw new AiError("ai_disabled_for_property", `${labelFor("ai_disabled_for_property")}: la llamada pendiente no se puede ejecutar.`, { retryable: false, status: 403, details: { toolCallId: row.id } });
  }
  if (toolSetting && !toolSetting.enabled) {
    throw new AiError("tool_denied", `La herramienta ${toolName} está desactivada en esta propiedad.`, { retryable: false, status: 403, details: { toolCallId: row.id } });
  }
  if (normalizeAutomationLevel(toolSetting?.automationLevel ?? property.defaultAutomationLevel) === "off") {
    throw new AiError("tool_denied", `La automatización de ${toolName} está apagada (nivel off).`, { retryable: false, status: 403, details: { toolCallId: row.id } });
  }
  const spentEur = await ports.monthToDateCostEur(ctx.propertyId, ctx.organizationId);
  const budget = budgetStatus(spentEur, property.monthlyBudgetEur);
  if (budget.exceeded) {
    throw new AiError("budget_exceeded", `${labelFor("budget_exceeded")} (${budget.spentEur.toFixed(2)} € de ${(budget.budgetEur ?? 0).toFixed(2)} €).`, {
      retryable: false,
      status: 403,
      details: { budgetEur: budget.budgetEur, spentEur: budget.spentEur, propertyId: ctx.propertyId, toolCallId: row.id }
    });
  }

  // Reclamación atómica (SEC-02): solo una de dos confirmaciones concurrentes cambia la fila.
  const claim = await ports.updateToolCall(row.id, { confirmedBy: ctx.userId }, guard);
  if (!claimed(claim)) throw notFound();

  await ports.audit({ ...auditBase, actorType: "user", actorUserId: ctx.userId, action: "AI_TOOL_CONFIRMATION_APPROVED", afterJson: { toolName, ...decisionJson } });

  const startedAt = now();
  let raw: unknown;
  try {
    raw = await input.execute(row.inputJson, ctx);
  } catch (error) {
    const aiError = isAiError(error) ? error : null;
    const errorMessage = aiError ? `${aiError.code}: ${errorText(aiError)}` : errorText(error);
    const failedTelemetry = aiError?.telemetry ?? null;
    const columns = telemetryColumns(failedTelemetry, true);
    await ports.updateToolCall(row.id, {
      status: "failed",
      confirmedBy: ctx.userId,
      errorMessage,
      latencyMs: Math.max(0, now() - startedAt),
      ...(columns.model !== undefined ? { model: columns.model } : {}),
      ...(columns.tokensInput !== undefined ? { tokensInput: columns.tokensInput } : {}),
      ...(columns.tokensOutput !== undefined ? { tokensOutput: columns.tokensOutput } : {}),
      ...(columns.costEur !== undefined ? { costEur: columns.costEur } : {}),
      inputJson: inputJsonRedacted,
      outputJson: { ...previousRedacted, confirmation: decisionJson, error: { code: aiError?.code ?? "error", message: errorMessage }, ...(failedTelemetry ? { usage: usageJson(failedTelemetry) } : {}) }
    });
    await ports.closeReview(row.id, "approved", ctx.userId, input.notes);
    await ports.audit({ ...auditBase, actorType: "ai", actorUserId: ctx.userId, action: "AI_TOOL_FAILED", afterJson: { toolName, code: aiError?.code ?? "error", message: errorMessage, confirmedBy: ctx.userId, model: failedTelemetry?.model ?? null } });
    if (!aiError) throw error;
    return { status: "failed", toolCallId: row.id, reason: aiError.code, message: aiError.message };
  }

  const unwrapped = unwrapExecuteResult<O>(raw);
  const latencyMs = Math.max(0, now() - startedAt);
  const configured = !unwrapped.notConfigured && !unwrapped.refused;
  const failedReason = unwrapped.refused ?? unwrapped.notConfigured;
  const status: ToolCallStatus = failedReason ? "failed" : "succeeded";
  const columns = telemetryColumns(unwrapped.telemetry, Boolean(unwrapped.refused));
  await ports.updateToolCall(row.id, {
    status,
    confirmedBy: ctx.userId,
    latencyMs,
    ...(columns.model !== undefined ? { model: columns.model } : {}),
    ...(columns.tokensInput !== undefined ? { tokensInput: columns.tokensInput } : {}),
    ...(columns.tokensOutput !== undefined ? { tokensOutput: columns.tokensOutput } : {}),
    ...(columns.costEur !== undefined ? { costEur: columns.costEur } : {}),
    ...(failedReason ? { errorMessage: `${failedReason.reason}: ${failedReason.message}` } : { errorMessage: null }),
    inputJson: inputJsonRedacted,
    outputJson: {
      ...previousRedacted,
      confirmation: decisionJson,
      execution: failedReason ? { configured: false, reason: failedReason.reason, message: failedReason.message } : redactForTelemetry(unwrapped.record ?? unwrapped.output, redactor),
      usage: usageJson(unwrapped.telemetry)
    }
  });
  await ports.closeReview(row.id, "approved", ctx.userId, input.notes);
  await ports.audit({
    ...auditBase,
    actorType: "ai",
    actorUserId: ctx.userId,
    action: failedReason ? "AI_TOOL_FAILED" : "AI_TOOL_EXECUTED",
    afterJson: { toolName, status, configured, confirmedBy: ctx.userId, model: unwrapped.telemetry?.model ?? null, ...(failedReason ? { reason: failedReason.reason } : {}) }
  });
  if (failedReason) return { status: "failed", toolCallId: row.id, reason: failedReason.reason as AiErrorCode, message: failedReason.message };
  return { status: "succeeded", toolCallId: row.id, output: unwrapped.output, configured };
}
