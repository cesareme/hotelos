// AI Assistant conversacional sobre datos del PMS — «Asistente ehotelOS»,
// /asistente (página completa del asistente unificado, Tanda L6b · L6b-07).
//
// El usuario pregunta en lenguaje natural (en español) y el asistente invoca
// las herramientas necesarias contra Prisma para responder con números
// reales y citas de la fuente. Cero alucinaciones: si no se ha mapeado la
// pregunta a una herramienta, el asistente lo dice y ofrece el catálogo.
//
// Misma conversación que el panel del shell (components/assistant): el hilo
// es `AssistantThread` (burbujas, badge «Por reglas»/«Modelo», citas, coste,
// escrituras pendientes con Aprobar / Rechazar, `role="log"` único), la
// memoria son las conversaciones del usuario (GET /assistant/conversations,
// «Nueva» y «Eliminar», tolerante al 404 mientras el backend v2 se fusiona)
// y cada pregunta viaja con el contexto de esta pantalla
// (`buildScreenContext`) y la superficie `backoffice`. Las seis preguntas
// sugeridas son las del back office (`SUGGESTED_QUESTIONS_BY_SURFACE`), todas
// cubiertas por las reglas de assistant.tools.ts.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, plantilla Chat): CocoaGrid 8/4 con el
// hilo (CocoaSection scroll="y") + compositor (CocoaInput multiline: Enter
// envía, Mayús+Enter salta de línea) y, al lado, las conversaciones y el
// catálogo de herramientas. Solo Cocoa y utilidades de cocoa-base.css: 0
// `style=`.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  askAssistant,
  confirmToolCall,
  deleteConversation,
  fetchAssistantTools,
  getConversation,
  listConversations,
  listPending,
  routedByOf,
  type AssistantConversationSummary,
  type AssistantPendingToolCall,
  type AssistantSurface,
  type AssistantTool,
  type AssistantToolCallDecision,
  type AssistantTurn
} from "../../services/assistantApi";
import { number, relativeTime } from "../../lib/format";
import { CocoaBadge, CocoaButton, CocoaGrid, CocoaInput, CocoaPage, CocoaSection, CocoaSpan, CocoaState, getPageCommands, type CocoaTone } from "../../components/cocoa";
import { AssistantThread } from "../../components/assistant/AssistantThread";
import { buildScreenContext } from "../../components/assistant/assistant-context";
import {
  HISTORY_UNAVAILABLE,
  NEW_CONVERSATION_LABEL,
  SUGGESTED_QUESTIONS_BY_SURFACE,
  confirmNotice,
  conversationTitle,
  errorMessage,
  isNotFound,
  mergePending,
  turnsFromMessages
} from "../../components/assistant/AssistantPanel";
import { ACTIONS } from "../../content/actions";
import { BRAND } from "../../config/brand";

/** Clave de esta pantalla en el árbol de navegación (App.tsx / nav-tree fila 79). */
export const ASSISTANT_SCREEN_KEY = "AssistantChat";

/** Superficie de la página completa: el prompt y las sugerencias del back office. */
export const ASSISTANT_PAGE_SURFACE: AssistantSurface = "backoffice";

/** Las seis preguntas sugeridas (las mismas del panel para el back office; cobertura 100 % por reglas). */
export const SUGGESTED_QUESTIONS: readonly string[] = SUGGESTED_QUESTIONS_BY_SURFACE[ASSISTANT_PAGE_SURFACE];

const THREAD_MAX_HEIGHT = 520;
const ASIDE_MAX_HEIGHT = 248;

type Notice = { tone: CocoaTone; text: string } | null;

