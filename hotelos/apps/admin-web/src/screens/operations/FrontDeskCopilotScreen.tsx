// Front Desk Copilot Screen — IA operativa para recepción.
//
// Directriz Anfitorio (Nov 2026):
//   "La IA debe responder + recomendar + actuar. Más allá de Ask Signals:
//    no solo mostrar 'habitación no lista' sino proponer 'la 402 sí, ¿reasignar?'"
//
// UI:
//   - Header con 10 chips de preguntas predefinidas (1-clic)
//   - Input para pregunta libre
//   - Thread tipo chat con respuestas estructuradas
//   - Cada respuesta tiene:
//       · texto natural
//       · items accionables con sus botones
//       · suggestions agregadas (CTAs globales)
//   - Auto-scroll a la última respuesta

import { useEffect, useRef, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type ActionKind =
  | "open_reservation"
  | "open_guest"
  | "open_room_rack"
  | "start_checkin"
  | "start_checkout"
  | "assign_room"
  | "mark_no_show"
  | "open_work_order"
  | "open_housekeeping";

type CopilotAction = {
  label: string;
  kind: ActionKind;
  payload?: Record<string, string | number | boolean>;
};

type CopilotItem = {
  primary: string;
  secondary?: string;
  badge?: string;
  actions?: CopilotAction[];
};

type CopilotAnswer = {
  intent: string;
  question: string;
  answer: string;
  items: CopilotItem[];
  suggestions: CopilotAction[];
  generatedAt: string;
  source: string;
};

type Preset = { id: string; label: string; question: string };

type Turn = { type: "user" | "assistant"; text?: string; answer?: CopilotAnswer; ts: number };

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

function executeAction(action: CopilotAction) {
  switch (action.kind) {
    case "open_reservation":
    case "start_checkin":
    case "start_checkout":
      navigateTo("ReservationDetailWorkspace");
      break;
    case "open_room_rack":
      navigateTo("RoomRackScreen");
      break;
    case "open_housekeeping":
      navigateTo("HousekeepingMobileScreen");
      break;
    case "open_work_order":
      navigateTo("MaintenanceDashboard");
      break;
    case "open_guest": {
      const gid = action.payload?.guestId;
      if (gid && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("guestId", String(gid));
        window.history.pushState({}, "", url);
      }
      navigateTo("GuestTimelineScreen");
      break;
    }
    default:
      break;
  }
}

export function FrontDeskCopilotScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { data: presets } = useApiData<{ items: Preset[] }>("/copilot/presets");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [turns]);

  async function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    setTurns((prev) => [...prev, { type: "user", text: question, ts: Date.now() }]);
    try {
      const res = await fetch(`${API_BASE}/copilot/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId, question })
      });
      const answer = (await res.json()) as CopilotAnswer;
      setTurns((prev) => [...prev, { type: "assistant", answer, ts: Date.now() }]);
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          type: "assistant",
          answer: {
            intent: "unknown",
            question,
            answer: err instanceof Error ? err.message : "Error consultando el copiloto",
            items: [],
            suggestions: [],
            generatedAt: new Date().toISOString(),
            source: "client-error"
          },
          ts: Date.now()
        }
      ]);
    } finally {
      setBusy(false);
      setInput("");
    }
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Recepción · IA</div>
          <h1 className="bo-page-title">Copiloto operativo</h1>
          <p className="bo-page-subtitle">
            Pregunta en lenguaje natural sobre {propertyName}. El copiloto responde con datos reales y propone la siguiente acción.
          </p>
        </div>
      </div>

      {/* Quick chips */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Preguntas frecuentes</h3>
          <span className="bo-muted" style={{ fontSize: 12 }}>1 clic = respuesta inmediata</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(presets?.items ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => ask(p.question)}
              style={{ padding: "8px 12px", borderRadius: 18, fontSize: 13 }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </article>

      {/* Conversation */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Conversación</h3>
          {turns.length > 0 ? (
            <button type="button" className="ghost" onClick={() => setTurns([])}>Limpiar</button>
          ) : null}
        </div>

        <div ref={scrollerRef} style={{ maxHeight: 600, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 12 }}>
          {turns.length === 0 ? (
            <p className="bo-muted" style={{ padding: 24, textAlign: "center" }}>
              Empieza pulsando uno de los chips de arriba o escribe tu pregunta debajo.
            </p>
          ) : (
            turns.map((t, idx) => (
              <TurnBubble key={idx} turn={t} />
            ))
          )}
          {busy ? (
            <div style={{ alignSelf: "flex-start", color: "var(--muted, #888)", fontStyle: "italic" }}>Pensando…</div>
          ) : null}
        </div>

        {/* Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          style={{ display: "flex", gap: 6, marginTop: 12 }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder="Pregunta algo… (p. ej. '¿Qué llegadas con saldo pendiente?')"
            style={{
              flex: 1,
              padding: "10px 14px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 14
            }}
          />
          <button type="submit" className="primary" disabled={busy || !input.trim()} style={{ minWidth: 100 }}>
            {busy ? "…" : "Preguntar"}
          </button>
        </form>
      </article>
    </>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  if (turn.type === "user") {
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "80%", background: "var(--accent, #6f3ad2)", color: "white", padding: "8px 12px", borderRadius: 12, borderBottomRightRadius: 4, fontSize: 14 }}>
        {turn.text}
      </div>
    );
  }
  const a = turn.answer;
  if (!a) return null;
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "92%", background: "var(--surface-elevated, rgba(0,0,0,0.04))", padding: 12, borderRadius: 12, borderBottomLeftRadius: 4, display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Intent + source tag */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span className="bo-chip" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{a.intent}</span>
        <span className="bo-muted" style={{ fontSize: 11 }}>{a.source}</span>
      </div>

      <p style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>{a.answer}</p>

      {a.items.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {a.items.map((it, idx) => (
            <li
              key={idx}
              style={{
                background: "var(--surface)",
                padding: 10,
                borderRadius: 8,
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: 4
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <strong style={{ fontSize: 13 }}>{it.primary}</strong>
                {it.badge ? <span className="bo-chip" style={{ fontSize: 11 }}>{it.badge}</span> : null}
              </div>
              {it.secondary ? <span className="bo-muted" style={{ fontSize: 12 }}>{it.secondary}</span> : null}
              {it.actions && it.actions.length > 0 ? (
                <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                  {it.actions.map((act, ai) => (
                    <button
                      key={ai}
                      type="button"
                      className={ai === 0 ? "primary" : "ghost"}
                      onClick={() => executeAction(act)}
                      style={{ fontSize: 12, padding: "4px 8px" }}
                    >
                      {act.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {a.suggestions.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 6, borderTop: "1px solid var(--border)" }}>
          <span className="bo-muted" style={{ fontSize: 11, marginRight: 4 }}>Sugerencias:</span>
          {a.suggestions.map((s, idx) => (
            <button key={idx} type="button" className="ghost" onClick={() => executeAction(s)} style={{ fontSize: 12, padding: "4px 10px" }}>
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
