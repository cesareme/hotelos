// Núcleo conversacional único del asistente ehotelOS (Tanda L6b · L6b-05) sobre @hotelos/ai-core.
//
// runAssistantTurn({ context, surface, question, conversationId?, screen?, correlationId }):
//   (a) memoria (assistant-memory.service.ts): conversación por usuario + propiedad, los últimos
//       10 mensajes como contexto del modelo, título = primera pregunta recortada;
//   (b) SIN proveedor (getAiCore().isConfigured() false) → routeByRules sobre el catálogo del
//       usuario (catalogFor: RBAC + superficie + módulos activos) y `run` de las locales; las del
//       registro se ejecutan por runAiTool (puertas, HITL, presupuesto y telemetría del runner);
//   (c) CON proveedor → getAiCore().complete({ system: promptFrom("assistant_<surface>", respaldo),
//       messages: memoria + contexto de pantalla + pregunta }, ctx, { tools: catálogo filtrado +
//       escrituras del registro que el usuario puede confirmar, toolChoice: "auto" }); bucle de
//       hasta MAX_MODEL_TURNS turnos con toolResultBlock. Las escrituras SIEMPRE pasan por runAiTool
//       → awaiting_confirmation (WRITE_ALWAYS_CONFIRMS del runner): el modelo solo PROPONE. Una
//       herramienta que no está en el catálogo del usuario se deniega sin ejecutarla. 403
//       (presupuesto) / 429 (rate limit) del runner o de ai-core, rechazo o proveedor caído →
//       respuesta por reglas con aviso (nunca se simula un modelo). Antes de llamar al modelo se
//       evalúa la puerta de propiedad (assistant-gate.ts: aiEnabled, nivel de automatización y
//       presupuesto mensual, las puertas 3/4/7 del runner): cerrada → reglas con aviso y 0 llamadas;
//   (d) AssistantTurn v2: mode (`llm` SOLO si un modelo respondió; deriveAssistantMode), routedBy,
//       citations [{ tool, source, aiToolCallId? }], cost { model, tokens, eur|null },
//       pendingToolCalls [], conversationId, notices. Una fila answerAnalyticsQuestion por turno
//       (recordToolCall, status succeeded, model/tokens/coste reales; por reglas → tokens 0 y
//       cost_eur 0, AI-CORE §6). Todo lo persistido (memoria y telemetría) pasa antes por
//       redactForTelemetry (marcadores sin mapa: irreversible a propósito); la telemetría del turno
//       guarda de la pregunta solo su huella (longitud + sha256 truncado), nunca el texto, porque el
//       redactor no reconoce nombres sin tratamiento (corrector L6b · REV-02).
// Superficie efectiva: con `conversationId` manda la superficie de la conversación guardada
// (catálogo, prompt y `turn.surface`); la del cuerpo solo cuenta al crearla (REV-05).
// Dependencias inyectables (AssistantCoreDeps / resetAssistantCoreForTests): tests sin Prisma ni red.

import { createHash } from "node:crypto";
import type { AiContentBlock, AiContext, AiCore, AiMessage, AiSuccessMeta, AiTelemetry, JsonSchema } from "@hotelos/ai-core";
import { createPiiRedactor, isAiError, toolResultBlock } from "@hotelos/ai-core";
import type { PiiRedactor } from "@hotelos/ai-core";
import { redactForTelemetry } from "@hotelos/ai-core/runner";
import type { RecordToolCallInput, ToolRunResult } from "@hotelos/ai-core/runner";
import { canExecuteToolForModules, evaluateAiSafetyForTool, getToolDefinition } from "@hotelos/ai-tools";
import type { HotelOsToolName } from "@hotelos/ai-tools";
import type { Prisma } from "@hotelos/database";
import type { RiskLevel } from "@hotelos/shared";
import { getAiCore } from "../../lib/ai-client.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../../lib/http-error.js";
import { recordToolCall as recordToolCallReal } from "../ai-operations/pipeline.service.js";
import { runAiTool as runAiToolReal } from "../ai-operations/tool-runner.service.js";
import type { RunAiToolInput } from "../ai-operations/tool-runner.service.js";
import { AI_TOOL_IMPLEMENTATIONS, AI_WRITE_TOOL_NAMES } from "../ai-operations/tools/index.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { ASSISTANT_SURFACES, catalogFor, toModelTools } from "./assistant-catalog.js";
import type { AssistantRunContext, AssistantSurface, AssistantTool } from "./assistant-catalog.js";
import { evaluateAssistantPropertyGate } from "./assistant-gate.js";
import type { AssistantGateInput, AssistantPropertyGate } from "./assistant-gate.js";
import { appendAssistantMessage, openAssistantConversation, memoryToModelMessages, recentAssistantMessages } from "./assistant-memory.service.js";
import type { AssistantConversationRecord, AssistantStoredToolCall } from "./assistant-memory.service.js";
import { routeByRules, suggestedQuestionsFor } from "./assistant-router.js";
import { composeUserMessage, fallbackPromptFor, normalizeScreenContext, promptCodeFor } from "./assistant-prompts.js";
import type { AssistantScreenContext } from "./assistant-prompts.js";
import type { ToolResult } from "./assistant.tools.js";

