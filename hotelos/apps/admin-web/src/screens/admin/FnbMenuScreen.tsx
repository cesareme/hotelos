// F&B Menu management — carta por outlet (Restaurante / Bar / Room service / Spa).
//
// Real endpoints:
//   GET  /properties/:propertyId/pos/outlets        — listar puntos de venta
//   GET  /properties/:propertyId/menu-items         — listar items
//   POST /properties/:propertyId/menu-items         — crear item
//
// Modelo: `MenuItem` (apps/api · packages/database/prisma/schema.prisma).
// Cada MenuItem pertenece a un outletId. Al venderse desde POS, el motor
// descuenta su receta de los InventoryItems vinculados (BOM).
// FnbInventoryScreen ya muestra el stock + BOM; ESTA pantalla es el catálogo
// editable de la carta (alta de items).

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { createMenuItem, type MenuItem } from "../../services/fnbInventoryApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();

type PosOutlet = { id: string; name: string; category: string };

const OUTLET_ICON: Record<string, string> = {
  restaurant: "🍽",
  bar: "🍷",
  cafe: "☕",
  roomservice: "🛎",
  spa: "🧖",
  default: "•"
};

const CATEGORY_PRESETS: Record<string, string[]> = {
  restaurant: ["Entrantes", "Principales", "Carnes", "Pescados", "Pastas", "Postres", "Vinos", "Menú del día"],
  bar: ["Bebidas", "Cócteles", "Cervezas", "Vinos", "Tapas", "Aperitivos"],
  cafe: ["Café", "Té", "Pastelería", "Sándwiches", "Zumos"],
  roomservice: ["Desayunos", "Snacks", "Bebidas", "Cenas", "Postres"],
  spa: ["Tratamientos", "Masajes", "Rituales", "Bebidas wellness"]
};

const TAX_RATES = [
  { v: 10, label: "10% (alimentación, restauración)" },
  { v: 21, label: "21% (general, bebidas alcohólicas)" },
  { v: 4, label: "4% (superreducido, pan/leche)" },
  { v: 0, label: "0% (exento)" }
];

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
}

type Draft = {
  outletId: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  taxRate: string;
  stockControlled: boolean; // sólo afecta a la presentación / TODO backend
};

function emptyDraft(outletId: string): Draft {
  return {
    outletId,
    sku: "",
    name: "",
    category: "",
    price: "",
    taxRate: "10",
    stockControlled: false
  };
}

