// F&B Menu management — Operaciones › Punto de venta › Cartas
// (/operaciones/tpv/cartas): carta por outlet (Restaurante / Bar / Room service / Spa).
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
//
// Cocoa 22 (docs/design/COCOA-22.md §4, dashboard archetype): CocoaPage →
// KPI strip → outlet tabs (CocoaButton role="tab" in a content toolbar; more
// than four outlets and a count badge per tab, so not a CocoaSegmentedControl,
// but the same WAI-ARIA contract: roving tabindex, arrows / Home / End move
// AND select, `aria-controls` → the labelled tabpanel; QA #18) → CocoaTable
// of the active outlet → «Nuevo item» in a CocoaDrawer with a CocoaFormRow
// (category presets as chips instead of a datalist).

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTabHost } from "../tabs/TabHost";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { createMenuItem, type MenuItem } from "../../services/fnbInventoryApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { money, percent, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  nextSegmentValue,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type PosOutlet = { id: string; name: string; category: string };

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
const TAX_OPTIONS = TAX_RATES.map((t) => ({ value: String(t.v), label: t.label }));

const NEW_ITEM_LABEL = "Nuevo item";

type Draft = {
  outletId: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  taxRate: string;
  stockControlled: boolean; // presentation only until the backend stores it
};

type DraftErrors = Partial<Record<"outletId" | "name" | "price", string>>;

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

function outletKey(id: string): string {
  // out_restaurant → restaurant
  return id.replace(/^out_/, "");
}

/** Existencias tab of the same container: stock and recipes of every item. */
function openStock() {
  const url = urlForScreen("FnbInventory");
  if (url) openTabPath(url);
}

// SKU cells in the monospaced face (named object: rule 6 keeps fonts out of literals).
const monoStyle: CSSProperties = { fontFamily: "var(--cocoa-font-mono)" };

const ITEM_COLUMNS: CocoaTableColumn<MenuItem>[] = [
  { key: "name", label: FIELD_LABELS.name, render: (it) => <strong>{it.name}</strong> },
  { key: "category", label: "Categoría", render: (it) => it.category ?? "—" },
  { key: "sku", label: "SKU", hideOnNarrow: true, render: (it) => (it.sku ? <span style={monoStyle}>{it.sku}</span> : "—") },
  { key: "price", label: FIELD_LABELS.price, align: "right", render: (it) => <strong>{money(Number(it.price))}</strong> },
  { key: "taxRate", label: "IVA", align: "right", hideOnNarrow: true, render: (it) => (it.taxRate != null ? percent(it.taxRate) : "—") },
  {
    key: "stock",
    label: "Control de stock",
    hideOnNarrow: true,
    // Stock control = the item has a recipe; the list endpoint does not say, so
    // the cell links to the Existencias tab where the recipe is shown.
    render: () => (
      <CocoaButton variant="plain" tone="accent" size="small" onClick={openStock} title="Ver existencias y recetas">
        {ACTIONS.viewDetail}
      </CocoaButton>
    )
  },
  {
    key: "active",
    label: FIELD_LABELS.status,
    render: (it) => (
      <CocoaBadge tone={it.active ? "success" : "neutral"} size="small">
        {it.active ? "activo" : "inactivo"}
      </CocoaBadge>
    )
  }
];

// Mirror skeleton: the KPI strip and the outlet card.
function MenuSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" />
    </div>
  );
}

