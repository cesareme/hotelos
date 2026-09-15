import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { useToast } from "../components/Toast";
import { getActivePropertyId } from "../services/activeProperty";
import { modulesPath, setPropertyModuleState, type PropertyModule, type PropertyModuleHealth, type PropertyModuleStatus } from "../services/modulesApi";
import { menuEntriesUnlockedBy } from "../navigation/nav-tree";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { pageHead } from "./tabs/configuracion/tab-helpers";
import { moduleCategoryLabel } from "./module-category-labels";

/**
 * Module Manager — wires the back-office modules grid to the real API:
 *   GET   /backoffice/properties/:propertyId/modules
 *   PATCH /backoffice/properties/:propertyId/modules/:moduleCode  { action: "enable" | "disable" }
 *
 * Core modules cannot be disabled (the backend enforces this; the UI mirrors it
 * by locking the toggle). A toggle goes through services/modulesApi.ts, which
 * invalidates the session cache of enabled modules and notifies the Sidebar
 * and the tab containers: an entry unlocked here appears without a reload.
 *
 * Tanda 5: base tab of Configuración › Módulos e integraciones (`embedded`),
 * visible to dirección and admin. Each card says which menu entries the module
 * unlocks, read from the navigation tree (nav-tree.generated.json, §6.2 of
 * pilots/tanda5-nav-tree.md) with the manifest's `menuEntries` as fallback, so
 * the list can never drift from the menu. «Activar módulo» in the Sidebar
 * opens this screen with `#modulo=<code>`: that card is highlighted and
 * scrolled into view.
 */

/** §6.2: modules whose data still lives in memory until L2 persists them. */
export const IN_MEMORY_MODULE_CODES: readonly string[] = ["guest_data_crm_loyalty", "reputation_quality", "procurement_inventory"];

export const IN_MEMORY_WARNING =
  "Los datos de Clientes y fidelización, Reputación y calidad y Compras e inventario se guardan por ahora en memoria: se pierden al reiniciar el servidor. Actívalos sabiendo que su persistencia llega en la siguiente entrega.";

