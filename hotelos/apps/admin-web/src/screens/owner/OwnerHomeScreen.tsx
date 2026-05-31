import { getActiveOrganizationId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

const ORGANIZATION_ID = getActiveOrganizationId();

type PortfolioTotals = {
  propertiesCount: number;
  activePropertiesCount: number;
  roomsCount: number;
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  pendingFiscalSubmissions: number;
  pendingBalanceEur: number;
  unattended: { reservations: number; messages: number; tasks: number };
};

type PortfolioAlert = {
  propertyId: string;
  severity: "critical" | "warning";
  title: string;
  description: string;
};

type PortfolioPropertyRow = {
  propertyId: string;
  name: string;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  health: "ok" | "warn" | "error";
};

type PortfolioDashboardData = {
  asOf: string;
  totals: PortfolioTotals;
  perProperty: PortfolioPropertyRow[];
  alerts: PortfolioAlert[];
};

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(value);
}
function fmtEur(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0 €";
  return new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}
function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,0 %";
  return `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} %`;
}
function navigateTo(screen: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

/** Owner home: the "1-page verdict" — portfolio value, performance KPIs, alerts. */
export function OwnerHomeScreen() {
  const { data, loading, error, refresh } = useApiData<PortfolioDashboardData>(
    `/dashboards/portfolio?organizationId=${ORGANIZATION_ID}`,
    { pollIntervalMs: 60000 }
  );

  const t = data?.totals;
  const alerts = data?.alerts ?? [];
  const perProperty = [...(data?.perProperty ?? [])].sort((a, b) => b.revenueMtdEur - a.revenueMtdEur).slice(0, 6);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Propietario · Resumen ejecutivo</div>
          <h1 className="bo-page-title">Resumen del propietario</h1>
          <p className="bo-page-subtitle">
            El estado de tu cartera de un vistazo: rendimiento, ingresos y lo que requiere tu atención.
          </p>
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻ Actualizar</button>
          <button type="button" onClick={() => navigateTo("PortfolioDashboard")}>Ver cartera completa</button>
          <button type="button" className="primary" onClick={() => navigateTo("RevenueHomeDashboard")}>Revenue</button>
        </div>
      </div>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ocupación</span><span className="bo-status ok">cartera</span></div>
          <div className="rev-kpi-value">{fmtPct(t?.occupancyPct)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">ADR</span><span className="bo-status info">media</span></div>
          <div className="rev-kpi-value">{fmtEur(t?.adrEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">RevPAR</span><span className="bo-status info">media</span></div>
          <div className="rev-kpi-value">{fmtEur(t?.revparEur)}</div>
        </article>
      </div>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ingresos (mes)</span><span className="bo-status ok">MTD</span></div>
          <div className="rev-kpi-value">{fmtEur(t?.revenueMtdEur)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${(t?.pendingBalanceEur ?? 0) > 0 ? "warn" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo pendiente</span><span className={`bo-status ${(t?.pendingBalanceEur ?? 0) > 0 ? "warn" : "ok"}`}>{(t?.pendingBalanceEur ?? 0) > 0 ? "por cobrar" : "al día"}</span></div>
          <div className="rev-kpi-value">{fmtEur(t?.pendingBalanceEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Propiedades activas</span><span className="bo-status ok">{fmtNumber(t?.propertiesCount)} total</span></div>
          <div className="rev-kpi-value">{fmtNumber(t?.activePropertiesCount)}</div>
        </article>
      </div>

      <div className="bo-grid two">
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Requiere tu atención</h3>
            <span className="bo-chip">{alerts.length}</span>
          </div>
          {alerts.length === 0 ? (
            <p className="bo-muted">Sin avisos. Todo en orden en la cartera.</p>
          ) : (
            <div className="bo-stack" style={{ gap: 8 }}>
              {alerts.slice(0, 6).map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 8, justifyContent: "space-between", borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 14 }}>{a.title}</strong>
                    <div className="bo-muted" style={{ fontSize: 12 }}>{a.description}</div>
                  </div>
                  <span className={`bo-status ${a.severity === "critical" ? "error" : "warn"}`}>{a.severity === "critical" ? "crítico" : "atención"}</span>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Propiedades destacadas</h3>
            <button type="button" className="ghost" style={{ color: "var(--accent-strong)" }} onClick={() => navigateTo("PortfolioDashboard")}>Ver todas →</button>
          </div>
          {perProperty.length === 0 ? (
            <EmptyState
              title="Sin datos de propiedades todavía"
              message="Las propiedades destacadas aparecerán aquí cuando se registren KPIs y movimientos en la cartera."
            />
          ) : (
            <table className="cm-table">
              <thead><tr><th>Propiedad</th><th>Ocup.</th><th>RevPAR</th><th>Ingresos (mes)</th></tr></thead>
              <tbody>
                {perProperty.map((p) => (
                  <tr key={p.propertyId}>
                    <td><strong>{p.name}</strong></td>
                    <td>{fmtPct(p.occupancyPct)}</td>
                    <td>{fmtEur(p.revparEur)}</td>
                    <td>{fmtEur(p.revenueMtdEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </div>
    </>
  );
}