export type { AssistantScreenContext } from "./assistant-prompts.js";
export type { AssistantGateInput, AssistantGateReason, AssistantPropertyGate } from "./assistant-gate.js";

/** Nombre de la herramienta del registro bajo la que se registra cada turno (advancedTool, analytics.ai_ask). */
export const ASSISTANT_TURN_TOOL_NAME = "answerAnalyticsQuestion";
/** Clave que exige el contexto para que el modelo reciba una escritura high | critical (la misma que POST /ai/tool-calls/:id/confirm). */
export const HIGH_RISK_CONFIRM_PERMISSION = "ai.high_risk.confirm";
const HIGH_RISK_LEVELS: readonly RiskLevel[] = ["high", "critical"];
/** Prefijo del `userId` del actor del huésped (checkin/service-context.ts serviceUserId): guest:<conversationId>. */
const GUEST_ACTOR_PREFIX = "guest:";
/** Turnos máximos del bucle modelo → herramientas → modelo. */
export const MAX_MODEL_TURNS = 3;
/** max_tokens de cada respuesta del modelo. */
export const MODEL_MAX_TOKENS = 700;
/** Caracteres máximos de un tool_result enviado al modelo. */
export const MAX_TOOL_RESULT_CHARS = 6000;
const MAX_SUMMARY_CHARS = 300;
const MAX_QUESTION_CHARS = 2000;

// ---------------------------------------------------------------------------
// Contrato del turno (v2; el panel lo lee en apps/admin-web/src/services/assistantApi.ts)
// ---------------------------------------------------------------------------

export type AssistantRoutedBy = "rules" | "model";

export type AssistantToolCallSummary = { name: string; ok: boolean; source: string; summary: string };

export type AssistantCitation = {
  tool: string;
  source: string;
  ok: boolean;
  summary: string;
  /** Fila de ai_tool_calls cuando la ejecutó el runner (herramientas del registro). */
  aiToolCallId?: string;
  /** 0 = lectura local sin modelo; ausente = coste desconocido aquí (lo lleva la fila del runner). */
  costEur?: number | null;
};

export type AssistantCost = { model: string | null; tokensInput: number | null; tokensOutput: number | null; eur: number | null };

export type AssistantPendingToolCall = {
  id: string;
  toolName: string;
  summary: string | null;
  riskLevel: RiskLevel | null;
  createdAt: string;
  conversationId: string | null;
  correlationId: string;
  /** Entrada propuesta por el modelo, redactada (sin PII). */
  input: Record<string, unknown> | null;
};

export type AssistantTurn = {
  question: string;
  answer: string;
  toolCalls: AssistantToolCallSummary[];
  mode: "deterministic" | "llm";
  generatedAt: string;
  correlationId: string;
  // ---- v2 ----
  surface: AssistantSurface;
  conversationId: string | null;
  routedBy: AssistantRoutedBy;
  citations: AssistantCitation[];
  cost: AssistantCost;
  pendingToolCalls: AssistantPendingToolCall[];
  /** Avisos en español (respaldo por reglas, herramientas denegadas…). */
  notices: string[];
};

/** Resultado de herramienta tal como lo ve el modo: `modelAnswered` solo cuando un modelo respondió de verdad. */
export type AssistantToolOutcome = { ok: boolean; modelAnswered?: boolean };

