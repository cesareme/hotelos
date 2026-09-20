// Frontend client for the conversational AI Assistant («Asistente ehotelOS»).
//
// Tanda L6b · asistente unificado: the v2 contract (memoria por conversación,
// enrutado por intención, citas y coste por respuesta, escrituras pendientes
// de aprobación) is ADDITIVE over the v1 turn that `/assistant/chat` returns
// today: every v2 field of `AssistantTurn` is optional, so the standalone
// AssistantChatScreen keeps working against the current API and the panel
// (components/assistant) reads the v2 fields when the backend sends them.
//
//   POST   /assistant/chat                   { question, conversationId?, surface?, screen? } → AssistantTurn
//   GET    /assistant/conversations          [AssistantConversationSummary] (o envelope { items })
//   GET    /assistant/conversations/:id      AssistantConversation (con mensajes)
//   DELETE /assistant/conversations/:id      204
//   GET    /assistant/pending                [AssistantPendingToolCall] (o envelope { items })
//   POST   /ai/tool-calls/:id/confirm        { decision, notes? } → AssistantConfirmResult (Tanda L6a)
//   GET    /assistant/tools                  { items: AssistantTool[] } (v1)
//
// Everything goes through `apiRequest` (tests/admin-web-no-raw-fetch): the
// active property header and the session token are added there.

import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";

export type AssistantToolCall = {
  name: string;
  ok: boolean;
  source: string;
  summary: string;
};

/** v1 answer mode (kept): `deterministic` = rules over the PMS data, `llm` = a language model answered. */
export type AssistantMode = "deterministic" | "llm";

/** v2 routing label: who produced the answer (badge «Por reglas» / «Modelo»). */
export type AssistantRoutedBy = "rules" | "model";

/**
 * Surfaces of the unified assistant (mirror of `AssistantSurface` in
 * apps/api/src/modules/assistant/assistant-catalog.ts): one core, one prompt
 * and permission set per surface. `guest` belongs to the guest bot (no staff
 * suggestions); the back-office panel uses `backoffice` / `reception`.
 */
export type AssistantSurface = "backoffice" | "reception" | "guest";

export const ASSISTANT_SURFACES: readonly AssistantSurface[] = ["backoffice", "reception", "guest"];

/** Entity the active screen is about: type + id only (never a name, never a query string). */
export type AssistantScreenEntity = { type: string; id: string };

/** Context of the page the question was asked from (built by components/assistant/assistant-context.ts). */
export type AssistantScreenContext = {
  screenKey: string;
  url: string;
  entity?: AssistantScreenEntity;
  /** Ids of the ⌘K page commands the screen offers (no labels). */
  commands?: string[];
};

/** One citation of an answer: tool · source · cost (null/0 = «sin coste»). */
export type AssistantCitation = {
  tool: string;
  source: string;
  costEur?: number | null;
  ok?: boolean;
  summary?: string;
};

/** Cost of a turn (EUR; null when the model answered without usage or without AI_USD_EUR_RATE). */
export type AssistantCost = {
  eur: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  model?: string | null;
};

export type AssistantRiskLevel = "low" | "medium" | "high" | "critical";

/** A write the assistant proposed and the tool runner left `awaiting_confirmation` (HITL, Tanda L6a). */
export type AssistantPendingToolCall = {
  id: string;
  toolName: string;
  summary?: string | null;
  riskLevel?: AssistantRiskLevel | null;
  createdAt: string;
  conversationId?: string | null;
  correlationId?: string | null;
  /** Redacted input (no PII): shown as-is when present. */
  input?: Record<string, unknown> | null;
};

export type AssistantTurn = {
  question: string;
  answer: string;
  toolCalls: AssistantToolCall[];
  mode: AssistantMode;
  generatedAt: string;
  correlationId: string;
  // ---- v2 (optional: absent while the API answers v1) ----
  conversationId?: string | null;
  routedBy?: AssistantRoutedBy | null;
  citations?: AssistantCitation[];
  cost?: AssistantCost | null;
  pendingToolCalls?: AssistantPendingToolCall[];
};

/** `assistant_conversations.status` (migración `20260920170000_asistente_unificado`: String, default `open`; vocabulario open | archived). */
export type AssistantConversationStatus = "open" | "archived";

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  surface: AssistantSurface | string;
  status: AssistantConversationStatus | string;
  lastMessageAt: string | null;
  createdAt?: string;
  messageCount?: number;
};

export type AssistantMessageRole = "user" | "assistant" | "tool" | "system";