export function AssistantChatScreen() {
  const [tools, setTools] = useState<AssistantTool[]>([]);
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
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchAssistantTools()
      .then(setTools)
      .catch(() => {
        /* no-op: the catalogue is optional */
      });
  }, []);

  const refreshHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryLoading(true);
    try {
      const items = await listConversations({ signal });
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
  }, []);

  const refreshPending = useCallback(async (signal?: AbortSignal) => {
    try {
      const items = await listPending(signal);
      setPending((current) => mergePending(current, items));
    } catch {
      // Los pendientes son opcionales mientras el endpoint v2 no exista: el hilo sigue.
    }
  }, []);

  // Al montar: historial y pendientes (ambos tolerantes a un 404).
  useEffect(() => {
    const controller = new AbortController();
    void refreshHistory(controller.signal);
    void refreshPending(controller.signal);
    return () => controller.abort();
  }, [refreshHistory, refreshPending]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns.length, busy]);

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
        const screen = buildScreenContext({ screenKey: ASSISTANT_SCREEN_KEY, pathname: typeof window !== "undefined" ? window.location.pathname : "", pageCommands: getPageCommands() });
        const turn = await askAssistant({ question, conversationId: activeIdRef.current ?? undefined, surface: ASSISTANT_PAGE_SURFACE, screen });
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
    [refreshHistory]
  );

  function startNewConversation() {
    setActiveId(null);
    setTurns([]);
    setError(null);
    setNotice(null);
  }

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

  // Quién respondió el último turno (v2 `routedBy`, o el `mode` v1): el badge de la cabecera.
  const lastRoutedBy = useMemo(() => {
    const last = turns[turns.length - 1];
    return last ? routedByOf(last) : "rules";
  }, [turns]);

  return (
    <CocoaPage
      eyebrow="Hoy"
      title={`Asistente ${BRAND.name}`}
      subtitle="Pregunta en lenguaje natural sobre tu hotel: las respuestas salen de tus datos y citan la fuente. El asistente nunca ejecuta cambios sin tu confirmación."
      actions={
        <CocoaBadge tone={lastRoutedBy === "model" ? "ai" : "neutral"} title={lastRoutedBy === "model" ? "Responde con un modelo de lenguaje" : "Sin modelo de lenguaje configurado: responde con reglas sobre tus datos"}>
          {lastRoutedBy === "model" ? "Con modelo de lenguaje" : "Sin modelo de lenguaje"}
        </CocoaBadge>
      }
      gap={3}
    >
      <CocoaGrid align="start">
        <CocoaSpan cols={8} min={480}>
          <div className="cocoa-stack" data-gap="2">
            <CocoaSection
              title="Conversación"
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
                <CocoaButton variant="plain" tone="accent" size="small" onClick={startNewConversation} disabled={busy || (turns.length === 0 && !activeId)}>
                  {NEW_CONVERSATION_LABEL}
                </CocoaButton>
              }
              scroll="y"
              maxHeight={THREAD_MAX_HEIGHT}
            >
              {threadLoading ? (
                <CocoaState kind="loading" inline message="Cargando conversación…" />
              ) : (
                <AssistantThread turns={turns} busy={busy} error={error} notice={notice} pending={pending} deciding={deciding} onDecide={(id, decision) => void decide(id, decision)} suggestions={SUGGESTED_QUESTIONS} onSuggest={(question) => void ask(question)} />
              )}
              <div ref={endRef} />
            </CocoaSection>

            <form className="cocoa-stack" data-gap="2" onSubmit={onSubmit} aria-label="Escribe tu pregunta">
              <CocoaInput
                value={draft}
                onChange={setDraft}
                multiline
                rows={2}
                placeholder="Escribe tu pregunta en español… (p. ej. «cuántas salidas tengo hoy»; Enter envía, Mayús+Enter salta de línea)"
                aria-label="Pregunta"
                disabled={busy}
                autoFocus
                onKeyDown={onComposerKeyDown}
              />
              <div className="cocoa-row" data-gap="2" data-justify="between">
                <span className="cocoa-note">Cada respuesta cita la herramienta, la fuente y el coste; las escrituras esperan tu aprobación.</span>
                <CocoaButton type="submit" variant="filled" tone="accent" loading={busy} disabled={busy || !draft.trim()}>
                  Preguntar
                </CocoaButton>
              </div>
            </form>
          </div>
        </CocoaSpan>

        <CocoaSpan cols={4} min={240}>
          <div className="cocoa-stack" data-gap="2">
            <CocoaSection title="Conversaciones" meta={historyUnavailable ? HISTORY_UNAVAILABLE : number(conversations.length)} scroll="y" maxHeight={ASIDE_MAX_HEIGHT}>
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

            <CocoaSection title="Herramientas disponibles" meta={number(tools.length)} scroll="y" maxHeight={ASIDE_MAX_HEIGHT}>
              {tools.length === 0 ? (
                <CocoaState kind="empty" inline title="Sin catálogo de herramientas disponible." />
              ) : (
                <ul className="c22-section__list" aria-label="Catálogo de herramientas">
                  {tools.map((tool) => (
                    <li key={tool.name}>
                      <div className="cocoa-stack" data-gap="1">
                        <span className="cocoa-mono">{tool.name}</span>
                        <span className="cocoa-note">{tool.description}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CocoaSection>
          </div>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

export default AssistantChatScreen;