/** Modo honesto del turno: `llm` SOLO si algún resultado lo produjo un modelo; si no, `deterministic`, haya o no clave. */
export function deriveAssistantMode(results: ReadonlyArray<{ result: AssistantToolOutcome }>): AssistantTurn["mode"] {
  return results.some(({ result }) => result.modelAnswered === true) ? "llm" : "deterministic";
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

/** Escritura del registro que el modelo puede PROPONER (el runner la deja awaiting_confirmation). */
export type AssistantWriteTool = { name: HotelOsToolName; description: string; inputSchema: JsonSchema; riskLevel: RiskLevel };

export type AssistantCoreDeps = {
  getAiCore: () => AiCore;
  /** Lecturas visibles para el usuario en la superficie (RBAC + superficie + módulos activos). */
  catalogFor: (input: { context: UserContext; surface: AssistantSurface }) => AssistantTool[];
  /** Escrituras del registro que el usuario podría confirmar (solo superficies de personal). */
  writeToolsFor: (input: { context: UserContext; surface: AssistantSurface }) => AssistantWriteTool[];
  runAiTool: (input: RunAiToolInput) => Promise<ToolRunResult>;
  recordToolCall: (input: RecordToolCallInput) => Promise<unknown>;
  /** Puerta de propiedad del camino con modelo (aiEnabled · nivel de automatización · presupuesto): cerrada → reglas con aviso. */
  propertyGate: (input: AssistantGateInput) => Promise<AssistantPropertyGate>;
  now: () => Date;
};

function enabledModulesOf(propertyId: string) {
  try {
    return getEnabledModuleCodes(propertyId);
  } catch {
    return [];
  }
}

/** catalogFor de L6b-02 más el filtro por módulos activos de las herramientas del registro (canExecuteToolForModules solo actúa al ejecutar). */
export function visibleCatalogFor(input: { context: UserContext; surface: AssistantSurface }): AssistantTool[] {
  const tools = catalogFor({ permissions: input.context.permissions, surface: input.surface });
  const enabledModules = enabledModulesOf(input.context.propertyId);
  return tools.filter((tool) => {
    if (tool.kind !== "registry" || !tool.registryName) return true;
    return canExecuteToolForModules({ toolName: tool.registryName, enabledModules, userPermissions: input.context.permissions }).allowed;
  });
}

/**
 * Escrituras con implementación (AI_WRITE_TOOL_NAMES) que el usuario podría confirmar de verdad (corrector L6b ·
 * REV-04): módulo activo y permisos del registro (canExecuteToolForModules), sin rechazo firme de la matriz de riesgo
 * (evaluateAiSafetyForTool.denied: la puerta 5 del runner las denegaría siempre, p. ej. createWorkOrder sin
 * maintenance.workorder.manage) y, si son high | critical, con `ai.high_risk.confirm` en el contexto (sin ella la
 * confirmación sería imposible). Ninguna en la superficie del huésped.
 */
export function writeToolsFor(input: { context: UserContext; surface: AssistantSurface }): AssistantWriteTool[] {
  if (input.surface === "guest") return [];
  const enabledModules = enabledModulesOf(input.context.propertyId);
  const permissions = input.context.permissions;
  const canConfirmHighRisk = (permissions as readonly string[]).includes(HIGH_RISK_CONFIRM_PERMISSION);
  const out: AssistantWriteTool[] = [];
  for (const name of AI_WRITE_TOOL_NAMES) {
    const impl = AI_TOOL_IMPLEMENTATIONS[name];
    if (!impl) continue;
    if (!canExecuteToolForModules({ toolName: name, enabledModules, userPermissions: permissions }).allowed) continue;
    const definition = getToolDefinition(name);
    if (evaluateAiSafetyForTool({ toolName: name, definition, permissions }).denied) continue;
    if (HIGH_RISK_LEVELS.includes(definition.riskLevel) && !canConfirmHighRisk) continue;
    out.push({ name, description: impl.description, inputSchema: impl.modelInputSchema ?? { type: "object" }, riskLevel: definition.riskLevel });
  }
  return out;
}

function defaultDeps(): AssistantCoreDeps {
  return {
    getAiCore,
    catalogFor: visibleCatalogFor,
    writeToolsFor,
    runAiTool: (input) => runAiToolReal(input),
    recordToolCall: (input) => {
      const { inputJson, outputJson, ...rest } = input;
      return recordToolCallReal({ ...rest, inputJson: inputJson as Prisma.InputJsonValue, ...(outputJson !== undefined ? { outputJson: outputJson as Prisma.InputJsonValue } : {}) });
    },
    propertyGate: evaluateAssistantPropertyGate,
    now: () => new Date()
  };
}

let overrides: Partial<AssistantCoreDeps> | null = null;

function currentDeps(): AssistantCoreDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}

/** Sustituye dependencias (tests sin Prisma ni red). Sin argumento restaura las reales. */
export function resetAssistantCoreForTests(deps?: Partial<AssistantCoreDeps>): void {
  overrides = deps ?? null;
}

/** Puerta de propiedad con las dependencias vigentes (la usa el clasificador del bot del huésped: misma puerta que el turno). */
export function assistantPropertyGate(input: AssistantGateInput): Promise<AssistantPropertyGate> {
  return currentDeps().propertyGate(input);
}

/** Superficie efectiva del turno (pura): la de la conversación guardada si es conocida; si no, la pedida. */
export function effectiveSurface(conversation: Pick<AssistantConversationRecord, "surface"> | null, requested: AssistantSurface): AssistantSurface {
  if (conversation && (ASSISTANT_SURFACES as readonly string[]).includes(conversation.surface)) return conversation.surface as AssistantSurface;
  return requested;
}

/** Conversación de mensajería del actor del huésped (`guest:<conversationId>`), o null para cualquier otro actor. */
export function guestConversationIdOf(userId: string): string | null {
  return userId.startsWith(GUEST_ACTOR_PREFIX) && userId.length > GUEST_ACTOR_PREFIX.length ? userId.slice(GUEST_ACTOR_PREFIX.length) : null;
}

/** Huella de la pregunta para la telemetría (pura): longitud y sha256 truncado, nunca el texto (REV-02). */
export function questionFingerprint(question: string): { questionChars: number; questionSha256: string } {
  return { questionChars: question.length, questionSha256: createHash("sha256").update(question, "utf8").digest("hex").slice(0, 16) };
}

