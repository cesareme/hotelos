import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

// ─── Helpers locales (replicados del NewGroupDialog para no acoplar) ─────

const fieldsetStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

// ─── Tipos de dominio · 6 categorías canónicas de evento ─────────────────

type EventType =
  | "welcome_cocktail"
  | "coffee_break"
  | "gala_dinner"
  | "conference"
  | "wedding"
  | "other";

type SetupStyle =
  | "theatre"
  | "u_shape"
  | "classroom"
  | "banquet"
  | "cocktail"
  | "boardroom";

type EventSpace = {
  id: string;
  name: string;
  capacity?: number;
};

type EventSpacesResponse = {
  event_spaces?: EventSpace[];
  eventSpaces?: EventSpace[];
} | EventSpace[];

export type GroupEvent = {
  id: string;
  groupBookingId: string;
  name: string;
  eventType: EventType;
  eventSpaceId?: string;
  startAt: string;
  endAt: string;
  expectedAttendees?: number;
  setupStyle: SetupStyle;
  notes?: string;
  createdAt?: string;
};

type CreateEventPayload = {
  name: string;
  eventType: EventType;
  eventSpaceId?: string;
  startAt: string;
  endAt: string;
  expectedAttendees?: number;
  setupStyle: SetupStyle;
  notes?: string;
};

// ─── Estado del form ─────────────────────────────────────────────────────

type FormState = {
  name: string;
  eventType: EventType;
  eventSpaceId: string;
  date: string;
  startTime: string;
  endTime: string;
  expectedAttendees: number | "";
  setupStyle: SetupStyle;
  notes: string;
};

// ─── Defaults inteligentes según tipo de evento ─ industria 2026 ─────────
function smartDefaultsForEventType(t: EventType): Partial<FormState> {
  switch (t) {
    case "gala_dinner":
      return { setupStyle: "banquet", startTime: "20:00", endTime: "23:00" };
    case "coffee_break":
      return { setupStyle: "cocktail", expectedAttendees: "" };
    case "conference":
      return { setupStyle: "theatre", startTime: "09:00", endTime: "13:00" };
    case "welcome_cocktail":
      return { setupStyle: "cocktail", startTime: "19:00", endTime: "21:00" };
    case "wedding":
      return { setupStyle: "banquet", startTime: "18:00", endTime: "23:59" };
    default:
      return {};
  }
}

// Combina date (YYYY-MM-DD) + time (HH:MM) en un ISO local-aware.
function combineDateTime(date: string, time: string): string {
  if (!date || !time) return "";
  const [h, m] = time.split(":").map((v) => Number(v));
  const [y, mo, d] = date.split("-").map((v) => Number(v));
  if ([h, m, y, mo, d].some((n) => Number.isNaN(n))) return "";
  const local = new Date(y, mo - 1, d, h, m, 0, 0);
  return local.toISOString();
}

function normalizeEventSpaces(payload: EventSpacesResponse | null): EventSpace[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.event_spaces)) return payload.event_spaces;
  if (Array.isArray(payload.eventSpaces)) return payload.eventSpaces;
  return [];
}

// ─── Componente principal ────────────────────────────────────────────────

