import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { chat } from "../api/client";
import type { ChatResponse } from "../api/client";
import { t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";

// Tanda CHK · corrector REV3-10 (diseño §5 «Bot del huésped», §8 «StayOverviewPage … y chat»):
// canal web del recepcionista IA sobre POST /guest-portal/chat (misma pila que WhatsApp,
// guest-bot.service.ts). Muestra el aviso de IA cuando el API lo declara
// (`disclosureShown`) y el resultado de cada turno (`action`): respondido, actualizado,
// pendiente de confirmación por recepción, derivado a una persona, sin identificar o
// desactivado. Sin `localStorage`: la conversación vive en la página.
//
// Tanda L7 · L7-05 (WCAG 2.2 · 1.3.1, 4.1.3): la sección se nombra por su título
// (`aria-labelledby`), el campo lleva etiqueta explícita (`<label htmlFor>` + `id`)
// y describe su propósito, el registro es `role="log"` con `aria-busy` mientras
// se espera la respuesta, el estado «enviando…» y los errores se anuncian en
// regiones vivas.

type Turn = { id: string; role: "guest" | "bot"; text: string; action?: ChatResponse["action"] };

const ACTION_KEY: Partial<Record<ChatResponse["action"], "chatHandoff" | "chatPending" | "chatUpdated" | "chatIdentify" | "chatDisabled">> = {
  handoff: "chatHandoff",
  pending_confirmation: "chatPending",
  updated: "chatUpdated",
  identify: "chatIdentify",
  disabled: "chatDisabled"
};

export function ChatWidget({ lang, propertyName }: { lang: Lang; propertyName?: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState(false);
  const conversationRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const introId = `${id}-intro`;
  const inputId = `${id}-input`;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setText("");
    setTurns((current) => [...current, { id: `g_${Date.now()}`, role: "guest", text: message }]);
    try {
      const response = await chat(message, { conversationId: conversationRef.current, language: lang });
      conversationRef.current = response.conversationId ?? conversationRef.current;
      if (response.disclosureShown) setDisclosure(true);
      setTurns((current) => [...current, { id: response.messageId ?? `b_${Date.now()}`, role: "bot", text: response.reply, action: response.action }]);
    } catch {
      setError(t(lang, "chatError"));
      setText(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gp-card gp-chat" aria-labelledby={titleId} aria-busy={busy}>
      <p className="gp-label" id={titleId}>{t(lang, "chatTitle")}</p>
      <p className="gp-meta" id={introId}>{t(lang, "chatIntro")}</p>
      {disclosure ? <p className="gp-disclosure" role="status">{t(lang, "chatDisclosure", { property: propertyName ?? "" })}</p> : null}
      <div className="gp-chat-log" ref={listRef} role="log" aria-live="polite" aria-busy={busy}>
        {turns.map((turn) => (
          <div key={turn.id} className={`gp-chat-turn gp-chat-${turn.role}`}>
            <p className="gp-chat-bubble">{turn.text}</p>
            {turn.action && ACTION_KEY[turn.action] ? <p className="gp-chat-action">{t(lang, ACTION_KEY[turn.action]!)}</p> : null}
          </div>
        ))}
      </div>
      <p className="gp-visually-hidden" role="status">{busy ? t(lang, "chatSending") : ""}</p>
      <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>
      <form className="gp-chat-form" onSubmit={onSubmit}>
        <label className="gp-field gp-chat-field" htmlFor={inputId}>
          <span className="gp-visually-hidden">{t(lang, "chatPlaceholder")}</span>
          <input id={inputId} type="text" value={text} onChange={(event) => setText(event.target.value)} placeholder={t(lang, "chatPlaceholder")} maxLength={4000} disabled={busy} autoComplete="off" aria-describedby={introId} />
        </label>
        <button type="submit" className="gp-button gp-button-primary" disabled={busy || !text.trim()}>
          {busy ? t(lang, "chatSending") : t(lang, "chatSend")}
        </button>
      </form>
    </section>
  );
}