// ---------------------------------------------------------------------------
// Utilidades de presentación (por reglas)
// ---------------------------------------------------------------------------

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function fmtPct(n: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(n) + " %";
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "<no serializable>";
  }
}

/** «hoy» con la fecha que devolvió la lectura (`data.date`, YYYY-MM-DD → dd/mm/aaaa) para que la cita sea auto-explicativa (REV-06). */
export function todayLabel(d: Record<string, unknown>): string {
  const iso = typeof d.date === "string" ? d.date : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `hoy (${match[3]}/${match[2]}/${match[1]})` : "hoy";
}

/** Resumen en español de un resultado de herramienta (las 12 locales, las del copiloto y un genérico). */
export function renderToolSummary(toolName: string, r: ToolResult): string {
  if (!r.ok) {
    const error = typeof r.data.error === "string" ? r.data.error : "";
    return error ? `(${toolName}: ${clipText(error, 160)})` : `(${toolName}: no hay datos disponibles)`;
  }
  const d = r.data as Record<string, unknown>;
  switch (toolName) {
    case "get_arrivals_today":
      return `${d.count} reservas con llegada ${todayLabel(d)}.`;
    case "get_departures_today":
      return `${d.count} reservas con salida ${todayLabel(d)}.`;
    case "get_in_house_guests":
      return `${d.count} huéspedes en hotel ahora.`;
    case "get_occupancy_today":
      return `Ocupación ${todayLabel(d)}: ${fmtPct(Number(d.occupancyPct))} (${d.occupiedRooms}/${d.totalRooms} habitaciones).`;
    case "get_recent_revenue_snapshot":
      return `Último snapshot ${d.snapshotDate}: ocupación ${fmtPct(Number(d.occupancyPct))}, ADR ${fmtMoney(Number(d.adr), String(d.currency))}, RevPAR ${fmtMoney(Number(d.revpar), String(d.currency))}.`;
    case "get_pickup_7d":
      return `Pickup últimos 7 días: ${d.reservationsCreated} reservas creadas.`;
    case "get_open_balance":
      return `Saldo pendiente: ${fmtMoney(Number(d.balanceDue), String(d.currency))} en ${d.openFolios} folios abiertos.`;
    case "get_housekeeping_status": {
      const breakdown = (d.statusBreakdown ?? {}) as Record<string, number>;
      const parts = Object.entries(breakdown).map(([k, v]) => `${k}: ${v}`);
      return `Pisos (${d.totalRooms} habitaciones) — ${parts.join(", ")}.`;
    }
    case "get_compliance_summary": {
      const bySev = (d.bySeverity ?? {}) as Record<string, number>;
      const parts = Object.entries(bySev).map(([k, v]) => `${k}: ${v}`);
      return parts.length > 0 ? `Cumplimiento por severidad — ${parts.join(", ")}.` : "Sin datos de cumplimiento.";
    }
    default: {
      // Presets CHK (`summary`), copiloto (`answer`) y cualquier otra con texto propio.
      if (typeof d.summary === "string" && d.summary) return clipText(d.summary, MAX_SUMMARY_CHARS);
      if (typeof d.answer === "string" && d.answer) return clipText(d.answer, MAX_SUMMARY_CHARS);
      return clipText(safeJson(d), MAX_SUMMARY_CHARS);
    }
  }
}

// ---------------------------------------------------------------------------
// Ejecución de herramientas (común a reglas y modelo)
// ---------------------------------------------------------------------------

type ToolExecution = {
  name: string;
  status: "executed" | "failed" | "awaiting_confirmation" | "denied" | "invalid_input";
  ok: boolean;
  source: string;
  summary: string;
  /** Lo que ve el modelo en el tool_result (recortado). */
  modelContent: string;
  aiToolCallId?: string;
  costEur?: number | null;
};

/** Error interno: el turno con modelo no puede continuar y se responde por reglas con aviso. */
class RulesFallback extends Error {
  readonly notice: string;
  constructor(notice: string) {
    super(notice);
    this.name = "RulesFallback";
    this.notice = notice;
  }
}

type TurnEnv = {
  deps: AssistantCoreDeps;
  context: UserContext;
  surface: AssistantSurface;
  correlationId: string;
  conversationId: string | null;
  readTools: AssistantTool[];
  writeTools: AssistantWriteTool[];
  redactor: PiiRedactor;
  pending: AssistantPendingToolCall[];
  notices: string[];
  /** Prefijo de log de las herramientas locales (AssistantRunContext.logScope); undefined = el del catálogo. */
  logScope?: string;
};

function toolResultContent(value: unknown): string {
  return clipText(safeJson(value), MAX_TOOL_RESULT_CHARS);
}

