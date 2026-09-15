import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { STATUS_LABELS, UI_STATES } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { dateTime, money, number } from "../../lib/format";

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

function fmtNumber(value: number | null | undefined): string {
  return number(value, { maximumFractionDigits: 0 });
}

function fmtQty(value: number | null | undefined): string {
  return number(value);
}

function formatDateTime(value?: string): string {
  return dateTime(value);
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
  const hosted = useTabHost() !== null;
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
      <div className="bo-page-head" style={hosted ? { justifyContent: "flex-end" } : undefined}>
        {hosted ? null : (
          <div className="bo-page-head-text">
            <div className="bo-page-eyebrow">Operaciones · Inventario</div>
            <h1 className="bo-page-title">Inventario operativo</h1>
            <p className="bo-page-subtitle">
              Vista de solo lectura sobre niveles de existencias, artículos bajo mínimo, valor del inventario y
              últimos movimientos. Refresca automáticamente cada 120 segundos.
            </p>
          </div>
        )}
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">{STATUS_LABELS.loading}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻ Actualizar</button>
        </div>
      </div>

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }} role="alert">
          <strong>{UI_STATES.error.title}.</strong> {UI_STATES.error.message}
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Artículos activos</span>
            {pill("info", "catálogo")}
          </div>
          <div className="rev-kpi-value">{fmtNumber(kpis.itemsCount)}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${belowMinKind === "ok" ? "ok" : belowMinKind === "warn" ? "warn" : "error"}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Bajo mínimo</span>
            {pill(belowMinKind, belowMinKind === "ok" ? "correcto" : "reponer")}
          </div>
          <div className="rev-kpi-value">{fmtNumber(kpis.itemsBelowMin)}</div>
        </article>
        <article className={`rev-kpi ${lowStockKind === "ok" ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Valor bajo mínimo</span>
            {pill(lowStockKind, "importe")}
          </div>
          <div className="rev-kpi-value">{money(kpis.lowStockValueEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Valor total del inventario</span>
            {pill("ok", "importe")}
          </div>
          <div className="rev-kpi-value">{money(kpis.totalInventoryValueEur)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Movimientos (30 días)</span>
            {pill("info", "actividad")}
          </div>
          <div className="rev-kpi-value">{fmtNumber(kpis.movementsLast30d)}</div>
        </article>
      </section>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Artículos bajo mínimo</h3>
          <span className="bo-chip">{itemsBelowMinList.length} items</span>
        </div>
        {itemsBelowMinList.length === 0 ? (
          <p className="bo-muted">Todos los artículos están por encima de su mínimo.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Ubicación</th>
                <th>Actual</th>
                <th>Mínimo</th>
                <th>Estado</th>
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
          <h3 style={{ color: "var(--ink)" }}>Más consumidos (últimos 30 días)</h3>
          <span className="bo-chip">{topConsumed.length} items</span>
        </div>
        {topConsumed.length === 0 ? (
          <p className="bo-muted">Sin consumo registrado en los últimos 30 días.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Artículo</th>
                <th>Consumido</th>
                <th style={{ width: "55%" }}>Cuota</th>
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
          <h3 style={{ color: "var(--ink)" }}>Existencias por ubicación</h3>
          <span className="bo-chip">{stockByLocation.length} locations</span>
        </div>
        {stockByLocation.length === 0 ? (
          <p className="bo-muted">Sin ubicaciones de existencias activas.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Ubicación</th>
                <th>Artículos</th>
                <th>Valor</th>
                <th style={{ width: "45%" }}>Cuota</th>
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
          <h3 style={{ color: "var(--ink)" }}>Movimientos recientes</h3>
          <span className="bo-chip">{recentMovements.length} entries</span>
        </div>
        {recentMovements.length === 0 ? (
          <p className="bo-muted">Todavía no hay movimientos de existencias.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Artículo</th>
                <th>Ubicación</th>
                <th>Tipo</th>
                <th>Cant.</th>
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
