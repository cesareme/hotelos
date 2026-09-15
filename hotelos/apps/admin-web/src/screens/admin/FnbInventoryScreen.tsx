// F&B inventory — Operaciones › Punto de venta › Existencias
// (/operaciones/tpv/existencias): live stock balances and the POS menu with
// its recipes (BOM). Closing a ticket deducts the ingredients automatically.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, dashboard archetype): CocoaPage with
// two inner views (`tabs`: Stock · Carta — hosted they paint as a segmented
// control under the container head) → KPI strip → CocoaTable of balances, or
// one CocoaSection per outlet whose items expand their recipe in place.
// Endpoints and polling (60 s) are the legacy ones.

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import type { StockBalance, MenuItem, MenuRecipe } from "../../services/fnbInventoryApi";
import { fetchMenuItemDetail } from "../../services/fnbInventoryApi";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { money, number, percent, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
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

function fmtNum(n: number): string {
  return number(n, { maximumFractionDigits: 3 });
}

/** «out_restaurant» → «Restaurant» (outlet ids are synthetic; the menu endpoint carries no outlet name). */
function outletTitle(outletId: string): string {
  return outletId.replace(/^out_/, "").replace(/^./, (c) => c.toUpperCase());
}

type Tab = "stock" | "menu";

// Named text styles (rule 6: fonts and colours never inside a `style={{…}}` literal).
const monoStyle: CSSProperties = { fontFamily: "var(--cocoa-font-mono)" };
const priceStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap"
};
const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };
const itemButtonStyle: CSSProperties = { justifyContent: "flex-start", minWidth: 0, flex: "1 1 auto" };
const recipeStyle: CSSProperties = { paddingLeft: "var(--cocoa-space-4)" };

const STOCK_COLUMNS: CocoaTableColumn<StockBalance>[] = [
  { key: "name", label: "Referencia", render: (s) => <strong>{s.name}</strong> },
  { key: "category", label: "Categoría", hideOnNarrow: true, render: (s) => s.category ?? "—" },
  { key: "sku", label: "SKU", hideOnNarrow: true, render: (s) => (s.sku ? <span style={monoStyle}>{s.sku}</span> : "—") },
  { key: "unit", label: "Unidad", hideOnNarrow: true },
  { key: "minLevel", label: "Mín.", align: "right", render: (s) => (s.minLevel != null ? fmtNum(s.minLevel) : "—") },
  {
    key: "onHand",
    label: "En stock",
    align: "right",
    render: (s) => (
      <>
        <strong>{fmtNum(s.onHand)}</strong> {s.unit}
      </>
    )
  },
  {
    key: "lowStock",
    label: FIELD_LABELS.status,
    render: (s) => (s.lowStock ? <CocoaBadge tone="warning">stock bajo</CocoaBadge> : <CocoaBadge tone="success">OK</CocoaBadge>)
  }
];

