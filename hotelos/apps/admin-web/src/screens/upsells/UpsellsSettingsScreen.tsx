// Upsells — catálogo de ofertas adicionales que se muestran al huésped antes
// y durante la estancia (room upgrade, early check-in, late check-out, parking,
// breakfast add-on, spa credit).
//
// Tanda 3 · CF-02: la pantalla lee y escribe sobre Prisma UpsellOffer a través
// de las rutas staff (services/upsellsApi.ts). La categoría de la UI se guarda
// como `offerType`; la categoría fiscal (`taxCategory`) decide el tipo de IVA /
// IGIC / IPSI que aplicará el folio cuando se venda la oferta.

import { useTabHost } from "../tabs/TabHost";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveProperty } from "../../services/activeProperty";
import { LoadingBlock, EmptyState, ErrorState, Spinner } from "../../components/States";
import { useToast } from "../../components/Toast";
import {
  createUpsellOffer,
  listUpsellOffers,
  patchUpsellOffer,
  toUpsellOfferInput,
  type UpsellOffer
} from "../../services/upsellsApi";
import { money, type CurrencyInput } from "../../lib/format";

type Draft = Omit<UpsellOffer, "id"> & { id: string | null };

const CATEGORIES: Array<{ value: string; label: string; icon: string; defaultTaxCategory: string }> = [
  { value: "upgrade", label: "Upgrade de habitación", icon: "⬆", defaultTaxCategory: "accommodation" },
  { value: "early_checkin", label: "Check-in temprano", icon: "🌅", defaultTaxCategory: "accommodation" },
  { value: "late_checkout", label: "Check-out tardío", icon: "🌇", defaultTaxCategory: "accommodation" },
  { value: "breakfast", label: "Desayuno", icon: "🥐", defaultTaxCategory: "food_beverage" },
  { value: "parking", label: "Parking", icon: "🅿", defaultTaxCategory: "general_services" },
  { value: "spa", label: "Spa / wellness", icon: "💆", defaultTaxCategory: "general_services" },
  { value: "transfer", label: "Traslado aeropuerto", icon: "🚗", defaultTaxCategory: "transport" },
  { value: "amenity", label: "Amenities", icon: "🎁", defaultTaxCategory: "general_services" },
  { value: "experience", label: "Experiencia local", icon: "🗺", defaultTaxCategory: "general_services" }
];

const CHANNELS = [
  { value: "pre_stay", label: "Pre-estancia (email)" },
  { value: "in_stay", label: "Durante la estancia (app)" },
  { value: "checkout", label: "Al hacer check-out" },
  { value: "kiosk", label: "Kiosko self check-in" }
];

// Categorías fiscales del catálogo (packages/compliance/src/spain/indirect-tax.ts).
// El tipo concreto (10 % / 21 % IVA, 7 % IGIC, 2 % / 4 % IPSI) lo resuelve el API
// según la región fiscal de la propiedad; aquí solo se elige el concepto.
const TAX_CATEGORIES = [
  { value: "accommodation", label: "Alojamiento (tipo reducido de hostelería)" },
  { value: "food_beverage", label: "Restauración / F&B (tipo reducido de hostelería)" },
  { value: "general_services", label: "Servicios generales (spa, parking, salas… tipo general)" },
  { value: "transport", label: "Transporte de viajeros" },
  { value: "not_subject", label: "No sujeto (indemnizaciones)" }
];

function fmtMoney(n: number, currency?: CurrencyInput): string {
  return money(n, currency);
}

function defaultTaxCategory(category: string): string {
  return CATEGORIES.find((c) => c.value === category)?.defaultTaxCategory ?? "general_services";
}

function newDraft(): Draft {
  return {
    id: null,
    code: "",
    name: "",
    description: null,
    price: 0,
    currency: "EUR",
    category: "upgrade",
    active: true,
    channel: "pre_stay",
    imageUrl: null,
    taxCategory: defaultTaxCategory("upgrade")
  };
}

