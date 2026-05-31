// API Reference Screen — documentación pública navegable de la API.
//
// Directriz HotelOS (Nov 2026):
//   "Integraciones abiertas. HotelOS debe diseñarse como plataforma API-first."

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

type EndpointRef = {
  method: string;
  path: string;
  category: string;
  permissions: string[];
  riskLevel: string;
  description: string;
};

type CategoryGroup = {
  category: string;
  label: string;
  description: string;
  endpoints: EndpointRef[];
};

type Data = {
  generatedAt: string;
  manifestVersion: number;
  totalEndpoints: number;
  publicEndpoints: number;
  byMethod: { GET: number; POST: number; PATCH: number; DELETE: number };
  byRisk: { public: number; low: number; medium: number; high: number; critical: number };
  categories: CategoryGroup[];
};

const METHOD_COLOR: Record<string, string> = {
  GET: "#1f8a4c",
  POST: "#2663c4",
  PATCH: "#a47600",
  DELETE: "#d23b3b"
};

const RISK_COLOR: Record<string, string> = {
  public: "#1f8a4c",
  low: "#1f8a4c",
  medium: "#d29b00",
  high: "#d23b3b",
  critical: "#7a1212"
};

export function ApiReferenceScreen() {
  const { data, loading, error, refresh } = useApiData<Data>("/developer/api-reference");
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | "all">("all");
  const [selectedMethod, setSelectedMethod] = useState<string | "all">("all");

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.categories
      .filter((c) => selectedCategory === "all" || c.category === selectedCategory)
      .map((c) => ({
        ...c,
        endpoints: c.endpoints.filter((e) => {
          if (selectedMethod !== "all" && e.method !== selectedMethod) return false;
          if (q) {
            return e.path.toLowerCase().includes(q) ||
              e.description.toLowerCase().includes(q) ||
              e.permissions.some((p) => p.toLowerCase().includes(q));
          }
          return true;
        })
      }))
      .filter((c) => c.endpoints.length > 0);
  }, [data, query, selectedCategory, selectedMethod]);

  const visibleCount = filtered.reduce((s, c) => s + c.endpoints.length, 0);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Developer · API reference</div>
          <h1 className="bo-page-title">API HotelOS</h1>
          <p className="bo-page-subtitle">
            Generado automáticamente desde el route permission manifest — siempre sincronizado con el código en producción.
            {data ? ` ${data.totalEndpoints} endpoints en ${data.categories.length} categorías.` : null}
          </p>
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻</button>
        </div>
      </div>

      {/* Resumen */}
      {data ? (
        <div className="rev-kpi-grid">
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">Total endpoints</span></div>
            <div className="rev-kpi-value">{data.totalEndpoints}</div>
          </article>
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">Públicos (sin perm.)</span></div>
            <div className="rev-kpi-value">{data.publicEndpoints}</div>
          </article>
          <article className="rev-kpi rev-kpi-ok">
            <div className="rev-kpi-head"><span className="rev-kpi-label">GET / POST / PATCH / DELETE</span></div>
            <div className="rev-kpi-value" style={{ fontSize: 18 }}>
              {data.byMethod.GET} / {data.byMethod.POST} / {data.byMethod.PATCH} / {data.byMethod.DELETE}
            </div>
          </article>
          <article className={`rev-kpi ${data.byRisk.critical > 0 ? "rev-kpi-error" : "rev-kpi-ok"}`}>
            <div className="rev-kpi-head"><span className="rev-kpi-label">Por riesgo</span></div>
            <div className="rev-kpi-value" style={{ fontSize: 14 }}>
              {data.byRisk.public}p · {data.byRisk.low}L · {data.byRisk.medium}M · {data.byRisk.high}H · {data.byRisk.critical}C
            </div>
          </article>
        </div>
      ) : null}

      {/* Filters */}
      <article className="bo-card" style={{ background: "var(--surface)", position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="search"
            placeholder="Buscar por path, descripción o permiso…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: "0 0 320px", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13 }}
          />
          <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)} style={{ padding: 6 }}>
            <option value="all">Todas las categorías</option>
            {data?.categories.map((c) => (
              <option key={c.category} value={c.category}>{c.label} ({c.endpoints.length})</option>
            ))}
          </select>
          <select value={selectedMethod} onChange={(e) => setSelectedMethod(e.target.value)} style={{ padding: 6 }}>
            <option value="all">Todos los métodos</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
          <span className="bo-muted" style={{ fontSize: 12, marginLeft: "auto" }}>
            {visibleCount} endpoint{visibleCount === 1 ? "" : "s"} visibles
          </span>
        </div>
      </article>

      {/* Categories */}
      {filtered.map((cat) => (
        <article key={cat.category} className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <div>
              <h3 style={{ color: "var(--ink)", margin: 0 }}>{cat.label}</h3>
              <p className="bo-muted" style={{ fontSize: 12, margin: "2px 0 0 0" }}>{cat.description}</p>
            </div>
            <span className="bo-chip">{cat.endpoints.length} endpoints</span>
          </div>

          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {cat.endpoints.map((ep) => (
              <li
                key={`${ep.method}-${ep.path}`}
                style={{
                  padding: 10,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  display: "grid",
                  gridTemplateColumns: "80px 1fr auto",
                  gap: 10,
                  alignItems: "center"
                }}
              >
                <span
                  style={{
                    background: METHOD_COLOR[ep.method] ?? "#888",
                    color: "white",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    textAlign: "center"
                  }}
                >
                  {ep.method}
                </span>
                <div style={{ minWidth: 0 }}>
                  <code style={{ fontSize: 13, color: "var(--ink)", fontFamily: "monospace" }}>{ep.path}</code>
                  <div className="bo-muted" style={{ fontSize: 12, marginTop: 2 }}>{ep.description}</div>
                  {ep.permissions.length > 0 ? (
                    <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                      {ep.permissions.map((p) => (
                        <span key={p} className="bo-chip" style={{ fontSize: 10, fontFamily: "monospace" }}>
                          🔒 {p}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: 4 }}>
                      <span className="bo-chip" style={{ fontSize: 10, background: "rgba(31, 138, 76, 0.1)", color: "#1f8a4c" }}>
                        público
                      </span>
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: RISK_COLOR[ep.riskLevel] ?? "#888",
                    color: "white",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.5
                  }}
                >
                  {ep.riskLevel}
                </span>
              </li>
            ))}
          </ul>
        </article>
      ))}

      {filtered.length === 0 && data ? (
        <p className="bo-muted" style={{ padding: 32, textAlign: "center" }}>
          Sin endpoints que coincidan con la búsqueda.
        </p>
      ) : null}
    </>
  );
}
