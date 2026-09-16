// Gobernanza de la IA — /configuracion/ia/gobernanza (hosted in
// InteligenciaArtificialTabs; Cocoa 22 · ola 10 · lote 10-B, plantilla
// DashboardAlojado).
//
// Five inner views over /ai-operations/governance/*: Políticas · Prompts ·
// Evaluaciones · Incidencias · Coste. Reads go through useApiData and writes
// through apiRequest, exactly as before; every outcome now reaches the toast
// instead of the old dismissable banner. Editing a policy's JSON, the results
// of an evaluation and the resolution of an incident open in a CocoaDrawer;
// the version history of a prompt paints under its table with the draft form
// and the diff. Same endpoints, bodies and screen key.

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { date, dateTime, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  toneBg,
  toneInk,
  type CocoaBarsDatum,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const GOV = "/ai-operations/governance";

type TabId = "policies" | "prompts" | "evaluations" | "incidents" | "cost";

// ---- shared types (mirror the governance.service.ts response shapes) ----

type PolicyRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  policyCode: string;
  name: string;
  configuration: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

type PromptGroup = {
  promptCode: string;
  versionCount: number;
  currentPublishedVersion?: string;
  currentPublishedId?: string;
  latestVersion?: string;
  updatedAt?: string;
};

type PromptVersionRecord = {
  id: string;
  promptCode: string;
  version: string;
  content: string;
  status: string;
  notes?: string;
  createdBy?: string;
  publishedAt?: string;
  archivedAt?: string;
  createdAt: string;
};

type PromptDiffLine = { type: "equal" | "added" | "removed"; lineNumber: number; text: string };
type PromptDiffResult = { a: PromptVersionRecord; b: PromptVersionRecord; diff: PromptDiffLine[] };

type EvaluationRecord = {
  id: string;
  evaluationName: string;
  evaluationType: string;
  promptCode?: string;
  status: string;
  score?: number;
  passRate?: number;
  sampleSize?: number;
  results: Record<string, unknown>;
  completedAt?: string;
  createdAt: string;
};

type IncidentRecord = {
  id: string;
  incidentType: string;
  severity: string;
  title: string;
  description?: string;
  status: string;
  assignedTo?: string;
  rootCause?: string;
  resolutionNotes?: string;
  createdAt: string;
  resolvedAt?: string;
};

type CostDashboard = {
  totalCostEur: number;
  totalTokens: number;
  byTool: Array<{ toolName: string; costEur: number; tokens: number; calls: number }>;
  byModel: Array<{ model: string; costEur: number; calls: number }>;
  dailyTrend: Array<{ date: string; costEur: number; calls: number }>;
  projectedMonthlyEur: number;
  windowDays: number;
};

type Notify = (message: string, variant?: "success" | "error") => void;

// ---- labels and tones (API values stay in English; the screen speaks Spanish) ----

const SEVERITY_LABEL: Record<string, string> = { low: "baja", medium: "media", high: "alta", critical: "crítica" };
const SEVERITY_OPTIONS = ["low", "medium", "high", "critical"].map((value) => ({ value, label: SEVERITY_LABEL[value] }));
const EVALUATION_TYPE_LABEL: Record<string, string> = { quality: "Calidad", accuracy: "Precisión", safety: "Seguridad", regression: "Regresión" };
const EVALUATION_TYPE_OPTIONS = ["quality", "accuracy", "safety", "regression"].map((value) => ({ value, label: EVALUATION_TYPE_LABEL[value] }));
const INCIDENT_TYPE_LABEL: Record<string, string> = {
  hallucination: "Alucinación",
  policy_violation: "Incumplimiento de política",
  data_leak: "Fuga de datos",
  bias: "Sesgo",
  other: "Otro"
};
const INCIDENT_TYPE_OPTIONS = ["hallucination", "policy_violation", "data_leak", "bias", "other"].map((value) => ({ value, label: INCIDENT_TYPE_LABEL[value] }));
const RECORD_STATUS_LABEL: Record<string, string> = {
  resolved: "resuelta",
  completed: "completada",
  published: "publicada",
  failed: "fallida",
  open: "abierta",
  archived: "archivada",
  draft: "borrador",
  pending: "pendiente",
  running: "en curso",
  in_progress: "en curso",
  skipped: "omitida"
};

function severityTone(severity?: string): CocoaTone {
  const s = (severity ?? "").toLowerCase();
  if (s === "critical" || s === "high") return "danger";
  if (s === "medium") return "warning";
  return "success";
}

function severityBadge(severity?: string) {
  const s = (severity ?? "").toLowerCase();
  return (
    <CocoaBadge tone={severityTone(severity)} variant="tinted" size="small">
      {SEVERITY_LABEL[s] ?? severity ?? "—"}
    </CocoaBadge>
  );
}

function recordStatusTone(status?: string): CocoaTone {
  const s = (status ?? "").toLowerCase();
  if (s === "resolved" || s === "completed" || s === "published") return "success";
  if (s === "failed" || s === "open") return "danger";
  if (s === "archived") return "neutral";
  return "warning";
}

function statusBadge(status?: string) {
  const s = (status ?? "").toLowerCase();
  return (
    <CocoaBadge tone={recordStatusTone(status)} variant="tinted" size="small">
      {RECORD_STATUS_LABEL[s] ?? status ?? "—"}
    </CocoaBadge>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Code blocks (JSON, diff) and one-line JSON previews: tokens only (rule 6).
const codeStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--cocoa-font-mono)",
  fontSize: "var(--cocoa-fs-caption)",
  lineHeight: "var(--cocoa-leading-text)",
  color: "var(--cocoa-label)",
  background: "var(--cocoa-fill-quaternary)",
  borderRadius: "var(--cocoa-radius-md)",
  padding: "var(--cocoa-space-3)",
  maxHeight: 320,
  overflow: "auto"
};

function diffLineStyle(type: PromptDiffLine["type"]): CSSProperties {
  if (type === "equal") return { color: "var(--cocoa-label-secondary)" };
  const tone: CocoaTone = type === "added" ? "success" : "danger";
  return { color: toneInk(tone), background: toneBg(tone) };
}

// =====================================================================================
// Policies
// =====================================================================================

const POLICY_COLUMNS: CocoaTableColumn<PolicyRecord>[] = [
  {
    key: "name",
    label: "Política",
    minWidth: 200,
    render: (p) => (
      <>
        <strong>{p.name}</strong>
        <span className="cocoa-note">
          <code className="cocoa-mono">{p.policyCode}</code>
        </span>
      </>
    )
  },
  {
    key: "configuration",
    label: "Configuración",
    minWidth: 240,
    render: (p) => (
      <code className="cocoa-mono cocoa-truncate" style={{ display: "block", maxWidth: 480 }}>
        {JSON.stringify(p.configuration ?? {})}
      </code>
    )
  },
  {
    key: "active",
    label: "Activa",
    fit: true,
    render: (p) => (
      <CocoaBadge tone={p.active ? "success" : "neutral"} variant="tinted" size="small">
        {p.active ? "activa" : "desactivada"}
      </CocoaBadge>
    )
  }
];

function PoliciesTab({ notify }: { notify: Notify }) {
  const { data, loading, error, refresh } = useApiData<PolicyRecord[]>(`${GOV}/policies`);
  const [editing, setEditing] = useState<PolicyRecord | null>(null);
  const [draftJson, setDraftJson] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const policies = useMemo(() => toArray<PolicyRecord>(data), [data]);

  const jsonError = useMemo(() => {
    if (!editing) return undefined;
    try {
      JSON.parse(draftJson);
      return undefined;
    } catch {
      return "La configuración debe ser un JSON válido.";
    }
  }, [editing, draftJson]);

  async function toggleActive(p: PolicyRecord) {
    setBusy(p.id);
    try {
      await apiRequest(`${GOV}/policies/${p.id}/active`, { method: "POST", body: { active: !p.active } });
      notify(`Política «${p.name}» ${p.active ? "desactivada" : "activada"}.`);
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(p: PolicyRecord) {
    setEditing(p);
    setDraftJson(JSON.stringify(p.configuration ?? {}, null, 2));
  }

  async function saveConfig() {
    if (!editing || jsonError) return;
    const p = editing;
    setBusy(p.id);
    try {
      await apiRequest(`${GOV}/policies`, { method: "POST", body: { policyCode: p.policyCode, configuration: JSON.parse(draftJson) as Record<string, unknown> } });
      notify(`Configuración de la política «${p.name}» guardada.`);
      setEditing(null);
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  const ready = !error && !(loading && policies.length === 0);

  return (
    <>
      <CocoaSection
        title="Políticas"
        meta={plural(policies.length, "política", "políticas")}
        padding={ready && policies.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      >
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar las políticas" message={error} onRetry={refresh} />
        ) : !loading && policies.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay políticas configuradas." />
        ) : (
          <CocoaTable
            columns={POLICY_COLUMNS}
            rows={policies}
            rowKey="id"
            loading={loading && policies.length === 0}
            rowActionsVisible="always"
            rowActions={(p) => (
              <>
                <CocoaButton variant="plain" size="small" onClick={() => startEdit(p)}>
                  {ACTIONS.edit}
                </CocoaButton>
                <CocoaButton variant="plain" size="small" tone={p.active ? "neutral" : "accent"} disabled={busy === p.id} loading={busy === p.id} onClick={() => void toggleActive(p)}>
                  {p.active ? ACTIONS.deactivate : ACTIONS.activate}
                </CocoaButton>
              </>
            )}
            caption="Políticas de la IA"
            aria-label="Políticas de la IA"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Editar política: ${editing.name}` : "Editar política"}
        subtitle={editing?.policyCode}
        side="right"
        size="md"
        footer={
          <div className="cocoa-row" data-justify="end" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setEditing(null)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" disabled={Boolean(jsonError) || busy === editing?.id} loading={busy === editing?.id} onClick={() => void saveConfig()}>
              {ACTIONS.save}
            </CocoaButton>
          </div>
        }
      >
        <CocoaFormSection title="Configuración" description="Reglas de la política en formato JSON. Se guardan tal cual las escribas.">
          <CocoaField label="Configuración (JSON)" error={jsonError} fullWidth>
            <CocoaInput value={draftJson} onChange={setDraftJson} multiline rows={14} className="cocoa-mono" />
          </CocoaField>
        </CocoaFormSection>
      </CocoaDrawer>
    </>
  );
}

// =====================================================================================
// Prompts
// =====================================================================================

const PROMPT_COLUMNS: CocoaTableColumn<PromptGroup>[] = [
  { key: "promptCode", label: "Código de prompt", minWidth: 180, render: (g) => <strong>{g.promptCode}</strong> },
  { key: "versionCount", label: "Versiones", align: "right", fit: true, render: (g) => number(g.versionCount) },
  {
    key: "currentPublishedVersion",
    label: "Publicada",
    fit: true,
    render: (g) =>
      g.currentPublishedVersion ? (
        <CocoaBadge tone="success" variant="tinted" size="small">
          {g.currentPublishedVersion}
        </CocoaBadge>
      ) : (
        <span className="cocoa-note">ninguna</span>
      )
  },
  { key: "latestVersion", label: "Última", fit: true, hideOnNarrow: true, render: (g) => g.latestVersion ?? "—" },
  { key: "updatedAt", label: "Actualizado", fit: true, showFrom: "laptop", render: (g) => dateTime(g.updatedAt) }
];

const VERSION_COLUMNS: CocoaTableColumn<PromptVersionRecord>[] = [
  { key: "version", label: "Versión", fit: true, render: (v) => <strong>{v.version}</strong> },
  { key: "status", label: "Estado", fit: true, render: (v) => statusBadge(v.status) },
  { key: "notes", label: "Notas", minWidth: 160, render: (v) => v.notes ?? <span className="cocoa-note">—</span> },
  { key: "publishedAt", label: "Publicada", fit: true, showFrom: "laptop", render: (v) => dateTime(v.publishedAt) },
  { key: "createdAt", label: "Creada", fit: true, hideOnNarrow: true, render: (v) => dateTime(v.createdAt) }
];

function PromptsTab({ notify }: { notify: Notify }) {
  const { data: groups, loading, error, refresh } = useApiData<PromptGroup[]>(`${GOV}/prompts`);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const versionsState = useApiData<PromptVersionRecord[]>(selectedCode ? `${GOV}/prompts/${encodeURIComponent(selectedCode)}/versions` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [diffA, setDiffA] = useState<string>("");
  const [diffB, setDiffB] = useState<string>("");
  const [diff, setDiff] = useState<PromptDiffResult | null>(null);
  const [newContent, setNewContent] = useState<string>("");
  const [newNotes, setNewNotes] = useState<string>("");

  const list = useMemo(() => toArray<PromptGroup>(groups), [groups]);
  const vlist = useMemo(() => toArray<PromptVersionRecord>(versionsState.data), [versionsState.data]);
  const versionOptions = useMemo(() => vlist.map((v) => ({ value: v.id, label: `${v.version} (${RECORD_STATUS_LABEL[v.status.toLowerCase()] ?? v.status})` })), [vlist]);

  function refreshAll() {
    refresh();
    versionsState.refresh();
  }

  function select(code: string) {
    setSelectedCode(code);
    setDiff(null);
    setDiffA("");
    setDiffB("");
  }

  async function publish(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/prompts/versions/${id}/publish`, { method: "POST" });
      notify("Versión del prompt publicada.");
      refreshAll();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function archive(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/prompts/versions/${id}/archive`, { method: "POST" });
      notify("Versión del prompt archivada.");
      refreshAll();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function addVersion() {
    if (!selectedCode || !newContent.trim()) {
      notify("Primero elige un prompt e introduce su contenido.", "error");
      return;
    }
    setBusy("new");
    try {
      await apiRequest(`${GOV}/prompts/versions`, {
        method: "POST",
        body: { promptCode: selectedCode, content: newContent, notes: newNotes || undefined }
      });
      notify("Nueva versión en borrador creada.");
      setNewContent("");
      setNewNotes("");
      refreshAll();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function runDiff() {
    if (!diffA || !diffB) {
      notify("Selecciona dos versiones para comparar.", "error");
      return;
    }
    try {
      const result = await apiRequest<PromptDiffResult>(`${GOV}/prompts/diff`, { query: { a: diffA, b: diffB } });
      setDiff(result);
    } catch (e) {
      notify(errorText(e), "error");
    }
  }

  const ready = !error && !(loading && list.length === 0);
  const versionsLoading = versionsState.loading && vlist.length === 0;

  return (
    <>
      <CocoaSection
        title="Prompts (instrucciones a la IA)"
        meta={plural(list.length, "código de prompt", "códigos de prompt")}
        padding={ready && list.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      >
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar los prompts" message={error} onRetry={refresh} />
        ) : !loading && list.length === 0 ? (
          <CocoaState kind="empty" inline title="Aún no hay prompts." />
        ) : (
          <CocoaTable
            columns={PROMPT_COLUMNS}
            rows={list}
            rowKey="promptCode"
            loading={loading && list.length === 0}
            selectedKey={selectedCode ?? undefined}
            onSelect={(g) => select(g.promptCode)}
            rowActionsVisible="always"
            rowActions={(g) => (
              <CocoaButton
                variant="plain"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  select(g.promptCode);
                }}
              >
                Ver historial
              </CocoaButton>
            )}
            caption="Prompts de la IA"
            aria-label="Prompts de la IA"
          />
        )}
      </CocoaSection>

      {selectedCode ? (
        <>
          <CocoaSection
            title={`Historial de versiones · ${selectedCode}`}
            meta={plural(vlist.length, "versión", "versiones")}
            padding={vlist.length > 0 || versionsLoading ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {versionsState.error ? (
              <CocoaState kind="error" title="No se pudieron cargar las versiones" message={versionsState.error} onRetry={versionsState.refresh} />
            ) : !versionsState.loading && vlist.length === 0 ? (
              <CocoaState kind="empty" inline title="Este prompt aún no tiene versiones." />
            ) : (
              <CocoaTable
                columns={VERSION_COLUMNS}
                rows={vlist}
                rowKey="id"
                loading={versionsLoading}
                rowActionsVisible="always"
                rowActions={(v) => (
                  <>
                    {v.status !== "published" ? (
                      <CocoaButton variant="plain" size="small" tone="accent" disabled={busy === v.id} loading={busy === v.id} onClick={() => void publish(v.id)}>
                        {ACTIONS.publish}
                      </CocoaButton>
                    ) : null}
                    {v.status !== "archived" ? (
                      <CocoaButton variant="plain" size="small" tone="neutral" disabled={busy === v.id} onClick={() => void archive(v.id)}>
                        {ACTIONS.archive}
                      </CocoaButton>
                    ) : null}
                  </>
                )}
                caption={`Versiones de ${selectedCode}`}
                aria-label={`Versiones de ${selectedCode}`}
              />
            )}
          </CocoaSection>

          <CocoaGrid align="start">
            <CocoaSpan cols={6} min={320}>
              <CocoaFormSection
                title="Nueva versión en borrador"
                description="El borrador no se usa hasta que se publique."
                actions={
                  <CocoaButton variant="filled" tone="accent" size="small" disabled={busy === "new" || !newContent.trim()} loading={busy === "new"} onClick={() => void addVersion()}>
                    Crear borrador
                  </CocoaButton>
                }
              >
                <CocoaField label="Contenido del prompt" required fullWidth>
                  <CocoaInput value={newContent} onChange={setNewContent} multiline rows={5} placeholder="Contenido del prompt…" className="cocoa-mono" />
                </CocoaField>
                <CocoaField label="Notas" hint={STATUS_LABELS.optional.toLowerCase()} fullWidth>
                  <CocoaInput value={newNotes} onChange={setNewNotes} placeholder="Qué cambia en esta versión" />
                </CocoaField>
              </CocoaFormSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaFormSection
                title="Comparar versiones"
                description="Líneas añadidas y retiradas entre dos versiones del prompt."
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" disabled={!diffA || !diffB} onClick={() => void runDiff()}>
                    Comparar
                  </CocoaButton>
                }
              >
                <CocoaFormRow columns={2}>
                  <CocoaField label="Versión A">
                    <CocoaSelect value={diffA} onChange={setDiffA} placeholder="Versión A…" options={versionOptions} />
                  </CocoaField>
                  <CocoaField label="Versión B">
                    <CocoaSelect value={diffB} onChange={setDiffB} placeholder="Versión B…" options={versionOptions} />
                  </CocoaField>
                </CocoaFormRow>
                {diff ? (
                  <pre style={codeStyle} aria-label={`Diferencias entre ${diff.a.version} y ${diff.b.version}`}>
                    {diff.diff.map((line, i) => (
                      <div key={i} style={diffLineStyle(line.type)}>
                        {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
                        {line.text}
                      </div>
                    ))}
                  </pre>
                ) : null}
              </CocoaFormSection>
            </CocoaSpan>
          </CocoaGrid>
        </>
      ) : null}
    </>
  );
}

// =====================================================================================
// Evaluations
// =====================================================================================

const EVALUATION_COLUMNS: CocoaTableColumn<EvaluationRecord>[] = [
  { key: "evaluationName", label: "Nombre", minWidth: 180, render: (ev) => <strong>{ev.evaluationName}</strong> },
  { key: "evaluationType", label: "Tipo", fit: true, render: (ev) => EVALUATION_TYPE_LABEL[ev.evaluationType] ?? ev.evaluationType },
  { key: "promptCode", label: "Prompt", fit: true, hideOnNarrow: true, render: (ev) => ev.promptCode ?? <span className="cocoa-note">—</span> },
  { key: "status", label: "Estado", fit: true, render: (ev) => statusBadge(ev.status) },
  { key: "score", label: "Puntuación", align: "right", fit: true, render: (ev) => (ev.score === undefined ? "—" : number(ev.score, { maximumFractionDigits: 1 })) },
  {
    key: "passRate",
    label: "Tasa de aprobación",
    align: "right",
    fit: true,
    hideOnNarrow: true,
    render: (ev) => percent(ev.passRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  },
  { key: "sampleSize", label: "Muestra", align: "right", fit: true, showFrom: "laptop", render: (ev) => (ev.sampleSize === undefined ? "—" : number(ev.sampleSize)) },
  { key: "completedAt", label: "Completada", fit: true, showFrom: "desktop", render: (ev) => dateTime(ev.completedAt) }
];

function EvaluationsTab({ notify }: { notify: Notify }) {
  const { data, loading, error, refresh } = useApiData<EvaluationRecord[]>(`${GOV}/evaluations`);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<EvaluationRecord | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("quality");
  const [promptCode, setPromptCode] = useState("");
  const evals = useMemo(() => toArray<EvaluationRecord>(data), [data]);

  async function create() {
    if (!name.trim()) {
      notify("El nombre de la evaluación es obligatorio.", "error");
      return;
    }
    setBusy("new");
    try {
      await apiRequest(`${GOV}/evaluations`, { method: "POST", body: { evaluationName: name, evaluationType: type, promptCode: promptCode || undefined } });
      notify("Evaluación creada (pendiente).");
      setName("");
      setPromptCode("");
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function run(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/evaluations/${id}/run`, { method: "POST" });
      notify("Ejecución de la evaluación completada.");
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  const ready = !error && !(loading && evals.length === 0);

  return (
    <>
      <CocoaFormSection
        title="Nueva evaluación"
        description="Mide la calidad, la precisión o la seguridad de un prompt sobre una muestra."
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" disabled={busy === "new" || !name.trim()} loading={busy === "new"} onClick={() => void create()}>
            {ACTIONS.create}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={3}>
          <CocoaField label="Nombre de la evaluación" required>
            <CocoaInput value={name} onChange={setName} placeholder="Respuestas al huésped · septiembre" />
          </CocoaField>
          <CocoaField label="Tipo">
            <CocoaSelect value={type} onChange={setType} options={EVALUATION_TYPE_OPTIONS} />
          </CocoaField>
          <CocoaField label="Código de prompt" hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaInput value={promptCode} onChange={setPromptCode} placeholder="guest_reply" />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaSection
        title="Evaluaciones"
        meta={plural(evals.length, "evaluación", "evaluaciones")}
        padding={ready && evals.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      >
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar las evaluaciones" message={error} onRetry={refresh} />
        ) : !loading && evals.length === 0 ? (
          <CocoaState kind="empty" inline title="Aún no hay evaluaciones." />
        ) : (
          <CocoaTable
            columns={EVALUATION_COLUMNS}
            rows={evals}
            rowKey="id"
            loading={loading && evals.length === 0}
            rowActionsVisible="always"
            rowActions={(ev) => (
              <>
                <CocoaButton variant="plain" size="small" tone="accent" disabled={busy === ev.id} loading={busy === ev.id} onClick={() => void run(ev.id)}>
                  Ejecutar
                </CocoaButton>
                {ev.status === "completed" || ev.status === "skipped" ? (
                  <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => setResults(ev)}>
                    {ev.status === "skipped" ? "Por qué" : "Resultados"}
                  </CocoaButton>
                ) : null}
              </>
            )}
            caption="Evaluaciones de la IA"
            aria-label="Evaluaciones de la IA"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={results !== null}
        onClose={() => setResults(null)}
        title={results ? `Resultados: ${results.evaluationName}` : "Resultados"}
        subtitle={results ? `${EVALUATION_TYPE_LABEL[results.evaluationType] ?? results.evaluationType} · ${RECORD_STATUS_LABEL[results.status.toLowerCase()] ?? results.status}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setResults(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {results ? <pre style={codeStyle}>{JSON.stringify(results.results, null, 2)}</pre> : null}
      </CocoaDrawer>
    </>
  );
}

// =====================================================================================
// Incidents
// =====================================================================================

const INCIDENT_COLUMNS: CocoaTableColumn<IncidentRecord>[] = [
  { key: "severity", label: "Gravedad", fit: true, render: (inc) => severityBadge(inc.severity) },
  {
    key: "title",
    label: "Título",
    minWidth: 220,
    render: (inc) => (
      <>
        <strong>{inc.title}</strong>
        {inc.description ? <span className="cocoa-note">{inc.description}</span> : null}
        {inc.status === "resolved" && (inc.rootCause || inc.resolutionNotes) ? (
          <span className="cocoa-note">
            Causa raíz: {inc.rootCause ?? "—"} · Notas: {inc.resolutionNotes ?? "—"} · Resuelta {dateTime(inc.resolvedAt)}
          </span>
        ) : null}
      </>
    )
  },
  { key: "incidentType", label: "Tipo", fit: true, hideOnNarrow: true, render: (inc) => INCIDENT_TYPE_LABEL[inc.incidentType] ?? inc.incidentType },
  { key: "status", label: "Estado", fit: true, render: (inc) => statusBadge(inc.status) },
  { key: "assignedTo", label: "Asignada a", fit: true, showFrom: "laptop", render: (inc) => inc.assignedTo ?? <span className="cocoa-note">—</span> },
  { key: "createdAt", label: "Creada", fit: true, showFrom: "desktop", render: (inc) => dateTime(inc.createdAt) }
];

function IncidentsTab({ notify }: { notify: Notify }) {
  const { data, loading, error, refresh } = useApiData<IncidentRecord[]>(`${GOV}/incidents`);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [incidentType, setIncidentType] = useState("hallucination");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [resolving, setResolving] = useState<IncidentRecord | null>(null);
  const [rootCause, setRootCause] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const incidents = useMemo(() => toArray<IncidentRecord>(data), [data]);

  async function create() {
    if (!title.trim()) {
      notify("El título es obligatorio.", "error");
      return;
    }
    setBusy("new");
    try {
      await apiRequest(`${GOV}/incidents`, { method: "POST", body: { title, incidentType, severity, description: description || undefined } });
      notify("Incidencia creada.");
      setTitle("");
      setDescription("");
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function assign(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/incidents/${id}/assign`, { method: "POST", body: {} });
      notify("Incidencia asignada a ti.");
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function reopen(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/incidents/${id}/reopen`, { method: "POST" });
      notify("Incidencia reabierta.");
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function resolve() {
    if (!resolving) return;
    const id = resolving.id;
    setBusy(id);
    try {
      await apiRequest(`${GOV}/incidents/${id}/resolve`, { method: "POST", body: { rootCause, resolutionNotes } });
      notify("Incidencia resuelta.");
      setResolving(null);
      setRootCause("");
      setResolutionNotes("");
      refresh();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  const ready = !error && !(loading && incidents.length === 0);

  return (
    <>
      <CocoaFormSection
        title="Nueva incidencia"
        description="Registra un comportamiento de la IA que haya que revisar."
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" disabled={busy === "new" || !title.trim()} loading={busy === "new"} onClick={() => void create()}>
            {ACTIONS.create}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={4}>
          <CocoaField label="Título de la incidencia" required>
            <CocoaInput value={title} onChange={setTitle} placeholder="Respuesta inventada sobre el desayuno" />
          </CocoaField>
          <CocoaField label="Tipo">
            <CocoaSelect value={incidentType} onChange={setIncidentType} options={INCIDENT_TYPE_OPTIONS} />
          </CocoaField>
          <CocoaField label="Gravedad">
            <CocoaSelect value={severity} onChange={setSeverity} options={SEVERITY_OPTIONS} />
          </CocoaField>
          <CocoaField label="Descripción" hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaInput value={description} onChange={setDescription} placeholder="Qué ocurrió y dónde" />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaSection
        title="Incidencias"
        meta={plural(incidents.length, "incidencia", "incidencias")}
        padding={ready && incidents.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
      >
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar las incidencias" message={error} onRetry={refresh} />
        ) : !loading && incidents.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay incidencias registradas." />
        ) : (
          <CocoaTable
            columns={INCIDENT_COLUMNS}
            rows={incidents}
            rowKey="id"
            loading={loading && incidents.length === 0}
            rowTone={(inc) => (inc.status === "resolved" ? undefined : severityTone(inc.severity) === "success" ? undefined : severityTone(inc.severity))}
            rowActionsVisible="always"
            rowActions={(inc) =>
              inc.status !== "resolved" ? (
                <>
                  <CocoaButton variant="plain" size="small" tone="neutral" disabled={busy === inc.id} onClick={() => void assign(inc.id)}>
                    {ACTIONS.assign}
                  </CocoaButton>
                  <CocoaButton variant="plain" size="small" tone="accent" disabled={busy === inc.id} onClick={() => setResolving(inc)}>
                    Resolver
                  </CocoaButton>
                </>
              ) : (
                <CocoaButton variant="plain" size="small" tone="neutral" disabled={busy === inc.id} loading={busy === inc.id} onClick={() => void reopen(inc.id)}>
                  {ACTIONS.reopen}
                </CocoaButton>
              )
            }
            caption="Incidencias de la IA"
            aria-label="Incidencias de la IA"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={resolving !== null}
        onClose={() => setResolving(null)}
        title={resolving ? `Resolver: ${resolving.title}` : "Resolver incidencia"}
        subtitle={resolving ? `${INCIDENT_TYPE_LABEL[resolving.incidentType] ?? resolving.incidentType} · gravedad ${SEVERITY_LABEL[resolving.severity.toLowerCase()] ?? resolving.severity}` : undefined}
        side="right"
        size="md"
        footer={
          <div className="cocoa-row" data-justify="end" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setResolving(null)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" disabled={busy === resolving?.id} loading={busy === resolving?.id} onClick={() => void resolve()}>
              Confirmar resolución
            </CocoaButton>
          </div>
        }
      >
        <CocoaFormSection title="Resolución" description="Qué la provocó y qué se ha hecho para que no se repita.">
          <CocoaField label="Causa raíz" fullWidth>
            <CocoaInput value={rootCause} onChange={setRootCause} placeholder="Causa raíz" />
          </CocoaField>
          <CocoaField label="Notas de resolución" fullWidth>
            <CocoaInput value={resolutionNotes} onChange={setResolutionNotes} multiline rows={4} placeholder="Notas de resolución" />
          </CocoaField>
        </CocoaFormSection>
      </CocoaDrawer>
    </>
  );
}

// =====================================================================================
// Cost
// =====================================================================================

const WINDOW_OPTIONS = [
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
  { value: "90", label: "90 días" }
];

type ToolCost = CostDashboard["byTool"][number];
type ModelCost = CostDashboard["byModel"][number];

const TOOL_COST_COLUMNS: CocoaTableColumn<ToolCost>[] = [
  { key: "toolName", label: "Herramienta", minWidth: 160, render: (t) => <strong>{t.toolName}</strong> },
  { key: "costEur", label: "Coste", align: "right", fit: true, render: (t) => money(t.costEur) },
  { key: "tokens", label: "Tokens (uso del modelo)", align: "right", fit: true, hideOnNarrow: true, render: (t) => number(t.tokens) },
  { key: "calls", label: "Llamadas", align: "right", fit: true, render: (t) => number(t.calls) }
];

const MODEL_COST_COLUMNS: CocoaTableColumn<ModelCost>[] = [
  { key: "model", label: "Modelo", minWidth: 160, render: (m) => <strong>{m.model}</strong> },
  { key: "costEur", label: "Coste", align: "right", fit: true, render: (m) => money(m.costEur) },
  { key: "calls", label: "Llamadas", align: "right", fit: true, render: (m) => number(m.calls) }
];

function CostTab() {
  const [days, setDays] = useState("30");
  const { data, loading, error, refresh } = useApiData<CostDashboard>(`${GOV}/cost`, { query: { days: Number(days) } });
  const byTool = useMemo(() => toArray<ToolCost>(data?.byTool), [data]);
  const byModel = useMemo(() => toArray<ModelCost>(data?.byModel), [data]);
  const daily = useMemo(() => toArray<CostDashboard["dailyTrend"][number]>(data?.dailyTrend), [data]);
  const bars: CocoaBarsDatum[] = useMemo(
    () => daily.map((d) => ({ label: date(d.date, "dayMonth"), value: d.costEur, tone: "accent" as const, hint: plural(d.calls, "llamada", "llamadas") })),
    [daily]
  );
  const windowDays = data?.windowDays ?? Number(days);

  return (
    <>
      <CocoaSection
        title="Panel de costes"
        meta={`Gasto · últimos ${plural(windowDays, "día", "días")}`}
        action={
          <div className="cocoa-row" data-gap="2">
            <CocoaSelect value={days} onChange={setDays} options={WINDOW_OPTIONS} size="small" inline aria-label="Ventana de días" />
            <CocoaButton variant="plain" tone="accent" size="small" onClick={refresh}>
              {ACTIONS.refresh}
            </CocoaButton>
          </div>
        }
      >
        {error && !data ? (
          <CocoaState kind="error" title="No se pudieron cargar los datos de coste" message={error} onRetry={refresh} />
        ) : loading && !data ? (
          <CocoaSkeleton.Strip count={4} />
        ) : (
          <CocoaKpiStrip aria-label="Coste de la IA">
            <CocoaKpi label="Coste total" value={money(data?.totalCostEur)} caption="Total del periodo" polarity="neutral" status="ok" />
            <CocoaKpi label="Tokens totales (uso del modelo)" value={number(data?.totalTokens)} caption="Entrada + salida" polarity="neutral" status="ok" />
            <CocoaKpi label="Proyectado / mes" value={money(data?.projectedMonthlyEur)} caption="Ritmo de gasto × 30 días" polarity="neutral" status="warning" />
            <CocoaKpi label="Herramientas activas" value={byTool.length} caption="Herramientas distintas con gasto" polarity="neutral" status="ok" />
          </CocoaKpiStrip>
        )}
      </CocoaSection>

      <CocoaGrid align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Coste por herramienta" meta={plural(byTool.length, "herramienta", "herramientas")} padding={byTool.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {byTool.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin gasto en el periodo." />
            ) : (
              <CocoaTable columns={TOOL_COST_COLUMNS} rows={byTool} rowKey="toolName" caption="Coste por herramienta" aria-label="Coste por herramienta" />
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Coste por modelo" meta={plural(byModel.length, "modelo", "modelos")} padding={byModel.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {byModel.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin gasto en el periodo." />
            ) : (
              <CocoaTable columns={MODEL_COST_COLUMNS} rows={byModel} rowKey="model" caption="Coste por modelo" aria-label="Coste por modelo" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Coste por día" meta={plural(daily.length, "día", "días")}>
        {daily.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin gasto en el periodo." />
        ) : (
          <CocoaChart.Bars data={bars} height={160} valueFormat={(v) => money(v)} aria-label={`Coste diario de la IA en los últimos ${plural(windowDays, "día", "días")}`} />
        )}
      </CocoaSection>
    </>
  );
}

// =====================================================================================
// Root screen
// =====================================================================================

const VIEWS: Array<{ value: TabId; label: string }> = [
  { value: "policies", label: "Políticas" },
  { value: "prompts", label: "Prompts" },
  { value: "evaluations", label: "Evaluaciones" },
  { value: "incidents", label: "Incidencias" },
  { value: "cost", label: "Coste" }
];

export function AiGovernanceScreen({ embedded = false }: { embedded?: boolean } = {}) {
  // Hosted (InteligenciaArtificialTabs): the container paints eyebrow + H1; `embedded` is the L1c bridge prop.
  const hosted = useTabHost() !== null || embedded;
  const [tab, setTab] = useState<TabId>("policies");
  const { showToast } = useToast();
  const notify = useCallback<Notify>((message, variant = "success") => showToast(message, { variant }), [showToast]);

  return (
    <CocoaPage
      eyebrow="Configuración · Inteligencia artificial"
      title="Gobernanza de la IA"
      subtitle={
        hosted
          ? undefined
          : "Políticas, versiones de prompts (instrucciones a la IA), evaluaciones, gestión de incidencias y coste: el panel de control de la IA para operar de forma segura en toda la cartera de hoteles."
      }
      tabs={VIEWS}
      activeTab={tab}
      onTabChange={(value) => setTab(value as TabId)}
    >
      {tab === "policies" ? <PoliciesTab notify={notify} /> : null}
      {tab === "prompts" ? <PromptsTab notify={notify} /> : null}
      {tab === "evaluations" ? <EvaluationsTab notify={notify} /> : null}
      {tab === "incidents" ? <IncidentsTab notify={notify} /> : null}
      {tab === "cost" ? <CostTab /> : null}
    </CocoaPage>
  );
}

export default AiGovernanceScreen;
