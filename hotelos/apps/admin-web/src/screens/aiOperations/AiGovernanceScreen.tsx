import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { LoadingBlock, Spinner } from "../../components/States";
import { toArray } from "../../utils/toArray";

// =====================================================================================
// IA · Gobernanza — centro de gobernanza de la IA
// Tabbed read+write screen over /ai-operations/governance/*:
//   Policies · Prompts · Evaluations · Incidents · Cost
// Aurora v2 styling (bo-card / rev-kpi / cm-table / cm-pill classes). Uses useApiData
// for reads and apiRequest for mutations. Not wired into App.tsx/Sidebar (orchestrator).
// =====================================================================================

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

// ---- formatters ----

const eur = new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("es-ES", { useGrouping: true, maximumFractionDigits: 0 });

function fmtEur(v: number | null | undefined): string {
  return eur.format(Number.isFinite(v as number) ? (v as number) : 0);
}
function fmtNum(v: number | null | undefined): string {
  return num.format(Number.isFinite(v as number) ? (v as number) : 0);
}
function fmtPct(v: number | null | undefined): string {
  return v === undefined || v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}
function fmtDateTime(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(d);
}

function severityClass(severity?: string): "ok" | "warn" | "error" {
  const s = (severity ?? "").toLowerCase();
  if (s === "critical" || s === "high") return "error";
  if (s === "medium") return "warn";
  return "ok";
}
function severityPill(severity?: string) {
  const status = severityClass(severity);
  const cls = status === "ok" ? "cm-pill-ok" : status === "warn" ? "cm-pill-warn" : "cm-pill-error";
  return <span className={`cm-pill ${cls}`}>{severity ?? "—"}</span>;
}
function statusPill(status?: string) {
  const s = (status ?? "").toLowerCase();
  if (s === "resolved" || s === "completed" || s === "published") return <span className="cm-pill cm-pill-ok">{status}</span>;
  if (s === "failed" || s === "open") return <span className="cm-pill cm-pill-error">{status}</span>;
  if (s === "archived") return <span className="cm-pill">{status}</span>;
  return <span className="cm-pill cm-pill-warn">{status}</span>;
}

function Banner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div
      className="bo-card"
      style={{ background: "var(--accent-soft)", borderLeft: "3px solid var(--accent)", padding: 12, fontSize: 13, display: "flex", justifyContent: "space-between", gap: 12 }}
    >
      <span>{message}</span>
      <button type="button" className="ghost" onClick={onDismiss}>Descartar</button>
    </div>
  );
}

// =====================================================================================
// Policies tab
// =====================================================================================

