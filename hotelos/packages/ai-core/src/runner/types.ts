// Contrato del tool runner (Tanda L6a, lote 3). Puro: sin Prisma, sin
// variables de entorno y sin red; todo lo que toca la base de datos entra por
// RunnerPorts (apps/api/src/modules/ai-operations/tool-runner.service.ts los
// construye sobre los servicios existentes). Se importa como
// `@hotelos/ai-core/runner` (alias de tsconfig.base.json).

import type { AiSafetyFacts, AiToolSafetyDecision, ToolDefinition, ToolEffect } from "@hotelos/ai-tools";
import type { HotelModuleCode } from "@hotelos/product";
import type { ActorType, AiSource, PermissionKey, RiskLevel, ToolContext } from "@hotelos/shared";

import type { AiErrorCode } from "../errors.js";
import type { AiTelemetry } from "../messages.js";
import type { AutomationLevel, GateLevel } from "./automation.js";
import type { ToolCallStatus } from "./status.js";

export type MaybePromise<T> = T | Promise<T>;

/** JSON serializable (lo que admite Prisma.InputJsonValue). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Definición del registro con `effect` garantizado (registry.ts lo declara desde el lote 3). */
export type RunnerToolDefinition = ToolDefinition & { effect: ToolEffect };

// --- Contexto -----------------------------------------------------------------

export type RunnerContext = {
  organizationId: string;
  propertyId: string;
  userId: string;
  permissions: PermissionKey[];
  enabledModules: HotelModuleCode[];
  correlationId: string;
  source: AiSource;
  locale: string;
  /** Conversación (mensajería) a la que pertenece la llamada, si procede. */
  conversationId?: string;
  deviceId?: string;
  /** Roles (templateKey) del usuario, si el llamador los conoce: satisfacen `requiresApprovalRole` al confirmar (SEC-04). */
  roles?: string[];
};

/** ToolContext de packages/shared/src/types.ts:343-352 (usa `auditCorrelationId`) → RunnerContext. */
export function runnerContextFromToolContext(ctx: ToolContext, enabledModules: HotelModuleCode[]): RunnerContext {
  return {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    userId: ctx.userId,
    permissions: [...ctx.permissions],
    enabledModules: [...enabledModules],
    correlationId: ctx.auditCorrelationId,
    source: ctx.source,
    locale: ctx.locale,
    ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {})
  };
}

/** RunnerContext → ToolContext (lo que reciben los `execute` de AiTool, contracts.ts:14). */
export function toolContextFromRunnerContext(ctx: RunnerContext): ToolContext {
  return {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    userId: ctx.userId,
    ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
    locale: ctx.locale,
    source: ctx.source,
    auditCorrelationId: ctx.correlationId,
    permissions: [...ctx.permissions]
  };
}

// --- Ports ----------------------------------------------------------------------

export type PropertyAiSettingView = {
  aiEnabled: boolean;
  defaultAutomationLevel: string;
  /** Presupuesto mensual en EUR (monthlyBudgetEurOf); null = sin límite. */
  monthlyBudgetEur: number | null;
};

export type ToolSettingView = {
  enabled: boolean;
  automationLevel: string | null;
  requiresConfirmation: boolean;
  requiresApprovalRole: string | null;
};

export type PolicyGateInput = {
  organizationId: string;
  propertyId: string;
  toolRiskLevel: RiskLevel;
  confidence?: number;
  automationLevel: GateLevel;
};

/** Misma forma que PolicyGateDecision de governance.service.ts:165-170 (sin importar apps/api). */
export type PolicyGateDecision = {
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresHumanReview: boolean;
  reasons: string[];
};

/** Misma forma que RecordToolCallInput de pipeline.service.ts (status tipado). */
export type RecordToolCallInput = {
  organizationId: string;
  toolName: string;
  status: ToolCallStatus;
  inputJson: JsonValue;
  propertyId?: string;
  userId?: string;
  conversationId?: string;
  outputJson?: JsonValue;
  confidence?: number;
  requiredConfirmation?: boolean;
  confirmedBy?: string;
  model?: string;
  latencyMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  /** undefined = columna NULL (coste desconocido); 0 solo cuando no hubo llamada al modelo. */
  costEur?: number;
  errorMessage?: string;
  automationLevel?: string;
};

