// API Reference — Configuración › Sistema › Referencia de API (/configuracion/sistema/api).
//
// Public, browsable documentation of the API generated from the route
// permission manifest (GET /developer/api-reference): always in sync with
// the code that runs in production.
//
// Cocoa 22 (lote 10-A · dashboard alojado): CocoaPage → CocoaKpiStrip
// (totals by method and visibility) → CocoaToolbar sticky (search, category
// and method filters, visible count) → one CocoaSection per category with
// the endpoints as a `c22-section__list` (method badge · path · description ·
// permission badges · risk badge). Hosted in SistemaTabs the container
// paints the title: the host context (`useTabHost()`) is what decides.
//
// qa#17 (fix:10-A): the API derives most descriptions from the last path
// segment («Listar housekeeping settings.», api-reference.service.ts
// describe()), which repeats the path in a mix of languages. The screen only
// paints — and searches — a description that says more than that segment;
// the handwritten ones (check-in, cancel, preview…) stay. The real fix (a
// Spanish dictionary of segments) belongs to the API and re-enables them.

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { LockIcon } from "../../components/cocoa-icons/StatusIcons";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaToolbar,
  type CocoaTone
} from "../../components/cocoa";

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
  byMethod: { GET: number; POST: number; PATCH: number; DELETE: number; PUT: number };
  byRisk: { public: number; low: number; medium: number; high: number; critical: number };
  categories: CategoryGroup[];
};

const METHOD_TONE: Record<string, CocoaTone> = { GET: "success", POST: "info", PATCH: "warning", PUT: "warning", DELETE: "danger" };

const RISK: Record<string, { tone: CocoaTone; label: string }> = {
  public: { tone: "success", label: "público" },
  low: { tone: "success", label: "riesgo bajo" },
  medium: { tone: "warning", label: "riesgo medio" },
  high: { tone: "danger", label: "riesgo alto" },
  critical: { tone: "danger", label: "riesgo crítico" }
};

const METHOD_OPTIONS = [
  { value: "all", label: "Todos los métodos" },
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PATCH", label: "PATCH" },
  { value: "PUT", label: "PUT" },
  { value: "DELETE", label: "DELETE" }
];

/**
 * Description worth painting: null when the API only echoed the method and
 * the path («PUT /fiscal/vat-settings») or the last path segment («Listar
 * rooms.», «Obtener detalle de :id.»), which the method badge and the
 * monospace path already say.
 */
function endpointDescription(ep: Pick<EndpointRef, "method" | "path" | "description">): string | null {
  const text = (ep.description ?? "").trim();
  if (!text || text === `${ep.method} ${ep.path}`) return null;
  const last = ep.path.split("/").filter(Boolean).pop() ?? "";
  const echoed = last.replace(/-/g, " ").toLowerCase();
  if (echoed && text.toLowerCase().endsWith(` ${echoed}.`)) return null;
  return text;
}

