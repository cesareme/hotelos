import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

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

function statusPill(status: string) {
  const s = status.toLowerCase();
  if (CLOSED_STATUSES.has(s)) {
    return <span className="cm-pill cm-pill-ok">{status}</span>;
  }
  if (IN_PROGRESS_STATUSES.has(s)) {
    return <span className="cm-pill cm-pill-warn">{status}</span>;
  }
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

function trendPill(trendPct: number) {
  if (trendPct === 0) {
    return <span className="cm-pill cm-pill-ok">flat</span>;
  }
  // For ESG metrics, lower is generally better (less CO2/water/waste). We
  // surface the sign honestly and let the operator interpret.
  if (trendPct < 0) {
    return <span className="cm-pill cm-pill-ok">{trendPct.toFixed(1)}%</span>;
  }
  return <span className="cm-pill cm-pill-warn">+{trendPct.toFixed(1)}%</span>;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function SustainabilityDashboard() {
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
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Sustainability</div>
          <h1 className="bo-page-title">Sostenibilidad</h1>
          <p className="bo-page-subtitle">
            Panel ESG de solo lectura: emisiones de CO2, consumo de agua,
            generación de residuos por habitación-noche y acciones de
            sostenibilidad activas. Datos refrescados cada 5 minutos para
            responsables de sostenibilidad y operaciones.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {state.error ? (
        <section className="bo-card">
          <p style={{ color: "var(--danger-ink)" }}>
            Couldn't load this view right now. Refresh to retry.
          </p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${co2PerRnStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">CO2 / room night</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.co2KgPerRoomNight)} kg</div>
          <div className="rev-kpi-delta">carbon intensity per occupied night</div>
        </article>
        <article className={`rev-kpi ${co2TotalStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">CO2 total (30d)</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.co2Total30dKg)} kg</div>
          <div className="rev-kpi-delta">sum of CO2 metrics in window</div>
        </article>
        <article className={`rev-kpi ${waterStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Water / room night</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.waterLitersPerRoomNight)} L</div>
          <div className="rev-kpi-delta">litres per occupied night</div>
        </article>
        <article className={`rev-kpi ${wasteStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Waste / room night</span>
          </div>
          <div className="rev-kpi-value">{formatNumber(kpis.wastePerRoomNightKg)} kg</div>
          <div className="rev-kpi-delta">kg per occupied night</div>
        </article>
        <article className={`rev-kpi ${actionsStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Active actions</span>
          </div>
          <div className="rev-kpi-value">{kpis.activeActions}</div>
          <div className="rev-kpi-delta">not closed / cancelled</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Metrics by category</h3>
            <span className="bo-chip">{metricsByCategory.length} categories</span>
          </div>
          {metricsByCategory.length === 0 ? (
            <p className="bo-muted">No metrics recorded in the selected window.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Latest</th>
                  <th>Unit</th>
                  <th style={{ textAlign: "right" }}>Trend</th>
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
            <h3>Active actions</h3>
            <span className="bo-chip">{activeActions.length}</span>
          </div>
          {activeActions.length === 0 ? (
            <p className="bo-muted">No active sustainability actions.</p>
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
                      aria-label={`Progress ${action.progressPct}%`}
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
                      aria-label="Progress unavailable"
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
                      ? `${action.progressPct}% complete`
                      : "progress not tracked"}
                    {action.targetDate ? (
                      <> · target {formatDate(action.targetDate)}</>
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
          <h3>Recent metrics</h3>
          <span className="bo-chip">{recentMetrics.length}</span>
        </div>
        {recentMetrics.length === 0 ? (
          <p className="bo-muted">No recent metrics recorded.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ textAlign: "right" }}>Value</th>
                <th>Unit</th>
                <th>Recorded</th>
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
