import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { LoadingBlock } from "../../components/States";

// ---- Sprint 47 — AI Tool Registry ----
// Catalog of every AI-backed tool defined in code (@hotelos/ai-tools) mirrored
// into AiToolRegistry, plus per-property enablement / automation settings.
// Aurora v2 styling (rev-kpi / bo-card / cm-table / cm-pill), consistent with
// the rest of the AI Operations zone. Wiring into App/Sidebar is done by the
// orchestrator — this component only exports cleanly.

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

function riskPill(risk: string) {
  const cls =
    risk === "critical" || risk === "high"
      ? "cm-pill-error"
      : risk === "medium"
        ? "cm-pill-warn"
        : "cm-pill-ok";
  return <span className={`cm-pill ${cls}`}>{fmtRisk(risk)}</span>;
}

// Mirror the backend guardrail client-side: critical/high tools cannot run
// autonomous without an approval role.
function autonomousBlocked(risk: string, automationLevel: string, approvalRole: string): boolean {
  return (
    automationLevel === "autonomous" &&
    (risk === "critical" || risk === "high") &&
    !approvalRole.trim()
  );
}

// ---- per-property settings editor ------------------------------------------

function PropertySettingEditor(props: {
  tool: ToolDetail;
  onSaved: () => void;
}) {
  const { tool } = props;
  const existing = tool.propertySettings.find((s) => s.toolName === tool.toolName) ?? null;

  const [enabled, setEnabled] = useState<boolean>(existing?.enabled ?? true);
  const [automationLevel, setAutomationLevel] = useState<AutomationLevel>(
    existing?.automationLevel ?? "suggest_and_confirm"
  );
  const [approvalRole, setApprovalRole] = useState<string>(existing?.requiresApprovalRole ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const blocked = autonomousBlocked(tool.riskLevel, automationLevel, approvalRole);

  async function save() {
    setError(null);
    setMessage(null);
    if (blocked) {
      setError(
        `El nivel de riesgo de la herramienta es "${fmtRisk(tool.riskLevel)}". La automatización autónoma requiere un rol que apruebe.`
      );
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
      setMessage("Guardado.");
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="bo-muted">Configuración por propiedad · {PROPERTY_ID}</p>

      <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.75rem" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Activada para esta propiedad</span>
      </label>

      <label style={{ display: "block", marginBottom: "0.75rem" }}>
        <span className="bo-muted">Nivel de automatización</span>
        <select
          value={automationLevel}
          onChange={(e) => setAutomationLevel(e.target.value as AutomationLevel)}
          style={{ width: "100%" }}
        >
          {AUTOMATION_LEVELS.map((level) => (
            <option key={level} value={level}>
              {fmtAutomation(level)}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "block", marginBottom: "0.75rem" }}>
        <span className="bo-muted">
          Rol que aprueba {tool.riskLevel === "critical" || tool.riskLevel === "high" ? "(obligatorio para modo autónomo)" : "(opcional)"}
        </span>
        <input
          type="text"
          value={approvalRole}
          onChange={(e) => setApprovalRole(e.target.value)}
          style={{ width: "100%" }}
          placeholder="p. ej. revenue_manager"
        />
      </label>

      {blocked ? (
        <p style={{ color: "var(--danger-ink)" }}>
          {`Las herramientas con nivel de riesgo "${fmtRisk(tool.riskLevel)}" no pueden ejecutarse de forma autónoma sin un rol que apruebe.`}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" className="primary" disabled={saving || blocked} onClick={save}>
          {saving ? "Guardando…" : "Guardar configuración"}
        </button>
      </div>

      {error ? <p style={{ color: "var(--danger-ink)" }}>{error}</p> : null}
      {message ? <p className="bo-muted">{message}</p> : null}
    </div>
  );
}

// ---- detail side panel -----------------------------------------------------

function ToolDetailPanel(props: { toolName: string; onClose: () => void; onSettingSaved: () => void }) {
  const { data: tool, loading, error, refresh } = useApiData<ToolDetail>(
    `/ai-operations/tools/${props.toolName}`
  );

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Detalle de la herramienta</p>
          <h3>{props.toolName}</h3>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {tool ? riskPill(tool.riskLevel) : null}
          <button type="button" className="ghost" onClick={props.onClose}>
            Cerrar
          </button>
        </div>
      </div>

      {loading && !tool ? <LoadingBlock /> : null}
      {error ? <p style={{ color: "var(--danger-ink)" }}>{error}</p> : null}

      {tool ? (
        <div className="bo-grid two">
          <div>
            <p className="bo-muted">Definición</p>
            <div className="dp-table">
              <div className="dp-row">
                <span className="dp-key">módulo</span>
                <span className="dp-val">{tool.moduleName} ({tool.moduleCode})</span>
              </div>
              <div className="dp-row">
                <span className="dp-key">riesgo</span>
                <span className="dp-val">{fmtRisk(tool.riskLevel)}</span>
              </div>
              <div className="dp-row">
                <span className="dp-key">requiere confirmación</span>
                <span className="dp-val">{tool.requiresConfirmation ? "sí" : "no"}</span>
              </div>
              <div className="dp-row">
                <span className="dp-key">activa</span>
                <span className="dp-val">{tool.active ? "sí" : "no"}</span>
              </div>
              <div className="dp-row">
                <span className="dp-key">en el código</span>
                <span className="dp-val">{tool.inCode ? "sí" : "no (huérfana, sin definición en el código)"}</span>
              </div>
              <div className="dp-row">
                <span className="dp-key">propiedades configuradas</span>
                <span className="dp-val">{tool.enabledPropertyCount}/{tool.propertySettingCount} activadas</span>
              </div>
            </div>

            <p className="bo-muted" style={{ marginTop: "1rem" }}>Descripción</p>
            <p>{tool.description ?? "—"}</p>

            <p className="bo-muted" style={{ marginTop: "1rem" }}>Permisos necesarios</p>
            <div className="bo-pill-row">
              {tool.requiredPermissions.length === 0 ? (
                <span className="bo-muted">ninguno</span>
              ) : (
                tool.requiredPermissions.map((perm) => (
                  <span key={perm} className="bo-pill">
                    {perm}
                  </span>
                ))
              )}
            </div>
          </div>

          <PropertySettingEditor
            tool={tool}
            onSaved={() => {
              refresh();
              props.onSettingSaved();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

// ---- screen ----------------------------------------------------------------

export function AiToolRegistryScreen() {
  const [moduleFilter, setModuleFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      ...(moduleFilter ? { moduleCode: moduleFilter } : {}),
      ...(riskFilter ? { riskLevel: riskFilter } : {}),
      ...(search.trim() ? { search: search.trim() } : {})
    }),
    [moduleFilter, riskFilter, search]
  );

  const { data: tools, loading, error, refresh: refreshTools } = useApiData<ToolListItem[]>(
    "/ai-operations/tools",
    { query }
  );
  const { data: stats, refresh: refreshStats } = useApiData<ToolRegistryStats>("/ai-operations/tools/stats");

  const items = tools ?? [];

  const moduleOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of stats?.byModule ?? []) map.set(m.moduleCode, m.moduleName);
    for (const t of items) map.set(t.moduleCode, t.moduleName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [stats, items]);

  function refreshAll() {
    refreshTools();
    refreshStats();
  }

  async function runSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const result = await apiRequest<{ synced: number; deactivated: number }>(
        "/ai-operations/tools/sync",
        { method: "POST" }
      );
      setSyncMessage(`Se sincronizaron ${result.synced} herramientas (${result.deactivated} desactivadas).`);
      refreshAll();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">IA · Catálogo de herramientas</div>
          <h1 className="bo-page-title">Catálogo de herramientas de IA</h1>
          <p className="bo-page-subtitle">
            Catálogo de todas las herramientas con IA que la plataforma puede ejecutar, sincronizado
            desde el código. Revisa el riesgo y los permisos y, después, actívalas y ajusta la
            automatización por propiedad.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="primary" disabled={syncing} onClick={runSync}>
            {syncing ? "Sincronizando…" : "Sincronizar catálogo desde el código"}
          </button>
          <button type="button" className="ghost" onClick={refreshAll}>↻ Actualizar</button>
        </div>
      </div>

      {syncError ? <p style={{ color: "var(--danger-ink)" }}>{syncError}</p> : null}
      {syncMessage ? <p className="bo-muted">{syncMessage}</p> : null}

      {error ? (
        <section className="bo-card" style={{ borderColor: "var(--danger-ink)" }}>
          No se pudo cargar el catálogo de herramientas ahora mismo. Actualiza para reintentar.
        </section>
      ) : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total de herramientas</span></div>
          <div className="rev-kpi-value">{stats?.totalTools ?? "…"}</div>
          <div className="rev-kpi-delta">{stats?.activeTools ?? 0} activas · {stats?.inactiveTools ?? 0} inactivas</div>
        </article>
        <article className={`rev-kpi rev-kpi-${stats && stats.byRisk.critical > 0 ? "error" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Crítico / Alto</span></div>
          <div className="rev-kpi-value">
            {stats ? `${stats.byRisk.critical} / ${stats.byRisk.high}` : "…"}
          </div>
          <div className="rev-kpi-delta">herramientas de riesgo elevado</div>
        </article>
        <article className="rev-kpi rev-kpi-warn">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Medio / Bajo</span></div>
          <div className="rev-kpi-value">
            {stats ? `${stats.byRisk.medium} / ${stats.byRisk.low}` : "…"}
          </div>
          <div className="rev-kpi-delta">herramientas rutinarias</div>
        </article>
        <article className="rev-kpi">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Requieren confirmación</span></div>
          <div className="rev-kpi-value">{stats ? `${stats.pctRequiringConfirmation}%` : "…"}</div>
          <div className="rev-kpi-delta">{stats?.requiringConfirmation ?? 0} herramientas</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Activas</span></div>
          <div className="rev-kpi-value">{stats?.activeTools ?? "…"}</div>
          <div className="rev-kpi-delta">en el catálogo activo</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Filtros</p>
            <h3>Herramientas</h3>
          </div>
          <span className="bo-chip">{items.length} herramientas</span>
        </div>

        <div className="bo-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
          <label>
            <span className="bo-muted" style={{ marginRight: "0.4rem" }}>Módulo</span>
            <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
              <option value="">Todos los módulos</option>
              {moduleOptions.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="bo-muted" style={{ marginRight: "0.4rem" }}>Riesgo</span>
            <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
              <option value="">Todos los riesgos</option>
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>{fmtRisk(r)}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: "1 1 220px" }}>
            <span className="bo-muted" style={{ marginRight: "0.4rem" }}>Buscar</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nombre de herramienta, módulo o descripción…"
              style={{ minWidth: "180px" }}
            />
          </label>
        </div>

        {loading && items.length === 0 ? (
          <LoadingBlock label="Cargando herramientas…" />
        ) : items.length === 0 ? (
          <p className="bo-muted">Ninguna herramienta coincide con estos filtros. Sincroniza el catálogo desde el código si parece vacío.</p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Herramienta</th>
                  <th>Módulo</th>
                  <th>Riesgo</th>
                  <th>Confirmación</th>
                  <th>Permisos</th>
                  <th>Activa</th>
                </tr>
              </thead>
              <tbody>
                {items.map((tool) => (
                  <tr
                    key={tool.toolName}
                    className={tool.active ? undefined : "cm-row-error"}
                    onClick={() => setSelectedTool(selectedTool === tool.toolName ? null : tool.toolName)}
                    style={{ cursor: "pointer", opacity: tool.active ? 1 : 0.6 }}
                  >
                    <td>
                      <strong>{tool.toolName}</strong>
                      {!tool.inCode ? <span className="bo-muted"> · huérfana (sin definición en el código)</span> : null}
                    </td>
                    <td>{tool.moduleName}</td>
                    <td>{riskPill(tool.riskLevel)}</td>
                    <td>
                      {tool.requiresConfirmation ? (
                        <span className="cm-pill cm-pill-warn">obligatoria</span>
                      ) : (
                        <span className="bo-muted">no</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="bo-pill-row">
                        {tool.requiredPermissions.length === 0 ? (
                          <span className="bo-muted">—</span>
                        ) : (
                          tool.requiredPermissions.map((perm) => (
                            <span key={perm} className="bo-pill">{perm}</span>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`cm-pill ${tool.active ? "cm-pill-ok" : "cm-pill-error"}`}>
                        {tool.active ? "activa" : "inactiva"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedTool ? (
        <ToolDetailPanel
          toolName={selectedTool}
          onClose={() => setSelectedTool(null)}
          onSettingSaved={refreshTools}
        />
      ) : null}
    </>
  );
}
