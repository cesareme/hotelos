// Setup Center (Puesta en marcha): the single configuration hub of Tanda 5,
// base tab of Configuración › Puesta en marcha. Cocoa 22 · ola 10 · lote 10-C
// (dashboard archetype): CocoaPage with the two inner views («Resumen» ·
// «Todos los ajustes») as segmented views of the head → progress + KPI strip →
// readiness per area and guided tools on the 12-column grid → the manual index
// as one section per area with a card per setup item (inline save form and
// completion checks on demand). Data, save calls and navigation are untouched.
import { useEffect, useState } from "react";
import { MANUAL_SETUP_OPTIONS, type ManualSetupOption } from "@hotelos/product";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchManualSetupOptions, saveManualSetupOption, type ManualSetupSummary } from "../../services/backofficeApi";
import { date, percent, plural } from "../../lib/format";
import { A11Y_LABELS, ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { shellNavigate } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaChart,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSpan,
  openTabPath,
  type CocoaTone
} from "../../components/cocoa";

type ManualSetupOptionView = ManualSetupOption & {
  setupState?: "not_started" | "saved" | "failed";
  latestSubmission?: { id: string; status: "saved" | "failed"; createdAt: string; validationErrorsJson?: string[] };
};

type SetupView = "overview" | "items";

const VIEWS: Array<{ value: SetupView; label: string }> = [
  { value: "overview", label: "Resumen" },
  { value: "items", label: "Todos los ajustes" }
];

// Deep links open through the shared openTabPath (CocoaRouteTabs): one channel, no local pushState copy (code-review#12).
const go = (path: string) => openTabPath(path);

function groupManualSetupOptions(options: ManualSetupOptionView[]): Array<[string, ManualSetupOptionView[]]> {
  const map = new Map<string, ManualSetupOptionView[]>();
  for (const option of options) {
    const list = map.get(option.group) ?? [];
    list.push(option);
    map.set(option.group, list);
  }
  return Array.from(map.entries());
}

function buildSetupSummary(options: ManualSetupOptionView[]): ManualSetupSummary {
  return {
    totalOptions: options.length,
    savedOptions: options.filter((o) => o.setupState === "saved").length,
    failedOptions: options.filter((o) => o.setupState === "failed").length,
    notStartedOptions: options.filter((o) => !o.setupState || o.setupState === "not_started").length
  };
}

function setupBadge(option: ManualSetupOptionView): { label: string; tone: CocoaTone } {
  if (option.setupState === "saved") return { label: "Configurado", tone: "success" };
  if (option.setupState === "failed") return { label: "Requiere atención", tone: "danger" };
  return { label: "Pendiente", tone: "warning" };
}

function countConfigured(options: ManualSetupOptionView[]): number {
  return options.filter((o) => o.setupState === "saved").length;
}

/** Tone of an area by its progress: complete → success, started → warning, untouched → info. */
function progressTone(done: number, total: number): CocoaTone {
  if (total > 0 && done >= total) return "success";
  return done > 0 ? "warning" : "info";
}

function severityTone(severity: string): CocoaTone {
  if (severity === "blocking") return "danger";
  return severity === "warning" ? "warning" : "info";
}

function severityLabel(severity: string): string {
  if (severity === "blocking") return "Bloqueante";
  return severity === "warning" ? "Aviso" : "Informativa";
}

// Curated guided tools — entry points that are not part of the per-item index.
// Tanda 5 (L1b): every entry is a screen of the tree (the Property Setup index,
// the setup wizard and the AI setup center retired into this hub).
const GUIDED_TOOLS: Array<{ label: string; screen: string; hint: string }> = [
  { label: "Propiedad", screen: "PropertyProfileSetupForm", hint: "Perfil, edificios, plantas, zonas, departamentos y categorías" },
  { label: "Habitaciones y espacios", screen: "RoomSetupForm", hint: "Inventario de habitaciones, tipos, espacios y recursos" },
  { label: "Categorías", screen: "CategoryManagerScreen", hint: "Opciones de categoría de reservas, revenue y cumplimiento" },
  { label: "Importar desde documentos", screen: "PropertyMapper", hint: "Extracción con IA de la estructura de la propiedad a partir de documentos" },
  { label: "Salida en vivo", screen: "GoLiveChecklist", hint: "Lista de comprobación y estado de preparación para salir en vivo" }
];

