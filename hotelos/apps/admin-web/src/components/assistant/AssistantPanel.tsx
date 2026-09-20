// Asistente unificado (Tanda L6b) · panel del asistente (CocoaDrawer, lado
// derecho) accesible desde cualquier pantalla del back office.
//
// Contenido: conversaciones del usuario (GET /assistant/conversations, con
// «Nueva» y «Eliminar»), el hilo (AssistantThread: burbujas, badge «Por
// reglas»/«Modelo», citas, coste, escrituras pendientes con Aprobar /
// Rechazar) y, en el pie, el compositor (CocoaInput multiline: Enter envía,
// Mayús+Enter salta de línea). Las preguntas sugeridas dependen de la
// superficie (`SUGGESTED_QUESTIONS_BY_SURFACE`) y todas las cubren las reglas
// de assistant.tools.ts, de modo que sin proveedor de IA responden igual.
//
// Cada pregunta viaja con el contexto de la página (`buildScreenContext`:
// clave de pantalla, URL sin query, entidad por id, comandos ⌘K por id) y
// con la superficie; la memoria por conversación la lleva `conversationId`.
//
// Apertura: el store de assistant-panel-store.ts (`openAssistant`,
// `openAssistantWith({ question, surface })`, evento «hotelos-open-assistant»);
// L6b-07 monta el panel en el shell y lo cablea a ⌘K. Cocoa solo, 0 `style=`.
//
// Los endpoints v2 pueden faltar mientras el backend de la tanda se fusiona:
// un 404 del historial o de los pendientes no bloquea el chat (se muestra
// «Historial no disponible» y el hilo sigue funcionando contra /assistant/chat).

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { BRAND } from "../../config/brand";
import { ACTIONS } from "../../content/actions";
import { relativeTime } from "../../lib/format";
import { ApiError } from "../../services/api-client";
import {
  askAssistant,
  confirmToolCall,
  deleteConversation,
  getConversation,
  listConversations,
  listPending,
  type AssistantCitation,
  type AssistantConfirmResult,
  type AssistantConversationSummary,
  type AssistantMessage,
  type AssistantPendingToolCall,
  type AssistantStoredToolCall,
  type AssistantSurface,
  type AssistantToolCall,
  type AssistantToolCallDecision,
  type AssistantTurn
} from "../../services/assistantApi";
import { CocoaBadge, CocoaButton, CocoaDrawer, CocoaInput, CocoaSection, CocoaState, getPageCommands, type CocoaTone } from "../cocoa";
import { AssistantThread } from "./AssistantThread";
import { buildScreenContext } from "./assistant-context";
import { closeAssistant, getAssistantPanelState, listenOpenAssistantEvents, subscribeAssistantPanel, takePendingQuestion, type AssistantPanelState } from "./assistant-panel-store";

export const DEFAULT_SURFACE: AssistantSurface = "backoffice";

export const SURFACE_LABELS: Record<AssistantSurface, string> = {
  backoffice: "Back office",
  reception: "Recepción",
  guest: "Huésped"
};

/**
 * Preguntas sugeridas por superficie (las mismas frases que
 * `ASSISTANT_SUGGESTED_QUESTIONS` / `CHECKIN_SUGGESTED_QUESTIONS` de
 * apps/api/src/modules/assistant/assistant-router.ts). Cada una contiene una
 * palabra clave del catálogo de reglas (assistant.tools.ts), así que sin
 * proveedor la cobertura es del 100 % (objetivo 2 de la tanda). El bot del
 * huésped tiene su propia clasificación: sin sugerencias de personal.
 */
export const SUGGESTED_QUESTIONS_BY_SURFACE: Record<AssistantSurface, readonly string[]> = {
  backoffice: [
    "¿Cuántas llegadas tengo hoy?",
    "¿Cuál es la ocupación ahora mismo?",
    "Dame el pickup de los últimos 7 días",
    "¿Qué saldo pendiente hay por cobrar?",
    "Estado de pisos hoy",
    "Resumen de cumplimiento normativo"
  ],
  reception: [
    "¿Cuántas llegadas tengo hoy?",
    "¿Cuántas salidas tengo hoy?",
    "¿Qué llegadas de hoy siguen sin habitación asignada?",
    "¿Qué pre-check-ins están incompletos?",
    "¿Qué habitaciones están listas para entregar?",
    "¿Qué saldo pendiente hay por cobrar?"
  ],
  guest: []
};

