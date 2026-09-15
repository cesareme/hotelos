import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { dateTime, number, percent } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();

type AnalyticsCenterData = {
  kpis: {
    totalMetrics: number;
    snapshotsLast24h: number;
    anomalies30d: number;
    criticalAnomalies: number;
    scheduledReportsActive: number;
  };
  topMetrics: Array<{
    id: string;
    name: string;
    latestValue: number;
    unit?: string;
    recordedAt: string;
    trendPct?: number;
  }>;
  recentAnomalies: Array<{
    id: string;
    metricName?: string;
    severity?: string;
    description?: string;
    detectedAt: string;
    status?: string;
  }>;
  upcomingReports: Array<{
    id: string;
    name: string;
    cadence?: string;
    nextRunAt?: string;
    recipients?: number;
  }>;
};

function fmtNumber(value: number | null | undefined): string {
  return number(value, { empty: "0" });
}

function fmtTrend(trend: number | undefined): string {
  return percent(trend, { signDisplay: "exceptZero" });
}

function formatDateTime(value?: string): string {
  return dateTime(value);
}

function severityClass(severity?: string): "ok" | "warn" | "error" {
  if (!severity) return "warn";
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high" || s === "error") return "error";
  if (s === "medium" || s === "warning" || s === "warn") return "warn";
  return "ok";
}

function severityPill(severity?: string) {
  const status = severityClass(severity);
  const cls = status === "ok" ? "cm-pill-ok" : status === "warn" ? "cm-pill-warn" : "cm-pill-error";
  return <span className={`cm-pill ${cls}`}>{severity ?? "—"}</span>;
}

function statusPill(status?: string) {
  if (!status) return <span className="bo-muted">—</span>;
  const s = status.toLowerCase();
  if (s === "resolved" || s === "closed" || s === "dismissed") {
    return <span className="cm-pill cm-pill-ok">{status}</span>;
  }
  if (s === "open" || s === "active" || s === "investigating") {
    return <span className="cm-pill cm-pill-warn">{status}</span>;
  }
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

function trendClass(trend: number | undefined): "ok" | "warn" | "error" | undefined {
  if (trend === undefined || !Number.isFinite(trend)) return undefined;
  if (trend > 0) return "ok";
  if (trend < 0) return "error";
  return "warn";
}

export function AnalyticsCenterDashboard() {
  const { data, loading, error, refresh } = useApiData<AnalyticsCenterData>(
    "/dashboards/analytics-center",
    { pollIntervalMs: 300000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis = data?.kpis;
  const topMetrics = data?.topMetrics ?? [];
  const recentAnomalies = data?.recentAnomalies ?? [];
  const upcomingReports = data?.upcomingReports ?? [];

  const anomalyStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.criticalAnomalies > 0 ? "error"
      : kpis.anomalies30d > 0 ? "warn"
      : "ok";

  const metricsStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.totalMetrics === 0 ? "error"
      : kpis.totalMetrics < 3 ? "warn"
      : "ok";

  const snapshotsStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.snapshotsLast24h === 0 ? "warn"
      : "ok";

  return (
    <>
      <CocoaPageHeader
        eyebrow="Informes"
        title="Analítica"
        subtitle="Indicadores personalizados, anomalías detectadas e informes programados de los últimos 30 días. Solo lectura; se actualiza cada 5 minutos."
        actions={<button type="button" className="ghost" onClick={refresh}>↻ {ACTIONS.refresh}</button>}
      />

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          {UI_STATES.error.title}. {UI_STATES.error.message}
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${metricsStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Indicadores</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.totalMetrics ?? 0)}</div>
          <div className="rev-kpi-delta">Definiciones activas</div>
        </article>
        <article className={`rev-kpi rev-kpi-${snapshotsStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Registros · 24 h</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.snapshotsLast24h ?? 0)}</div>
          <div className="rev-kpi-delta">Generados en las últimas 24 h</div>
        </article>
        <article className={`rev-kpi rev-kpi-${anomalyStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Anomalías · 30 días</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.anomalies30d ?? 0)}</div>
          <div className="rev-kpi-delta">Eventos detectados</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis && kpis.criticalAnomalies > 0 ? "error" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Anomalías críticas</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.criticalAnomalies ?? 0)}</div>
          <div className="rev-kpi-delta">Severidad crítica / alta</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Informes programados</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.scheduledReportsActive ?? 0)}</div>
          <div className="rev-kpi-delta">Informes programados activos</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Indicadores</p>
              <h3>Indicadores principales</h3>
            </div>
            <span className="bo-chip">{topMetrics.length} métricas</span>
          </div>
          {topMetrics.length === 0 ? (
            <EmptyState
              title="No hay registros de indicadores"
              message="Aún no se han registrado métricas en la ventana actual. Aparecerán aquí en cuanto el pipeline genere el primer snapshot."
            />
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Indicador</th>
                    <th style={{ textAlign: "right" }}>Último valor</th>
                    <th style={{ textAlign: "right" }}>Tendencia</th>
                    <th>Registrado</th>
                  </tr>
                </thead>
                <tbody>
                  {topMetrics.map((row) => {
                    const tc = trendClass(row.trendPct);
                    const rowClass = tc === "error" ? "cm-row-error" : tc === "warn" ? "cm-row-warn" : undefined;
                    return (
                      <tr key={row.id} className={rowClass}>
                        <td><strong>{row.name}</strong></td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {fmtNumber(row.latestValue)}{row.unit ? ` ${row.unit}` : ""}
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {fmtTrend(row.trendPct)}
                        </td>
                        <td>{formatDateTime(row.recordedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Anomalías</p>
              <h3>Anomalías recientes</h3>
            </div>
            <span className="bo-chip">{recentAnomalies.length} eventos</span>
          </div>
          {recentAnomalies.length === 0 ? (
            <EmptyState
              title="No hay anomalías recientes"
              message="Las métricas están dentro de los umbrales esperados. Si se detectan desvíos aparecerán aquí con severidad y contexto."
            />
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Severidad</th>
                    <th>Indicador</th>
                    <th>Descripción</th>
                    <th>Estado</th>
                    <th>Detectada</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAnomalies.map((a) => (
                    <tr
                      key={a.id}
                      className={
                        severityClass(a.severity) === "error"
                          ? "cm-row-error"
                          : severityClass(a.severity) === "warn"
                            ? "cm-row-warn"
                            : undefined
                      }
                    >
                      <td>{severityPill(a.severity)}</td>
                      <td>{a.metricName ?? <span className="bo-muted">—</span>}</td>
                      <td>{a.description ?? <span className="bo-muted">—</span>}</td>
                      <td>{statusPill(a.status)}</td>
                      <td>{formatDateTime(a.detectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Informes</p>
            <h3>Próximos informes programados</h3>
          </div>
          <span className="bo-chip">{upcomingReports.length} reportes</span>
        </div>
        {upcomingReports.length === 0 ? (
          <EmptyState
            title="No hay informes programados activos"
            message="Programa reportes desde el módulo de Analytics para automatizar el envío recurrente a stakeholders."
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Informe</th>
                  <th>Cadencia</th>
                  <th>Próxima ejecución</th>
                  <th style={{ textAlign: "right" }}>Destinatarios</th>
                </tr>
              </thead>
              <tbody>
                {upcomingReports.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td>
                    <td>{r.cadence ?? <span className="bo-muted">—</span>}</td>
                    <td>{r.nextRunAt ? formatDateTime(r.nextRunAt) : <span className="bo-muted">sin programar</span>}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.recipients ?? <span className="bo-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
