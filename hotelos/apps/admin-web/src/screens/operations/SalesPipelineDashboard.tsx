import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { date, money, percent, plural } from "../../lib/format";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ErrorState } from "../../components/States";
import { ACTIONS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Comercial › Ventas a empresas), never retyped here.
const HEADER = treeHeaderFor("SalesPipelineDashboard", { eyebrow: "Comercial", title: "Ventas a empresas" });
const LOAD_ERROR = errorStateFor("las ventas a empresas");

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
  return money(value);
}

function formatDate(iso?: string): string {
  return date(iso);
}

function formatProbability(p?: number): string {
  return percent(p, { ratio: true, maximumFractionDigits: 0 });
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
      <CocoaPageHeader
        eyebrow={HEADER.eyebrow}
        title={HEADER.title}
        subtitle="Embudo de ventas a empresas en solo lectura: oportunidades abiertas, valor ponderado, cuentas con más peso y conversión del periodo. Se calcula a partir de las oportunidades y las cuentas y se actualiza cada dos minutos."
        actions={
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ {ACTIONS.refresh}
          </button>
        }
      />

      {state.error ? <ErrorState title={LOAD_ERROR.title} message={LOAD_ERROR.message} onRetry={() => state.refresh()} /> : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${openStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Oportunidades abiertas</span></div>
          <div className="rev-kpi-value">{kpis.openOpportunities}</div>
          <div className="rev-kpi-delta">en el embudo ahora mismo</div>
        </article>
        <article className={`rev-kpi ${pipelineStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Valor de la cartera</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.pipelineValueEur)}</div>
          <div className="rev-kpi-delta">suma de las oportunidades abiertas</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Cartera ponderada</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.weightedPipelineEur)}</div>
          <div className="rev-kpi-delta">valor × probabilidad</div>
        </article>
        <article className={`rev-kpi ${wonStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ganadas este mes</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.closedWonMtdEur)}</div>
          <div className="rev-kpi-delta">desde el día 1 hasta hoy</div>
        </article>
        <article className={`rev-kpi ${conversionStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tasa de conversión</span></div>
          <div className="rev-kpi-value">{kpis.conversionRatePct}%</div>
          <div className="rev-kpi-delta">ganadas / (ganadas + perdidas) en el periodo</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Cartera por fase</h3>
            <span className="bo-chip">{plural(opportunitiesByStage.length, "fase", "fases", { withCount: true })}</span>
          </div>
          {opportunitiesByStage.length === 0 ? (
            <p className="bo-muted">Todavía no hay oportunidades en esta propiedad.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Fase</th>
                  <th style={{ textAlign: "right" }}>Número</th>
                  <th>Embudo</th>
                  <th style={{ textAlign: "right" }}>Valor total</th>
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
                          aria-label={plural(row.count, "oportunidad", "oportunidades", { withCount: true })}
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
            <h3>Principales cuentas</h3>
            <span className="bo-chip">{plural(topAccounts.length, "cuenta", "cuentas", { withCount: true })}</span>
          </div>
          {topAccounts.length === 0 ? (
            <p className="bo-muted">Sin cuentas con oportunidades abiertas.</p>
          ) : (
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Cuenta</th>
                  <th style={{ textAlign: "right" }}>Abiertas</th>
                  <th style={{ textAlign: "right" }}>Valor total</th>
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
          <h3>Oportunidades recientes</h3>
          <span className="bo-chip">{recentOpportunities.length}</span>
        </div>
        {recentOpportunities.length === 0 ? (
          <p className="bo-muted">Sin oportunidades recientes.</p>
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
                  cierre previsto: {formatDate(opp.expectedCloseDate)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
