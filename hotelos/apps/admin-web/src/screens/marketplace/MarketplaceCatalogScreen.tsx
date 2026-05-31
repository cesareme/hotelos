// Marketplace público de apps — catálogo + instalación.
// Conecta con el backend P2-1 (Apaleo-style).

import { useEffect, useMemo, useState } from "react";
import {
  fetchCategories,
  fetchListings,
  fetchInstallations,
  installListing,
  uninstallListing,
  fetchOAuthScopes,
  type MarketplaceListing,
  type AppInstallation
} from "../../services/marketplaceApi";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

const CATEGORY_LABELS: Record<string, string> = {
  channel_manager: "Channel Manager",
  rate_management: "Revenue Management",
  payments: "Pagos",
  messaging: "Mensajería",
  smart_lock: "Cerraduras inteligentes",
  accounting: "Contabilidad",
  compliance: "Cumplimiento",
  energy: "Energía",
  marketing: "Marketing",
  crm: "CRM",
  operations: "Operaciones",
  analytics: "Analítica",
  ai_assistant: "Asistentes IA"
};

export function MarketplaceCatalogScreen() {
  const { showToast } = useToast();
  const [categories, setCategories] = useState<string[]>([]);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installations, setInstallations] = useState<AppInstallation[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [category, setCategory] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketplaceListing | null>(null);
  const [installing, setInstalling] = useState(false);
  const [chosenScopes, setChosenScopes] = useState<Set<string>>(new Set());
  const [pendingUninstallId, setPendingUninstallId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [cats, items, installs, sc] = await Promise.all([
        fetchCategories(),
        fetchListings(category || undefined),
        fetchInstallations(),
        fetchOAuthScopes()
      ]);
      setCategories(cats);
      setListings(items);
      setInstallations(installs);
      setScopes(sc);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando marketplace.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [category]);

  const installedAppIds = useMemo(() => new Set(installations.map((i) => i.appId)), [installations]);

  async function handleInstall() {
    if (!selected) return;
    const appId = selected.appId;
    setInstalling(true);
    try {
      await installListing(appId, { grantedScopes: Array.from(chosenScopes) });
      setSelected(null);
      setChosenScopes(new Set());
      await refresh();
      showToast(`Módulo "${appId}" instalado`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error instalando.";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setInstalling(false);
    }
  }

  async function confirmUninstall() {
    const appId = pendingUninstallId;
    if (!appId) return;
    setPendingUninstallId(null);
    try {
      await uninstallListing(appId);
      await refresh();
      showToast(`Módulo "${appId}" desinstalado`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error.";
      setError(message);
      showToast(message, { variant: "error" });
    }
  }

  function toggleScope(s: string) {
    setChosenScopes((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s); else n.add(s);
      return n;
    });
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Plataforma · Marketplace
          </p>
          <h2 style={{ color: "var(--ink)" }}>Catálogo de apps</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Apps certificadas que extienden tu PMS — channel managers, revenue tools, llaves digitales, asistentes IA…
            Cada app pide los <strong>scopes OAuth</strong> que necesita y tú apruebas exactamente qué datos puede leer/escribir.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>↻ Actualizar</button>
      </header>

      {/* Category filter */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setCategory("")}
          className={category === "" ? "primary" : ""}
          style={{ padding: "6px 12px" }}
        >
          Todas
        </button>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={category === c ? "primary" : ""}
            style={{ padding: "6px 12px" }}
          >
            {CATEGORY_LABELS[c] ?? c}
          </button>
        ))}
      </div>

      {error ? <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p> : null}

      {/* Listings grid */}
      {loading ? <LoadingBlock label="Cargando catálogo…" /> : listings.length === 0 ? (
        <EmptyState
          title="Sin apps publicadas en esta categoría"
          message="Las apps verificadas aparecerán aquí en cuanto un partner publique. Mientras tanto, puedes crear tu propia app en «Developer Apps»."
        />
      ) : (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {listings.map((l) => {
            const installed = installedAppIds.has(l.appId);
            return (
              <article key={l.id} className="bo-card" style={{ background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {l.iconUrl ? (
                    <img src={l.iconUrl} alt="" width={36} height={36} style={{ borderRadius: 8 }} />
                  ) : (
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--accent-soft, rgba(78,224,163,0.15))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📦</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ color: "var(--ink)", margin: 0, fontSize: 14 }}>{l.appId}</h3>
                    <p className="bo-muted" style={{ margin: 0, fontSize: 11 }}>
                      {CATEGORY_LABELS[l.category] ?? l.category}
                      {l.verified ? " · ✓ verificada" : ""}
                    </p>
                  </div>
                </div>
                <p style={{ fontSize: 13, color: "var(--ink)", margin: 0 }}>{l.tagline}</p>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                  <span className="bo-muted" style={{ fontSize: 11 }}>{l.installsCount} instalaciones · {l.pricing ?? "free"}</span>
                  {installed ? (
                    <button type="button" onClick={() => setPendingUninstallId(l.appId)}>Desinstalar</button>
                  ) : (
                    <button type="button" className="primary" onClick={() => { setSelected(l); setChosenScopes(new Set()); }}>Instalar</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Install dialog */}
      {selected ? (
        <article className="bo-card" style={{ background: "var(--surface-2, var(--surface))", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Instalar {selected.appId}</h3>
            <button type="button" onClick={() => setSelected(null)}>Cancelar</button>
          </div>
          <p style={{ color: "var(--ink)", margin: "8px 0" }}>{selected.description}</p>
          <p className="bo-muted" style={{ marginTop: 12, fontSize: 12 }}>
            Esta app puede pedir acceso a los siguientes scopes. Selecciona los que quieras conceder:
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 4 }}>
            {scopes.map((s) => (
              <label key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={chosenScopes.has(s)} onChange={() => toggleScope(s)} />
                <span className="mono">{s}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" className="primary" onClick={handleInstall} disabled={installing || chosenScopes.size === 0}>
              {installing ? <Spinner size="sm" /> : `Instalar con ${chosenScopes.size} scopes`}
            </button>
            <button type="button" onClick={() => setChosenScopes(new Set(scopes))} disabled={installing}>Conceder todos</button>
          </div>
        </article>
      ) : null}

      {/* Installed list */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Apps instaladas</h3>
          <span className="bo-chip">{installations.length}</span>
        </div>
        {installations.length === 0 ? (
          <EmptyState title="Ninguna app instalada" message="Instala una app del catálogo para empezar." />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead><tr><th>App</th><th>Scopes</th><th>Instalada</th><th></th></tr></thead>
              <tbody>
                {installations.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.appId}</td>
                    <td style={{ fontSize: 11 }}>{i.scopes.join(", ")}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{new Date(i.installedAt).toLocaleDateString("es-ES")}</td>
                    <td><button type="button" onClick={() => setPendingUninstallId(i.appId)}>Desinstalar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <ConfirmDialog
        open={pendingUninstallId !== null}
        title="¿Desinstalar esta app?"
        description="Los tokens emitidos quedarán inactivos."
        confirmLabel="Desinstalar"
        variant="danger"
        onConfirm={() => void confirmUninstall()}
        onCancel={() => setPendingUninstallId(null)}
      />
    </section>
  );
}
