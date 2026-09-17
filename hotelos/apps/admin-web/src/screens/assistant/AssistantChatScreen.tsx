// AI Assistant conversacional sobre datos del PMS — «Asistente ehotelOS»,
// /asistente (standalone).
//
// El usuario pregunta en lenguaje natural (en español) y el assistant invoca
// las tools necesarias contra Prisma para responder con números reales y
// citas de la fuente. Cero alucinaciones: si no se ha mapeado la pregunta a
// una tool, el assistant lo dice y ofrece el catálogo.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, plantilla Chat): CocoaGrid 8/4 with
// the thread (CocoaSection scroll="y", bubbles as CocoaCard bordered, the
// user's on the accent wash) + composer (CocoaInput multiline: Enter sends,
// Shift+Enter breaks the line) and the tool catalogue aside. Mode badge
// «IA». One live region: the thread log.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { askAssistant, fetchAssistantTools, type AssistantTool, type AssistantTurn } from "../../services/assistantApi";
import { number, time } from "../../lib/format";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaCard, CocoaGrid, CocoaInput, CocoaPage, CocoaSection, CocoaSkeleton, CocoaSpan, CocoaState } from "../../components/cocoa";

const SUGGESTED_QUESTIONS = [
  "¿Cuántas llegadas tengo hoy?",
  "¿Cuál es la ocupación ahora mismo?",
  "Dame el pickup de los últimos 7 días",
  "¿Qué saldo pendiente hay por cobrar?",
  "Estado de pisos hoy",
  "Resumen de cumplimiento normativo"
];

const THREAD_MAX_HEIGHT = 520;

function fmtTime(iso: string): string {
  return time(iso, { empty: "" });
}

function modeLabel(mode: AssistantTurn["mode"]): string {
  return mode === "llm" ? "Modelo de lenguaje" : "Determinista";
}

// Bubbles: the user's on `--cocoa-accent-bg` (token), the assistant's on the
// card surface; both capped at 80 % of the thread width.
const bubbleStyle: CSSProperties = { alignSelf: "flex-start", maxWidth: "80%", minWidth: 0 };
const ownBubbleStyle: CSSProperties = { ...bubbleStyle, alignSelf: "flex-end", background: "var(--cocoa-accent-bg)" };

// Text styles (tokens only).
const metaStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)",
  color: "var(--cocoa-label-secondary)",
  letterSpacing: "var(--cocoa-tracking-wide)"
};

const textStyle: CSSProperties = { margin: 0, color: "var(--cocoa-label)" };

const answerStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "inherit",
  fontSize: "var(--cocoa-fs-body)",
  lineHeight: "var(--cocoa-lh-body)",
  color: "var(--cocoa-label)"
};

const captionStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)"
};

const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

