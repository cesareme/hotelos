import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { number, plural } from "../../lib/format";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ErrorState } from "../../components/States";
import { ACTIONS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Operaciones › Energía y agua), never retyped here.
const HEADER = treeHeaderFor("EnergyDashboard", { eyebrow: "Operaciones", title: "Energía y agua" });
const LOAD_ERROR = errorStateFor("el consumo de energía y agua");

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
  return `${number(n)} kWh`;
}

function trendPill(pct: number) {
  if (pct === 0) return <span className="cm-pill cm-pill-ok">estable</span>;
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
      <CocoaPageHeader
        eyebrow={HEADER.eyebrow}
        title={HEADER.title}
        subtitle="Consumo de los últimos 30 días: kWh totales, kWh por habitación ocupada, tendencia frente al periodo anterior, contadores activos y lecturas anómalas, por contador y por día. Solo lectura; se actualiza cada 5 minutos."
        actions={
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ {ACTIONS.refresh}
          </button>
        }
      />

      {state.error ? <ErrorState title={LOAD_ERROR.title} message={LOAD_ERROR.message} onRetry={() => state.refresh()} /> : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Total kWh (30d)</span>
          </div>
          <div className="rev-kpi-value">{number(kpis.totalKwh30d)}</div>
          <div className="rev-kpi-delta">consumo en la ventana</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">kWh por habitación ocupada</span>
          </div>
          <div className="rev-kpi-value">{number(kpis.kwhPerOccupiedRoom)}</div>
          <div className="rev-kpi-delta">kWh totales entre las noches ocupadas</div>
        </article>
        <article className={`rev-kpi ${tendencyStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Tendencia (90 días)</span>
          </div>
          <div className="rev-kpi-value">
            {kpis.tendencyPct90d > 0 ? "+" : ""}
            {kpis.tendencyPct90d}%
          </div>
          <div className="rev-kpi-delta">últimos 30 días frente a los 30 anteriores</div>
        </article>
        <article className={`rev-kpi ${activeMetersStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Contadores activos</span>
          </div>
          <div className="rev-kpi-value">{kpis.activeMeters}</div>
          <div className="rev-kpi-delta">con lecturas recientes</div>
        </article>
        <article className={`rev-kpi ${abnormalStatus}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Lecturas anómalas</span>
          </div>
          <div className="rev-kpi-value">{kpis.abnormalReadingsCount}</div>
          <div className="rev-kpi-delta">retrocesos o valores atípicos en la ventana</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Consumo por contador</h3>
            <span className="bo-chip">{plural(consumptionByMeter.length, "contador", "contadores", { withCount: true })}</span>
          </div>
          {consumptionByMeter.length === 0 ? (
            <p className="bo-muted">Sin contadores con lecturas en el periodo seleccionado.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Contador</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: "right" }}>kWh (30d)</th>
                  <th style={{ textAlign: "right" }}>Tendencia</th>
                </tr>
              </thead>
              <tbody>
                {consumptionByMeter.map((row) => (
                  <tr key={row.meterName}>
                    <td><strong>{row.meterName}</strong></td>
                    <td>{row.meterType}</td>
                    <td style={{ textAlign: "right" }}>{number(row.kwh30d)}</td>
                    <td style={{ textAlign: "right" }}>{trendPill(row.trendPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Mayores consumidores</h3>
            <span className="bo-chip">{plural(topConsumers.length, "contador", "contadores", { withCount: true })}</span>
          </div>
          {topConsumers.length === 0 ? (
            <p className="bo-muted">Sin consumidores con consumo registrado.</p>
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
          <h3>Consumo diario</h3>
          <span className="bo-chip">{plural(dailyConsumption.length, "día", "días", { withCount: true })}</span>
        </div>
        {dailyConsumption.length === 0 ? (
          <p className="bo-muted">Sin datos de consumo diario en el periodo.</p>
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
            aria-label="Consumo diario en kWh de los últimos 30 días"
          >
            {dailyConsumption.map((d) => {
              const ratio = maxDailyKwh > 0 ? d.kwh / maxDailyKwh : 0;
              const heightPct = Math.max(2, Math.round(ratio * 100));
              return (
                <div
                  key={d.date}
                  title={`${d.date}: ${number(d.kwh)} kWh`}
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
