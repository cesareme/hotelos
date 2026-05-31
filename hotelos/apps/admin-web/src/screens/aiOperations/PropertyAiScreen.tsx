import { getActivePropertyId, getActiveOrganizationId } from "../../services/activeProperty";
import { useEffect, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { LoadingBlock } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();
const ORGANIZATION_ID = getActiveOrganizationId();

// --- types ---------------------------------------------------------------

type AutomationLevel = "off" | "suggest" | "suggest_and_confirm" | "autonomous";

type PropertyAiSettings = {
  propertyId: string;
  aiEnabled: boolean;
  defaultAutomationLevel: AutomationLevel;
  guestFacingDisclosure: string | null;
  voiceLocales: string[];
  configurationJson: Record<string, unknown>;
  updatedAt: string | null;
  isDefault: boolean;
};

type ReadinessCheck = {
  key: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

type AiReadiness = {
  propertyId: string;
  checks: ReadinessCheck[];
  ready: boolean;
};

type ConfiguredPropertySummary = {
  propertyId: string;
  propertyName: string;
  configured: boolean;
  aiEnabled: boolean;
  defaultAutomationLevel: AutomationLevel;
  disclosureSet: boolean;
  voiceLocaleCount: number;
  updatedAt: string | null;
};

// --- constants -----------------------------------------------------------

const AUTOMATION_OPTIONS: Array<{ value: AutomationLevel; label: string; description: string }> = [
  { value: "off", label: "Desactivado", description: "La IA nunca actúa. Sin sugerencias ni acciones." },
  { value: "suggest", label: "Sugerir", description: "La IA propone acciones para que el personal las revise. Nada se ejecuta automáticamente." },
  {
    value: "suggest_and_confirm",
    label: "Sugerir y confirmar",
    description: "La IA prepara las acciones y solo las ejecuta después de que una persona las confirme. Opción recomendada por defecto."
  },
  {
    value: "autonomous",
    label: "Autónomo",
    description: "La IA actúa por su cuenta sin confirmación para cada acción. Requiere un responsable de aprobación registrado."
  }
];

const VOICE_LOCALE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "es-ES", label: "Español (España) · es-ES" },
  { value: "en-GB", label: "Inglés (Reino Unido) · en-GB" },
  { value: "ca-ES", label: "Catalán · ca-ES" },
  { value: "fr-FR", label: "Francés · fr-FR" },
  { value: "de-DE", label: "Alemán · de-DE" },
  { value: "it-IT", label: "Italiano · it-IT" },
  { value: "pt-PT", label: "Portugués · pt-PT" },
  { value: "nl-NL", label: "Neerlandés · nl-NL" }
];

// --- helpers -------------------------------------------------------------