export function NewEventDialog(props: {
  groupBookingId: string;
  groupName: string;
  arrivalDate: string;
  departureDate: string;
  onClose: () => void;
  onCreated: (event: GroupEvent) => void;
  onError: (msg: string) => void;
}) {
  const propertyId = useMemo(() => getActivePropertyId(), []);

  const [form, setForm] = useState<FormState>(() => ({
    name: "",
    eventType: "gala_dinner",
    eventSpaceId: "",
    date: props.arrivalDate,
    startTime: "20:00",
    endTime: "23:00",
    expectedAttendees: 50,
    setupStyle: "banquet",
    notes: ""
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Carga de salas disponibles para la propiedad activa.
  const eventSpacesState = useApiData<EventSpacesResponse>(
    `/properties/${propertyId}/event-spaces`
  );
  const eventSpaces = useMemo(
    () => normalizeEventSpaces(eventSpacesState.data),
    [eventSpacesState.data]
  );

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleEventTypeChange(next: EventType) {
    const patch = smartDefaultsForEventType(next);
    setForm((f) => ({ ...f, ...patch, eventType: next }));
  }

  // Resumen humano del horario para el usuario.
  const scheduleSummary = useMemo(() => {
    if (!form.date || !form.startTime || !form.endTime) return null;
    if (form.endTime <= form.startTime) {
      return "La hora de fin debe ser posterior a la hora de inicio.";
    }
    return `Evento programado el ${form.date} de ${form.startTime} a ${form.endTime}.`;
  }, [form.date, form.startTime, form.endTime]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Validaciones básicas
    if (!form.name.trim()) return setError("El nombre del evento es obligatorio.");
    if (!form.date) return setError("La fecha del evento es obligatoria.");
    if (form.date < props.arrivalDate || form.date > props.departureDate) {
      return setError(
        `La fecha debe estar dentro del rango del grupo (${props.arrivalDate} → ${props.departureDate}).`
      );
    }
    if (!form.startTime || !form.endTime) return setError("Indica hora de inicio y fin.");
    if (form.endTime <= form.startTime) return setError("La hora de fin debe ser posterior a la de inicio.");

    const startAt = combineDateTime(form.date, form.startTime);
    const endAt = combineDateTime(form.date, form.endTime);
    if (!startAt || !endAt) return setError("No se pudo calcular el rango horario del evento.");

    setSubmitting(true);
    try {
      const payload: CreateEventPayload = {
        name: form.name.trim(),
        eventType: form.eventType,
        eventSpaceId: form.eventSpaceId.trim() || undefined,
        startAt,
        endAt,
        expectedAttendees:
          typeof form.expectedAttendees === "number" && form.expectedAttendees > 0
            ? form.expectedAttendees
            : undefined,
        setupStyle: form.setupStyle,
        notes: form.notes.trim() || undefined
      };
      const created = await apiRequest<GroupEvent>(
        `/groups/${props.groupBookingId}/events`,
        { method: "POST", body: payload }
      );
      props.onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-event-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "92vh",
          overflow: "auto",
          background: "var(--surface-1, var(--surface))",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}>
              Comercial · Groups &amp; Events
            </p>
            <h3 id="new-event-title" style={{ margin: "2px 0 0 0" }}>Nuevo evento</h3>
            <p className="bo-muted" style={{ margin: "2px 0 0 0", fontSize: 12 }}>
              Asociado al grupo <strong>{props.groupName}</strong> · ventana {props.arrivalDate} → {props.departureDate}
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >×</button>
        </div>

        {/* 1. Identificación */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Identificación</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Nombre del evento *">
              <input
                type="text"
                required
                maxLength={160}
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                style={inputStyle}
                placeholder="Cena de gala García-López"
                autoFocus
              />
            </Field>
          </div>
          <Field label="Tipo de evento *" hint="Aplica defaults inteligentes (hora, setup) según el formato.">
            <select
              value={form.eventType}
              onChange={(e) => handleEventTypeChange(e.target.value as EventType)}
              style={inputStyle}
            >
              <option value="welcome_cocktail">🥂 Welcome cocktail</option>
              <option value="coffee_break">☕ Coffee break</option>
              <option value="gala_dinner">🍽️ Gala dinner</option>
              <option value="conference">🎤 Conference</option>
              <option value="wedding">💍 Wedding</option>
              <option value="other">⚙️ Other</option>
            </select>
          </Field>
        </fieldset>

        {/* 2. Cuándo */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Cuándo</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 12 }}>
            <Field label="Fecha *" hint={`Dentro de ${props.arrivalDate} → ${props.departureDate}`}>
              <input
                type="date"
                required
                value={form.date}
                min={props.arrivalDate}
                max={props.departureDate}
                onChange={(e) => update("date", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Hora inicio *">
              <input
                type="time"
                required
                value={form.startTime}
                onChange={(e) => update("startTime", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Hora fin *">
              <input
                type="time"
                required
                value={form.endTime}
                min={form.startTime}
                onChange={(e) => update("endTime", e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>
          {scheduleSummary ? (
            <p className="bo-muted" style={{ margin: "8px 0 0 0", fontSize: 12 }}>
              {scheduleSummary}
            </p>
          ) : null}
        </fieldset>

        {/* 3. Sala y setup */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Sala y setup</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 12 }}>
            <Field
              label="Sala / event space"
              hint={
                eventSpacesState.loading
                  ? "Cargando salas disponibles…"
                  : eventSpaces.length === 0
                    ? "No hay salas registradas para esta propiedad."
                    : "Selecciona el espacio asignado al evento."
              }
            >
              <select
                value={form.eventSpaceId}
                onChange={(e) => update("eventSpaceId", e.target.value)}
                style={inputStyle}
                disabled={eventSpacesState.loading}
              >
                <option value="">— Sin asignar —</option>
                {eventSpaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                    {typeof space.capacity === "number" ? ` (cap. ${space.capacity})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Estilo de montaje *" hint="Configuración del mobiliario / disposición.">
              <select
                value={form.setupStyle}
                onChange={(e) => update("setupStyle", e.target.value as SetupStyle)}
                style={inputStyle}
              >
                <option value="theatre">🎭 Theatre (auditorio)</option>
                <option value="u_shape">🇺 U-shape</option>
                <option value="classroom">🏫 Classroom (aula)</option>
                <option value="banquet">🍽️ Banquet (mesas redondas)</option>
                <option value="cocktail">🥂 Cocktail (de pie)</option>
                <option value="boardroom">⚙️ Boardroom</option>
              </select>
            </Field>
            <Field label="Asistentes esperados" hint="Pax aproximados para dimensionar F&B y montaje.">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={form.expectedAttendees}
                onChange={(e) => {
                  const v = e.target.value;
                  update("expectedAttendees", v === "" ? "" : Number(v));
                }}
                style={inputStyle}
                placeholder="50"
              />
            </Field>
          </div>
        </fieldset>

        {/* 4. Notas */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Notas</legend>
          <Field label="Observaciones internas">
            <textarea
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              style={{ ...inputStyle, minHeight: 70, resize: "vertical" }}
              placeholder="Alergias, AV / streaming, decoración, accesos VIP, timings, etc."
            />
          </Field>
        </fieldset>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>{error}</p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>* Campos obligatorios</p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>Cancelar</button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "Creando…" : "Crear evento"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
