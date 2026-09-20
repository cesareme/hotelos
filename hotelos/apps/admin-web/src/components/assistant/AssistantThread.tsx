// Asistente unificado (Tanda L6b) · hilo de la conversación.
//
// Burbujas (plantilla Chat de Cocoa 22, COCOA-22.md §4): la pregunta del
// usuario como CocoaCallout tone="accent" alineada a la derecha (`cocoa-row`
// data-justify="end"), la respuesta como CocoaCard bordered padding="sm" con
// el badge de enrutado («Por reglas» / «Modelo»), el coste del turno, la
// respuesta y las citas (herramienta · fuente · coste € o «sin coste»). Las
// escrituras que el tool runner deja `awaiting_confirmation` se pintan como
// tarjeta con Aprobar / Rechazar (HITL, AI-CORE.md §10). Una sola live
// region: el `role="log"` del hilo (los errores se pintan dentro).
//
// Solo Cocoa y utilidades de cocoa-base.css: 0 `style=` (regla del carril).
// Las funciones puras (formatCitation, routedByLabel, citationsOf,
// turnCostLabel) se prueban en components/__tests__/assistant-panel.test.mts.

import { ACTIONS } from "../../content/actions";
import { dateTime, money, time } from "../../lib/format";
import { BRAND } from "../../config/brand";
import { routedByOf, type AssistantCitation, type AssistantPendingToolCall, type AssistantRiskLevel, type AssistantRoutedBy, type AssistantToolCallDecision, type AssistantTurn } from "../../services/assistantApi";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaCard, CocoaSkeleton, type CocoaTone } from "../cocoa";

export const NO_COST_LABEL = "sin coste";
export const ROUTED_BY_LABEL: Record<AssistantRoutedBy, string> = { rules: "Por reglas", model: "Modelo" };
export const ROUTED_BY_TITLE: Record<AssistantRoutedBy, string> = {
  rules: "Respuesta por reglas sobre tus datos, sin modelo de lenguaje",
  model: "Respuesta con un modelo de lenguaje sobre tus datos"
};
export const PENDING_WRITE_LABEL = "Escritura pendiente de aprobación";
export const RISK_LABEL: Record<AssistantRiskLevel, string> = { low: "Riesgo bajo", medium: "Riesgo medio", high: "Riesgo alto", critical: "Riesgo crítico" };
const RISK_TONE: Record<AssistantRiskLevel, CocoaTone> = { low: "neutral", medium: "warning", high: "danger", critical: "danger" };

/** Coste en euros (puro): «sin coste» para null, 0 o inválido; si no, 4 decimales (los costes por turno son de milésimas). */
export function costLabel(costEur: number | null | undefined): string {
  if (typeof costEur !== "number" || !Number.isFinite(costEur) || costEur <= 0) return NO_COST_LABEL;
  return money(costEur, { decimals: 4 });
}

/** «herramienta · fuente · coste» (puro): la cita de una respuesta tal y como se lee en el hilo. */
export function formatCitation(citation: AssistantCitation): string {
  const source = citation.source.trim() || "fuente no indicada";
  return `${citation.tool} · ${source} · ${costLabel(citation.costEur)}`;
}

/** Etiqueta del badge de enrutado (puro). */
export function routedByLabel(turn: Pick<AssistantTurn, "mode" | "routedBy">): string {
  return ROUTED_BY_LABEL[routedByOf(turn)];
}

/** Citas de un turno (puro): las v2, o las `toolCalls` v1 convertidas (sin coste). */
export function citationsOf(turn: Pick<AssistantTurn, "toolCalls" | "citations">): AssistantCitation[] {
  if (turn.citations && turn.citations.length > 0) return turn.citations;
  return (turn.toolCalls ?? []).map((call) => ({ tool: call.name, source: call.source, ok: call.ok, summary: call.summary, costEur: null }));
}

/** Coste del turno (puro): `cost.eur`, o la suma de las citas cuando el turno no lo trae. */
export function turnCostLabel(turn: Pick<AssistantTurn, "cost" | "citations" | "toolCalls">): string {
  if (turn.cost && typeof turn.cost.eur === "number") return costLabel(turn.cost.eur);
  const sum = citationsOf(turn).reduce((acc, citation) => acc + (typeof citation.costEur === "number" && citation.costEur > 0 ? citation.costEur : 0), 0);
  return costLabel(sum);
}

function fmtTime(iso: string): string {
  return time(iso, { empty: "" });
}

/** Texto de la respuesta línea a línea (los saltos de línea del asistente se respetan sin `white-space` en línea). */
function AnswerText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="cocoa-stack" data-gap="1">
      {lines.map((line, index) => (
        <span key={index}>{line.length > 0 ? line : "\u00a0"}</span>
      ))}
    </div>
  );
}

export interface PendingToolCallCardProps {
  call: AssistantPendingToolCall;
  /** Id de la llamada cuya decisión está en curso (deshabilita el resto). */
  deciding?: string | null;
  onDecide?: (id: string, decision: AssistantToolCallDecision) => void;
}