export function UpsellsSettingsScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const embedded = useTabHost() !== null;
  const { showToast } = useToast();
  const { propertyId } = useActiveProperty();
  const [items, setItems] = useState<UpsellOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setItems(await listUpsellOffers(propertyId));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "No se pudo cargar el catálogo de upsells.");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const active = items.filter((i) => i.active).length;
    const channels = new Set(items.map((o) => o.channel ?? "any"));
    return { total: items.length, active, channels: channels.size };
  }, [items]);

  function startNew() {
    setMsg(null);
    setEditing(newDraft());
  }

  function startEdit(offer: UpsellOffer) {
    setMsg(null);
    setEditing({ ...offer });
  }

  async function save(draft: Draft) {
    setBusy(true);
    setMsg(null);
    try {
      const { id, ...fields } = draft;
      const input = toUpsellOfferInput(fields);
      if (!input.name) throw new Error("El nombre de la oferta es obligatorio.");
      if (input.price < 0) throw new Error("El precio no puede ser negativo.");
      if (id) await patchUpsellOffer(id, input);
      else await createUpsellOffer(propertyId, input);
      const okMsg = id ? "Oferta actualizada" : "Oferta creada";
      setMsg(okMsg);
      setEditing(null);
      showToast(okMsg, { variant: "success" });
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo guardar la oferta.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(offer: UpsellOffer) {
    setBusy(true);
    setMsg(null);
    try {
      await patchUpsellOffer(offer.id, { active: !offer.active });
      showToast(offer.active ? `«${offer.name}» pausada` : `«${offer.name}» activada`, { variant: "success" });
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo cambiar el estado de la oferta.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const newOfferButton = (
    <button type="button" className="primary" onClick={startNew} disabled={busy}>+ Nueva oferta</button>
  );

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          {embedded ? null : (
            <>
              <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
                Comercial · Ventas adicionales
              </p>
              <h2 style={{ color: "var(--ink)" }}>Catálogo de ofertas adicionales</h2>
            </>
          )}
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Define qué se ofrece al huésped antes y durante la estancia (upgrade, parking, desayuno…),
            por qué canal y a qué precio. El portal, el kiosko y el panel de upsells leen este catálogo.
          </p>
        </div>
        {newOfferButton}
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Ofertas totales</span>
            <span className="bo-status info">catálogo</span>
          </div>
          <div className="rev-kpi-value">{stats.total}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Activas</span>
            <span className="bo-status ok">vendibles</span>
          </div>
          <div className="rev-kpi-value">{stats.active}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Canales</span>
            <span className="bo-status info">distintos</span>
          </div>
          <div className="rev-kpi-value">{stats.channels}</div>
        </article>
      </div>

      {editing ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>{editing.id ? "Editar oferta" : "Nueva oferta"}</h3>
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>Cancelar</button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(editing);
            }}
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}
          >
            <label>Código
              <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} placeholder="UPG-SUITE" />
            </label>
            <label>Nombre
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            </label>
            <label>Categoría
              <select
                value={editing.category}
                onChange={(e) => {
                  const category = e.target.value;
                  // Keep the fiscal category in sync unless the user already overrode it.
                  const prevDefault = defaultTaxCategory(editing.category);
                  const taxCategory = editing.taxCategory && editing.taxCategory !== prevDefault ? editing.taxCategory : defaultTaxCategory(category);
                  setEditing({ ...editing, category, taxCategory });
                }}
              >
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.icon} {c.label}</option>)}
              </select>
            </label>
            <label>Canal
              <select value={editing.channel ?? "pre_stay"} onChange={(e) => setEditing({ ...editing, channel: e.target.value })}>
                {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label>Precio (impuestos incluidos)
              <input type="number" step="0.01" min="0" value={editing.price} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })} required />
            </label>
            <label>Moneda
              <input value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value.toUpperCase() })} maxLength={3} />
            </label>
            <label>Categoría fiscal
              <select value={editing.taxCategory ?? defaultTaxCategory(editing.category)} onChange={(e) => setEditing({ ...editing, taxCategory: e.target.value })}>
                {TAX_CATEGORIES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label>Imagen (URL)
              <input value={editing.imageUrl ?? ""} onChange={(e) => setEditing({ ...editing, imageUrl: e.target.value })} placeholder="https://…" />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>Descripción
              <textarea rows={2} value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label>
              <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              {" "}Activa
            </label>
            <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? <Spinner size="sm" /> : "Guardar"}
              </button>
            </div>
          </form>
        </article>
      ) : null}

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Catálogo</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="bo-chip">{items.length}</span>
            <button type="button" className="ghost" onClick={() => void load()} disabled={loading} title="Recargar">↻</button>
          </div>
        </div>
        {loading && items.length === 0 ? (
          <LoadingBlock label="Cargando catálogo…" />
        ) : loadError ? (
          <ErrorState title="No se pudo cargar el catálogo" message={loadError} onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="Sin ofertas en esta propiedad"
            message="Aún no hay upsells configurados. Empieza con un upgrade o un late check-out: son los más rentables. Hasta que exista al menos una oferta activa, el panel de upsells y el portal del huésped no mostrarán nada."
            actions={newOfferButton}
          />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Canal</th><th>Precio</th><th>Fiscal</th><th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {items.map((o) => {
                  const cat = CATEGORIES.find((c) => c.value === o.category);
                  const ch = CHANNELS.find((c) => c.value === o.channel);
                  const tax = TAX_CATEGORIES.find((t) => t.value === o.taxCategory);
                  return (
                    <tr key={o.id}>
                      <td className="mono"><strong>{o.code || "—"}</strong></td>
                      <td>{o.name}</td>
                      <td>{cat ? `${cat.icon} ${cat.label}` : o.category}</td>
                      <td>{ch?.label ?? o.channel ?? "—"}</td>
                      <td className="mono">{fmtMoney(o.price, o.currency)}</td>
                      <td className="bo-muted" style={{ fontSize: 12 }}>{tax ? tax.label.split(" (")[0] : o.taxCategory ?? "—"}</td>
                      <td><span className={`bo-status ${o.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{o.active ? "activa" : "pausada"}</span></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button type="button" onClick={() => startEdit(o)} disabled={busy}>Editar</button>{" "}
                        <button type="button" className="ghost" onClick={() => void toggleActive(o)} disabled={busy}>
                          {o.active ? "Pausar" : "Activar"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
