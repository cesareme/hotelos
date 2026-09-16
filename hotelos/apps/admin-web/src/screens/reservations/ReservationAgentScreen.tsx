// Dictar una reserva — Recepción › Nueva reserva › Dictar (IA)
// (/recepcion/reservas/nueva/dictar).
//
// Cocoa 22 · ola 3 · lote 3-A (form archetype, template `Formulario`):
// CocoaPage → CocoaSection «Petición de reserva» with a multiline CocoaInput,
// the dictation button (browser speech recognition, honest fallback when the
// browser has none), example chips and «Procesar solicitud» → CocoaSection
// «Revisa y confirma» with CocoaFormRow + CocoaField controls over the draft
// the agent returned, the availability quotes as pressable chips and the two
// actions (Cotizar · Crear reserva) → CocoaCallout with the outcome and
// «Abrir reserva». Same API calls as before (ai-parse, availability quote,
// createReservation) and the same dictation flow. Hosted inside
// NuevaReservaTabs the container paints the title.

import { useEffect, useRef, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { urlForScreen } from "../../navigation/nav-tree";
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
import { useTabHost } from "../tabs/TabHost";
import { money, percent, plural } from "../../lib/format";
import { FIELD_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaStepper,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const BOARD_OPTIONS = [
  { value: "", label: "—" },
  { value: "RO", label: "Solo alojamiento (RO)" },
  { value: "BB", label: "Alojamiento y desayuno (BB)" },
  { value: "HB", label: "Media pensión (HB)" },
  { value: "FB", label: "Pensión completa (FB)" },
  { value: "AI", label: "Todo incluido (AI)" }
];

// Sample requests (the agent understands Spanish and English input).
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

function toCount(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function ReservationAgentScreen() {
  const hosted = useTabHost() !== null;
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
      setStatus(error instanceof Error ? error.message : "No se pudo procesar la solicitud.");
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
      setStatus(`Disponibilidad consultada para ${plural(q.length, "tipo de habitación", "tipos de habitación")}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo consultar la disponibilidad.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!draft.arrivalDate || !draft.departureDate || !draft.roomTypeId) {
      setStatus("Llegada, salida y tipo de habitación son obligatorios para crear la reserva.");
      return;
    }
    const [firstName, ...rest] = draft.guestName.trim().split(/\s+/);
    // The API refuses a primary guest without surname (400 «primaryGuest.surname1
    // (apellido) es obligatorio») since the Tanda 4 cierre: a guest record with
    // no surname is unusable for the parte de viajeros. Ask here instead of
    // letting the request fail.
    if (firstName && rest.length === 0) {
      setStatus("Indica nombre y apellido del huésped (por ejemplo «Ana García») o deja el campo vacío.");
      return;
    }
    setBusy(true);
    setStatus("Creando reserva…");
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
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo crear la reserva.");
    } finally {
      setBusy(false);
    }
  }

  function openCreated() {
    if (!created) return;
    openTabPath(urlForScreen("ReservationDetailWorkspace", { id: created.id }) ?? "/recepcion/reservas");
  }

  const source: { label: string; tone: CocoaTone } | null = result
    ? result.source === "ai"
      ? { label: "IA", tone: "ai" }
      : result.source === "rules"
        ? { label: "Entendida", tone: "success" }
        : { label: "No entendida", tone: "warning" }
    : null;
  const canCreate = Boolean(draft.arrivalDate && draft.departureDate && draft.roomTypeId);

  return (
    <CocoaPage
      eyebrow="Recepción · Nueva reserva"
      title="Dictar una reserva"
      subtitle={hosted ? undefined : "Dicta o escribe la petición en lenguaje natural; el agente prepara un borrador que revisas antes de crear la reserva."}
      actions={<CocoaBadge tone="ai">Asistido por IA</CocoaBadge>}
      commands={[{ id: "dictar-procesar", label: "Procesar la petición dictada", run: () => void handleParse() }]}
    >
      <CocoaSection title="Petición de reserva" meta={speechSupported ? (listening ? "escuchando" : "voz o texto") : "solo texto"}>
        <p>
          El agente extrae fechas, huéspedes, tipo de habitación y régimen en un borrador que revisas antes de crear la reserva. No se reserva
          nada hasta que confirmes.
        </p>
        <CocoaField label="Petición" help={speechSupported ? undefined : "Este navegador no admite dictado por voz: escribe la petición (funciona igual)."}>
          <CocoaInput
            id="dictar-peticion"
            value={text}
            onChange={setText}
            multiline
            rows={3}
            placeholder="Doble para 2 adultos, 3 noches desde el próximo viernes, a nombre de María García"
          />
        </CocoaField>
        <div className="cocoa-row" data-gap="2">
          {speechSupported ? (
            <CocoaButton
              variant={listening ? "tinted" : "bordered"}
              tone={listening ? "accent" : "neutral"}
              size="small"
              aria-pressed={listening}
              icon={<MicIcon />}
              onClick={toggleListen}
            >
              {listening ? "Detener dictado" : "Dictar"}
            </CocoaButton>
          ) : null}
          {listening ? (
            <CocoaBadge tone="ai" variant="dot">
              Escuchando…
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="filled" tone="accent" size="small" loading={parsing} disabled={parsing || !text.trim()} onClick={() => void handleParse()}>
            Procesar solicitud
          </CocoaButton>
        </div>
        <div className="cocoa-row" data-gap="2">
          <span className="cocoa-caption">Prueba con</span>
          {EXAMPLES.map((example) => (
            <CocoaButton key={example} variant="plain" tone="neutral" size="small" title={example} onClick={() => setText(example)}>
              {example.slice(0, 38)}…
            </CocoaButton>
          ))}
        </div>
        {status && !created ? (
          <CocoaCallout tone="neutral" role="status">
            {status}
          </CocoaCallout>
        ) : null}
      </CocoaSection>

      {result && result.source !== "none" && source ? (
        <CocoaSection
          title="Revisa y confirma"
          meta={
            <CocoaBadge tone={source.tone}>
              {source.label} · {percent(result.confidence * 100, { maximumFractionDigits: 0 })} de confianza
            </CocoaBadge>
          }
        >
          <CocoaFormRow columns={3} min={200}>
            <CocoaField label="Llegada" required>
              <CocoaDatePicker value={draft.arrivalDate} onChange={(v) => set("arrivalDate", v)} />
            </CocoaField>
            <CocoaField label="Salida" required>
              <CocoaDatePicker value={draft.departureDate} onChange={(v) => set("departureDate", v)} />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.roomType} required>
              <CocoaSelect
                value={draft.roomTypeId}
                onChange={(v) => set("roomTypeId", v)}
                placeholder="Selecciona…"
                options={roomTypes.map((rt) => ({ value: rt.id, label: rt.name }))}
              />
            </CocoaField>
            <CocoaField label="Adultos">
              <CocoaStepper value={toCount(draft.adults, 2)} onChange={(n) => set("adults", String(n))} min={1} />
            </CocoaField>
            <CocoaField label="Niños">
              <CocoaStepper value={toCount(draft.children, 0)} onChange={(n) => set("children", String(n))} min={0} />
            </CocoaField>
            <CocoaField label="Régimen">
              <CocoaSelect value={draft.boardType} onChange={(v) => set("boardType", v)} options={BOARD_OPTIONS} />
            </CocoaField>
            <CocoaField label="Nombre del huésped" help="Nombre y apellido, por ejemplo «Ana García».">
              <CocoaInput value={draft.guestName} onChange={(v) => set("guestName", v)} autoComplete="off" />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.email}>
              <CocoaInput type="email" value={draft.email} onChange={(v) => set("email", v)} autoComplete="off" />
            </CocoaField>
            <CocoaField label={FIELD_LABELS.phone}>
              <CocoaInput type="tel" value={draft.phone} onChange={(v) => set("phone", v)} autoComplete="off" />
            </CocoaField>
            <CocoaField label="Peticiones especiales" fullWidth>
              <CocoaInput value={draft.specialRequests} onChange={(v) => set("specialRequests", v)} multiline rows={2} />
            </CocoaField>
          </CocoaFormRow>

          {quotes.length > 0 ? (
            <div className="cocoa-row" data-gap="2" role="group" aria-label="Disponibilidad por tipo de habitación">
              {quotes.map((q) => {
                const active = draft.roomTypeId === q.roomTypeId;
                return (
                  <CocoaButton
                    key={q.roomTypeId}
                    variant={active ? "tinted" : "bordered"}
                    tone={active ? "accent" : "neutral"}
                    size="small"
                    aria-pressed={active}
                    onClick={() => set("roomTypeId", q.roomTypeId)}
                  >
                    {q.roomTypeName}: {plural(q.availableRooms, "disponible", "disponibles")} · {money(q.totalAmount, q.currency)}
                  </CocoaButton>
                );
              })}
            </div>
          ) : null}

          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" disabled={busy} onClick={() => void handleQuote()}>
              Cotizar disponibilidad
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" loading={busy} disabled={busy || !canCreate} onClick={() => void handleCreate()}>
              Crear reserva
            </CocoaButton>
          </div>

          {created ? (
            <CocoaCallout
              tone="success"
              role="status"
              title={`Reserva ${created.code} creada`}
              actions={
                <CocoaButton variant="filled" tone="accent" size="small" onClick={openCreated}>
                  Abrir reserva
                </CocoaButton>
              }
            >
              Abre el detalle para asignar habitación y completar los datos del huésped.
            </CocoaCallout>
          ) : null}
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}
