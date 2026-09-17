// Ajustes de la IA — /configuracion/ia (base tab of InteligenciaArtificialTabs;
// Cocoa 22 · ola 10 · lote 10-B, plantilla Formulario).
//
// Master switch and defaults of every AI feature of the active property
// (GET/POST /ai-operations/property/settings), the readiness checklist
// (GET /ai-operations/property/readiness) and the organisation-wide table
// (GET /ai-operations/property/configured). Form sections with controlled
// Cocoa controls, a CocoaActionBar that saves (⌘/Ctrl+Enter), a discard guard
// (CocoaDialog, qa#18) and a toast for the outcome; the per-tool exceptions
// live in the tool catalogue. The readiness rows are rendered in Spanish by
// their API key (./ai-operations-labels, qa#3). Same endpoints, query and
// body as before.

import { getActivePropertyId, getActiveOrganizationId } from "../../services/activeProperty";
import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { dateTime, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { readinessCheckLabel, readinessDetail, type ReadinessContext } from "./ai-operations-labels";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  toneFromStatus,
  type CocoaTableColumn
} from "../../components/cocoa";

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

type FormValues = {
  aiEnabled: boolean;
  automationLevel: AutomationLevel;
  disclosure: string;
  voiceLocales: string[];
  autonomousApprovedBy: string;
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

const READINESS_LABEL: Record<ReadinessCheck["status"], string> = { ok: "correcto", warn: "aviso", error: "error" };

const DEFAULT_VALUES: FormValues = { aiEnabled: true, automationLevel: "suggest_and_confirm", disclosure: "", voiceLocales: [], autonomousApprovedBy: "" };

// --- helpers -------------------------------------------------------------

function automationLabel(level: string): string {
  return AUTOMATION_OPTIONS.find((o) => o.value === level)?.label ?? level.replace(/_/g, " ");
}

function valuesFrom(data: PropertyAiSettings): FormValues {
  const approver = data.configurationJson?.autonomousApprovedBy;
  return {
    aiEnabled: data.aiEnabled,
    automationLevel: data.defaultAutomationLevel,
    disclosure: data.guestFacingDisclosure ?? "",
    voiceLocales: data.voiceLocales,
    autonomousApprovedBy: typeof approver === "string" ? approver : ""
  };
}

const CONFIGURED_COLUMNS: CocoaTableColumn<ConfiguredPropertySummary>[] = [
  { key: "propertyName", label: "Propiedad", minWidth: 180, render: (row) => <strong>{row.propertyName}</strong> },
  {
    key: "aiEnabled",
    label: "IA",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={row.aiEnabled ? "success" : "neutral"} variant="tinted" size="small">
        {row.aiEnabled ? "activada" : "desactivada"}
      </CocoaBadge>
    )
  },
  { key: "defaultAutomationLevel", label: "Automatización", fit: true, hideOnNarrow: true, render: (row) => automationLabel(row.defaultAutomationLevel) },
  {
    key: "disclosureSet",
    label: "Aviso",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={row.disclosureSet ? "success" : "warning"} variant="tinted" size="small">
        {row.disclosureSet ? STATUS_LABELS.yes : STATUS_LABELS.no}
      </CocoaBadge>
    )
  },
  { key: "voiceLocaleCount", label: "Idiomas de voz", align: "right", fit: true, hideOnNarrow: true, render: (row) => number(row.voiceLocaleCount) },
  {
    key: "configured",
    label: "Configurada",
    fit: true,
    showFrom: "laptop",
    render: (row) => (
      <CocoaBadge tone={row.configured ? "success" : "neutral"} variant="outline" size="small">
        {row.configured ? "guardada" : "por defecto"}
      </CocoaBadge>
    )
  }
];

function SettingsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={160} />
      <CocoaSkeleton variant="card" height={120} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

// --- screen --------------------------------------------------------------

