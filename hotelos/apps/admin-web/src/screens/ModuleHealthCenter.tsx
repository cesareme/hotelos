import { Fragment, useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest, ApiError } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { dateTime } from "../lib/format";

// =====================================================================================
// Módulos · Salud de módulos — wired to GET /backoffice/properties/:propertyId/modules
// (every module of the catalog with its activation status, health checks and the
// recommended next action) and POST …/modules/:code/recalculate-health.
// Activation/deactivation lives in ModuleManager; this screen is the health view.
// =====================================================================================

type ModuleStatus = "enabled" | "disabled" | "available";
type HealthStatus = "ok" | "needs_configuration" | "error";
type CheckSeverity = "info" | "warning" | "blocking";

type HealthCheck = {
  id: string;
  checkCode: string;
  status: HealthStatus;
  severity: CheckSeverity;
  message: string;
  updatedAt: string;
};

type BackOfficeModule = {
  code: string;
  name: string;
  category: string;
  description: string;
  isCore: boolean;
  status: ModuleStatus;
  healthStatus: HealthStatus;
  healthChecks: HealthCheck[];
  recommendedNextAction?: string;
};

type Filter = "all" | "enabled" | "attention";

const STATUS_LABEL: Record<ModuleStatus, string> = {
  enabled: "Activo",
  disabled: "Inactivo",
  available: "Disponible"
};

const HEALTH_LABEL: Record<HealthStatus, string> = {
  ok: "Correcto",
  needs_configuration: "Configuración pendiente",
  error: "Error"
};

const SEVERITY_LABEL: Record<CheckSeverity, string> = {
  info: "Info",
  warning: "Aviso",
  blocking: "Bloqueante"
};

function healthPill(health: HealthStatus) {
  const cls = health === "ok" ? "cm-pill-ok" : health === "error" ? "cm-pill-error" : "cm-pill-warn";
  return <span className={`cm-pill ${cls}`}>{HEALTH_LABEL[health] ?? health}</span>;
}

