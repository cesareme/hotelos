// Procurement dashboard — Operaciones › Compras e inventario › Compras
// (/operaciones/compras). Read-only view of purchase orders, committed value
// and active suppliers.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, dashboard archetype): CocoaPage →
// KPI strip (5, captions as `deltaLabel`) → grid 6/6 (orders by status as a
// CocoaTable with totals · top suppliers as a CocoaTable) → latest orders as
// a section list with a status CocoaBadge. Mirror skeleton with the same
// spans. Data: GET /dashboards/procurement?propertyId= (120 s poll), unchanged.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { ACTIONS, STATUS_LABELS, UI_STATES } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { dateTime, money, number, percent, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type StatusRow = { status: string; count: number; totalValueEur: number };
type SupplierRow = {
  id: string;
  name: string;
  activePoCount: number;
  committedEur: number;
  otdRatePct: number;
};
type RecentPo = {
  id: string;
  number?: string;
  supplierName?: string;
  status: string;
  totalEur: number;
  createdAt: string;
};

type ProcurementDashboardData = {
  kpis: {
    openPOs: number;
    pendingApproval: number;
    committedValueEur: number;
    receivedThisMonthEur: number;
    supplierCount: number;
  };
  posByStatus: StatusRow[];
  topSuppliers: SupplierRow[];
  recentPOs: RecentPo[];
};

// Purchase-order statuses of the API in Spanish; unknown ones fall back to the raw word.
const PO_STATUS_LABEL: Record<string, string> = {
  draft: STATUS_LABELS.draft,
  submitted: STATUS_LABELS.sent,
  pending_approval: STATUS_LABELS.pending,
  approved: STATUS_LABELS.approved,
  rejected: STATUS_LABELS.rejected,
  ordered: "Pedido",
  partially_received: "Recibido parcialmente",
  received: "Recibido",
  closed: "Cerrado",
  cancelled: STATUS_LABELS.cancelled
};

const PO_STATUS_TONE: Record<string, CocoaTone> = {
  draft: "neutral",
  submitted: "info",
  pending_approval: "warning",
  approved: "accent",
  rejected: "danger",
  ordered: "info",
  partially_received: "warning",
  received: "success",
  closed: "neutral",
  cancelled: "danger"
};

function statusLabel(status: string): string {
  if (!status) return "—";
  return PO_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function statusTone(status: string): CocoaTone {
  return PO_STATUS_TONE[status] ?? "neutral";
}

const STATUS_COLUMNS: CocoaTableColumn<StatusRow>[] = [
  { key: "status", label: "Estado", render: (row) => <CocoaBadge tone={statusTone(row.status)}>{statusLabel(row.status)}</CocoaBadge> },
  { key: "count", label: "Pedidos", align: "right", render: (row) => number(row.count) },
  { key: "totalValueEur", label: "Valor total", align: "right", render: (row) => money(row.totalValueEur) }
];

const SUPPLIER_COLUMNS: CocoaTableColumn<SupplierRow>[] = [
  { key: "name", label: "Proveedor", render: (row) => <strong>{row.name}</strong> },
  { key: "activePoCount", label: "Pedidos activos", align: "right", render: (row) => number(row.activePoCount) },
  { key: "committedEur", label: "Comprometido", align: "right", render: (row) => money(row.committedEur) },
  { key: "otdRatePct", label: "Entrega a tiempo", align: "right", hideOnNarrow: true, render: (row) => percent(row.otdRatePct) }
];

// Mirror skeleton: strip of five KPI tiles, the 6/6 row and the list card.
function ProcurementSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} />
    </div>
  );
}

