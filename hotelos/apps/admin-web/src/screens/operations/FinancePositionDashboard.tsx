import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

type AgingBuckets = {
  current: number;
  days0_30: number;
  days31_60: number;
  days61_90: number;
  days90Plus: number;
};

type FinancePositionDashboardData = {
  kpis: {
    accountsReceivableTotal: number;
    accountsPayableTotal: number;
    cashOnHand: number;
    monthCollectedPct: number;
  };
  arAging: AgingBuckets;
  apAging: AgingBuckets;
  topDebtors: Array<{ guestOrAccount: string; invoiceCount: number; outstanding: number }>;
  topCreditors: Array<{ supplierName: string; billCount: number; outstanding: number }>;
  recentPayments: Array<{ id: string; amount: number; method: string; capturedAt?: string; reference?: string }>;
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

function bucketTotal(buckets: AgingBuckets | undefined): number {
  if (!buckets) return 0;
  return (
    (buckets.current ?? 0) +
    (buckets.days0_30 ?? 0) +
    (buckets.days31_60 ?? 0) +
    (buckets.days61_90 ?? 0) +
    (buckets.days90Plus ?? 0)
  );
}

export function FinancePositionDashboard() {
  const { data, loading, error, refresh } = useApiData<FinancePositionDashboardData>(
    "/dashboards/finance-position",
    { pollIntervalMs: 60000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis = data?.kpis;
  const arAging = data?.arAging;
  const apAging = data?.apAging;
  const topDebtors = data?.topDebtors ?? [];
  const topCreditors = data?.topCreditors ?? [];
  const recentPayments = data?.recentPayments ?? [];

  const collectedStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.monthCollectedPct >= 80 ? "ok"
      : kpis.monthCollectedPct >= 50 ? "warn"
      : "error";

  const arStatus: "ok" | "warn" | "error" =
    !arAging ? "warn"
      : arAging.days90Plus > 0 ? "error"
      : arAging.days61_90 > 0 ? "warn"
      : "ok";

  const apStatus: "ok" | "warn" | "error" =
    !apAging ? "warn"
      : apAging.days90Plus > 0 ? "error"
      : apAging.days61_90 > 0 ? "warn"
      : "ok";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Finance · Position</div>
          <h1 className="bo-page-title">AR · AP · Cash</h1>
          <p className="bo-page-subtitle">
            Monitor de salud financiera en tiempo real: cuentas a cobrar, cuentas a pagar, tesorería disponible
            y porcentaje de cobro del mes en curso. Solo lectura; refresca automáticamente cada 60 segundos.
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
        <article className={`rev-kpi ${arStatus === "error" ? "rev-kpi-error" : arStatus === "warn" ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Accounts Receivable</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.accountsReceivableTotal)}</div>
          <div className="rev-kpi-delta">{topDebtors.length} deudores activos</div>
        </article>
        <article className={`rev-kpi ${apStatus === "error" ? "rev-kpi-error" : apStatus === "warn" ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Accounts Payable</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.accountsPayableTotal)}</div>
          <div className="rev-kpi-delta">{topCreditors.length} proveedores con saldo</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Cash on hand</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.cashOnHand)}</div>
          <div className="rev-kpi-delta">Pagos capturados menos reembolsos</div>
        </article>
        <article className={`rev-kpi ${collectedStatus === "error" ? "rev-kpi-error" : collectedStatus === "warn" ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Cobrado este mes</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : pct(kpis?.monthCollectedPct)}</div>
          <div className="rev-kpi-delta">Cobrado / facturado mes en curso</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Aging</p>
              <h3>Cuentas a cobrar (AR)</h3>
            </div>
            <span className="bo-chip">{money(bucketTotal(arAging))}</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>No vencido</th>
                  <th>0 – 30 días</th>
                  <th>31 – 60 días</th>
                  <th>61 – 90 días</th>
                  <th>90+ días</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{money(arAging?.current)}</td>
                  <td>{money(arAging?.days0_30)}</td>
                  <td>{money(arAging?.days31_60)}</td>
                  <td>{money(arAging?.days61_90)}</td>
                  <td className={(arAging?.days90Plus ?? 0) > 0 ? "cm-row-error" : undefined}>
                    <strong>{money(arAging?.days90Plus)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Aging</p>
              <h3>Cuentas a pagar (AP)</h3>
            </div>
            <span className="bo-chip">{money(bucketTotal(apAging))}</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>No vencido</th>
                  <th>0 – 30 días</th>
                  <th>31 – 60 días</th>
                  <th>61 – 90 días</th>
                  <th>90+ días</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{money(apAging?.current)}</td>
                  <td>{money(apAging?.days0_30)}</td>
                  <td>{money(apAging?.days31_60)}</td>
                  <td>{money(apAging?.days61_90)}</td>
                  <td className={(apAging?.days90Plus ?? 0) > 0 ? "cm-row-error" : undefined}>
                    <strong>{money(apAging?.days90Plus)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Top 10</p>
            <h3>Principales deudores</h3>
          </div>
          <span className="bo-chip">{topDebtors.length} filas</span>
        </div>
        {topDebtors.length === 0 ? (
          <EmptyState
            title="No hay deudores con saldo abierto"
            message="Todos los clientes están al día con los cobros. Si aparecen saldos pendientes los verás aquí ordenados por importe."
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Cuenta / Cliente</th>
                  <th>Facturas</th>
                  <th style={{ textAlign: "right" }}>Saldo pendiente</th>
                </tr>
              </thead>
              <tbody>
                {topDebtors.map((debtor: FinancePositionDashboardData["topDebtors"][number], idx: number) => (
                  <tr key={`${debtor.guestOrAccount}-${idx}`}>
                    <td>{debtor.guestOrAccount}</td>
                    <td>{debtor.invoiceCount}</td>
                    <td style={{ textAlign: "right" }}><strong>{money(debtor.outstanding)}</strong></td>
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
            <p className="bo-muted">Top 10</p>
            <h3>Principales acreedores</h3>
          </div>
          <span className="bo-chip">{topCreditors.length} filas</span>
        </div>
        {topCreditors.length === 0 ? (
          <EmptyState
            title="No hay facturas de proveedor abiertas"
            message="No hay deuda con proveedores en este momento. Aparecerán aquí las facturas pendientes de pago si las hubiera."
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Proveedor</th>
                  <th>Facturas</th>
                  <th style={{ textAlign: "right" }}>Saldo pendiente</th>
                </tr>
              </thead>
              <tbody>
                {topCreditors.map((creditor: FinancePositionDashboardData["topCreditors"][number], idx: number) => (
                  <tr key={`${creditor.supplierName}-${idx}`}>
                    <td>{creditor.supplierName}</td>
                    <td>{creditor.billCount}</td>
                    <td style={{ textAlign: "right" }}><strong>{money(creditor.outstanding)}</strong></td>
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
            <p className="bo-muted">Tesorería</p>
            <h3>Pagos recientes</h3>
          </div>
          <span className="bo-chip">{recentPayments.length} capturados</span>
        </div>
        {recentPayments.length === 0 ? (
          <p className="bo-muted">No se han capturado pagos.</p>
        ) : (
          <ul className="bo-list">
            {recentPayments.map((payment: FinancePositionDashboardData["recentPayments"][number]) => (
              <li key={payment.id}>
                <strong>{money(payment.amount)}</strong> · {payment.method}
                {" · "}
                <span className="bo-muted">{formatDateTime(payment.capturedAt)}</span>
                {payment.reference ? (
                  <>
                    {" · "}
                    <code>{payment.reference}</code>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
