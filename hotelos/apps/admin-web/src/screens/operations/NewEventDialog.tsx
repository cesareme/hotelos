// NewEventDialog — create an event (banquet, conference…) of a group.
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «diálogo / drawer»): a CocoaDrawer
// (right, md; bottom sheet on phones) whose body is a <form> of four
// CocoaFormSections (identification, when, room and setup, notes); the
// footer has two buttons: Cancelar and «Crear evento» (submits the form by
// `form=`). Smart defaults by event type (setup and hours) are kept.
// Reads GET /properties/:id/event-spaces; POST /groups/:id/events.
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { date, dateRange, number } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import {
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaSelect
} from "../../components/cocoa";

const FORM_ID = "new-event-form";
const NAME_INPUT_ID = "new-event-name";

// ─── Domain types · six canonical event types ────────────────────────────

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

const EVENT_TYPE_OPTIONS: Array<{ value: EventType; label: string }> = [
  { value: "welcome_cocktail", label: "Cóctel de bienvenida" },
  { value: "coffee_break", label: "Pausa café" },
  { value: "gala_dinner", label: "Cena de gala" },
  { value: "conference", label: "Conferencia" },
  { value: "wedding", label: "Boda" },
  { value: "other", label: "Otro" }
];

const SETUP_STYLE_OPTIONS: Array<{ value: SetupStyle; label: string }> = [
  { value: "theatre", label: "Teatro (auditorio)" },
  { value: "u_shape", label: "En U" },
  { value: "classroom", label: "Aula" },
  { value: "banquet", label: "Banquete (mesas redondas)" },
  { value: "cocktail", label: "Cóctel (de pie)" },
  { value: "boardroom", label: "Sala de juntas" }
];

// ─── Form state ──────────────────────────────────────────────────────────

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

// Smart defaults by event type (setup and hours).
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

// date (YYYY-MM-DD) + time (HH:MM) → ISO instant in the local zone.
function combineDateTime(day: string, time: string): string {
  if (!day || !time) return "";
  const [h, m] = time.split(":").map((v) => Number(v));
  const [y, mo, d] = day.split("-").map((v) => Number(v));
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

// Secondary note under a row (schedule summary): identity from the system.
const NOTE_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)"
};

