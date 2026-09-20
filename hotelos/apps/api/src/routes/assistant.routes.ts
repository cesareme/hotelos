// Assistant bounded context — segundo plugin Fastify (P1-16; patrón de webhooks.routes.ts).
//
// Tanda L6b (L6b-06): rutas HTTP del asistente unificado sobre el núcleo conversacional
// único (modules/assistant/assistant-core.service.ts, L6b-05) y la memoria por usuario
// (assistant-memory.service.ts). Contrato completo en docs/api-contracts.md
// («Asistente unificado (Tanda L6b · 2026-09-20)»); manifiesto en security/route-permissions.ts.
//
//   GET    /assistant/tools?surface=          catálogo que ESTE usuario ve en ESA superficie
//                                             (visibleCatalogFor: RBAC + superficie + módulos
//                                             activos) y las preguntas sugeridas que responde por
//                                             reglas (nunca se sugiere lo que no puede contestar)
//   POST   /assistant/chat                    { question, conversationId?, surface?, screen? } →
//                                             AssistantTurn v2 (400 con pregunta vacía; 404 opaco
//                                             con conversationId ajeno o propiedad fuera de ámbito)
//   GET    /assistant/conversations?surface=  { items } del usuario en la propiedad activa
//   GET    /assistant/conversations/:id       conversación con sus mensajes (solo del propio usuario)
//   DELETE /assistant/conversations/:id       204 (los mensajes caen por la FK en cascada)
//   GET    /assistant/pending                 { items } escrituras propuestas desde las
//                                             conversaciones del usuario en la propiedad activa que
//                                             el runner dejó awaiting_confirmation (ai_tool_calls);
//                                             se deciden con POST /ai/tool-calls/:id/confirm
//
// Tenencia: la propiedad activa es la de request.userContext (parámetro → cabecera
// x-property-id → primera asignada; una cabecera fuera de ámbito ya es el 404 opaco del hook
// de server.ts). Las rutas por id pasan por assertEntityAccess con el resolver
// `assistantConversation` (lib/tenancy.ts): solo resuelve filas del PROPIO usuario y la
// propiedad de la FILA manda sobre la cabecera; lo demás es «Conversación no encontrada.».
// Dependencias inyectables (resetAssistantRoutesForTests) para el test del plugin sin Prisma.

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createPiiRedactor } from "@hotelos/ai-core";
import { redactForTelemetry } from "@hotelos/ai-core/runner";
import { getToolDefinition } from "@hotelos/ai-tools";
import type { HotelOsToolName, ToolDefinition } from "@hotelos/ai-tools";
import { OBSERVABILITY_HEADERS } from "@hotelos/config";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { RiskLevel } from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../lib/http-error.js";
import { createId } from "../lib/ids.js";
import { assertEntityAccess } from "../lib/tenancy.js";
import type { EntityOwner, TenantRequest } from "../lib/tenancy.js";
import { AI_TOOL_IMPLEMENTATIONS } from "../modules/ai-operations/tools/index.js";
import { ASSISTANT_SURFACES } from "../modules/assistant/assistant-catalog.js";
import type { AssistantSurface, AssistantTool } from "../modules/assistant/assistant-catalog.js";
import { visibleCatalogFor } from "../modules/assistant/assistant-core.service.js";
import type { AssistantPendingToolCall } from "../modules/assistant/assistant-core.service.js";
import {
  ASSISTANT_CONVERSATION_NOT_FOUND,
  ASSISTANT_CONVERSATIONS_LIST_MAX,
  deleteAssistantConversation,
  getAssistantConversation,
  listAssistantConversations
} from "../modules/assistant/assistant-memory.service.js";
import { suggestedQuestionsFor } from "../modules/assistant/assistant-router.js";
import type { SuggestedQuestion } from "../modules/assistant/assistant-router.js";
import { answerQuestion } from "../modules/assistant/assistant.service.js";

/** Escrituras pendientes que devuelve GET /assistant/pending (las más recientes). */
export const ASSISTANT_PENDING_MAX = 100;
/** Conversaciones por defecto en GET /assistant/conversations (máximo ASSISTANT_CONVERSATIONS_LIST_MAX). */
export const ASSISTANT_CONVERSATIONS_DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Contrato wire (el panel lo lee en apps/admin-web/src/services/assistantApi.ts)
// ---------------------------------------------------------------------------

export type AssistantToolListItem = {
  name: string;
  description: string;
  keywords: string[];
  kind: AssistantTool["kind"];
  origin: AssistantTool["origin"];
  /** Riesgo de la definición del registro; las lecturas locales son `low`. */
  riskLevel: RiskLevel;
};

export type AssistantToolsResponse = { surface: AssistantSurface; items: AssistantToolListItem[]; suggestedQuestions: SuggestedQuestion[] };

export type AssistantChatBody = { question: string; conversationId: string | null; surface: AssistantSurface; screen: unknown };

