// Catálogo de herramientas de IA — /configuracion/ia/herramientas (hosted in
// InteligenciaArtificialTabs; Cocoa 22 · ola 10 · lote 10-B, plantilla
// DashboardAlojado con lista).
//
// Every AI-backed tool defined in code (@hotelos/ai-tools) mirrored into
// AiToolRegistry (GET /ai-operations/tools, /tools/stats, POST /tools/sync)
// plus the per-property enablement / automation settings
// (GET /ai-operations/tools/:name, POST /tools/property-settings). KPI
// strip, content toolbar with the three filters, a CocoaTable whose rows
// open the tool in a CocoaDrawer with its definition and the per-property
// form. Same endpoints, queries and bodies as before.

import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

const AUTOMATION_LEVELS = ["off", "suggest", "suggest_and_confirm", "autonomous"] as const;
type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

// ---- types (mirror the service result shapes) -------------------------------

type ToolListItem = {
  toolName: string;
  moduleCode: string;
  moduleName: string;
  riskLevel: string;
  requiresConfirmation: boolean;
  active: boolean;
  inputSchemaVersion: string | null;
  outputSchemaVersion: string | null;
  createdAt: string;
  description: string | null;
  requiredPermissions: string[];
  inCode: boolean;
  propertySettingCount: number;
  enabledPropertyCount: number;
};

type PropertyToolSetting = {
  toolName: string;
  moduleCode: string;
  moduleName: string;
  riskLevel: string;
  description: string | null;
  requiredPermissions: string[];
  registryRequiresConfirmation: boolean;
  registryActive: boolean;
  configured: boolean;
  enabled: boolean;
  automationLevel: AutomationLevel;
  requiresConfirmation: boolean;
  requiresApprovalRole: string | null;
  configurationJson: Record<string, unknown>;
};

type ToolDetail = ToolListItem & { propertySettings: PropertyToolSetting[] };

type ToolRegistryStats = {
  totalTools: number;
  activeTools: number;
  inactiveTools: number;
  requiringConfirmation: number;
  pctRequiringConfirmation: number;
  byRisk: Record<RiskLevel, number>;
  byModule: Array<{ moduleCode: string; moduleName: string; count: number; active: number }>;
};

// ---- helpers ---------------------------------------------------------------

function fmtAutomation(level: string): string {
  switch (level) {
    case "off":
      return "Desactivado";
    case "suggest":
      return "Sugerir";
    case "suggest_and_confirm":
      return "Sugerir y confirmar";
    case "autonomous":
      return "Autónomo";
    default:
      return level;
  }
}

function fmtRisk(risk: string): string {
  switch (risk) {
    case "critical":
      return "crítico";
    case "high":
      return "alto";
    case "medium":
      return "medio";
    case "low":
      return "bajo";
    default:
      return risk;
  }
}

function riskTone(risk: string): CocoaTone {
  return risk === "critical" || risk === "high" ? "danger" : risk === "medium" ? "warning" : "success";
}

function riskBadge(risk: string) {
  return (
    <CocoaBadge tone={riskTone(risk)} variant="tinted" size="small">
      {fmtRisk(risk)}
    </CocoaBadge>
  );
}

function permissionChips(permissions: string[]) {
  if (permissions.length === 0) return <span className="cocoa-note">—</span>;
  return (
    <div className="cocoa-cluster">
      {permissions.map((perm) => (
        <CocoaBadge key={perm} tone="neutral" variant="outline" size="small" uppercase={false}>
          {perm}
        </CocoaBadge>
      ))}
    </div>
  );
}

// Mirror the backend guardrail client-side: critical/high tools cannot run
// autonomous without an approval role.
function autonomousBlocked(risk: string, automationLevel: string, approvalRole: string): boolean {
  return automationLevel === "autonomous" && (risk === "critical" || risk === "high") && !approvalRole.trim();
}

const AUTOMATION_OPTIONS = AUTOMATION_LEVELS.map((level) => ({ value: level, label: fmtAutomation(level) }));
const RISK_FILTER_OPTIONS = [{ value: "", label: "Todos los riesgos" }, ...RISK_LEVELS.map((r) => ({ value: r, label: fmtRisk(r) }))];

