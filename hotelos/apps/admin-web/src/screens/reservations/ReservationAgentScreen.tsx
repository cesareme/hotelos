import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useRef, useState } from "react";
import {
  aiParseReservation,
  createReservation,
  quoteAvailability,
  fetchRoomTypes,
  type AdminReservation,
  type AdminRoomType,
  type AvailabilityQuote,
  type ReservationParseResult
} from "../../services/pmsCommerceApi";
import { Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

const BOARD_OPTIONS = [
  { value: "", label: "—" },
  { value: "RO", label: "Solo alojamiento (RO)" },
  { value: "BB", label: "Alojamiento y desayuno (BB)" },
  { value: "HB", label: "Media pensión (HB)" },
  { value: "FB", label: "Pensión completa (FB)" },
  { value: "AI", label: "Todo incluido (AI)" }
];

const EXAMPLES = [
  "Doble para 2 adultos, 3 noches desde el próximo viernes, a nombre de María García",
  "Suite for a couple, 2 nights from 12/06, breakfast included, guest John Smith",
  "1 habitación familiar, 2 adultos y 1 niño, del 10 al 14 de julio",
  "Single room, 1 night tonight, room only, +34600111222"
];

type Draft = {
  arrivalDate: string; departureDate: string; adults: string; children: string;
  roomTypeId: string; boardType: string; guestName: string; email: string; phone: string; specialRequests: string;
};
const EMPTY: Draft = {
  arrivalDate: "", departureDate: "", adults: "2", children: "0",
  roomTypeId: "", boardType: "", guestName: "", email: "", phone: "", specialRequests: ""
};

// Browser Speech Recognition (Chrome/Edge/Safari). Honest fallback when absent.
function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export function ReservationAgentScreen() {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<ReservationParseResult | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [quotes, setQuotes] = useState<AvailabilityQuote[]>([]);
  const [created, setCreated] = useState<AdminReservation | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");
  const speechSupported = Boolean(getSpeechRecognition());

  useEffect(() => {
    void fetchRoomTypes(PROPERTY_ID).then(setRoomTypes).catch(() => setRoomTypes([]));
    return () => recognitionRef.current?.stop();
  }, []);

  function set<K extends keyof Draft>(key: K, value: string) {
    setDraft((cur) => ({ ...cur, [key]: value }));
  }

  function toggleListen() {
    const SR = getSpeechRecognition();
    if (!SR) return;
    if (listening) { recognitionRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = "es-ES";
    rec.interimResults = true;
    rec.continuous = false;
    baseTextRef.current = text ? `${text} ` : "";
    rec.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i]![0]!.transcript;
      setText(baseTextRef.current + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function handleParse() {
    if (!text.trim()) { setStatus("Escribe o dicta una solicitud primero."); return; }
    if (listening) recognitionRef.current?.stop();
    setParsing(true);
    setStatus(null);
    setCreated(null);
    setQuotes([]);
    try {
      const res = await aiParseReservation(PROPERTY_ID, text);
      setResult(res);
      const d = res.draft;
      setDraft({
        arrivalDate: d.arrivalDate ?? "",
        departureDate: d.departureDate ?? "",
        adults: String(d.adults ?? 2),
        children: String(d.children ?? 0),
        roomTypeId: d.roomTypeId ?? "",
        boardType: d.boardType ?? "",
        guestName: d.guestName ?? "",
        email: d.email ?? "",
        phone: d.phone ?? "",
        specialRequests: d.specialRequests ?? ""
      });
      if (res.source === "none") setStatus(res.message ?? "No se pudo entender la solicitud.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Fallo al procesar.");
    } finally {
      setParsing(false);
    }
  }

  async function handleQuote() {
    if (!draft.arrivalDate || !draft.departureDate) { setStatus("Se necesitan fechas de llegada y salida para cotizar."); return; }
    setBusy(true);
    setStatus("Consultando disponibilidad…");
    try {
      const q = await quoteAvailability(PROPERTY_ID, {
        arrivalDate: draft.arrivalDate, departureDate: draft.departureDate,
        adults: Number(draft.adults), children: Number(draft.children)
      });
      setQuotes(q);
      const match = draft.roomTypeId ? q.find((x) => x.roomTypeId === draft.roomTypeId) : q.find((x) => x.availableRooms > 0);
      if (match && !draft.roomTypeId) set("roomTypeId", match.roomTypeId);
      setStatus(`Disponibilidad consultada para ${q.length} tipos de habitación.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Fallo al cotizar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!draft.arrivalDate || !draft.departureDate || !draft.roomTypeId) {
      setStatus("Llegada, salida y tipo de habitación son obligatorios para crear la reserva.");
      return;
    }
    setBusy(true);
    setStatus("Creando reserva…");
    const [firstName, ...rest] = draft.guestName.trim().split(/\s+/);
    const quote = quotes.find((q) => q.roomTypeId === draft.roomTypeId);
    try {
      const reservation = await createReservation(PROPERTY_ID, {
        channel: "direct",
        arrivalDate: draft.arrivalDate,
        departureDate: draft.departureDate,
        adults: Number(draft.adults),
        children: Number(draft.children),
        roomTypeId: draft.roomTypeId,
        boardType: draft.boardType || undefined,
        specialRequests: draft.specialRequests || undefined,
        totalAmount: quote?.totalAmount ?? 0,
        currency: "EUR",
        sourceCode: "ai_agent",
        primaryGuest: firstName ? {
          firstName,
          surname1: rest.join(" ") || undefined,
          email: draft.email || undefined,
          phone: draft.phone || undefined
        } : undefined
      });
      setCreated(reservation);
      setStatus(`Reserva ${reservation.code} creada.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Fallo al crear.");
    } finally {
      setBusy(false);
    }
  }

  const srcBadge = result
    ? result.source === "ai" ? { label: "AI", cls: "ai" } : result.source === "rules" ? { label: "Understood", cls: "ok" } : { label: "Not understood", cls: "warn" }
    : null;

  return (
    <>
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">PMS · AI Booking Agent</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>Book by voice or text</h2>
          </div>
          <span className="bo-chip">AI-assisted</span>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          Speak or type a booking request in plain language. The agent extracts dates, guests, room type and board into a draft
          you review before creating the reservation. Nothing is booked until you confirm.
        </p>

        <div className="bo-form-field" style={{ marginTop: "var(--space-4)" }}>
          <span>Booking request</span>
          <div style={{ position: "relative" }}>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder='e.g. "Doble para 2 adultos, 3 noches desde el próximo viernes, a nombre de María García"'
              rows={3}
              style={{ width: "100%", paddingRight: speechSupported ? 52 : undefined }}
            />
            {speechSupported ? (
              <button
                type="button"
                className={listening ? "primary" : ""}
                onClick={toggleListen}
                aria-label={listening ? "Stop listening" : "Dictate"}
                title={listening ? "Stop listening" : "Dictate"}
                style={{ position: "absolute", top: 8, right: 8, width: 38, height: 38, padding: 0, borderRadius: "var(--radius-full)" }}
              >
                {listening ? "■" : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            ) : null}
          </div>
          {listening ? <small className="bo-status ai" style={{ display: "inline-flex", marginTop: 6 }}><Spinner size="sm" /> Listening…</small> : null}
          {!speechSupported ? <small className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>Voice dictation isn't supported in this browser — type your request (it works the same).</small> : null}
        </div>

        <div className="bo-pill-row" style={{ marginTop: "var(--space-2)" }}>
          <span className="bo-muted">Try:</span>
          {EXAMPLES.map((ex) => (
            <button type="button" className="bo-pill" key={ex} onClick={() => setText(ex)} style={{ cursor: "pointer" }}>{ex.slice(0, 38)}…</button>
          ))}
        </div>

        <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
          <button type="button" className="primary" onClick={handleParse} disabled={parsing || !text.trim()}>
            {parsing ? <><Spinner size="sm" /> Procesando…</> : "Procesar solicitud"}
          </button>
        </div>
        {status ? <p className={status.startsWith("Reservation") ? "bo-status ok" : "bo-muted"} style={{ marginTop: "var(--space-3)", display: "inline-flex", textTransform: "none", letterSpacing: 0 }}>{status}</p> : null}
      </section>

      {result && result.source !== "none" ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Extracted booking</p>
              <h3 style={{ margin: 0 }}>Review &amp; confirm</h3>
            </div>
            {srcBadge ? <span className={`bo-status ${srcBadge.cls}`}>{srcBadge.label} · {Math.round(result.confidence * 100)}% confident</span> : null}
          </div>

          <div className="bo-grid three">
            <label className="bo-form-field"><span>Arrival <strong>required</strong></span>
              <input type="date" value={draft.arrivalDate} onChange={(e) => set("arrivalDate", e.target.value)} /></label>
            <label className="bo-form-field"><span>Departure <strong>required</strong></span>
              <input type="date" value={draft.departureDate} onChange={(e) => set("departureDate", e.target.value)} /></label>
            <label className="bo-form-field"><span>Adults / children</span>
              <div className="bo-inline-inputs">
                <input type="number" min="1" value={draft.adults} onChange={(e) => set("adults", e.target.value)} aria-label="Adults" />
                <input type="number" min="0" value={draft.children} onChange={(e) => set("children", e.target.value)} aria-label="Children" />
              </div>
            </label>
            <label className="bo-form-field"><span>Room type <strong>required</strong></span>
              <select value={draft.roomTypeId} onChange={(e) => set("roomTypeId", e.target.value)}>
                <option value="">Select…</option>
                {roomTypes.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
              </select>
            </label>
            <label className="bo-form-field"><span>Board</span>
              <select value={draft.boardType} onChange={(e) => set("boardType", e.target.value)}>
                {BOARD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="bo-form-field"><span>Guest name</span>
              <input value={draft.guestName} onChange={(e) => set("guestName", e.target.value)} /></label>
            <label className="bo-form-field"><span>Email</span>
              <input type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} /></label>
            <label className="bo-form-field"><span>Phone</span>
              <input value={draft.phone} onChange={(e) => set("phone", e.target.value)} /></label>
          </div>
          <label className="bo-form-field"><span>Special requests</span>
            <textarea value={draft.specialRequests} onChange={(e) => set("specialRequests", e.target.value)} /></label>

          {quotes.length ? (
            <div className="bo-pill-row" style={{ margin: "var(--space-2) 0" }}>
              {quotes.map((q) => (
                <button type="button" key={q.roomTypeId} className={`bo-pill${draft.roomTypeId === q.roomTypeId ? " is-active" : ""}`} onClick={() => set("roomTypeId", q.roomTypeId)} style={{ cursor: "pointer" }}>
                  {q.roomTypeName}: {q.availableRooms} avail · {q.totalAmount} {q.currency}
                </button>
              ))}
            </div>
          ) : null}

          <div className="bo-actions">
            <button type="button" onClick={handleQuote} disabled={busy}>Cotizar disponibilidad</button>
            <button type="button" className="primary" onClick={handleCreate} disabled={busy || !draft.arrivalDate || !draft.departureDate || !draft.roomTypeId}>
              {busy ? <><Spinner size="sm" /> Procesando…</> : "Crear reserva"}
            </button>
          </div>

          {created ? (
            <article className="bo-card" style={{ marginTop: "var(--space-3)" }}>
              <div className="bo-card-head"><h3 style={{ margin: 0 }}>{created.code}</h3><span className="bo-status ok">Created</span></div>
              <div className="bo-actions">
                <button type="button" onClick={() => { window.history.pushState(null, "", `/backoffice/reservations/${created.id}`); window.dispatchEvent(new PopStateEvent("popstate")); }}>Open reservation</button>
              </div>
            </article>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
