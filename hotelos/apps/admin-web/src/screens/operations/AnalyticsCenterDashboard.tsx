// Analytics center — Informes › Analítica (/informes/analitica).
//
// Cocoa 22 (ola 9 · lote 9-A): standalone dashboard (DashboardStandalone):
// KPI strip → 6/6 row (top metrics table + recent anomalies table) →
// scheduled reports table. Read only; polls every five minutes.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { dateTime, number, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDelta,
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
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type MetricRow = { id: string; name: string; latestValue: number; unit?: string; recordedAt: string; trendPct?: number };
type AnomalyRow = { id: string; metricName?: string; severity?: string; description?: string; detectedAt: string; status?: string };
type ScheduledReportRow = { id: string; name: string; cadence?: string; nextRunAt?: string; recipients?: number };

type AnalyticsCenterData = {
  kpis: {
    totalMetrics: number;
    snapshotsLast24h: number;
    anomalies30d: number;
    criticalAnomalies: number;
    scheduledReportsActive: number;
  };
  topMetrics: MetricRow[];
  recentAnomalies: AnomalyRow[];
  upcomingReports: ScheduledReportRow[];
};

function fmtNumber(value: number | null | undefined): string {
  return number(value, { empty: "0" });
}

function severityTone(severity?: string): CocoaTone {
  if (!severity) return "warning";
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high" || s === "error") return "danger";
  if (s === "medium" || s === "warning" || s === "warn") return "warning";
  return "success";
}

function anomalyStatusTone(status: string): CocoaTone {
  const s = status.toLowerCase();
  if (s === "resolved" || s === "closed" || s === "dismissed") return "success";
  return "warning";
}

function kpiStatus(status: "ok" | "warn" | "error"): CocoaKpiStatus {
  return status === "ok" ? "ok" : status === "warn" ? "warning" : "critical";
}

const METRIC_COLUMNS: CocoaTableColumn<MetricRow>[] = [
  { key: "name", label: "Indicador", render: (row) => <strong>{row.name}</strong> },
  { key: "latestValue", label: "Último valor", align: "right", render: (row) => `${fmtNumber(row.latestValue)}${row.unit ? ` ${row.unit}` : ""}` },
  {
    key: "trendPct",
    label: "Tendencia",
    align: "right",
    render: (row) => (row.trendPct === undefined || !Number.isFinite(row.trendPct) ? "—" : <CocoaDelta delta={row.trendPct} unit="%" polarity="positive-good" />)
  },
  { key: "recordedAt", label: "Registrado", render: (row) => dateTime(row.recordedAt), hideOnNarrow: true }
];

const ANOMALY_COLUMNS: CocoaTableColumn<AnomalyRow>[] = [
  { key: "severity", label: "Severidad", render: (row) => <CocoaBadge tone={severityTone(row.severity)}>{row.severity ?? "—"}</CocoaBadge> },
  { key: "metricName", label: "Indicador", render: (row) => row.metricName ?? "—" },
  { key: "description", label: "Descripción", render: (row) => row.description ?? "—", hideOnNarrow: true },
  { key: "status", label: "Estado", render: (row) => (row.status ? <CocoaBadge tone={anomalyStatusTone(row.status)}>{row.status}</CocoaBadge> : "—") },
  { key: "detectedAt", label: "Detectada", render: (row) => dateTime(row.detectedAt) }
];

const REPORT_COLUMNS: CocoaTableColumn<ScheduledReportRow>[] = [
  { key: "name", label: "Informe", render: (row) => <strong>{row.name}</strong> },
  { key: "cadence", label: "Cadencia", render: (row) => row.cadence ?? "—" },
  {
    key: "nextRunAt",
    label: "Próxima ejecución",
    render: (row) =>
      row.nextRunAt ? (
        dateTime(row.nextRunAt)
      ) : (
        <CocoaBadge tone="neutral" size="small">
          sin programar
        </CocoaBadge>
      )
  },
  { key: "recipients", label: "Destinatarios", align: "right", render: (row) => (row.recipients === undefined ? "—" : number(row.recipients)), hideOnNarrow: true }
];

// Skeleton espejo: strip of 5 tiles, then 6/6 · 12.
function AnalyticsCenterSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={200} />
    </div>
  );
}