export function ApiReferenceScreen() {
  const hosted = useTabHost() !== null;
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
            const description = endpointDescription(e);
            return e.path.toLowerCase().includes(q) || (description !== null && description.toLowerCase().includes(q)) || e.permissions.some((p) => p.toLowerCase().includes(q));
          }
          return true;
        })
      }))
      .filter((c) => c.endpoints.length > 0);
  }, [data, query, selectedCategory, selectedMethod]);

  const visibleCount = filtered.reduce((s, c) => s + c.endpoints.length, 0);
  const filtersActive = query.trim() !== "" || selectedCategory !== "all" || selectedMethod !== "all";

  const categoryOptions = useMemo(
    () => [{ value: "all", label: "Todas las categorías" }, ...(data?.categories ?? []).map((c) => ({ value: c.category, label: `${c.label} (${c.endpoints.length})` }))],
    [data]
  );

  const summary = data ? `${plural(data.totalEndpoints, "endpoint", "endpoints")} en ${plural(data.categories.length, "categoría", "categorías")}.` : "";

  return (
    <CocoaPage
      eyebrow="Configuración · Sistema"
      title="Referencia de la API"
      subtitle={hosted ? undefined : `Generada automáticamente desde el manifiesto de permisos de rutas: siempre sincronizada con el código en producción. ${summary}`.trim()}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<CocoaSkeleton.Strip count={6} label="Cargando referencia de la API" />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "api-reference-refresh", label: `${ACTIONS.refresh} referencia de la API`, run: refresh }]}
    >
      {data ? (
        <CocoaKpiStrip stagger aria-label="Resumen de la API">
          <CocoaKpi label="Endpoints" value={number(data.totalEndpoints)} caption={plural(data.categories.length, "categoría", "categorías")} size="compact" />
          <CocoaKpi label="Públicos" value={number(data.publicEndpoints)} caption="sin permiso requerido" size="compact" />
          <CocoaKpi label="GET" value={number(data.byMethod.GET)} size="compact" />
          <CocoaKpi label="POST" value={number(data.byMethod.POST)} size="compact" />
          <CocoaKpi label="PATCH" value={number(data.byMethod.PATCH)} size="compact" />
          <CocoaKpi label="PUT" value={number(data.byMethod.PUT ?? 0)} size="compact" />
          <CocoaKpi label="DELETE" value={number(data.byMethod.DELETE)} size="compact" />
          <CocoaKpi
            label="Riesgo alto o crítico"
            value={number(data.byRisk.high + data.byRisk.critical)}
            caption={`${number(data.byRisk.medium)} medio · ${number(data.byRisk.low + data.byRisk.public)} bajo o público`}
            status={data.byRisk.critical > 0 ? "warning" : "ok"}
            size="compact"
          />
        </CocoaKpiStrip>
      ) : null}

      <CocoaToolbar
        variant="content"
        sticky
        aria-label="Filtros de la referencia"
        leftSlot={<CocoaSearchInput value={query} onChange={setQuery} placeholder="Ruta, descripción o permiso…" aria-label="Buscar endpoints por ruta, descripción o permiso" />}
        rightSlot={
          <>
            <CocoaSelect value={selectedCategory} onChange={setSelectedCategory} options={categoryOptions} inline aria-label="Filtrar por categoría" />
            <CocoaSelect value={selectedMethod} onChange={setSelectedMethod} options={METHOD_OPTIONS} inline aria-label="Filtrar por método" />
            <span className="cocoa-note" role="status">
              {plural(visibleCount, "endpoint visible", "endpoints visibles")}
            </span>
          </>
        }
      />

      {filtered.map((cat) => (
        <CocoaSection key={cat.category} title={cat.label} meta={plural(cat.endpoints.length, "endpoint", "endpoints")}>
          {cat.description ? <p className="cocoa-note">{cat.description}</p> : null}
          <ul className="c22-section__list" aria-label={`Endpoints de ${cat.label}`}>
            {cat.endpoints.map((ep) => {
              const risk = RISK[ep.riskLevel] ?? { tone: "neutral" as CocoaTone, label: ep.riskLevel };
              const description = endpointDescription(ep);
              return (
                <li key={`${ep.method}-${ep.path}`}>
                  <div className="cocoa-stack" data-gap="1" style={{ minWidth: 0 }}>
                    <span className="cocoa-cluster">
                      <CocoaBadge tone={METHOD_TONE[ep.method] ?? "neutral"} variant="tinted" size="small">
                        {ep.method}
                      </CocoaBadge>
                      <code className="cocoa-mono">{ep.path}</code>
                    </span>
                    {description ? <span className="cocoa-note">{description}</span> : null}
                    {ep.permissions.length > 0 ? (
                      <span className="cocoa-cluster" aria-label="Permisos requeridos">
                        {ep.permissions.map((p) => (
                          <CocoaBadge key={p} tone="neutral" size="small" uppercase={false} icon={<LockIcon size={10} aria-hidden />}>
                            {p}
                          </CocoaBadge>
                        ))}
                      </span>
                    ) : (
                      <CocoaBadge tone="success" size="small" style={{ alignSelf: "flex-start" }}>
                        público
                      </CocoaBadge>
                    )}
                  </div>
                  <CocoaBadge tone={risk.tone} size="small">
                    {risk.label}
                  </CocoaBadge>
                </li>
              );
            })}
          </ul>
        </CocoaSection>
      ))}

      {filtered.length === 0 && data ? (
        <CocoaSection aria-label="Sin resultados">
          <CocoaState
            kind="empty"
            illustration="search"
            title={STATUS_LABELS.noResults}
            message="Ningún endpoint coincide con la búsqueda o los filtros."
            primaryAction={
              filtersActive
                ? {
                    label: ACTIONS.clearFilters,
                    onClick: () => {
                      setQuery("");
                      setSelectedCategory("all");
                      setSelectedMethod("all");
                    }
                  }
                : undefined
            }
          />
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}