export function FnbInventoryScreen() {
  const hosted = useTabHost() !== null;
  const propertyName = getActiveProperty().propertyName;
  const balances = useApiData<{ items: StockBalance[] }>(`/properties/${PROPERTY_ID}/stock-balances`, { pollIntervalMs: 60000 });
  const menus = useApiData<{ items: MenuItem[] }>(`/properties/${PROPERTY_ID}/menu-items`, { pollIntervalMs: 60000 });

  const [tab, setTab] = useState<Tab>("stock");
  const [expandedMenuId, setExpandedMenuId] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<Record<string, MenuRecipe[]>>({});
  const [loadingRecipe, setLoadingRecipe] = useState<string | null>(null);

  const stockItems = useMemo(() => toArray<StockBalance>(balances.data?.items), [balances.data]);
  const menuItems = useMemo(() => toArray<MenuItem>(menus.data?.items), [menus.data]);

  const lowStockCount = useMemo(() => stockItems.filter((s) => s.lowStock).length, [stockItems]);
  const totalItems = stockItems.length;

  // Group menu by outlet
  const menuByOutlet = useMemo(() => {
    const m = new Map<string, MenuItem[]>();
    for (const item of menuItems) {
      const arr = m.get(item.outletId) ?? [];
      arr.push(item);
      m.set(item.outletId, arr);
    }
    return m;
  }, [menuItems]);

  async function toggleMenuDetail(id: string) {
    if (expandedMenuId === id) {
      setExpandedMenuId(null);
      return;
    }
    setExpandedMenuId(id);
    if (!recipes[id]) {
      setLoadingRecipe(id);
      try {
        const detail = await fetchMenuItemDetail(id);
        setRecipes((prev) => ({ ...prev, [id]: detail.recipes }));
      } catch {
        setRecipes((prev) => ({ ...prev, [id]: [] }));
      } finally {
        setLoadingRecipe(null);
      }
    }
  }

  const refreshAll = () => {
    balances.refresh();
    menus.refresh();
  };
  const anyLoading = balances.loading || menus.loading;

  let stockBody;
  if (balances.loading && stockItems.length === 0) {
    stockBody = <CocoaTable columns={STOCK_COLUMNS} rows={[]} loading aria-label="Existencias" />;
  } else if (balances.error && stockItems.length === 0) {
    stockBody = <CocoaState kind="error" title="No se pudo cargar" message={balances.error} onRetry={balances.refresh} />;
  } else if (stockItems.length === 0) {
    stockBody = <CocoaState kind="empty" illustration="box" title="Sin inventario" message="No hay referencias en stock." />;
  } else {
    stockBody = <CocoaTable columns={STOCK_COLUMNS} rows={stockItems} rowKey="inventoryItemId" caption="Existencias" aria-label="Existencias" />;
  }
  const stockTableReady = stockItems.length > 0 || (balances.loading && stockItems.length === 0);

  return (
    <CocoaPage
      eyebrow={`Operaciones · ${propertyName}`}
      title="Existencias y carta"
      subtitle={hosted ? undefined : "Existencias en vivo y carta del TPV con sus recetas. Al cerrar una comanda, el motor descuenta automáticamente los ingredientes consumidos."}
      tabs={[
        { value: "stock", label: `Stock · ${number(totalItems)}` },
        { value: "menu", label: `Carta · ${number(menuItems.length)}` }
      ]}
      activeTab={tab}
      onTabChange={(value) => setTab(value === "menu" ? "menu" : "stock")}
      actions={
        <>
          {anyLoading && (stockItems.length > 0 || menuItems.length > 0) ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "fnb-inventory-refresh", label: "Actualizar existencias y carta", run: refreshAll },
        { id: "fnb-inventory-stock", label: "Ver existencias", run: () => setTab("stock") },
        { id: "fnb-inventory-menu", label: "Ver carta con recetas", run: () => setTab("menu") }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Resumen de existencias">
        <CocoaKpi label="Referencias en stock" value={totalItems} deltaLabel="activas" polarity="neutral" status="ok" />
        <CocoaKpi label="Stock bajo" value={lowStockCount} deltaLabel={lowStockCount > 0 ? "reponer" : "OK"} polarity="neutral" status={lowStockCount > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Platos / bebidas" value={menuItems.length} deltaLabel="en carta" polarity="neutral" status="ok" />
        <CocoaKpi label="Puntos de venta" value={menuByOutlet.size} deltaLabel="distintos" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      {tab === "stock" ? (
        <CocoaSection
          title="Existencias"
          meta={stockItems.length > 0 ? `${plural(stockItems.length, "referencia", "referencias")}${lowStockCount > 0 ? ` · ${lowStockCount} bajo mínimo` : ""}` : undefined}
          padding={stockTableReady ? "none" : "md"}
          style={{ overflow: "clip" }}
          aria-label="Existencias"
        >
          {stockBody}
        </CocoaSection>
      ) : menus.loading && menuItems.length === 0 ? (
        <CocoaSkeleton variant="card" />
      ) : menus.error && menuItems.length === 0 ? (
        <CocoaSection aria-label="Carta">
          <CocoaState kind="error" title="No se pudo cargar la carta" message={menus.error} onRetry={menus.refresh} />
        </CocoaSection>
      ) : menuItems.length === 0 ? (
        <CocoaSection aria-label="Carta">
          <CocoaState kind="empty" illustration="box" title="Sin carta" message="Aún no hay platos ni bebidas configurados." />
        </CocoaSection>
      ) : (
        [...menuByOutlet.entries()].map(([outletId, items]) => (
          <CocoaSection key={outletId} title={outletTitle(outletId)} meta={plural(items.length, "item", "items")}>
            <ul className="c22-section__list" aria-label={`Carta de ${outletTitle(outletId)}`}>
              {items.map((it) => {
                const open = expandedMenuId === it.id;
                const recipe = recipes[it.id];
                const panelId = `fnb-recipe-${it.id}`;
                return (
                  <li key={it.id}>
                    <div className="cocoa-stack" data-gap="2" style={growStyle}>
                      <div className="cocoa-row" data-gap="2" data-justify="between">
                        <CocoaButton variant="plain" tone={open ? "accent" : "neutral"} size="small" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => void toggleMenuDetail(it.id)} style={itemButtonStyle}>
                          {it.name}
                        </CocoaButton>
                        <span className="cocoa-cluster">
                          {it.category ? (
                            <CocoaBadge tone="neutral" size="small">
                              {it.category}
                            </CocoaBadge>
                          ) : null}
                          <span style={priceStyle}>
                            {money(it.price)}
                            {it.taxRate ? ` · ${percent(it.taxRate)} IVA` : ""}
                          </span>
                        </span>
                      </div>
                      {open ? (
                        <div id={panelId} style={recipeStyle}>
                          {loadingRecipe === it.id ? (
                            <CocoaState kind="loading" inline />
                          ) : !recipe || recipe.length === 0 ? (
                            <CocoaState kind="empty" inline title="Sin receta configurada — la venta no descontará stock." />
                          ) : (
                            <ul className="c22-section__list" aria-label={`Receta de ${it.name}`}>
                              {recipe.map((r) => (
                                <li key={r.id}>
                                  <span>Ingrediente {r.inventoryItemId.slice(-6)}</span>
                                  <strong>{fmtNum(r.quantity)}</strong>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CocoaSection>
        ))
      )}
    </CocoaPage>
  );
}
