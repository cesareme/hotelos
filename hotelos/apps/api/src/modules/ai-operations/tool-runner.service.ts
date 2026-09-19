// Tool runner del API (Tanda L6a, lote 3): construye los ports Prisma del
// runner puro de @hotelos/ai-core/runner sobre los servicios existentes
// (property-ai, tool settings, gobernanza, pipeline, revisión humana,
// auditoría, módulos activos) y expone dos servicios:
//   · runAiTool → ejecuta (lecturas/borradores) o deja pendiente (escrituras)
//     una herramienta del registro con las implementaciones de ./tools;
//   · confirmToolCall → decisión humana sobre una fila awaiting_confirmation
//     (la ruta POST /ai/tool-calls/:id/confirm la añade el orquestador).
// Errores tipados: presupuesto agotado → 403 AI_BUDGET_EXCEEDED; rate limit de
// ai-core → 429 AI_RATE_LIMITED con retryAfterSeconds; fila no confirmable →
// 404 opaco. Solo el runner registra telemetría y auditoría (actorType "ai").

import { AiError, isAiError } from "@hotelos/ai-core";
import { canonicalToolName, confirmTool, monthlyBudgetEurOf, runTool, TOOL_CALL_NOT_FOUND_MESSAGE } from "@hotelos/ai-core/runner";
import type {
  AuditInput,
  ConfirmToolResult,
  EnqueueReviewInput,
  LegacyStatus,
  PolicyGateDecision,
  PolicyGateInput,
  RecordToolCallInput,
  RunnerContext,
  RunnerPorts,
  RunnerToolDefinition,
  StoredToolCall,
  ToolCallGuard,
  ToolCallPatch,
  ToolExecute,
  ToolPreview,
  ToolRunResult,
  ToolSettingView
} from "@hotelos/ai-core/runner";
import { canExecuteToolForModules, TOOL_DEFINITIONS } from "@hotelos/ai-tools";
import type { AiSafetyFacts, HotelOsToolName } from "@hotelos/ai-tools";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { HotelModuleCode } from "@hotelos/product";
import type { AiSource, PermissionKey } from "@hotelos/shared";
import { getAiConfig } from "../../lib/ai-config.js";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { evaluatePolicyGate } from "./governance.service.js";
import { approveReview, enqueueReview, rejectReview } from "./human-review.service.js";
import { monthToDateCostEur, recordToolCall, updateToolCall } from "./pipeline.service.js";
import { getPropertyAiSettings } from "./property-ai.service.js";
import { AI_TOOL_IMPLEMENTATIONS, apiToolContextFromRunner, parseToolInput } from "./tools/index.js";
import type { AiToolImpl } from "./tools/index.js";

export type PropertyAiSettingsLike = { aiEnabled: boolean; defaultAutomationLevel: string; configurationJson: Record<string, unknown> };

/** Dependencias del runner del API: todas inyectables (tests sin Prisma). */
export type ToolRunnerDeps = {
  getPropertyAiSettings: (propertyId: string) => Promise<PropertyAiSettingsLike>;
  findToolSetting: (propertyId: string, toolName: string) => Promise<ToolSettingView | null>;
  evaluatePolicyGate: (input: PolicyGateInput) => Promise<PolicyGateDecision>;
  recordToolCall: (input: RecordToolCallInput) => Promise<{ id: string }>;
  /** Escritura condicional (guard) que devuelve las filas afectadas: 0 = otra confirmación la reclamó antes (SEC-02). */
  updateToolCall: (id: string, patch: ToolCallPatch, guard?: ToolCallGuard) => Promise<{ count: number }>;
  monthToDateCostEur: (input: { organizationId: string; propertyId?: string }) => Promise<number>;
  enqueueReview: (input: EnqueueReviewInput) => Promise<{ id: string }>;
  findPendingReview: (relatedEntityId: string) => Promise<{ id: string } | null>;
  approveReview: (input: { context: UserContext; id: string; userId: string; notes?: string; correlationId?: string }) => Promise<unknown>;
  rejectReview: (input: { context: UserContext; id: string; userId: string; reason: string; correlationId?: string }) => Promise<unknown>;
  recordAuditEvent: (input: AuditInput) => unknown;
  getEnabledModuleCodes: (propertyId: string) => HotelModuleCode[];
  canExecuteToolForModules: (input: { toolName: HotelOsToolName; enabledModules: HotelModuleCode[]; userPermissions: PermissionKey[] }) => { allowed: true } | { allowed: false; reason: string };
  getDefinition: (name: string) => RunnerToolDefinition | null;
  loadToolCall: (id: string) => Promise<StoredToolCall | null>;
  getImplementation: (name: string) => AiToolImpl<unknown, unknown> | null;
  monthlyBudgetEurDefault: () => number;
  now: () => number;
};

function toJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined || value === null ? {} : value) as Prisma.InputJsonValue;
}

function mapStoredToolCall(row: { id: string; organizationId: string; propertyId: string | null; userId: string | null; conversationId: string | null; toolName: string; status: string; inputJson: unknown; outputJson: unknown; requiredConfirmation: boolean; automationLevel: string | null; createdAt: Date; confirmedBy: string | null }): StoredToolCall {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    userId: row.userId,
    conversationId: row.conversationId,
    toolName: row.toolName,
    status: row.status,
    inputJson: row.inputJson,
    outputJson: row.outputJson,
    requiredConfirmation: row.requiredConfirmation,
    automationLevel: row.automationLevel,
    // Corrección L6a (SEC-02/SEC-03): caducidad (createdAt + 24 h) y reclamación (confirmedBy) las aplica el runner.
    createdAt: row.createdAt,
    confirmedBy: row.confirmedBy
  };
}

function defaultDeps(): ToolRunnerDeps {
  return {
    getPropertyAiSettings,
    findToolSetting: async (propertyId, toolName) => {
      const row = await prisma.propertyAiToolSetting.findUnique({ where: { propertyId_toolName: { propertyId, toolName } } });
      if (!row) return null;
      return { enabled: row.enabled, automationLevel: row.automationLevel, requiresConfirmation: row.requiresConfirmation, requiresApprovalRole: row.requiresApprovalRole };
    },
    evaluatePolicyGate: (input) => evaluatePolicyGate(input),
    recordToolCall: async (input) => {
      const { inputJson, outputJson, ...rest } = input;
      const row = await recordToolCall({ ...rest, inputJson: toJson(inputJson), ...(outputJson !== undefined ? { outputJson: toJson(outputJson) } : {}) });
      return { id: row.id };
    },
    updateToolCall: (id, patch, guard) => {
      const { inputJson, outputJson, ...rest } = patch;
      return updateToolCall(id, { ...rest, ...(inputJson !== undefined ? { inputJson: toJson(inputJson) } : {}), ...(outputJson !== undefined ? { outputJson: toJson(outputJson) } : {}) }, guard);
    },
    monthToDateCostEur,
    enqueueReview: async (input) => {
      const item = await enqueueReview(input);
      return { id: item.id };
    },
    findPendingReview: (relatedEntityId) => prisma.aiHumanReviewItem.findFirst({ where: { relatedEntityType: "ai_tool_call", relatedEntityId, status: { in: ["pending", "escalated"] } }, select: { id: true } }),
    approveReview,
    rejectReview,
    recordAuditEvent,
    getEnabledModuleCodes,
    canExecuteToolForModules,
    getDefinition: (name) => (TOOL_DEFINITIONS.find((definition) => definition.name === name) as RunnerToolDefinition | undefined) ?? null,
    loadToolCall: async (id) => {
      const row = await prisma.aiToolCall.findUnique({ where: { id } });
      return row ? mapStoredToolCall(row) : null;
    },
    getImplementation: (name) => (AI_TOOL_IMPLEMENTATIONS[name] as AiToolImpl<unknown, unknown> | undefined) ?? null,
    monthlyBudgetEurDefault: () => getAiConfig().monthlyBudgetEurDefault,
    now: Date.now
  };
}

let overrides: Partial<ToolRunnerDeps> | null = null;

function currentDeps(): ToolRunnerDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}

/** Sustituye dependencias (tests sin Prisma). Sin argumento restaura las reales. */
export function resetAiToolRunnerForTests(deps?: Partial<ToolRunnerDeps>): void {
  overrides = deps ?? null;
}

/**
 * approveReview/rejectReview lanzan ConflictError («No se puede aprobar un elemento de
 * revisión en estado …») si la revisión ya estaba decidida desde la cola: es el ÚNICO error
 * tolerado al cerrar la revisión desde la confirmación (patrón email-reservation.service.ts:585-591).
 */
export function isReviewAlreadyDecided(error: unknown): boolean {
  if (error instanceof ConflictError) return true;
  const message = error instanceof Error ? error.message : "";
  return /Cannot (approve|reject) a review item with status|No se puede (aprobar|rechazar) un elemento de revisión/.test(message);
}

export type RunnerPortsOptions = {
  /** Usuario que decide (approveReview/rejectReview exigen un UserContext). */
  user?: UserContext;
  correlationId?: string;
};