async function executeLocalTool(env: TurnEnv, tool: AssistantTool): Promise<ToolExecution> {
  const ctx: AssistantRunContext = { organizationId: env.context.organizationId, propertyId: env.context.propertyId, correlationId: env.correlationId, ...(env.logScope ? { logScope: env.logScope } : {}) };
  try {
    const result = await tool.run!(ctx);
    const summary = renderToolSummary(tool.name, result);
    return { name: tool.name, status: result.ok ? "executed" : "failed", ok: result.ok, source: result.source, summary, modelContent: toolResultContent({ ok: result.ok, source: result.source, summary, data: result.data }), costEur: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summary = `(${tool.name}: ${clipText(message, 160)})`;
    return { name: tool.name, status: "failed", ok: false, source: tool.name, summary, modelContent: `Error al ejecutar ${tool.name}: ${clipText(message, 400)}`, costEur: 0 };
  }
}

function isBudgetOrRateLimit(error: unknown): error is ForbiddenError | TooManyRequestsError {
  return error instanceof ForbiddenError || error instanceof TooManyRequestsError;
}

/** Herramienta del registro (lectura o escritura) a través del runner: puertas, HITL, presupuesto y telemetría de allí. */
async function executeRegistryTool(env: TurnEnv, name: HotelOsToolName, input: Record<string, unknown>, options: { description: string | null; riskLevel: RiskLevel | null }): Promise<ToolExecution> {
  const source = `runner:${name}`;
  let result: ToolRunResult;
  try {
    result = await env.deps.runAiTool({
      context: env.context,
      toolName: name,
      input,
      correlationId: env.correlationId,
      source: "chat",
      ...(env.conversationId ? { conversationId: env.conversationId } : {})
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      const summary = `${name} necesita datos concretos: ${clipText(error.message, 200)}`;
      return { name, status: "invalid_input", ok: false, source, summary, modelContent: `Entrada no válida: ${clipText(error.message, 500)}` };
    }
    throw error;
  }
  if (result.status === "executed") {
    const summary = clipText(safeJson(result.output), MAX_SUMMARY_CHARS);
    return { name, status: "executed", ok: true, source, summary, modelContent: toolResultContent({ ok: true, output: result.output }), aiToolCallId: result.toolCallId };
  }
  if (result.status === "awaiting_confirmation") {
    env.pending.push({
      id: result.toolCallId,
      toolName: name,
      summary: options.description,
      riskLevel: options.riskLevel,
      createdAt: env.deps.now().toISOString(),
      conversationId: env.conversationId,
      correlationId: env.correlationId,
      input: Object.keys(input).length > 0 ? (redactForTelemetry(input, env.redactor) as Record<string, unknown>) : null
    });
    const summary = `Propuesta ${name} registrada (id ${result.toolCallId}): pendiente de que una persona la confirme. No se ha ejecutado.`;
    return { name, status: "awaiting_confirmation", ok: true, source, summary, modelContent: summary, aiToolCallId: result.toolCallId };
  }
  const summary = `${name} denegada (${result.reason}): ${clipText(result.message, 200)}`;
  env.notices.push(summary);
  return { name, status: "denied", ok: false, source, summary, modelContent: `Herramienta denegada (${result.reason}): ${clipText(result.message, 500)}`, ...(result.toolCallId ? { aiToolCallId: result.toolCallId } : {}) };
}

async function executeCatalogTool(env: TurnEnv, tool: AssistantTool, input: Record<string, unknown>): Promise<ToolExecution> {
  if (tool.kind === "local" && tool.run) return executeLocalTool(env, tool);
  if (tool.kind === "registry" && tool.registryName) {
    return executeRegistryTool(env, tool.registryName, input, { description: tool.description, riskLevel: getToolDefinition(tool.registryName).riskLevel });
  }
  return { name: tool.name, status: "failed", ok: false, source: tool.name, summary: `(${tool.name}: sin ejecución disponible)`, modelContent: `La herramienta ${tool.name} no tiene ejecución disponible.` };
}

// ---------------------------------------------------------------------------
// Camino por reglas
// ---------------------------------------------------------------------------

type PathResult = { answer: string; executions: ToolExecution[]; modelAnswered: boolean };

function composeRulesAnswer(env: TurnEnv, executions: ToolExecution[]): string {
  if (executions.length === 0) {
    const suggestions = suggestedQuestionsFor(env.surface, env.readTools).slice(0, 8);
    const examples = suggestions.length > 0 ? suggestions.map((s) => `• «${s.question}»`) : env.readTools.slice(0, 8).map((t) => `• ${t.name}: ${t.description}`);
    return ["No he sabido enrutar tu pregunta a una herramienta concreta. Puedo responder, entre otras cosas, a:", "", ...examples, "", "Reformula la pregunta usando una de esas áreas y te responderé con datos reales."].join("\n");
  }
  const lines: string[] = [];
  lines.push(executions.length === 1 ? "Aquí tienes la respuesta:" : `He consultado ${executions.length} fuentes:`);
  lines.push("");
  for (const execution of executions) lines.push(`• ${execution.summary}`);
  lines.push("");
  lines.push("Datos consultados en tiempo real (por reglas, sin modelo). Si necesitas detalle, pídelo por entidad concreta (reservas, folios, etc.).");
  return lines.join("\n");
}

async function answerByRules(env: TurnEnv, question: string): Promise<PathResult> {
  const route = routeByRules(question, env.readTools);
  const executions: ToolExecution[] = [];
  for (const tool of route.tools) {
    try {
      executions.push(await executeCatalogTool(env, tool, {}));
    } catch (error) {
      if (!isBudgetOrRateLimit(error)) throw error;
      // Por reglas no hay más respaldo: la herramienta queda fuera y se avisa.
      env.notices.push(clipText(error.message, 200));
      executions.push({ name: tool.name, status: "denied", ok: false, source: tool.name, summary: `(${tool.name}: ${clipText(error.message, 160)})`, modelContent: "" });
    }
  }
  return { answer: composeRulesAnswer(env, executions), executions, modelAnswered: false };
}

// ---------------------------------------------------------------------------
// Camino con modelo (tool use, ≤ MAX_MODEL_TURNS)
// ---------------------------------------------------------------------------

type UsageAccumulator = { model: string | null; tokensInput: number; tokensOutput: number; costEur: number | null; calls: number };

function addUsage(usage: UsageAccumulator, meta: Pick<AiSuccessMeta, "model" | "tokensInput" | "tokensOutput" | "costEur"> | AiTelemetry | null | undefined): void {
  if (!meta) return;
  usage.calls += 1;
  usage.model = meta.model;
  usage.tokensInput += meta.tokensInput;
  usage.tokensOutput += meta.tokensOutput;
  if (usage.calls === 1) usage.costEur = meta.costEur;
  else usage.costEur = usage.costEur === null || meta.costEur === null ? null : usage.costEur + meta.costEur;
}

function modelToolsOf(env: TurnEnv) {
  return [...toModelTools(env.readTools), ...env.writeTools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))];
}

