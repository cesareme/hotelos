import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { dateTime, number, percent, plural } from "../../lib/format";
import { ErrorState } from "../../components/States";
import { ACTIONS, errorStateFor } from "../../content/actions";
import { pageHead, treeHeaderFor } from "../tabs/tab-helpers";

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

const CLOSED_STATUSES = new Set([
  "completed",
  "done",
  "cancelled",
  "canceled",
  "archived"
]);
const IN_PROGRESS_STATUSES = new Set([
  "in_progress",
  "in-progress",
  "active",
  "ongoing",
  "running"
]);

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

function statusPill(status: string) {
  const s = status.toLowerCase().replace(/[\s-]+/g, "_");
  const label = ACTION_STATUS_LABELS[s] ?? status.replace(/_/g, " ");
  if (CLOSED_STATUSES.has(s)) {
    return <span className="cm-pill cm-pill-ok">{label}</span>;
  }
  if (IN_PROGRESS_STATUSES.has(s)) {
    return <span className="cm-pill cm-pill-warn">{label}</span>;
  }
  return <span className="cm-pill cm-pill-warn">{label}</span>;
}

function trendPill(trendPct: number) {
  if (trendPct === 0) {
    return <span className="cm-pill cm-pill-ok">estable</span>;
  }
  // For ESG metrics, lower is generally better (less CO2/water/waste). We
  // surface the sign honestly and let the operator interpret.
  if (trendPct < 0) {
    return <span className="cm-pill cm-pill-ok">{percent(trendPct, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>;
  }
  return <span className="cm-pill cm-pill-warn">{percent(trendPct, { signDisplay: "always", minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>;
}

function formatDate(iso?: string): string {
  return dateTime(iso);
}

function formatNumber(n: number): string {
  return number(n);
}

export function SustainabilityDashboard({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: pageHead paints only subtitle and actions.
  const Head = pageHead(embedded);
  const state = useApiData<SustainabilityDashboardData>(
    `/dashboards/sustainability?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 300000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, metricsByCategory, activeActions, recentMetrics } = data;

  const co2PerRnStatus =
    kpis.co2KgPerRoomNight === 0
      ? "rev-kpi-ok"
      : kpis.co2KgPerRoomNight > 30
        ? "rev-kpi-error"
        : kpis.co2KgPerRoomNight > 15
          ? "rev-kpi-warn"
          : "rev-kpi-ok";
  const co2TotalStatus = kpis.co2Total30dKg > 0 ? "rev-kpi-warn" : "rev-kpi-ok";
  const waterStatus =
    kpis.waterLitersPerRoomNight === 0
      ? "rev-kpi-ok"
      : kpis.waterLitersPerRoomNight > 400
        ? "rev-kpi-error"
        : kpis.waterLitersPerRoomNight > 200
          ? "rev-kpi-warn"
          : "rev-kpi-ok";
  const wasteStatus =
    kpis.wastePerRoomNightKg === 0
      ? "rev-kpi-ok"
      : kpis.wastePerRoomNightKg > 2
        ? "rev-kpi-error"
        : kpis.wastePerRoomNightKg > 1
          ? "rev-kpi-warn"
          : "rev-kpi-ok";
  const actionsStatus = kpis.activeActions > 0 ? "rev-kpi-warn" : "rev-kpi-ok";

  return (
    <>
      <Head
        eyebrow={HEADER.eyebrow}
        title={HEADER.title}
        subtitle="Panel de sostenibilidad en solo lectura: emisiones de CO2, consumo de agua y residuos por habitación-noche, y acciones de sostenibilidad activas. Se actualiza cada 5 minutos."
        actions={
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ {ACTIONS.refresh}
          </button>
        }
      />

      {state.error ? <ErrorState title={LOAD_ERROR.title} message={LOAD_ERROR.message} onRetry={() => state.refresh()} /> : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${co2PerRnStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">CO2 por noche ocupada</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.co2KgPerRoomNight)} kg</div>
          <div className="rev-kpi-delta">intensidad de carbono por noche ocupada</div>
        </article>
        <article className={`rev-kpi ${co2TotalStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">CO2 total (30 días)</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.co2Total30dKg)} kg</div>
          <div className="rev-kpi-delta">suma de las métricas de CO2 en la ventana</div>
        </article>
        <article className={`rev-kpi ${waterStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Agua / noche ocupada</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.waterLitersPerRoomNight)} L</div>
          <div className="rev-kpi-delta">litros por noche ocupada</div>
        </article>
        <article className={`rev-kpi ${wasteStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Residuos / noche ocupada</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.wastePerRoomNightKg)} kg</div>
          <div className="rev-kpi-delta">kilos por noche ocupada</div>
        </article>
        <article className={`rev-kpi ${actionsStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Acciones activas</span>
          </div>
          <div className="rev-kpi-value">{kpis.activeActions}</div>
          <div className="rev-kpi-delta">ni cerradas ni canceladas</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Métricas por categoría</h3>
            <span className="bo-chip">{plural(metricsByCategory.length, "categoría", "categorías", { withCount: true })}</span>
          </div>
          {metricsByCategory.length === 0 ? (
            <p className="bo-muted">Sin métricas registradas en el periodo seleccionado.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th style={{ textAlign: "right" }}>Último valor</th>
                  <th>Unidad</th>
                  <th style={{ textAlign: "right" }}>Tendencia</th>
                </tr>
              </thead>
              <tbody>
                {metricsByCategory.map((row) => (
                  <tr key={row.category}>
                    <td><strong>{row.category}</strong></td>
                    <td style={{ textAlign: "right" }}>{formatNumber(row.latestValue)}</td>
                    <td>{row.unit || "—"}</td>
                    <td style={{ textAlign: "right" }}>{trendPill(row.trendPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Acciones activas</h3>
            <span className="bo-chip">{activeActions.length}</span>
          </div>
          {activeActions.length === 0 ? (
            <p className="bo-muted">Sin acciones de sostenibilidad activas.</p>
          ) : (
            <ul className="bo-list">
              {activeActions.map((action) => (
                <li
                  key={action.id}
                  style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {statusPill(action.status)}
                    <strong>{action.name}</strong>
                  </div>
                  {typeof action.progressPct === "number" ? (
                    <div
                      aria-label={`Progreso ${action.progressPct}%`}
                      style={{
                        width: "100%",
                        height: 8,
                        background: "var(--surface-2, #eee)",
                        borderRadius: 4,
                        overflow: "hidden"
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.max(0, Math.min(100, action.progressPct))}%`,
                          height: "100%",
                          background: "var(--accent-ink, #2a7)"
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      aria-label="Progreso no disponible"
                      style={{
                        width: "100%",
                        height: 8,
                        background: "var(--surface-2, #eee)",
                        borderRadius: 4,
                        opacity: 0.4
                      }}
                    />
                  )}
                  <small className="bo-muted">
                    {typeof action.progressPct === "number"
                      ? `${action.progressPct}% completado`
                      : "sin seguimiento del progreso"}
                    {action.targetDate ? (
                      <> · objetivo {formatDate(action.targetDate)}</>
                    ) : null}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Métricas recientes</h3>
          <span className="bo-chip">{recentMetrics.length}</span>
        </div>
        {recentMetrics.length === 0 ? (
          <p className="bo-muted">Sin métricas recientes.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th style={{ textAlign: "right" }}>Valor</th>
                <th>Unidad</th>
                <th>Registrado</th>
              </tr>
            </thead>
            <tbody>
              {recentMetrics.map((metric) => (
                <tr key={metric.id}>
                  <td><strong>{metric.name}</strong></td>
                  <td style={{ textAlign: "right" }}>{formatNumber(metric.value)}</td>
                  <td>{metric.unit || "—"}</td>
                  <td>{formatDate(metric.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