/** Ports Prisma del runner puro sobre los servicios existentes; `deps` sustituye cualquiera (tests). */
export function buildRunnerPorts(deps: Partial<ToolRunnerDeps> = {}, options: RunnerPortsOptions = {}): RunnerPorts {
  const d: ToolRunnerDeps = { ...currentDeps(), ...deps };
  const reviewContext = (userId: string): UserContext =>
    options.user ?? { organizationId: "", propertyId: "", userId, fullName: "", deviceId: "", permissions: [] };

  return {
    getDefinition: (name) => d.getDefinition(name),
    canExecute: (input) => d.canExecuteToolForModules({ toolName: input.toolName as HotelOsToolName, enabledModules: input.enabledModules, userPermissions: input.userPermissions }),
    getPropertySetting: async (propertyId) => {
      const settings = await d.getPropertyAiSettings(propertyId);
      return {
        aiEnabled: settings.aiEnabled,
        defaultAutomationLevel: settings.defaultAutomationLevel,
        monthlyBudgetEur: monthlyBudgetEurOf(settings.configurationJson, d.monthlyBudgetEurDefault())
      };
    },
    getToolSetting: (propertyId, toolName) => d.findToolSetting(propertyId, toolName),
    evaluatePolicyGate: (input) => d.evaluatePolicyGate(input),
    monthToDateCostEur: (propertyId, organizationId) => d.monthToDateCostEur({ organizationId, propertyId }),
    recordToolCall: (input) => d.recordToolCall(input),
    updateToolCall: (id, patch, guard) => d.updateToolCall(id, patch, guard),
    enqueueReview: (input) => d.enqueueReview(input),
    closeReview: async (relatedEntityId, decision, userId, notes) => {
      const item = await d.findPendingReview(relatedEntityId);
      if (!item) return; // sin revisión encolada (riesgo medio sin gate): nada que cerrar
      try {
        if (decision === "approved") {
          await d.approveReview({ context: reviewContext(userId), id: item.id, userId, ...(notes ? { notes } : {}), ...(options.correlationId ? { correlationId: options.correlationId } : {}) });
        } else {
          await d.rejectReview({ context: reviewContext(userId), id: item.id, userId, reason: notes?.trim() || "Rechazada desde la confirmación de la herramienta de IA.", ...(options.correlationId ? { correlationId: options.correlationId } : {}) });
        }
      } catch (error) {
        if (!isReviewAlreadyDecided(error)) throw error;
        console.warn("[ai.tool-runner] review already decided; tool call closed anyway", { reviewItemId: item.id, toolCallId: relatedEntityId, decision, correlationId: options.correlationId });
      }
    },
    audit: (input) => d.recordAuditEvent(input)
  };
}

export type RunAiToolInput<I = unknown, O = unknown> = {
  context: UserContext;
  toolName: string;
  /** Nombre a persistir (scan_id_document, guest_message_reply…); defecto el canónico. */
  recordAs?: string;
  legacyStatus?: LegacyStatus;
  input: I;
  facts?: AiSafetyFacts;
  confidence?: number;
  /** Ejecución explícita; sin ella se usa la implementación de ./tools (o denied tool_not_implemented). */
  execute?: ToolExecute<I, O>;
  preview?: ToolPreview<I>;
  correlationId: string;
  source?: AiSource;
  locale?: string;
  conversationId?: string;
};

function runnerContextFor(deps: ToolRunnerDeps, user: UserContext, correlationId: string, options: { source?: AiSource; locale?: string; conversationId?: string } = {}): RunnerContext {
  return {
    organizationId: user.organizationId,
    propertyId: user.propertyId,
    userId: user.userId,
    permissions: [...user.permissions],
    enabledModules: deps.getEnabledModuleCodes(user.propertyId),
    correlationId,
    source: options.source ?? "text",
    locale: options.locale ?? "es-ES",
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(user.deviceId ? { deviceId: user.deviceId } : {})
  };
}

/** Traduce las denegaciones con error tipado (presupuesto → 403, rate limit → 429); el resto se devuelve. */
function throwIfTyped<O>(result: ToolRunResult<O>, ctx: RunnerContext): ToolRunResult<O> {
  if (result.status !== "denied") return result;
  if (result.reason === "budget_exceeded") {
    const details = result.details ?? {};
    throw new ForbiddenError("Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED", propertyId: ctx.propertyId, budgetEur: details.budgetEur ?? null, spentEur: details.spentEur ?? null, toolCallId: result.toolCallId ?? null });
  }
  if (result.reason === "rate_limited") {
    const retryAfterMs = typeof result.details?.retryAfterMs === "number" ? result.details.retryAfterMs : undefined;
    throw new TooManyRequestsError(result.message, { ...(retryAfterMs !== undefined ? { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) } : {}) });
  }
  return result;
}