/** Module code preselected through the URL hash (`#modulo=<code>`), or null. */
export function moduleCodeFromHash(hash: string): string | null {
  const match = /(?:^#|[#&])modulo=([^&]+)/.exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Menu entries (items, or tabs of an item) gated by this module code. */
function ModuleUnlocks({ module }: { module: PropertyModule }) {
  const unlocks = useMemo(() => menuEntriesUnlockedBy(module.code), [module.code]);
  if (unlocks.length > 0) {
    return (
      <p className="bo-muted" style={{ fontSize: 12 }}>
        Desbloquea en el menú:{" "}
        {unlocks.map((unlock, index) => (
          <span key={`${unlock.category.key}-${unlock.item.screenKey}`}>
            {index > 0 ? " · " : ""}
            {unlock.category.label} › {unlock.item.label}
            {unlock.wholeItem ? "" : ` (${unlock.tabs.map((tab) => tab.label).join(", ")})`}
          </span>
        ))}
      </p>
    );
  }
  const entries = module.menuEntries ?? [];
  if (entries.length === 0) return null;
  return (
    <p className="bo-muted" style={{ fontSize: 12 }}>
      Desbloquea en el menú:{" "}
      {entries.map((entry, index) => (
        <span key={`${entry.screenKey}-${entry.url}`}>
          {index > 0 ? " · " : ""}
          {entry.category ? `${entry.category} › ` : ""}
          {entry.label}
          {entry.tab ? ` (${entry.tab})` : ""}
        </span>
      ))}
    </p>
  );
}

const STATUS_LABEL: Record<PropertyModuleStatus, string> = {
  enabled: "Activo",
  disabled: "Inactivo",
  available: "Disponible"
};

function statusTone(status: PropertyModuleStatus): "ok" | "warn" | "info" {
  if (status === "enabled") return "ok";
  if (status === "disabled") return "warn";
  return "info";
}

function healthTone(health: PropertyModuleHealth): "ok" | "warn" | "error" {
  if (health === "ok") return "ok";
  if (health === "error") return "error";
  return "warn";
}

function healthLabel(health: PropertyModuleHealth): string {
  if (health === "ok") return "Salud OK";
  if (health === "error") return "Error";
  return "Configuración pendiente";
}

function readHashCode(): string | null {
  if (typeof window === "undefined") return null;
  return moduleCodeFromHash(window.location.hash);
}

export function ModuleManager({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const { showToast } = useToast();

  const { data, loading, error, refresh } = useApiData<PropertyModule[]>(modulesPath(propertyId));

  // Track which module codes have an in-flight toggle so we can disable just
  // those rows (not the entire grid) while the PATCH resolves.
  const [pending, setPending] = useState<Set<string>>(new Set());
  // «Activar módulo» from the menu lands here with #modulo=<code>.
  const [focusCode, setFocusCode] = useState<string | null>(() => readHashCode());

  useEffect(() => {
    function onHashChange() {
      setFocusCode(readHashCode());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const modules = data ?? [];
  const activeCount = modules.filter((m) => m.status === "enabled").length;
  const blockedCount = modules.filter((m) => m.healthStatus !== "ok").length;
  const focused = focusCode ? modules.find((m) => m.code === focusCode) ?? null : null;

  // Scroll the focused card into view once the cards exist, and again after the
  // container has settled (lazy chunk, KPI row, guide) — a single smooth scroll
  // at mount time was left 3 000 px above the card (browser-roles#15).
  const focusedCode = focused?.code ?? null;
  const cardCount = modules.length;
  useEffect(() => {
    if (!focusedCode || typeof document === "undefined") return undefined;
    const timers: number[] = [];
    let frame = 0;
    const reveal = (behavior: ScrollBehavior) => {
      const card = document.getElementById(`module-${focusedCode}`);
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const viewport = window.innerHeight || document.documentElement.clientHeight;
      const inView = rect.top >= 0 && rect.bottom <= viewport;
      if (!inView) card.scrollIntoView({ block: "center", behavior });
    };
    frame = window.requestAnimationFrame(() => reveal("auto"));
    for (const delay of [250, 900]) timers.push(window.setTimeout(() => reveal("smooth"), delay));
    return () => {
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [focusedCode, cardCount]);

  async function toggle(module: PropertyModule) {
    if (module.isCore) return;
    const nextAction: "enable" | "disable" = module.status === "enabled" ? "disable" : "enable";
    setPending((prev) => {
      const next = new Set(prev);
      next.add(module.code);
      return next;
    });
    try {
      await setPropertyModuleState(propertyId, module.code, nextAction);
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
      <Head
        eyebrow="Configuración"
        title="Módulos"
        subtitle="Activa, desactiva e inspecciona los módulos de la propiedad. Los módulos base no pueden desactivarse y las dependencias se validan en el servidor. Cada módulo indica qué entradas del menú desbloquea."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {loading ? <span className="bo-status info">{STATUS_LABELS.loading}</span> : null}
            {error ? <span className="bo-status error">{error}</span> : null}
            <button type="button" onClick={refresh} disabled={loading}>↻ {ACTIONS.refresh}</button>
          </div>
        }
      />

      <div
        role="note"
        data-module-warning="in-memory"
        style={{ fontSize: 13, padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--warn-soft, var(--surface-soft))", color: "var(--ink)" }}
      >
        {IN_MEMORY_WARNING}
      </div>

      {focusCode && !loading && !focused ? (
        <div role="status" style={{ fontSize: 13, padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-soft)", color: "var(--ink)" }}>
          El módulo «{focusCode}» no está disponible en esta propiedad.
        </div>
      ) : null}

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
          <p>Módulos con comprobaciones de salud fallidas o que requieren configuración.</p>
        </article>
      </div>

      <div className="bo-grid two">
        {modules.map((module) => {
          const busy = pending.has(module.code);
          const isOn = module.status === "enabled";
          const isFocused = focused?.code === module.code;
          const inMemory = IN_MEMORY_MODULE_CODES.includes(module.code);
          return (
            <article
              className="bo-card"
              key={module.code}
              id={`module-${module.code}`}
              data-module-code={module.code}
              data-module-status={module.status}
              style={isFocused ? { outline: "2px solid var(--accent, #6f3ad2)", outlineOffset: 2 } : undefined}
            >
              <div className="bo-card-head">
                <div>
                  <h3>{module.name}</h3>
                  <p className="bo-muted" style={{ marginTop: 2, fontSize: 12 }}>
                    {moduleCategoryLabel(module.category)}
                  </p>
                </div>
                <span className={`bo-status ${statusTone(module.status)}`}>
                  {STATUS_LABEL[module.status]}
                </span>
              </div>
              <p>{module.description}</p>
              <ModuleUnlocks module={module} />
              {inMemory ? (
                <p className="bo-muted" style={{ fontSize: 12 }} data-module-warning={module.code}>
                  Sus datos se guardan en memoria hasta la siguiente entrega: se pierden al reiniciar el servidor.
                </p>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className={`bo-status ${healthTone(module.healthStatus)}`}>
                  {healthLabel(module.healthStatus)}
                </span>
                {module.isCore ? <span className="bo-chip">base</span> : null}
                {module.dependencies.length ? (
                  <span className="bo-chip" title={`Depende de: ${module.dependencies.join(", ")}`}>
                    dependencias: {module.dependencies.length}
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
                  title={module.isCore ? "Los módulos base no pueden desactivarse" : undefined}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    checked={isOn}
                    disabled={module.isCore || busy || loading}
                    onChange={() => toggle(module)}
                    aria-label={isOn ? `Desactivar ${module.name}` : `${ACTIONS.enableModule}: ${module.name}`}
                  />
                  <span>{isOn ? "Activado" : "Desactivado"}</span>
                  {busy ? <span className="bo-status info">{STATUS_LABELS.saving}</span> : null}
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