/**
 * Entrada de una herramienta elegida por el modelo. En la superficie del huésped el `conversationId` es SIEMPRE la
 * conversación del actor (`guest:<id>`), nunca la que proponga el modelo (corrector L6b · L6B-REV-12: un huésped no
 * puede hacer que knownGuestPii se siembre con la PII de otra conversación).
 */
export function modelToolInput(env: Pick<TurnEnv, "surface" | "context">, rawInput: unknown): Record<string, unknown> {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? { ...(rawInput as Record<string, unknown>) } : {};
  if (env.surface !== "guest") return input;
  const conversationId = guestConversationIdOf(env.context.userId);
  if (conversationId) input.conversationId = conversationId;
  else delete input.conversationId;
  return input;
}

async function executeModelToolUse(env: TurnEnv, name: string, rawInput: unknown): Promise<ToolExecution> {
  const input = modelToolInput(env, rawInput);
  const readTool = env.readTools.find((tool) => tool.name === name);
  if (readTool) return executeCatalogTool(env, readTool, input);
  const writeTool = env.writeTools.find((tool) => tool.name === name);
  if (writeTool) return executeRegistryTool(env, writeTool.name, input, { description: writeTool.description, riskLevel: writeTool.riskLevel });
  // Fuera del catálogo del usuario: nunca se ejecuta (ni siquiera se consulta el registro).
  const message = `La herramienta «${name}» no está disponible para este usuario en esta superficie.`;
  env.notices.push(message);
  return { name, status: "denied", ok: false, source: name, summary: `(${name}: no disponible)`, modelContent: message };
}

