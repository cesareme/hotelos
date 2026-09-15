import { useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest, ApiError } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { date } from "../lib/format";

// =====================================================================================
// Revenue · Calendario de demanda (admin) — wired to
//   GET  /revenue/properties/:propertyId/demand-calendar  → { items: DemandEvent[] }
//   POST /revenue/properties/:propertyId/demand-calendar  (permission revenue.recommend)
// Events feed forecast confidence and the pricing explanations. The module
// revenue_profit_engine must be enabled for the property (403 otherwise).
// =====================================================================================

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

function eventTypeLabel(value?: string): string {
  return EVENT_TYPES.find((option) => option.value === value)?.label ?? (value || "—");
}

function impactPill(value?: string) {
  const impact = IMPACTS.find((option) => option.value === value);
  const cls = value === "high" ? "cm-pill-error" : value === "medium" ? "cm-pill-warn" : "cm-pill-ok";
  return <span className={`cm-pill ${cls}`}>{impact?.label ?? (value || "—")}</span>;
}

function fmtDate(value?: string): string {
  return date(value, "medium", { empty: value ?? "—" });
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

export function DemandCalendarAdminScreen() {
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const { showToast } = useToast();
  const state = useApiData<{ items: DemandEvent[] }>(`/revenue/properties/${propertyId}/demand-calendar`);

  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("city_event");
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [impact, setImpact] = useState<Impact>("medium");
  const [saving, setSaving] = useState(false);
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

  function validate(): string | null {
    if (!name.trim()) return "Indica un nombre para el evento.";
    if (!startDate || !endDate) return "Indica las fechas de inicio y fin.";
    if (endDate < startDate) return "La fecha de fin no puede ser anterior a la de inicio.";
    return null;
  }

  async function create() {
    if (saving) return;
    const problem = validate();
    if (problem) {
      setFormError(problem);
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
      state.refresh();
    } catch (err) {
      const message = errorMessage(err, "No se pudo crear el evento de demanda.");
      setFormError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (state.loading && !state.data) return <LoadingBlock label="Cargando calendario de demanda…" />;
  if (state.error && !state.data) {
    return (
      <ErrorState
        title="No se pudo cargar el calendario de demanda"
        message={state.error}
        onRetry={state.refresh}
      />
    );
  }

  return (
    <>
      <CocoaPageHeader
        eyebrow="Revenue"
        title="Calendario de demanda"
        subtitle="Eventos, festivos y periodos de alta demanda que alimentan la previsión y explican los precios."
        style={{ marginBottom: "var(--space-6)" }}
        actions={
          <>
            <button type="button" className="ghost" onClick={() => navigateTo("RevenueForecastExplorer")}>Explorador de previsión</button>
            <button type="button" className="ghost" onClick={() => navigateTo("RevenueHomeDashboard")}>Panel de revenue</button>
          </>
        }
      />

      <div className="bo-grid two">
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Nuevo evento de demanda</h3>
          </div>
          <label className="bo-form-field">
            <span>Nombre *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} placeholder="Ej.: Congreso médico en el Palexco" />
          </label>
          <label className="bo-form-field">
            <span>Tipo</span>
            <select value={eventType} onChange={(e) => setEventType(e.target.value)} disabled={saving}>
              {EVENT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="bo-grid two">
            <label className="bo-form-field">
              <span>Inicio *</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={saving} />
            </label>
            <label className="bo-form-field">
              <span>Fin *</span>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} disabled={saving} />
            </label>
          </div>
          <label className="bo-form-field">
            <span>Impacto esperado</span>
            <select value={impact} onChange={(e) => setImpact(e.target.value as Impact)} disabled={saving}>
              {IMPACTS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {formError ? (
            <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", color: "var(--danger-ink)" }}>{formError}</p>
          ) : null}
          <div className="bo-actions">
            <button type="button" className="primary" onClick={create} disabled={saving}>
              {saving ? "Guardando…" : "Añadir evento"}
            </button>
          </div>
        </section>

        <section className="bo-card">
          <div className="bo-card-head">
            <h3>{showPast ? "Todos los eventos" : "Próximos eventos"}</h3>
            <div className="bo-actions" style={{ margin: 0 }}>
              <span className="bo-status info">{visible.length}</span>
              {past.length > 0 ? (
                <button type="button" className="ghost" onClick={() => setShowPast((v) => !v)}>
                  {showPast ? "Ocultar pasados" : `Ver pasados (${past.length})`}
                </button>
              ) : null}
            </div>
          </div>
          {visible.length === 0 ? (
            <EmptyState
              title="Sin eventos de demanda"
              message="Añade congresos, festivos o periodos de compresión para mejorar la confianza del forecast de esta propiedad."
            />
          ) : (
            <div className="bo-table-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Evento</th>
                    <th>Tipo</th>
                    <th>Fechas</th>
                    <th>Impacto</th>
                    <th>Origen</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((event) => (
                    <tr key={event.id}>
                      <td><strong>{event.name}</strong></td>
                      <td>{eventTypeLabel(event.eventType)}</td>
                      <td>
                        {fmtDate(event.startDate)}
                        {event.endDate && event.endDate !== event.startDate ? ` → ${fmtDate(event.endDate)}` : ""}
                      </td>
                      <td>{impactPill(event.expectedImpact)}</td>
                      <td className="bo-muted">{event.source === "manual" ? "Manual" : event.source ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
