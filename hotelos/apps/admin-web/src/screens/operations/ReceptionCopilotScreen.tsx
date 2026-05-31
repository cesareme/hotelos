import { useEffect, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { apiRequest } from "../../services/api-client";
import { useApiData } from "../../hooks/useApiData";
import { Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

type Conversation = { id: string; channel: string; status: string; guestId?: string; reservationId?: string; createdAt: string };
type Message = { id: string; conversationId: string; senderType: "guest" | "staff" | "ai"; body: string; sentAt: string };
type AiDraft = { disclosure: string; draft: string; requiresHumanReview: boolean; source: "ai" | "rules" };
type Kpis = { arrivalsToday: number; departuresToday: number; inHouseNow: number; unassignedRooms: number; pendingBalanceEur: number };

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "Email", webchat: "Chat web", sms: "SMS", app: "App" };

const INTENTS = [
  "¿Tienen parking?",
  "¿A qué hora es el check-out?",
  "¿Puedo hacer late check-out?",
  "¿Admiten mascotas?",
  "¿Cómo llego al hotel?",
  "¿El desayuno está incluido?",
  "¿Tienen wifi gratis?",
  "Quiero pedir un taxi"
];
const LANGUAGES = [
  { v: "auto", l: "Idioma del huésped" },
  { v: "es", l: "Español" },
  { v: "en", l: "Inglés" },
  { v: "fr", l: "Francés" },
  { v: "de", l: "Alemán" },
  { v: "it", l: "Italiano" },
  { v: "pt", l: "Portugués" }
];
const TONES = [
  { v: "cordial", l: "Cordial" },
  { v: "formal", l: "Formal" },
  { v: "cercano", l: "Cercano" },
  { v: "breve", l: "Breve" }
];

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}
function openSearch() {
  window.dispatchEvent(new CustomEvent("hotelos-open-search"));
}
function fmtNum(n: number | undefined): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(n ?? 0);
}
function fmtEur(n: number | undefined): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n ?? 0);
}

