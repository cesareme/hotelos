// Upsells — catálogo de ofertas adicionales que se muestran al huésped antes
// y durante la estancia (room upgrade, early check-in, late check-out, parking,
// breakfast add-on, spa credit). Reemplaza el placeholder genérico.

import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";

const PROPERTY_ID = getActivePropertyId();

type UpsellOffer = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  price: number;
  currency: string;
  category: string;
  active: boolean;
  channel?: string | null; // "pre_stay" | "in_stay" | "checkout" | "kiosk"
  imageUrl?: string | null;
};

const CATEGORIES: Array<{ value: string; label: string; icon: string }> = [
  { value: "upgrade", label: "Upgrade de habitación", icon: "⬆" },
  { value: "early_checkin", label: "Check-in temprano", icon: "🌅" },
  { value: "late_checkout", label: "Check-out tardío", icon: "🌇" },
  { value: "breakfast", label: "Desayuno", icon: "🥐" },
  { value: "parking", label: "Parking", icon: "🅿" },
  { value: "spa", label: "Spa / wellness", icon: "💆" },
  { value: "transfer", label: "Traslado aeropuerto", icon: "🚗" },
  { value: "amenity", label: "Amenities", icon: "🎁" },
  { value: "experience", label: "Experiencia local", icon: "🗺" }
];

const CHANNELS = [
  { value: "pre_stay", label: "Pre-estancia (email)" },
  { value: "in_stay", label: "Durante la estancia (app)" },
  { value: "checkout", label: "Al hacer check-out" },
  { value: "kiosk", label: "Kiosko self check-in" }
];

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function UpsellsSettingsScreen() {
  const { showToast } = useToast();
  // Reusamos los advanced records (módulo "guest_self_service" + entityType "upsell_offers")
  // que ya existen — la UI siempre fue placeholder.
  const offersData = useApiData<{ items: UpsellOffer[] }>(
    `/properties/${PROPERTY_ID}/guest-self-service/upsell_offers`,
    { pollIntervalMs: 0 }
  );
  const [items, setItems] = useState<UpsellOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<UpsellOffer | null>(null);

  useEffect(() => {
    if (offersData.data?.items) setItems(offersData.data.items);
  }, [offersData.data]);

  const stats = useMemo(() => {
    const active = items.filter((i) => i.active).length;
    const byChannel: Record<string, number> = {};
    for (const o of items) {
      const k = o.channel ?? "any";
      byChannel[k] = (byChannel[k] ?? 0) + 1;
    }
    return { total: items.length, active, byChannel };
  }, [items]);

  function startNew() {
    setEditing({
      id: `new_${Date.now()}`,
      code: "",
      name: "",
      price: 0,
      currency: "EUR",
      category: "upgrade",
      active: true,
      channel: "pre_stay"
    });
  }

  async function save(offer: UpsellOffer) {
    setBusy(true);
    setMsg(null);
    try {
      const isNew = offer.id.startsWith("new_");
      const path = isNew
        ? `/properties/${PROPERTY_ID}/guest-self-service/upsell_offers`
        : `/properties/${PROPERTY_ID}/guest-self-service/upsell_offers/${offer.id}`;
      await apiRequest(path, {
        method: isNew ? "POST" : "PATCH",
        body: { ...offer, id: undefined }
      });
      const okMsg = isNew ? "Oferta creada" : "Oferta actualizada";
      setMsg(okMsg);
      setEditing(null);
      offersData.refresh();
      showToast(okMsg, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error guardando";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Experiencia del huésped · Upsells
          </p>
          <h2 style={{ color: "var(--ink)" }}>Catálogo de ofertas adicionales</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Define qué se ofrece al huésped antes y durante la estancia (upgrade, parking, breakfast…),
            por qué canal y a qué precio. El portal y el kiosko leen este catálogo.
          </p>
        </div>
        <button type="button" className="primary" onClick={startNew}>+ Nueva oferta</button>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Ofertas totales</span>
            <span className="bo-status info">catalogo</span>
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
          <div className="rev-kpi-value">{Object.keys(stats.byChannel).length}</div>
        </article>
      </div>

      {editing ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>{editing.id.startsWith("new_") ? "Nueva oferta" : "Editar oferta"}</h3>
            <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void save(editing); }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <label>Código
              <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} required />
            </label>
            <label>Nombre
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            </label>
            <label>Categoría
              <select value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.icon} {c.label}</option>)}
              </select>
            </label>
            <label>Canal
              <select value={editing.channel ?? "pre_stay"} onChange={(e) => setEditing({ ...editing, channel: e.target.value })}>
                {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label>Precio
              <input type="number" step="0.01" value={editing.price} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })} required />
            </label>
            <label>Moneda
              <input value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value.toUpperCase() })} maxLength={3} />
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
          <span className="bo-chip">{items.length}</span>
        </div>
        {offersData.loading && items.length === 0 ? <LoadingBlock label="Cargando catálogo…" /> : items.length === 0 ? (
          <EmptyState title="Sin ofertas" message="Aún no hay upsells configurados. Empieza con un upgrade o late check-out — los más rentables." />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Canal</th><th>Precio</th><th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {items.map((o) => {
                  const cat = CATEGORIES.find((c) => c.value === o.category);
                  const ch = CHANNELS.find((c) => c.value === o.channel);
                  return (
                    <tr key={o.id}>
                      <td className="mono"><strong>{o.code}</strong></td>
                      <td>{o.name}</td>
                      <td>{cat ? `${cat.icon} ${cat.label}` : o.category}</td>
                      <td>{ch?.label ?? o.channel ?? "—"}</td>
                      <td className="mono">{fmtMoney(o.price, o.currency)}</td>
                      <td><span className={`bo-status ${o.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{o.active ? "activa" : "pausada"}</span></td>
                      <td><button type="button" onClick={() => setEditing(o)}>Editar</button></td>
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