export function FnbMenuScreen() {
  const { showToast } = useToast();
  const outlets = useApiData<PosOutlet[]>(`/properties/${PROPERTY_ID}/pos/outlets`, { pollIntervalMs: 0 });
  const menus = useApiData<{ items: MenuItem[] }>(`/properties/${PROPERTY_ID}/menu-items`, { pollIntervalMs: 30000 });

  const outletList = toArray<PosOutlet>(outlets.data);
  const allItems = menus.data?.items ?? [];

  const [activeOutletId, setActiveOutletId] = useState<string | null>(null);
  const currentOutletId = activeOutletId ?? outletList[0]?.id ?? null;

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  // Agrupar por outlet
  const byOutlet = useMemo(() => {
    const m = new Map<string, MenuItem[]>();
    for (const it of allItems) {
      const arr = m.get(it.outletId) ?? [];
      arr.push(it);
      m.set(it.outletId, arr);
    }
    return m;
  }, [allItems]);

  const currentItems = currentOutletId ? byOutlet.get(currentOutletId) ?? [] : [];

  function openCreate() {
    if (!currentOutletId) return;
    setDraft(emptyDraft(currentOutletId));
    setShowForm(true);
    setMsg(null);
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { setMsg("El nombre es obligatorio."); return; }
    if (!draft.outletId) { setMsg("Selecciona un punto de venta."); return; }
    const price = Number(draft.price);
    if (!draft.price.trim() || Number.isNaN(price) || price < 0) {
      setMsg("El precio es obligatorio y no puede ser negativo.");
      return;
    }
    setBusy(true); setMsg(null);
    try {
      await createMenuItem({
        outletId: draft.outletId,
        sku: draft.sku.trim() || undefined,
        name: draft.name.trim(),
        category: draft.category.trim() || undefined,
        price,
        taxRate: draft.taxRate ? Number(draft.taxRate) : undefined
      });
      setMsg(`Item «${draft.name}» creado.`);
      showToast(`Item «${draft.name}» añadido a la carta`, { variant: "success" });
      setShowForm(false);
      setDraft(null);
      menus.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo crear el item.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function outletKey(id: string): string {
    // out_restaurant → restaurant
    return id.replace(/^out_/, "");
  }
  function outletIcon(id: string): string {
    return OUTLET_ICON[outletKey(id)] ?? OUTLET_ICON.default;
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>F&B · Carta</p>
          <h2 style={{ color: "var(--ink)" }}>Cartas de Restauración (F&B)</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Catálogo de platos y bebidas por punto de venta. Cada item tiene precio, IVA y opcionalmente
            una receta (BOM) que descuenta stock al cerrar la comanda (ver{" "}
            <strong>Inventario F&amp;B</strong>).
          </p>
        </div>
        <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
          {(outlets.loading || menus.loading || busy) ? <Spinner size="sm" /> : null}
          <button type="button" onClick={() => { outlets.refresh(); menus.refresh(); }}>↻ Actualizar</button>
          <button type="button" className="primary" onClick={openCreate} disabled={busy || !currentOutletId}>+ Nuevo item</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {/* KPIs */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Puntos de venta</span><span className="bo-status info">activos</span></div>
          <div className="rev-kpi-value">{outletList.length}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Items en carta</span><span className="bo-status info">total</span></div>
          <div className="rev-kpi-value">{allItems.length}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Items activos</span><span className="bo-status ok">en venta</span></div>
          <div className="rev-kpi-value">{allItems.filter((i) => i.active).length}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Precio medio</span><span className="bo-status info">€/item</span></div>
          <div className="rev-kpi-value">{allItems.length > 0 ? fmtMoney(allItems.reduce((s, i) => s + Number(i.price), 0) / allItems.length) : "—"}</div>
        </article>
      </div>

      {/* Tabs por outlet */}
      {outlets.loading && outletList.length === 0 ? (
        <LoadingBlock label="Cargando puntos de venta…" />
      ) : outlets.error ? (
        <ErrorState title="No se pudieron cargar los outlets" message={outlets.error} onRetry={outlets.refresh} />
      ) : outletList.length === 0 ? (
        <EmptyState title="Sin puntos de venta" message="Esta propiedad no tiene outlets configurados todavía." />
      ) : (
        <>
          <div className="bo-row" style={{ gap: 6, borderBottom: "1px solid var(--line-soft)", paddingBottom: 8, flexWrap: "wrap" }} role="tablist">
            {outletList.map((o) => {
              const itemCount = (byOutlet.get(o.id) ?? []).length;
              const active = currentOutletId === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={active ? "primary" : ""}
                  style={{ borderRadius: 999 }}
                  onClick={() => setActiveOutletId(o.id)}
                >
                  <span aria-hidden style={{ marginRight: 4 }}>{outletIcon(o.id)}</span>
                  {o.name}
                  <span className="bo-chip" style={{ marginLeft: 6, fontSize: 11 }}>{itemCount}</span>
                </button>
              );
            })}
          </div>

          {/* Tabla items del outlet activo */}
          {menus.loading && allItems.length === 0 ? (
            <LoadingBlock label="Cargando carta…" />
          ) : menus.error ? (
            <ErrorState title="No se pudo cargar la carta" message={menus.error} onRetry={menus.refresh} />
          ) : currentItems.length === 0 ? (
            <EmptyState
              title={`Sin items en ${outletList.find((o) => o.id === currentOutletId)?.name ?? "este outlet"}`}
              message="Crea el primer plato o bebida para que aparezca en el TPV."
              actions={<button type="button" className="primary" onClick={openCreate} disabled={busy}>+ Nuevo item</button>}
            />
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Categoría</th>
                    <th>SKU</th>
                    <th style={{ textAlign: "right" }}>Precio</th>
                    <th>IVA</th>
                    <th>Control de stock</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {currentItems.map((it) => (
                    <tr key={it.id}>
                      <td><strong>{it.name}</strong></td>
                      <td>{it.category ?? <span className="bo-muted">—</span>}</td>
                      <td className="mono">{it.sku ?? <span className="bo-muted">—</span>}</td>
                      <td style={{ textAlign: "right" }}><strong>{fmtMoney(Number(it.price))}</strong></td>
                      <td>{it.taxRate != null ? `${it.taxRate}%` : <span className="bo-muted">—</span>}</td>
                      <td>
                        {/* Control de stock = tiene receta. Lo deducimos: no podemos saberlo sin
                            llamar a /menu-items/:id. Mostramos un placeholder visual. */}
                        <span className="bo-muted" style={{ fontSize: 12 }} title="Ver detalle en Inventario F&B">
                          Ver detalle
                        </span>
                      </td>
                      <td>
                        <span className={`bo-status ${it.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>
                          {it.active ? "activo" : "inactivo"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Form alta item */}
      {showForm && draft ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)", margin: 0 }}>Nuevo item de carta</h3>
            <button type="button" onClick={() => { setShowForm(false); setDraft(null); }}>✕</button>
          </div>
          <div className="bo-grid two" style={{ gap: 10 }}>
            <label className="bo-form-field">
              <span>Punto de venta *</span>
              <select value={draft.outletId} onChange={(e) => setDraft((d) => d ? { ...d, outletId: e.target.value } : d)} disabled={busy}>
                {outletList.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Categoría</span>
              <input
                list="fnb-categories"
                value={draft.category}
                onChange={(e) => setDraft((d) => d ? { ...d, category: e.target.value } : d)}
                placeholder="Ej. Principales"
                disabled={busy}
              />
              <datalist id="fnb-categories">
                {(CATEGORY_PRESETS[outletKey(draft.outletId)] ?? []).map((c) => <option key={c} value={c} />)}
              </datalist>
            </label>
            <label className="bo-form-field" style={{ gridColumn: "1 / -1" }}>
              <span>Nombre *</span>
              <input value={draft.name} onChange={(e) => setDraft((d) => d ? { ...d, name: e.target.value } : d)} placeholder="Ej. Tarta de queso con frutos rojos" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>SKU / código</span>
              <input value={draft.sku} onChange={(e) => setDraft((d) => d ? { ...d, sku: e.target.value } : d)} placeholder="RST-DES-001" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Precio *</span>
              <input type="number" min={0} step={0.01} value={draft.price} onChange={(e) => setDraft((d) => d ? { ...d, price: e.target.value } : d)} placeholder="6.50" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>IVA aplicable</span>
              <select value={draft.taxRate} onChange={(e) => setDraft((d) => d ? { ...d, taxRate: e.target.value } : d)} disabled={busy}>
                {TAX_RATES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Control de stock (BOM)</span>
              <input
                type="checkbox"
                checked={draft.stockControlled}
                onChange={(e) => setDraft((d) => d ? { ...d, stockControlled: e.target.checked } : d)}
                disabled={busy}
              />
              <span className="bo-muted" style={{ fontSize: 11 }}>
                Si activas el control, después define la receta en{" "}
                <strong>Inventario F&amp;B</strong> para descontar ingredientes al cerrar la comanda.
              </span>
            </label>
          </div>
          <div className="bo-actions" style={{ marginTop: 10 }}>
            <button type="button" className="primary" onClick={save} disabled={busy}>Crear item</button>
            <button type="button" onClick={() => { setShowForm(false); setDraft(null); }} disabled={busy}>Cancelar</button>
          </div>
        </article>
      ) : null}
    </section>
  );
}
