import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type EnergyDashboardData = {
  kpis: {
    totalKwh30d: number;
    kwhPerOccupiedRoom: number;
    tendencyPct90d: number;
    activeMeters: number;
    abnormalReadingsCount: number;
  };
  consumptionByMeter: Array<{
    meterName: string;
    meterType: string;
    kwh30d: number;
    trendPct: number;
  }>;
  dailyConsumption: Array<{ date: string; kwh: number }>;
  topConsumers: Array<{ meterName: string; locationName?: string; kwh: number }>;
};

const EMPTY: EnergyDashboardData = {
  kpis: {
    totalKwh30d: 0,
    kwhPerOccupiedRoom: 0,
    tendencyPct90d: 0,
    activeMeters: 0,
    abnormalReadingsCount: 0
  },
  consumptionByMeter: [],
  dailyConsumption: [],
  topConsumers: []
};

function formatKwh(n: number): string {
  return `${n.toLocaleString()} kWh`;
}

function trendPill(pct: number) {
  if (pct === 0) return <span className="cm-pill cm-pill-ok">flat</span>;
  if (pct > 0) {
    const cls = pct >= 15 ? "cm-pill-error" : pct >= 5 ? "cm-pill-warn" : "cm-pill-ok";
    return <span className={`cm-pill ${cls}`}>+{pct}%</span>;
  }
  const cls = pct <= -15 ? "cm-pill-ok" : "cm-pill-ok";
  return <span className={`cm-pill ${cls}`}>{pct}%</span>;
}

function shortDay(iso: string): string {
  try {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  } catch {
    return iso;
  }
}

export function EnergyDashboard() {
  const state = useApiData<EnergyDashboardData>(
    `/dashboards/energy?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 300000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, consumptionByMeter, dailyConsumption, topConsumers } = data;

  const tendencyStatus =
    kpis.tendencyPct90d >= 15
      ? "rev-kpi-error"
      : kpis.tendencyPct90d >= 5
        ? "rev-kpi-warn"
        : "rev-kpi-ok";
  const abnormalStatus =
    kpis.abnormalReadingsCount === 0
      ? "rev-kpi-ok"
      : kpis.abnormalReadingsCount >= 5
        ? "rev-kpi-error"
        : "rev-kpi-warn";
  const activeMetersStatus = kpis.activeMeters > 0 ? "rev-kpi-ok" : "rev-kpi-warn";

  const maxDailyKwh = dailyConsumption.reduce((m, d) => (d.kwh > m ? d.kwh : m), 0);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Energy</div>
          <h1 className="bo-page-title">Consumo energético</h1>
          <p className="bo-page-subtitle">
            Panel operativo de consumo energético: kWh totales en ventana de 30
            días, kWh por habitación ocupada, tendencia respecto al periodo
            anterior, contadores activos, lecturas anómalas y consumo por
            contador y por día. Vista solo lectura actualizada cada 5 minutos.
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
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Total kWh (30d)</span>
          </div>
          <div className="rev-kpi-value">{kpis.totalKwh30d.toLocaleString()}</div>
          <div className="rev-kpi-delta">consumption in window</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">kWh per occupied room</span>
          </div>
          <div className="rev-kpi-value">{kpis.kwhPerOccupiedRoom.toLocaleString()}</div>
          <div className="rev-kpi-delta">total kWh / occupied room-nights</div>
        </article>
        <article className={`rev-kpi ${tendencyStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Tendency (90d)</span>
          </div>
          <div className="rev-kpi-value">
            {kpis.tendencyPct90d > 0 ? "+" : ""}
            {kpis.tendencyPct90d}%
          </div>
          <div className="rev-kpi-delta">last 30 vs prior 30</div>
        </article>
        <article className={`rev-kpi ${activeMetersStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Active meters</span>
          </div>
          <div className="rev-kpi-value">{kpis.activeMeters}</div>
          <div className="rev-kpi-delta">currently reporting</div>
        </article>
        <article className={`rev-kpi ${abnormalStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Abnormal readings</span>
          </div>
          <div className="rev-kpi-value">{kpis.abnormalReadingsCount}</div>
          <div className="rev-kpi-delta">rollbacks or outliers in window</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Consumption by meter</h3>
            <span className="bo-chip">{consumptionByMeter.length} meters</span>
          </div>
          {consumptionByMeter.length === 0 ? (
            <p className="bo-muted">No meters with readings in the selected window.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Meter</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>kWh (30d)</th>
                  <th style={{ textAlign: "right" }}>Trend</th>
                </tr>
              </thead>
              <tbody>
                {consumptionByMeter.map((row) => (
                  <tr key={row.meterName}>
                    <td><strong>{row.meterName}</strong></td>
                    <td>{row.meterType}</td>
                    <td style={{ textAlign: "right" }}>{row.kwh30d.toLocaleString()}</td>
                    <td style={{ textAlign: "right" }}>{trendPill(row.trendPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Top consumers</h3>
            <span className="bo-chip">top {topConsumers.length}</span>
          </div>
          {topConsumers.length === 0 ? (
            <p className="bo-muted">No consumers with positive consumption.</p>
          ) : (
            <ul className="bo-list">
              {topConsumers.map((row) => (
                <li
                  key={row.meterName}
                  style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>{row.meterName}</strong>
                    <span className="cm-pill cm-pill-ok">{formatKwh(row.kwh)}</span>
                  </div>
                  {row.locationName ? (
                    <small className="bo-muted">{row.locationName}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Daily consumption</h3>
          <span className="bo-chip">{dailyConsumption.length} days</span>
        </div>
        {dailyConsumption.length === 0 ? (
          <p className="bo-muted">No daily consumption data in the window.</p>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 4,
              height: 140,
              padding: "8px 0",
              borderBottom: "1px solid var(--border)",
              overflowX: "auto"
            }}
            aria-label="Daily kWh consumption, last 30 days"
          >
            {dailyConsumption.map((d) => {
              const ratio = maxDailyKwh > 0 ? d.kwh / maxDailyKwh : 0;
              const heightPct = Math.max(2, Math.round(ratio * 100));
              return (
                <div
                  key={d.date}
                  title={`${d.date}: ${d.kwh.toLocaleString()} kWh`}
                  style={{
                    flex: "1 0 14px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    minWidth: 14
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: `${heightPct}%`,
                      background: "var(--accent)",
                      borderRadius: 2,
                      opacity: d.kwh === 0 ? 0.2 : 1
                    }}
                  />
                  <small className="bo-muted" style={{ fontSize: 10 }}>
                    {shortDay(d.date)}
                  </small>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
