// Revenue · Calendario de demanda — /revenue/calendario-demanda (standalone).
//
// Cocoa 22 · ola 5 · lote 5-A. The inventory files it under «calendario»,
// but its body is a create form next to the list of events, so the page
// follows the Formulario + ListaTabla recipes (docs/design/COCOA-22.md §4):
// CocoaPage → CocoaKpiStrip (próximos · alto impacto · pasados) → CocoaGrid
// 4/8 → CocoaFormSection (string-controlled fields, validation in
// CocoaField.error, the primary in the section footer) · CocoaSection
// padding none + CocoaTable (empty state inside the section, «Ver pasados»
// as the section action). Below 600 px the table stacks its own cards.
//
// Wired to
//   GET  /revenue/properties/:propertyId/demand-calendar  → { items: DemandEvent[] }
//   POST /revenue/properties/:propertyId/demand-calendar  (permission revenue.recommend)
// Events feed forecast confidence and the pricing explanations. The module
// revenue_profit_engine must be enabled for the property (403 otherwise).

import { useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest, ApiError } from "../services/api-client";
import { getActivePropertyId, getActivePropertyName } from "../services/activeProperty";
import { useToast } from "../components/Toast";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { date, dateRange, number, plural } from "../lib/format";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { treeHeaderFor } from "./tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

type Impact = "low" | "medium" | "high";

type DemandEvent = {
  id: string;
  propertyId: string;
  name: string;
  eventType?: string;
  startDate: string;
  endDate: string;
  expectedImpact?: string;
  impactScore?: number;
  source?: string;
  createdAt: string;
};

const EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "city_event", label: "Evento de ciudad" },
  { value: "conference", label: "Congreso / feria" },
  { value: "holiday", label: "Festivo / puente" },
  { value: "sports", label: "Evento deportivo" },
  { value: "concert", label: "Concierto / espectáculo" },
  { value: "low_demand", label: "Periodo de baja demanda" },
  { value: "manual", label: "Otro (manual)" }
];

const IMPACTS: Array<{ value: Impact; label: string; score: number }> = [
  { value: "low", label: "Bajo", score: 0.3 },
  { value: "medium", label: "Medio", score: 0.6 },
  { value: "high", label: "Alto", score: 0.9 }
];

const IMPACT_TONE: Record<Impact, CocoaTone> = { low: "success", medium: "warning", high: "danger" };

function eventTypeLabel(value?: string): string {
  return EVENT_TYPES.find((option) => option.value === value)?.label ?? (value || "—");
}

function impactLabel(value?: string): string {
  return IMPACTS.find((option) => option.value === value)?.label ?? (value || "—");
}

function impactTone(value?: string): CocoaTone {
  return value === "low" || value === "medium" || value === "high" ? IMPACT_TONE[value] : "neutral";
}

function sourceLabel(value?: string): string {
  return value === "manual" ? "Manual" : value ?? "—";
}

