import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type SalesPipelineDashboardData = {
  kpis: {
    openOpportunities: number;
    pipelineValueEur: number;
    weightedPipelineEur: number;
    closedWonMtdEur: number;
    conversionRatePct: number;
  };
  opportunitiesByStage: Array<{ stage: string; count: number; totalValue: number }>;
  topAccounts: Array<{ accountName: string; openOpps: number; totalValue: number }>;
  recentOpportunities: Array<{
    id: string;
    name: string;
    stage: string;
    expectedValue?: number;
    probability?: number;
    accountName?: string;
    expectedCloseDate?: string;
  }>;
};

const EMPTY: SalesPipelineDashboardData = {
  kpis: {
    openOpportunities: 0,
    pipelineValueEur: 0,
    weightedPipelineEur: 0,
    closedWonMtdEur: 0,
    conversionRatePct: 0
  },
  opportunitiesByStage: [],
  topAccounts: [],
  recentOpportunities: []
};

const WON_STAGES = new Set(["won", "closed_won", "closed-won", "closedwon"]);
const LOST_STAGES = new Set(["lost", "closed_lost", "closed-lost", "closedlost"]);

const eurFormat = new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR" });

function normaliseStage(stage: string): string {
  return stage.toLowerCase().replace(/[\s-]+/g, "_").trim();
}

function stagePill(stage: string) {
  const key = normaliseStage(stage);
  if (WON_STAGES.has(key)) return <span className="cm-pill cm-pill-ok">{stage}</span>;
  if (LOST_STAGES.has(key)) return <span className="cm-pill cm-pill-error">{stage}</span>;
  return <span className="cm-pill cm-pill-warn">{stage}</span>;
}

function formatEur(value: number): string {
  return eurFormat.format(value);
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-ES");
  } catch {
    return iso;
  }
}

function formatProbability(p?: number): string {
  if (p === undefined || p === null) return "—";
  return `${Math.round(p * 100)}%`;
}

export function SalesPipelineDashboard() {
  const state = useApiData<SalesPipelineDashboardData>(
    `/dashboards/sales-pipeline?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 120000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, opportunitiesByStage, topAccounts, recentOpportunities } = data;

  const maxStageCount = opportunitiesByStage.reduce((max, row) => Math.max(max, row.count), 0);

  const openStatus = kpis.openOpportunities > 0 ? "rev-kpi-warn" : "rev-kpi-ok";
  const pipelineStatus = kpis.pipelineValueEur > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const wonStatus = kpis.closedWonMtdEur > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const conversionStatus =
    kpis.conversionRatePct >= 50 ? "rev-kpi-ok" : kpis.conversionRatePct >= 25 ? "rev-kpi-warn" : "rev-kpi-error";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Commercial · Sales</div>
          <h1 className="bo-page-title">Sales pipeline</h1>
          <p className="bo-page-subtitle">
            Vista de solo lectura del pipeline comercial B2B: oportunidades abiertas, valor
            ponderado, cuentas con mayor exposición y conversión del periodo. Datos agregados
            desde oportunidades de venta y cuentas, con refresco automático cada dos minutos.
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
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open opportunities</span></div>
          <div className="rev-kpi-value">{kpis.openOpportunities}</div>
          <div className="rev-kpi-delta">currently in pipeline</div>
        </article>
        <article className={`rev-kpi ${pipelineStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pipeline value</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.pipelineValueEur)}</div>
          <div className="rev-kpi-delta">sum of open opportunities</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Weighted pipeline</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.weightedPipelineEur)}</div>
          <div className="rev-kpi-delta">value × probability</div>
        </article>
        <article className={`rev-kpi ${wonStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Closed won MTD</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.closedWonMtdEur)}</div>
          <div className="rev-kpi-delta">month-to-date</div>
        </article>
        <article className={`rev-kpi ${conversionStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Conversion rate</span></div>
          <div className="rev-kpi-value">{kpis.conversionRatePct}%</div>
          <div className="rev-kpi-delta">won / (won + lost) in period</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Pipeline by stage</h3>
            <span className="bo-chip">{opportunitiesByStage.length} stages</span>
          </div>
          {opportunitiesByStage.length === 0 ? (
            <p className="bo-muted">No opportunities yet for this property.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th style={{ textAlign: "right" }}>Count</th>
                  <th>Funnel</th>
                  <th style={{ textAlign: "right" }}>Total value</th>
                </tr>
              </thead>
              <tbody>
                {opportunitiesByStage.map((row) => {
                  const widthPct = maxStageCount > 0 ? Math.round((row.count / maxStageCount) * 100) : 0;
                  return (
                    <tr key={row.stage}>
                      <td>{stagePill(row.stage)}</td>
                      <td style={{ textAlign: "right" }}>{row.count}</td>
                      <td style={{ minWidth: 120 }}>
                        <div
                          style={{
                            background: "var(--brand-soft, #d8e3ff)",
                            height: 8,
                            borderRadius: 4,
                            width: `${widthPct}%`,
                            minWidth: row.count > 0 ? 4 : 0
                          }}
                          aria-label={`${row.count} opportunities`}
                        />
                      </td>
                      <td style={{ textAlign: "right" }}>{formatEur(row.totalValue)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Top accounts</h3>
            <span className="bo-chip">top {topAccounts.length}</span>
          </div>
          {topAccounts.length === 0 ? (
            <p className="bo-muted">No accounts with open opportunities.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th style={{ textAlign: "right" }}>Open</th>
                  <th style={{ textAlign: "right" }}>Total value</th>
                </tr>
              </thead>
              <tbody>
                {topAccounts.map((row) => (
                  <tr key={row.accountName}>
                    <td><strong>{row.accountName}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.openOpps}</td>
                    <td style={{ textAlign: "right" }}>{formatEur(row.totalValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Recent opportunities</h3>
          <span className="bo-chip">{recentOpportunities.length}</span>
        </div>
        {recentOpportunities.length === 0 ? (
          <p className="bo-muted">No recent opportunities.</p>
        ) : (
          <ul className="bo-list">
            {recentOpportunities.map((opp) => (
              <li key={opp.id} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {stagePill(opp.stage)}
                  <strong>{opp.name}</strong>
                  {opp.expectedValue !== undefined ? (
                    <span className="bo-pill">{formatEur(opp.expectedValue)}</span>
                  ) : null}
                  <span className="bo-pill">{formatProbability(opp.probability)}</span>
                </div>
                <small className="bo-muted">
                  {opp.accountName ? <>{opp.accountName} · </> : null}
                  expected close: {formatDate(opp.expectedCloseDate)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
