// Memoria de conversación del asistente unificado (Tanda L6b · L6b-05) sobre las tablas de
// L6b-01: assistant_conversations (una por usuario + propiedad + superficie, con el contexto
// de pantalla con el que se abrió) y assistant_messages (FK ON DELETE CASCADE; `content`
// cifrado en reposo por la extensión Prisma, PII_FIELDS.AssistantMessage).
//
// Privacidad: TODA lectura y borrado se acota a (organizationId, propertyId, userId): una
// conversación de otro usuario, otra propiedad u otra organización no existe (null / 404
// opaco), aunque se conozca su id. Lo que se persiste pasa antes por el redactor del núcleo
// (redactForTelemetry: marcadores [NOMBRE_n], [TEL_n]… sin mapa), que cubre documentos,
// teléfonos, correos, tarjetas y nombres con tratamiento o fórmula de presentación, NO un
// nombre suelto («¿Tiene reserva Nombre Apellido?»): por eso `title` (primera pregunta) va
// cifrado en reposo igual que `content` (PII_FIELDS.AssistantConversation, corrector L6b ·
// REV-02) y screen_context_json solo admite ids seguros (normalizeScreenContext).
//
// Retención (L6B-REV-07): purgeAssistantConversations borra las conversaciones (y sus mensajes
// por la FK en cascada) con last_message_at anterior a ASSISTANT_RETENTION_DAYS (90); el
// scheduler de server.ts la ejecuta bajo el líder. eraseAssistantConversationsOfUsers borra
// las de los actores `guest:<conversationId>` en la supresión RGPD (gdpr.service.ts).
//
// Contexto del modelo: los últimos ASSISTANT_MEMORY_WINDOW (10) mensajes en orden cronológico
// (memoryToModelMessages los convierte en turnos user/assistant contiguos fusionados).
// Dependencias inyectables (AssistantMemoryStore, resetAssistantMemoryForTests): los tests
// usan createInMemoryAssistantMemoryStore, sin Prisma.

import type { AiMessage } from "@hotelos/ai-core";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { NotFoundError } from "../../lib/http-error.js";
import type { AssistantSurface } from "./assistant-catalog.js";
import type { AssistantScreenContext } from "./assistant-prompts.js";

export const ASSISTANT_MEMORY_WINDOW = 10;
export const ASSISTANT_TITLE_MAX = 80;
/** Mensajes que devuelve getAssistantConversation (los más recientes). */
export const ASSISTANT_CONVERSATION_MESSAGES_MAX = 200;
export const ASSISTANT_CONVERSATIONS_LIST_MAX = 50;
/** Retención por defecto de la memoria del asistente (días desde last_message_at; decisión D5 del informe L6b). */
export const ASSISTANT_RETENTION_DAYS = 90;

export const ASSISTANT_CONVERSATION_NOT_FOUND = "Conversación no encontrada.";

export type AssistantMessageRole = "user" | "assistant" | "tool";
export type AssistantRoutedBy = "rules" | "model";
export type AssistantConversationStatus = "open" | "archived";

/** Cita persistida en tool_calls_json del mensaje del asistente. */
export type AssistantStoredToolCall = {
  tool: string;
  source: string;
  ok?: boolean;
  summary?: string;
  aiToolCallId?: string;
};

export type AssistantConversationRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  userId: string;
  surface: AssistantSurface | string;
  title: string;
  screenContext: AssistantScreenContext | null;
  status: AssistantConversationStatus | string;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type AssistantMessageRecord = {
  id: string;
  conversationId: string;
  role: AssistantMessageRole | string;
  content: string;
  toolCalls: AssistantStoredToolCall[];
  routedBy: AssistantRoutedBy | string | null;
  model: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costEur: number | null;
  createdAt: Date;
};

export type AssistantConversationSummary = {
  id: string;
  title: string;
  surface: string;
  status: string;
  lastMessageAt: string;
  createdAt: string;
  messageCount: number;
};

export type AssistantConversationView = AssistantConversationSummary & {
  screenContext: AssistantScreenContext | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
    routedBy: string | null;
    toolCalls: AssistantStoredToolCall[];
    cost: { model: string | null; tokensInput: number | null; tokensOutput: number | null; eur: number | null } | null;
  }>;
};

// ---------------------------------------------------------------------------
// Store (port) y sus dos implementaciones
// ---------------------------------------------------------------------------

