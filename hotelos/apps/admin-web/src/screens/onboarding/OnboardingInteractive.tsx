import { useCallback, useEffect, useMemo, useState } from "react";
import {
  aiSuggestMapping,
  approveMapping,
  classifyFile,
  createProject,
  editMapping,
  extractFile,
  generateMappings,
  getActiveProjectId,
  listExtractedEntities,
  listMappingSuggestions,
  listProjects,
  rejectMapping,
  setActiveProjectId,
  uploadFile,
  type ExtractedEntity,
  type ExtractResult,
  type MappingSuggestion,
  type OnboardingFile,
  type OnboardingProject
} from "../../services/onboardingApi";
import { LoadingBlock } from "../../components/States";

// ---- Sprint 53 — interactive AI Onboarding screens ----
// Three real screens that drive the upload -> classify -> extract -> generate
// mappings -> approve pipeline against the frozen onboarding contract. Aurora v2
// styling (bo-card / rev-kpi / cm-table / cm-pill / dp-table). The screens are
// resilient: if Sprint 52's backend hasn't reshaped responses yet, the helpers
// normalise legacy shapes and errors render as a clear inline message.

const SAMPLE_ROOM_CSV = `Room,Type,Floor,Status
101,Double Standard,1,Clean
102,Double Standard,1,Clean
103,Single,1,Occupied
201,Suite,2,Clean
202,,2,Dirty
203,Double Superior,2,Out of Order`;

function navigate(screen: string): void {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

// ---- Confidence / status pill helpers (consistent across the pipeline) ----

function confidencePillClass(confidence: number): string {
  if (confidence >= 0.8) return "cm-pill-ok";
  if (confidence >= 0.5) return "cm-pill-warn";
  return "cm-pill-error";
}

function ConfidencePill({ confidence }: { confidence: number }) {
  const pct = Math.round((confidence ?? 0) * 100);
  return <span className={`cm-pill ${confidencePillClass(confidence)}`}>{pct}%</span>;
}

function statusPillClass(status: string): string {
  switch (status) {
    case "approved":
    case "applied":
      return "cm-pill-ok";
    case "rejected":
      return "cm-pill-error";
    case "edited":
      return "cm-pill-warn";
    default:
      return "cm-pill-warn"; // pending
  }
}

const STATUS_LABELS_ES: Record<string, string> = {
  pending: "pendiente",
  approved: "aprobado",
  applied: "aplicado",
  rejected: "rechazado",
  edited: "editado"
};

function StatusPill({ status }: { status: string }) {
  return <span className={`cm-pill ${statusPillClass(status)}`}>{STATUS_LABELS_ES[status] ?? status}</span>;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return <span className="bo-muted">—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {warnings.map((w, i) => (
        <span
          key={`${w}-${i}`}
          className="cm-pill cm-pill-warn"
          style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}
          title={w}
        >
          {w}
        </span>
      ))}
    </div>
  );
}

function compactFields(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields ?? {});
  if (entries.length === 0) return "—";
  return entries
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
    .join(" · ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isForbidden(message: string): boolean {
  return /403|forbidden|permission/i.test(message);
}

