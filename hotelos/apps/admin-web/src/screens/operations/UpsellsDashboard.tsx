// Ventas adicionales — Comercial › Ventas adicionales (/comercial/ventas-adicionales,
// base tab of VentasAdicionalesTabs).
//
// Cocoa 22 · ola 7 · lote 7-C: hosted dashboard (template DashboardAlojado,
// pilot GeneralManagerScreen): KPI strip → principales ofertas (table with the
// conversion bar) → compras recientes. Read only; GET /dashboards/upsells every
// two minutes. Standalone the same function paints eyebrow, title and subtitle.

import { useTabHost } from "../tabs/TabHost";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { dateTime, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
// Menu labels of the tree (Comercial › Ventas adicionales), never retyped here.
const HEADER = treeHeaderFor("UpsellsDashboard", { eyebrow: "Comercial", title: "Ventas adicionales" });
const LOAD_ERROR = errorStateFor("las ventas adicionales");

type TopOffer = {
  id: string;
  name: string;
  views30d: number;
  conversions30d: number;
  revenue30dEur: number;
  conversionRatePct: number;
};

type Purchase = {
  id: string;
  offerName: string;
  guestName?: string;
  reservationId?: string;
  amountEur: number;
  purchasedAt: string;
};

type UpsellsDashboardData = {
  kpis: {
    activeOffers: number;
    offersShown30d: number;
    conversions30d: number;
    conversionRatePct: number;
    revenueLift30dEur: number;
  };
  topOffers: TopOffer[];
  recentPurchases: Purchase[];
};

const OFFER_COLUMNS: CocoaTableColumn<TopOffer>[] = [
  { key: "name", label: "Oferta", minWidth: 160, render: (row) => <strong>{row.name}</strong> },
  { key: "views30d", label: "Vistas", align: "right", fit: true, render: (row) => number(row.views30d) },
  { key: "conversions30d", label: "Conversiones", align: "right", fit: true, render: (row) => number(row.conversions30d) },
  {
    key: "conversionRatePct",
    label: "Conversión",
    minWidth: 140,
    render: (row) => (
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <span style={{ flex: "1 1 auto", minWidth: 72 }}>
          <CocoaChart.Progress
            value={Math.max(0, Math.min(100, row.conversionRatePct))}
            showValue={false}
            aria-label={`Conversión de ${row.name}: ${percent(row.conversionRatePct)}`}
          />
        </span>
        <span>{percent(row.conversionRatePct)}</span>
      </div>
    )
  },
  { key: "revenue30dEur", label: "Ingresos", align: "right", fit: true, render: (row) => money(row.revenue30dEur) }
];

const PURCHASE_COLUMNS: CocoaTableColumn<Purchase>[] = [
  { key: "offerName", label: "Oferta", minWidth: 160, render: (row) => <strong>{row.offerName}</strong> },
  { key: "guestName", label: "Huésped", hideOnNarrow: true, render: (row) => row.guestName ?? "—" },
  { key: "reservationId", label: "Reserva", fit: true, showFrom: "desktop", render: (row) => row.reservationId ?? "—" },
  { key: "amountEur", label: "Importe", align: "right", fit: true, render: (row) => money(row.amountEur) },
  { key: "purchasedAt", label: "Comprada", fit: true, render: (row) => dateTime(row.purchasedAt) }
];

// Skeleton espejo: strip of 5 tiles, then two full-width cards.
function UpsellsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[12], [12]]} height={200} />
    </div>
  );
}

export function UpsellsDashboard() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const { data, loading, error, refresh } = useApiData<UpsellsDashboardData>(`/dashboards/upsells?propertyId=${PROPERTY_ID}`, {
    pollIntervalMs: 120000
  });

  const kpis = data?.kpis;
  const topOffers = toArray<TopOffer>(data?.topOffers);
  const recentPurchases = toArray<Purchase>(data?.recentPurchases);

  const activeStatus = kpis && kpis.activeOffers > 0 ? "ok" : "warning";
  const shownStatus = kpis && kpis.offersShown30d > 0 ? "ok" : "warning";
  const conversionsStatus = kpis && kpis.conversions30d > 0 ? "ok" : "warning";
  const conversionRateStatus = !kpis ? "warning" : kpis.conversionRatePct >= 20 ? "ok" : kpis.conversionRatePct >= 5 ? "warning" : "critical";
  const revenueStatus = kpis && kpis.revenueLift30dEur > 0 ? "ok" : "warning";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${getActiveProperty().propertyName}`}
      title={HEADER.title}
      subtitle={
        hosted
          ? undefined
          : "Vista de solo lectura del rendimiento de las ofertas adicionales: ofertas activas, exposiciones, conversiones, tasa de conversión e ingresos adicionales de los últimos 30 días. Datos agregados desde el catálogo y las compras de los huéspedes, con refresco automático cada dos minutos."
      }
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{LOAD_ERROR.title}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<UpsellsSkeleton />}
      error={{ title: LOAD_ERROR.title, message: LOAD_ERROR.message, onRetry: refresh }}
      commands={[{ id: "ventas-adicionales-refresh", label: "Actualizar las ventas adicionales", run: refresh }]}
    >
      {kpis ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de ventas adicionales">
            <CocoaKpi label="Ofertas activas" value={number(kpis.activeOffers)} deltaLabel="en el catálogo" polarity="neutral" status={activeStatus} />
            <CocoaKpi label="Ofertas mostradas · 30 días" value={number(kpis.offersShown30d)} deltaLabel="exposiciones en el periodo" polarity="neutral" status={shownStatus} />
            <CocoaKpi label="Conversiones · 30 días" value={number(kpis.conversions30d)} deltaLabel="compradas o confirmadas" polarity="neutral" status={conversionsStatus} />
            <CocoaKpi label="Tasa de conversión" value={percent(kpis.conversionRatePct)} deltaLabel="conversiones / mostradas" polarity="neutral" status={conversionRateStatus} />
            <CocoaKpi label="Ingresos adicionales · 30 días" value={money(kpis.revenueLift30dEur)} deltaLabel="compras convertidas" polarity="neutral" status={revenueStatus} />
          </CocoaKpiStrip>

          <CocoaSection title="Principales ofertas" meta={plural(topOffers.length, "oferta", "ofertas")} padding={topOffers.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {topOffers.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin actividad de ventas adicionales en el periodo seleccionado." />
            ) : (
              <CocoaTable columns={OFFER_COLUMNS} rows={topOffers} rowKey="id" caption="Principales ofertas" aria-label="Principales ofertas" />
            )}
          </CocoaSection>

          <CocoaSection title="Compras recientes" meta={plural(recentPurchases.length, "compra", "compras")} padding={recentPurchases.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {recentPurchases.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin compras recientes." />
            ) : (
              <CocoaTable columns={PURCHASE_COLUMNS} rows={recentPurchases} rowKey="id" caption="Compras recientes" aria-label="Compras recientes" />
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
