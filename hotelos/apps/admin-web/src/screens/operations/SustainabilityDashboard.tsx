// Sostenibilidad — /cumplimiento/sostenibilidad (Cocoa 22 · ola 8 · lote 8-C,
// plantilla DashboardAlojado; hosted in SostenibilidadTabs on the host context).
//
// Read-only panel of GET /dashboards/sustainability?propertyId= (5-minute
// polling): CO2, water and waste per occupied room night as a KPI strip with
// status thresholds, the metrics by category and the recent metrics as
// CocoaTables, the active sustainability actions with a CocoaChart.Progress.
//
// Frame: CocoaPage on the host context (hosted, the container paints eyebrow
// and H1; `treeHeaderFor` keeps the standalone header on the menu labels);
// page states (skeleton on the first load, error state when nothing loaded; a
// later error keeps the last data with a callout) and the ⌘K command are the
// page's.

import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { dateTime, number, percent, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaKpiStatus,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Cumplimiento › Sostenibilidad), never retyped here.
const HEADER = treeHeaderFor("SustainabilityDashboard", { eyebrow: "Cumplimiento", title: "Sostenibilidad" });
const LOAD_ERROR = errorStateFor("los datos de sostenibilidad");

type SustainabilityDashboardData = {
  kpis: {
    co2KgPerRoomNight: number;
    co2Total30dKg: number;
    waterLitersPerRoomNight: number;
    wastePerRoomNightKg: number;
    activeActions: number;
  };
  metricsByCategory: Array<{
    category: string;
    latestValue: number;
    unit: string;
    trendPct: number;
  }>;
  activeActions: Array<{
    id: string;
    name: string;
    status: string;
    progressPct?: number;
    targetDate?: string;
  }>;
  recentMetrics: Array<{
    id: string;
    name: string;
    value: number;
    unit: string;
    recordedAt: string;
  }>;
};

type CategoryRow = SustainabilityDashboardData["metricsByCategory"][number];
type SustainabilityAction = SustainabilityDashboardData["activeActions"][number];
type RecentMetric = SustainabilityDashboardData["recentMetrics"][number];

const EMPTY: SustainabilityDashboardData = {
  kpis: {
    co2KgPerRoomNight: 0,
    co2Total30dKg: 0,
    waterLitersPerRoomNight: 0,
    wastePerRoomNightKg: 0,
    activeActions: 0
  },
  metricsByCategory: [],
  activeActions: [],
  recentMetrics: []
};

const CLOSED_STATUSES = new Set(["completed", "done", "cancelled", "canceled", "archived"]);
const IN_PROGRESS_STATUSES = new Set(["in_progress", "in-progress", "active", "ongoing", "running"]);

const ACTION_STATUS_LABELS: Record<string, string> = {
  completed: "completada",
  done: "completada",
  cancelled: "cancelada",
  canceled: "cancelada",
  archived: "archivada",
  in_progress: "en curso",
  active: "en curso",
  ongoing: "en curso",
  running: "en curso",
  planned: "planificada",
  draft: "borrador",
  paused: "en pausa"
};

function statusBadge(status: string) {
  const s = status.toLowerCase().replace(/[\s-]+/g, "_");
  const label = ACTION_STATUS_LABELS[s] ?? status.replace(/_/g, " ");
  const tone = CLOSED_STATUSES.has(s) ? "success" : IN_PROGRESS_STATUSES.has(s) ? "info" : "neutral";
  return (
    <CocoaBadge tone={tone} variant="dot" size="small">
      {label}
    </CocoaBadge>
  );
}

// For ESG metrics lower is generally better (less CO2 / water / waste): the sign
// is shown honestly and the operator interprets it.
function trendBadge(trendPct: number) {
  if (trendPct === 0) {
    return (
      <CocoaBadge tone="neutral" variant="dot">
        estable
      </CocoaBadge>
    );
  }
  if (trendPct < 0) {
    return (
      <CocoaBadge tone="success" variant="dot">
        {percent(trendPct, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
      </CocoaBadge>
    );
  }
  return (
    <CocoaBadge tone="warning" variant="dot">
      {percent(trendPct, { signDisplay: "always", minimumFractionDigits: 1, maximumFractionDigits: 1 })}
    </CocoaBadge>
  );
}

/** KPI status by threshold (pure): zero means «no data yet», never an alarm. */
export function intensityStatus(value: number, warnAbove: number, criticalAbove: number): CocoaKpiStatus {
  if (value === 0) return "ok";
  if (value > criticalAbove) return "critical";
  if (value > warnAbove) return "warning";
  return "ok";
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// Columns outside the component (A5): numbers fit their content on the right.
const CATEGORY_COLUMNS: CocoaTableColumn<CategoryRow>[] = [
  { key: "category", label: "Categoría", render: (row) => <strong>{row.category}</strong> },
  { key: "latestValue", label: "Último valor", align: "right", fit: true, render: (row) => number(row.latestValue) },
  { key: "unit", label: "Unidad", fit: true, hideOnNarrow: true, render: (row) => row.unit || "—" },
  { key: "trendPct", label: "Tendencia", align: "right", fit: true, render: (row) => trendBadge(row.trendPct) }
];

const RECENT_COLUMNS: CocoaTableColumn<RecentMetric>[] = [
  { key: "name", label: FIELD_LABELS.name, render: (metric) => <strong>{metric.name}</strong> },
  { key: "value", label: "Valor", align: "right", fit: true, render: (metric) => number(metric.value) },
  { key: "unit", label: "Unidad", fit: true, hideOnNarrow: true, render: (metric) => metric.unit || "—" },
  { key: "recordedAt", label: "Registrado", fit: true, render: (metric) => dateTime(metric.recordedAt) }
];

// Mirror skeleton: the five-tile strip, the 6/6 grid and the recent-metrics card.
function SustainabilitySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} />
    </div>
  );
}

