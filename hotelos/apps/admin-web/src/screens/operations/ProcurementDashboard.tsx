import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { EmptyState } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

type ProcurementDashboardData = {
  kpis: {
    openPOs: number;
    pendingApproval: number;
    committedValueEur: number;
    receivedThisMonthEur: number;
    supplierCount: number;
  };
  posByStatus: Array<{ status: string; count: number; totalValueEur: number }>;
  topSuppliers: Array<{
    id: string;
    name: string;
    activePoCount: number;
    committedEur: number;
    otdRatePct: number;
  }>;
  recentPOs: Array<{
    id: string;
    number?: string;
    supplierName?: string;
    status: string;
    totalEur: number;
    createdAt: string;
  }>;
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

function prettyStatus(status: string): string {
  if (!status) return "—";
  return status.replace(/_/g, " ");
}

export function ProcurementDashboard() {
  const { data, loading, error, refresh } = useApiData<ProcurementDashboardData>(
    "/dashboards/procurement",
    { pollIntervalMs: 120000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis = data?.kpis;
  const posByStatus = data?.posByStatus ?? [];
  const topSuppliers = data?.topSuppliers ?? [];
  const recentPOs = data?.recentPOs ?? [];

  const pendingStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.pendingApproval === 0 ? "ok"
      : kpis.pendingApproval < 5 ? "warn"
      : "error";

  const openStatus: "ok" | "warn" | "error" =
    !kpis ? "warn"
      : kpis.openPOs === 0 ? "ok"
      : kpis.openPOs < 25 ? "warn"
      : "error";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Procurement</div>
          <h1 className="bo-page-title">Pedidos de compra · Proveedores</h1>
          <p className="bo-page-subtitle">
            Vista de solo lectura del estado de las órdenes de compra, valor comprometido
            y proveedores activos. Refresca automáticamente cada 120 segundos.
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
        <article className={`rev-kpi ${openStatus === "error" ? "rev-kpi-error" : openStatus === "warn" ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">POs abiertos</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.openPOs ?? 0)}</div>
          <div className="rev-kpi-delta">No cerrados ni cancelados</div>
        </article>
        <article className={`rev-kpi ${pendingStatus === "error" ? "rev-kpi-error" : pendingStatus === "warn" ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pendientes de aprobación</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.pendingApproval ?? 0)}</div>
          <div className="rev-kpi-delta">Borrador / submitted</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Valor comprometido</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.committedValueEur)}</div>
          <div className="rev-kpi-delta">Aprobados u ordenados, no recibidos</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Recibido este mes</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : money(kpis?.receivedThisMonthEur)}</div>
          <div className="rev-kpi-delta">POs recibidos en mes en curso</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Proveedores activos</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : (kpis?.supplierCount ?? 0)}</div>
          <div className="rev-kpi-delta">Con POs en esta propiedad</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Breakdown</p>
            <h3>POs por estado</h3>
          </div>
          <span className="bo-chip">{posByStatus.length} estados</span>
        </div>
        {posByStatus.length === 0 ? (
          <EmptyState
            title="No hay órdenes de compra en el periodo"
            message="Cuando se generen POs aparecerán desglosadas por estado para que veas el pipeline de compras."
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Estado</th>
                  <th style={{ textAlign: "right" }}>POs</th>
                  <th style={{ textAlign: "right" }}>Valor total</th>
                </tr>
              </thead>
              <tbody>
                {posByStatus.map((row: ProcurementDashboardData["posByStatus"][number]) => (
                  <tr key={row.status}>
                    <td><strong>{prettyStatus(row.status)}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.count}</td>
                    <td style={{ textAlign: "right" }}>{money(row.totalValueEur)}</td>
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
            <h3>Principales proveedores</h3>
          </div>
          <span className="bo-chip">{topSuppliers.length} filas</span>
        </div>
        {topSuppliers.length === 0 ? (
          <EmptyState
            title="No hay proveedores con POs activos"
            message="Aparecerán aquí los principales proveedores cuando haya órdenes de compra en curso."
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Proveedor</th>
                  <th style={{ textAlign: "right" }}>POs activos</th>
                  <th style={{ textAlign: "right" }}>Comprometido</th>
                  <th style={{ textAlign: "right" }}>OTD</th>
                </tr>
              </thead>
              <tbody>
                {topSuppliers.map((supplier: ProcurementDashboardData["topSuppliers"][number]) => (
                  <tr key={supplier.id}>
                    <td><strong>{supplier.name}</strong></td>
                    <td style={{ textAlign: "right" }}>{supplier.activePoCount}</td>
                    <td style={{ textAlign: "right" }}>{money(supplier.committedEur)}</td>
                    <td style={{ textAlign: "right" }}>{pct(supplier.otdRatePct)}</td>
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
            <p className="bo-muted">Recientes</p>
            <h3>Últimas órdenes de compra</h3>
          </div>
          <span className="bo-chip">{recentPOs.length} POs</span>
        </div>
        {recentPOs.length === 0 ? (
          <EmptyState
            title="No hay órdenes de compra recientes"
            message="Las últimas POs aparecerán aquí con su estado, proveedor e importe."
          />
        ) : (
          <ul className="bo-list">
            {recentPOs.map((po: ProcurementDashboardData["recentPOs"][number]) => (
              <li key={po.id}>
                <strong>{po.number ?? po.id}</strong>
                {po.supplierName ? <> · {po.supplierName}</> : null}
                {" · "}
                <span className="bo-muted">{prettyStatus(po.status)}</span>
                {" · "}
                <strong>{money(po.totalEur)}</strong>
                {" · "}
                <span className="bo-muted">{formatDateTime(po.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