async function answerByModel(env: TurnEnv, question: string, screen: AssistantScreenContext | null, history: AiMessage[], usage: UsageAccumulator): Promise<PathResult> {
  const ai = env.deps.getAiCore();
  const system = await ai.promptFrom(promptCodeFor(env.surface), fallbackPromptFor(env.surface));
  const aiCtx: AiContext = {
    organizationId: env.context.organizationId,
    propertyId: env.context.propertyId,
    userId: env.context.userId,
    toolName: ASSISTANT_TURN_TOOL_NAME,
    purpose: "complete",
    correlationId: env.correlationId,
    ...(env.conversationId ? { conversationId: env.conversationId } : {})
  };
  const tools = modelToolsOf(env);
  const messages: AiMessage[] = [...history, { role: "user", content: composeUserMessage(question, screen) }];
  const executions: ToolExecution[] = [];
  let lastText = "";

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
    let result;
    try {
      result = await ai.complete({ system, messages, maxTokens: MODEL_MAX_TOKENS }, aiCtx, { tools, toolChoice: "auto" });
    } catch (error) {
      if (isAiError(error)) {
        addUsage(usage, error.telemetry);
        throw new RulesFallback(`El modelo no está disponible ahora mismo (${error.message}); he respondido por reglas.`);
      }
      throw error;
    }
    if (result.configured === false) {
      addUsage(usage, result.telemetry);
      throw new RulesFallback(`${result.message}; he respondido por reglas.`);
    }
    addUsage(usage, result);
    if (result.toolUses.length === 0) {
      return { answer: result.text.trim() || lastText || "El modelo no ha devuelto texto.", executions, modelAnswered: true };
    }
    lastText = result.text.trim();
    const assistantBlocks: AiContentBlock[] = [
      ...(lastText ? [{ type: "text", text: lastText } as AiContentBlock] : []),
      ...result.toolUses.map((use) => ({ type: "tool_use", id: use.id, name: use.name, input: use.input }) as AiContentBlock)
    ];
    messages.push({ role: "assistant", content: assistantBlocks });
    const resultBlocks: AiContentBlock[] = [];
    for (const use of result.toolUses) {
      let execution: ToolExecution;
      try {
        execution = await executeModelToolUse(env, use.name, use.input);
      } catch (error) {
        if (isBudgetOrRateLimit(error)) throw new RulesFallback(`${clipText(error.message, 200)} He respondido por reglas.`);
        const message = error instanceof Error ? error.message : String(error);
        execution = { name: use.name, status: "failed", ok: false, source: use.name, summary: `(${use.name}: ${clipText(message, 160)})`, modelContent: `Error al ejecutar ${use.name}: ${clipText(message, 400)}` };
      }
      executions.push(execution);
      resultBlocks.push(toolResultBlock(use.id, execution.modelContent || execution.summary, !execution.ok));
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  const gathered = executions.filter((execution) => execution.status !== "denied").map((execution) => `• ${execution.summary}`);
  const answer = [lastText || "He agotado los turnos de consulta con el modelo.", ...(gathered.length > 0 ? ["", "Esto es lo obtenido de las herramientas:", ...gathered] : [])].join("\n");
  return { answer, executions, modelAnswered: true };
}

// ---------------------------------------------------------------------------
// Turno
// ---------------------------------------------------------------------------

export type RunAssistantTurnInput = {
  context: UserContext;
  surface: AssistantSurface;
  question: string;
  conversationId?: string | null;
  screen?: AssistantScreenContext | unknown;
  correlationId: string;
  /** Prefijo de log de las herramientas locales del turno (p. ej. `copilot.ask` desde el alias); undefined = el del catálogo. */
  logScope?: string;
};

function redactText(value: string, redactor: PiiRedactor): string {
  const redacted = redactForTelemetry(value, redactor);
  return typeof redacted === "string" ? redacted : safeJson(redacted);
}

function citationOf(execution: ToolExecution): AssistantCitation {
  return {
    tool: execution.name,
    source: execution.source,
    ok: execution.ok,
    summary: execution.summary,
    ...(execution.aiToolCallId ? { aiToolCallId: execution.aiToolCallId } : {}),
    ...(execution.costEur !== undefined ? { costEur: execution.costEur } : {})
  };
}

function storedToolCallOf(citation: AssistantCitation): AssistantStoredToolCall {
  return { tool: citation.tool, source: citation.source, ok: citation.ok, summary: citation.summary, ...(citation.aiToolCallId ? { aiToolCallId: citation.aiToolCallId } : {}) };
}

function warn(event: string, correlationId: string, error: unknown): void {
  console.warn(`[assistant.core] ${event}`, { correlationId, error: error instanceof Error ? error.message : String(error) });
}

export async function runAssistantTurn(input: RunAssistantTurnInput): Promise<AssistantTurn> {
  const deps = currentDeps();
  const started = deps.now();
  const t0 = Date.now();
  const question = (input.question ?? "").replace(/\s+/g, " ").trim();
  if (!question) throw new BadRequestError("La pregunta no puede estar vacía.");
  if (question.length > MAX_QUESTION_CHARS) throw new BadRequestError(`La pregunta supera los ${MAX_QUESTION_CHARS} caracteres.`);
  if (!ASSISTANT_SURFACES.includes(input.surface)) throw new BadRequestError(`Superficie desconocida: ${String(input.surface)}.`);
  const screen = normalizeScreenContext(input.screen);
  const redactor = createPiiRedactor();
  const redactedQuestion = redactText(question, redactor);

  // (a) memoria: la conversación del usuario en esta propiedad (404 opaco si el id es ajeno).
  let conversation: AssistantConversationRecord | null = null;
  try {
    conversation = await openAssistantConversation({
      organizationId: input.context.organizationId,
      propertyId: input.context.propertyId,
      userId: input.context.userId,
      surface: input.surface,
      conversationId: input.conversationId ?? null,
      screen,
      question: redactedQuestion
    });
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    warn("memory open failed; answering without memory", input.correlationId, error);
  }
  let history: AiMessage[] = [];
  if (conversation) {
    try {
      history = memoryToModelMessages(await recentAssistantMessages(conversation.id));
    } catch (error) {
      warn("memory read failed; answering without history", input.correlationId, error);
    }
  }

  // Superficie efectiva (REV-05): con conversación guardada manda la suya (catálogo, prompt y turno).
  const surface = effectiveSurface(conversation, input.surface);
  const env: TurnEnv = {
    deps,
    context: input.context,
    surface,
    correlationId: input.correlationId,
    conversationId: conversation?.id ?? null,
    readTools: deps.catalogFor({ context: input.context, surface }),
    writeTools: deps.writeToolsFor({ context: input.context, surface }),
    redactor,
    pending: [],
    notices: [],
    ...(input.logScope ? { logScope: input.logScope } : {})
  };
  const usage: UsageAccumulator = { model: null, tokensInput: 0, tokensOutput: 0, costEur: null, calls: 0 };

  // (b)/(c) reglas sin proveedor; modelo con proveedor (tras la puerta de propiedad) y respaldo por reglas con aviso.
  let path: PathResult;
  let routedBy: AssistantRoutedBy = "rules";
  const ai = deps.getAiCore();
  if (ai.isConfigured()) {
    const gate = await deps.propertyGate({ organizationId: input.context.organizationId, propertyId: input.context.propertyId, toolName: ASSISTANT_TURN_TOOL_NAME });
    if (!gate.allowed) {
      env.notices.push(gate.notice);
      path = await answerByRules(env, question);
    } else {
      try {
        path = await answerByModel(env, question, screen, history, usage);
        routedBy = "model";
      } catch (error) {
        if (!(error instanceof RulesFallback)) throw error;
        env.notices.push(error.notice);
        path = await answerByRules(env, question);
      }
    }
  } else {
    path = await answerByRules(env, question);
  }

  const notices = Array.from(new Set(env.notices));
  const answer = notices.length > 0 ? `${path.answer}\n\n${notices.map((notice) => `Aviso: ${notice}`).join("\n")}` : path.answer;
  // Citas = lecturas intentadas (ejecutadas, fallidas o con entrada inválida); las propuestas pendientes van en
  // pendingToolCalls y las denegaciones en notices.
  const cited = path.executions.filter((execution) => execution.status !== "awaiting_confirmation" && execution.status !== "denied");
  const citations = cited.map(citationOf);
  const mode = deriveAssistantMode([...cited.map((execution) => ({ result: { ok: execution.ok } })), ...(path.modelAnswered ? [{ result: { ok: true, modelAnswered: true } }] : [])]);
  const cost: AssistantCost =
    usage.calls === 0 ? { model: null, tokensInput: 0, tokensOutput: 0, eur: 0 } : { model: usage.model, tokensInput: usage.tokensInput, tokensOutput: usage.tokensOutput, eur: usage.costEur };
  const generatedAt = deps.now().toISOString();

  const turn: AssistantTurn = {
    question,
    answer,
    toolCalls: citations.map((citation) => ({ name: citation.tool, ok: citation.ok, source: citation.source, summary: citation.summary })),
    mode,
    generatedAt,
    correlationId: input.correlationId,
    surface,
    conversationId: conversation?.id ?? null,
    routedBy,
    citations,
    cost,
    pendingToolCalls: env.pending,
    notices
  };

  // (a) memoria: pregunta y respuesta redactadas (el cifrado en reposo lo aplica la extensión de Prisma).
  if (conversation) {
    const redactedAnswer = redactText(answer, redactor);
    const userAt = started;
    const assistantAt = new Date(Math.max(deps.now().getTime(), userAt.getTime() + 1));
    try {
      await appendAssistantMessage({ conversationId: conversation.id, role: "user", content: redactedQuestion, createdAt: userAt });
      await appendAssistantMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: redactedAnswer,
        toolCalls: citations.map(storedToolCallOf),
        routedBy,
        model: cost.model,
        tokensInput: cost.tokensInput,
        tokensOutput: cost.tokensOutput,
        costEur: cost.eur,
        createdAt: assistantAt
      });
    } catch (error) {
      warn("memory write failed", input.correlationId, error);
    }
  }

  // (d) una fila answerAnalyticsQuestion por turno (telemetría; un fallo nunca rompe la respuesta).
  const row: RecordToolCallInput = {
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    userId: input.context.userId,
    ...(conversation ? { conversationId: conversation.id } : {}),
    toolName: ASSISTANT_TURN_TOOL_NAME,
    status: "succeeded",
    // Nunca el texto de la pregunta (REV-02): el redactor no reconoce nombres sin tratamiento y la fila es append-only.
    inputJson: redactForTelemetry({ ...questionFingerprint(question), surface, conversationId: conversation?.id ?? null, screen }, redactor),
    outputJson: redactForTelemetry(
      { routedBy, mode, toolCalls: turn.toolCalls, citations, pendingToolCalls: env.pending.map((p) => ({ id: p.id, toolName: p.toolName })), notices, answerChars: answer.length },
      redactor
    ),
    latencyMs: Date.now() - t0,
    automationLevel: "suggest",
    tokensInput: cost.tokensInput ?? 0,
    tokensOutput: cost.tokensOutput ?? 0,
    ...(cost.model ? { model: cost.model } : {}),
    // AI-CORE §6: sin llamada → 0; hubo llamada sin coste calculable → columna NULL.
    ...(cost.eur !== null ? { costEur: cost.eur } : {})
  };
  try {
    await deps.recordToolCall(row);
  } catch (error) {
    warn("telemetry insert failed", input.correlationId, error);
  }
  return turn;
}