export function ReceptionCopilotScreen() {
  const fd = useApiData<{ kpis: Kpis }>(`/dashboards/front-desk?propertyId=${PROPERTY_ID}`, { pollIntervalMs: 60000 });
  const kpis = fd.data?.kpis ?? { arrivalsToday: 0, departuresToday: 0, inHouseNow: 0, unassignedRooms: 0, pendingBalanceEur: 0 };

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [guestMessage, setGuestMessage] = useState("");
  const [language, setLanguage] = useState("auto");
  const [tone, setTone] = useState("cordial");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [editedDraft, setEditedDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void apiRequest<Conversation[]>(`/properties/${PROPERTY_ID}/conversations`)
      .then((list) => setConversations(Array.isArray(list) ? list : []))
      .catch(() => setConversations([]));
  }, []);

  async function selectConversation(id: string) {
    setSelectedId(id);
    setDraft(null);
    setMessages([]);
    if (!id) {
      setGuestMessage("");
      return;
    }
    try {
      const msgs = await apiRequest<Message[]>(`/conversations/${id}/messages`);
      const list = Array.isArray(msgs) ? msgs : [];
      setMessages(list);
      const lastGuest = [...list].reverse().find((m) => m.senderType === "guest");
      if (lastGuest) setGuestMessage(lastGuest.body);
    } catch {
      setMessages([]);
    }
  }

  async function suggestReply() {
    if (!guestMessage.trim()) {
      setStatus("Escribe o elige primero el mensaje del huésped.");
      return;
    }
    setBusy(true);
    setStatus("Generando borrador…");
    setDraft(null);
    try {
      const convId = selectedId || "copilot-adhoc";
      const result = await apiRequest<AiDraft>(`/conversations/${convId}/ai-draft`, {
        method: "POST",
        body: { guestQuestion: guestMessage, tone, language }
      });
      setDraft(result);
      setEditedDraft(result.draft);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo generar el borrador.");
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!selectedId) {
      setStatus("Selecciona una conversación para enviar la respuesta.");
      return;
    }
    if (!editedDraft.trim()) return;
    setBusy(true);
    setStatus("Enviando…");
    try {
      await apiRequest(`/conversations/${selectedId}/messages`, { method: "POST", body: { senderType: "staff", body: editedDraft } });
      await selectConversation(selectedId);
      setDraft(null);
      setStatus("Respuesta enviada ✓");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo enviar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-page" style={{ display: "grid", gap: 16 }}>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Recepción · Copiloto</div>
          <h1 className="bo-page-title">Copiloto de recepción</h1>
          <p className="bo-muted" style={{ maxWidth: 760, textTransform: "none" }}>
            Tu centro de mando: el pulso del día, accesos directos a las tareas y un asistente de IA que redacta las
            respuestas a los huéspedes. <strong>La IA nunca envía nada sola</strong> — tú revisas y envías.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => navigateTo("FrontDeskDashboard")}>Ver «Mi día» →</button>
        </div>
      </div>

      {/* Pulso del día */}
      <div className="rev-kpi-grid" data-tour="cop-pulse">
        <article className="rev-kpi rev-kpi-ok" role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => navigateTo("FrontDeskDashboard")}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Llegadas hoy</span><span className="bo-status info">hoy</span></div>
          <div className="rev-kpi-value">{fmtNum(kpis.arrivalsToday)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok" role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => navigateTo("FrontDeskDashboard")}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Salidas hoy</span><span className="bo-status info">hoy</span></div>
          <div className="rev-kpi-value">{fmtNum(kpis.departuresToday)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">En el hotel</span><span className="bo-status ok">ocupadas</span></div>
          <div className="rev-kpi-value">{fmtNum(kpis.inHouseNow)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.unassignedRooms > 0 ? "warn" : "ok"}`} role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => navigateTo("FrontDeskDashboard")}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Sin habitación</span><span className={`bo-status ${kpis.unassignedRooms > 0 ? "warn" : "ok"}`}>{kpis.unassignedRooms > 0 ? "asignar" : "al día"}</span></div>
          <div className="rev-kpi-value">{fmtNum(kpis.unassignedRooms)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.pendingBalanceEur > 0 ? "warn" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo pendiente</span><span className={`bo-status ${kpis.pendingBalanceEur > 0 ? "warn" : "ok"}`}>{kpis.pendingBalanceEur > 0 ? "cobrar" : "al día"}</span></div>
          <div className="rev-kpi-value">{fmtEur(kpis.pendingBalanceEur)}</div>
        </article>
      </div>

      {/* Acciones rápidas */}
      <div className="bo-actions" data-tour="cop-actions" style={{ flexWrap: "wrap" }}>
        <button type="button" className="primary" onClick={() => navigateTo("ReservationCreate")}>+ Crear reserva</button>
        <button type="button" onClick={openSearch}>Buscar huésped (⌘K)</button>
        <button type="button" onClick={() => navigateTo("ReservationAgent")}>✨ Reservar con IA</button>
        <button type="button" onClick={() => navigateTo("FrontDeskDashboard")}>Llegadas / check-in</button>
        <button type="button" onClick={() => navigateTo("LiveTimelineWorkspace")}>Live Timeline</button>
      </div>

      <div className="bo-grid two">
        {/* Mensaje del huésped */}
        <section className="bo-card" data-tour="cop-input">
          <div className="bo-card-head">
            <h3>Mensaje del huésped</h3>
            {conversations.length > 0 ? <span className="bo-chip">{conversations.length} conversaciones</span> : <span className="bo-chip">mensaje suelto</span>}
          </div>

          {conversations.length > 0 ? (
            <div className="bo-pill-row" style={{ marginBottom: 8 }}>
              <button type="button" className={`bo-pill${selectedId === "" ? " is-active" : ""}`} style={{ cursor: "pointer" }} onClick={() => void selectConversation("")}>Mensaje suelto</button>
              {conversations.slice(0, 6).map((c) => (
                <button key={c.id} type="button" className={`bo-pill${selectedId === c.id ? " is-active" : ""}`} style={{ cursor: "pointer" }} onClick={() => void selectConversation(c.id)}>
                  {CHANNEL_LABEL[c.channel] ?? c.channel} · {c.id.slice(0, 6)}
                </button>
              ))}
            </div>
          ) : null}

          {messages.length > 0 ? (
            <div className="bo-card" style={{ maxHeight: 160, overflowY: "auto", background: "var(--surface-soft)" }}>
              {messages.slice(-6).map((m) => (
                <div key={m.id} className="bo-row" style={{ alignItems: "flex-start", gap: 8 }}>
                  <span className={`bo-status ${m.senderType === "guest" ? "info" : m.senderType === "ai" ? "ai" : "ok"}`} style={{ fontSize: 10 }}>
                    {m.senderType === "guest" ? "Huésped" : m.senderType === "ai" ? "IA" : "Recepción"}
                  </span>
                  <span style={{ flex: 1, fontSize: 13 }}>{m.body}</span>
                </div>
              ))}
            </div>
          ) : null}

          <label className="bo-form-field">
            <span>Mensaje del huésped</span>
            <textarea value={guestMessage} onChange={(e) => setGuestMessage(e.target.value)} rows={4} placeholder="Ej.: ¿Tienen parking? ¿A qué hora es el check-out?" disabled={busy} />
          </label>

          <div data-tour="cop-intents">
            <span className="bo-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Preguntas frecuentes</span>
            <div className="bo-pill-row" style={{ marginTop: 6 }}>
              {INTENTS.map((q) => (
                <button key={q} type="button" className="bo-pill" style={{ cursor: "pointer" }} disabled={busy} onClick={() => setGuestMessage(q)}>{q}</button>
              ))}
            </div>
          </div>

          <div className="bo-row" data-tour="cop-options" style={{ gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label className="bo-muted" style={{ fontSize: 12 }}>Responder en</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
              {LANGUAGES.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
            </select>
            <label className="bo-muted" style={{ fontSize: 12 }}>Tono</label>
            <select value={tone} onChange={(e) => setTone(e.target.value)} disabled={busy}>
              {TONES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
          </div>

          <div className="bo-actions" style={{ marginTop: 12 }}>
            <button className="primary" type="button" disabled={busy || !guestMessage.trim()} onClick={() => void suggestReply()}>
              {busy ? <><Spinner size="sm" /> Generando…</> : "✨ Sugerir respuesta con IA"}
            </button>
          </div>
        </section>

        {/* Borrador sugerido */}
        <section className="bo-card" data-tour="cop-draft">
          <div className="bo-card-head">
            <h3>Borrador sugerido</h3>
            {draft ? (
              <span className={`bo-status ${draft.source === "ai" ? "ok" : "info"}`}>{draft.source === "ai" ? "✨ Generado por IA" : "📋 Por reglas"}</span>
            ) : null}
          </div>

          {draft ? (
            <>
              {draft.requiresHumanReview ? (
                <p className="bo-status warn" style={{ display: "inline-block", padding: "4px 10px", textTransform: "none" }}>
                  ⚠ Requiere tu revisión: el mensaje puede ser sensible (queja, reembolso, urgencia).
                </p>
              ) : null}
              {draft.source === "rules" ? (
                <p className="bo-muted" style={{ textTransform: "none" }}>
                  La IA no está configurada, así que este borrador se generó por reglas. Configura un proveedor de IA
                  (Ajustes de IA) para respuestas redactadas por modelo.
                </p>
              ) : null}
              <label className="bo-form-field">
                <span>Respuesta (puedes editarla antes de enviar)</span>
                <textarea value={editedDraft} onChange={(e) => setEditedDraft(e.target.value)} rows={8} disabled={busy} />
              </label>
              <div className="bo-actions">
                <button className="primary" type="button" disabled={busy || !selectedId || !editedDraft.trim()} onClick={() => void sendReply()}>Enviar respuesta</button>
                <button type="button" disabled={busy} onClick={() => { void navigator.clipboard?.writeText(editedDraft); setStatus("Copiado al portapapeles ✓"); }}>Copiar</button>
              </div>
              {!selectedId ? (
                <p className="bo-muted" style={{ textTransform: "none" }}>Para enviar directamente, elige una conversación arriba. Si es un mensaje suelto, copia la respuesta.</p>
              ) : null}
            </>
          ) : (
            <p className="bo-muted" style={{ textTransform: "none" }}>
              Escribe o elige el mensaje del huésped, ajusta idioma y tono, y pulsa «Sugerir respuesta con IA».
            </p>
          )}
        </section>
      </div>

      {status ? <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>{status}</p> : null}
    </section>
  );
}