/** «12–18 sept 2026» for a multi-day event, «12 sept 2026» for a single day. */
function eventDates(event: DemandEvent): string {
  if (event.endDate && event.endDate !== event.startDate) return dateRange(event.startDate, event.endDate, { style: "medium", empty: event.startDate });
  return date(event.startDate, "medium", { empty: event.startDate || "—" });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return err.message || "No tienes permiso para crear eventos de demanda (revenue.recommend).";
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

const COLUMNS: CocoaTableColumn<DemandEvent>[] = [
  { key: "name", label: "Evento", minWidth: 160, render: (event) => <strong>{event.name}</strong> },
  { key: "eventType", label: "Tipo", fit: true, render: (event) => eventTypeLabel(event.eventType) },
  { key: "dates", label: "Fechas", fit: true, render: (event) => eventDates(event) },
  {
    key: "impact",
    label: "Impacto",
    fit: true,
    render: (event) => <CocoaBadge tone={impactTone(event.expectedImpact)}>{impactLabel(event.expectedImpact)}</CocoaBadge>
  },
  { key: "source", label: "Origen", fit: true, hideOnNarrow: true, render: (event) => sourceLabel(event.source) }
];

export function DemandCalendarAdminScreen() {
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const propertyName = getActivePropertyName();
  const head = treeHeaderFor("DemandCalendarAdmin", { eyebrow: "Revenue", title: "Calendario de demanda" });
  const { showToast } = useToast();
  const state = useApiData<{ items: DemandEvent[] }>(`/revenue/properties/${propertyId}/demand-calendar`);

  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("city_event");
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [impact, setImpact] = useState<Impact>("medium");
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  const events = useMemo(() => {
    const rows = toArray<DemandEvent>(state.data);
    return [...rows].sort((a, b) => a.startDate.localeCompare(b.startDate));
  }, [state.data]);
  const cutoff = today();
  const upcoming = events.filter((event) => event.endDate >= cutoff);
  const past = events.filter((event) => event.endDate < cutoff);
  const visible = showPast ? events : upcoming;
  const highImpact = upcoming.filter((event) => event.expectedImpact === "high").length;
  const nextEvent = upcoming[0] ?? null;

  // Field errors show after the first attempt (a fresh form is not «wrong»).
  const errors = {
    name: !name.trim() ? "Indica un nombre para el evento." : undefined,
    dates: !startDate || !endDate ? "Indica las fechas de inicio y fin." : endDate < startDate ? "La fecha de fin no puede ser anterior a la de inicio." : undefined
  };
  const valid = !errors.name && !errors.dates;

  async function create() {
    if (saving) return;
    setAttempted(true);
    if (!valid) {
      setFormError(errors.name ?? errors.dates ?? null);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await apiRequest(`/revenue/properties/${propertyId}/demand-calendar`, {
        method: "POST",
        body: {
          name: name.trim(),
          eventType,
          startDate,
          endDate,
          expectedImpact: impact,
          impactScore: IMPACTS.find((option) => option.value === impact)?.score ?? 0.6
        }
      });
      showToast(`Evento «${name.trim()}» añadido al calendario de demanda.`, { variant: "success" });
      setName("");
      setEventType("city_event");
      setImpact("medium");
      setAttempted(false);
      state.refresh();
    } catch (err) {
      const message = errorMessage(err, "No se pudo crear el evento de demanda.");
      setFormError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const pageState = state.loading && !state.data ? "loading" : state.error && !state.data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${head.eyebrow} · ${propertyName}`}
      title={head.title}
      subtitle="Eventos, festivos y periodos de alta demanda que alimentan la previsión y explican los precios."
      state={pageState}
      skeleton={
        <>
          <CocoaSkeleton.Strip count={3} min={200} />
          <CocoaSkeleton.Grid rows={[[4, 8]]} height={320} />
        </>
      }
      error={{ title: "No se pudo cargar el calendario de demanda", message: state.error ?? undefined, onRetry: state.refresh }}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("RevenueForecastExplorer")}>
            Explorador de previsión
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("RevenueHomeDashboard")}>
            Panel de revenue
          </CocoaButton>
        </>
      }
      commands={[
        { id: "demand-calendar-add", label: "Añadir evento de demanda", run: () => void create(), shortcut: "⌘ Enter" },
        { id: "demand-calendar-refresh", label: `${ACTIONS.refresh}: calendario de demanda`, run: state.refresh },
        { id: "demand-calendar-forecast", label: "Abrir el explorador de previsión", run: () => navigateTo("RevenueForecastExplorer") }
      ]}
    >
      <CocoaKpiStrip min={200} aria-label="Resumen del calendario de demanda">
        <CocoaKpi
          label="Próximos eventos"
          value={number(upcoming.length)}
          caption={nextEvent ? `Siguiente: ${date(nextEvent.startDate, "dayMonth")} · ${nextEvent.name}` : "Ninguno programado"}
        />
        <CocoaKpi label="De alto impacto" value={number(highImpact)} caption="Entre los próximos" tone={highImpact > 0 ? "danger" : undefined} />
        <CocoaKpi label="Pasados" value={number(past.length)} caption="Ya fuera de la previsión" />
      </CocoaKpiStrip>

      <CocoaGrid align="start">
        <CocoaSpan cols={4} min={320}>
          <CocoaFormSection
            title="Nuevo evento de demanda"
            description="Congresos, festivos o periodos de compresión: mejoran la confianza de la previsión de esta propiedad."
            actions={
              <CocoaButton variant="filled" tone="accent" onClick={() => void create()} loading={saving} disabled={saving}>
                {saving ? STATUS_LABELS.saving : "Añadir evento"}
              </CocoaButton>
            }
          >
            <CocoaField label="Nombre" required error={attempted ? errors.name : undefined}>
              <CocoaInput
                value={name}
                onChange={setName}
                disabled={saving}
                placeholder="Ej.: Congreso médico en el Palexco"
                autoComplete="off"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void create();
                  }
                }}
              />
            </CocoaField>
            <CocoaFormRow columns={2}>
              <CocoaField label="Tipo">
                <CocoaSelect value={eventType} onChange={setEventType} options={EVENT_TYPES} disabled={saving} />
              </CocoaField>
              <CocoaField label="Impacto esperado">
                <CocoaSelect value={impact} onChange={(value) => setImpact(value as Impact)} options={IMPACTS} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaFormRow columns={2}>
              <CocoaField label="Inicio" required>
                <CocoaDatePicker value={startDate} onChange={setStartDate} disabled={saving} />
              </CocoaField>
              <CocoaField label="Fin" required error={attempted ? errors.dates : undefined}>
                <CocoaDatePicker value={endDate} min={startDate} onChange={setEndDate} disabled={saving} />
              </CocoaField>
            </CocoaFormRow>
            {formError ? (
              <CocoaCallout tone="danger" role="alert" title="No se pudo añadir el evento">
                {formError}
              </CocoaCallout>
            ) : null}
          </CocoaFormSection>
        </CocoaSpan>

        <CocoaSpan cols={8} min={480}>
          <CocoaSection
            title={showPast ? "Todos los eventos" : "Próximos eventos"}
            meta={plural(visible.length, "evento", "eventos")}
            action={
              past.length > 0 ? (
                <CocoaButton variant="plain" size="small" tone="accent" onClick={() => setShowPast((value) => !value)} aria-pressed={showPast}>
                  {showPast ? "Ocultar pasados" : `Ver pasados (${number(past.length)})`}
                </CocoaButton>
              ) : undefined
            }
            padding={visible.length > 0 ? "none" : "md"}
            footer={visible.length > 0 ? `${plural(visible.length, "evento", "eventos")} de ${plural(events.length, "evento registrado", "eventos registrados")}` : undefined}
            style={{ overflow: "clip" }}
            aria-label="Eventos de demanda"
          >
            {visible.length === 0 ? (
              <CocoaState
                kind="empty"
                title="Sin eventos de demanda"
                message="Añade congresos, festivos o periodos de compresión para mejorar la confianza de la previsión de esta propiedad."
                secondaryAction={past.length > 0 ? { label: `Ver pasados (${number(past.length)})`, onClick: () => setShowPast(true) } : undefined}
              />
            ) : (
              <CocoaTable columns={COLUMNS} rows={visible} rowKey="id" caption="Eventos de demanda" aria-label="Eventos de demanda" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

export default DemandCalendarAdminScreen;