export const HISTORY_UNAVAILABLE = "Historial no disponible";
export const NEW_CONVERSATION_LABEL = "Nueva conversación";
export const THREAD_MAX_HEIGHT = 420;
export const HISTORY_MAX_HEIGHT = 168;

/** Sugerencias de una superficie (puro): las del back office cuando la superficie no tiene lista. */
export function suggestionsFor(surface: AssistantSurface | string | null | undefined): readonly string[] {
  if (surface && Object.prototype.hasOwnProperty.call(SUGGESTED_QUESTIONS_BY_SURFACE, surface)) return SUGGESTED_QUESTIONS_BY_SURFACE[surface as AssistantSurface];
  return SUGGESTED_QUESTIONS_BY_SURFACE[DEFAULT_SURFACE];
}

/** Cita guardada → cita del hilo (pura): la forma persistida lleva `tool`, la del turno en vivo `name`. */
export function citationFromStored(call: AssistantStoredToolCall): AssistantCitation {
  return { tool: call.tool, source: call.source, ok: call.ok, summary: call.summary, costEur: null, ...(call.aiToolCallId ? { aiToolCallId: call.aiToolCallId } : {}) };
}

/** Cita guardada → `toolCalls` v1 del turno (pura). */
export function toolCallFromStored(call: AssistantStoredToolCall): AssistantToolCall {
  return { name: call.tool, ok: call.ok ?? true, source: call.source, summary: call.summary ?? "" };
}

/**
 * Turnos de una conversación guardada (puro): cada mensaje `user` abre un turno
 * y el siguiente `assistant` lo cierra con su respuesta, enrutado, citas y
 * coste; un `assistant` sin pregunta previa abre su propio turno. Los `tool` /
 * `system` no se pintan. Las citas guardadas (`toolCalls: [{ tool, source… }]`,
 * contrato de GET /assistant/conversations/:id) se convierten a la forma del
 * turno en vivo (`{ name… }` y `citations`), así una conversación reabierta
 * pinta «herramienta · fuente · sin coste» igual que el turno original
 * (corrector L6b · REV-01).
 */
export function turnsFromMessages(messages: readonly AssistantMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  let open: AssistantTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      if (open) turns.push(open);
      open = { question: message.content, answer: "", toolCalls: [], mode: "deterministic", generatedAt: message.createdAt, correlationId: message.correlationId ?? message.id };
      continue;
    }
    if (message.role !== "assistant") continue;
    const turn: AssistantTurn = open ?? { question: "", answer: "", toolCalls: [], mode: "deterministic", generatedAt: message.createdAt, correlationId: message.correlationId ?? message.id };
    const stored = message.toolCalls ?? [];
    turn.answer = message.content;
    turn.toolCalls = stored.map(toolCallFromStored);
    turn.routedBy = message.routedBy ?? null;
    turn.mode = message.routedBy === "model" ? "llm" : "deterministic";
    turn.citations = message.citations ?? stored.map(citationFromStored);
    if (message.cost !== undefined) turn.cost = message.cost;
    if (!open) turn.generatedAt = message.createdAt;
    turns.push(turn);
    open = null;
  }
  if (open) turns.push(open);
  return turns;
}

/**
 * Hilo al que va una pregunta pendiente del store (⌘K «Preguntar al asistente…», puro): si el panel ya estaba abierto
 * con un hilo, continúa en él; si estaba cerrado, la pregunta abre una conversación NUEVA (nunca cae en el último
 * hilo reabierto desde el historial sin que el operador lo vea; corrector L6b · REV-08).
 */
export function threadForPendingQuestion(input: { panelWasOpen: boolean; activeId: string | null }): string | null {
  return input.panelWasOpen ? input.activeId : null;
}