export function FnbMenuScreen() {
  const hosted = useTabHost() !== null;
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const outlets = useApiData<PosOutlet[]>(`/properties/${PROPERTY_ID}/pos/outlets`, { pollIntervalMs: 0 });
  const menus = useApiData<{ items: MenuItem[] }>(`/properties/${PROPERTY_ID}/menu-items`, { pollIntervalMs: 30000 });

  const outletList = toArray<PosOutlet>(outlets.data);
  const allItems = useMemo(() => toArray<MenuItem>(menus.data?.items), [menus.data]);

  const [activeOutletId, setActiveOutletId] = useState<string | null>(null);
  const currentOutletId = activeOutletId ?? outletList[0]?.id ?? null;
  const currentOutlet = outletList.find((o) => o.id === currentOutletId) ?? null;

  // Outlet tabs: one shared panel (the outlet card) whose content follows the
  // active tab; arrows / Home / End move focus AND select (automatic
  // activation — switching an outlet is a local filter, no fetch).
  const tabsId = useId();
  const tabId = (outletId: string) => `${tabsId}-tab-${outletId}`;
  const panelId = `${tabsId}-panel`;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!currentOutletId) return;
    const target = nextSegmentValue(
      currentOutletId,
      outletList.map((o) => o.id),
      event.key
    );
    if (!target) return;
    event.preventDefault();
    setActiveOutletId(target);
    tabRefs.current.get(target)?.focus();
  };

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

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
  const activeCount = allItems.filter((i) => i.active).length;
  const averagePrice = allItems.length > 0 ? money(allItems.reduce((s, i) => s + Number(i.price), 0) / allItems.length) : "—";

  function openCreate() {
    if (!currentOutletId) return;
    setDraft(emptyDraft(currentOutletId));
    setErrors({});
    setFormError(null);
    setShowForm(true);
    setMsg(null);
  }

  function closeForm() {
    if (busy) return;
    setShowForm(false);
    setDraft(null);
    setErrors({});
    setFormError(null);
  }

  function patchDraft(patch: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  async function save() {
    if (!draft) return;
    const next: DraftErrors = {};
    if (!draft.name.trim()) next.name = "El nombre es obligatorio.";
    if (!draft.outletId) next.outletId = "Selecciona un punto de venta.";
    const price = Number(draft.price);
    if (!draft.price.trim() || Number.isNaN(price) || price < 0) next.price = "El precio es obligatorio y no puede ser negativo.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFormError(null);
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
      setFormError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const refreshAll = () => {
    outlets.refresh();
    menus.refresh();
  };

  const presets = draft ? CATEGORY_PRESETS[outletKey(draft.outletId)] ?? [] : [];
  const outletOptions = outletList.map((o) => ({ value: o.id, label: o.name }));
  const anyLoading = outlets.loading || menus.loading;

  // The outlet card: tabs + table, or the honest state of the outlet list.
  let outletBody;
  if (outlets.error && outletList.length === 0) {
    outletBody = <CocoaState kind="error" title="No se pudieron cargar los puntos de venta" message={outlets.error} onRetry={outlets.refresh} />;
  } else if (outletList.length === 0) {
    outletBody = <CocoaState kind="empty" illustration="box" title="Sin puntos de venta" message="Esta propiedad no tiene puntos de venta configurados todavía." />;
  } else if (menus.loading && allItems.length === 0) {
    outletBody = <CocoaTable columns={ITEM_COLUMNS} rows={[]} loading aria-label="Carta" />;
  } else if (menus.error && allItems.length === 0) {
    outletBody = <CocoaState kind="error" title="No se pudo cargar la carta" message={menus.error} onRetry={menus.refresh} />;
  } else if (currentItems.length === 0) {
    outletBody = (
      <CocoaState
        kind="empty"
        illustration="box"
        title={`Sin items en ${currentOutlet?.name ?? "este punto de venta"}`}
        message="Crea el primer plato o bebida para que aparezca en el TPV."
        primaryAction={{ label: NEW_ITEM_LABEL, onClick: openCreate, loading: busy }}
      />
    );
  } else {
    outletBody = <CocoaTable columns={ITEM_COLUMNS} rows={currentItems} rowKey="id" caption={`Carta de ${currentOutlet?.name ?? "punto de venta"}`} aria-label={`Carta de ${currentOutlet?.name ?? "punto de venta"}`} />;
  }
  const tableReady = outletList.length > 0 && currentItems.length > 0 && !(menus.loading && allItems.length === 0);

  return (
    <CocoaPage
      eyebrow={`Operaciones · ${propertyName}`}
      title="Cartas de restauración"
      subtitle={hosted ? undefined : "Catálogo de platos y bebidas por punto de venta. Cada artículo tiene precio, IVA y opcionalmente una receta que descuenta existencias al cerrar la comanda (ver Existencias)."}
      actions={
        <>
          {anyLoading && (outletList.length > 0 || allItems.length > 0) ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {menus.error && allItems.length > 0 ? <CocoaBadge tone="danger">{STATUS_LABELS.loadError}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon width={14} height={14} aria-hidden="true" />} onClick={openCreate} disabled={busy || !currentOutletId}>
            {NEW_ITEM_LABEL}
          </CocoaButton>
        </>
      }
      state={outlets.loading && outletList.length === 0 && !outlets.error ? "loading" : "ready"}
      skeleton={<MenuSkeleton />}
      commands={[
        { id: "fnb-menu-new", label: `${NEW_ITEM_LABEL} de carta`, run: openCreate },
        { id: "fnb-menu-refresh", label: "Actualizar cartas", run: refreshAll }
      ]}
    >
      {msg ? (
        <CocoaCallout tone="success" role="status">
          {msg}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Resumen de las cartas">
        <CocoaKpi label="Puntos de venta" value={outletList.length} deltaLabel="activos" polarity="neutral" status="ok" />
        <CocoaKpi label="Items en carta" value={allItems.length} deltaLabel="total" polarity="neutral" status="ok" />
        <CocoaKpi label="Items activos" value={activeCount} deltaLabel="en venta" polarity="neutral" status="ok" />
        <CocoaKpi label="Precio medio" value={averagePrice} deltaLabel="por item" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      {outletList.length > 0 ? (
        <CocoaToolbar
          variant="content"
          aria-label="Puntos de venta"
          leftSlot={
            <div role="tablist" aria-label="Carta por punto de venta" aria-orientation="horizontal" className="cocoa-cluster" onKeyDown={onTabKeyDown}>
              {outletList.map((o) => {
                const itemCount = (byOutlet.get(o.id) ?? []).length;
                const active = currentOutletId === o.id;
                return (
                  <CocoaButton
                    key={o.id}
                    id={tabId(o.id)}
                    role="tab"
                    aria-selected={active}
                    aria-controls={panelId}
                    tabIndex={active ? 0 : -1}
                    ref={(element) => {
                      if (element) tabRefs.current.set(o.id, element);
                      else tabRefs.current.delete(o.id);
                    }}
                    variant={active ? "tinted" : "plain"}
                    tone={active ? "accent" : "neutral"}
                    size="small"
                    onClick={() => setActiveOutletId(o.id)}
                  >
                    {o.name}
                    <CocoaBadge tone={active ? "accent" : "neutral"} size="small" aria-label={plural(itemCount, "item", "items")}>
                      {itemCount}
                    </CocoaBadge>
                  </CocoaButton>
                );
              })}
            </div>
          }
        />
      ) : null}

      {/* The tabpanel the tabs control; its name is the active tab's. */}
      <div role="tabpanel" id={panelId} aria-labelledby={currentOutletId ? tabId(currentOutletId) : undefined}>
        <CocoaSection
          title={currentOutlet ? `Carta de ${currentOutlet.name}` : "Carta"}
          meta={tableReady ? plural(currentItems.length, "item", "items") : undefined}
          padding={tableReady ? "none" : "md"}
          style={{ overflow: "clip" }}
          aria-label="Carta del punto de venta"
        >
          {outletBody}
        </CocoaSection>
      </div>

      <CocoaDrawer
        open={showForm && draft !== null}
        onClose={closeForm}
        title="Nuevo item de carta"
        subtitle={draft ? outletList.find((o) => o.id === draft.outletId)?.name : undefined}
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeForm} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={busy}>
              Crear item
            </CocoaButton>
          </>
        }
      >
        {draft ? (
          <div className="cocoa-stack" data-gap="4">
            {formError ? (
              <CocoaCallout tone="danger" role="alert">
                {formError}
              </CocoaCallout>
            ) : null}
            <CocoaFormRow columns={2} min={200}>
              <CocoaField label="Punto de venta" required error={errors.outletId}>
                <CocoaSelect value={draft.outletId} onChange={(v) => patchDraft({ outletId: v, category: "" })} options={outletOptions} disabled={busy} />
              </CocoaField>
              <CocoaField label="Categoría" hint={STATUS_LABELS.optional.toLowerCase()}>
                <CocoaInput value={draft.category} onChange={(v) => patchDraft({ category: v })} placeholder="Ej. Principales" disabled={busy} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.name} required fullWidth error={errors.name}>
                <CocoaInput value={draft.name} onChange={(v) => patchDraft({ name: v })} placeholder="Ej. Tarta de queso con frutos rojos" disabled={busy} />
              </CocoaField>
              <CocoaField label="SKU / código" hint={STATUS_LABELS.optional.toLowerCase()}>
                <CocoaInput value={draft.sku} onChange={(v) => patchDraft({ sku: v })} placeholder="RST-DES-001" disabled={busy} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.price} required error={errors.price}>
                <CocoaInput type="number" min={0} step={0.01} inputMode="decimal" value={draft.price} onChange={(v) => patchDraft({ price: v })} placeholder="6,50" disabled={busy} />
              </CocoaField>
              <CocoaField label="IVA aplicable" fullWidth>
                <CocoaSelect value={draft.taxRate} onChange={(v) => patchDraft({ taxRate: v })} options={TAX_OPTIONS} disabled={busy} />
              </CocoaField>
              <CocoaField label="Control de stock (BOM)" inline fullWidth help="Si activas el control, después define la receta en Existencias para descontar ingredientes al cerrar la comanda.">
                <CocoaSwitch checked={draft.stockControlled} onChange={(v) => patchDraft({ stockControlled: v })} disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
            {presets.length > 0 ? (
              <div className="cocoa-stack" data-gap="2">
                <span className="c22-field__label">Categorías habituales</span>
                <div className="cocoa-cluster" role="group" aria-label="Categorías habituales">
                  {presets.map((c) => (
                    <CocoaButton key={c} size="small" variant={draft.category === c ? "tinted" : "bordered"} tone={draft.category === c ? "accent" : "neutral"} aria-pressed={draft.category === c} onClick={() => patchDraft({ category: c })} disabled={busy}>
                      {c}
                    </CocoaButton>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}