function ActionItem({ action }: { action: SustainabilityAction }) {
  const tracked = typeof action.progressPct === "number";
  const progressLabel = tracked ? `${percent(action.progressPct, { maximumFractionDigits: 0 })} completado` : "sin seguimiento del progreso";
  return (
    <li>
      <div className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
        <div className="cocoa-row" data-gap="2">
          {statusBadge(action.status)}
          <strong>{action.name}</strong>
        </div>
        {tracked ? <CocoaChart.Progress value={clampProgress(action.progressPct ?? 0)} showValue={false} aria-label={`Progreso de ${action.name}: ${progressLabel}`} /> : null}
        <span className="cocoa-caption">
          {progressLabel}
          {action.targetDate ? ` · objetivo ${dateTime(action.targetDate)}` : ""}
        </span>
      </div>
    </li>
  );
}

export function SustainabilityDashboard() {
  const state = useApiData<SustainabilityDashboardData>(`/dashboards/sustainability?propertyId=${PROPERTY_ID}`, { pollIntervalMs: 300000 });
  const refresh = state.refresh;

  const data = state.data ?? EMPTY;
  const { kpis, metricsByCategory, activeActions, recentMetrics } = data;
  const firstLoad = state.loading && !state.data;

  // Page states (D27) are CocoaPage's: skeleton on the first load, error state when nothing loaded, else the content (a later error keeps the last data with a callout).
  const pageState: "loading" | "error" | "ready" = firstLoad ? "loading" : state.error && !state.data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Panel de sostenibilidad en solo lectura: emisiones de CO2, consumo de agua y residuos por habitación-noche, y acciones de sostenibilidad activas. Se actualiza cada 5 minutos."
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={state.loading}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={pageState}
      skeleton={<SustainabilitySkeleton />}
      error={{ title: LOAD_ERROR.title, message: LOAD_ERROR.message, onRetry: refresh }}
      commands={[{ id: "sostenibilidad-refresh", label: "Actualizar el panel de sostenibilidad", run: refresh }]}
    >
      {state.error && state.data ? (
        <CocoaCallout
          tone="danger"
          role="alert"
          title={LOAD_ERROR.title}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => state.refresh()}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {LOAD_ERROR.message} Se muestran los últimos datos cargados.
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de sostenibilidad">
        <CocoaKpi
          label="CO2 por noche ocupada"
          value={number(kpis.co2KgPerRoomNight)}
          unit="kg"
          caption="intensidad de carbono por noche ocupada"
          polarity="neutral"
          status={intensityStatus(kpis.co2KgPerRoomNight, 15, 30)}
        />
        <CocoaKpi
          label="CO2 total (30 días)"
          value={number(kpis.co2Total30dKg)}
          unit="kg"
          caption="suma de las métricas de CO2 en la ventana"
          polarity="neutral"
          status={kpis.co2Total30dKg > 0 ? "warning" : "ok"}
        />
        <CocoaKpi
          label="Agua por noche ocupada"
          value={number(kpis.waterLitersPerRoomNight)}
          unit="L"
          caption="litros por noche ocupada"
          polarity="neutral"
          status={intensityStatus(kpis.waterLitersPerRoomNight, 200, 400)}
        />
        <CocoaKpi
          label="Residuos por noche ocupada"
          value={number(kpis.wastePerRoomNightKg)}
          unit="kg"
          caption="kilos por noche ocupada"
          polarity="neutral"
          status={intensityStatus(kpis.wastePerRoomNightKg, 1, 2)}
        />
        <CocoaKpi label="Acciones activas" value={kpis.activeActions} caption="ni cerradas ni canceladas" polarity="neutral" status={kpis.activeActions > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Métricas por categoría y acciones activas">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Métricas por categoría"
            meta={plural(metricsByCategory.length, "categoría", "categorías", { withCount: true })}
            padding={metricsByCategory.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {metricsByCategory.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin métricas registradas en el periodo seleccionado." />
            ) : (
              <CocoaTable columns={CATEGORY_COLUMNS} rows={metricsByCategory} rowKey="category" caption="Métricas por categoría" aria-label="Métricas por categoría" />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Acciones activas" meta={plural(activeActions.length, "acción", "acciones", { withCount: true })}>
            {activeActions.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin acciones de sostenibilidad activas." />
            ) : (
              <ol className="c22-section__list" aria-label="Acciones de sostenibilidad activas">
                {activeActions.map((action) => (
                  <ActionItem key={action.id} action={action} />
                ))}
              </ol>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection
        title="Métricas recientes"
        meta={plural(recentMetrics.length, "métrica", "métricas", { withCount: true })}
        padding={recentMetrics.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {recentMetrics.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin métricas recientes." />
        ) : (
          <CocoaTable columns={RECENT_COLUMNS} rows={recentMetrics} rowKey="id" caption="Métricas recientes" aria-label="Métricas recientes" />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
