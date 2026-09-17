import { useCallback, useEffect, useMemo, useState } from "react";
import {
  classifyFile,
  createProject,
  extractFile,
  generateMappings,
  getActiveProjectId,
  listExtractedEntities,
  listMappingSuggestions,
  listProjects,
  setActiveProjectId,
  uploadFile,
  type ExtractedEntity,
  type ExtractResult,
  type OnboardingFile,
  type OnboardingProject
} from "../../services/onboardingApi";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { navigateTo, type ScreenKey } from "../../lib/navigate";
import { number, percent, plural } from "../../lib/format";

// ---- Sprint 53 — interactive AI Onboarding screens (Cocoa 22 · ola 11) ----
// Two real screens that drive the upload -> classify -> extract -> generate
// mappings -> approve pipeline against the frozen onboarding contract, painted
// with the Cocoa primitives (CocoaPage / CocoaSection / CocoaKpi / CocoaTable /
// CocoaBadge; no legacy `.bo-*` / `.cm-*` / `.rev-*` / `.dp-*` classes). The
// screens are resilient: if Sprint 52's backend hasn't reshaped responses yet,
// the helpers normalise legacy shapes and errors render as a CocoaCallout or a
// CocoaState.

const EYEBROW = "Alta y migración con IA";

const SAMPLE_ROOM_CSV = `Room,Type,Floor,Status
101,Double Standard,1,Clean
102,Double Standard,1,Clean
103,Single,1,Occupied
201,Suite,2,Clean
202,,2,Dirty
203,Double Superior,2,Out of Order`;

// ---- Confidence helpers (consistent across the pipeline) ----

function confidenceTone(confidence: number): CocoaTone {
  if (confidence >= 0.8) return "success";
  if (confidence >= 0.5) return "warning";
  return "danger";
}

function confidenceStatus(confidence: number): CocoaKpiStatus {
  if (confidence >= 0.8) return "ok";
  if (confidence >= 0.5) return "warning";
  return "critical";
}