export type ToolCallPatch = {
  status?: ToolCallStatus;
  confirmedBy?: string;
  /** Se reescribe al cerrar una fila pendiente: la entrada ejecutable se sustituye por la copia redactada (SEC-06). */
  inputJson?: JsonValue;
  outputJson?: JsonValue;
  errorMessage?: string | null;
  model?: string;
  latencyMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costEur?: number | null;
};

export type EnqueueReviewInput = {
  organizationId: string;
  propertyId?: string;
  reviewType: "ai_tool_call";
  relatedEntityType: "ai_tool_call";
  relatedEntityId: string;
  payloadJson: Record<string, unknown>;
  correlationId?: string;
  actorUserId?: string;
};

export type ReviewDecision = "approved" | "rejected";

/** Condición de una escritura sobre ai_tool_calls (transición de estado atómica). */
export type ToolCallGuard = {
  status: ToolCallStatus;
  /** true = además `confirmed_by IS NULL` (la fila no ha sido reclamada por otra confirmación). */
  unclaimed?: boolean;
};

export type AuditInput = {
  organizationId: string;
  propertyId?: string;
  actorUserId?: string;
  actorType: ActorType;
  action: RunnerAuditAction;
  entityType: "ai_tool_call";
  entityId?: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  correlationId?: string;
};

export type RunnerAuditAction =
  | "AI_TOOL_EXECUTED"
  | "AI_TOOL_CONFIRMATION_REQUESTED"
  | "AI_TOOL_DENIED"
  | "AI_TOOL_FAILED"
  | "AI_TOOL_CONFIRMATION_APPROVED"
  | "AI_TOOL_CONFIRMATION_REJECTED";

export type RunnerPorts = {
  /** Definición del registro por nombre canónico; null si no existe. */
  getDefinition(name: string): RunnerToolDefinition | null;
  /** canExecuteToolForModules (registry.ts:185): módulo activo y permisos del usuario. */
  canExecute(input: { toolName: string; enabledModules: HotelModuleCode[]; userPermissions: PermissionKey[] }): { allowed: true } | { allowed: false; reason: string };
  getPropertySetting(propertyId: string): MaybePromise<PropertyAiSettingView>;
  getToolSetting(propertyId: string, toolName: string): MaybePromise<ToolSettingView | null>;
  evaluatePolicyGate(input: PolicyGateInput): MaybePromise<PolicyGateDecision>;
  /** Suma de cost_eur del mes natural (UTC) de la propiedad. */
  monthToDateCostEur(propertyId: string, organizationId: string): MaybePromise<number>;
  recordToolCall(input: RecordToolCallInput): MaybePromise<{ id: string }>;
  /**
   * Actualiza la fila. Con `guard` la escritura es CONDICIONAL (UPDATE … WHERE id AND status = guard.status
   * [AND confirmed_by IS NULL]) y `count` dice cuántas filas cambiaron: 0 = otra petición la reclamó antes
   * (SEC-02: dos aprobaciones concurrentes nunca ejecutan dos veces).
   */
  updateToolCall(id: string, patch: ToolCallPatch, guard?: ToolCallGuard): MaybePromise<{ count: number }>;
  enqueueReview(input: EnqueueReviewInput): MaybePromise<{ id: string }>;
  /** Cierra la revisión ligada a la llamada; tolera «ya decidida» (ConflictError) sin lanzar. */
  closeReview(relatedEntityId: string, decision: ReviewDecision, userId: string, notes?: string): MaybePromise<void>;
  audit(input: AuditInput): MaybePromise<unknown>;
};

// --- Ejecución --------------------------------------------------------------------