export type AssistantMemoryScope = { organizationId: string; propertyId: string; userId: string };

export type NewAssistantConversation = AssistantMemoryScope & { surface: string; title: string; screenContext: AssistantScreenContext | null };

export type NewAssistantMessage = {
  conversationId: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls?: AssistantStoredToolCall[];
  routedBy?: AssistantRoutedBy | null;
  model?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  costEur?: number | null;
  createdAt?: Date;
};

export type AssistantMemoryStore = {
  findConversation(id: string): Promise<AssistantConversationRecord | null>;
  createConversation(data: NewAssistantConversation): Promise<AssistantConversationRecord>;
  updateConversation(id: string, patch: { lastMessageAt?: Date; screenContext?: AssistantScreenContext | null; status?: string }): Promise<void>;
  listConversations(scope: AssistantMemoryScope, options: { surface?: string; limit: number }): Promise<Array<AssistantConversationRecord & { messageCount: number }>>;
  deleteConversation(id: string): Promise<void>;
  /** Borra (con sus mensajes) las conversaciones con last_message_at anterior a `cutoff`; devuelve cuántas. */
  deleteConversationsBefore(cutoff: Date): Promise<number>;
  /** Borra (con sus mensajes) las conversaciones de esos user_id en la organización; devuelve cuántas. */
  deleteConversationsOfUsers(scope: { organizationId: string; userIds: readonly string[] }): Promise<number>;
  createMessage(data: NewAssistantMessage): Promise<AssistantMessageRecord>;
  /** Los `limit` más recientes, en orden cronológico ascendente. */
  listRecentMessages(conversationId: string, limit: number): Promise<AssistantMessageRecord[]>;
  countMessages(conversationId: string): Promise<number>;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function toolCallsFromJson(value: unknown): AssistantStoredToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      tool: String(item.tool ?? ""),
      source: String(item.source ?? ""),
      ...(typeof item.ok === "boolean" ? { ok: item.ok } : {}),
      ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
      ...(typeof item.aiToolCallId === "string" ? { aiToolCallId: item.aiToolCallId } : {})
    }));
}

function screenContextFromJson(value: unknown): AssistantScreenContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.screenKey !== "string" || !raw.screenKey) return null;
  return raw as unknown as AssistantScreenContext;
}

type ConversationRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  userId: string;
  surface: string;
  title: string;
  screenContextJson: unknown;
  status: string;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type MessageRow = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolCallsJson: unknown;
  routedBy: string | null;
  model: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costEur: unknown;
  createdAt: Date;
};

