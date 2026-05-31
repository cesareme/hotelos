import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useState } from "react";
import { MANUAL_SETUP_OPTIONS, type ManualSetupOption } from "@hotelos/product";
import { fetchManualSetupOptions, saveManualSetupOption, type ManualSetupSummary } from "../../services/backofficeApi";

type ManualSetupOptionView = ManualSetupOption & {
  setupState?: "not_started" | "saved" | "failed";
  latestSubmission?: { id: string; status: "saved" | "failed"; createdAt: string; validationErrorsJson?: string[] };
};

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}
function go(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

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

function setupBadge(option: ManualSetupOptionView): { label: string; cls: "ok" | "warn" | "error" } {
  if (option.setupState === "saved") return { label: "Configured", cls: "ok" };
  if (option.setupState === "failed") return { label: "Needs attention", cls: "error" };
  return { label: "Pending", cls: "warn" };
}

function countConfigured(options: ManualSetupOptionView[]): number {
  return options.filter((o) => o.setupState === "saved").length;
}

// Curated guided tools — entry points that are not part of the per-item index.
const GUIDED_TOOLS: Array<{ label: string; screen: string; hint: string }> = [
  { label: "Property Setup", screen: "PropertySetupHomeScreen", hint: "Structured forms for profile, rooms, spaces, departments" },
  { label: "Category Manager", screen: "CategoryManagerScreen", hint: "Reservation, revenue & compliance category options" },
  { label: "Property mapper", screen: "PropertyMapper", hint: "Visual map of buildings, floors, zones & rooms" },
  { label: "Setup checklist", screen: "PropertySetupWizard", hint: "Step-by-step go-live readiness wizard" },
  { label: "Start AI Setup", screen: "AISetupCenter", hint: "Open the AI-guided onboarding & migration wizard" }
];

function OptionCard({ option, onSaved }: { option: ManualSetupOptionView; onSaved: (optionCode: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const badge = setupBadge(option);

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
    <article className="bo-card bo-stack" style={{ gap: "var(--space-3)" }}>
      <div className="bo-card-head" style={{ marginBottom: 0 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{option.label}</h3>
          <p className="bo-option-desc">{option.description}</p>
        </div>
        <span className={`bo-status ${badge.cls}`}>{badge.label}</span>
      </div>

      {option.inputMethods.length ? (
        <div className="bo-pill-row">
          {option.inputMethods.map((method) => (
            <span className="bo-pill" key={method.code}>{method.label}</span>
          ))}
        </div>
      ) : null}

      <div className="bo-actions">
        <button type="button" className="primary" onClick={() => go(option.adminPath)}>Configurar</button>
        {option.latestSubmission ? (
          <small className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
            Last saved {new Date(option.latestSubmission.createdAt).toLocaleDateString("es-ES")}
          </small>
        ) : null}
      </div>

      <details>
        <summary style={{ cursor: "pointer", fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--ink-soft)" }}>
          Enter data here
        </summary>
        <div className="bo-stack" style={{ marginTop: "var(--space-3)" }}>
          <div className="bo-grid two">
            {option.requiredInputs.map((input) => (
              <label className="bo-form-field" key={input}>
                <span>{input}<strong> required</strong></span>
                <input
                  aria-label={input}
                  value={values[input] ?? ""}
                  onChange={(event) => setValues((current) => ({ ...current, [input]: event.currentTarget.value }))}
                  placeholder={input}
                />
              </label>
            ))}
          </div>
          <div className="bo-actions">
            <button className="primary" disabled={saveState === "saving"} onClick={handleSave} type="button">
              {saveState === "saving" ? "Guardando…" : "Guardar"}
            </button>
            {saveMessage ? (
              <small className={saveState === "error" ? "bo-field-error" : "bo-muted"} style={{ textTransform: "none", letterSpacing: 0 }}>
                {saveMessage}
              </small>
            ) : null}
          </div>
        </div>
      </details>

      {option.completionChecks.length ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "var(--fs-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)" }}>
            Completion checks
          </summary>
          <ul className="bo-list" style={{ marginTop: "var(--space-3)", fontSize: "var(--fs-xs)", color: "var(--ink-muted)" }}>
            {option.completionChecks.map((check) => (
              <li key={check.code}>
                <span className={`bo-status ${check.severity === "blocking" ? "error" : check.severity === "warning" ? "warn" : "ok"}`}>
                  {check.severity}
                </span>{" "}
                {check.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

export function SetupCenter({ initialTab = "overview" }: { initialTab?: "overview" | "items" }) {
  const [tab, setTab] = useState<"overview" | "items">(initialTab);
  const [options, setOptions] = useState<ManualSetupOptionView[]>(MANUAL_SETUP_OPTIONS);
  const [summary, setSummary] = useState<ManualSetupSummary>(() => buildSetupSummary(MANUAL_SETUP_OPTIONS));
  const [source, setSource] = useState<"static" | "api">("static");
  const [focusGroup, setFocusGroup] = useState<string | null>(null);
  const groups = groupManualSetupOptions(options);

  useEffect(() => {
    let mounted = true;
    fetchManualSetupOptions(getActivePropertyId())
      .then((payload) => {
        if (!mounted) return;
        setOptions(payload.options as ManualSetupOptionView[]);
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

  function openGroup(group: string) {
    setFocusGroup(group);
    setTab("items");
    window.scrollTo(0, 0);
  }

  const total = summary.totalOptions || 1;
  const pct = Math.round((summary.savedOptions / total) * 100);

  return (
    <>
      {/* Header + tabs */}
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">Back Office · Setup</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>Setup Center</h2>
          </div>
          <div className="bo-row">
            <button type="button" onClick={() => go("/backoffice/property-setup")}>Property Setup</button>
            <button type="button" onClick={() => go("/backoffice/configuration/categories")}>Category Manager</button>
          </div>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          One place to configure the property. <strong>Overview</strong> shows your go-live readiness; <strong>All setup items</strong> is the
          complete manual index — open an item to configure it, or fill it in inline.
        </p>

        <div className="bo-row" style={{ marginTop: "var(--space-4)", gap: "var(--space-2)" }}>
          <button type="button" className={tab === "overview" ? "primary" : ""} onClick={() => setTab("overview")}>Overview</button>
          <button type="button" className={tab === "items" ? "primary" : ""} onClick={() => setTab("items")}>All setup items</button>
        </div>
      </section>

      {tab === "overview" ? (
        <>
          {/* Progress overview */}
          <section className="bo-card">
            <div className="bo-stack" style={{ gap: "var(--space-3)" }}>
              <div className="bo-row" style={{ justifyContent: "space-between" }}>
                <strong>{summary.savedOptions} of {summary.totalOptions} configured</strong>
                <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>{pct}%</span>
              </div>
              <div className={`bo-progress-bar${pct >= 100 ? " ok" : ""}`}><span style={{ width: `${pct}%` }} /></div>
              <div className="bo-grid three" style={{ marginTop: "var(--space-2)" }}>
                <article className="rev-kpi rev-kpi-ok"><span className="rev-kpi-label">Configured</span><span className="rev-kpi-value">{summary.savedOptions}</span></article>
                <article className="rev-kpi rev-kpi-warn"><span className="rev-kpi-label">Pending</span><span className="rev-kpi-value">{summary.notStartedOptions}</span></article>
                <article className={`rev-kpi${summary.failedOptions ? " rev-kpi-error" : ""}`}><span className="rev-kpi-label">Needs attention</span><span className="rev-kpi-value">{summary.failedOptions}</span></article>
              </div>
            </div>
          </section>

          {/* Readiness by area (live, derived from manual-setup progress) */}
          <section className="bo-section">
            <div className="bo-card-head"><h3>Readiness by area</h3><span className="bo-chip">{groups.length} areas</span></div>
            <div className="bo-grid three">
              {groups.map(([group, groupOptions]) => {
                const done = countConfigured(groupOptions);
                const gp = Math.round((done / (groupOptions.length || 1)) * 100);
                const cls = gp >= 100 ? "ok" : done > 0 ? "warn" : "info";
                return (
                  <article className="bo-card bo-stack" key={group} style={{ gap: "var(--space-3)" }}>
                    <div className="bo-card-head" style={{ marginBottom: 0 }}>
                      <h3 style={{ margin: 0 }}>{group}</h3>
                      <span className={`bo-status ${cls}`}>{done}/{groupOptions.length}</span>
                    </div>
                    <div className={`bo-progress-bar${gp >= 100 ? " ok" : done > 0 ? " warn" : ""}`}><span style={{ width: `${gp}%` }} /></div>
                    <div className="bo-actions">
                      <button type="button" onClick={() => openGroup(group)}>View items</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {/* Guided tools */}
          <section className="bo-section">
            <div className="bo-card-head"><h3>Guided tools</h3></div>
            <div className="bo-grid three">
              {GUIDED_TOOLS.map((tool) => (
                <article className="bo-card bo-stack" key={tool.screen} style={{ gap: "var(--space-2)" }}>
                  <h3 style={{ margin: 0 }}>{tool.label}</h3>
                  <p className="bo-option-desc">{tool.hint}</p>
                  <div className="bo-actions"><button type="button" className="primary" onClick={() => nav(tool.screen)}>Abrir</button></div>
                </article>
              ))}
            </div>
          </section>

          <p className="bo-muted" style={{ textTransform: "none", letterSpacing: 0, textAlign: "center" }}>
            {summary.totalOptions} setup items · data source: {source}
          </p>
        </>
      ) : (
        <>
          {/* All setup items — grouped, collapsible index */}
          {groups.map(([group, groupOptions], index) => {
            const done = countConfigured(groupOptions);
            const gp = Math.round((done / (groupOptions.length || 1)) * 100);
            return (
              <details className="bo-section" key={group} open={index === 0 || group === focusGroup}>
                <summary style={{ cursor: "pointer", listStyle: "none" }}>
                  <div className="bo-card-head" style={{ marginBottom: 0, alignItems: "center" }}>
                    <div className="bo-row" style={{ gap: "var(--space-3)" }}>
                      <h3 style={{ margin: 0 }}>{group}</h3>
                      <span className={`bo-status ${gp >= 100 ? "ok" : done > 0 ? "warn" : "info"}`}>{done}/{groupOptions.length} configured</span>
                    </div>
                    <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>{groupOptions.length} items</span>
                  </div>
                </summary>
                <div className="bo-grid two" style={{ marginTop: "var(--space-4)" }}>
                  {groupOptions.map((option) => (
                    <OptionCard key={option.code} option={option} onSaved={markOptionSaved} />
                  ))}
                </div>
              </details>
            );
          })}
          <p className="bo-muted" style={{ textTransform: "none", letterSpacing: 0, textAlign: "center" }}>
            {summary.totalOptions} setup items · data source: {source}
          </p>
        </>
      )}
    </>
  );
}

export function SetupCenterScreen() {
  return <SetupCenter initialTab="overview" />;
}