/**
 * Citation as it is STORED with a message (`assistant_messages.tool_calls_json`, mirror of
 * `AssistantStoredToolCall` in apps/api/src/modules/assistant/assistant-memory.service.ts and of
 * `GET /assistant/conversations/:id` in docs/api-contracts.md): `tool`, not `name`.
 */
export type AssistantStoredToolCall = {
  tool: string;
  source: string;
  ok?: boolean;
  summary?: string;
  aiToolCallId?: string;
};

export type AssistantMessage = {
  id: string;
  role: AssistantMessageRole;
  content: string;
  createdAt: string;
  routedBy?: AssistantRoutedBy | null;
  /** Stored citations of an assistant message (never the live `AssistantToolCall` shape: see `turnsFromMessages`). */
  toolCalls?: AssistantStoredToolCall[];
  citations?: AssistantCitation[];
  cost?: AssistantCost | null;
  correlationId?: string | null;
};

export type AssistantConversation = AssistantConversationSummary & {
  messages: AssistantMessage[];
  screenContext?: AssistantScreenContext | null;
};

export type AssistantAskInput = {
  question: string;
  conversationId?: string | null;
  surface?: AssistantSurface;
  screen?: AssistantScreenContext;
};

export type AssistantToolCallDecision = "approve" | "reject";

/** Mirror of `ConfirmToolResult` (packages/ai-core/src/runner/types.ts). */
export type AssistantConfirmResult =
  | { status: "succeeded"; toolCallId: string; output: unknown; configured: boolean }
  | { status: "failed"; toolCallId: string; reason: string; message: string }
  | { status: "rejected"; toolCallId: string };

export type AssistantTool = {
  name: string;
  description: string;
  keywords: string[];
};

/** Body of `POST /assistant/chat` (pure): only the keys with a value travel, so the v1 API sees `{ question }` alone. */
export function assistantAskBody(input: string | AssistantAskInput): AssistantAskInput {
  const source: AssistantAskInput = typeof input === "string" ? { question: input } : input;
  const body: AssistantAskInput = { question: source.question.trim() };
  if (source.conversationId) body.conversationId = source.conversationId;
  if (source.surface) body.surface = source.surface;
  if (source.screen) body.screen = source.screen;
  return body;
}

/** Who answered (pure): the v2 `routedBy`, else derived from the v1 `mode` (`llm` → model, otherwise rules). */
export function routedByOf(turn: Pick<AssistantTurn, "mode" | "routedBy">): AssistantRoutedBy {
  if (turn.routedBy === "rules" || turn.routedBy === "model") return turn.routedBy;
  return turn.mode === "llm" ? "model" : "rules";
}

/** `AssistantSurface` guard for values that arrive from events, URLs or the API. */
export function isAssistantSurface(value: unknown): value is AssistantSurface {
  return typeof value === "string" && (ASSISTANT_SURFACES as readonly string[]).includes(value);
}

export function askAssistant(input: string | AssistantAskInput): Promise<AssistantTurn> {
  return apiRequest<AssistantTurn>("/assistant/chat", { method: "POST", body: assistantAskBody(input) });
}

export async function listConversations(options: { surface?: AssistantSurface; signal?: AbortSignal } = {}): Promise<AssistantConversationSummary[]> {
  const res = await apiRequest<unknown>("/assistant/conversations", {
    query: options.surface ? { surface: options.surface } : undefined,
    signal: options.signal
  });
  return toArray<AssistantConversationSummary>(res);
}

export function getConversation(conversationId: string, signal?: AbortSignal): Promise<AssistantConversation> {
  return apiRequest<AssistantConversation>(`/assistant/conversations/${encodeURIComponent(conversationId)}`, { signal });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await apiRequest<unknown>(`/assistant/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
}

export async function listPending(signal?: AbortSignal): Promise<AssistantPendingToolCall[]> {
  const res = await apiRequest<unknown>("/assistant/pending", { signal });
  return toArray<AssistantPendingToolCall>(res);
}

export function confirmToolCall(toolCallId: string, decision: AssistantToolCallDecision, notes?: string): Promise<AssistantConfirmResult> {
  return apiRequest<AssistantConfirmResult>(`/ai/tool-calls/${encodeURIComponent(toolCallId)}/confirm`, {
    method: "POST",
    body: notes ? { decision, notes } : { decision }
  });
}

export async function fetchAssistantTools(): Promise<AssistantTool[]> {
  const res = await apiRequest<{ items: AssistantTool[] }>("/assistant/tools");
  return res.items;
}