export function PropertyAiScreen() {
  // Hosted (InteligenciaArtificialTabs): the container paints eyebrow + H1.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const settingsState = useApiData<PropertyAiSettings>("/ai-operations/property/settings", {
    query: { propertyId: PROPERTY_ID }
  });
  const readinessState = useApiData<AiReadiness>("/ai-operations/property/readiness", {
    query: { propertyId: PROPERTY_ID }
  });
  const configuredState = useApiData<ConfiguredPropertySummary[]>("/ai-operations/property/configured", {
    query: { organizationId: ORGANIZATION_ID }
  });

  // Editable form state (hydrated from the loaded settings) and its saved snapshot for the dirty guard.
  const [values, setValues] = useState<FormValues>(DEFAULT_VALUES);
  const [saved, setSaved] = useState<FormValues>(DEFAULT_VALUES);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);

  // Hydrate the editable form whenever fresh settings arrive.
  useEffect(() => {
    const data = settingsState.data;
    if (!data) return;
    const next = valuesFrom(data);
    setValues(next);
    setSaved(next);
  }, [settingsState.data]);

  const { aiEnabled, automationLevel, disclosure, voiceLocales, autonomousApprovedBy } = values;
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const approverMissing = automationLevel === "autonomous" && !autonomousApprovedBy.trim();

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const toggleLocale = (value: string) => {
    set("voiceLocales", voiceLocales.includes(value) ? voiceLocales.filter((l) => l !== value) : [...voiceLocales, value]);
  };

  const refreshAll = () => {
    settingsState.refresh();
    readinessState.refresh();
    configuredState.refresh();
  };

  const handleSave = async () => {
    if (saving) return;
    setSaveError(null);
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
      showToast("Configuración de IA guardada", { variant: "success" });
      refreshAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
      showToast(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const readiness = readinessState.data;
  const checks = useMemo(() => toArray<ReadinessCheck>(readiness?.checks), [readiness]);
  const okChecks = checks.filter((c) => c.status === "ok").length;
  const ready = readiness?.ready ?? false;
  const configured = useMemo(() => toArray<ConfiguredPropertySummary>(configuredState.data), [configuredState.data]);
  const selectedOption = AUTOMATION_OPTIONS.find((o) => o.value === automationLevel);
  const settings = settingsState.data;
  // The readiness sentences quote the SAVED settings (what the API checked), never the edited form.
  const readinessContext = useMemo<ReadinessContext>(() => {
    if (!settings) return {};
    const approver = settings.configurationJson?.autonomousApprovedBy;
    return {
      voiceLocales: settings.voiceLocales,
      automationLevel: settings.defaultAutomationLevel,
      automationLevelLabel: automationLabel(settings.defaultAutomationLevel),
      approvedBy: typeof approver === "string" && approver.trim() ? approver.trim() : undefined
    };
  }, [settings]);
  const discard = confirmDiscard();
  const savedStatus = dirty
    ? "Cambios sin guardar"
    : settings?.updatedAt
      ? `Última actualización ${dateTime(settings.updatedAt)}`
      : settings?.isDefault
        ? "Aún sin guardar: se muestran los valores por defecto."
        : undefined;

  return (
    <CocoaPage
      eyebrow="Configuración · Inteligencia artificial"
      title="Configuración de IA de la propiedad"
      subtitle={
        hosted
          ? undefined
          : "El interruptor principal y los valores por defecto de toda la IA, para esta propiedad. Las excepciones por herramienta se gestionan aparte en el catálogo de herramientas de IA."
      }
      actions={
        <>
          {readiness ? (
            <CocoaBadge tone={ready ? "success" : "warning"} variant="tinted">
              {ready ? "IA lista" : "Requiere atención"}
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={settingsState.loading && !settings ? "loading" : settingsState.error && !settings ? "error" : "ready"}
      skeleton={<SettingsSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: settingsState.error ?? undefined, onRetry: refreshAll }}
      commands={[
        { id: "ia-ajustes-save", label: "Guardar la configuración de IA", run: () => { void handleSave(); }, shortcut: "⌘ Enter" },
        { id: "ia-ajustes-refresh", label: "Actualizar la configuración de IA", run: refreshAll }
      ]}
    >
      <CocoaSection title="Preparación de la IA" meta={readiness ? `${number(okChecks)} de ${plural(checks.length, "comprobación", "comprobaciones")} correctas` : undefined}>
        {readinessState.loading && !readiness ? (
          <CocoaSkeleton variant="text" lines={3} />
        ) : readinessState.error && !readiness ? (
          <CocoaState kind="error" inline title="No se pudo comprobar la preparación" message={readinessState.error} onRetry={readinessState.refresh} />
        ) : checks.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin comprobaciones para esta propiedad." />
        ) : (
          <ul className="c22-section__list" aria-label="Comprobaciones de preparación">
            {checks.map((check) => (
              <li key={check.key}>
                <div className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto" }}>
                  <strong>{readinessCheckLabel(check)}</strong>
                  <span className="cocoa-note">{readinessDetail(check, readinessContext)}</span>
                </div>
                <CocoaBadge tone={toneFromStatus(check.status)} variant="dot" size="small">
                  {READINESS_LABEL[check.status]}
                </CocoaBadge>
              </li>
            ))}
          </ul>
        )}
      </CocoaSection>

      <CocoaFormSection title="Interruptor principal" description="Enciende o apaga todas las funciones de IA de esta propiedad.">
        <CocoaField label="IA activada para esta propiedad" inline>
          <CocoaSwitch checked={aiEnabled} onChange={(v) => set("aiEnabled", v)} />
        </CocoaField>
        {!aiEnabled ? (
          <CocoaCallout tone="warning" title="La IA queda desactivada por completo">
            Las sugerencias, la voz, la automatización y la IA de cara al huésped se detendrán en esta propiedad hasta que se reactive.
          </CocoaCallout>
        ) : null}
      </CocoaFormSection>

      <CocoaFormSection title="Nivel de automatización por defecto" description="Cuánto puede hacer la IA sin una persona; cada herramienta puede ajustarlo aparte.">
        <div className="cocoa-stack" data-gap="2">
          <CocoaSegmentedControl
            value={automationLevel}
            onChange={(v) => set("automationLevel", v as AutomationLevel)}
            options={AUTOMATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            aria-label="Nivel de automatización por defecto"
          />
          {selectedOption ? <p className="cocoa-note">{selectedOption.description}</p> : null}
        </div>
        {automationLevel === "autonomous" ? (
          <CocoaCallout tone="warning" title="La IA autónoma actúa sin confirmación para cada acción">
            <div className="cocoa-stack" data-gap="3">
              <span>Es una decisión deliberada y para toda la organización, y requiere un responsable de aprobación registrado antes de poder guardarse.</span>
              <CocoaField label="Aprobado por (nombre o usuario)" required error={approverMissing ? "Indica quién aprueba el modo autónomo." : undefined}>
                <CocoaInput value={autonomousApprovedBy} onChange={(v) => set("autonomousApprovedBy", v)} placeholder="p. ej. Juana Pérez, Directora de Operaciones" />
              </CocoaField>
            </div>
          </CocoaCallout>
        ) : null}
      </CocoaFormSection>

      <CocoaFormSection
        title="Aviso de IA al huésped"
        description="Informar al huésped de que interviene la IA es un requisito legal. Incluye un aviso bilingüe (español + inglés) que se mostrará allí donde los huéspedes interactúen con la IA."
      >
        <CocoaField label="Aviso al huésped" fullWidth>
          <CocoaInput value={disclosure} onChange={(v) => set("disclosure", v)} multiline rows={6} placeholder={"Aviso en español…\nAviso en inglés…"} />
        </CocoaField>
      </CocoaFormSection>

      <CocoaFormSection title="Idiomas de voz" description="Idiomas en los que la IA de voz puede hablar. Selecciona todos los que usen tus huéspedes.">
        <CocoaField label="Idiomas" hint={`${number(voiceLocales.length)} seleccionados`} help="Pulsa un idioma para activarlo o desactivarlo." fullWidth>
          <div role="group" aria-label="Idiomas de voz" className="cocoa-cluster">
            {VOICE_LOCALE_OPTIONS.map((option) => {
              const active = voiceLocales.includes(option.value);
              return (
                <CocoaButton key={option.value} size="small" variant={active ? "tinted" : "bordered"} tone={active ? "accent" : "neutral"} aria-pressed={active} onClick={() => toggleLocale(option.value)}>
                  {option.label}
                </CocoaButton>
              );
            })}
          </div>
        </CocoaField>
      </CocoaFormSection>

      {saveError ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
          {saveError}
        </CocoaCallout>
      ) : null}

      <CocoaSection title="Configuración de IA de toda la organización" meta={plural(configured.length, "propiedad", "propiedades")} padding={configured.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {configuredState.error && configured.length === 0 ? (
          <CocoaState kind="error" inline title="No se pudieron cargar las propiedades" message={configuredState.error} onRetry={configuredState.refresh} />
        ) : !configuredState.loading && configured.length === 0 ? (
          <CocoaState kind="empty" inline title="No se han encontrado propiedades para esta organización." />
        ) : (
          <CocoaTable columns={CONFIGURED_COLUMNS} rows={configured} rowKey="propertyId" loading={configuredState.loading && configured.length === 0} caption="Configuración de IA por propiedad" aria-label="Configuración de IA por propiedad" />
        )}
      </CocoaSection>

      <CocoaActionBar
        aria-label="Acciones de la configuración de IA"
        status={savedStatus}
        secondary={{ label: "Descartar cambios", disabled: !dirty || saving, onClick: () => setAskDiscard(true) }}
        primary={{ label: saving ? STATUS_LABELS.saving : "Guardar configuración de IA", loading: saving, disabled: saving || approverMissing, onClick: () => { void handleSave(); } }}
        publishToastOffset
      />

      <CocoaDialog
        open={askDiscard}
        onClose={() => setAskDiscard(false)}
        tone="destructive"
        title={discard.title}
        description={discard.message}
        confirmLabel={discard.confirmLabel}
        cancelLabel={discard.cancelLabel}
        onConfirm={() => {
          setValues(saved);
          setSaveError(null);
          setAskDiscard(false);
        }}
      />
    </CocoaPage>
  );
}