/** Fusión de pendientes (puro): sin duplicados por id, las nuevas primero. */
export function mergePending(current: readonly AssistantPendingToolCall[], incoming: readonly AssistantPendingToolCall[]): AssistantPendingToolCall[] {
  const seen = new Set<string>();
  const out: AssistantPendingToolCall[] = [];
  for (const call of [...incoming, ...current]) {
    if (!call || seen.has(call.id)) continue;
    seen.add(call.id);
    out.push(call);
  }
  return out;
}

/** Título de una conversación en la lista (puro): el suyo o «Conversación» + superficie. */
export function conversationTitle(conversation: Pick<AssistantConversationSummary, "title" | "surface">): string {
  const title = conversation.title?.trim();
  if (title) return title;
  const surface = SURFACE_LABELS[conversation.surface as AssistantSurface];
  return surface ? `Conversación · ${surface}` : "Conversación";
}

/** Mensaje legible de un fallo (puro): el del API (ya en español) o uno genérico. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** 404 del API (puro): el endpoint v2 aún no existe o el recurso desapareció. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Aviso tras una decisión (puro). */
export function confirmNotice(result: AssistantConfirmResult): { tone: CocoaTone; text: string } {
  if (result.status === "succeeded") return { tone: "success", text: "Acción aprobada y ejecutada." };
  if (result.status === "rejected") return { tone: "neutral", text: "Acción rechazada: no se ejecutará." };
  return { tone: "danger", text: result.message || "La acción aprobada no se pudo ejecutar." };
}

/** Estado del panel para React (`useSyncExternalStore` sobre el store fuera de React). */
export function useAssistantPanel(): AssistantPanelState {
  return useSyncExternalStore(subscribeAssistantPanel, getAssistantPanelState, getAssistantPanelState);
}

export interface AssistantPanelProps {
  /** Clave de la pantalla activa (App.tsx): viaja en el contexto de cada pregunta. */
  screenKey?: string | null;
  /** Superficie por defecto cuando el store no fija otra (el shell la deduce de la categoría). */
  surface?: AssistantSurface;
  /** Abre el asistente completo (/asistente) desde el panel; sin él no se ofrece el enlace. */
  onOpenFullAssistant?: () => void;
}

type Notice = { tone: CocoaTone; text: string } | null;

