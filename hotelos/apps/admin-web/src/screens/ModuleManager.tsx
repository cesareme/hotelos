import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { useToast } from "../components/Toast";
import { getActivePropertyId } from "../services/activeProperty";
import { modulesPath, setPropertyModuleState, type PropertyModule, type PropertyModuleHealth, type PropertyModuleStatus } from "../services/modulesApi";
import { menuEntriesUnlockedBy } from "../navigation/nav-tree";
import { toArray } from "../utils/toArray";
import { plural } from "../lib/format";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { useTabHost } from "./tabs/TabHost";
import { treeHeaderFor } from "./tabs/tab-helpers";
import { moduleCategoryLabel } from "./module-category-labels";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  type CocoaTone
} from "../components/cocoa";

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
 * Tanda 5: base tab of Configuración › Módulos e integraciones (host context),
 * visible to dirección and admin. Each card says which menu entries the module
 * unlocks, read from the navigation tree (nav-tree.generated.json, §6.2 of
 * pilots/tanda5-nav-tree.md) with the manifest's `menuEntries` as fallback, so
 * the list can never drift from the menu. «Activar módulo» in the Sidebar
 * opens this screen with `#modulo=<code>`: that card is highlighted and
 * scrolled into view.
 *
 * Cocoa 22 · ola 10 · lote 10-C (form archetype): CocoaPage → in-memory
 * warning as a CocoaCallout → KPI strip → one CocoaSection per module on the
 * 12-column grid (status badge, what it unlocks, health, a CocoaSwitch to
 * activate it). Calls, hash handling and the scroll-into-view are untouched.
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
      <p className="cocoa-note">
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
    <p className="cocoa-note">
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

const HEADER = treeHeaderFor("ModuleManager", { eyebrow: "Configuración", title: "Módulos" });

function statusTone(status: PropertyModuleStatus): CocoaTone {
  if (status === "enabled") return "success";
  if (status === "disabled") return "warning";
  return "info";
}

function healthTone(health: PropertyModuleHealth): CocoaTone {
  if (health === "ok") return "success";
  if (health === "error") return "danger";
  return "warning";
}

function healthLabel(health: PropertyModuleHealth): string {
  if (health === "ok") return "Salud correcta";
  if (health === "error") return "Error";
  return "Configuración pendiente";
}

function readHashCode(): string | null {
  if (typeof window === "undefined") return null;
  return moduleCodeFromHash(window.location.hash);
}

function ModuleManagerPage() {
  // The host context decides the head (CocoaPage reads it).
  // Hosted, the container already describes the modules in its subtitle (§4.2 D20).
  const hosted = useTabHost() !== null;
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

  const modules = useMemo(() => toArray<PropertyModule>(data), [data]);
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
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle={hosted ? undefined : "Activa, desactiva e inspecciona los módulos de la propiedad. Los módulos base no pueden desactivarse y las dependencias se validan en el servidor. Cada módulo indica qué entradas del menú desbloquea."}
      actions={
        <>
          {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading} loading={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={
        <div className="cocoa-stack" data-gap="4" aria-hidden="true">
          <CocoaSkeleton.Strip count={2} min={200} />
          <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={220} />
        </div>
      }
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "module-manager-refresh", label: "Actualizar los módulos de la propiedad", run: refresh }]}
    >
      <div data-module-warning="in-memory">
        <CocoaCallout tone="warning" title="Datos guardados en memoria">
          {IN_MEMORY_WARNING}
        </CocoaCallout>
      </div>

      {focusCode && !loading && !focused ? (
        <CocoaCallout tone="info" role="status">
          El módulo «{focusCode}» no está disponible en esta propiedad.
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip min={200} aria-label="Resumen de módulos">
        <CocoaKpi label="Módulos activos" value={activeCount} unit={`de ${modules.length}`} caption="disponibles para esta propiedad" polarity="neutral" status="ok" />
        <CocoaKpi label="Pendientes de configuración" value={blockedCount} caption="con comprobaciones de salud fallidas o que requieren configuración" polarity="negative-good" status={blockedCount > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Módulos de la propiedad">
        {modules.map((module) => {
          const busy = pending.has(module.code);
          const isOn = module.status === "enabled";
          const isFocused = focused?.code === module.code;
          const inMemory = IN_MEMORY_MODULE_CODES.includes(module.code);
          return (
            <CocoaSpan cols={6} min={320} key={module.code}>
              <CocoaSection
                id={`module-${module.code}`}
                variant={isFocused ? "elevated" : "bordered"}
                title={module.name}
                meta={<CocoaBadge tone={statusTone(module.status)}>{STATUS_LABEL[module.status]}</CocoaBadge>}
              >
                <p className="cocoa-note">{moduleCategoryLabel(module.category)}</p>
                <p>{module.description}</p>
                <ModuleUnlocks module={module} />
                {inMemory ? (
                  <p className="cocoa-note" data-module-warning={module.code}>
                    Sus datos se guardan en memoria hasta la siguiente entrega: se pierden al reiniciar el servidor.
                  </p>
                ) : null}
                <div className="cocoa-cluster">
                  <CocoaBadge tone={healthTone(module.healthStatus)}>{healthLabel(module.healthStatus)}</CocoaBadge>
                  {module.isCore ? <CocoaBadge tone="neutral">base</CocoaBadge> : null}
                  {module.dependencies.length ? (
                    <CocoaBadge tone="neutral" title={`Depende de: ${module.dependencies.join(", ")}`}>
                      {plural(module.dependencies.length, "dependencia", "dependencias")}
                    </CocoaBadge>
                  ) : null}
                  {isFocused ? <CocoaBadge tone="accent">Seleccionado desde el menú</CocoaBadge> : null}
                </div>
                {module.recommendedNextAction && module.healthStatus !== "ok" ? (
                  <CocoaCallout tone="warning">{module.recommendedNextAction}</CocoaCallout>
                ) : null}
                <div className="cocoa-row" data-gap="2">
                  <CocoaSwitch
                    checked={isOn}
                    onChange={() => void toggle(module)}
                    disabled={module.isCore || busy || loading}
                    aria-label={isOn ? `${ACTIONS.deactivate} ${module.name}` : `${ACTIONS.enableModule}: ${module.name}`}
                  />
                  <span>{isOn ? STATUS_LABELS.enabled : STATUS_LABELS.disabled}</span>
                  {busy ? <CocoaBadge tone="info">{STATUS_LABELS.saving}</CocoaBadge> : null}
                  {module.isCore ? <span className="cocoa-note">Los módulos base no pueden desactivarse</span> : null}
                </div>
              </CocoaSection>
            </CocoaSpan>
          );
        })}
      </CocoaGrid>

      {!loading && modules.length === 0 ? (
        <CocoaSection aria-label="Sin módulos">
          <CocoaState kind="empty" title="No hay módulos disponibles para esta propiedad." />
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}

// The page reads the host context (TabHost.tsx); the loader hands it over as it is.
export function ModuleManager() {
  return <ModuleManagerPage />;
}