// ─── Main component ──────────────────────────────────────────────────────

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

  // Rooms available in the active property.
  const eventSpacesState = useApiData<EventSpacesResponse>(`/properties/${propertyId}/event-spaces`);
  const eventSpaces = useMemo(() => normalizeEventSpaces(eventSpacesState.data), [eventSpacesState.data]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleEventTypeChange(next: EventType) {
    const patch = smartDefaultsForEventType(next);
    setForm((f) => ({ ...f, ...patch, eventType: next }));
  }

  // Human summary of the schedule.
  const scheduleSummary = useMemo(() => {
    if (!form.date || !form.startTime || !form.endTime) return null;
    if (form.endTime <= form.startTime) return "La hora de fin debe ser posterior a la hora de inicio.";
    return `Evento programado el ${date(form.date, "medium")} de ${form.startTime} a ${form.endTime}.`;
  }, [form.date, form.startTime, form.endTime]);

  const stay = dateRange(props.arrivalDate, props.departureDate);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) return setError("El nombre del evento es obligatorio.");
    if (!form.date) return setError("La fecha del evento es obligatoria.");
    if (form.date < props.arrivalDate || form.date > props.departureDate) {
      return setError(`La fecha debe estar dentro de la estancia del grupo (${stay}).`);
    }
    if (!form.startTime || !form.endTime) return setError("Indica la hora de inicio y la de fin.");
    if (form.endTime <= form.startTime) return setError("La hora de fin debe ser posterior a la de inicio.");

    const startAt = combineDateTime(form.date, form.startTime);
    const endAt = combineDateTime(form.date, form.endTime);
    if (!startAt || !endAt) return setError("No se pudo calcular el horario del evento.");

    setSubmitting(true);
    try {
      const payload: CreateEventPayload = {
        name: form.name.trim(),
        eventType: form.eventType,
        eventSpaceId: form.eventSpaceId.trim() || undefined,
        startAt,
        endAt,
        expectedAttendees: typeof form.expectedAttendees === "number" && form.expectedAttendees > 0 ? form.expectedAttendees : undefined,
        setupStyle: form.setupStyle,
        notes: form.notes.trim() || undefined
      };
      const created = await apiRequest<GroupEvent>(`/groups/${props.groupBookingId}/events`, { method: "POST", body: payload });
      props.onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const spaceOptions = [
    { value: "", label: "Sin asignar" },
    ...eventSpaces.map((space) => ({
      value: space.id,
      label: `${space.name}${typeof space.capacity === "number" ? ` (aforo ${number(space.capacity)})` : ""}`
    }))
  ];

  return (
    <CocoaDrawer
      open
      onClose={props.onClose}
      title="Nuevo evento"
      subtitle={`Asociado al grupo ${props.groupName} · estancia ${stay}`}
      side="right"
      size="md"
      initialFocus={() => document.getElementById(NAME_INPUT_ID)}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" type="submit" form={FORM_ID} loading={submitting} disabled={submitting}>
            Crear evento
          </CocoaButton>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="cocoa-stack" data-gap="4" noValidate>
        <CocoaFormSection title="Identificación">
          <CocoaField label="Nombre del evento" required fullWidth>
            <CocoaInput id={NAME_INPUT_ID} value={form.name} onChange={(value) => update("name", value)} maxLength={160} placeholder="Cena de gala García-López" required />
          </CocoaField>
          <CocoaField label="Tipo de evento" required help="Ajusta el horario y el montaje por defecto según el formato.">
            <CocoaSelect value={form.eventType} onChange={(value) => handleEventTypeChange(value as EventType)} options={EVENT_TYPE_OPTIONS} />
          </CocoaField>
        </CocoaFormSection>

        <CocoaFormSection title="Cuándo">
          <CocoaFormRow columns={3} min={140}>
            <CocoaField label="Fecha" required help={`Dentro de ${stay}.`}>
              <CocoaDatePicker value={form.date} onChange={(value) => update("date", value)} min={props.arrivalDate} max={props.departureDate} required />
            </CocoaField>
            <CocoaField label="Hora de inicio" required>
              <CocoaInput value={form.startTime} onChange={(value) => update("startTime", value)} type="time" required />
            </CocoaField>
            <CocoaField label="Hora de fin" required>
              <CocoaInput value={form.endTime} onChange={(value) => update("endTime", value)} type="time" min={form.startTime} required />
            </CocoaField>
          </CocoaFormRow>
          {scheduleSummary ? <p style={NOTE_STYLE}>{scheduleSummary}</p> : null}
        </CocoaFormSection>

        <CocoaFormSection title="Sala y montaje">
          <CocoaField
            label="Sala"
            help={
              eventSpacesState.loading
                ? "Cargando salas disponibles…"
                : eventSpaces.length === 0
                  ? "No hay salas registradas para esta propiedad."
                  : "Selecciona el espacio asignado al evento."
            }
          >
            <CocoaSelect value={form.eventSpaceId} onChange={(value) => update("eventSpaceId", value)} options={spaceOptions} disabled={eventSpacesState.loading} />
          </CocoaField>
          <CocoaFormRow columns={2}>
            <CocoaField label="Estilo de montaje" required help="Disposición del mobiliario.">
              <CocoaSelect value={form.setupStyle} onChange={(value) => update("setupStyle", value as SetupStyle)} options={SETUP_STYLE_OPTIONS} />
            </CocoaField>
            <CocoaField label="Asistentes esperados" help="Personas aproximadas para dimensionar restauración y montaje.">
              <CocoaInput
                value={form.expectedAttendees === "" ? "" : String(form.expectedAttendees)}
                onChange={(value) => update("expectedAttendees", value === "" ? "" : Number(value))}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                placeholder="50"
              />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Notas">
          <CocoaField label="Observaciones internas" fullWidth>
            <CocoaInput
              value={form.notes}
              onChange={(value) => update("notes", value)}
              multiline
              rows={3}
              placeholder="Alergias, audiovisuales, decoración, accesos VIP, horarios…"
            />
          </CocoaField>
        </CocoaFormSection>

        {error ? (
          <CocoaCallout tone="danger" title={error} role="alert">
            {null}
          </CocoaCallout>
        ) : null}
      </form>
    </CocoaDrawer>
  );
}
