import { useTabHost } from "../tabs/TabHost";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { dateTime, money } from "../../lib/format";

const PROPERTY_ID = getActivePropertyId();

type UpsellsDashboardData = {
  kpis: {
    activeOffers: number;
    offersShown30d: number;
    conversions30d: number;
    conversionRatePct: number;
    revenueLift30dEur: number;
  };
  topOffers: Array<{
    id: string;
    name: string;
    views30d: number;
    conversions30d: number;
    revenue30dEur: number;
    conversionRatePct: number;
  }>;
  recentPurchases: Array<{
    id: string;
    offerName: string;
    guestName?: string;
    reservationId?: string;
    amountEur: number;
    purchasedAt: string;
  }>;
};

const EMPTY: UpsellsDashboardData = {
  kpis: {
    activeOffers: 0,
    offersShown30d: 0,
    conversions30d: 0,
    conversionRatePct: 0,
    revenueLift30dEur: 0
  },
  topOffers: [],
  recentPurchases: []
};

function formatEur(value: number): string {
  return money(value);
}

function formatDateTime(iso?: string): string {
  return dateTime(iso);
}

export function UpsellsDashboard() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const embedded = useTabHost() !== null;
  const state = useApiData<UpsellsDashboardData>(
    `/dashboards/upsells?propertyId=${PROPERTY_ID}`,
    { pollIntervalMs: 120000 }
  );

  const data = state.data ?? EMPTY;
  const { kpis, topOffers, recentPurchases } = data;

  const activeStatus = kpis.activeOffers > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const shownStatus = kpis.offersShown30d > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const conversionsStatus = kpis.conversions30d > 0 ? "rev-kpi-ok" : "rev-kpi-warn";
  const conversionRateStatus =
    kpis.conversionRatePct >= 20
      ? "rev-kpi-ok"
      : kpis.conversionRatePct >= 5
      ? "rev-kpi-warn"
      : "rev-kpi-error";
  const revenueStatus = kpis.revenueLift30dEur > 0 ? "rev-kpi-ok" : "rev-kpi-warn";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          {embedded ? null : (
            <>
              <div className="bo-page-eyebrow">Comercial · Ventas adicionales</div>
              <h1 className="bo-page-title">Ventas adicionales</h1>
            </>
          )}
          <p className="bo-page-subtitle">
            Vista de solo lectura del rendimiento de ofertas auxiliares: ofertas activas,
            exposiciones, conversiones, tasa de conversión y revenue incremental en los
            últimos 30 días. Datos agregados desde el catálogo de upsells y las compras
            de huéspedes, con refresco automático cada dos minutos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => state.refresh()}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      {state.error ? (
        <section className="bo-card">
          <p style={{ color: "var(--danger-ink)" }}>Couldn't load this view right now. Refresh to retry.</p>
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${activeStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Ofertas activas</span></div>
          <div className="rev-kpi-value">{kpis.activeOffers}</div>
          <div className="rev-kpi-delta">in catalogue</div>
        </article>
        <article className={`rev-kpi ${shownStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Offers shown · 30d</span></div>
          <div className="rev-kpi-value">{kpis.offersShown30d}</div>
          <div className="rev-kpi-delta">exposures in window</div>
        </article>
        <article className={`rev-kpi ${conversionsStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Conversions · 30d</span></div>
          <div className="rev-kpi-value">{kpis.conversions30d}</div>
          <div className="rev-kpi-delta">purchased / confirmed</div>
        </article>
        <article className={`rev-kpi ${conversionRateStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tasa de conversión</span></div>
          <div className="rev-kpi-value">{kpis.conversionRatePct}%</div>
          <div className="rev-kpi-delta">conversions / shown</div>
        </article>
        <article className={`rev-kpi ${revenueStatus}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Revenue lift · 30d</span></div>
          <div className="rev-kpi-value">{formatEur(kpis.revenueLift30dEur)}</div>
          <div className="rev-kpi-delta">converted purchases</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Principales ofertas</h3>
          <span className="bo-chip">{topOffers.length} offers</span>
        </div>
        {topOffers.length === 0 ? (
          <p className="bo-muted">Sin actividad de ventas adicionales en el periodo seleccionado.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Oferta</th>
                <th style={{ textAlign: "right" }}>Vistas</th>
                <th style={{ textAlign: "right" }}>Conversiones</th>
                <th>Conversión</th>
                <th style={{ textAlign: "right" }}>Ingresos</th>
              </tr>
            </thead>
            <tbody>
              {topOffers.map((row) => {
                const widthPct = Math.max(0, Math.min(100, Math.round(row.conversionRatePct)));
                return (
                  <tr key={row.id}>
                    <td><strong>{row.name}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.views30d}</td>
                    <td style={{ textAlign: "right" }}>{row.conversions30d}</td>
                    <td style={{ minWidth: 140 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8
                        }}
                      >
                        <div
                          style={{
                            background: "var(--brand-soft, #d8e3ff)",
                            height: 8,
                            borderRadius: 4,
                            width: `${widthPct}%`,
                            minWidth: row.conversions30d > 0 ? 4 : 0,
                            flex: "0 0 auto"
                          }}
                          aria-label={`${row.conversionRatePct}% conversion`}
                        />
                        <small className="bo-muted">{row.conversionRatePct}%</small>
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>{formatEur(row.revenue30dEur)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Compras recientes</h3>
          <span className="bo-chip">{recentPurchases.length}</span>
        </div>
        {recentPurchases.length === 0 ? (
          <p className="bo-muted">Sin compras recientes.</p>
        ) : (
          <ul className="bo-list">
            {recentPurchases.map((p) => (
              <li key={p.id} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{p.offerName}</strong>
                  <span className="bo-pill">{formatEur(p.amountEur)}</span>
                  {p.guestName ? <span className="bo-pill">{p.guestName}</span> : null}
                </div>
                <small className="bo-muted">
                  {p.reservationId ? <>reservation {p.reservationId} · </> : null}
                  purchased: {formatDateTime(p.purchasedAt)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
