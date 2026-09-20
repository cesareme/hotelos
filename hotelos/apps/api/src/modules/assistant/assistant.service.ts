// Asistente ehotelOS · fachada del chat (/assistant/chat).
//
// Tanda L6b (L6b-05): la lógica vive en el núcleo conversacional único
// (assistant-core.service.ts, runAssistantTurn) sobre @hotelos/ai-core: memoria por
// usuario y propiedad, catálogo filtrado por RBAC/superficie/módulos, enrutado por
// reglas sin proveedor y por el modelo (tool use) con proveedor, escrituras siempre
// awaiting_confirmation por el tool runner, y una fila answerAnalyticsQuestion por turno.
// `answerQuestion` delega con la superficie `backoffice` por defecto; el contrato
// (AssistantTurn v2, deriveAssistantMode) se re-exporta desde aquí para los llamadores
// históricos (assistant.routes.ts, server.ts, assistant-mode.test.mts).
//
// Diseño honesto: el modo `llm` solo se declara cuando un modelo ha respondido de
// verdad (deriveAssistantMode); sin clave el asistente responde por reglas y lo dice.

import { ASSISTANT_TOOLS } from "./assistant.tools.js";
import type { UserContext } from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { runAssistantTurn } from "./assistant-core.service.js";
import type { AssistantScreenContext, AssistantTurn } from "./assistant-core.service.js";
import type { AssistantSurface } from "./assistant-catalog.js";

export { deriveAssistantMode } from "./assistant-core.service.js";
export type { AssistantCitation, AssistantCost, AssistantPendingToolCall, AssistantRoutedBy, AssistantScreenContext, AssistantToolCallSummary, AssistantToolOutcome, AssistantTurn } from "./assistant-core.service.js";

export type AnswerQuestionInput = {
  context: UserContext;
  question: string;
  /** Conversación existente del usuario (memoria); sin ella se abre una nueva. */
  conversationId?: string | null;
  /** Defecto backoffice (el chat clásico); el panel pasa reception cuando procede. */
  surface?: AssistantSurface;
  /** Contexto de la pantalla desde la que se pregunta (tipo + id, nunca nombres). */
  screen?: AssistantScreenContext | unknown;
  correlationId?: string;
};

export function answerQuestion(input: AnswerQuestionInput): Promise<AssistantTurn> {
  return runAssistantTurn({
    context: input.context,
    surface: input.surface ?? "backoffice",
    question: input.question,
    conversationId: input.conversationId ?? null,
    screen: input.screen,
    correlationId: input.correlationId ?? createId("corr")
  });
}

export function getAvailableTools() {
  return ASSISTANT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    keywords: t.keywords
  }));
}