/** Fila de ai_tool_calls awaiting_confirmation tal como la ve el panel (la fila no guarda correlationId: null). */
export type AssistantPendingItem = Omit<AssistantPendingToolCall, "correlationId"> & { correlationId: string | null };

export type AssistantPendingScope = { organizationId: string; propertyId: string; userId: string };

/** Columnas de ai_tool_calls que necesita toPendingToolCall. */
export type AssistantPendingRow = { id: string; toolName: string; inputJson: unknown; conversationId: string | null; createdAt: Date };

// ---------------------------------------------------------------------------
// Funciones puras (assistant-routes.test.mts)
// ---------------------------------------------------------------------------

/** `surface` de query o body: ausente → `fallback` (backoffice); fuera de ASSISTANT_SURFACES → 400. */
export function parseAssistantSurface(value: unknown, fallback: AssistantSurface = "backoffice"): AssistantSurface {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (ASSISTANT_SURFACES as readonly string[]).includes(value)) return value as AssistantSurface;
  throw new BadRequestError(`Superficie desconocida: ${String(value)}. Usa ${ASSISTANT_SURFACES.join(" | ")}.`);
}

/** Cuerpo de POST /assistant/chat: pregunta obligatoria (400 vacía), conversationId opcional (string), surface por defecto backoffice, screen tal cual (el núcleo lo normaliza). */
export function parseAssistantChatBody(raw: unknown): AssistantChatBody {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const question = typeof body.question === "string" ? body.question.replace(/\s+/g, " ").trim() : "";
  if (!question) throw new BadRequestError("La pregunta no puede estar vacía.");
  let conversationId: string | null = null;
  if (body.conversationId !== undefined && body.conversationId !== null && body.conversationId !== "") {
    if (typeof body.conversationId !== "string") throw new BadRequestError("conversationId debe ser el identificador de una conversación.");
    conversationId = body.conversationId.trim();
  }
  return { question, conversationId, surface: parseAssistantSurface(body.surface), screen: body.screen };
}

function parseLimit(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return ASSISTANT_CONVERSATIONS_DEFAULT_LIMIT;
  return Math.min(ASSISTANT_CONVERSATIONS_LIST_MAX, Math.max(1, Math.floor(n)));
}

function definitionOf(name: string): ToolDefinition | null {
  try {
    return getToolDefinition(name as HotelOsToolName);
  } catch {
    return null;
  }
}

function riskLevelOf(tool: AssistantTool): RiskLevel {
  if (tool.kind === "registry" && tool.registryName) return definitionOf(tool.registryName)?.riskLevel ?? "low";
  return "low";
}

/** Vista pública de una herramienta del catálogo (sin `run`, sin permisos: ya filtrado). */
export function toToolListItem(tool: AssistantTool): AssistantToolListItem {
  return { name: tool.name, description: tool.description, keywords: [...tool.keywords], kind: tool.kind, origin: tool.origin, riskLevel: riskLevelOf(tool) };
}

/**
 * Fila awaiting_confirmation → ítem del panel. La fila pendiente conserva la entrada EJECUTABLE
 * (runner SEC-06: solo ella guarda inputJson sin redactar), así que aquí se redacta SIEMPRE
 * antes de salir (marcadores [NOMBRE_n]/[TEL_n]… sin mapa). `summary` = descripción en español
 * de la implementación (la del registro como respaldo); `riskLevel` = el de la definición.
 */
export function toPendingToolCall(row: AssistantPendingRow): AssistantPendingItem {
  const definition = definitionOf(row.toolName);
  const impl = AI_TOOL_IMPLEMENTATIONS[row.toolName];
  const hasInput = Boolean(row.inputJson) && typeof row.inputJson === "object" && !Array.isArray(row.inputJson) && Object.keys(row.inputJson as object).length > 0;
  const input = hasInput ? (redactForTelemetry(row.inputJson, createPiiRedactor()) as Record<string, unknown>) : null;
  return {
    id: row.id,
    toolName: row.toolName,
    summary: impl?.description ?? definition?.description ?? null,
    riskLevel: definition?.riskLevel ?? null,
    createdAt: row.createdAt.toISOString(),
    conversationId: row.conversationId,
    correlationId: null,
    input
  };
}

function memoryScope(context: UserContext): AssistantPendingScope {
  return { organizationId: context.organizationId, propertyId: context.propertyId, userId: context.userId };
}

function correlationIdOf(request: FastifyRequest): string {
  const raw = request.headers[OBSERVABILITY_HEADERS.correlationId];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : createId("corr");
}

// ---------------------------------------------------------------------------
// Pendientes (Prisma) y dependencias inyectables
// ---------------------------------------------------------------------------

/**
 * Filtro de los pendientes del usuario (puro): filas awaiting_confirmation sin reclamar de la propiedad activa cuyo
 * conversation_id es una conversación del usuario en esa propiedad O que el propio usuario propuso (user_id de la
 * fila): así una propuesta huérfana (conversación borrada después, o nacida sin conversationId) sigue siendo decidible
 * desde el panel por quien la lanzó (corrector L6b · REV-07, alternativa D6) sin abrirla a otros usuarios.
 */
