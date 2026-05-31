import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import type { StockBalance, MenuItem, MenuRecipe } from "../../services/fnbInventoryApi";
import { fetchMenuItemDetail } from "../../services/fnbInventoryApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

function fmtNum(n: number): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 3 }).format(n);
}

type Tab = "stock" | "menu";

export function FnbInventoryScreen() {
  const balances = useApiData<{ items: StockBalance[] }>(`/properties/${PROPERTY_ID}/stock-balances`, { pollIntervalMs: 60000 });
  const menus = useApiData<{ items: MenuItem[] }>(`/properties/${PROPERTY_ID}/menu-items`, { pollIntervalMs: 60000 });

  const [tab, setTab] = useState<Tab>("stock");
  const [expandedMenuId, setExpandedMenuId] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<Record<string, MenuRecipe[]>>({});
  const [loadingRecipe, setLoadingRecipe] = useState<string | null>(null);

  const stockItems = balances.data?.items ?? [];
  const menuItems = menus.data?.items ?? [];

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
    if (expandedMenuId === id) { setExpandedMenuId(null); return; }
    setExpandedMenuId(id);
    if (!recipes[id]) {
      setLoadingRecipe(id);
      try {
        const detail = await fetchMenuItemDetail(id);
        setRecipes((prev) => ({ ...prev, [id]: detail.recipes }));
      } catch {
        setRecipes((prev) => ({ ...prev, [id]: [] }));
      } finally { setLoadingRecipe(null); }
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>F&B · Inventario</p>
          <h2 style={{ color: "var(--ink)" }}>Inventario y carta</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Stock en vivo + carta del TPV con sus recetas (BOM). Al cerrar una comanda, el motor descuenta
            automáticamente los ingredientes consumidos.
          </p>
        </div>
        <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
          {(balances.loading || menus.loading) ? <Spinner size="sm" /> : null}
          <button type="button" onClick={() => { balances.refresh(); menus.refresh(); }}>↻ Actualizar</button>
        </div>
      </header>

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Referencias en stock</span><span className="bo-status info">activas</span></div><div className="rev-kpi-value">{totalItems}</div></article>
        <article className={`rev-kpi rev-kpi-${lowStockCount > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Stock bajo</span><span className={`bo-status ${lowStockCount > 0 ? "warn" : "ok"}`}>{lowStockCount > 0 ? "reponer" : "OK"}</span></div><div className="rev-kpi-value">{lowStockCount}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Platos / bebidas</span><span className="bo-status info">en carta</span></div><div className="rev-kpi-value">{menuItems.length}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Puntos de venta</span><span className="bo-status info">distintos</span></div><div className="rev-kpi-value">{menuByOutlet.size}</div></article>
      </div>

      <div className="bo-row" style={{ gap: 6, borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }} role="tablist">
        <button type="button" role="tab" aria-selected={tab === "stock"} className={tab === "stock" ? "primary" : ""} style={{ borderRadius: 999 }} onClick={() => setTab("stock")}>Stock {lowStockCount > 0 ? <span className="bo-status warn" style={{ fontSize: 10, marginLeft: 6 }}>{lowStockCount}</span> : null}</button>
        <button type="button" role="tab" aria-selected={tab === "menu"} className={tab === "menu" ? "primary" : ""} style={{ borderRadius: 999 }} onClick={() => setTab("menu")}>Carta · {menuItems.length}</button>
      </div>

      {tab === "stock" ? (
        balances.loading && stockItems.length === 0 ? <LoadingBlock label="Cargando inventario…" />
        : balances.error ? <ErrorState title="No se pudo cargar" message={balances.error} onRetry={balances.refresh} />
        : stockItems.length === 0 ? <EmptyState title="Sin inventario" message="No hay referencias en stock." />
        : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead><tr><th>Referencia</th><th>Categoría</th><th>SKU</th><th>Unidad</th><th>Mín.</th><th>En stock</th><th>Estado</th></tr></thead>
              <tbody>
                {stockItems.map((s) => (
                  <tr key={s.inventoryItemId} style={s.lowStock ? { background: "var(--surface-alt, rgba(245,158,11,.08))" } : undefined}>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.category ?? "—"}</td>
                    <td className="mono">{s.sku ?? "—"}</td>
                    <td>{s.unit}</td>
                    <td>{s.minLevel ?? "—"}</td>
                    <td><strong>{fmtNum(s.onHand)}</strong> {s.unit}</td>
                    <td>{s.lowStock ? <span className="bo-status warn">stock bajo</span> : <span className="bo-status ok">OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        menus.loading && menuItems.length === 0 ? <LoadingBlock label="Cargando carta…" />
        : menuItems.length === 0 ? <EmptyState title="Sin carta" message="Aún no hay platos ni bebidas configurados." />
        : (
          <div className="bo-stack" style={{ gap: 12 }}>
            {[...menuByOutlet.entries()].map(([outletId, items]) => (
              <article key={outletId} className="bo-card" style={{ background: "var(--surface)" }}>
                <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>{outletId.replace(/^out_/, "").replace(/^./, (c) => c.toUpperCase())}</h3><span className="bo-chip">{items.length}</span></div>
                <div className="bo-stack" style={{ gap: 6 }}>
                  {items.map((it) => {
                    const open = expandedMenuId === it.id;
                    const recipe = recipes[it.id];
                    return (
                      <div key={it.id} style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 6 }}>
                        <div
                          role="button"
                          tabIndex={0}
                          aria-expanded={open}
                          aria-label={`${open ? "Contraer" : "Expandir"} receta de ${it.name}`}
                          onClick={() => toggleMenuDetail(it.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void toggleMenuDetail(it.id);
                            }
                          }}
                          style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                        >
                          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <strong style={{ color: "var(--ink)" }}>{it.name}</strong>
                            {it.category ? <span className="bo-muted" style={{ fontSize: 11 }}>{it.category}</span> : null}
                          </span>
                          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span className="bo-muted" style={{ fontSize: 12 }}>{fmtNum(it.price)} €{it.taxRate ? ` · ${it.taxRate}% IVA` : ""}</span>
                            <span className="bo-muted" aria-hidden>{open ? "▾" : "▸"}</span>
                          </span>
                        </div>
                        {open ? (
                          <div style={{ marginTop: 6, paddingLeft: 16, fontSize: 13 }}>
                            {loadingRecipe === it.id ? <span className="bo-muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner size="sm" /> Cargando receta…</span>
                              : !recipe || recipe.length === 0 ? <span className="bo-muted">Sin receta configurada — la venta no descontará stock.</span>
                              : (
                                <table className="bo-table" style={{ marginTop: 4 }}><tbody>
                                  {recipe.map((r) => (
                                    <tr key={r.id}><td>Ingrediente {r.inventoryItemId.slice(-6)}</td><td style={{ textAlign: "right" }}>{fmtNum(r.quantity)}</td></tr>
                                  ))}
                                </tbody></table>
                              )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>
        )
      )}
    </section>
  );
}
