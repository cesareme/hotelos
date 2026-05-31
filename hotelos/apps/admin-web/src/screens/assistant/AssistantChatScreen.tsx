// AI Assistant conversacional sobre datos del PMS — estilo "Ask Signals".
//
// El usuario pregunta en lenguaje natural (en español) y el assistant invoca
// las tools necesarias contra Prisma para responder con números reales y
// citas de la fuente. Cero alucinaciones: si no se ha mapeado la pregunta a
// una tool, el assistant lo dice y ofrece el catálogo.

import { useEffect, useMemo, useRef, useState } from "react";
import { askAssistant, fetchAssistantTools, type AssistantTool, type AssistantTurn } from "../../services/assistantApi";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";

const SUGGESTED_QUESTIONS = [
  "¿Cuántas llegadas tengo hoy?",
  "¿Cuál es la ocupación ahora mismo?",
  "Dame el pickup de los últimos 7 días",
  "¿Qué saldo pendiente hay por cobrar?",
  "Estado de pisos hoy",
  "Resumen de cumplimiento normativo"
];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export function AssistantChatScreen() {
  const [tools, setTools] = useState<AssistantTool[]>([]);
  const [history, setHistory] = useState<AssistantTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchAssistantTools().then(setTools).catch(() => {/* no-op */});
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);

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
      setError(e instanceof Error ? e.message : "No se pudo conectar con el assistant.");
    } finally {
      setBusy(false);
    }
  }

  const mode = useMemo(() => history[history.length - 1]?.mode ?? "deterministic", [history]);

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: "70vh" }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>IA · Asistente conversacional</p>
          <h2 style={{ color: "var(--ink)" }}>Pregunta a HotelOS</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Pregunta en lenguaje natural sobre tu hotel. Las respuestas se basan en datos reales de Prisma y citan la fuente.
            Modo actual: <strong>{mode === "llm" ? "LLM activo" : "Determinista (sin LLM configurado)"}</strong>.
          </p>
        </div>
      </header>

      {/* Sugerencias clicables si no hay historial */}
      {history.length === 0 ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Empieza con una de estas preguntas</h3>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className="bo-chip-button"
                onClick={() => void ask(q)}
                disabled={busy}
                style={{
                  padding: "8px 14px",
                  background: "var(--surface-2, var(--surface))",
                  border: "1px solid var(--border)",
                  borderRadius: 99,
                  color: "var(--ink)",
                  cursor: "pointer"
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </article>
      ) : null}

      {/* Historial */}
      <div className="rev-report-wrap" style={{ flex: 1, overflowY: "auto" }}>
        {history.map((turn) => (
          <div key={turn.correlationId} style={{ marginBottom: 16 }}>
            {/* User turn */}
            <article className="bo-card" style={{ background: "var(--accent-soft, rgba(78,224,163,0.08))", marginBottom: 6 }}>
              <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10, margin: 0 }}>
                Tú · {fmtTime(turn.generatedAt)}
              </p>
              <p style={{ margin: "4px 0 0", color: "var(--ink)" }}>{turn.question}</p>
            </article>
            {/* Assistant turn */}
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10, margin: 0 }}>
                HotelOS Assistant · {turn.mode === "llm" ? "LLM" : "Determinista"}
              </p>
              <pre style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.5,
                margin: "6px 0 0",
                color: "var(--ink)"
              }}>{turn.answer}</pre>
              {turn.toolCalls.length > 0 ? (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                  <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10, marginBottom: 4 }}>
                    Fuentes consultadas
                  </p>
                  {turn.toolCalls.map((tc) => (
                    <div key={tc.name} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
                      <span className={`bo-status ${tc.ok ? "ok" : "warn"}`} style={{ fontSize: 9 }}>
                        {tc.ok ? "OK" : "no data"}
                      </span>
                      <span className="mono" style={{ color: "var(--ink-muted)" }}>{tc.name}</span>
                      <span style={{ color: "var(--ink-muted)" }}>·</span>
                      <span style={{ color: "var(--ink-muted)" }}>{tc.source}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          </div>
        ))}
        {busy ? <LoadingBlock label="Pensando…" /> : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p>
      ) : null}

      {/* Input bar */}
      <form
        className="bo-row"
        onSubmit={(e) => { e.preventDefault(); void ask(question); }}
        style={{ gap: 8, alignItems: "stretch" }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Escribe tu pregunta en español… (p. ej. «cuántas salidas tengo hoy»)"
          disabled={busy}
          style={{ flex: "1 1 0%", padding: "10px 14px" }}
          autoFocus
        />
        <button type="submit" className="primary" disabled={busy || !question.trim()}>
          {busy ? <Spinner size="sm" /> : "Preguntar"}
        </button>
      </form>

      {/* Tool catalog footer */}
      {tools.length > 0 ? (
        <details style={{ marginTop: 4 }}>
          <summary className="bo-muted" style={{ cursor: "pointer", fontSize: 12 }}>
            Catálogo de herramientas disponibles ({tools.length})
          </summary>
          <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 6 }}>
            {tools.map((t) => (
              <article key={t.name} className="bo-card" style={{ background: "var(--surface-2, var(--surface))", padding: 8, fontSize: 12 }}>
                <strong className="mono" style={{ color: "var(--ink)" }}>{t.name}</strong>
                <div className="bo-muted" style={{ marginTop: 2 }}>{t.description}</div>
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