export function PendingToolCallCard({ call, deciding, onDecide }: PendingToolCallCardProps) {
  const busy = deciding === call.id;
  const locked = Boolean(deciding) && !busy;
  const risk = call.riskLevel ?? null;
  return (
    <CocoaCard variant="bordered" padding="sm" role="group" aria-label={PENDING_WRITE_LABEL}>
      <div className="cocoa-stack" data-gap="2">
        <div className="cocoa-row" data-gap="2" data-justify="between">
          <CocoaBadge tone="warning" size="small">
            Escritura pendiente
          </CocoaBadge>
          {risk ? (
            <CocoaBadge tone={RISK_TONE[risk]} size="small">
              {RISK_LABEL[risk]}
            </CocoaBadge>
          ) : null}
        </div>
        <span className="cocoa-mono">{call.toolName}</span>
        {call.summary ? <span>{call.summary}</span> : null}
        <span className="cocoa-note">
          Propuesta {call.createdAt ? `el ${dateTime(call.createdAt)}` : "por el asistente"} · no se ejecuta sin tu aprobación.
        </span>
        <div className="cocoa-row" data-gap="2" data-justify="end">
          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={busy || locked || !onDecide} onClick={() => onDecide?.(call.id, "reject")}>
            {ACTIONS.reject}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" loading={busy} disabled={busy || locked || !onDecide} onClick={() => onDecide?.(call.id, "approve")}>
            {ACTIONS.approve}
          </CocoaButton>
        </div>
      </div>
    </CocoaCard>
  );
}

export interface AssistantThreadProps {
  turns: readonly AssistantTurn[];
  /** Hay una pregunta en vuelo: se pinta la burbuja «Pensando…». */
  busy?: boolean;
  /** Error de la última pregunta (se pinta dentro del log para que se anuncie). */
  error?: string | null;
  /** Aviso no bloqueante (resultado de una aprobación, historial no disponible…). */
  notice?: { tone: CocoaTone; text: string } | null;
  /** Escrituras pendientes de aprobación (las del turno y las de `GET /assistant/pending`). */
  pending?: readonly AssistantPendingToolCall[];
  deciding?: string | null;
  onDecide?: (id: string, decision: AssistantToolCallDecision) => void;
  /** Preguntas sugeridas para el hilo vacío. */
  suggestions?: readonly string[];
  onSuggest?: (question: string) => void;
}

export function AssistantThread({ turns, busy = false, error = null, notice = null, pending = [], deciding = null, onDecide, suggestions = [], onSuggest }: AssistantThreadProps) {
  const showSuggestions = turns.length === 0 && !busy && suggestions.length > 0;
  return (
    <div className="cocoa-stack" data-gap="2" role="log" aria-live="polite" aria-label="Conversación con el asistente">
      {showSuggestions ? (
        <div className="cocoa-stack" data-gap="2">
          <span className="cocoa-caption">Empieza con una de estas preguntas</span>
          <div className="cocoa-cluster" role="list" aria-label="Preguntas sugeridas">
            {suggestions.map((question) => (
              <CocoaButton key={question} variant="tinted" tone="neutral" size="small" wrap onClick={() => onSuggest?.(question)} disabled={!onSuggest}>
                {question}
              </CocoaButton>
            ))}
          </div>
        </div>
      ) : null}

      {turns.map((turn, index) => {
        const routedBy = routedByOf(turn);
        const citations = citationsOf(turn);
        return (
          <div key={`${turn.correlationId}-${index}`} className="cocoa-stack" data-gap="2">
            <div className="cocoa-row" data-justify="end">
              <CocoaCallout tone="accent" title={`Tú · ${fmtTime(turn.generatedAt)}`.trim()}>
                {turn.question}
              </CocoaCallout>
            </div>
            <CocoaCard variant="bordered" padding="sm" role="group" aria-label="Respuesta del asistente">
              <div className="cocoa-stack" data-gap="2">
                <div className="cocoa-row" data-gap="2" data-justify="between">
                  <span className="cocoa-caption">Asistente {BRAND.name}</span>
                  <span className="cocoa-cluster">
                    <CocoaBadge tone="ai" size="small" title={ROUTED_BY_TITLE[routedBy]}>
                      {ROUTED_BY_LABEL[routedBy]}
                    </CocoaBadge>
                    <CocoaBadge tone="neutral" size="small" uppercase={false} title="Coste de la respuesta">
                      {turnCostLabel(turn)}
                    </CocoaBadge>
                  </span>
                </div>
                <AnswerText text={turn.answer} />
                {citations.length > 0 ? (
                  <div className="cocoa-stack" data-gap="1">
                    <span className="cocoa-caption">Fuentes</span>
                    <ul className="c22-section__list" aria-label="Fuentes consultadas">
                      {citations.map((citation, citationIndex) => (
                        <li key={`${citation.tool}-${citationIndex}`}>
                          <span className="cocoa-note">{formatCitation(citation)}</span>
                          <CocoaBadge tone={citation.ok === false ? "warning" : "success"} size="small">
                            {citation.ok === false ? "sin datos" : "OK"}
                          </CocoaBadge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </CocoaCard>
          </div>
        );
      })}

      {pending.map((call) => (
        <PendingToolCallCard key={call.id} call={call} deciding={deciding} onDecide={onDecide} />
      ))}

      {busy ? (
        <CocoaCard variant="bordered" padding="sm" role="group" aria-label="Pensando…">
          <div className="cocoa-stack" data-gap="2">
            <span className="cocoa-caption">Pensando…</span>
            <CocoaSkeleton variant="text" lines={2} />
          </div>
        </CocoaCard>
      ) : null}

      {notice ? <CocoaCallout tone={notice.tone}>{notice.text}</CocoaCallout> : null}
      {error ? <CocoaCallout tone="danger">{error}</CocoaCallout> : null}
    </div>
  );
}

export default AssistantThread;