export function ProcurementDashboard() {
  const hosted = useTabHost() !== null;
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<ProcurementDashboardData>(
    "/dashboards/procurement",
    { pollIntervalMs: 120000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis = data?.kpis;
  const posByStatus = toArray<StatusRow>(data?.posByStatus);
  const topSuppliers = toArray<SupplierRow>(data?.topSuppliers);
  const recentPOs = toArray<RecentPo>(data?.recentPOs);

  const pendingStatus = !kpis ? "warning" : kpis.pendingApproval === 0 ? "ok" : kpis.pendingApproval < 5 ? "warning" : "critical";
  const openStatus = !kpis ? "warning" : kpis.openPOs === 0 ? "ok" : kpis.openPOs < 25 ? "warning" : "critical";
  const statusTotals = posByStatus.reduce(
    (acc, row) => ({ count: acc.count + row.count, value: acc.value + row.totalValueEur }),
    { count: 0, value: 0 }
  );
  const state = loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`Operaciones · ${propertyName}`}
      title="Pedidos de compra · Proveedores"
      subtitle={hosted ? undefined : "Vista de solo lectura del estado de las órdenes de compra, valor comprometido y proveedores activos. Refresca automáticamente cada 120 segundos."}
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{UI_STATES.error.title}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<ProcurementSkeleton />}
      error={{ title: UI_STATES.error.title, message: error ?? UI_STATES.error.message, onRetry: refresh }}
      commands={[{ id: "procurement-refresh", label: "Actualizar compras", run: refresh }]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de compras">
        <CocoaKpi label="Pedidos abiertos" value={number(kpis?.openPOs ?? 0)} deltaLabel="no cerrados ni cancelados" polarity="neutral" status={openStatus} />
        <CocoaKpi label="Pendientes de aprobación" value={number(kpis?.pendingApproval ?? 0)} deltaLabel="borrador o enviados" polarity="neutral" status={pendingStatus} />
        <CocoaKpi label="Valor comprometido" value={money(kpis?.committedValueEur)} deltaLabel="aprobados u ordenados, no recibidos" polarity="neutral" status="ok" />
        <CocoaKpi label="Recibido este mes" value={money(kpis?.receivedThisMonthEur)} deltaLabel="pedidos recibidos en el mes en curso" polarity="neutral" status="ok" />
        <CocoaKpi label="Proveedores activos" value={number(kpis?.supplierCount ?? 0)} deltaLabel="con pedidos en esta propiedad" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Órdenes por estado y proveedores">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Pedidos por estado" meta={plural(posByStatus.length, "estado", "estados")} padding={posByStatus.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {posByStatus.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay órdenes de compra en el periodo" message="Cuando se generen pedidos aparecerán desglosados por estado para que veas el flujo de compras." />
            ) : (
              <CocoaTable
                columns={STATUS_COLUMNS}
                rows={posByStatus}
                rowKey="status"
                density="compact"
                caption="Órdenes de compra por estado"
                aria-label="Órdenes de compra por estado"
                footer={{ status: "Total", count: number(statusTotals.count), totalValueEur: <strong>{money(statusTotals.value)}</strong> }}
              />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Principales proveedores" meta={plural(topSuppliers.length, "proveedor", "proveedores")} padding={topSuppliers.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {topSuppliers.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay proveedores con pedidos activos" message="Aparecerán aquí los principales proveedores cuando haya órdenes de compra en curso." />
            ) : (
              <CocoaTable columns={SUPPLIER_COLUMNS} rows={topSuppliers} rowKey="id" density="compact" caption="Principales proveedores" aria-label="Principales proveedores" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Últimas órdenes de compra" meta={plural(recentPOs.length, "pedido", "pedidos")}>
        {recentPOs.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay órdenes de compra recientes" message="Los últimos pedidos aparecerán aquí con su estado, proveedor e importe." />
        ) : (
          <ol className="c22-section__list" aria-label="Últimas órdenes de compra">
            {recentPOs.map((po) => (
              <li key={po.id}>
                <span className="cocoa-cluster">
                  <CocoaBadge tone={statusTone(po.status)} variant="dot" size="small">
                    {statusLabel(po.status)}
                  </CocoaBadge>
                  <strong>{po.number ?? po.id}</strong>
                  {po.supplierName ? <span>{po.supplierName}</span> : null}
                </span>
                <span className="cocoa-cluster">
                  <strong>{money(po.totalEur)}</strong>
                  <time dateTime={po.createdAt}>{dateTime(po.createdAt)}</time>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