function OptionCard({ option, onSaved }: { option: ManualSetupOptionView; onSaved: (optionCode: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const badge = setupBadge(option);
  const saving = saveState === "saving";
  const formId = `setup-option-form-${option.code}`;
  const checksId = `setup-option-checks-${option.code}`;

  async function handleSave() {
    const missing = option.requiredInputs.filter((input) => !values[input]?.trim());
    if (missing.length > 0) {
      setSaveState("error");
      setSaveMessage(`Falta rellenar: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`);
      return;
    }
    setSaveState("saving");
    try {
      await saveManualSetupOption(getActivePropertyId(), option.code, { values });
      setSaveState("saved");
      setSaveMessage("Guardado correctamente.");
      onSaved(option.code);
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "No se pudo guardar.");
    }
  }

  return (
    <CocoaSection id={`setup-option-${option.code}`} title={option.label} meta={<CocoaBadge tone={badge.tone}>{badge.label}</CocoaBadge>}>
      <p className="cocoa-note">{option.description}</p>

      {option.inputMethods.length ? (
        <div className="cocoa-cluster" aria-label="Formas de introducir los datos">
          {option.inputMethods.map((method) => (
            <CocoaBadge key={method.code} tone="neutral" uppercase={false}>
              {method.label}
            </CocoaBadge>
          ))}
        </div>
      ) : null}

      <div className="cocoa-row" data-gap="2">
        <CocoaButton variant="filled" tone="accent" size="small" onClick={() => go(option.url)}>
          Configurar
        </CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" size="small" aria-expanded={showForm} aria-controls={formId} onClick={() => setShowForm((open) => !open)}>
          Rellenar aquí
        </CocoaButton>
        {option.completionChecks.length ? (
          <CocoaButton variant="plain" tone="neutral" size="small" aria-expanded={showChecks} aria-controls={checksId} onClick={() => setShowChecks((open) => !open)}>
            {plural(option.completionChecks.length, "comprobación", "comprobaciones", { withCount: true })}
          </CocoaButton>
        ) : null}
        {option.latestSubmission ? <span className="cocoa-note">Guardado el {date(option.latestSubmission.createdAt)}</span> : null}
      </div>

      {showForm ? (
        <div id={formId} className="cocoa-stack" data-gap="3" role="group" aria-label={`Guardar ${option.label} desde aquí`}>
          {option.requiredInputs.length > 0 ? (
            <CocoaFormRow columns={2}>
              {option.requiredInputs.map((input) => (
                <CocoaField key={input} label={input} required>
                  <CocoaInput value={values[input] ?? ""} onChange={(next) => setValues((current) => ({ ...current, [input]: next }))} placeholder={input} aria-label={input} />
                </CocoaField>
              ))}
            </CocoaFormRow>
          ) : (
            <p className="cocoa-note">Este ajuste no pide datos aquí: guarda para registrarlo como configurado.</p>
          )}
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="filled" tone="accent" size="small" loading={saving} disabled={saving} onClick={() => void handleSave()}>
              {saving ? STATUS_LABELS.saving : ACTIONS.save}
            </CocoaButton>
          </div>
          {saveMessage ? (
            <CocoaCallout tone={saveState === "error" ? "danger" : "success"} role="status">
              {saveMessage}
            </CocoaCallout>
          ) : null}
        </div>
      ) : null}

      {showChecks && option.completionChecks.length ? (
        <ul id={checksId} className="c22-section__list" aria-label={`Comprobaciones de ${option.label}`}>
          {option.completionChecks.map((check) => (
            <li key={check.code}>
              <span>{check.label}</span>
              <CocoaBadge tone={severityTone(check.severity)} size="small">
                {severityLabel(check.severity)}
              </CocoaBadge>
            </li>
          ))}
        </ul>
      ) : null}
    </CocoaSection>
  );
}

// Setup Center (Puesta en marcha): the single configuration hub of Tanda 5. Rendered
// as the base tab of Configuración › Puesta en marcha (`embedded`) or standalone.
export function SetupCenter({ initialTab = "overview", embedded = false }: { initialTab?: SetupView; embedded?: boolean }) {
  // The host context decides the head (CocoaPage reads it); `embedded` is the L1c bridge the loader still passes.
  const hosted = embedded || useTabHost() !== null;
  const [tab, setTab] = useState<SetupView>(initialTab);
  const [options, setOptions] = useState<ManualSetupOptionView[]>(MANUAL_SETUP_OPTIONS);
  const [summary, setSummary] = useState<ManualSetupSummary>(() => buildSetupSummary(MANUAL_SETUP_OPTIONS));
  const [source, setSource] = useState<"static" | "api">("static");
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(MANUAL_SETUP_OPTIONS.slice(0, 1).map((option) => option.group)));
  const groups = groupManualSetupOptions(options);

  useEffect(() => {
    let mounted = true;
    fetchManualSetupOptions(getActivePropertyId())
      .then((payload) => {
        if (!mounted) return;
        // The services type still describes the pre-Tanda 5 shape (adminPath); the API
        // already returns the product catalogue fields (url, screen), so widen here.
        setOptions(payload.options as unknown as ManualSetupOptionView[]);
        setSummary(payload.setupSummary);
        setSource("api");
      })
      .catch(() => {
        if (!mounted) return;
        setOptions(MANUAL_SETUP_OPTIONS);
        setSummary(buildSetupSummary(MANUAL_SETUP_OPTIONS));
        setSource("static");
      });
    return () => { mounted = false; };
  }, []);

  function markOptionSaved(optionCode: string) {
    setOptions((current) => {
      const next = current.map((o) => o.code === optionCode ? {
        ...o,
        setupState: "saved" as const,
        latestSubmission: { id: "local-admin-save", status: "saved" as const, createdAt: new Date().toISOString() }
      } : o);
      setSummary(buildSetupSummary(next));
      return next;
    });
  }

  function toggleGroup(group: string) {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function openGroup(group: string) {
    setOpenGroups((current) => new Set(current).add(group));
    setTab("items");
    window.scrollTo(0, 0);
  }

  const total = summary.totalOptions || 1;
  const pct = Math.round((summary.savedOptions / total) * 100);
  const sourceNote = `${plural(summary.totalOptions, "elemento de configuración", "elementos de configuración", { withCount: true })} · origen: ${source === "api" ? "estado guardado en la base de datos" : "catálogo estático (sin conexión con el API)"}`;

  return (
    <CocoaPage
      eyebrow="Configuración"
      title={hosted ? "Estado de la configuración" : "Puesta en marcha"}
      subtitle="Un único lugar para configurar la propiedad. Resumen muestra el estado de preparación para salir en vivo; Todos los ajustes es el índice manual completo: abre un ajuste para configurarlo o rellénalo aquí mismo."
      tabs={VIEWS}
      activeTab={tab}
      onTabChange={(value) => setTab(value === "items" ? "items" : "overview")}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => shellNavigate("PropertyProfileSetupForm")}>
            Propiedad
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => shellNavigate("CategoryManagerScreen")}>
            Categorías
          </CocoaButton>
        </>
      }
      commands={[
        { id: "setup-center-overview", label: "Puesta en marcha: resumen", run: () => setTab("overview") },
        { id: "setup-center-items", label: "Puesta en marcha: todos los ajustes", run: () => setTab("items") }
      ]}
    >
      {tab === "overview" ? (
        <>
          <CocoaSection title="Estado de la configuración" meta={`${summary.savedOptions} de ${summary.totalOptions} configurados`}>
            <CocoaChart.Progress
              value={pct}
              tone={pct >= 100 ? "success" : "accent"}
              label="Elementos configurados"
              valueLabel={percent(pct, { maximumFractionDigits: 0 })}
              aria-label={`${summary.savedOptions} de ${summary.totalOptions} elementos configurados`}
            />
            <CocoaKpiStrip min={200} aria-label="Resumen de la configuración">
              <CocoaKpi label="Configurados" value={summary.savedOptions} unit={`de ${summary.totalOptions}`} polarity="neutral" status="ok" />
              <CocoaKpi label="Pendientes" value={summary.notStartedOptions} polarity="neutral" status={summary.notStartedOptions > 0 ? "warning" : "ok"} />
              <CocoaKpi label="Requieren atención" value={summary.failedOptions} polarity="neutral" status={summary.failedOptions > 0 ? "critical" : "ok"} />
            </CocoaKpiStrip>
          </CocoaSection>

          {/* Readiness by area (live, derived from manual-setup progress) */}
          <CocoaSection title="Preparación por área" meta={plural(groups.length, "área", "áreas", { withCount: true })}>
            <CocoaGrid aria-label="Preparación por área">
              {groups.map(([group, groupOptions]) => {
                const done = countConfigured(groupOptions);
                const gp = Math.round((done / (groupOptions.length || 1)) * 100);
                const tone = progressTone(done, groupOptions.length);
                return (
                  <CocoaSpan cols={4} min={240} key={group}>
                    <CocoaCard variant="bordered" padding="md" role="group" aria-label={group}>
                      <div className="cocoa-stack" data-gap="3">
                        <div className="cocoa-row" data-gap="2" data-justify="between">
                          <strong>{group}</strong>
                          <CocoaBadge tone={tone}>
                            {done}/{groupOptions.length}
                          </CocoaBadge>
                        </div>
                        <CocoaChart.Progress value={gp} tone={tone} showValue={false} aria-label={`${group}: ${done} de ${groupOptions.length} configurados`} />
                        <CocoaButton variant="plain" tone="accent" size="small" align="start" onClick={() => openGroup(group)}>
                          Ver elementos
                        </CocoaButton>
                      </div>
                    </CocoaCard>
                  </CocoaSpan>
                );
              })}
            </CocoaGrid>
          </CocoaSection>

          <CocoaSection title="Herramientas guiadas" meta={plural(GUIDED_TOOLS.length, "herramienta", "herramientas", { withCount: true })}>
            <CocoaGrid aria-label="Herramientas guiadas">
              {GUIDED_TOOLS.map((tool) => (
                <CocoaSpan cols={4} min={240} key={tool.screen}>
                  <CocoaCard variant="bordered" padding="md" role="group" aria-label={tool.label}>
                    <div className="cocoa-stack" data-gap="2">
                      <strong>{tool.label}</strong>
                      <p className="cocoa-note">{tool.hint}</p>
                      <CocoaButton variant="filled" tone="accent" size="small" align="start" onClick={() => shellNavigate(tool.screen)}>
                        Abrir
                      </CocoaButton>
                    </div>
                  </CocoaCard>
                </CocoaSpan>
              ))}
            </CocoaGrid>
          </CocoaSection>

          <p className="cocoa-note">{sourceNote}</p>
        </>
      ) : (
        <>
          {/* All setup items — grouped, collapsible index */}
          {groups.map(([group, groupOptions]) => {
            const done = countConfigured(groupOptions);
            const open = openGroups.has(group);
            const panelId = `setup-group-${group.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
            return (
              <CocoaSection
                key={group}
                title={group}
                meta={<CocoaBadge tone={progressTone(done, groupOptions.length)}>{done}/{groupOptions.length} configurados</CocoaBadge>}
                action={
                  <CocoaButton variant="plain" tone="neutral" size="small" aria-expanded={open} aria-controls={panelId} onClick={() => toggleGroup(group)}>
                    {open ? A11Y_LABELS.collapse : `${A11Y_LABELS.expand} · ${plural(groupOptions.length, "elemento", "elementos", { withCount: true })}`}
                  </CocoaButton>
                }
              >
                {open ? (
                  <div id={panelId} role="region" aria-label={group}>
                    <CocoaGrid>
                      {groupOptions.map((option) => (
                        <CocoaSpan cols={6} min={320} key={option.code}>
                          <OptionCard option={option} onSaved={markOptionSaved} />
                        </CocoaSpan>
                      ))}
                    </CocoaGrid>
                  </div>
                ) : (
                  <p className="cocoa-note">{plural(groupOptions.length, "elemento", "elementos", { withCount: true })} · despliega el área para configurarlos o rellenarlos aquí.</p>
                )}
              </CocoaSection>
            );
          })}
          <p className="cocoa-note">{sourceNote}</p>
        </>
      )}
    </CocoaPage>
  );
}

export function SetupCenterScreen({ embedded = false }: { embedded?: boolean } = {}) {
  return <SetupCenter initialTab="overview" embedded={embedded} />;
}
