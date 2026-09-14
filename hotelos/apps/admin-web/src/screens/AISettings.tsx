import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../hooks/useApiData";
import { apiRequest, ApiError } from "../services/api-client";
import { getActivePropertyId } from "../services/activeProperty";
import { useToast } from "../components/Toast";
import { ErrorState, LoadingBlock } from "../components/States";
import { navigateTo } from "../lib/navigate";

// =====================================================================================
// IA · Ajustes de IA — wired to GET/PATCH /backoffice/properties/:propertyId/ai-settings.
// The three editable fields the API exposes (aiEnabled, defaultAutomationLevel,
// guestFacingDisclosure) are shown as a form; everything else on screen is read
// from the same response (provisioned flag, per-tool overrides). Nothing here
// is static copy pretending to be property state.
// =====================================================================================

type AutomationLevel = "off" | "draft_only" | "suggest_and_confirm" | "auto_low_risk" | "auto_within_rules";

type AiSettings = {
  id: string;
  propertyId: string;
  aiEnabled: boolean;
  defaultAutomationLevel: AutomationLevel;
  guestFacingDisclosure?: string | null;
  voiceLocales: string[];
  configurationJson: Record<string, unknown>;
  updatedAt: string;
};

type AiToolSetting = {
  id: string;
  toolName: string;
  enabled: boolean;
  automationLevel: AutomationLevel;
  requiresConfirmation: boolean;
  requiresApprovalRole?: string;
};

type AiSettingsResponse = {
  settings: AiSettings;
  provisioned: boolean;
  toolSettings: AiToolSetting[];
};

const AUTOMATION_LEVELS: Array<{ value: AutomationLevel; label: string; help: string }> = [
  { value: "off", label: "Desactivado", help: "La IA no propone ni ejecuta acciones." },
  { value: "draft_only", label: "Solo borradores", help: "La IA redacta propuestas; una persona las envía." },
  { value: "suggest_and_confirm", label: "Sugerir y confirmar", help: "Cada acción requiere confirmación humana." },
  { value: "auto_low_risk", label: "Automático (bajo riesgo)", help: "Ejecuta sola las acciones de bajo riesgo; el resto pide confirmación." },
  { value: "auto_within_rules", label: "Automático dentro de reglas", help: "Ejecuta sola todo lo que cumpla las reglas de gobernanza." }
];

function automationLabel(level: string): string {
  return AUTOMATION_LEVELS.find((option) => option.value === level)?.label ?? level;
}

