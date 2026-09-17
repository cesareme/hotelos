import { useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest, ApiError } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
import { useToast } from "../components/Toast";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { EMPTY, dateTime, plural } from "../lib/format";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { useTabHost } from "./tabs/TabHost";
import { treeHeaderFor } from "./tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

// =====================================================================================
// Módulos · Salud de módulos — wired to GET /backoffice/properties/:propertyId/modules
// (every module of the catalog with its activation status, health checks and the
// recommended next action) and POST …/modules/:code/recalculate-health.
// Activation/deactivation lives in ModuleManager; this screen is the health view.
//
// Cocoa 22 · ola 10 · lote 10-C (dashboard archetype): CocoaPage → KPI strip →
// one section with the module table (segmented filter in its head, «Recalcular»
// per row) → the checks of a module open in a CocoaDrawer instead of the old
// nested table row. Calls and permissions are untouched.
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
  info: "Informativa",
  warning: "Aviso",
  blocking: "Bloqueante"
};

const FILTER_OPTIONS: Array<{ value: Filter; label: string }> = [
  { value: "enabled", label: "Activos" },
  { value: "attention", label: "Con incidencias" },
  { value: "all", label: STATUS_LABELS.all }
];

const HEADER = treeHeaderFor("ModuleHealthCenter", { eyebrow: "Configuración · Módulos e integraciones", title: "Salud de módulos" });

function healthTone(health: HealthStatus): CocoaTone {
  return health === "ok" ? "success" : health === "error" ? "danger" : "warning";
}

function statusTone(status: ModuleStatus): CocoaTone {
  return status === "enabled" ? "success" : status === "disabled" ? "warning" : "neutral";
}