const TOOL_COLUMNS: CocoaTableColumn<ToolListItem>[] = [
  {
    key: "toolName",
    label: "Herramienta",
    minWidth: 200,
    render: (tool) => (
      <>
        <strong>{tool.toolName}</strong>
        {!tool.inCode ? <span className="cocoa-note">huérfana (sin definición en el código)</span> : null}
      </>
    )
  },
  { key: "moduleName", label: "Módulo", fit: true, hideOnNarrow: true },
  { key: "riskLevel", label: "Riesgo", fit: true, render: (tool) => riskBadge(tool.riskLevel) },
  {
    key: "requiresConfirmation",
    label: "Confirmación",
    fit: true,
    showFrom: "desktop", // qa#16: at 1024 × 768 the table ran 28 px past its wrap; the fit column (≈ 110 px) waits for desktop
    render: (tool) =>
      tool.requiresConfirmation ? (
        <CocoaBadge tone="warning" variant="tinted" size="small">
          obligatoria
        </CocoaBadge>
      ) : (
        <span className="cocoa-note">no</span>
      )
  },
  { key: "requiredPermissions", label: "Permisos", showFrom: "desktop", render: (tool) => permissionChips(tool.requiredPermissions) },
  {
    key: "active",
    label: "Activa",
    fit: true,
    render: (tool) => (
      <CocoaBadge tone={tool.active ? "success" : "neutral"} variant="tinted" size="small">
        {tool.active ? "activa" : "inactiva"}
      </CocoaBadge>
    )
  }
];

// ---- per-property settings editor ------------------------------------------

function PropertySettingEditor(props: { tool: ToolDetail; onSaved: () => void }) {
  const { tool } = props;
  const { showToast } = useToast();
  const existing = tool.propertySettings.find((s) => s.toolName === tool.toolName) ?? null;

  const [enabled, setEnabled] = useState<boolean>(existing?.enabled ?? true);
  const [automationLevel, setAutomationLevel] = useState<AutomationLevel>(existing?.automationLevel ?? "suggest_and_confirm");
  const [approvalRole, setApprovalRole] = useState<string>(existing?.requiresApprovalRole ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = autonomousBlocked(tool.riskLevel, automationLevel, approvalRole);
  const roleRequired = tool.riskLevel === "critical" || tool.riskLevel === "high";

  async function save() {
    setError(null);
    if (blocked) {
      setError(`El nivel de riesgo de la herramienta es «${fmtRisk(tool.riskLevel)}». La automatización autónoma requiere un rol que apruebe.`);
      return;
    }
    setSaving(true);
    try {
      await apiRequest("/ai-operations/tools/property-settings", {
        method: "POST",
        body: {
          propertyId: PROPERTY_ID,
          toolName: tool.toolName,
          enabled,
          automationLevel,
          requiresApprovalRole: approvalRole.trim() ? approvalRole.trim() : null
        }
      });
      showToast(STATUS_LABELS.saved, { variant: "success" });
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CocoaFormSection
      title="Configuración por propiedad"
      description={`Excepción de esta herramienta en ${getActiveProperty().propertyName}.`}
      actions={
        <CocoaButton variant="filled" tone="accent" size="small" disabled={saving || blocked} loading={saving} onClick={() => void save()}>
          {saving ? STATUS_LABELS.saving : "Guardar configuración"}
        </CocoaButton>
      }
    >
      <CocoaField label="Activada para esta propiedad" inline>
        <CocoaSwitch checked={enabled} onChange={setEnabled} />
      </CocoaField>
      <CocoaField label="Nivel de automatización" fullWidth>
        <CocoaSelect value={automationLevel} onChange={(v) => setAutomationLevel(v as AutomationLevel)} options={AUTOMATION_OPTIONS} />
      </CocoaField>
      <CocoaField
        label="Rol que aprueba"
        hint={roleRequired ? "obligatorio para el modo autónomo" : STATUS_LABELS.optional.toLowerCase()}
        error={blocked ? `Las herramientas con riesgo «${fmtRisk(tool.riskLevel)}» no pueden ejecutarse de forma autónoma sin un rol que apruebe.` : undefined}
        fullWidth
      >
        <CocoaInput value={approvalRole} onChange={setApprovalRole} placeholder="p. ej. revenue_manager" />
      </CocoaField>
      {error ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
          {error}
        </CocoaCallout>
      ) : null}
    </CocoaFormSection>
  );
}

// ---- detail drawer ---------------------------------------------------------

function ToolDetailDrawer(props: { toolName: string | null; onClose: () => void; onSettingSaved: () => void }) {
  const { data: tool, loading, error, refresh } = useApiData<ToolDetail>(props.toolName ? `/ai-operations/tools/${props.toolName}` : null);

  return (
    <CocoaDrawer
      open={props.toolName !== null}
      onClose={props.onClose}
      title={props.toolName ?? "Herramienta"}
      subtitle={tool ? `${tool.moduleName} (${tool.moduleCode}) · riesgo ${fmtRisk(tool.riskLevel)}` : undefined}
      side="right"
      size="lg"
      footer={
        <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose}>
          {ACTIONS.close}
        </CocoaButton>
      }
    >
      {loading && !tool ? (
        <CocoaSkeleton variant="text" lines={6} />
      ) : error && !tool ? (
        <CocoaState kind="error" title="No se pudo cargar la herramienta" message={error} onRetry={refresh} />
      ) : tool ? (
        <div className="cocoa-stack" data-gap="4">
          <CocoaSection title="Definición" padding="sm">
            <ul className="c22-section__list" aria-label="Definición de la herramienta">
              <li>
                <span>Módulo</span>
                <strong>
                  {tool.moduleName} ({tool.moduleCode})
                </strong>
              </li>
              <li>
                <span>Riesgo</span>
                {riskBadge(tool.riskLevel)}
              </li>
              <li>
                <span>Requiere confirmación</span>
                <strong>{tool.requiresConfirmation ? STATUS_LABELS.yes : STATUS_LABELS.no}</strong>
              </li>
              <li>
                <span>Activa</span>
                <strong>{tool.active ? STATUS_LABELS.yes : STATUS_LABELS.no}</strong>
              </li>
              <li>
                <span>En el código</span>
                <strong>{tool.inCode ? STATUS_LABELS.yes : "no (huérfana, sin definición en el código)"}</strong>
              </li>
              <li>
                <span>Propiedades configuradas</span>
                <strong>
                  {number(tool.enabledPropertyCount)}/{number(tool.propertySettingCount)} activadas
                </strong>
              </li>
            </ul>
            <p className="cocoa-note">{tool.description ?? "Sin descripción."}</p>
            <div className="cocoa-stack" data-gap="1">
              <span className="cocoa-caption">Permisos necesarios</span>
              {tool.requiredPermissions.length === 0 ? <span className="cocoa-note">ninguno</span> : permissionChips(tool.requiredPermissions)}
            </div>
          </CocoaSection>

          <PropertySettingEditor
            key={tool.toolName}
            tool={tool}
            onSaved={() => {
              refresh();
              props.onSettingSaved();
            }}
          />
        </div>
      ) : null}
    </CocoaDrawer>
  );
}