function statusPill(status: ModuleStatus) {
  const cls = status === "enabled" ? "cm-pill-ok" : status === "disabled" ? "cm-pill-warn" : "";
  return <span className={`cm-pill ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function fmtDateTime(value?: string): string {
  return dateTime(value);
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "No tienes permiso para recalcular la salud de módulos (modules.configure).";
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

export function ModuleHealthCenter({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: eyebrow and title are not painted.
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const { showToast } = useToast();
  const state = useApiData<BackOfficeModule[]>(`/backoffice/properties/${propertyId}/modules`);
  const [filter, setFilter] = useState<Filter>("enabled");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const modules = useMemo(() => toArray<BackOfficeModule>(state.data), [state.data]);
  const enabled = modules.filter((m) => m.status === "enabled");
  const attention = modules.filter((m) => m.status === "enabled" && m.healthStatus !== "ok");
  const blocking = modules.filter((m) => m.status === "enabled" && (m.healthChecks ?? []).some((c) => c.status !== "ok" && c.severity === "blocking"));

  const visible = modules.filter((m) => {
    if (filter === "enabled") return m.status === "enabled";
    if (filter === "attention") return m.status === "enabled" && m.healthStatus !== "ok";
    return true;
  });

  async function recalculate(module: BackOfficeModule) {
    if (pending.has(module.code)) return;
    setPending((prev) => new Set(prev).add(module.code));
    try {
      await apiRequest(`/backoffice/properties/${propertyId}/modules/${module.code}/recalculate-health`, { method: "POST" });
      showToast(`Salud de «${module.name}» recalculada.`, { variant: "success" });
      state.refresh();
    } catch (err) {
      showToast(errorMessage(err, `No se pudo recalcular la salud de «${module.name}».`), { variant: "error" });
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(module.code);
        return next;
      });
    }
  }

  async function recalculateAll() {
    const targets = modules.filter((m) => m.status === "enabled");
    for (const module of targets) {
      // Sequential on purpose: each call rewrites the module's checks server-side.
      await recalculate(module);
    }
  }

  function toggleExpanded(code: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  if (state.loading && !state.data) return <LoadingBlock label="Cargando salud de módulos…" />;
  if (state.error && !state.data) {
    return <ErrorState title="No se pudo cargar la salud de módulos" message={state.error} onRetry={state.refresh} />;
  }

  return (
    <>
      <div className="bo-page-head" style={{ marginBottom: "var(--space-6)" }}>
        <div className="bo-page-head-text">
          {embedded ? null : <div className="bo-page-eyebrow">Módulos e integraciones</div>}
          {embedded ? null : <h1 className="bo-page-title">Salud de módulos</h1>}
          <p className="bo-page-subtitle">
            Estado de configuración y comprobaciones de cada módulo activo. Activa o desactiva módulos desde el marketplace.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => navigateTo("ModuleManager")}>Marketplace de módulos</button>
          <button type="button" className="primary" onClick={recalculateAll} disabled={pending.size > 0 || enabled.length === 0}>
            {pending.size > 0 ? "Recalculando…" : "Recalcular todos los activos"}
          </button>
        </div>
      </div>

      <div className="bo-grid three" style={{ marginBottom: "var(--space-4)" }}>
        <article className="bo-card">
          <div className="bo-card-head"><h3>Módulos activos</h3></div>
          <div className="bo-metric">{enabled.length}</div>
          <p className="bo-muted" style={{ textTransform: "none" }}>de {modules.length} en el catálogo</p>
        </article>
        <article className="bo-card">
          <div className="bo-card-head"><h3>Con configuración pendiente</h3>{attention.length > 0 ? <span className="bo-status warn">Atención</span> : <span className="bo-status ok">Correcto</span>}</div>
          <div className="bo-metric">{attention.length}</div>
          <p className="bo-muted" style={{ textTransform: "none" }}>módulos activos con alguna comprobación no superada</p>
        </article>
        <article className="bo-card">
          <div className="bo-card-head"><h3>Bloqueantes</h3>{blocking.length > 0 ? <span className="bo-status error">Error</span> : <span className="bo-status ok">Correcto</span>}</div>
          <div className="bo-metric">{blocking.length}</div>
          <p className="bo-muted" style={{ textTransform: "none" }}>módulos con comprobaciones bloqueantes pendientes</p>
        </article>
      </div>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Comprobaciones por módulo</h3>
          <div className="bo-actions" style={{ margin: 0 }}>
            <button type="button" className={filter === "enabled" ? "primary" : "ghost"} onClick={() => setFilter("enabled")}>Activos</button>
            <button type="button" className={filter === "attention" ? "primary" : "ghost"} onClick={() => setFilter("attention")}>Con incidencias</button>
            <button type="button" className={filter === "all" ? "primary" : "ghost"} onClick={() => setFilter("all")}>Todos</button>
          </div>
        </div>
        {visible.length === 0 ? (
          <EmptyState
            title={filter === "attention" ? "Sin incidencias" : "Sin módulos"}
            message={
              filter === "attention"
                ? "Todos los módulos activos superan sus comprobaciones."
                : "No hay módulos que mostrar con este filtro."
            }
          />
        ) : (
          <div className="bo-table-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Módulo</th>
                  <th>Estado</th>
                  <th>Salud</th>
                  <th>Comprobaciones</th>
                  <th>Acción recomendada</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((module) => {
                  const checks = module.healthChecks ?? [];
                  const failing = checks.filter((c) => c.status !== "ok");
                  const isOpen = expanded.has(module.code);
                  const busy = pending.has(module.code);
                  return (
                    <Fragment key={module.code}>
                      <tr>
                        <td>
                          <strong>{module.name}</strong>
                          <div className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>{module.code}{module.isCore ? " · core" : ""}</div>
                        </td>
                        <td>{statusPill(module.status)}</td>
                        <td>{healthPill(module.healthStatus)}</td>
                        <td>
                          {checks.length === 0 ? (
                            <span className="bo-muted" style={{ textTransform: "none" }}>Sin comprobaciones registradas</span>
                          ) : (
                            <button type="button" className="ghost" onClick={() => toggleExpanded(module.code)} aria-expanded={isOpen}>
                              {failing.length}/{checks.length} pendientes {isOpen ? "▾" : "▸"}
                            </button>
                          )}
                        </td>
                        <td style={{ maxWidth: 320 }}>{module.recommendedNextAction ?? "—"}</td>
                        <td>
                          <button type="button" className="ghost" disabled={busy} onClick={() => recalculate(module)}>
                            {busy ? "Recalculando…" : "Recalcular"}
                          </button>
                        </td>
                      </tr>
                      {isOpen && checks.length > 0 ? (
                        <tr>
                          <td colSpan={6} style={{ background: "var(--surface-2, var(--surface-1))" }}>
                            <table className="cm-table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th>Comprobación</th>
                                  <th>Estado</th>
                                  <th>Severidad</th>
                                  <th>Detalle</th>
                                  <th>Actualizada</th>
                                </tr>
                              </thead>
                              <tbody>
                                {checks.map((check) => (
                                  <tr key={check.id}>
                                    <td>{check.checkCode}</td>
                                    <td>{healthPill(check.status)}</td>
                                    <td>{SEVERITY_LABEL[check.severity] ?? check.severity}</td>
                                    <td>{check.message}</td>
                                    <td className="bo-muted">{fmtDateTime(check.updatedAt)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