export function AnalyticsCenterDashboard() {
  const { data, loading, error, refresh } = useApiData<AnalyticsCenterData>("/dashboards/analytics-center", {
    pollIntervalMs: 300000,
    query: { propertyId: PROPERTY_ID }
  });

  const kpis = data?.kpis;
  const topMetrics = toArray<MetricRow>(data?.topMetrics);
  const recentAnomalies = toArray<AnomalyRow>(data?.recentAnomalies);
  const upcomingReports = toArray<ScheduledReportRow>(data?.upcomingReports);

  const anomalyStatus = !kpis ? "warn" : kpis.criticalAnomalies > 0 ? "error" : kpis.anomalies30d > 0 ? "warn" : "ok";
  const metricsStatus = !kpis ? "warn" : kpis.totalMetrics === 0 ? "error" : kpis.totalMetrics < 3 ? "warn" : "ok";
  const snapshotsStatus = !kpis ? "warn" : kpis.snapshotsLast24h === 0 ? "warn" : "ok";
  const header = treeHeaderFor("AnalyticsCenterDashboard", { eyebrow: "Informes", title: "Analítica" });

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle="Indicadores personalizados, anomalías detectadas e informes programados de los últimos 30 días. Solo lectura; se actualiza cada 5 minutos."
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : !kpis ? "empty" : "ready"}
      skeleton={<AnalyticsCenterSkeleton />}
      empty={{ title: "Sin datos de analítica", message: "Los indicadores aparecen aquí en cuanto el pipeline genere el primer registro." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "analitica-refresh", label: "Actualizar el centro de analítica", run: refresh }]}
    >
      {kpis ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de analítica">
            <CocoaKpi label="Indicadores" value={fmtNumber(kpis.totalMetrics)} deltaLabel="definiciones activas" polarity="neutral" status={kpiStatus(metricsStatus)} />
            <CocoaKpi label="Registros · 24 h" value={fmtNumber(kpis.snapshotsLast24h)} deltaLabel="generados en las últimas 24 h" polarity="neutral" status={kpiStatus(snapshotsStatus)} />
            <CocoaKpi label="Anomalías · 30 días" value={fmtNumber(kpis.anomalies30d)} deltaLabel="eventos detectados" polarity="negative-good" status={kpiStatus(anomalyStatus)} />
            <CocoaKpi label="Anomalías críticas" value={fmtNumber(kpis.criticalAnomalies)} deltaLabel="severidad crítica o alta" polarity="negative-good" status={kpis.criticalAnomalies > 0 ? "critical" : "ok"} />
            <CocoaKpi label="Informes programados" value={fmtNumber(kpis.scheduledReportsActive)} deltaLabel="informes programados activos" polarity="neutral" status="ok" />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Indicadores y anomalías" align="start">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Indicadores principales" meta={plural(topMetrics.length, "métrica", "métricas")} padding={topMetrics.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {topMetrics.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay registros de indicadores." message="Aún no se han registrado métricas en la ventana actual. Aparecerán aquí en cuanto el pipeline genere el primer registro." />
                ) : (
                  <CocoaTable columns={METRIC_COLUMNS} rows={topMetrics} rowKey="id" caption="Indicadores principales" aria-label="Indicadores principales" />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Anomalías recientes" meta={plural(recentAnomalies.length, "evento", "eventos")} padding={recentAnomalies.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {recentAnomalies.length === 0 ? (
                  <CocoaState kind="empty" inline title="No hay anomalías recientes." message="Las métricas están dentro de los umbrales esperados. Si se detectan desvíos aparecerán aquí con severidad y contexto." />
                ) : (
                  <CocoaTable columns={ANOMALY_COLUMNS} rows={recentAnomalies} rowKey="id" caption="Anomalías recientes" aria-label="Anomalías recientes" />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection title="Próximos informes programados" meta={plural(upcomingReports.length, "informe", "informes")} padding={upcomingReports.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {upcomingReports.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay informes programados activos." message="Programa informes desde el módulo de analítica para automatizar el envío recurrente a los interesados." />
            ) : (
              <CocoaTable columns={REPORT_COLUMNS} rows={upcomingReports} rowKey="id" caption="Próximos informes programados" aria-label="Próximos informes programados" />
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