// Shared "Continue the journey" nav strip kept at the bottom of every screen so
// the pipeline stays traversable.
function NavCards({ actions }: { actions: Array<{ label: string; screen: string }> }) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Continúa el proceso</p>
          <h3>Siguientes pasos</h3>
        </div>
      </div>
      <div className="bo-actions">
        {actions.map((a) => (
          <button key={a.screen} type="button" onClick={() => navigate(a.screen)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function ProjectBanner({
  projects,
  activeId,
  onSelect,
  onCreate,
  creating,
  error
}: {
  projects: OnboardingProject[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
  error: string | null;
}) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Proyecto activo</p>
          <h3>Proyecto de alta y migración</h3>
        </div>
        <span className="bo-chip">{projects.length} proyecto(s)</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
        {projects.length > 0 ? (
          <label>
            <span className="bo-muted" style={{ marginRight: "0.4rem" }}>Proyecto</span>
            <select value={activeId ?? ""} onChange={(e) => onSelect(e.target.value)}>
              <option value="" disabled>
                Selecciona un proyecto…
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {(p.name as string) ?? p.id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="bo-muted">Aún no hay proyectos de alta/migración.</span>
        )}
        <button type="button" className="ghost" onClick={onCreate} disabled={creating}>
          {creating ? "Creando…" : "Crear proyecto de demostración"}
        </button>
      </div>
      {error ? <p style={{ color: "var(--danger-ink)", marginTop: "0.5rem" }}>{error}</p> : null}
    </section>
  );
}

// Shared project-selection hook used by all three screens.
function useActiveProject() {
  const [projects, setProjects] = useState<OnboardingProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => getActiveProjectId());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setError(null);
    try {
      const items = await listProjects();
      setProjects(items);
      setActiveId((current) => {
        if (current && items.some((p) => p.id === current)) return current;
        const next = items[0]?.id ?? null;
        if (next) setActiveProjectId(next);
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const select = useCallback((id: string) => {
    setActiveId(id);
    setActiveProjectId(id);
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const project = await createProject({ name: "Demo Onboarding Project", sourceSystem: "generic_csv" });
      setActiveId(project.id);
      setActiveProjectId(project.id);
      await loadProjects();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }, [loadProjects]);

  return { projects, activeId, creating, error, select, create, reload: loadProjects };
}

// ============================================================================
// 1) File Upload & Classification
// ============================================================================

export function FileUploadAndClassificationScreen() {
  const { projects, activeId, creating, error: projectError, select, create } = useActiveProject();

  const [fileName, setFileName] = useState("room-list.csv");
  const [content, setContent] = useState("");
  const [uploadedFile, setUploadedFile] = useState<OnboardingFile | null>(null);
  const [extractResult, setExtractResult] = useState<ExtractResult | null>(null);

  const [busy, setBusy] = useState<null | "upload" | "extract">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const detectedType = uploadedFile?.detectedDocumentType;
  const classified = Boolean(detectedType && detectedType !== "pending_classification");

  // The upload endpoint returns a "blocked" payload (no id) if sensitive data is
  // detected, rather than a file. Guard against that.
  const uploadBlocked = Boolean(uploadedFile && !uploadedFile.id);

  async function handleUploadAndClassify() {
    if (!activeId) {
      setActionError("Selecciona o crea un proyecto primero.");
      return;
    }
    if (!content.trim()) {
      setActionError("Pega contenido CSV/JSON para subir.");
      return;
    }
    setBusy("upload");
    setActionError(null);
    setExtractResult(null);
    try {
      const file = await uploadFile(activeId, {
        fileName: fileName.trim() || "uploaded-export.csv",
        fileType: fileName.toLowerCase().endsWith(".json") ? "application/json" : "text/csv",
        content
      });
      if (!file.id) {
        // sensitive-data block path
        setUploadedFile(file);
        setActionError(
          (file as { reason?: string }).reason ?? "La subida se ha bloqueado porque contiene datos sensibles."
        );
        return;
      }
      const classifiedFile = await classifyFile(file.id);
      setUploadedFile(classifiedFile);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(isForbidden(message) ? `Permiso denegado (onboarding.*): ${message}` : message);
    } finally {
      setBusy(null);
    }
  }

  async function handleExtract() {
    if (!uploadedFile?.id) return;
    setBusy("extract");
    setActionError(null);
    try {
      const result = await extractFile(uploadedFile.id);
      setExtractResult(result);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(isForbidden(message) ? `Permiso denegado (onboarding.*): ${message}` : message);
    } finally {
      setBusy(null);
    }
  }

  // Derive an extraction summary even if the backend doesn't return one yet.
  const summary = useMemo(() => {
    if (!extractResult) return null;
    if (extractResult.summary) return extractResult.summary;
    const entities = (extractResult.extractedEntities ?? []) as ExtractedEntity[];
    const confidences = entities
      .map((e) => (typeof e.confidence === "number" ? e.confidence : Number(e.confidence)))
      .filter((c) => Number.isFinite(c));
    const warnings = entities.reduce((n, e) => n + (Array.isArray(e.warnings) ? e.warnings.length : 0), 0);
    return { totalEntities: entities.length, avgConfidence: avg(confidences), warnings };
  }, [extractResult]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Alta y migración con IA</div>
          <h1 className="bo-page-title">Subida y clasificación de ficheros</h1>
          <p className="bo-page-subtitle">
            Pega una lista de habitaciones, un tarifario, un mapeo de canales, reservas o una exportación de Histórico y Previsión. La IA
            clasifica el tipo de documento y luego ejecuta la extracción. No se aplica nada sin revisión humana.
          </p>
        </div>
      </div>

      <ProjectBanner
        projects={projects}
        activeId={activeId}
        onSelect={select}
        onCreate={create}
        creating={creating}
        error={projectError}
      />

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Paso 1</p>
            <h3>Subir contenido</h3>
          </div>
          {classified ? (
            <span className="bo-chip">
              {detectedType} · <ConfidencePill confidence={uploadedFile?.confidence ?? 0} />
            </span>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <label>
            <span className="bo-muted" style={{ display: "block", marginBottom: 4 }}>Nombre del fichero</span>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              style={{ width: "100%", maxWidth: 360 }}
              placeholder="room-list.csv"
            />
          </label>
          <label>
            <span className="bo-muted" style={{ display: "block", marginBottom: 4 }}>Contenido pegado (CSV / JSON)</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              style={{ width: "100%", fontFamily: "var(--font-mono, monospace)", fontSize: "var(--fs-sm)" }}
              placeholder="Room,Type,Floor,Status…"
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="ghost" onClick={() => { setFileName("room-list.csv"); setContent(SAMPLE_ROOM_CSV); }}>
              Cargar lista de habitaciones de ejemplo
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleUploadAndClassify}
              disabled={busy !== null || !activeId}
            >
              {busy === "upload" ? "Subiendo…" : "Subir y clasificar"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handleExtract}
              disabled={busy !== null || !classified || uploadBlocked}
              title={!classified ? "Clasifica un fichero primero" : undefined}
            >
              {busy === "extract" ? "Extrayendo…" : "Ejecutar extracción"}
            </button>
          </div>
          {actionError ? <p style={{ color: "var(--danger-ink)" }}>{actionError}</p> : null}
        </div>
      </section>

      {classified && !uploadBlocked ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Paso 2 · Clasificación</p>
              <h3>Tipo de documento detectado</h3>
            </div>
            <ConfidencePill confidence={uploadedFile?.confidence ?? 0} />
          </div>
          <div className="dp-table">
            <div className="dp-row"><span className="dp-key">fileName</span><span className="dp-val">{uploadedFile?.fileName ?? "—"}</span></div>
            <div className="dp-row"><span className="dp-key">detectedDocumentType</span><span className="dp-val">{detectedType}</span></div>
            <div className="dp-row"><span className="dp-key">confidence</span><span className="dp-val">{Math.round((uploadedFile?.confidence ?? 0) * 100)}%</span></div>
            <div className="dp-row"><span className="dp-key">status</span><span className="dp-val">{uploadedFile?.status ?? "—"}</span></div>
          </div>
        </section>
      ) : null}

      {summary ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Paso 3 · Extracción completada</p>
              <h3>Resumen de la extracción</h3>
            </div>
            <span className="bo-status ok">extraído</span>
          </div>
          <div className="rev-kpi-grid">
            <article className="rev-kpi rev-kpi-ok">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Entidades totales</span></div>
              <div className="rev-kpi-value">{summary.totalEntities}</div>
            </article>
            <article className={`rev-kpi rev-kpi-${summary.avgConfidence >= 0.8 ? "ok" : summary.avgConfidence >= 0.5 ? "warn" : "error"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Confianza media</span></div>
              <div className="rev-kpi-value">{Math.round(summary.avgConfidence * 100)}%</div>
            </article>
            <article className={`rev-kpi rev-kpi-${summary.warnings > 0 ? "warn" : "ok"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Avisos</span></div>
              <div className="rev-kpi-value">{summary.warnings}</div>
            </article>
          </div>
          <div className="bo-actions" style={{ marginTop: "1rem" }}>
            <button type="button" className="primary" onClick={() => navigate("AIExtractionReview")}>
              Revisar entidades extraídas →
            </button>
          </div>
        </section>
      ) : null}

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Seguridad y transparencia</p>
            <h3>Se requiere revisión humana</h3>
          </div>
          <span className="bo-status warn">aviso</span>
        </div>
        <p>
          Las sugerencias de la IA quedan pendientes hasta que una persona las aprueba, rechaza o edita: la IA no puede aplicar
          la migración directamente. Los ficheros subidos se cifran, los datos de tarjeta de pago en bruto se rechazan y las
          vistas previas sensibles requieren permiso.
        </p>
      </section>

      <NavCards
        actions={[
          { label: "Siguiente: revisión de extracción (IA)", screen: "AIExtractionReview" },
          { label: "Mapear propiedad desde documentos", screen: "PropertyMapper" }
        ]}
      />
    </>
  );
}

// ============================================================================
// 2) AI Extraction Review
// ============================================================================

export function AIExtractionReviewScreen() {
  const { projects, activeId, creating, error: projectError, select, create } = useActiveProject();

  const [entities, setEntities] = useState<ExtractedEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [mappingCount, setMappingCount] = useState<number | null>(null);

  const load = useCallback(async (projectId: string) => {
    setLoading(true);
    setError(null);
    try {
      const items = await listExtractedEntities(projectId);
      setEntities(items);
    } catch (err) {
      const message = errorMessage(err);
      setError(isForbidden(message) ? `Permiso denegado (onboarding.*): ${message}` : message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) void load(activeId);
    else setEntities([]);
  }, [activeId, load]);

  async function handleGenerate() {
    if (!activeId) return;
    setGenerating(true);
    setGenerateError(null);
    setMappingCount(null);
    try {
      const result = await generateMappings(activeId);
      // Frozen contract returns { suggestions, summary }. If the live backend
      // hasn't reshaped yet, fall back to re-fetching the suggestion list.
      if (Array.isArray(result.suggestions)) {
        setMappingCount(result.suggestions.length);
      } else {
        const list = await listMappingSuggestions(activeId);
        setMappingCount(list.length);
      }
    } catch (err) {
      const message = errorMessage(err);
      setGenerateError(isForbidden(message) ? `Permission denied (onboarding.*): ${message}` : message);
    } finally {
      setGenerating(false);
    }
  }

  const kpis = useMemo(() => {
    const total = entities.length;
    const byType = new Map<string, number>();
    for (const e of entities) byType.set(e.entityType, (byType.get(e.entityType) ?? 0) + 1);
    const avgConfidence = avg(entities.map((e) => e.confidence));
    const needsReview = entities.filter((e) => e.confidence < 0.5).length;
    return { total, byType: [...byType.entries()], avgConfidence, needsReview };
  }, [entities]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Alta y migración con IA</div>
          <h1 className="bo-page-title">Revisión de extracción (IA)</h1>
          <p className="bo-page-subtitle">
            Revisa las entidades extraídas, sus referencias de origen, la confianza y los avisos antes del mapeo de esquema. Las filas
            con baja confianza se marcan para revisión humana.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => activeId && load(activeId)} disabled={!activeId || loading}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      <ProjectBanner
        projects={projects}
        activeId={activeId}
        onSelect={select}
        onCreate={create}
        creating={creating}
        error={projectError}
      />

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Entidades totales</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.total}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tipos de entidad</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.byType.length}</div>
          <div className="rev-kpi-delta">{kpis.byType.map(([t, c]) => `${t}: ${c}`).join(" · ") || "—"}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.avgConfidence >= 0.8 ? "ok" : kpis.avgConfidence >= 0.5 ? "warn" : "error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Confianza media</span></div>
          <div className="rev-kpi-value">{loading ? "…" : `${Math.round(kpis.avgConfidence * 100)}%`}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.needsReview > 0 ? "error" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Requiere revisión</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.needsReview}</div>
          <div className="rev-kpi-delta">Confianza &lt; 50%</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Entidades extraídas</p>
            <h3>Cola de revisión</h3>
          </div>
          <span className="bo-chip">{entities.length} filas</span>
        </div>

        {error ? (
          <p style={{ color: "var(--danger-ink)" }}>{error}</p>
        ) : loading ? (
          <LoadingBlock label="Cargando entidades extraídas…" />
        ) : entities.length === 0 ? (
          <p className="bo-muted">
            Aún no hay entidades extraídas. Sube y extrae un fichero desde «Subida y clasificación de ficheros» primero.
          </p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Tipo de entidad</th>
                  <th>Referencia de origen</th>
                  <th>Confianza</th>
                  <th>Campos clave</th>
                  <th>Avisos</th>
                </tr>
              </thead>
              <tbody>
                {entities.map((e) => (
                  <tr key={e.id} className={e.confidence < 0.5 ? "cm-row-error" : e.confidence < 0.8 ? "cm-row-warn" : undefined}>
                    <td><strong>{e.entityType}</strong></td>
                    <td>{e.sourceRef}</td>
                    <td><ConfidencePill confidence={e.confidence} /></td>
                    <td style={{ maxWidth: 360 }}>{compactFields(e.fields)}</td>
                    <td><Warnings warnings={e.warnings} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="bo-actions" style={{ marginTop: "1rem" }}>
          <button type="button" className="primary" onClick={handleGenerate} disabled={!activeId || generating}>
            {generating ? "Generando mapeos…" : "Generar mapeos"}
          </button>
          {mappingCount !== null ? (
            <button type="button" className="ghost" onClick={() => navigate("RoomMappingReview")}>
              Revisar mapeos ({mappingCount}) →
            </button>
          ) : null}
        </div>
        {generateError ? <p style={{ color: "var(--danger-ink)" }}>{generateError}</p> : null}
      </section>

      <div className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head"><h3>Enmascarado de PII en vistas previas</h3><span className="bo-status ok">ok</span></div>
          <p>Los números de documento, teléfono, correo, dirección, pago e identidad se enmascaran salvo que se conceda onboarding.view_sensitive.</p>
        </article>
        <article className="bo-card">
          <div className="bo-card-head"><h3>Protección de datos en bruto</h3><span className="bo-status error">bloqueado</span></div>
          <p>El CVV, el PAN/número de tarjeta completo en bruto y las imágenes de DNI/pasaporte se bloquean antes de la extracción.</p>
        </article>
      </div>

      <NavCards
        actions={[
          { label: "Revisión de mapeo de habitaciones", screen: "RoomMappingReview" },
          { label: "Volver a subir ficheros", screen: "FileUploadAndClassification" }
        ]}
      />
    </>
  );
}

// ============================================================================
// 3) Room Mapping Review
// ============================================================================

export function RoomMappingReviewScreen() {
  const { projects, activeId, creating, error: projectError, select, create } = useActiveProject();

  const [suggestions, setSuggestions] = useState<MappingSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [aiBusyId, setAiBusyId] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);

  async function suggestWithAi(s: MappingSuggestion) {
    setAiBusyId(s.id);
    setAiNote(null);
    try {
      const res = await aiSuggestMapping({ sourceValue: s.sourceValue, targetType: s.mappingType });
      if (!res.configured) {
        setAiNote(res.message ?? "IA no configurada. Edita el destino a mano.");
        return;
      }
      if (res.suggestion && res.suggestion.target) {
        // Prefill the row in edit mode so a human reviews + saves the suggestion.
        setEditingId(s.id);
        setEditValue(res.suggestion.target);
        const pct = Math.round((res.suggestion.confidence ?? 0) * 100);
        setAiNote(`✨ IA sugiere para "${s.sourceValue}" → "${res.suggestion.target}" (${pct}%). ${res.suggestion.rationale} — revísalo y guarda.`);
      } else {
        setAiNote(res.message ?? "La IA no encontró un destino claro; edítalo a mano.");
      }
    } catch (err) {
      setAiNote(errorMessage(err));
    } finally {
      setAiBusyId(null);
    }
  }

  const load = useCallback(async (projectId: string) => {
    setLoading(true);
    setError(null);
    try {
      const items = await listMappingSuggestions(projectId);
      setSuggestions(items);
    } catch (err) {
      const message = errorMessage(err);
      setError(isForbidden(message) ? `Permiso denegado (onboarding.*): ${message}` : message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) void load(activeId);
    else setSuggestions([]);
  }, [activeId, load]);

  async function runAction(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setActionError(null);
    try {
      await fn();
      if (activeId) await load(activeId);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(isForbidden(message) ? `Permiso denegado (onboarding.*): ${message}` : message);
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(s: MappingSuggestion) {
    setEditingId(s.id);
    setEditValue(s.targetValue === "—" ? "" : s.targetValue);
    setActionError(null);
  }

  async function saveEdit(id: string) {
    await runAction(id, () => editMapping(id, editValue));
    setEditingId(null);
    setEditValue("");
  }

  const kpis = useMemo(() => {
    const total = suggestions.length;
    const pending = suggestions.filter((s) => s.status === "pending").length;
    const approved = suggestions.filter((s) => s.status === "approved" || s.status === "applied").length;
    const rejected = suggestions.filter((s) => s.status === "rejected").length;
    const avgConfidence = avg(suggestions.map((s) => s.confidence));
    return { total, pending, approved, rejected, avgConfidence };
  }, [suggestions]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Alta y migración con IA</div>
          <h1 className="bo-page-title">Revisión de mapeo de habitaciones</h1>
          <p className="bo-page-subtitle">
            Aprueba, rechaza o edita los mapeos de rangos de habitaciones, tipos de habitación, espacios y recursos no-habitación generados a partir
            de ficheros, planos o el recorrido de habitaciones. Se requiere aprobación antes de cualquier simulación o aplicación.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => activeId && load(activeId)} disabled={!activeId || loading}>
            ↻ Actualizar
          </button>
        </div>
      </div>

      <ProjectBanner
        projects={projects}
        activeId={activeId}
        onSelect={select}
        onCreate={create}
        creating={creating}
        error={projectError}
      />

      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.total}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.pending > 0 ? "warn" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Pendientes</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.pending}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Aprobados</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.approved}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.rejected > 0 ? "error" : "ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Rechazados</span></div>
          <div className="rev-kpi-value">{loading ? "…" : kpis.rejected}</div>
        </article>
        <article className={`rev-kpi rev-kpi-${kpis.avgConfidence >= 0.8 ? "ok" : kpis.avgConfidence >= 0.5 ? "warn" : "error"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Confianza media</span></div>
          <div className="rev-kpi-value">{loading ? "…" : `${Math.round(kpis.avgConfidence * 100)}%`}</div>
        </article>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Sugerencias de mapeo</p>
            <h3>Cola de revisión</h3>
          </div>
          <span className="bo-chip">{suggestions.length} filas</span>
        </div>

        {error ? (
          <p style={{ color: "var(--danger-ink)" }}>{error}</p>
        ) : loading ? (
          <LoadingBlock label="Cargando sugerencias de mapeo…" />
        ) : suggestions.length === 0 ? (
          <p className="bo-muted">
            Aún no hay sugerencias de mapeo. Ejecuta «Generar mapeos» desde «Revisión de extracción (IA)» primero.
          </p>
        ) : (
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Origen → Destino</th>
                  <th>Confianza</th>
                  <th>Justificación</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => {
                  const decided = s.status === "approved" || s.status === "rejected" || s.status === "applied";
                  const isBusy = busyId === s.id;
                  const isEditing = editingId === s.id;
                  return (
                    <tr key={s.id} className={s.confidence < 0.5 ? "cm-row-error" : s.confidence < 0.8 ? "cm-row-warn" : undefined}>
                      <td><strong>{s.mappingType}</strong></td>
                      <td>
                        <span>{s.sourceValue}</span>
                        <span className="bo-muted"> → </span>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            style={{ width: 200 }}
                            placeholder="Valor de destino"
                          />
                        ) : (
                          <span>{s.targetValue}</span>
                        )}
                      </td>
                      <td><ConfidencePill confidence={s.confidence} /></td>
                      <td style={{ maxWidth: 320 }}>{s.rationale}</td>
                      <td><StatusPill status={s.status} /></td>
                      <td>
                        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                          {isEditing ? (
                            <>
                              <button type="button" className="primary" disabled={isBusy} onClick={() => saveEdit(s.id)}>
                                Guardar
                              </button>
                              <button type="button" className="ghost" disabled={isBusy} onClick={() => { setEditingId(null); setEditValue(""); }}>
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="ghost" disabled={decided || isBusy} onClick={() => runAction(s.id, () => approveMapping(s.id))}>
                                Aprobar
                              </button>
                              <button type="button" className="ghost" disabled={decided || isBusy} onClick={() => runAction(s.id, () => rejectMapping(s.id))}>
                                Rechazar
                              </button>
                              <button type="button" className="ghost" disabled={isBusy} onClick={() => startEdit(s)}>
                                Editar
                              </button>
                              <button
                                type="button"
                                className="ghost"
                                disabled={decided || isBusy || aiBusyId === s.id}
                                onClick={() => void suggestWithAi(s)}
                                title="La IA propone un destino; tú lo revisas y guardas"
                              >
                                {aiBusyId === s.id ? "Consultando IA…" : "✨ Sugerir (IA)"}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {actionError ? <p style={{ color: "var(--danger-ink)" }}>{actionError}</p> : null}
        {aiNote ? <p className="bo-muted" style={{ marginTop: 8 }}>{aiNote}</p> : null}
      </section>

      <NavCards
        actions={[
          { label: "Volver a la revisión de extracción", screen: "AIExtractionReview" },
          { label: "Mapear propiedad desde documentos", screen: "PropertyMapper" }
        ]}
      />
    </>
  );
}