function fmtDateTime(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "No tienes permiso para cambiar los ajustes de IA (ai.configure).";
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

export function AISettings() {
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const { showToast } = useToast();
  const state = useApiData<AiSettingsResponse>(`/backoffice/properties/${propertyId}/ai-settings`);

  const [aiEnabled, setAiEnabled] = useState(false);
  const [automationLevel, setAutomationLevel] = useState<AutomationLevel>("suggest_and_confirm");
  const [disclosure, setDisclosure] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seed the form from the server each time the settings load/refresh.
  useEffect(() => {
    const settings = state.data?.settings;
    if (!settings) return;
    setAiEnabled(Boolean(settings.aiEnabled));
    setAutomationLevel(settings.defaultAutomationLevel);
    setDisclosure(settings.guestFacingDisclosure ?? "");
  }, [state.data]);

  const settings = state.data?.settings ?? null;
  const dirty =
    settings !== null &&
    (aiEnabled !== Boolean(settings.aiEnabled) ||
      automationLevel !== settings.defaultAutomationLevel ||
      disclosure !== (settings.guestFacingDisclosure ?? ""));

  async function save() {
    if (!settings || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiRequest(`/backoffice/properties/${propertyId}/ai-settings`, {
        method: "PATCH",
        body: {
          aiEnabled,
          defaultAutomationLevel: automationLevel,
          guestFacingDisclosure: disclosure
        }
      });
      showToast("Ajustes de IA guardados.", { variant: "success" });
      state.refresh();
    } catch (err) {
      const message = errorMessage(err, "No se pudieron guardar los ajustes de IA.");
      setSaveError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (state.loading && !state.data) return <LoadingBlock label="Cargando ajustes de IA…" />;
  if (state.error && !state.data) {
    return (
      <ErrorState
        title="No se pudieron cargar los ajustes de IA"
        message={state.error}
        onRetry={state.refresh}
      />
    );
  }
  if (!settings) return <ErrorState title="Sin datos de ajustes de IA" onRetry={state.refresh} />;

  const toolSettings = state.data?.toolSettings ?? [];
  const selectedLevel = AUTOMATION_LEVELS.find((option) => option.value === automationLevel);

  return (
    <>
      <div className="bo-page-head" style={{ marginBottom: "var(--space-6)" }}>
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Inteligencia artificial</div>
          <h1 className="bo-page-title">Ajustes de IA</h1>
          <p className="bo-page-subtitle">
            Activación de la IA, nivel de automatización por defecto y aviso al huésped. Las políticas
            detalladas (herramientas, prompts, evaluaciones) viven en Gobernanza de IA.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <span className={`bo-status ${settings.aiEnabled ? "ok" : "warn"}`}>
            {settings.aiEnabled ? "IA activada" : "IA desactivada"}
          </span>
          {!state.data?.provisioned ? <span className="bo-status info">Valores por defecto (sin guardar)</span> : null}
        </div>
      </div>

      <div className="bo-grid two">
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Configuración general</h3>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: "var(--space-3)" }}>
            <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} disabled={saving} />
            <span>IA activada en esta propiedad</span>
          </label>
          <label className="bo-form-field">
            <span>Nivel de automatización por defecto</span>
            <select value={automationLevel} onChange={(e) => setAutomationLevel(e.target.value as AutomationLevel)} disabled={saving}>
              {AUTOMATION_LEVELS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {selectedLevel ? (
            <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginTop: 4 }}>{selectedLevel.help}</p>
          ) : null}
          <label className="bo-form-field">
            <span>Aviso al huésped (transparencia de IA)</span>
            <textarea
              rows={3}
              value={disclosure}
              onChange={(e) => setDisclosure(e.target.value)}
              disabled={saving}
              placeholder="Ej.: Parte de la atención está asistida por inteligencia artificial supervisada por nuestro equipo."
            />
          </label>
          {saveError ? (
            <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", color: "var(--danger-ink)" }}>{saveError}</p>
          ) : null}
          <div className="bo-actions">
            <button type="button" className="primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!dirty || saving}
              onClick={() => {
                setAiEnabled(Boolean(settings.aiEnabled));
                setAutomationLevel(settings.defaultAutomationLevel);
                setDisclosure(settings.guestFacingDisclosure ?? "");
                setSaveError(null);
              }}
            >
              Descartar
            </button>
          </div>
          <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginTop: "var(--space-3)" }}>
            Última actualización: {fmtDateTime(settings.updatedAt)} · Idiomas de voz: {settings.voiceLocales.length ? settings.voiceLocales.join(", ") : "—"}
          </p>
        </section>

        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Herramientas con ajuste propio</h3>
            <span className="bo-status info">{toolSettings.length}</span>
          </div>
          {toolSettings.length === 0 ? (
            <p className="bo-muted" style={{ textTransform: "none" }}>
              Ninguna herramienta tiene un nivel distinto del general ({automationLabel(settings.defaultAutomationLevel)}).
            </p>
          ) : (
            <div className="bo-table-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Herramienta</th>
                    <th>Estado</th>
                    <th>Automatización</th>
                    <th>Confirmación</th>
                  </tr>
                </thead>
                <tbody>
                  {toolSettings.map((tool) => (
                    <tr key={tool.id}>
                      <td>{tool.toolName}</td>
                      <td>
                        <span className={`cm-pill ${tool.enabled ? "cm-pill-ok" : "cm-pill-warn"}`}>{tool.enabled ? "Activa" : "Inactiva"}</span>
                      </td>
                      <td>{automationLabel(tool.automationLevel)}</td>
                      <td>{tool.requiresConfirmation ? `Sí${tool.requiresApprovalRole ? ` (${tool.requiresApprovalRole})` : ""}` : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="bo-actions" style={{ marginTop: "var(--space-3)" }}>
            <button type="button" onClick={() => navigateTo("AiGovernanceScreen")}>Gobernanza de IA</button>
            <button type="button" className="ghost" onClick={() => navigateTo("AiToolRegistryScreen")}>Catálogo de herramientas</button>
            <button type="button" className="ghost" onClick={() => navigateTo("PropertyAiScreen")}>Configuración de IA (propiedad)</button>
          </div>
        </section>
      </div>
    </>
  );
}