/**
 * Lo que devuelve un `execute`: el resultado desnudo (si tiene forma AiResult el runner
 * extrae la telemetría con telemetryFromAiResult) o envuelto en `{ output, telemetry, record }`
 * (`record` = lo que se persiste en outputJson en lugar de `output`, para no guardar PII).
 */
export type ExecuteResult<T> = T | { output: T; telemetry?: AiTelemetry | null; record?: JsonValue };

export type ToolExecute<I = unknown, O = unknown> = (input: I, ctx: RunnerContext) => MaybePromise<ExecuteResult<O>>;
export type ToolPreview<I = unknown> = (input: I, ctx: RunnerContext) => MaybePromise<JsonValue | undefined>;

export type DenyReason = AiErrorCode | "tool_disabled" | "module_disabled" | "missing_permission" | "safety" | "policy_gate";

export type ToolRunResult<T = unknown> =
  | { status: "executed"; toolCallId: string; output: T; configured: boolean }
  | { status: "awaiting_confirmation"; toolCallId: string; preview?: JsonValue; requiresApprovalRole?: string }
  | { status: "denied"; toolCallId?: string; reason: DenyReason; message: string; riskLevel: RiskLevel; details?: Record<string, unknown> };

export type LegacyStatus = { succeeded?: ToolCallStatus; notConfigured?: ToolCallStatus };

export type RunToolInput<I = unknown, O = unknown> = {
  toolName: string;
  /** Nombre a persistir en ai_tool_calls (p. ej. scan_id_document); defecto el canónico. */
  recordAs?: string;
  /** Vocabulario legado a persistir (completed | skipped) para los llamadores históricos. */
  legacyStatus?: LegacyStatus;
  input: I;
  ctx: RunnerContext;
  facts?: AiSafetyFacts;
  confidence?: number;
  execute?: ToolExecute<I, O>;
  preview?: ToolPreview<I>;
  ports: RunnerPorts;
  now?: () => number;
};

export type ToolGateDecision =
  | {
      mode: "deny";
      toolName: string;
      reason: DenyReason;
      message: string;
      riskLevel: RiskLevel;
      definition: RunnerToolDefinition | null;
      automationLevel: AutomationLevel | null;
      details?: Record<string, unknown>;
    }
  | {
      mode: "execute" | "confirm";
      toolName: string;
      definition: RunnerToolDefinition;
      automationLevel: AutomationLevel;
      /** Valor de la columna required_confirmation (definición.requiresConfirmation en lecturas). */
      requiredConfirmation: boolean;
      requiresApprovalRole?: string;
      requiresHumanReview: boolean;
      safety: AiToolSafetyDecision;
      gate: PolicyGateDecision;
      budget: { budgetEur: number | null; spentEur: number };
      reasons: string[];
    };

export type StoredToolCall = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  userId: string | null;
  conversationId?: string | null;
  toolName: string;
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  requiredConfirmation?: boolean;
  automationLevel?: string | null;
  /** Fecha de creación de la fila: con ella confirmTool aplica la caducidad (CONFIRMATION_TTL_MS). */
  createdAt?: Date | string | null;
  /** Quién la reclamó (confirmed_by): una fila pendiente ya reclamada no es confirmable. */
  confirmedBy?: string | null;
};

export type ConfirmToolInput<O = unknown> = {
  toolCallId: string;
  ctx: RunnerContext;
  decision: "approve" | "reject";
  notes?: string;
  execute: ToolExecute<unknown, O>;
  ports: RunnerPorts;
  loadToolCall(id: string): MaybePromise<StoredToolCall | null>;
  now?: () => number;
  /** Caducidad de una fila awaiting_confirmation desde createdAt (defecto CONFIRMATION_TTL_MS = 24 h). */
  ttlMs?: number;
};

export type ConfirmToolResult<O = unknown> =
  | { status: "succeeded"; toolCallId: string; output: O; configured: boolean }
  | { status: "failed"; toolCallId: string; reason: AiErrorCode; message: string }
  | { status: "rejected"; toolCallId: string };
