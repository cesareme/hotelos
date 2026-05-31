import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();

type Kpis = {
  itemsCount: number;
  itemsBelowMin: number;
  lowStockValueEur: number;
  totalInventoryValueEur: number;
  movementsLast30d: number;
};

type InventoryDashboardData = {
  kpis: Kpis;
  itemsBelowMinList: Array<{
    id: string;
    sku?: string;
    name: string;
    currentQty: number;
    minimumQty: number;
    locationName?: string;
  }>;
  topConsumed: Array<{ id: string; name: string; consumedQty: number }>;
  stockByLocation: Array<{ locationName: string; itemsCount: number; valueEur: number }>;
  recentMovements: Array<{
    id: string;
    itemName: string;
    movementType: string;
    quantity: number;
    at: string;
    locationName?: string;
  }>;
};

type StatusKind = "ok" | "warn" | "error" | "info";

const currencyFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true,
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2
});

const numberFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true });
const qtyFormatter = new Intl.NumberFormat("es-ES", { useGrouping: true,
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

function money(value: number | null | undefined): string {
  return currencyFormatter.format(Number.isFinite(value as number) ? (value as number) : 0);
}

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return numberFormatter.format(value);
}

function fmtQty(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return qtyFormatter.format(value);
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

function pill(kind: StatusKind, label: string) {
  return <span className={`bo-status ${kind}`}>{label}</span>;
}

function maxOf(values: number[]): number {
  let max = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

function barPercent(value: number, max: number): number {
  if (max <= 0) return 0;
  const pct = Math.round((value / max) * 100);
  return Math.max(0, Math.min(100, pct));
}

const MOVEMENT_LABELS: Record<string, string> = {
  receipt: "Receipt",
  in: "Inbound",
  purchase: "Purchase",
  transfer_in: "Transfer in",
  adjustment_in: "Adjust +",
  return: "Return",
  consumption: "Consumption",
  out: "Outbound",
  issue: "Issue",
  transfer_out: "Transfer out",
  adjustment_out: "Adjust −",
  loss: "Loss",
  waste: "Waste"
};

const MOVEMENT_KIND: Record<string, StatusKind> = {
  receipt: "ok",
  in: "ok",
  purchase: "ok",
  transfer_in: "info",
  adjustment_in: "info",
  return: "info",
  consumption: "warn",
  out: "warn",
  issue: "warn",
  transfer_out: "info",
  adjustment_out: "warn",
  loss: "error",
  waste: "error"
};

export function InventoryDashboard() {
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
  const itemsBelowMinList = data?.itemsBelowMinList ?? [];
  const topConsumed = data?.topConsumed ?? [];
  const stockByLocation = data?.stockByLocation ?? [];
  const recentMovements = data?.recentMovements ?? [];

  const consumedMax = maxOf(topConsumed.map((row) => row.consumedQty));
  const locationValueMax = maxOf(stockByLocation.map((row) => row.valueEur));

  const belowMinKind: StatusKind = kpis.itemsBelowMin === 0 ? "ok" : kpis.itemsBelowMin >= 5 ? "error" : "warn";
  const lowStockKind: StatusKind = kpis.lowStockValueEur > 0 ? "warn" : "ok";

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Operations · Inventory</div>
          <h1 className="bo-page-title">Inventario operativo</h1>
          <p className="bo-page-subtitle">
            Vista de solo lectura sobre niveles de stock, artículos bajo mínimo, valor del inventario y
            últimos movimientos. Refresca automáticamente cada 120 segundos.
          </p>
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">loading</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻ Refresh</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          Couldn't load this view right now. Refresh to retry.
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Active items</span>
            {pill("info", "catalog")}
          </div>
          <div className="rev-kpi-value">{fmtNumber(kpis.itemsCount)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${belowMinKind === "ok" ? "ok" : belowMinKind === "warn" ? "warn" : "error"}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Below minimum</span>
            {pill(belowMinKind, belowMinKind === "ok" ? "healthy" : "reorder")}
          </div>
          <div className="rev-kpi-value">{fmtNumber(kpis.itemsBelowMin)}</div>
        </article>
        <article className={`rev-kpi ${lowStockKind === "ok" ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Low-stock value</span>
            {pill(lowStockKind, "EUR")}
          </div>
          <div className="rev-kpi-value">{money(kpis.lowStockValueEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Total inventory value</span>
            {pill("ok", "EUR")}
          </div>
          <div className="rev-kpi-value">{money(kpis.totalInventoryValueEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Movements (30d)</span>
            {pill("info", "activity")}
          </div>
          <div className="rev-kpi-value">{fmtNumber(kpis.movementsLast30d)}</div>
        </article>
      </section>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Items below minimum</h3>
          <span className="bo-chip">{itemsBelowMinList.length} items</span>
        </div>
        {itemsBelowMinList.length === 0 ? (
          <p className="bo-muted">All items above their minimum level.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Location</th>
                <th>Current</th>
                <th>Min</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {itemsBelowMinList.map((row) => {
                const ratio = row.minimumQty > 0 ? row.currentQty / row.minimumQty : 0;
                const kind: StatusKind = row.currentQty <= 0 ? "error" : ratio < 0.5 ? "error" : "warn";
                const label = row.currentQty <= 0 ? "out of stock" : ratio < 0.5 ? "critical" : "low";
                return (
                  <tr key={row.id}>
                    <td><code>{row.sku ?? "—"}</code></td>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.locationName ?? "—"}</td>
                    <td>{fmtQty(row.currentQty)}</td>
                    <td>{fmtQty(row.minimumQty)}</td>
                    <td>{pill(kind, label)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Top consumed (last 30 days)</h3>
          <span className="bo-chip">{topConsumed.length} items</span>
        </div>
        {topConsumed.length === 0 ? (
          <p className="bo-muted">No consumption recorded in the last 30 days.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Consumed</th>
                <th style={{ width: "55%" }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {topConsumed.map((row) => {
                const pct = barPercent(row.consumedQty, consumedMax);
                return (
                  <tr key={row.id}>
                    <td><strong>{row.name}</strong></td>
                    <td>{fmtQty(row.consumedQty)}</td>
                    <td>
                      <div style={{ background: "var(--surface)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 6, overflow: "hidden", height: 12 }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: "var(--ink)", opacity: 0.55 }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Stock by location</h3>
          <span className="bo-chip">{stockByLocation.length} locations</span>
        </div>
        {stockByLocation.length === 0 ? (
          <p className="bo-muted">No active stock locations.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Location</th>
                <th>Items</th>
                <th>Value</th>
                <th style={{ width: "45%" }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {stockByLocation.map((row) => {
                const pct = barPercent(row.valueEur, locationValueMax);
                return (
                  <tr key={row.locationName}>
                    <td><strong>{row.locationName}</strong></td>
                    <td>{fmtNumber(row.itemsCount)}</td>
                    <td>{money(row.valueEur)}</td>
                    <td>
                      <div style={{ background: "var(--surface)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 6, overflow: "hidden", height: 12 }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: "var(--ink)", opacity: 0.55 }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Recent movements</h3>
          <span className="bo-chip">{recentMovements.length} entries</span>
        </div>
        {recentMovements.length === 0 ? (
          <p className="bo-muted">No stock movements recorded yet.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Item</th>
                <th>Location</th>
                <th>Type</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {recentMovements.map((row) => {
                const kind = MOVEMENT_KIND[row.movementType] ?? "info";
                const label = MOVEMENT_LABELS[row.movementType] ?? row.movementType;
                return (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.at)}</td>
                    <td><strong>{row.itemName}</strong></td>
                    <td>{row.locationName ?? "—"}</td>
                    <td>{pill(kind, label)}</td>
                    <td>{fmtQty(row.quantity)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </article>
    </>
  );
}
