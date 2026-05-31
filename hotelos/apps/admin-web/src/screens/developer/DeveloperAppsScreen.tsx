// Developer Apps — gestión de las apps OAuth2 propias del partner.
// Permite crear apps, ver/rotar client_secret y elegir scopes.

import { useEffect, useState } from "react";
import {
  fetchDeveloperApps,
  createDeveloperApp,
  rotateAppSecret,
  fetchOAuthScopes,
  type DeveloperApp
} from "../../services/marketplaceApi";
import { LoadingBlock, EmptyState, Spinner } from "../../components/States";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

export function DeveloperAppsScreen() {
  const { showToast } = useToast();
  const [apps, setApps] = useState<DeveloperApp[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [appType, setAppType] = useState("integration");
  const [chosenScopes, setChosenScopes] = useState<Set<string>>(new Set());
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [pendingRotateId, setPendingRotateId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [list, sc] = await Promise.all([fetchDeveloperApps(), fetchOAuthScopes()]);
      setApps(list);
      setScopes(sc);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function toggleScope(s: string) {
    setChosenScopes((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s); else n.add(s);
      return n;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || chosenScopes.size === 0) return;
    const appName = name.trim();
    setCreating(true);
    try {
      const result = await createDeveloperApp({
        name: appName,
        appType,
        scopes: Array.from(chosenScopes)
      });
      setCreatedSecret({ clientId: result.clientId, clientSecret: result.clientSecret });
      setName("");
      setChosenScopes(new Set());
      await refresh();
      showToast(`App "${appName}" creada`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error creando app.";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  async function confirmRotate() {
    const appId = pendingRotateId;
    if (!appId) return;
    setPendingRotateId(null);
    const app = apps.find((a) => a.id === appId);
    try {
      const r = await rotateAppSecret(appId);
      if (app) setCreatedSecret({ clientId: app.clientId, clientSecret: r.clientSecret });
      await refresh();
      showToast(app ? `Secret de "${app.name}" rotado` : "Secret rotado", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error.";
      setError(message);
      showToast(message, { variant: "error" });
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Plataforma · Developer Apps
          </p>
          <h2 style={{ color: "var(--ink)" }}>Mis aplicaciones OAuth2</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cada app tiene un <code>client_id</code> público y un <code>client_secret</code> que se muestra <strong>solo una vez</strong>.
            Soporta Authorization Code + PKCE (S256) y Client Credentials (server-to-server). Refresh tokens rotativos con 30 d de vida.
          </p>
        </div>
      </header>

      {error ? <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p> : null}

      {createdSecret ? (
        <article className="bo-card" style={{ background: "var(--accent-soft, rgba(78,224,163,0.10))", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Credenciales emitidas</h3>
            <button type="button" onClick={() => setCreatedSecret(null)}>Cerrar</button>
          </div>
          <p className="bo-muted" style={{ textTransform: "none" }}>Cópialas ahora — el secret <strong>no se mostrará de nuevo</strong>.</p>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <div>
              <span className="bo-muted" style={{ fontSize: 11 }}>CLIENT_ID</span>
              <pre className="mono" style={{ background: "var(--surface-2)", padding: 8, borderRadius: 4, margin: "4px 0 0", overflowX: "auto" }}>{createdSecret.clientId}</pre>
            </div>
            <div>
              <span className="bo-muted" style={{ fontSize: 11 }}>CLIENT_SECRET</span>
              <pre className="mono" style={{ background: "var(--surface-2)", padding: 8, borderRadius: 4, margin: "4px 0 0", overflowX: "auto" }}>{createdSecret.clientSecret}</pre>
            </div>
          </div>
        </article>
      ) : null}

      {/* Create form */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Nueva app</h3></div>
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="bo-muted" style={{ textTransform: "none" }}>Nombre de la app</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mi conector con SAP" required />
          <label className="bo-muted" style={{ textTransform: "none" }}>Tipo</label>
          <select value={appType} onChange={(e) => setAppType(e.target.value)}>
            <option value="integration">Integración server-to-server</option>
            <option value="spa">Single-page app (con PKCE)</option>
            <option value="mobile">Mobile</option>
            <option value="partner_app">Marketplace partner</option>
          </select>
          <label className="bo-muted" style={{ textTransform: "none" }}>Scopes ({chosenScopes.size}/{scopes.length})</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 4 }}>
            {scopes.map((s) => (
              <label key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={chosenScopes.has(s)} onChange={() => toggleScope(s)} />
                <span className="mono">{s}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="primary" disabled={creating || !name.trim() || chosenScopes.size === 0}>
              {creating ? <Spinner size="sm" /> : "+ Crear app"}
            </button>
            <button type="button" onClick={() => setChosenScopes(new Set(scopes))} disabled={creating}>Todos los scopes</button>
          </div>
        </form>
      </article>

      {/* List */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Apps existentes</h3>
          <span className="bo-chip">{apps.length}</span>
        </div>
        {loading && apps.length === 0 ? <LoadingBlock label="Cargando…" /> : apps.length === 0 ? (
          <EmptyState title="Sin apps" message="Crea la primera arriba." />
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead><tr><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Client ID</th><th>Scopes</th><th></th></tr></thead>
              <tbody>
                {apps.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong></td>
                    <td>{a.appType}</td>
                    <td><span className={`bo-status ${a.status === "active" ? "ok" : "info"}`} style={{ fontSize: 10 }}>{a.status}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{a.clientId}</td>
                    <td style={{ fontSize: 11 }}>{a.scopes.length}</td>
                    <td><button type="button" onClick={() => setPendingRotateId(a.id)}>Rotar secret</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <ConfirmDialog
        open={pendingRotateId !== null}
        title="¿Rotar el client_secret?"
        description="El secret anterior dejará de funcionar inmediatamente."
        confirmLabel="Rotar"
        variant="danger"
        onConfirm={() => void confirmRotate()}
        onCancel={() => setPendingRotateId(null)}
      />
    </section>
  );
}