function mapConversation(row: ConversationRow): AssistantConversationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    userId: row.userId,
    surface: row.surface,
    title: row.title,
    screenContext: screenContextFromJson(row.screenContextJson),
    status: row.status,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapMessage(row: MessageRow): AssistantMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    toolCalls: toolCallsFromJson(row.toolCallsJson),
    routedBy: row.routedBy,
    model: row.model,
    tokensInput: row.tokensInput,
    tokensOutput: row.tokensOutput,
    costEur: toNumber(row.costEur),
    createdAt: row.createdAt
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** Implementación Prisma (la extensión de cifrado actúa sobre AssistantMessage.content en create/find). */
export function createPrismaAssistantMemoryStore(): AssistantMemoryStore {
  return {
    async findConversation(id) {
      const row = await prisma.assistantConversation.findUnique({ where: { id } });
      return row ? mapConversation(row) : null;
    },
    async createConversation(data) {
      const row = await prisma.assistantConversation.create({
        data: {
          organizationId: data.organizationId,
          propertyId: data.propertyId,
          userId: data.userId,
          surface: data.surface,
          title: data.title,
          ...(data.screenContext ? { screenContextJson: toJson(data.screenContext) } : {})
        }
      });
      return mapConversation(row);
    },
    async updateConversation(id, patch) {
      await prisma.assistantConversation.update({
        where: { id },
        data: {
          ...(patch.lastMessageAt ? { lastMessageAt: patch.lastMessageAt } : {}),
          ...(patch.screenContext !== undefined ? { screenContextJson: patch.screenContext ? toJson(patch.screenContext) : { set: null } } : {}),
          ...(patch.status ? { status: patch.status } : {})
        }
      });
    },
    async listConversations(scope, options) {
      const rows = await prisma.assistantConversation.findMany({
        where: { organizationId: scope.organizationId, propertyId: scope.propertyId, userId: scope.userId, ...(options.surface ? { surface: options.surface } : {}) },
        orderBy: { lastMessageAt: "desc" },
        take: options.limit,
        include: { _count: { select: { messages: true } } }
      });
      return rows.map((row) => ({ ...mapConversation(row), messageCount: row._count.messages }));
    },
    async deleteConversation(id) {
      await prisma.assistantConversation.delete({ where: { id } });
    },
    async deleteConversationsBefore(cutoff) {
      // Los mensajes caen por la FK ON DELETE CASCADE de la migración _asistente_unificado.
      const result = await prisma.assistantConversation.deleteMany({ where: { lastMessageAt: { lt: cutoff } } });
      return result.count;
    },
    async deleteConversationsOfUsers(scope) {
      if (scope.userIds.length === 0) return 0;
      const result = await prisma.assistantConversation.deleteMany({ where: { organizationId: scope.organizationId, userId: { in: [...scope.userIds] } } });
      return result.count;
    },
    async createMessage(data) {
      const row = await prisma.assistantMessage.create({
        data: {
          conversationId: data.conversationId,
          role: data.role,
          content: data.content,
          ...(data.toolCalls && data.toolCalls.length > 0 ? { toolCallsJson: toJson(data.toolCalls) } : {}),
          ...(data.routedBy ? { routedBy: data.routedBy } : {}),
          ...(data.model ? { model: data.model } : {}),
          ...(typeof data.tokensInput === "number" ? { tokensInput: data.tokensInput } : {}),
          ...(typeof data.tokensOutput === "number" ? { tokensOutput: data.tokensOutput } : {}),
          ...(typeof data.costEur === "number" ? { costEur: data.costEur } : {}),
          ...(data.createdAt ? { createdAt: data.createdAt } : {})
        }
      });
      return mapMessage(row);
    },
    async listRecentMessages(conversationId, limit) {
      const rows = await prisma.assistantMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: limit });
      return rows.map(mapMessage).reverse();
    },
    countMessages(conversationId) {
      return prisma.assistantMessage.count({ where: { conversationId } });
    }
  };
}