/** 0.83 → "83 %" (lib/format, es-ES). */
function formatConfidence(confidence: number | undefined): string {
  return percent(confidence ?? 0, { ratio: true, maximumFractionDigits: 0 });
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  return (
    <CocoaBadge tone={confidenceTone(confidence ?? 0)} variant="tinted" size="small">
      {formatConfidence(confidence)}
    </CocoaBadge>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return <span className="cocoa-note">—</span>;
  return (
    <span className="cocoa-cluster" data-gap="1">
      {warnings.map((w, i) => (
        <CocoaBadge key={`${w}-${i}`} tone="warning" size="small" title={w}>
          <span className="cocoa-truncate" style={{ maxWidth: 220 }}>
            {w}
          </span>
        </CocoaBadge>
      ))}
    </span>
  );
}

/** Caption + monospace value (the classification facts). */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="cocoa-row" data-gap="3" data-align="baseline">
      <span className="cocoa-caption" style={{ minWidth: 160 }}>
        {label}
      </span>
      <span className="cocoa-mono">{value}</span>
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

/** A 403 reads as a permission problem of the onboarding.* keys, anything else verbatim. */
function actionErrorMessage(err: unknown): string {
  const message = errorMessage(err);
  return isForbidden(message) ? `Sin permiso (onboarding.*): ${message}` : message;
}

// Shared "Continue the journey" nav strip kept at the bottom of every screen so
// the pipeline stays traversable.
function NavCards({ actions }: { actions: Array<{ label: string; screen: ScreenKey }> }) {
  return (
    <CocoaSection title="Siguientes pasos" meta="Continúa el proceso">
      <div className="cocoa-row" data-gap="2">
        {actions.map((a) => (
          <CocoaButton key={a.screen} variant="bordered" tone="neutral" onClick={() => navigateTo(a.screen)}>
            {a.label}
          </CocoaButton>
        ))}
      </div>
    </CocoaSection>
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
  const options = projects.map((p) => ({ value: p.id, label: String(p.name ?? p.id) }));
  return (
    <CocoaSection title="Proyecto de alta y migración" meta={plural(projects.length, "proyecto", "proyectos")}>
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-row" data-gap="3" data-align="end">
          {projects.length > 0 ? (
            <CocoaField label="Proyecto activo" style={{ flex: "1 1 260px", maxWidth: 420 }}>
              <CocoaSelect value={activeId ?? ""} onChange={onSelect} options={options} placeholder="Selecciona un proyecto…" />
            </CocoaField>
          ) : (
            <span className="cocoa-note">Aún no hay proyectos de alta/migración.</span>
          )}
          <CocoaButton variant="bordered" tone="neutral" onClick={onCreate} disabled={creating} loading={creating}>
            {creating ? "Creando…" : "Crear proyecto de demostración"}
          </CocoaButton>
        </div>
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaSection>
  );
}

// Shared project-selection hook used by both screens.
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
      setActionError(actionErrorMessage(err));
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
      setActionError(actionErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function loadSample() {
    setFileName("room-list.csv");
    setContent(SAMPLE_ROOM_CSV);
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
    <CocoaPage
      eyebrow={EYEBROW}
      title="Subida y clasificación de ficheros"
      subtitle="Pega una lista de habitaciones, un tarifario, un mapeo de canales, reservas o una exportación de Histórico y Previsión. La IA clasifica el tipo de documento y luego ejecuta la extracción. No se aplica nada sin revisión humana."
      commands={[
        { id: "onboarding-upload-classify", label: "Subir y clasificar el fichero", run: () => { void handleUploadAndClassify(); } },
        { id: "onboarding-extract", label: "Ejecutar la extracción", run: () => { void handleExtract(); } }
      ]}
    >
      <ProjectBanner
        projects={projects}
        activeId={activeId}
        onSelect={select}
        onCreate={create}
        creating={creating}
        error={projectError}
      />

      <CocoaSection
        title="Subir contenido"
        meta="Paso 1"
        action={
          classified ? (
            <span className="cocoa-cluster" data-gap="2">
              <CocoaBadge tone="neutral" size="small">
                {detectedType}
              </CocoaBadge>
              <ConfidenceBadge confidence={uploadedFile?.confidence ?? 0} />
            </span>
          ) : undefined
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Nombre del fichero" style={{ maxWidth: 360 }}>
            <CocoaInput value={fileName} onChange={setFileName} placeholder="room-list.csv" />
          </CocoaField>
          <CocoaField label="Contenido pegado (CSV / JSON)">
            <CocoaInput multiline rows={10} value={content} onChange={setContent} placeholder="Room,Type,Floor,Status…" />
          </CocoaField>
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" onClick={loadSample}>
              Cargar lista de habitaciones de ejemplo
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={() => { void handleUploadAndClassify(); }}
              disabled={busy !== null || !activeId}
              loading={busy === "upload"}
            >
              {busy === "upload" ? "Subiendo…" : "Subir y clasificar"}
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => { void handleExtract(); }}
              disabled={busy !== null || !classified || uploadBlocked}
              loading={busy === "extract"}
              title={!classified ? "Clasifica un fichero primero" : undefined}
            >
              {busy === "extract" ? "Extrayendo…" : "Ejecutar extracción"}
            </CocoaButton>
          </div>
          {actionError ? (
            <CocoaCallout tone="danger" role="alert">
              {actionError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaSection>

      {classified && !uploadBlocked ? (
        <CocoaSection title="Tipo de documento detectado" meta="Paso 2 · Clasificación" action={<ConfidenceBadge confidence={uploadedFile?.confidence ?? 0} />}>
          <div className="cocoa-stack" data-gap="2">
            <Fact label="Nombre del fichero" value={uploadedFile?.fileName ?? "—"} />
            <Fact label="Tipo detectado" value={detectedType ?? "—"} />
            <Fact label="Confianza" value={formatConfidence(uploadedFile?.confidence)} />
            <Fact label="Estado" value={uploadedFile?.status ?? "—"} />
          </div>
        </CocoaSection>
      ) : null}

      {summary ? (
        <CocoaSection
          title="Resumen de la extracción"
          meta="Paso 3 · Extracción completada"
          action={
            <CocoaBadge tone="success" variant="tinted" size="small">
              extraído
            </CocoaBadge>
          }
          footer={
            <CocoaButton variant="filled" tone="accent" onClick={() => navigateTo("AIExtractionReview")}>
              Revisar entidades extraídas
            </CocoaButton>
          }
        >
          <CocoaKpiStrip aria-label="Resumen de la extracción">
            <CocoaKpi label="Entidades totales" value={number(summary.totalEntities)} polarity="neutral" status="ok" />
            <CocoaKpi label="Confianza media" value={formatConfidence(summary.avgConfidence)} polarity="neutral" status={confidenceStatus(summary.avgConfidence)} />
            <CocoaKpi label="Avisos" value={number(summary.warnings)} polarity="neutral" status={summary.warnings > 0 ? "warning" : "ok"} />
          </CocoaKpiStrip>
        </CocoaSection>
      ) : null}

      <CocoaCallout tone="warning" role="note" title="Se requiere revisión humana">
        Las sugerencias de la IA quedan pendientes hasta que una persona las aprueba, rechaza o edita: la IA no puede aplicar la
        migración directamente. Los ficheros subidos se cifran, los datos de tarjeta de pago en bruto se rechazan y las vistas
        previas sensibles requieren permiso.
      </CocoaCallout>

      <NavCards
        actions={[
          { label: "Siguiente: revisión de extracción (IA)", screen: "AIExtractionReview" },
          { label: "Mapear propiedad desde documentos", screen: "PropertyMapper" }
        ]}
      />
    </CocoaPage>
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
      setError(actionErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) void load(activeId);
    else setEntities([]);
  }, [activeId, load]);

  const reload = useCallback(() => {
    if (activeId) void load(activeId);
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
      setGenerateError(actionErrorMessage(err));
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

  const columns = useMemo<CocoaTableColumn<ExtractedEntity>[]>(
    () => [
      { key: "entityType", label: "Tipo de entidad", fit: true, render: (e) => <strong>{e.entityType}</strong> },
      { key: "sourceRef", label: "Referencia de origen", truncate: 220, render: (e) => e.sourceRef },
      { key: "confidence", label: "Confianza", fit: true, render: (e) => <ConfidenceBadge confidence={e.confidence} /> },
      { key: "fields", label: "Campos clave", minWidth: 240, truncate: 360, render: (e) => compactFields(e.fields) },
      { key: "warnings", label: "Avisos", minWidth: 160, render: (e) => <Warnings warnings={e.warnings} /> }
    ],
    []
  );

  return (
    <CocoaPage
      eyebrow={EYEBROW}
      title="Revisión de extracción (IA)"
      subtitle="Revisa las entidades extraídas, sus referencias de origen, la confianza y los avisos antes del mapeo de esquema. Las filas con baja confianza se marcan para revisión humana."
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={reload} disabled={!activeId || loading} loading={loading}>
          Actualizar
        </CocoaButton>
      }
      commands={[
        { id: "ai-extraction-refresh", label: "Actualizar las entidades extraídas", run: reload },
        { id: "ai-extraction-generate", label: "Generar mapeos", run: () => { void handleGenerate(); } }
      ]}
    >
      <ProjectBanner
        projects={projects}
        activeId={activeId}
        onSelect={select}
        onCreate={create}
        creating={creating}
        error={projectError}
      />

      <CocoaKpiStrip aria-label="Resumen de las entidades extraídas">
        <CocoaKpi label="Entidades totales" value={loading ? "…" : number(kpis.total)} polarity="neutral" status="ok" />
        <CocoaKpi
          label="Tipos de entidad"
          value={loading ? "…" : number(kpis.byType.length)}
          caption={kpis.byType.map(([t, c]) => `${t}: ${number(c)}`).join(" · ") || "—"}
          polarity="neutral"
          status="ok"
        />
        <CocoaKpi label="Confianza media" value={loading ? "…" : formatConfidence(kpis.avgConfidence)} polarity="neutral" status={confidenceStatus(kpis.avgConfidence)} />
        <CocoaKpi
          label="Requiere revisión"
          value={loading ? "…" : number(kpis.needsReview)}
          caption="Confianza por debajo del 50 %"
          polarity="neutral"
          status={kpis.needsReview > 0 ? "critical" : "ok"}
        />
      </CocoaKpiStrip>

      <CocoaSection
        title="Cola de revisión"
        meta="Entidades extraídas"
        action={
          <CocoaBadge tone="neutral" size="small">
            {plural(entities.length, "fila", "filas")}
          </CocoaBadge>
        }
        footer={
          <div className="cocoa-stack" data-gap="2">
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="filled" tone="accent" onClick={() => { void handleGenerate(); }} disabled={!activeId || generating} loading={generating}>
                {generating ? "Generando mapeos…" : "Generar mapeos"}
              </CocoaButton>
              {mappingCount !== null ? (
                <CocoaBadge tone="success" variant="tinted">
                  {plural(mappingCount, "mapeo generado", "mapeos generados")}
                </CocoaBadge>
              ) : null}
            </div>
            {generateError ? (
              <CocoaCallout tone="danger" role="alert">
                {generateError}
              </CocoaCallout>
            ) : null}
          </div>
        }
      >
        {error ? (
          <CocoaState kind="error" inline title="No se pudieron cargar las entidades extraídas" message={error} onRetry={reload} />
        ) : loading ? (
          <CocoaState kind="loading" title="Cargando entidades extraídas…" />
        ) : entities.length === 0 ? (
          <CocoaState
            kind="empty"
            dashed
            title="Aún no hay entidades extraídas"
            message="Sube y extrae un fichero desde «Subida y clasificación de ficheros» primero."
            primaryAction={{ label: "Ir a la subida de ficheros", onClick: () => navigateTo("FileUploadAndClassification") }}
          />
        ) : (
          <CocoaTable<ExtractedEntity>
            columns={columns}
            rows={entities}
            rowKey="id"
            rowTone={(e) => (e.confidence < 0.5 ? "danger" : e.confidence < 0.8 ? "warning" : undefined)}
            caption="Cola de revisión de entidades extraídas"
          />
        )}
      </CocoaSection>

      <CocoaGrid gap={3} align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Enmascarado de PII en vistas previas"
            action={
              <CocoaBadge tone="success" variant="tinted" size="small">
                ok
              </CocoaBadge>
            }
          >
            <p className="cocoa-note">
              Los números de documento, teléfono, correo, dirección, pago e identidad se enmascaran salvo que se conceda
              onboarding.view_sensitive.
            </p>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Protección de datos en bruto"
            action={
              <CocoaBadge tone="danger" variant="tinted" size="small">
                bloqueado
              </CocoaBadge>
            }
          >
            <p className="cocoa-note">
              El CVV, el PAN/número de tarjeta completo en bruto y las imágenes de DNI/pasaporte se bloquean antes de la
              extracción.
            </p>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <NavCards
        actions={[
          { label: "Lotes de migración", screen: "MigrationBatches" },
          { label: "Volver a subir ficheros", screen: "FileUploadAndClassification" }
        ]}
      />
    </CocoaPage>
  );
}