export function AssistantChatScreen() {
  const [tools, setTools] = useState<AssistantTool[]>([]);
  const [history, setHistory] = useState<AssistantTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchAssistantTools()
      .then(setTools)
      .catch(() => {
        /* no-op: the catalogue is optional */
      });
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [history.length, busy]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setQuestion("");
    try {
      const turn = await askAssistant(text);
      setHistory((h) => [...h, turn]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo conectar con el asistente.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask(question);
    }
  }

  const mode = useMemo(() => history[history.length - 1]?.mode ?? "deterministic", [history]);

  return (
    <CocoaPage
      eyebrow="Hoy"
      title="Asistente ehotelOS"
      subtitle="Pregunta en lenguaje natural sobre tu hotel: las respuestas salen de tus datos y citan la fuente. El asistente nunca ejecuta cambios sin tu confirmación."
      actions={
        <CocoaBadge tone={mode === "llm" ? "ai" : "neutral"} title={mode === "llm" ? "Responde con un modelo de lenguaje" : "Sin modelo de lenguaje configurado: responde con reglas sobre tus datos"}>
          {mode === "llm" ? "Con modelo de lenguaje" : "Sin modelo de lenguaje"}
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
                <CocoaBadge tone="ai" size="small">
                  IA
                </CocoaBadge>
              }
              scroll="y"
              maxHeight={THREAD_MAX_HEIGHT}
            >
              <div className="cocoa-stack" data-gap="2" role="log" aria-live="polite" aria-label="Conversación con el asistente">
                {history.length === 0 ? (
                  <div className="cocoa-stack" data-gap="2">
                    <p style={captionStyle}>Empieza con una de estas preguntas</p>
                    <div className="cocoa-cluster" role="list" aria-label="Preguntas sugeridas">
                      {SUGGESTED_QUESTIONS.map((q) => (
                        <CocoaButton key={q} variant="tinted" tone="neutral" size="small" onClick={() => void ask(q)} disabled={busy}>
                          {q}
                        </CocoaButton>
                      ))}
                    </div>
                  </div>
                ) : null}

                {history.map((turn) => (
                  <div key={turn.correlationId} className="cocoa-stack" data-gap="2">
                    <CocoaCard variant="bordered" padding="sm" style={ownBubbleStyle} role="group" aria-label="Tu pregunta">
                      <p style={metaStyle}>Tú · {fmtTime(turn.generatedAt)}</p>
                      <p style={textStyle}>{turn.question}</p>
                    </CocoaCard>
                    <CocoaCard variant="bordered" padding="sm" style={bubbleStyle} role="group" aria-label="Respuesta del asistente">
                      <div className="cocoa-row" data-gap="2">
                        <p style={metaStyle}>Asistente ehotelOS</p>
                        <CocoaBadge tone="ai" size="small">
                          {modeLabel(turn.mode)}
                        </CocoaBadge>
                      </div>
                      <pre style={answerStyle}>{turn.answer}</pre>
                      {turn.toolCalls.length > 0 ? (
                        <div className="cocoa-stack" data-gap="1">
                          <p style={metaStyle}>Fuentes consultadas</p>
                          <ul className="c22-section__list" aria-label="Fuentes consultadas">
                            {turn.toolCalls.map((tc) => (
                              <li key={tc.name}>
                                <CocoaBadge tone={tc.ok ? "success" : "warning"} size="small">
                                  {tc.ok ? "OK" : "sin datos"}
                                </CocoaBadge>
                                <div className="cocoa-row" data-gap="2" data-align="baseline" style={growStyle}>
                                  <span className="cocoa-mono">{tc.name}</span>
                                  <span style={captionStyle}>{tc.source}</span>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </CocoaCard>
                  </div>
                ))}

                {busy ? (
                  <CocoaCard variant="bordered" padding="sm" style={bubbleStyle} role="group" aria-label="Pensando…">
                    <p style={metaStyle}>Pensando…</p>
                    <CocoaSkeleton variant="text" lines={2} />
                  </CocoaCard>
                ) : null}
                <div ref={endRef} />
              </div>
            </CocoaSection>

            {error ? <CocoaCallout tone="danger">{error}</CocoaCallout> : null}

            <form className="cocoa-row" data-gap="2" data-align="end" data-wrap="nowrap" onSubmit={onSubmit} aria-label="Escribe tu pregunta">
              <CocoaInput
                value={question}
                onChange={setQuestion}
                multiline
                rows={2}
                placeholder="Escribe tu pregunta en español… (p. ej. «cuántas salidas tengo hoy»)"
                aria-label="Pregunta"
                disabled={busy}
                autoFocus
                onKeyDown={onComposerKeyDown}
                style={growStyle}
              />
              <CocoaButton type="submit" variant="filled" tone="accent" loading={busy} disabled={busy || !question.trim()}>
                Preguntar
              </CocoaButton>
            </form>
          </div>
        </CocoaSpan>

        <CocoaSpan cols={4} min={240}>
          <CocoaSection title="Herramientas disponibles" meta={number(tools.length)} scroll="y" maxHeight={THREAD_MAX_HEIGHT}>
            {tools.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin catálogo de herramientas disponible." />
            ) : (
              <ul className="c22-section__list" aria-label="Catálogo de herramientas">
                {tools.map((t) => (
                  <li key={t.name}>
                    <div className="cocoa-stack" data-gap="1" style={growStyle}>
                      <span className="cocoa-mono">{t.name}</span>
                      <span style={captionStyle}>{t.description}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

export default AssistantChatScreen;