/** Ejecuta una herramienta del registro a través del runner puro con los ports del API. */
export async function runAiTool<I = unknown, O = unknown>(input: RunAiToolInput<I, O>): Promise<ToolRunResult<O>> {
  const deps = currentDeps();
  const canonical = canonicalToolName(input.toolName);
  const impl = input.execute ? null : deps.getImplementation(canonical);
  // La entrada se valida ANTES de registrar nada (400 en español): la fila pendiente
  // guarda la entrada validada, que es la que ejecuta la confirmación.
  const parsed = impl ? (parseToolInput(impl.inputSchema, input.input, canonical) as I) : input.input;
  const ctx = runnerContextFor(deps, input.context, input.correlationId, { source: input.source, locale: input.locale, conversationId: input.conversationId });
  const ports = buildRunnerPorts({}, { user: input.context, correlationId: input.correlationId });
  const execute: ToolExecute<I, O> | undefined =
    input.execute ?? (impl ? (value, runnerCtx) => impl.execute(value, apiToolContextFromRunner(runnerCtx, input.context)) as Promise<never> : undefined);
  const preview: ToolPreview<I> | undefined =
    input.preview ?? (impl?.preview ? (value, runnerCtx) => impl.preview!(value, apiToolContextFromRunner(runnerCtx, input.context)) : undefined);

  const result = await runTool<I, O>({
    toolName: canonical,
    ...(input.recordAs ? { recordAs: input.recordAs } : {}),
    ...(input.legacyStatus ? { legacyStatus: input.legacyStatus } : {}),
    input: parsed,
    ctx,
    ...(input.facts ? { facts: input.facts } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(execute ? { execute } : {}),
    ...(preview ? { preview } : {}),
    ports,
    now: deps.now
  });
  return throwIfTyped(result, ctx);
}

export type ConfirmToolCallInput = {
  context: UserContext;
  toolCallId: string;
  decision: "approve" | "reject";
  notes?: string;
  correlationId: string;
  /** Ejecución explícita (tests, llamadores del lote 4); sin ella se usa la implementación de ./tools. */
  execute?: ToolExecute<unknown, unknown>;
  source?: AiSource;
  locale?: string;
};

/** Decisión humana sobre una llamada awaiting_confirmation (servicio; la ruta la añade el orquestador). */
export async function confirmToolCall(input: ConfirmToolCallInput): Promise<ConfirmToolResult> {
  const deps = currentDeps();
  const row = await deps.loadToolCall(input.toolCallId);
  // 404 opaco: inexistente, de otra organización o de otra propiedad (SEC-03; el runner repite la comprobación y el estado).
  if (!row || row.organizationId !== input.context.organizationId) throw new NotFoundError(TOOL_CALL_NOT_FOUND_MESSAGE);
  if (row.propertyId && row.propertyId !== input.context.propertyId) throw new NotFoundError(TOOL_CALL_NOT_FOUND_MESSAGE);
  const canonical = canonicalToolName(row.toolName);
  const impl = input.execute ? null : deps.getImplementation(canonical);
  const ctx = runnerContextFor(deps, input.context, input.correlationId, { source: input.source, locale: input.locale, ...(row.conversationId ? { conversationId: row.conversationId } : {}) });
  const ports = buildRunnerPorts({}, { user: input.context, correlationId: input.correlationId });
  const execute: ToolExecute<unknown, unknown> =
    input.execute ??
    (impl
      ? (value, runnerCtx) => impl.execute(parseToolInput(impl.inputSchema, value, canonical), apiToolContextFromRunner(runnerCtx, input.context))
      : async () => {
          throw new AiError("tool_not_implemented", `Herramienta sin ejecución disponible: ${canonical}.`, { retryable: false, status: 503 });
        });
  try {
    return await confirmTool({ toolCallId: input.toolCallId, ctx, decision: input.decision, ...(input.notes !== undefined ? { notes: input.notes } : {}), execute, ports, loadToolCall: async () => row, now: deps.now });
  } catch (error) {
    if (!isAiError(error)) throw error;
    const details = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : {};
    if (error.code === "tool_unknown") throw new NotFoundError(TOOL_CALL_NOT_FOUND_MESSAGE);
    if (error.code === "tool_denied") throw new ForbiddenError(error.message, { code: "AI_TOOL_CONFIRM_FORBIDDEN", ...details });
    // Corrección L6a (SEC-03): puertas re-evaluadas al confirmar y caducidad de la fila pendiente.
    if (error.code === "ai_disabled_for_property") throw new ForbiddenError(error.message, { code: "AI_DISABLED_FOR_PROPERTY", propertyId: input.context.propertyId, ...details });
    if (error.code === "budget_exceeded") throw new ForbiddenError("Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED", propertyId: input.context.propertyId, budgetEur: details.budgetEur ?? null, spentEur: details.spentEur ?? null, toolCallId: input.toolCallId });
    if (error.code === "confirmation_expired") throw new ConflictError(error.message, { code: "AI_CONFIRMATION_EXPIRED", ...details });
    if (error.code === "rate_limited") throw new TooManyRequestsError(error.message, { ...(error.retryAfterMs !== undefined ? { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)) } : {}) });
    throw error;
  }
}