// ---- screen ----------------------------------------------------------------

export function AiToolRegistryScreen({ embedded = false }: { embedded?: boolean } = {}) {
  // Hosted (InteligenciaArtificialTabs): the container paints eyebrow + H1; `embedded` is the L1c bridge prop.
  const hosted = useTabHost() !== null || embedded;
  const { showToast } = useToast();
  const [moduleFilter, setModuleFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const query = useMemo(
    () => ({
      ...(moduleFilter ? { moduleCode: moduleFilter } : {}),
      ...(riskFilter ? { riskLevel: riskFilter } : {}),
      ...(search.trim() ? { search: search.trim() } : {})
    }),
    [moduleFilter, riskFilter, search]
  );

  const { data: tools, loading, error, refresh: refreshTools } = useApiData<ToolListItem[]>("/ai-operations/tools", { query });
  const { data: stats, refresh: refreshStats } = useApiData<ToolRegistryStats>("/ai-operations/tools/stats");

  const items = useMemo(() => toArray<ToolListItem>(tools), [tools]);
  const filtered = moduleFilter !== "" || riskFilter !== "" || search.trim() !== "";

  const moduleOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of toArray<ToolRegistryStats["byModule"][number]>(stats?.byModule)) map.set(m.moduleCode, m.moduleName);
    for (const t of items) map.set(t.moduleCode, t.moduleName);
    const sorted = [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return [{ value: "", label: "Todos los módulos" }, ...sorted.map(([code, name]) => ({ value: code, label: name }))];
  }, [stats, items]);

  function refreshAll() {
    refreshTools();
    refreshStats();
  }

  async function runSync() {
    setSyncing(true);
    try {
      const result = await apiRequest<{ synced: number; deactivated: number }>("/ai-operations/tools/sync", { method: "POST" });
      showToast(`Se sincronizaron ${plural(result.synced, "herramienta", "herramientas")} (${number(result.deactivated)} desactivadas).`, { variant: "success" });
      refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), { variant: "error" });
    } finally {
      setSyncing(false);
    }
  }

  function clearFilters() {
    setModuleFilter("");
    setRiskFilter("");
    setSearch("");
  }

  const ready = !error && !(loading && items.length === 0);

  return (
    <CocoaPage
      eyebrow="Configuración · Inteligencia artificial"
      title="Catálogo de herramientas de IA"
      subtitle={
        hosted
          ? undefined
          : "Catálogo de todas las herramientas con IA que la plataforma puede ejecutar, sincronizado desde el código. Revisa el riesgo y los permisos y, después, actívalas y ajusta la automatización por propiedad."
      }
      actions={
        <>
          <CocoaButton variant="filled" tone="accent" size="small" disabled={syncing} loading={syncing} onClick={() => void runSync()}>
            {syncing ? "Sincronizando…" : "Sincronizar catálogo desde el código"}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "ia-herramientas-sync", label: "Sincronizar el catálogo de herramientas de IA", run: () => void runSync() },
        { id: "ia-herramientas-refresh", label: "Actualizar el catálogo de herramientas de IA", run: refreshAll }
      ]}
    >
      {stats ? (
        <CocoaKpiStrip stagger aria-label="Resumen del catálogo">
          <CocoaKpi label="Total de herramientas" value={number(stats.totalTools)} caption={`${number(stats.activeTools)} activas · ${number(stats.inactiveTools)} inactivas`} polarity="neutral" status="ok" />
          <CocoaKpi label="Crítico / Alto" value={`${number(stats.byRisk.critical)} / ${number(stats.byRisk.high)}`} caption="herramientas de riesgo elevado" polarity="negative-good" status={stats.byRisk.critical > 0 ? "critical" : "ok"} />
          <CocoaKpi label="Medio / Bajo" value={`${number(stats.byRisk.medium)} / ${number(stats.byRisk.low)}`} caption="herramientas rutinarias" polarity="neutral" status="warning" />
          <CocoaKpi label="Requieren confirmación" value={percent(stats.pctRequiringConfirmation, { maximumFractionDigits: 0 })} caption={plural(stats.requiringConfirmation, "herramienta", "herramientas")} polarity="neutral" status="ok" />
          <CocoaKpi label="Activas" value={number(stats.activeTools)} caption="en el catálogo activo" polarity="positive-good" status="ok" />
        </CocoaKpiStrip>
      ) : (
        <CocoaSkeleton.Strip count={5} />
      )}

      <CocoaToolbar
        variant="content"
        aria-label="Filtros del catálogo"
        leftSlot={<CocoaSearchInput value={search} onChange={setSearch} debounceMs={250} placeholder="Nombre de herramienta, módulo o descripción…" aria-label="Buscar herramientas" />}
        rightSlot={
          <>
            <CocoaSelect value={moduleFilter} onChange={setModuleFilter} options={moduleOptions} inline aria-label="Filtrar por módulo" />
            <CocoaSelect value={riskFilter} onChange={setRiskFilter} options={RISK_FILTER_OPTIONS} inline aria-label="Filtrar por riesgo" />
          </>
        }
      />

      <CocoaSection title="Herramientas" meta={plural(items.length, "herramienta", "herramientas")} padding={ready && items.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {error ? (
          <CocoaState kind="error" title="No se pudo cargar el catálogo de herramientas" message={error} onRetry={refreshTools} />
        ) : !loading && items.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration={filtered ? "search" : "box"}
            title={filtered ? "Ninguna herramienta coincide con estos filtros" : "El catálogo está vacío"}
            message={filtered ? "Prueba con otro módulo, riesgo o texto." : "Sincroniza el catálogo desde el código para cargar las herramientas definidas."}
            primaryAction={filtered ? { label: ACTIONS.clearFilters, onClick: clearFilters } : { label: "Sincronizar catálogo desde el código", onClick: () => void runSync(), loading: syncing }}
          />
        ) : (
          <CocoaTable
            columns={TOOL_COLUMNS}
            rows={items}
            rowKey="toolName"
            loading={loading && items.length === 0}
            selectedKey={selectedTool ?? undefined}
            onSelect={(tool) => setSelectedTool(selectedTool === tool.toolName ? null : tool.toolName)}
            rowTone={(tool) => (tool.active ? undefined : "neutral")}
            rowTitle={() => "Abrir el detalle de la herramienta"}
            caption="Catálogo de herramientas de IA"
            aria-label="Catálogo de herramientas de IA"
          />
        )}
      </CocoaSection>

      <ToolDetailDrawer toolName={selectedTool} onClose={() => setSelectedTool(null)} onSettingSaved={refreshTools} />
    </CocoaPage>
  );
}
