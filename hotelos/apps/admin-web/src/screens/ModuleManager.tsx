import { useMemo, useState } from "react";
import { apiRequest } from "../services/api-client";
import { useApiData } from "../hooks/useApiData";
import { useToast } from "../components/Toast";
import { getActivePropertyId } from "../services/activeProperty";

/**
 * Module Manager — wires the back-office modules grid to the real API:
 *   GET   /backoffice/properties/:propertyId/modules
 *   PATCH /backoffice/properties/:propertyId/modules/:moduleCode  { action: "enable" | "disable" }
 *
 * Core modules cannot be disabled (the backend enforces this; the UI mirrors it
 * by locking the toggle). The toggle issues an optimistic-feeling PATCH and
 * refreshes the grid on success/failure.
 */

type ModuleStatus = "enabled" | "disabled" | "available";
type HealthStatus = "ok" | "needs_configuration" | "error";

type BackOfficeModule = {
  code: string;
  name: string;
  category: string;
  description: string;
  isCore: boolean;
  dependencies: string[];
  status: ModuleStatus;
  healthStatus: HealthStatus;
  recommendedNextAction?: string;
};

const STATUS_LABEL: Record<ModuleStatus, string> = {
  enabled: "Activo",
  disabled: "Inactivo",
  available: "Disponible"
};

function statusTone(status: ModuleStatus): "ok" | "warn" | "info" {
  if (status === "enabled") return "ok";
  if (status === "disabled") return "warn";
  return "info";
}

function healthTone(health: HealthStatus): "ok" | "warn" | "error" {
  if (health === "ok") return "ok";
  if (health === "error") return "error";
  return "warn";
}

function healthLabel(health: HealthStatus): string {
  if (health === "ok") return "Salud OK";
  if (health === "error") return "Error";
  return "Configuración pendiente";
}

export function ModuleManager() {
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const { showToast } = useToast();

  const { data, loading, error, refresh } = useApiData<BackOfficeModule[]>(
    `/backoffice/properties/${propertyId}/modules`
  );

  // Track which module codes have an in-flight toggle so we can disable just
  // those rows (not the entire grid) while the PATCH resolves.
  const [pending, setPending] = useState<Set<string>>(new Set());

  const modules = data ?? [];
  const activeCount = modules.filter((m) => m.status === "enabled").length;
  const blockedCount = modules.filter((m) => m.healthStatus !== "ok").length;

  async function toggle(module: BackOfficeModule) {
    if (module.isCore) return;
    const nextAction: "enable" | "disable" = module.status === "enabled" ? "disable" : "enable";
    setPending((prev) => {
      const next = new Set(prev);
      next.add(module.code);
      return next;
    });
    try {
      await apiRequest(`/backoffice/properties/${propertyId}/modules/${module.code}`, {
        method: "PATCH",
        body: { action: nextAction }
      });
      showToast(
        nextAction === "enable" ? `${module.name} activado` : `${module.name} desactivado`,
        { variant: "success" }
      );
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, { variant: "error" });
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(module.code);
        return next;
      });
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Modular suite
          </p>
          <h2>Module Manager</h2>
          <p className="bo-muted" style={{ marginTop: 4 }}>
            Activa, desactiva e inspecciona los módulos del hotel. Los módulos core no pueden
            desactivarse y las dependencias se validan en el backend.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {loading ? <span className="bo-status info">loading</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" onClick={refresh} disabled={loading}>Refresh</button>
        </div>
      </header>

      <div className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Módulos activos</h3>
            <span className="bo-status ok">ok</span>
          </div>
          <div className="bo-metric">{activeCount}</div>
          <p>De {modules.length} módulos disponibles para esta propiedad.</p>
        </article>
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Pendientes de configuración</h3>
            <span className={`bo-status ${blockedCount > 0 ? "warn" : "ok"}`}>
              {blockedCount > 0 ? "warn" : "ok"}
            </span>
          </div>
          <div className="bo-metric">{blockedCount}</div>
          <p>Módulos con health-checks fallidos o que requieren setup.</p>
        </article>
      </div>

      <div className="bo-grid two">
        {modules.map((module) => {
          const busy = pending.has(module.code);
          const isOn = module.status === "enabled";
          return (
            <article className="bo-card" key={module.code}>
              <div className="bo-card-head">
                <div>
                  <h3>{module.name}</h3>
                  <p className="bo-muted" style={{ marginTop: 2, fontSize: 12 }}>
                    {module.category} · {module.code}
                  </p>
                </div>
                <span className={`bo-status ${statusTone(module.status)}`}>
                  {STATUS_LABEL[module.status]}
                </span>
              </div>
              <p>{module.description}</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className={`bo-status ${healthTone(module.healthStatus)}`}>
                  {healthLabel(module.healthStatus)}
                </span>
                {module.isCore ? <span className="bo-chip">core</span> : null}
                {module.dependencies.length ? (
                  <span className="bo-chip" title={`Depende de: ${module.dependencies.join(", ")}`}>
                    deps: {module.dependencies.length}
                  </span>
                ) : null}
              </div>
              {module.recommendedNextAction && module.healthStatus !== "ok" ? (
                <p className="bo-muted" style={{ fontSize: 12 }}>
                  {module.recommendedNextAction}
                </p>
              ) : null}
              <div className="bo-actions" style={{ marginTop: 8 }}>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: module.isCore ? "not-allowed" : "pointer",
                    opacity: module.isCore ? 0.6 : 1
                  }}
                  title={module.isCore ? "Los módulos core no pueden desactivarse" : undefined}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    checked={isOn}
                    disabled={module.isCore || busy || loading}
                    onChange={() => toggle(module)}
                  />
                  <span>{isOn ? "Activado" : "Desactivado"}</span>
                  {busy ? <span className="bo-status info">saving…</span> : null}
                </label>
              </div>
            </article>
          );
        })}
        {!loading && modules.length === 0 ? (
          <article className="bo-card">
            <p className="bo-muted">No hay módulos disponibles para esta propiedad.</p>
          </article>
        ) : null}
      </div>
    </section>
  );
}
