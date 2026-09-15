// Inventory dashboard — Operaciones › Compras e inventario › Inventario
// (/operaciones/compras/inventario). Read-only view of stock levels, items
// below their minimum, inventory value and the latest movements.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, dashboard archetype): CocoaPage →
// KPI strip (5) → grid 8/4 (items below minimum as a CocoaTable · stock by
// location as a section list) → grid 6/6 (top consumed as CocoaChart.Bars ·
// recent movements as a CocoaTable). Mirror skeleton with the same spans.
// Data: GET /dashboards/inventory?propertyId= (120 s poll), unchanged.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { ACTIONS, STATUS_LABELS, UI_STATES } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { dateTime, money, number, percent, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaBarsDatum,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type Kpis = {
  itemsCount: number;
  itemsBelowMin: number;
  lowStockValueEur: number;
  totalInventoryValueEur: number;
  movementsLast30d: number;
};

type BelowMinRow = {
  id: string;
  sku?: string;
  name: string;
  currentQty: number;
  minimumQty: number;
  locationName?: string;
};
type ConsumedRow = { id: string; name: string; consumedQty: number };
type LocationRow = { locationName: string; itemsCount: number; valueEur: number };
type MovementRow = {
  id: string;
  itemName: string;
  movementType: string;
  quantity: number;
  at: string;
  locationName?: string;
};

type InventoryDashboardData = {
  kpis: Kpis;
  itemsBelowMinList: BelowMinRow[];
  topConsumed: ConsumedRow[];
  stockByLocation: LocationRow[];
  recentMovements: MovementRow[];
};

function fmtNumber(value: number | null | undefined): string {
  return number(value, { maximumFractionDigits: 0 });
}

function fmtQty(value: number | null | undefined): string {
  return number(value);
}

const MOVEMENT_LABELS: Record<string, string> = {
  receipt: "Recepción",
  in: "Entrada",
  purchase: "Compra",
  transfer_in: "Traspaso de entrada",
  adjustment_in: "Ajuste +",
  return: "Devolución",
  consumption: "Consumo",
  out: "Salida",
  issue: "Entrega",
  transfer_out: "Traspaso de salida",
  adjustment_out: "Ajuste −",
  loss: "Pérdida",
  waste: "Merma"
};

const MOVEMENT_TONE: Record<string, CocoaTone> = {
  receipt: "success",
  in: "success",
  purchase: "success",
  transfer_in: "info",
  adjustment_in: "info",
  return: "info",
  consumption: "warning",
  out: "warning",
  issue: "warning",
  transfer_out: "info",
  adjustment_out: "warning",
  loss: "danger",
  waste: "danger"
};

/** Severity of an item below its minimum (pure): out of stock / under half / low. */
function belowMinLevel(row: BelowMinRow): { tone: CocoaTone; label: string } {
  const ratio = row.minimumQty > 0 ? row.currentQty / row.minimumQty : 0;
  if (row.currentQty <= 0) return { tone: "danger", label: "sin existencias" };
  if (ratio < 0.5) return { tone: "danger", label: "crítico" };
  return { tone: "warning", label: "bajo" };
}

const BELOW_MIN_COLUMNS: CocoaTableColumn<BelowMinRow>[] = [
  { key: "sku", label: "SKU", hideOnNarrow: true, render: (row) => row.sku ?? "—" },
  { key: "name", label: "Nombre", render: (row) => <strong>{row.name}</strong> },
  { key: "locationName", label: "Ubicación", hideOnNarrow: true, render: (row) => row.locationName ?? "—" },
  { key: "currentQty", label: "Actual", align: "right", render: (row) => fmtQty(row.currentQty) },
  { key: "minimumQty", label: "Mínimo", align: "right", render: (row) => fmtQty(row.minimumQty) },
  {
    key: "state",
    label: "Estado",
    render: (row) => {
      const level = belowMinLevel(row);
      return <CocoaBadge tone={level.tone}>{level.label}</CocoaBadge>;
    }
  }
];

const MOVEMENT_COLUMNS: CocoaTableColumn<MovementRow>[] = [
  { key: "at", label: "Cuándo", render: (row) => dateTime(row.at) },
  { key: "itemName", label: "Artículo", render: (row) => <strong>{row.itemName}</strong> },
  { key: "locationName", label: "Ubicación", hideOnNarrow: true, render: (row) => row.locationName ?? "—" },
  {
    key: "movementType",
    label: "Tipo",
    render: (row) => <CocoaBadge tone={MOVEMENT_TONE[row.movementType] ?? "info"}>{MOVEMENT_LABELS[row.movementType] ?? row.movementType}</CocoaBadge>
  },
  { key: "quantity", label: "Cant.", align: "right", render: (row) => fmtQty(row.quantity) }
];

// Mirror skeleton: strip of five KPI tiles, then the 8/4 and 6/6 rows.
function InventorySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[8, 4], [6, 6]]} />
    </div>
  );
}