/** Implementación en memoria (tests del núcleo y de la memoria, sin Prisma). */
export function createInMemoryAssistantMemoryStore(): AssistantMemoryStore & { conversations: AssistantConversationRecord[]; messages: AssistantMessageRecord[] } {
  const conversations: AssistantConversationRecord[] = [];
  const messages: AssistantMessageRecord[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${String(++seq).padStart(4, "0")}`;
  return {
    conversations,
    messages,
    async findConversation(id) {
      return conversations.find((row) => row.id === id) ?? null;
    },
    async createConversation(data) {
      const now = new Date();
      const row: AssistantConversationRecord = {
        id: nextId("conv"),
        organizationId: data.organizationId,
        propertyId: data.propertyId,
        userId: data.userId,
        surface: data.surface,
        title: data.title,
        screenContext: data.screenContext,
        status: "open",
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now
      };
      conversations.push(row);
      return row;
    },
    async updateConversation(id, patch) {
      const row = conversations.find((item) => item.id === id);
      if (!row) return;
      if (patch.lastMessageAt) row.lastMessageAt = patch.lastMessageAt;
      if (patch.screenContext !== undefined) row.screenContext = patch.screenContext;
      if (patch.status) row.status = patch.status;
      row.updatedAt = new Date();
    },
    async listConversations(scope, options) {
      return conversations
        .filter((row) => row.organizationId === scope.organizationId && row.propertyId === scope.propertyId && row.userId === scope.userId && (!options.surface || row.surface === options.surface))
        .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
        .slice(0, options.limit)
        .map((row) => ({ ...row, messageCount: messages.filter((message) => message.conversationId === row.id).length }));
    },
    async deleteConversation(id) {
      const index = conversations.findIndex((row) => row.id === id);
      if (index >= 0) conversations.splice(index, 1);
      for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.conversationId === id) messages.splice(i, 1);
    },
    async deleteConversationsBefore(cutoff) {
      const doomed = conversations.filter((row) => row.lastMessageAt.getTime() < cutoff.getTime()).map((row) => row.id);
      for (const id of doomed) await this.deleteConversation(id);
      return doomed.length;
    },
    async deleteConversationsOfUsers(scope) {
      const doomed = conversations.filter((row) => row.organizationId === scope.organizationId && scope.userIds.includes(row.userId)).map((row) => row.id);
      for (const id of doomed) await this.deleteConversation(id);
      return doomed.length;
    },
    async createMessage(data) {
      const row: AssistantMessageRecord = {
        id: nextId("msg"),
        conversationId: data.conversationId,
        role: data.role,
        content: data.content,
        toolCalls: data.toolCalls ?? [],
        routedBy: data.routedBy ?? null,
        model: data.model ?? null,
        tokensInput: data.tokensInput ?? null,
        tokensOutput: data.tokensOutput ?? null,
        costEur: data.costEur ?? null,
        createdAt: data.createdAt ?? new Date(Date.now() + seq)
      };
      messages.push(row);
      return row;
    },
    async listRecentMessages(conversationId, limit) {
      const rows = messages.filter((row) => row.conversationId === conversationId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      return rows.slice(Math.max(0, rows.length - limit));
    },
    async countMessages(conversationId) {
      return messages.filter((row) => row.conversationId === conversationId).length;
    }
  };
}

let storeOverride: AssistantMemoryStore | null = null;
let prismaStore: AssistantMemoryStore | null = null;

function currentStore(): AssistantMemoryStore {
  if (storeOverride) return storeOverride;
  prismaStore ??= createPrismaAssistantMemoryStore();
  return prismaStore;
}

/** Sustituye el almacén (tests sin Prisma). Sin argumento restaura el real. */
export function resetAssistantMemoryForTests(store?: AssistantMemoryStore): void {
  storeOverride = store ?? null;
}

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

/** Título = primera pregunta recortada (espacios colapsados, máximo ASSISTANT_TITLE_MAX caracteres con «…»). */
export function titleFromQuestion(question: string): string {
  const text = (question ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Conversación";
  return text.length > ASSISTANT_TITLE_MAX ? `${text.slice(0, ASSISTANT_TITLE_MAX - 1).trimEnd()}…` : text;
}

function ownedBy(row: AssistantConversationRecord | null, scope: AssistantMemoryScope): row is AssistantConversationRecord {
  return Boolean(row) && row!.organizationId === scope.organizationId && row!.propertyId === scope.propertyId && row!.userId === scope.userId;
}

/**
 * Últimos mensajes → turnos del modelo: solo `user` y `assistant` (los `tool`, si los hubiera,
 * son traza), contiguos del mismo rol fusionados en un único bloque (el proveedor exige
 * alternancia) y sin arrancar por `assistant`.
 */
export function memoryToModelMessages(messages: readonly AssistantMessageRecord[]): AiMessage[] {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content.trim();
    if (!content) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      turns.push({ role: message.role, content });
    }
  }
  while (turns.length > 0 && turns[0]!.role === "assistant") turns.shift();
  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
}

function summaryOf(row: AssistantConversationRecord & { messageCount: number }): AssistantConversationSummary {
  return {
    id: row.id,
    title: row.title,
    surface: row.surface,
    status: row.status,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    messageCount: row.messageCount
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type OpenAssistantConversationInput = AssistantMemoryScope & {
  surface: AssistantSurface;
  /** Conversación existente del MISMO usuario y propiedad; otra → 404 opaco. */
  conversationId?: string | null;
  screen?: AssistantScreenContext | null;
  /** Primera pregunta (título) cuando se crea; ya redactada por el llamador. */
  question: string;
};

/** Abre (o crea) la conversación del turno. Con `conversationId` ajeno o inexistente → NotFoundError (404 opaco). */
export async function openAssistantConversation(input: OpenAssistantConversationInput): Promise<AssistantConversationRecord> {
  const store = currentStore();
  const scope: AssistantMemoryScope = { organizationId: input.organizationId, propertyId: input.propertyId, userId: input.userId };
  const conversationId = (input.conversationId ?? "").trim();
  if (conversationId) {
    const existing = await store.findConversation(conversationId);
    if (!ownedBy(existing, scope)) throw new NotFoundError(ASSISTANT_CONVERSATION_NOT_FOUND);
    if (input.screen && JSON.stringify(input.screen) !== JSON.stringify(existing.screenContext)) {
      await store.updateConversation(existing.id, { screenContext: input.screen });
      existing.screenContext = input.screen;
    }
    return existing;
  }
  return store.createConversation({ ...scope, surface: input.surface, title: titleFromQuestion(input.question), screenContext: input.screen ?? null });
}

/** Añade un mensaje y actualiza last_message_at. El contenido debe llegar ya redactado (redactForTelemetry). */
export async function appendAssistantMessage(input: NewAssistantMessage): Promise<AssistantMessageRecord> {
  const store = currentStore();
  const message = await store.createMessage(input);
  await store.updateConversation(input.conversationId, { lastMessageAt: message.createdAt });
  return message;
}

/** Los últimos `limit` (defecto 10) mensajes de la conversación en orden cronológico. */
export function recentAssistantMessages(conversationId: string, limit = ASSISTANT_MEMORY_WINDOW): Promise<AssistantMessageRecord[]> {
  return currentStore().listRecentMessages(conversationId, Math.max(1, limit));
}

export async function listAssistantConversations(input: AssistantMemoryScope & { surface?: AssistantSurface | string; limit?: number }): Promise<AssistantConversationSummary[]> {
  const limit = Math.min(ASSISTANT_CONVERSATIONS_LIST_MAX, Math.max(1, input.limit ?? 20));
  const rows = await currentStore().listConversations({ organizationId: input.organizationId, propertyId: input.propertyId, userId: input.userId }, { ...(input.surface ? { surface: input.surface } : {}), limit });
  return rows.map(summaryOf);
}

/** Conversación con sus mensajes (los ASSISTANT_CONVERSATION_MESSAGES_MAX más recientes); null si no es del usuario en esa propiedad. */
export async function getAssistantConversation(input: AssistantMemoryScope & { conversationId: string }): Promise<AssistantConversationView | null> {
  const store = currentStore();
  const row = await store.findConversation(input.conversationId);
  if (!ownedBy(row, input)) return null;
  const [messages, messageCount] = await Promise.all([store.listRecentMessages(row.id, ASSISTANT_CONVERSATION_MESSAGES_MAX), store.countMessages(row.id)]);
  return {
    ...summaryOf({ ...row, messageCount }),
    screenContext: row.screenContext,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      routedBy: message.routedBy,
      toolCalls: message.toolCalls,
      cost: message.role === "assistant" ? { model: message.model, tokensInput: message.tokensInput, tokensOutput: message.tokensOutput, eur: message.costEur } : null
    }))
  };
}

/** Borra la conversación (y sus mensajes por la FK en cascada) si es del usuario en esa propiedad; false si no existe para él. */
export async function deleteAssistantConversation(input: AssistantMemoryScope & { conversationId: string }): Promise<boolean> {
  const store = currentStore();
  const row = await store.findConversation(input.conversationId);
  if (!ownedBy(row, input)) return false;
  await store.deleteConversation(row.id);
  return true;
}

/** Fecha límite de la retención (pura): `now` menos `retentionDays` días (mínimo 1). */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  const days = Number.isFinite(retentionDays) && retentionDays >= 1 ? Math.floor(retentionDays) : ASSISTANT_RETENTION_DAYS;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Purga por retención (L6B-REV-07): borra toda conversación (de cualquier usuario, propiedad y superficie) cuyo
 * last_message_at sea anterior a `retentionDays` (defecto ASSISTANT_RETENTION_DAYS); los mensajes caen en cascada.
 */
export async function purgeAssistantConversations(input: { retentionDays?: number; now?: Date } = {}): Promise<{ cutoff: string; retentionDays: number; deleted: number }> {
  const retentionDays = Number.isFinite(input.retentionDays) && (input.retentionDays ?? 0) >= 1 ? Math.floor(input.retentionDays!) : ASSISTANT_RETENTION_DAYS;
  const cutoff = retentionCutoff(input.now ?? new Date(), retentionDays);
  const deleted = await currentStore().deleteConversationsBefore(cutoff);
  return { cutoff: cutoff.toISOString(), retentionDays, deleted };
}

/** Supresión RGPD: borra las conversaciones (y mensajes) de esos actores (`guest:<conversationId>`) en la organización. */
export function eraseAssistantConversationsOfUsers(input: { organizationId: string; userIds: readonly string[] }): Promise<number> {
  return currentStore().deleteConversationsOfUsers(input);
}