export function AssistantPanel({ screenKey = null, surface: surfaceProp = DEFAULT_SURFACE, onOpenFullAssistant }: AssistantPanelProps) {
  const state = useAssistantPanel();
  const surface = state.surface ?? surfaceProp;
  const composerId = useId();

  const [conversations, setConversations] = useState<AssistantConversationSummary[]>([]);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [pending, setPending] = useState<AssistantPendingToolCall[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const busyRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  /** Estado de apertura visto por la última petición del store (decide si ⌘K abre un hilo nuevo). */
  const wasOpenRef = useRef(false);

  // El evento de window («hotelos-open-assistant») abre el store mientras el panel está montado.
  useEffect(() => listenOpenAssistantEvents(), []);

  // Solo las conversaciones de la superficie activa (una por usuario + propiedad + superficie): las de recepción no se
  // continúan desde el back office ni al revés (corrector L6b · REV-05; el API fija además la superficie de la conversación).
  const refreshHistory = useCallback(
    async (signal?: AbortSignal) => {
      setHistoryLoading(true);
      try {
        const items = await listConversations({ surface, signal });
        setConversations(items);
        setHistoryUnavailable(false);
      } catch (cause) {
        if (signal?.aborted) return;
        setConversations([]);
        setHistoryUnavailable(true);
        if (!isNotFound(cause)) setNotice({ tone: "warning", text: errorMessage(cause, HISTORY_UNAVAILABLE) });
      } finally {
        if (!signal?.aborted) setHistoryLoading(false);
      }
    },
    [surface]
  );

  const refreshPending = useCallback(async (signal?: AbortSignal) => {
    try {
      const items = await listPending(signal);
      setPending((current) => mergePending(current, items));
    } catch {
      // Los pendientes son opcionales mientras el endpoint v2 no exista: el hilo sigue.
    }
  }, []);

  // Al abrir: historial y pendientes (ambos tolerantes a un 404).
  useEffect(() => {
    if (!state.open) return undefined;
    const controller = new AbortController();
    void refreshHistory(controller.signal);
    void refreshPending(controller.signal);
    return () => controller.abort();
  }, [state.open, refreshHistory, refreshPending]);

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      setDraft("");
      try {
        const screen = buildScreenContext({ screenKey, pathname: typeof window !== "undefined" ? window.location.pathname : "", pageCommands: getPageCommands() });
        const turn = await askAssistant({ question, conversationId: activeIdRef.current ?? undefined, surface, screen });
        setTurns((current) => [...current, turn]);
        if (turn.pendingToolCalls && turn.pendingToolCalls.length > 0) setPending((current) => mergePending(current, turn.pendingToolCalls ?? []));
        if (turn.conversationId && turn.conversationId !== activeIdRef.current) {
          setActiveId(turn.conversationId);
          void refreshHistory();
        }
      } catch (cause) {
        setError(errorMessage(cause, "No se pudo conectar con el asistente."));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [screenKey, surface, refreshHistory]
  );

  function startNewConversation() {
    activeIdRef.current = null;
    setActiveId(null);
    setTurns([]);
    setError(null);
    setNotice(null);
  }

  // Pregunta pendiente del store (⌘K, «Preguntar al asistente…»): se envía al abrir. Con el panel cerrado abre un
  // hilo nuevo; abierto, continúa el hilo activo (threadForPendingQuestion).
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = state.open;
    if (!state.open) return;
    const question = takePendingQuestion();
    if (!question) return;
    if (threadForPendingQuestion({ panelWasOpen: wasOpen, activeId: activeIdRef.current }) === null) startNewConversation();
    void ask(question);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startNewConversation es estable (solo setters)
  }, [state.open, state.requestId, ask]);

  async function openConversation(conversationId: string) {
    if (conversationId === activeId) return;
    setThreadLoading(true);
    setError(null);
    setNotice(null);
    try {
      const conversation = await getConversation(conversationId);
      setActiveId(conversation.id);
      setTurns(turnsFromMessages(conversation.messages ?? []));
    } catch (cause) {
      setError(errorMessage(cause, "No se pudo abrir la conversación."));
    } finally {
      setThreadLoading(false);
    }
  }

  async function removeConversation(conversationId: string) {
    try {
      await deleteConversation(conversationId);
      setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
      if (conversationId === activeId) startNewConversation();
      setNotice({ tone: "neutral", text: "Conversación eliminada." });
    } catch (cause) {
      setNotice({ tone: "danger", text: errorMessage(cause, "No se pudo eliminar la conversación.") });
    }
  }

  async function decide(toolCallId: string, decision: AssistantToolCallDecision) {
    if (deciding) return;
    setDeciding(toolCallId);
    setNotice(null);
    try {
      const result = await confirmToolCall(toolCallId, decision);
      setPending((current) => current.filter((call) => call.id !== toolCallId));
      setNotice(confirmNotice(result));
    } catch (cause) {
      setNotice({ tone: "danger", text: errorMessage(cause, "No se pudo registrar la decisión.") });
    } finally {
      setDeciding(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(draft);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft);
    }
  }

  const contextLabel = screenKey ? `Con el contexto de esta pantalla · ${SURFACE_LABELS[surface]}` : `Sin contexto de pantalla · ${SURFACE_LABELS[surface]}`;

  // `c22-assistant-composer` (styles/cocoa-22-shell.css): el formulario ocupa todo el ancho del pie del cajón (REV-09).
  const composer = (
    <form className="cocoa-stack c22-assistant-composer" data-gap="2" onSubmit={onSubmit} aria-label="Escribe tu pregunta">
      <CocoaInput
        id={composerId}
        value={draft}
        onChange={setDraft}
        multiline
        rows={2}
        placeholder="Escribe tu pregunta en español… (Enter envía, Mayús+Enter salta de línea)"
        aria-label="Pregunta"
        disabled={busy}
        onKeyDown={onComposerKeyDown}
      />
      <div className="cocoa-row" data-gap="2" data-justify="between">
        <span className="cocoa-note">{contextLabel}</span>
        <CocoaButton type="submit" variant="filled" tone="accent" loading={busy} disabled={busy || !draft.trim()}>
          Preguntar
        </CocoaButton>
      </div>
    </form>
  );

  return (
    <CocoaDrawer
      open={state.open}
      onClose={closeAssistant}
      title={`Asistente ${BRAND.name}`}
      subtitle="Responde con tus datos y cita la fuente; nunca ejecuta cambios sin tu aprobación."
      side="right"
      size="lg"
      footer={composer}
      initialFocus={() => (typeof document === "undefined" ? null : document.getElementById(composerId))}
      focusKey={state.requestId}
    >
      <div className="cocoa-stack" data-gap="3">
        <CocoaSection
          title="Conversaciones"
          meta={historyUnavailable ? HISTORY_UNAVAILABLE : `${conversations.length}`}
          action={
            <CocoaButton variant="plain" tone="accent" size="small" onClick={startNewConversation} disabled={busy}>
              {NEW_CONVERSATION_LABEL}
            </CocoaButton>
          }
          scroll="y"
          maxHeight={HISTORY_MAX_HEIGHT}
        >
          {historyLoading && conversations.length === 0 ? (
            <CocoaState kind="loading" inline message="Cargando conversaciones…" />
          ) : historyUnavailable ? (
            <CocoaState kind="empty" inline title={HISTORY_UNAVAILABLE} message="La memoria de conversaciones aún no está activa en este servidor; el hilo actual sigue funcionando." />
          ) : conversations.length === 0 ? (
            <CocoaState kind="empty" inline title="Sin conversaciones guardadas" message="Tu primera pregunta abre una." />
          ) : (
            <ul className="c22-section__list" aria-label="Conversaciones">
              {conversations.map((conversation) => {
                const active = conversation.id === activeId;
                return (
                  <li key={conversation.id}>
                    <CocoaButton variant="plain" tone={active ? "accent" : "neutral"} size="small" wrap align="start" aria-current={active ? true : undefined} onClick={() => void openConversation(conversation.id)} disabled={busy || threadLoading}>
                      {conversationTitle(conversation)}
                    </CocoaButton>
                    <span className="cocoa-cluster">
                      {conversation.lastMessageAt ? <span className="cocoa-note">{relativeTime(conversation.lastMessageAt)}</span> : null}
                      <CocoaButton variant="plain" tone="destructive" size="small" aria-label={`${ACTIONS.delete} conversación`} onClick={() => void removeConversation(conversation.id)} disabled={busy}>
                        {ACTIONS.delete}
                      </CocoaButton>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CocoaSection>

        <CocoaSection
          title="Hilo"
          meta={
            <span className="cocoa-cluster">
              {pending.length > 0 ? (
                <CocoaBadge tone="warning" size="small">
                  {pending.length} pendientes
                </CocoaBadge>
              ) : null}
              <CocoaBadge tone="ai" size="small">
                IA
              </CocoaBadge>
            </span>
          }
          action={
            onOpenFullAssistant ? (
              <CocoaButton variant="plain" tone="accent" size="small" onClick={onOpenFullAssistant}>
                Abrir asistente completo
              </CocoaButton>
            ) : undefined
          }
          scroll="y"
          maxHeight={THREAD_MAX_HEIGHT}
        >
          {threadLoading ? (
            <CocoaState kind="loading" inline message="Cargando conversación…" />
          ) : (
            <AssistantThread turns={turns} busy={busy} error={error} notice={notice} pending={pending} deciding={deciding} onDecide={(id, decision) => void decide(id, decision)} suggestions={suggestionsFor(surface)} onSuggest={(question) => void ask(question)} />
          )}
        </CocoaSection>
      </div>
    </CocoaDrawer>
  );
}

export default AssistantPanel;
