import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

type ChannelPerformanceData = {
  kpis: {
    activeChannels: number;
    openParityAlerts: number;
    avgCommissionPct: number;
    reservations30d: number;
    revenue30dEur: number;
  };
  channelMix: Array<{
    channelName: string;
    reservations: number;
    revenueEur: number;
    sharePct: number;
  }>;
  topProfitableChannels: Array<{
    channelName: string;
    netRevenueEur: number;
    commissionEur: number;
    marginPct: number;
  }>;
  recentParityAlerts: Array<{
    id: string;
    channelName?: string;
    severity?: string;
    detectedAt: string;
    resolvedAt?: string;
    description?: string;
  }>;
  syncJobsStatus: Array<{ status: string; count: number }>;
};

const currencyFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true,
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2
});

function money(value: number | null | undefined): string {
  return currencyFormatter.format(Number.isFinite(value as number) ? (value as number) : 0);
}

function pct(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "0%";
  return `${value}%`;
}

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
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

function syncStatusPill(status: string) {
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "success" || s === "completed" || s === "done") {
    return <span className="cm-pill cm-pill-ok">{status}</span>;
  }
  if (s === "failed" || s === "error" || s === "cancelled") {
    return <span className="cm-pill cm-pill-error">{status}</span>;
  }
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

export function ChannelPerformanceDashboard() {
  const { data, loading, error, refresh } = useApiData<ChannelPerformanceData>(
    "/dashboards/channel-performance",
    { pollIntervalMs: 120000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis = data?.kpis;
  const channelMix = data?.channelMix ?? [];
  const topProfitableChannels = data?.topProfitableChannels ?? [];
  const recentParityAlerts = data?.recentParityAlerts ?? [];
  const syncJobsStatus = data?.syncJobsStatus ?? [];

  const parityStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.openParityAlerts === 0 ? "ok"
      : kpis.openParityAlerts <= 2 ? "warn"
      : "error";

  const activeStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.activeChannels === 0 ? "error"
      : kpis.activeChannels < 2 ? "warn"
      : "ok";

  const commissionStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.avgCommissionPct >= 20 ? "error"
      : kpis.avgCommissionPct >= 12 ? "warn"
      : "ok";

  const maxShare = channelMix.reduce((max, m) => (m.sharePct > max ? m.sharePct : max), 0);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Channels</div>
          <h1 className="bo-page-title">Channel performance</h1>
          <p className="bo-page-subtitle">
            Channel mix, profitability, parity alerts and sync job status para los últimos 30 días.
            Solo lectura; refresca automáticamente cada 120 segundos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={refresh}>↻ Refresh</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          Couldn't load this view right now. Refresh to retry.
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${activeStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Active channels</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.activeChannels ?? 0)}</div>
          <div className="rev-kpi-delta">Canales con status “active”</div>
        </article>
        <article className={`rev-kpi rev-kpi-${parityStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open parity alerts</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.openParityAlerts ?? 0)}</div>
          <div className="rev-kpi-delta">Estado “open” en rate parity</div>
        </article>
        <article className={`rev-kpi rev-kpi-${commissionStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Avg commission</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : pct(kpis?.avgCommissionPct)}</div>
          <div className="rev-kpi-delta">Promedio entre canales con comisión definida</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Reservations 30d</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.reservations30d ?? 0)}</div>
          <div className="rev-kpi-delta">Reservas externas importadas</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Revenue 30d</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.revenue30dEur)}</div>
          <div className="rev-kpi-delta">Gross revenue snapshots</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Mix</p>
              <h3>Channel mix</h3>
            </div>
            <span className="bo-chip">{channelMix.length} canales</span>
          </div>
          {channelMix.length === 0 ? (
            <EmptyState
              title="No hay actividad de canales"
              message="Cuando entren reservas a través de los canales conectados aparecerá aquí el reparto por canal."
            />
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th style={{ textAlign: "right" }}>Reservas</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {channelMix.map((row, idx) => {
                    const barWidth = maxShare > 0 ? Math.max(2, (row.sharePct / maxShare) * 100) : 0;
                    return (
                      <tr key={`${row.channelName}-${idx}`}>
                        <td><strong>{row.channelName}</strong></td>
                        <td style={{ textAlign: "right" }}>{row.reservations}</td>
                        <td style={{ textAlign: "right" }}>{money(row.revenueEur)}</td>
                        <td>
                          <div
                            aria-label={`Share ${row.sharePct}%`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              minWidth: 140
                            }}
                          >
                            <div
                              style={{
                                background: "var(--bg-muted, #eef0f4)",
                                borderRadius: 4,
                                height: 8,
                                flex: 1,
                                overflow: "hidden"
                              }}
                            >
                              <div
                                style={{
                                  background: "var(--accent-ink, #2f6feb)",
                                  height: "100%",
                                  width: `${barWidth}%`
                                }}
                              />
                            </div>
                            <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right" }}>
                              {pct(row.sharePct)}
                            </span>
                          </div>
                        </td>
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
              <p className="bo-muted">Profitability</p>
              <h3>Top profitable channels</h3>
            </div>
            <span className="bo-chip">{topProfitableChannels.length} top</span>
          </div>
          {topProfitableChannels.length === 0 ? (
            <EmptyState
              title="No hay snapshots de rentabilidad"
              message="La rentabilidad neta por canal aparecerá aquí cuando el pipeline registre el primer snapshot del periodo."
            />
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th style={{ textAlign: "right" }}>Net revenue</th>
                    <th style={{ textAlign: "right" }}>Comisión</th>
                    <th style={{ textAlign: "right" }}>Margen</th>
                  </tr>
                </thead>
                <tbody>
                  {topProfitableChannels.map((row, idx) => (
                    <tr key={`${row.channelName}-${idx}`}>
                      <td><strong>{row.channelName}</strong></td>
                      <td style={{ textAlign: "right" }}>{money(row.netRevenueEur)}</td>
                      <td style={{ textAlign: "right" }}>{money(row.commissionEur)}</td>
                      <td style={{ textAlign: "right" }}>{pct(row.marginPct)}</td>
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
            <p className="bo-muted">Parity</p>
            <h3>Recent parity alerts</h3>
          </div>
          <span className="bo-chip">{recentParityAlerts.length} alertas</span>
        </div>
        {recentParityAlerts.length === 0 ? (
          <p className="bo-muted">No hay alertas de parity recientes.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Severidad</th>
                  <th>Canal</th>
                  <th>Descripción</th>
                  <th>Detectada</th>
                  <th>Resuelta</th>
                </tr>
              </thead>
              <tbody>
                {recentParityAlerts.map((alert) => (
                  <tr
                    key={alert.id}
                    className={
                      severityClass(alert.severity) === "error"
                        ? "cm-row-error"
                        : severityClass(alert.severity) === "warn"
                          ? "cm-row-warn"
                          : undefined
                    }
                  >
                    <td>{severityPill(alert.severity)}</td>
                    <td>{alert.channelName ?? "—"}</td>
                    <td>{alert.description ?? "—"}</td>
                    <td>{formatDateTime(alert.detectedAt)}</td>
                    <td>{alert.resolvedAt ? formatDateTime(alert.resolvedAt) : <span className="bo-muted">abierta</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Sync</p>
            <h3>Sync jobs status</h3>
          </div>
          <span className="bo-chip">{syncJobsStatus.reduce((s, j) => s + j.count, 0)} jobs</span>
        </div>
        {syncJobsStatus.length === 0 ? (
          <p className="bo-muted">No hay sync jobs en la ventana.</p>
        ) : (
          <ul className="bo-list">
            {syncJobsStatus.map((row) => (
              <li key={row.status}>
                {syncStatusPill(row.status)} <strong>{row.count}</strong> jobs
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
