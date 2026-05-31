import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type QualityDashboardData = {
  kpis: {
    openCases: number;
    slaBreachedPct: number;
    avgResolutionHours: number;
    closedLast30d: number;
    criticalOpen: number;
  };
  casesByType: Array<{ caseType: string; count: number }>;
  casesByStatus: Array<{ status: string; count: number }>;
  topFailureModes: Array<{ rootCause: string; count: number }>;
  recentCases: Array<{
    id: string;
    title: string;
    status: string;
    severity?: string;
    openedAt: string;
    closedAt?: string;
  }>;
};

const EMPTY: QualityDashboardData = {
  kpis: { openCases: 0, slaBreachedPct: 0, avgResolutionHours: 0, closedLast30d: 0, criticalOpen: 0 },
  casesByType: [],
  casesByStatus: [],
  topFailureModes: [],
  recentCases: []
};

const CRITICAL_PRIORITIES = new Set(["critical", "urgent", "high"]);
const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function statusPill(status: string) {
  if (CLOSED_STATUSES.has(status)) return <span className="cm-pill cm-pill-ok">{status}</span>;
  if (status === "in_progress" || status === "assigned" || status === "investigating")
    return <span className="cm-pill cm-pill-warn">{status}</span>;
  if (status === "waiting_vendor" || status === "on_hold")
    return <span className="cm-pill cm-pill-warn">{status}</span>;
  return <span className="cm-pill cm-pill-error">{status}</span>;
}

function severityChip(severity?: string) {
  const sev = severity ?? "normal";
  if (CRITICAL_PRIORITIES.has(sev)) return <span className="cm-pill cm-pill-error">{sev}</span>;
  if (sev === "normal") return <span className="cm-pill cm-pill-ok">{sev}</span>;
  return <span className="cm-pill cm-pill-warn">{sev}</span>;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function QualityDashboard() {
  const state = useApiData<QualityDashboardData>(
    `/dashboards/quality?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 60000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, casesByType, casesByStatus, topFailureModes, recentCases } = data;

  const openStatus = kpis.openCases > 0 ? "rev-kpi-warn" : "rev-kpi-ok";
  const criticalStatus = kpis.criticalOpen > 0 ? "rev-kpi-error" : "rev-kpi-ok";
  const slaStatus = kpis.slaBreachedPct >= 25 ? "rev-kpi-error" : kpis.slaBreachedPct > 0 ? "rev-kpi-warn" : "rev-kpi-ok";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Quality</div>
          <h1 className="bo-page-title">Quality cases</h1>
          <p className="bo-page-subtitle">
            Panel operativo de calidad: casos abiertos, críticos y resueltos recientemente,
            tiempo medio de resolución, distribución por tipo y estado, y modos de fallo más
            frecuentes. Vista solo lectura actualizada cada minuto.
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
          <p style={{ color: "var(--danger-ink)" }}>Couldn't load this view right now. Refresh to retry.</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${openStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open cases</span></div>
          <div className="rev-kpi-value">{kpis.openCases}</div>
          <div className="rev-kpi-delta">currently active</div>
        </article>
        <article className={`rev-kpi ${criticalStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Critical open</span></div>
          <div className="rev-kpi-value">{kpis.criticalOpen}</div>
          <div className="rev-kpi-delta">priority: critical / urgent / high</div>
        </article>
        <article className={`rev-kpi ${slaStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">SLA breached</span></div>
          <div className="rev-kpi-value">{kpis.slaBreachedPct}%</div>
          <div className="rev-kpi-delta">no SLA target configured</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Avg resolution</span></div>
          <div className="rev-kpi-value">{kpis.avgResolutionHours}h</div>
          <div className="rev-kpi-delta">hours per resolved case</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Closed last 30d</span></div>
          <div className="rev-kpi-value">{kpis.closedLast30d}</div>
          <div className="rev-kpi-delta">resolved in last 30 days</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Cases by type</h3>
            <span className="bo-chip">{casesByType.length} buckets</span>
          </div>
          {casesByType.length === 0 ? (
            <p className="bo-muted">No quality cases in the selected window.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Case type</th>
                  <th style={{ textAlign: "right" }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {casesByType.map((row) => (
                  <tr key={row.caseType}>
                    <td><strong>{row.caseType}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Cases by status</h3>
            <span className="bo-chip">{casesByStatus.length} buckets</span>
          </div>
          {casesByStatus.length === 0 ? (
            <p className="bo-muted">No quality cases in the selected window.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {casesByStatus.map((row) => (
                  <tr key={row.status}>
                    <td>{statusPill(row.status)}</td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Top failure modes</h3>
            <span className="bo-chip">{topFailureModes.length}</span>
          </div>
          {topFailureModes.length === 0 ? (
            <p className="bo-muted">No resolved cases in the selected window.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Root cause</th>
                  <th style={{ textAlign: "right" }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {topFailureModes.map((row) => (
                  <tr key={row.rootCause}>
                    <td><strong>{row.rootCause}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Recent cases</h3>
            <span className="bo-chip">{recentCases.length}</span>
          </div>
          {recentCases.length === 0 ? (
            <p className="bo-muted">No recent quality cases.</p>
          ) : (
            <ul className="bo-list">
              {recentCases.map((c) => (
                <li key={c.id} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {statusPill(c.status)}
                    {severityChip(c.severity)}
                    <strong>{c.title}</strong>
                  </div>
                  <small className="bo-muted">
                    Opened {formatDate(c.openedAt)}
                    {c.closedAt ? <> · Closed {formatDate(c.closedAt)}</> : null}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </>
  );
}