function severityTone(severity: CheckSeverity): CocoaTone {
  return severity === "blocking" ? "danger" : severity === "warning" ? "warning" : "info";
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "No tienes permiso para recalcular la salud de módulos (modules.configure).";
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

// Columns outside the component (§4.2 A5); the row actions carry the per-row state.
const MODULE_COLUMNS: CocoaTableColumn<BackOfficeModule>[] = [
  {
    key: "name",
    label: "Módulo",
    minWidth: 200,
    render: (module) => (
      <span className="cocoa-stack" data-gap="1">
        <strong>{module.name}</strong>
        <span className="cocoa-note">
          {module.code}
          {module.isCore ? " · base" : ""}
        </span>
      </span>
    )
  },
  { key: "status", label: "Estado", fit: true, render: (module) => <CocoaBadge tone={statusTone(module.status)}>{STATUS_LABEL[module.status] ?? module.status}</CocoaBadge> },
  { key: "healthStatus", label: "Salud", fit: true, render: (module) => <CocoaBadge tone={healthTone(module.healthStatus)}>{HEALTH_LABEL[module.healthStatus] ?? module.healthStatus}</CocoaBadge> },
  {
    key: "checks",
    label: "Comprobaciones",
    fit: true,
    hideOnNarrow: true,
    render: (module) => {
      const checks = module.healthChecks ?? [];
      if (checks.length === 0) return <span className="cocoa-note">Sin comprobaciones registradas</span>;
      const failing = checks.filter((check) => check.status !== "ok").length;
      return `${failing}/${checks.length} pendientes`;
    }
  },
  { key: "recommendedNextAction", label: "Acción recomendada", showFrom: "desktop", render: (module) => module.recommendedNextAction ?? EMPTY }
];

function ModuleHealthPage() {
  // The host context decides the head (CocoaPage reads it).
  const hosted = useTabHost() !== null;
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const { showToast } = useToast();
  const modulesState = useApiData<BackOfficeModule[]>(`/backoffice/properties/${propertyId}/modules`);
  const [filter, setFilter] = useState<Filter>("enabled");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const modules = useMemo(() => toArray<BackOfficeModule>(modulesState.data), [modulesState.data]);
  const enabled = modules.filter((m) => m.status === "enabled");
  const attention = modules.filter((m) => m.status === "enabled" && m.healthStatus !== "ok");
  const blocking = modules.filter((m) => m.status === "enabled" && (m.healthChecks ?? []).some((c) => c.status !== "ok" && c.severity === "blocking"));

  const visible = modules.filter((m) => {
    if (filter === "enabled") return m.status === "enabled";
    if (filter === "attention") return m.status === "enabled" && m.healthStatus !== "ok";
    return true;
  });
  const selected = selectedCode ? modules.find((m) => m.code === selectedCode) ?? null : null;
  const selectedChecks = selected?.healthChecks ?? [];

  async function recalculate(module: BackOfficeModule) {
    if (pending.has(module.code)) return;
    setPending((prev) => new Set(prev).add(module.code));
    try {
      await apiRequest(`/backoffice/properties/${propertyId}/modules/${module.code}/recalculate-health`, { method: "POST" });
      showToast(`Salud de «${module.name}» recalculada.`, { variant: "success" });
      modulesState.refresh();
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

  const recalculating = pending.size > 0;
  const pageState = modulesState.loading && !modulesState.data ? "loading" : modulesState.error && !modulesState.data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Estado de configuración y comprobaciones de cada módulo activo. Los módulos se activan y desactivan desde Módulos e integraciones."
      actions={
        <>
          {hosted ? null : (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ModuleManager")}>
              Módulos e integraciones
            </CocoaButton>
          )}
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void recalculateAll()} disabled={recalculating || enabled.length === 0} loading={recalculating}>
            {recalculating ? "Recalculando…" : "Recalcular todos los activos"}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={
        <div className="cocoa-stack" data-gap="4" aria-hidden="true">
          <CocoaSkeleton.Strip count={3} min={200} />
          <CocoaSkeleton variant="card" height={320} />
        </div>
      }
      error={{ title: "No se pudo cargar la salud de módulos", message: modulesState.error ?? undefined, onRetry: modulesState.refresh }}
      commands={[{ id: "module-health-recalculate-all", label: "Recalcular la salud de todos los módulos activos", run: () => { void recalculateAll(); } }]}
    >
      <CocoaKpiStrip min={200} aria-label="Salud de módulos">
        <CocoaKpi label="Módulos activos" value={enabled.length} unit={`de ${modules.length}`} caption="en el catálogo" polarity="neutral" status="ok" />
        <CocoaKpi label="Con configuración pendiente" value={attention.length} caption="activos con alguna comprobación no superada" polarity="negative-good" status={attention.length > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Bloqueantes" value={blocking.length} caption="con comprobaciones bloqueantes pendientes" polarity="negative-good" status={blocking.length > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      {/* padding="none" + overflow clip: the table clips to the radius without creating a scroll container (§4.2 D26). */}
      <CocoaSection
        title="Comprobaciones por módulo"
        meta={plural(visible.length, "módulo", "módulos")}
        action={<CocoaSegmentedControl size="small" value={filter} onChange={(value) => setFilter(value as Filter)} options={FILTER_OPTIONS} aria-label="Filtrar módulos" panelId="module-health-checks" />}
        padding={visible.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {/* The filter tabs control this panel (qa#10: aria-controls on the active tab). */}
        <div id="module-health-checks" role="tabpanel" aria-label="Comprobaciones por módulo">
          {visible.length === 0 ? (
            <CocoaState kind="empty" inline title={filter === "attention" ? "Sin incidencias: todos los módulos activos superan sus comprobaciones." : "No hay módulos que mostrar con este filtro."} />
          ) : (
            <CocoaTable
              columns={MODULE_COLUMNS}
              rows={visible}
              rowKey="code"
              selectedKey={selectedCode ?? undefined}
              onSelect={(module) => setSelectedCode(module.code)}
              rowTitle={() => "Ver las comprobaciones del módulo"}
              rowActions={(module) => (
                <CocoaButton
                  variant="plain"
                  size="small"
                  loading={pending.has(module.code)}
                  disabled={pending.has(module.code)}
                  onClick={(event) => {
                    event.stopPropagation();
                    void recalculate(module);
                  }}
                >
                  {pending.has(module.code) ? "Recalculando…" : "Recalcular"}
                </CocoaButton>
              )}
              rowActionsVisible="always"
              caption="Comprobaciones por módulo"
              aria-label="Comprobaciones por módulo"
            />
          )}
        </div>
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelectedCode(null)}
        title={selected?.name ?? "Módulo"}
        subtitle={selected ? `${selected.code} · ${HEALTH_LABEL[selected.healthStatus] ?? selected.healthStatus}` : undefined}
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedCode(null)}>
              {ACTIONS.close}
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              disabled={!selected || pending.has(selected.code)}
              loading={selected ? pending.has(selected.code) : false}
              onClick={() => {
                if (selected) void recalculate(selected);
              }}
            >
              Recalcular
            </CocoaButton>
          </>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-cluster">
              <CocoaBadge tone={statusTone(selected.status)}>{STATUS_LABEL[selected.status] ?? selected.status}</CocoaBadge>
              <CocoaBadge tone={healthTone(selected.healthStatus)}>{HEALTH_LABEL[selected.healthStatus] ?? selected.healthStatus}</CocoaBadge>
              {selected.isCore ? <CocoaBadge tone="neutral">base</CocoaBadge> : null}
            </div>
            <p className="cocoa-note">{selected.description}</p>
            {selected.recommendedNextAction ? (
              <CocoaCallout tone="info" title="Acción recomendada">
                {selected.recommendedNextAction}
              </CocoaCallout>
            ) : null}
            {selectedChecks.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin comprobaciones registradas." />
            ) : (
              <ul className="c22-section__list" aria-label={`Comprobaciones de ${selected.name}`}>
                {selectedChecks.map((check) => (
                  <li key={check.id}>
                    <CocoaBadge tone={severityTone(check.severity)} variant="dot" size="small">
                      {SEVERITY_LABEL[check.severity] ?? check.severity}
                    </CocoaBadge>
                    <span className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <span>{check.checkCode}</span>
                      <span className="cocoa-note">{check.message}</span>
                      <span className="cocoa-note">{dateTime(check.updatedAt)}</span>
                    </span>
                    <CocoaBadge tone={healthTone(check.status)}>{HEALTH_LABEL[check.status] ?? check.status}</CocoaBadge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

// The page reads the host context (TabHost.tsx); the loader hands it over as it is.
export function ModuleHealthCenter() {
  return <ModuleHealthPage />;
}