export function InventoryDashboard() {
  const hosted = useTabHost() !== null;
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<InventoryDashboardData>(
    "/dashboards/inventory",
    { pollIntervalMs: 120000, query: { propertyId: PROPERTY_ID } }
  );

  const kpis: Kpis = data?.kpis ?? {
    itemsCount: 0,
    itemsBelowMin: 0,
    lowStockValueEur: 0,
    totalInventoryValueEur: 0,
    movementsLast30d: 0
  };
  const itemsBelowMinList = toArray<BelowMinRow>(data?.itemsBelowMinList);
  const topConsumed = toArray<ConsumedRow>(data?.topConsumed);
  const stockByLocation = toArray<LocationRow>(data?.stockByLocation);
  const recentMovements = toArray<MovementRow>(data?.recentMovements);

  const locationTotal = stockByLocation.reduce((sum, row) => sum + (Number.isFinite(row.valueEur) ? row.valueEur : 0), 0);
  const consumedBars: CocoaBarsDatum[] = topConsumed.map((row) => ({ label: row.name, value: row.consumedQty, tone: "accent" }));

  const belowMinStatus = kpis.itemsBelowMin === 0 ? "ok" : kpis.itemsBelowMin >= 5 ? "critical" : "warning";
  const state = loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`Operaciones · ${propertyName}`}
      title="Inventario operativo"
      subtitle={hosted ? undefined : "Vista de solo lectura sobre niveles de existencias, artículos bajo mínimo, valor del inventario y últimos movimientos. Refresca automáticamente cada 120 segundos."}
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
      skeleton={<InventorySkeleton />}
      error={{ title: UI_STATES.error.title, message: error ?? UI_STATES.error.message, onRetry: refresh }}
      commands={[{ id: "inventory-refresh", label: "Actualizar inventario", run: refresh }]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de inventario">
        <CocoaKpi label="Artículos activos" value={fmtNumber(kpis.itemsCount)} deltaLabel="catálogo" polarity="neutral" status="ok" />
        <CocoaKpi label="Bajo mínimo" value={fmtNumber(kpis.itemsBelowMin)} deltaLabel={belowMinStatus === "ok" ? "correcto" : "reponer"} polarity="neutral" status={belowMinStatus} />
        <CocoaKpi label="Valor bajo mínimo" value={money(kpis.lowStockValueEur)} deltaLabel="importe" polarity="neutral" status={kpis.lowStockValueEur > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Valor total del inventario" value={money(kpis.totalInventoryValueEur)} deltaLabel="importe" polarity="neutral" status="ok" />
        <CocoaKpi label="Movimientos (30 días)" value={fmtNumber(kpis.movementsLast30d)} deltaLabel="actividad" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Artículos bajo mínimo y existencias por ubicación">
        <CocoaSpan cols={8} min={480}>
          <CocoaSection
            title="Artículos bajo mínimo"
            meta={plural(itemsBelowMinList.length, "artículo", "artículos")}
            padding={itemsBelowMinList.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {itemsBelowMinList.length === 0 ? (
              <CocoaState kind="empty" inline title="Todos los artículos están por encima de su mínimo." />
            ) : (
              <CocoaTable columns={BELOW_MIN_COLUMNS} rows={itemsBelowMinList} rowKey="id" caption="Artículos bajo mínimo" aria-label="Artículos bajo mínimo" />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={4} min={320}>
          <CocoaSection title="Existencias por ubicación" meta={plural(stockByLocation.length, "ubicación", "ubicaciones")}>
            {stockByLocation.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin ubicaciones de existencias activas." />
            ) : (
              <ul className="c22-section__list" aria-label="Existencias por ubicación">
                {stockByLocation.map((row) => (
                  <li key={row.locationName}>
                    <span className="cocoa-cluster">
                      {row.locationName}
                      <CocoaBadge tone="neutral" size="small">
                        {plural(row.itemsCount, "artículo", "artículos")}
                      </CocoaBadge>
                      {locationTotal > 0 ? (
                        <CocoaBadge tone="info" size="small" variant="dot" title="Cuota del valor total">
                          {percent((row.valueEur / locationTotal) * 100)}
                        </CocoaBadge>
                      ) : null}
                    </span>
                    <strong>{money(row.valueEur)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start" aria-label="Consumo y movimientos">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Más consumidos" meta="Últimos 30 días">
            {topConsumed.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin consumo registrado en los últimos 30 días." />
            ) : (
              <>
                <CocoaChart.Bars data={consumedBars} height={160} valueFormat={fmtQty} aria-label="Artículos más consumidos en los últimos 30 días" />
                <ul className="c22-section__list" aria-label="Cantidad consumida por artículo">
                  {topConsumed.map((row) => (
                    <li key={row.id}>
                      <span>{row.name}</span>
                      <strong>{fmtQty(row.consumedQty)}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Movimientos recientes"
            meta={plural(recentMovements.length, "movimiento", "movimientos")}
            padding={recentMovements.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {recentMovements.length === 0 ? (
              <CocoaState kind="empty" inline title="Todavía no hay movimientos de existencias." />
            ) : (
              <CocoaTable columns={MOVEMENT_COLUMNS} rows={recentMovements} rowKey="id" density="compact" caption="Movimientos recientes" aria-label="Movimientos recientes" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}