function PoliciesTab({ notify }: { notify: (m: string) => void }) {
  const { data, loading, error, refresh } = useApiData<PolicyRecord[]>(`${GOV}/policies`);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftJson, setDraftJson] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const policies = useMemo(() => toArray<PolicyRecord>(data), [data]);

  async function toggleActive(p: PolicyRecord) {
    setBusy(p.id);
    try {
      await apiRequest(`${GOV}/policies/${p.id}/active`, { method: "POST", body: { active: !p.active } });
      notify(`Política "${p.name}" ${p.active ? "desactivada" : "activada"}.`);
      refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function startEdit(p: PolicyRecord) {
    setEditing(p.id);
    setDraftJson(JSON.stringify(p.configuration ?? {}, null, 2));
  }

  async function saveConfig(p: PolicyRecord) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draftJson);
    } catch {
      notify("La configuración debe ser un JSON válido.");
      return;
    }
    setBusy(p.id);
    try {
      await apiRequest(`${GOV}/policies`, { method: "POST", body: { policyCode: p.policyCode, configuration: parsed } });
      notify(`Configuración de la política "${p.name}" guardada.`);
      setEditing(null);
      refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="bo-card-head">
        <div><p className="bo-muted">Reglas de protección</p><h3>Políticas</h3></div>
        <span className="bo-chip">{policies.length} políticas</span>
      </div>
      {error ? <p className="bo-muted">No se pudieron cargar las políticas. Pulsa Actualizar para reintentar.</p> : null}
      {loading && policies.length === 0 ? (
        <LoadingBlock label="Cargando políticas…" />
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr><th>Política</th><th>Código</th><th>Configuración</th><th>Activa</th><th /></tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td><code style={{ fontSize: 12 }}>{p.policyCode}</code></td>
                  <td style={{ minWidth: 280 }}>
                    {editing === p.id ? (
                      <textarea
                        value={draftJson}
                        onChange={(e) => setDraftJson(e.target.value)}
                        rows={5}
                        style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
                      />
                    ) : (
                      <code style={{ fontSize: 12 }}>{JSON.stringify(p.configuration ?? {})}</code>
                    )}
                  </td>
                  <td>{p.active ? <span className="cm-pill cm-pill-ok">activa</span> : <span className="cm-pill">desactivada</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editing === p.id ? (
                      <>
                        <button type="button" className="primary" disabled={busy === p.id} onClick={() => saveConfig(p)}>Guardar</button>{" "}
                        <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancelar</button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => startEdit(p)}>Editar</button>{" "}
                        <button type="button" className="ghost" disabled={busy === p.id} onClick={() => toggleActive(p)}>
                          {p.active ? "Desactivar" : "Activar"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {policies.length === 0 && !loading ? (
                <tr><td colSpan={5} className="bo-muted">No hay políticas configuradas.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// =====================================================================================
// Prompts tab
// =====================================================================================

function PromptsTab({ notify }: { notify: (m: string) => void }) {
  const { data: groups, loading, error, refresh } = useApiData<PromptGroup[]>(`${GOV}/prompts`);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const codeForVersions = selectedCode;
  const { data: versions, refresh: refreshVersions } = useApiData<PromptVersionRecord[]>(
    codeForVersions ? `${GOV}/prompts/${encodeURIComponent(codeForVersions)}/versions` : null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [diffA, setDiffA] = useState<string>("");
  const [diffB, setDiffB] = useState<string>("");
  const [diff, setDiff] = useState<PromptDiffResult | null>(null);
  const [newContent, setNewContent] = useState<string>("");
  const [newNotes, setNewNotes] = useState<string>("");

  const list = groups ?? [];
  const vlist = versions ?? [];

  function refreshAll() {
    refresh();
    refreshVersions();
  }

  async function publish(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/prompts/versions/${id}/publish`, { method: "POST" });
      notify("Versión del prompt publicada.");
      refreshAll();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
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
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addVersion() {
    if (!selectedCode || !newContent.trim()) {
      notify("Primero elige un prompt e introduce su contenido.");
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
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runDiff() {
    if (!diffA || !diffB) {
      notify("Selecciona dos versiones para comparar.");
      return;
    }
    try {
      const result = await apiRequest<PromptDiffResult>(`${GOV}/prompts/diff`, { query: { a: diffA, b: diffB } });
      setDiff(result);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="bo-card-head">
        <div><p className="bo-muted">Control de versiones</p><h3>Prompts (instrucciones a la IA)</h3></div>
        <span className="bo-chip">{list.length} códigos de prompt</span>
      </div>
      {error ? <p className="bo-muted">No se pudieron cargar los prompts. Pulsa Actualizar para reintentar.</p> : null}

      <div className="rev-report-wrap">
        <table className="cm-table">
          <thead>
            <tr><th>Código de prompt</th><th>Versiones</th><th>Publicada</th><th>Última</th><th>Actualizado</th><th /></tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.promptCode} className={selectedCode === g.promptCode ? "cm-row-warn" : undefined}>
                <td><strong>{g.promptCode}</strong></td>
                <td>{g.versionCount}</td>
                <td>{g.currentPublishedVersion ? <span className="cm-pill cm-pill-ok">{g.currentPublishedVersion}</span> : <span className="bo-muted">ninguna</span>}</td>
                <td>{g.latestVersion ?? "—"}</td>
                <td>{fmtDateTime(g.updatedAt)}</td>
                <td><button type="button" onClick={() => { setSelectedCode(g.promptCode); setDiff(null); setDiffA(""); setDiffB(""); }}>Ver historial</button></td>
              </tr>
            ))}
            {list.length === 0 && !loading ? <tr><td colSpan={6} className="bo-muted">Aún no hay prompts.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {selectedCode ? (
        <section className="bo-card" style={{ marginTop: 16 }}>
          <div className="bo-card-head">
            <div><p className="bo-muted">Historial de versiones</p><h3>{selectedCode}</h3></div>
            <span className="bo-chip">{vlist.length} versiones</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr><th>Versión</th><th>Estado</th><th>Notas</th><th>Publicada</th><th>Creada</th><th /></tr>
              </thead>
              <tbody>
                {vlist.map((v) => (
                  <tr key={v.id}>
                    <td><strong>{v.version}</strong></td>
                    <td>{statusPill(v.status)}</td>
                    <td>{v.notes ?? <span className="bo-muted">—</span>}</td>
                    <td>{fmtDateTime(v.publishedAt)}</td>
                    <td>{fmtDateTime(v.createdAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {v.status !== "published" ? (
                        <button type="button" className="primary" disabled={busy === v.id} onClick={() => publish(v.id)}>Publicar</button>
                      ) : null}{" "}
                      {v.status !== "archived" ? (
                        <button type="button" className="ghost" disabled={busy === v.id} onClick={() => archive(v.id)}>Archivar</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {vlist.length === 0 ? <tr><td colSpan={6} className="bo-muted"><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner size="sm" /> Cargando versiones…</span></td></tr> : null}
              </tbody>
            </table>
          </div>

          {/* New draft version */}
          <div style={{ marginTop: 16 }}>
            <p className="bo-muted" style={{ marginBottom: 6 }}>Nueva versión en borrador</p>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              rows={4}
              placeholder="Contenido del prompt…"
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
            <div className="bo-row" style={{ gap: 8, marginTop: 8 }}>
              <input value={newNotes} onChange={(e) => setNewNotes(e.target.value)} placeholder="Notas (opcional)" style={{ flex: 1 }} />
              <button type="button" className="primary" disabled={busy === "new"} onClick={addVersion}>Crear borrador</button>
            </div>
          </div>

          {/* Diff */}
          <div style={{ marginTop: 16 }}>
            <p className="bo-muted" style={{ marginBottom: 6 }}>Comparar versiones</p>
            <div className="bo-row" style={{ gap: 8 }}>
              <select value={diffA} onChange={(e) => setDiffA(e.target.value)}>
                <option value="">Versión A…</option>
                {vlist.map((v) => <option key={v.id} value={v.id}>{v.version} ({v.status})</option>)}
              </select>
              <select value={diffB} onChange={(e) => setDiffB(e.target.value)}>
                <option value="">Versión B…</option>
                {vlist.map((v) => <option key={v.id} value={v.id}>{v.version} ({v.status})</option>)}
              </select>
              <button type="button" onClick={runDiff}>Comparar</button>
            </div>
            {diff ? (
              <pre style={{ marginTop: 12, background: "var(--surface-2, #0001)", padding: 12, borderRadius: 6, overflowX: "auto", fontSize: 12 }}>
                {diff.diff.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      color: line.type === "added" ? "var(--ok-ink, #137333)" : line.type === "removed" ? "var(--danger-ink, #c5221f)" : "inherit",
                      background: line.type === "added" ? "rgba(19,115,51,0.08)" : line.type === "removed" ? "rgba(197,34,31,0.08)" : "transparent"
                    }}
                  >
                    {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}{line.text}
                  </div>
                ))}
              </pre>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

// =====================================================================================
// Evaluations tab
// =====================================================================================

function EvaluationsTab({ notify }: { notify: (m: string) => void }) {
  const { data, loading, error, refresh } = useApiData<EvaluationRecord[]>(`${GOV}/evaluations`);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("quality");
  const [promptCode, setPromptCode] = useState("");
  const evals = useMemo(() => toArray<EvaluationRecord>(data), [data]);

  async function create() {
    if (!name.trim()) {
      notify("El nombre de la evaluación es obligatorio.");
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
      notify(e instanceof Error ? e.message : String(e));
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
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="bo-card-head">
        <div><p className="bo-muted">Calidad</p><h3>Evaluaciones</h3></div>
        <span className="bo-chip">{evals.length} evaluaciones</span>
      </div>

      <div className="bo-row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre de la evaluación" style={{ flex: 2, minWidth: 180 }} />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="quality">quality</option>
          <option value="accuracy">accuracy</option>
          <option value="safety">safety</option>
          <option value="regression">regression</option>
        </select>
        <input value={promptCode} onChange={(e) => setPromptCode(e.target.value)} placeholder="Código de prompt (opcional)" style={{ flex: 1, minWidth: 140 }} />
        <button type="button" className="primary" disabled={busy === "new"} onClick={create}>Crear</button>
      </div>

      {error ? <p className="bo-muted">No se pudieron cargar las evaluaciones. Pulsa Actualizar para reintentar.</p> : null}
      <div className="rev-report-wrap">
        <table className="cm-table">
          <thead>
            <tr><th>Nombre</th><th>Tipo</th><th>Prompt</th><th>Estado</th><th style={{ textAlign: "right" }}>Puntuación</th><th style={{ textAlign: "right" }}>Tasa de aprobación</th><th style={{ textAlign: "right" }}>Muestra</th><th>Completada</th><th /></tr>
          </thead>
          <tbody>
            {evals.map((ev) => (
              <>
                <tr key={ev.id}>
                  <td><strong>{ev.evaluationName}</strong></td>
                  <td>{ev.evaluationType}</td>
                  <td>{ev.promptCode ?? <span className="bo-muted">—</span>}</td>
                  <td>{statusPill(ev.status)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ev.score === undefined ? "—" : ev.score.toFixed(1)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtPct(ev.passRate)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ev.sampleSize ?? "—"}</td>
                  <td>{fmtDateTime(ev.completedAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="primary" disabled={busy === ev.id} onClick={() => run(ev.id)}>Ejecutar</button>{" "}
                    {ev.status === "completed" || ev.status === "skipped" ? (
                      <button type="button" className="ghost" onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}>
                        {expanded === ev.id ? "Ocultar" : ev.status === "skipped" ? "Por qué" : "Resultados"}
                      </button>
                    ) : null}
                  </td>
                </tr>
                {expanded === ev.id ? (
                  <tr key={`${ev.id}-detail`}>
                    <td colSpan={9}>
                      <pre style={{ background: "var(--surface-2, #0001)", padding: 12, borderRadius: 6, overflowX: "auto", fontSize: 12, maxHeight: 320 }}>
                        {JSON.stringify(ev.results, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
            {evals.length === 0 && !loading ? <tr><td colSpan={9} className="bo-muted">Aún no hay evaluaciones.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

// =====================================================================================
// Incidents tab
// =====================================================================================

function IncidentsTab({ notify }: { notify: (m: string) => void }) {
  const { data, loading, error, refresh } = useApiData<IncidentRecord[]>(`${GOV}/incidents`);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [incidentType, setIncidentType] = useState("hallucination");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [resolving, setResolving] = useState<string | null>(null);
  const [rootCause, setRootCause] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const incidents = useMemo(() => toArray<IncidentRecord>(data), [data]);

  async function create() {
    if (!title.trim()) {
      notify("El título es obligatorio.");
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
      notify(e instanceof Error ? e.message : String(e));
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
      notify(e instanceof Error ? e.message : String(e));
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
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function resolve(id: string) {
    setBusy(id);
    try {
      await apiRequest(`${GOV}/incidents/${id}/resolve`, { method: "POST", body: { rootCause, resolutionNotes } });
      notify("Incidencia resuelta.");
      setResolving(null);
      setRootCause("");
      setResolutionNotes("");
      refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="bo-card-head">
        <div><p className="bo-muted">Seguridad</p><h3>Incidencias</h3></div>
        <span className="bo-chip">{incidents.length} incidencias</span>
      </div>

      <div className="bo-row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título de la incidencia" style={{ flex: 2, minWidth: 180 }} />
        <select value={incidentType} onChange={(e) => setIncidentType(e.target.value)}>
          <option value="hallucination">hallucination</option>
          <option value="policy_violation">policy_violation</option>
          <option value="data_leak">data_leak</option>
          <option value="bias">bias</option>
          <option value="other">other</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="critical">critical</option>
        </select>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descripción (opcional)" style={{ flex: 2, minWidth: 180 }} />
        <button type="button" className="primary" disabled={busy === "new"} onClick={create}>Crear</button>
      </div>

      {error ? <p className="bo-muted">No se pudieron cargar las incidencias. Pulsa Actualizar para reintentar.</p> : null}
      <div className="rev-report-wrap">
        <table className="cm-table">
          <thead>
            <tr><th>Gravedad</th><th>Título</th><th>Tipo</th><th>Estado</th><th>Asignada a</th><th>Creada</th><th /></tr>
          </thead>
          <tbody>
            {incidents.map((inc) => (
              <>
                <tr key={inc.id} className={severityClass(inc.severity) === "error" ? "cm-row-error" : severityClass(inc.severity) === "warn" ? "cm-row-warn" : undefined}>
                  <td>{severityPill(inc.severity)}</td>
                  <td><strong>{inc.title}</strong>{inc.description ? <div className="bo-muted" style={{ fontSize: 12 }}>{inc.description}</div> : null}</td>
                  <td>{inc.incidentType}</td>
                  <td>{statusPill(inc.status)}</td>
                  <td>{inc.assignedTo ?? <span className="bo-muted">—</span>}</td>
                  <td>{fmtDateTime(inc.createdAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {inc.status !== "resolved" ? (
                      <>
                        <button type="button" disabled={busy === inc.id} onClick={() => assign(inc.id)}>Asignar</button>{" "}
                        <button type="button" className="primary" disabled={busy === inc.id} onClick={() => setResolving(resolving === inc.id ? null : inc.id)}>Resolver</button>
                      </>
                    ) : (
                      <button type="button" className="ghost" disabled={busy === inc.id} onClick={() => reopen(inc.id)}>Reabrir</button>
                    )}
                  </td>
                </tr>
                {resolving === inc.id ? (
                  <tr key={`${inc.id}-resolve`}>
                    <td colSpan={7}>
                      <div className="bo-row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <input value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="Causa raíz" style={{ flex: 1, minWidth: 200 }} />
                        <input value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} placeholder="Notas de resolución" style={{ flex: 2, minWidth: 240 }} />
                        <button type="button" className="primary" disabled={busy === inc.id} onClick={() => resolve(inc.id)}>Confirmar resolución</button>
                        <button type="button" className="ghost" onClick={() => setResolving(null)}>Cancelar</button>
                      </div>
                    </td>
                  </tr>
                ) : inc.status === "resolved" && (inc.rootCause || inc.resolutionNotes) ? (
                  <tr key={`${inc.id}-resolved`}>
                    <td colSpan={7} className="bo-muted" style={{ fontSize: 12 }}>
                      Causa raíz: {inc.rootCause ?? "—"} · Notas: {inc.resolutionNotes ?? "—"} · Resuelta {fmtDateTime(inc.resolvedAt)}
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
            {incidents.length === 0 && !loading ? <tr><td colSpan={7} className="bo-muted">No hay incidencias registradas.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

// =====================================================================================
// Cost tab
// =====================================================================================

function CostTab() {
  const [days, setDays] = useState(30);
  const { data, loading, error, refresh } = useApiData<CostDashboard>(`${GOV}/cost`, { query: { days } });
  const maxDaily = useMemo(() => Math.max(1, ...(data?.dailyTrend ?? []).map((d) => d.costEur)), [data]);
  const byTool = data?.byTool ?? [];
  const byModel = data?.byModel ?? [];
  const daily = data?.dailyTrend ?? [];

  return (
    <>
      <div className="bo-card-head">
        <div><p className="bo-muted">Gasto · últimos {data?.windowDays ?? days} días</p><h3>Panel de costes</h3></div>
        <div className="bo-row" style={{ gap: 8 }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 días</option>
            <option value={30}>30 días</option>
            <option value={90}>90 días</option>
          </select>
          <button type="button" className="ghost" onClick={refresh}>↻ Actualizar</button>
        </div>
      </div>
      {error ? <p className="bo-muted">No se pudieron cargar los datos de coste. Pulsa Actualizar para reintentar.</p> : null}

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Coste total</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : fmtEur(data?.totalCostEur)}</div>
          <div className="rev-kpi-delta">Total del periodo</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tokens totales (uso del modelo)</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : fmtNum(data?.totalTokens)}</div>
          <div className="rev-kpi-delta">Entrada + salida</div>
        </article>
        <article className="rev-kpi rev-kpi-warn">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Proyectado / mes</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : fmtEur(data?.projectedMonthlyEur)}</div>
          <div className="rev-kpi-delta">Ritmo de gasto × 30 días</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Herramientas activas</span></div>
          <div className="rev-kpi-value">{loading && !data ? "…" : byTool.length}</div>
          <div className="rev-kpi-delta">Herramientas distintas con gasto</div>
        </article>
      </section>

      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head"><div><p className="bo-muted">Por herramienta</p><h3>Coste por herramienta</h3></div><span className="bo-chip">{byTool.length}</span></div>
          {byTool.length === 0 ? <p className="bo-muted">Sin gasto en el periodo.</p> : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead><tr><th>Herramienta</th><th style={{ textAlign: "right" }}>Coste</th><th style={{ textAlign: "right" }}>Tokens (uso del modelo)</th><th style={{ textAlign: "right" }}>Llamadas</th></tr></thead>
                <tbody>
                  {byTool.map((t) => (
                    <tr key={t.toolName}>
                      <td><strong>{t.toolName}</strong></td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtEur(t.costEur)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtNum(t.tokens)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{t.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="bo-card">
          <div className="bo-card-head"><div><p className="bo-muted">Por modelo</p><h3>Coste por modelo</h3></div><span className="bo-chip">{byModel.length}</span></div>
          {byModel.length === 0 ? <p className="bo-muted">Sin gasto en el periodo.</p> : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead><tr><th>Modelo</th><th style={{ textAlign: "right" }}>Coste</th><th style={{ textAlign: "right" }}>Llamadas</th></tr></thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={m.model}>
                      <td><strong>{m.model}</strong></td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtEur(m.costEur)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head"><div><p className="bo-muted">Tendencia diaria</p><h3>Coste por día</h3></div><span className="bo-chip">{daily.length} días</span></div>
        {daily.length === 0 ? <p className="bo-muted">Sin gasto en el periodo.</p> : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 160, paddingTop: 8 }}>
            {daily.map((d) => (
              <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }} title={`${d.date}: ${fmtEur(d.costEur)} (${d.calls} llamadas)`}>
                <div style={{ width: "70%", background: "var(--accent)", borderRadius: "3px 3px 0 0", height: `${Math.max(2, (d.costEur / maxDaily) * 100)}%` }} />
                <div style={{ fontSize: 9, color: "var(--ink-muted)", marginTop: 4, transform: "rotate(-45deg)", whiteSpace: "nowrap" }}>{d.date.slice(5)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// =====================================================================================
// Root screen
// =====================================================================================

const TABS: Array<{ id: TabId; label: string; subtitle: string }> = [
  { id: "policies", label: "Políticas", subtitle: "Configuración de la regla" },
  { id: "prompts", label: "Prompts (instrucciones a la IA)", subtitle: "Versiones (publicar/archivar)" },
  { id: "evaluations", label: "Evaluaciones", subtitle: "Calidad y precisión" },
  { id: "incidents", label: "Incidencias", subtitle: "Flujo de seguridad" },
  { id: "cost", label: "Coste", subtitle: "Gasto y tokens (uso del modelo)" }
];

export function AiGovernanceScreen() {
  const [tab, setTab] = useState<TabId>("policies");
  const [banner, setBanner] = useState<string | null>(null);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">IA · Gobernanza</div>
          <h1 className="bo-page-title">Gobernanza de la IA</h1>
          <p className="bo-page-subtitle">
            Políticas, versiones de prompts (instrucciones a la IA), evaluaciones, gestión de incidencias y coste:
            el panel de control de la IA para operar de forma segura en toda la cartera de hoteles.
          </p>
        </div>
      </div>

      <div className="bo-row" style={{ gap: 0, borderBottom: "1px solid var(--line)", paddingBottom: 0, marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              border: "none",
              borderRadius: 0,
              borderBottom: t.id === tab ? "2px solid var(--accent)" : "2px solid transparent",
              background: "transparent",
              padding: "12px 18px",
              cursor: "pointer",
              color: t.id === tab ? "var(--ink)" : "var(--ink-muted)",
              fontWeight: t.id === tab ? 700 : 500
            }}
          >
            <div style={{ fontSize: 14 }}>{t.label}</div>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", fontWeight: 500 }}>{t.subtitle}</div>
          </button>
        ))}
      </div>

      <Banner message={banner} onDismiss={() => setBanner(null)} />

      <section className="bo-card" style={{ marginTop: banner ? 12 : 0 }}>
        {tab === "policies" ? <PoliciesTab notify={setBanner} /> : null}
        {tab === "prompts" ? <PromptsTab notify={setBanner} /> : null}
        {tab === "evaluations" ? <EvaluationsTab notify={setBanner} /> : null}
        {tab === "incidents" ? <IncidentsTab notify={setBanner} /> : null}
        {tab === "cost" ? <CostTab /> : null}
      </section>
    </>
  );
}

export default AiGovernanceScreen;