function readinessTone(status: ReadinessCheck["status"]): "ok" | "warn" | "error" {
  return status;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

// --- screen --------------------------------------------------------------

export function PropertyAiScreen() {
  const settingsState = useApiData<PropertyAiSettings>("/ai-operations/property/settings", {
    query: { propertyId: PROPERTY_ID }
  });
  const readinessState = useApiData<AiReadiness>("/ai-operations/property/readiness", {
    query: { propertyId: PROPERTY_ID }
  });
  const configuredState = useApiData<ConfiguredPropertySummary[]>("/ai-operations/property/configured", {
    query: { organizationId: ORGANIZATION_ID }
  });

  // Editable form state (hydrated from the loaded settings).
  const [aiEnabled, setAiEnabled] = useState(true);
  const [automationLevel, setAutomationLevel] = useState<AutomationLevel>("suggest_and_confirm");
  const [disclosure, setDisclosure] = useState("");
  const [voiceLocales, setVoiceLocales] = useState<string[]>([]);
  const [autonomousApprovedBy, setAutonomousApprovedBy] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Hydrate the editable form whenever fresh settings arrive.
  useEffect(() => {
    const data = settingsState.data;
    if (!data) return;
    setAiEnabled(data.aiEnabled);
    setAutomationLevel(data.defaultAutomationLevel);
    setDisclosure(data.guestFacingDisclosure ?? "");
    setVoiceLocales(data.voiceLocales);
    const approver = data.configurationJson?.autonomousApprovedBy;
    setAutonomousApprovedBy(typeof approver === "string" ? approver : "");
  }, [settingsState.data]);

  const toggleLocale = (value: string) => {
    setVoiceLocales((current) =>
      current.includes(value) ? current.filter((l) => l !== value) : [...current, value]
    );
  };

  const refreshAll = () => {
    settingsState.refresh();
    readinessState.refresh();
    configuredState.refresh();
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaveSuccess(false);
    setSaving(true);
    try {
      // Merge the approver into configurationJson so the autonomous guardrail
      // can be satisfied in the same request that flips the level.
      const baseConfig = settingsState.data?.configurationJson ?? {};
      const configurationJson: Record<string, unknown> = { ...baseConfig };
      if (autonomousApprovedBy.trim()) {
        configurationJson.autonomousApprovedBy = autonomousApprovedBy.trim();
      } else {
        delete configurationJson.autonomousApprovedBy;
      }

      await apiRequest("/ai-operations/property/settings", {
        method: "POST",
        body: {
          propertyId: PROPERTY_ID,
          aiEnabled,
          defaultAutomationLevel: automationLevel,
          guestFacingDisclosure: disclosure,
          voiceLocales,
          configurationJson
        }
      });
      setSaveSuccess(true);
      refreshAll();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const readiness = readinessState.data;
  const ready = readiness?.ready ?? false;

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">IA · Configuración por propiedad</div>
          <h1 className="bo-page-title">Configuración de IA de la propiedad</h1>
          <p className="bo-page-subtitle">
            El interruptor principal y los valores por defecto de toda la IA, para esta propiedad. Las
            excepciones por herramienta se gestionan aparte en el registro de herramientas de IA.
          </p>
        </div>
        <div className="bo-page-head-actions">
          {readiness ? (
            <span className={`bo-status ${ready ? "ok" : "warn"}`} style={{ fontSize: 13, padding: "6px 12px" }}>
              {ready ? "✓ IA lista" : "⚠ Requiere atención"}
            </span>
          ) : null}
          <button type="button" onClick={refreshAll}>↻ Actualizar</button>
        </div>
      </div>

      {/* Readiness checklist */}
      <section className="bo-card">
        <div className="bo-card-head">
          <h2 style={{ fontSize: 18 }}>Preparación de la IA</h2>
          {readiness ? (
            <span className={`bo-chip`}>{readiness.checks.filter((c) => c.status === "ok").length}/{readiness.checks.length} correcto</span>
          ) : null}
        </div>
        {readinessState.loading ? (
          <p style={{ color: "var(--ink-muted)" }}>Comprobando la preparación…</p>
        ) : readinessState.error ? (
          <p style={{ color: "var(--danger-ink)" }}>{readinessState.error}</p>
        ) : readiness ? (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {readiness.checks.map((check) => (
              <li
                key={check.key}
                style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
              >
                <span className={`bo-status ${readinessTone(check.status)}`} style={{ minWidth: 56, textAlign: "center" }}>
                  {check.status === "ok" ? "correcto" : check.status === "warn" ? "aviso" : "error"}
                </span>
                <div>
                  <div style={{ fontWeight: 600 }}>{check.label}</div>
                  <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>{check.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {settingsState.loading ? (
        <section className="bo-card">
          <LoadingBlock label="Cargando configuración…" />
        </section>
      ) : settingsState.error ? (
        <section className="bo-card">
          <p style={{ color: "var(--danger-ink)" }}>{settingsState.error}</p>
        </section>
      ) : (
        <>
          {/* Master switch */}
          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 18 }}>Interruptor principal</h2>
              <span className={`bo-status ${aiEnabled ? "ok" : "neutral"}`}>{aiEnabled ? "activada" : "desactivada"}</span>
            </div>
            <label style={{ display: "flex", gap: 12, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
              />
              <span style={{ fontWeight: 600 }}>IA activada para esta propiedad</span>
            </label>
            {!aiEnabled ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: "var(--warn-surface, #fff7ed)",
                  border: "1px solid var(--warn-line, #fed7aa)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--warn-ink, #9a3412)",
                  fontSize: 13
                }}
              >
                ⚠ Desactivar la IA deshabilita <strong>todas</strong> las funciones de IA de esta propiedad: las
                sugerencias, la voz, la automatización y la IA de cara al huésped se detendrán hasta que se reactive.
              </div>
            ) : null}
          </section>

          {/* Automation level */}
          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 18 }}>Nivel de automatización por defecto</h2>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {AUTOMATION_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                    padding: 12,
                    border: `1px solid ${automationLevel === option.value ? "var(--accent, #2563eb)" : "var(--line)"}`,
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer"
                  }}
                >
                  <input
                    type="radio"
                    name="automationLevel"
                    value={option.value}
                    checked={automationLevel === option.value}
                    onChange={() => setAutomationLevel(option.value)}
                    style={{ marginTop: 3 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>{option.label}</div>
                    <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>{option.description}</div>
                  </div>
                </label>
              ))}
            </div>

            {automationLevel === "autonomous" ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: "var(--warn-surface, #fff7ed)",
                  border: "1px solid var(--warn-line, #fed7aa)",
                  borderRadius: "var(--radius-md)"
                }}
              >
                <div style={{ fontSize: 13, color: "var(--warn-ink, #9a3412)", marginBottom: 8 }}>
                  ⚠ La IA autónoma actúa sin confirmación para cada acción. Es una decisión deliberada y para toda la
                  organización, y requiere un responsable de aprobación registrado antes de poder guardarse.
                </div>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Aprobado por (nombre o usuario)</span>
                  <input
                    type="text"
                    placeholder="p. ej. Juana Pérez, Directora de Operaciones"
                    value={autonomousApprovedBy}
                    onChange={(e) => setAutonomousApprovedBy(e.target.value)}
                  />
                </label>
              </div>
            ) : null}
          </section>

          {/* Guest-facing disclosure */}
          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 18 }}>Aviso de IA al huésped</h2>
            </div>
            <p style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 0 }}>
              Informar al huésped de que interviene la IA es un <strong>requisito legal</strong>. Incluya un aviso
              bilingüe (español + inglés) que se mostrará allí donde los huéspedes interactúen con la IA.
            </p>
            <textarea
              value={disclosure}
              onChange={(e) => setDisclosure(e.target.value)}
              rows={6}
              placeholder={"Aviso en español…\nAviso en inglés…"}
              style={{
                width: "100%",
                fontFamily: "inherit",
                fontSize: 14,
                padding: 12,
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                resize: "vertical"
              }}
            />
          </section>

          {/* Voice locales */}
          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 18 }}>Idiomas de voz</h2>
              <span className="bo-chip">{voiceLocales.length} seleccionados</span>
            </div>
            <p style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 0 }}>
              Idiomas en los que la IA de voz puede hablar. Seleccione todos los que usen sus huéspedes.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {VOICE_LOCALE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "8px 12px",
                    border: `1px solid ${voiceLocales.includes(option.value) ? "var(--accent, #2563eb)" : "var(--line)"}`,
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer"
                  }}
                >
                  <input
                    type="checkbox"
                    checked={voiceLocales.includes(option.value)}
                    onChange={() => toggleLocale(option.value)}
                  />
                  <span style={{ fontSize: 13 }}>{option.label}</span>
                </label>
              ))}
            </div>
          </section>

          {/* Save */}
          <section className="bo-card">
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="primary" onClick={handleSave} disabled={saving}>
                {saving ? "Guardando…" : "Guardar configuración de IA"}
              </button>
              {settingsState.data?.updatedAt ? (
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  Última actualización {fmtDateTime(settingsState.data.updatedAt)}
                </span>
              ) : settingsState.data?.isDefault ? (
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Aún sin guardar: se muestran los valores por defecto.</span>
              ) : null}
            </div>
            {saveError ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: "var(--danger-surface, #fef2f2)",
                  border: "1px solid var(--danger-line, #fecaca)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--danger-ink)",
                  fontSize: 13
                }}
              >
                {saveError}
              </div>
            ) : null}
            {saveSuccess ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: "var(--ok-surface, #f0fdf4)",
                  border: "1px solid var(--ok-line, #bbf7d0)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--ok-ink, #166534)",
                  fontSize: 13
                }}
              >
                ✓ Configuración de IA guardada.
              </div>
            ) : null}
          </section>

          {/* Org-wide configuration */}
          <section className="bo-card">
            <div className="bo-card-head">
              <h2 style={{ fontSize: 18 }}>Configuración de IA de toda la organización</h2>
              <span className="bo-chip">{configuredState.data?.length ?? 0} propiedades</span>
            </div>
            {configuredState.loading ? (
              <LoadingBlock label="Cargando propiedades…" />
            ) : configuredState.error ? (
              <p style={{ color: "var(--danger-ink)" }}>{configuredState.error}</p>
            ) : !configuredState.data || configuredState.data.length === 0 ? (
              <p style={{ color: "var(--ink-muted)" }}>No se han encontrado propiedades para esta organización.</p>
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr>
                      <th>Propiedad</th>
                      <th>IA</th>
                      <th>Automatización</th>
                      <th>Aviso</th>
                      <th style={{ textAlign: "right" }}>Idiomas de voz</th>
                      <th>Configurada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configuredState.data.map((row) => (
                      <tr key={row.propertyId}>
                        <td><strong>{row.propertyName}</strong></td>
                        <td>
                          <span className={`bo-status ${row.aiEnabled ? "ok" : "neutral"}`}>
                            {row.aiEnabled ? "activada" : "desactivada"}
                          </span>
                        </td>
                        <td>{AUTOMATION_OPTIONS.find((o) => o.value === row.defaultAutomationLevel)?.label ?? row.defaultAutomationLevel.replace(/_/g, " ")}</td>
                        <td>
                          <span className={`bo-status ${row.disclosureSet ? "ok" : "warn"}`}>
                            {row.disclosureSet ? "sí" : "no"}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>{row.voiceLocaleCount}</td>
                        <td>
                          <span className={`bo-status ${row.configured ? "ok" : "neutral"}`}>
                            {row.configured ? "guardada" : "por defecto"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