export function pendingToolCallsWhere(scope: AssistantPendingScope, conversationIds: readonly string[]): Prisma.AiToolCallWhereInput {
  return {
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    status: "awaiting_confirmation",
    confirmedBy: null,
    OR: [...(conversationIds.length > 0 ? [{ conversationId: { in: [...conversationIds] } }] : []), { userId: scope.userId }]
  };
}

/**
 * Escrituras propuestas por el asistente que siguen awaiting_confirmation (sin reclamar) en la
 * propiedad activa: las de las conversaciones del usuario en esa propiedad (assistant_conversations;
 * ai_tool_calls.conversation_id no lleva FK) y las que él mismo propuso aunque la conversación ya no
 * exista (pendingToolCallsWhere). Privacidad como la memoria: una propuesta lanzada desde la
 * conversación de otro usuario no aparece, aunque la pueda confirmar por POST /ai/tool-calls/:id/confirm
 * si tiene los permisos.
 */
export async function listAssistantPendingToolCalls(scope: AssistantPendingScope): Promise<AssistantPendingItem[]> {
  const conversations = await prisma.assistantConversation.findMany({
    where: { organizationId: scope.organizationId, propertyId: scope.propertyId, userId: scope.userId },
    select: { id: true }
  });
  const rows = await prisma.aiToolCall.findMany({
    where: pendingToolCallsWhere(scope, conversations.map((conversation) => conversation.id)),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ASSISTANT_PENDING_MAX,
    select: { id: true, toolName: true, inputJson: true, conversationId: true, createdAt: true }
  });
  return rows.map(toPendingToolCall);
}

export type AssistantRouteDeps = {
  /** assertEntityAccess con el resolver `assistantConversation` (404 opaco si no es del usuario). */
  assertConversationAccess: (request: TenantRequest, id: string) => Promise<EntityOwner>;
  listPendingToolCalls: (scope: AssistantPendingScope) => Promise<AssistantPendingItem[]>;
};

function defaultDeps(): AssistantRouteDeps {
  return {
    assertConversationAccess: (request, id) => assertEntityAccess(request, { entity: "assistantConversation", id }),
    listPendingToolCalls: listAssistantPendingToolCalls
  };
}

let overrides: Partial<AssistantRouteDeps> | null = null;

function currentDeps(): AssistantRouteDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}

/** Sustituye dependencias (test del plugin sin Prisma). Sin argumento restaura las reales. */
export function resetAssistantRoutesForTests(deps?: Partial<AssistantRouteDeps>): void {
  overrides = deps ?? null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  app.get("/assistant/tools", async (request): Promise<AssistantToolsResponse> => {
    const surface = parseAssistantSurface((request.query as { surface?: unknown } | undefined)?.surface);
    const tools = visibleCatalogFor({ context: request.userContext, surface });
    return { surface, items: tools.map(toToolListItem), suggestedQuestions: suggestedQuestionsFor(surface, tools) };
  });

  app.post("/assistant/chat", async (request) => {
    const body = parseAssistantChatBody(request.body);
    return answerQuestion({
      context: request.userContext,
      question: body.question,
      conversationId: body.conversationId,
      surface: body.surface,
      screen: body.screen,
      correlationId: correlationIdOf(request)
    });
  });

  app.get("/assistant/conversations", async (request) => {
    const query = (request.query ?? {}) as { surface?: unknown; limit?: unknown };
    const surface = query.surface === undefined || query.surface === "" ? undefined : parseAssistantSurface(query.surface);
    const items = await listAssistantConversations({ ...memoryScope(request.userContext), ...(surface ? { surface } : {}), limit: parseLimit(query.limit) });
    return { items };
  });

  app.get("/assistant/conversations/:id", async (request) => {
    const { id } = request.params as { id: string };
    const owner = await currentDeps().assertConversationAccess(request, id);
    const conversation = await getAssistantConversation({
      organizationId: request.userContext.organizationId,
      propertyId: owner.propertyId ?? request.userContext.propertyId,
      userId: request.userContext.userId,
      conversationId: id
    });
    if (!conversation) throw new NotFoundError(ASSISTANT_CONVERSATION_NOT_FOUND);
    return conversation;
  });

  app.delete("/assistant/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const owner = await currentDeps().assertConversationAccess(request, id);
    const deleted = await deleteAssistantConversation({
      organizationId: request.userContext.organizationId,
      propertyId: owner.propertyId ?? request.userContext.propertyId,
      userId: request.userContext.userId,
      conversationId: id
    });
    if (!deleted) throw new NotFoundError(ASSISTANT_CONVERSATION_NOT_FOUND);
    return reply.code(204).send();
  });

  app.get("/assistant/pending", async (request) => {
    const items = await currentDeps().listPendingToolCalls(memoryScope(request.userContext));
    return { items };
  });
};
