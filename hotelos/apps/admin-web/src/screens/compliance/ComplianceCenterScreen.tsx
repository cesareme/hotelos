import { useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import {
  updateComplianceItem,
  updateComplianceProfile,
  fetchComplianceDocuments,
  createComplianceDocument,
  deleteComplianceDocument,
  createComplianceTask,
  updateComplianceTask,
  deleteComplianceTask,
  fetchInspectionFolder,
  extractDocumentDates,
  type ComplianceAssistant,
  type ComplianceSuggestion,
  type ComplianceCenter,
  type ComplianceControl,
  type ComplianceStatus,
  type ComplianceTask,
  type ComplianceDocument,
  type ComplianceAlertsResponse,
  type ComplianceAlert,
  type ComplianceProfile
} from "../../services/complianceApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { toArray } from "../../utils/toArray";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  XCircleIcon,
  InfoCircleIcon
} from "../../components/cocoa-icons/StatusIcons";
import type { ComponentType } from "react";
import type { CocoaIconProps } from "../../components/cocoa-icons/StatusIcons";

// Instructional copy shown at the top of the Compliance Center screen.
// Helps users understand what the screen does and how to drive it.
// The card is dismissible and the dismissed state is persisted under the
// "compliance" key so it stays hidden across reloads.
const COMPLIANCE_INSTRUCTIONS = {
  title: "Centro de cumplimiento",
  description:
    "Repasa qué obligaciones legales aplican a este hotel, qué documento las justifica, cuándo vencen, quién es el responsable y qué riesgo hay si no se cumplen.",
  steps: [
    "Configura el perfil del establecimiento (comunidad autónoma, tipo y servicios) en Ajustes para que la matriz aplique las obligaciones correctas.",
    "Revisa la Matriz por área y abre cada control para actualizar su estado, responsable, fecha de caducidad y notas.",
    "Registra los documentos que justifican cada obligación: con su fecha de caducidad el control pasa a «Cumple» automáticamente.",
    "Atiende las Alertas (vencidos, vencen pronto, documentos faltantes) y crea Tareas correctivas para hacer seguimiento."
  ],
  tip: "Genera la «Carpeta de inspección» antes de una visita oficial para tener un dossier imprimible con todas las obligaciones aplicables y los documentos que las soportan."
};

const PROPERTY_ID = getActivePropertyId();

type Kind = "ok" | "warn" | "error" | "info";

// Cocoa StatusIcon mapping for the compliance "semáforo" (traffic light)
// chips. Each Kind (ok/warn/error/info) maps to a Cocoa status icon so the
// regulatory state indicators (VeriFactu / SES / TBAI / IGIC) render with the
// canonical Cocoa shield icons instead of bare colored text.
const KIND_ICON: Record<Kind, ComponentType<CocoaIconProps>> = {
  ok: CheckCircleIcon,
  warn: ExclamationCircleIcon,
  error: XCircleIcon,
  info: InfoCircleIcon
};

/** Status chip with leading Cocoa StatusIcon — used for the regulatory
 *  "semáforo" (VeriFactu / SES / TBAI / IGIC) and every other compliance
 *  status badge in the screen. Keeps the `bo-status` class so colors continue
 *  to be driven by the design tokens. */
function StatusChip({ kind, children, style }: { kind: Kind; children: React.ReactNode; style?: React.CSSProperties }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={`bo-status ${kind}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, ...style }}>
      <Icon size={12} aria-hidden={true} />
      {children}
    </span>
  );
}
const STATUS_LABEL: Record<ComplianceStatus, string> = {
  COMPLIANT: "Cumple", NON_COMPLIANT: "No cumple", PENDING: "Pendiente", EXPIRED: "Vencido",
  EXPIRING_SOON: "Vence pronto", NOT_APPLICABLE: "No aplica", UNDER_REVIEW: "En revisión"
};
const STATUS_KIND: Record<ComplianceStatus, Kind> = {
  COMPLIANT: "ok", NON_COMPLIANT: "error", PENDING: "warn", EXPIRED: "error",
  EXPIRING_SOON: "warn", NOT_APPLICABLE: "info", UNDER_REVIEW: "info"
};
const RISK_LABEL: Record<string, string> = { CRITICAL: "Crítico", HIGH: "Alto", MEDIUM: "Medio", LOW: "Bajo" };
const RISK_KIND: Record<string, Kind> = { CRITICAL: "error", HIGH: "warn", MEDIUM: "info", LOW: "ok" };
const EDITABLE_STATUS: { v: string; l: string }[] = [
  { v: "COMPLIANT", l: "Cumple" }, { v: "PENDING", l: "Pendiente" }, { v: "NON_COMPLIANT", l: "No cumple" }, { v: "UNDER_REVIEW", l: "En revisión" }
];
const ALERT_KIND_LABEL: Record<string, string> = {
  EXPIRED: "Vencido", EXPIRING_SOON: "Vence pronto", NON_COMPLIANT: "No cumple", MISSING_DOCUMENT: "Falta documento", TASK_OVERDUE: "Tarea vencida"
};
const SEVERITY_KIND: Record<string, Kind> = { CRITICAL: "error", HIGH: "error", MEDIUM: "warn", LOW: "info" };
const SEVERITY_LABEL: Record<string, string> = { CRITICAL: "Crítico", HIGH: "Alto", MEDIUM: "Medio", LOW: "Bajo" };
const TASK_STATUS_LABEL: Record<string, string> = { OPEN: "Abierta", IN_PROGRESS: "En curso", DONE: "Hecha" };
const TASK_STATUS_KIND: Record<string, Kind> = { OPEN: "warn", IN_PROGRESS: "info", DONE: "ok" };
const COMUNIDADES: { v: string; l: string }[] = [
  { v: "AND", l: "Andalucía" }, { v: "ARA", l: "Aragón" }, { v: "AST", l: "Asturias" }, { v: "BAL", l: "Islas Baleares" },
  { v: "CAN", l: "Canarias" }, { v: "CANT", l: "Cantabria" }, { v: "CLM", l: "Castilla-La Mancha" }, { v: "CYL", l: "Castilla y León" },
  { v: "CAT", l: "Cataluña" }, { v: "VAL", l: "Comunitat Valenciana" }, { v: "EXT", l: "Extremadura" }, { v: "GAL", l: "Galicia" },
  { v: "MAD", l: "Comunidad de Madrid" }, { v: "MUR", l: "Región de Murcia" }, { v: "NAV", l: "Navarra" }, { v: "PVA", l: "País Vasco" },
  { v: "RIO", l: "La Rioja" }, { v: "CEU", l: "Ceuta" }, { v: "MEL", l: "Melilla" }
];
const HOTEL_TYPES: { v: string; l: string }[] = [
  { v: "URBAN", l: "Urbano" }, { v: "RESORT", l: "Resort / vacacional" }, { v: "RURAL", l: "Rural" }, { v: "APARTHOTEL", l: "Aparthotel" }, { v: "HOSTEL", l: "Hostel / albergue" }
];
const PROFILE_FEATURES: { k: keyof ComplianceProfile; l: string }[] = [
  { k: "hasRestaurant", l: "Restaurante" }, { k: "hasKitchen", l: "Cocina propia" }, { k: "hasPool", l: "Piscina" }, { k: "hasSpa", l: "Spa / wellness" },
  { k: "hasParking", l: "Parking" }, { k: "hasEvents", l: "Eventos / salones" }, { k: "hasTerrace", l: "Terraza / música" }, { k: "hasLaundry", l: "Lavandería" },
  { k: "buildingProtected", l: "Edificio protegido" }
];
const COMUNIDAD_LABEL: Record<string, string> = Object.fromEntries(COMUNIDADES.map((c) => [c.v, c.l]));

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Tab = "matriz" | "documentos" | "tareas" | "alertas" | "asistente" | "ajustes";

export function ComplianceCenterScreen() {
  const { data, loading, error, refresh } = useApiData<ComplianceCenter>(
    `/compliance/properties/${PROPERTY_ID}/center`,
    { pollIntervalMs: 60000 }
  );
  const tasksApi = useApiData<ComplianceTask[]>(`/compliance/properties/${PROPERTY_ID}/tasks`, { pollIntervalMs: 60000 });
  const docsApi = useApiData<{ items: ComplianceDocument[] }>(`/compliance/properties/${PROPERTY_ID}/documents`, { pollIntervalMs: 0 });
  const alertsApi = useApiData<ComplianceAlertsResponse>(`/compliance/properties/${PROPERTY_ID}/alerts`, { pollIntervalMs: 60000 });

  const [tab, setTab] = useState<Tab>("matriz");
  // The assistant is fetched lazily (only when its tab is open) to avoid an LLM
  // call on every dashboard load when a provider is configured.
  const assistantApi = useApiData<ComplianceAssistant>(tab === "asistente" ? `/compliance/properties/${PROPERTY_ID}/assistant` : null, { pollIntervalMs: 0 });
  const [area, setArea] = useState("all");
  const [risk, setRisk] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status: string; responsibleName: string; expiryDate: string; notes: string }>({ status: "", responsibleName: "", expiryDate: "", notes: "" });

  // documents associated to the currently-open ficha
  const [fichaDocs, setFichaDocs] = useState<ComplianceDocument[]>([]);
  const [fichaDocsLoading, setFichaDocsLoading] = useState(false);
  const [docForm, setDocForm] = useState<{ title: string; documentType: string; issueDate: string; expiryDate: string; fileName: string; mimeType: string; fileSize: number }>({ title: "", documentType: "", issueDate: "", expiryDate: "", fileName: "", mimeType: "", fileSize: 0 });

  const kpis = data?.kpis;
  const areas = data?.areas ?? [];
  const controls = useMemo(() => data?.controls ?? [], [data]);
  const tasks = useMemo(() => toArray<ComplianceTask>(tasksApi.data), [tasksApi.data]);
  const allDocs = docsApi.data?.items ?? [];
  const alerts = alertsApi.data;

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => controls.filter((c) => {
    if (area !== "all" && c.areaCode !== area) return false;
    if (risk !== "all" && c.riskLevel !== risk) return false;
    if (status !== "all" && c.status !== status) return false;
    if (q && !`${c.code} ${c.title} ${c.areaName}`.toLowerCase().includes(q)) return false;
    return true;
  }), [controls, area, risk, status, q]);

  async function loadFichaDocs(code: string) {
    setFichaDocsLoading(true);
    try { setFichaDocs(await fetchComplianceDocuments(code)); }
    catch { setFichaDocs([]); }
    finally { setFichaDocsLoading(false); }
  }

  function openFicha(c: ComplianceControl) {
    if (openCode === c.code) { setOpenCode(null); return; }
    setOpenCode(c.code);
    setMsg(null);
    setDraft({
      status: ["COMPLIANT", "PENDING", "NON_COMPLIANT", "UNDER_REVIEW"].includes(c.status) ? c.status : "PENDING",
      responsibleName: c.responsibleName ?? "",
      expiryDate: c.expiryDate ? c.expiryDate.slice(0, 10) : "",
      notes: c.notes ?? ""
    });
    setDocForm({ title: "", documentType: c.requiredDocuments[0] ?? "", issueDate: "", expiryDate: "", fileName: "", mimeType: "", fileSize: 0 });
    void loadFichaDocs(c.code);
  }

  async function saveItem(c: ComplianceControl, patch: Record<string, unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try {
      await updateComplianceItem(c.code, patch);
      setMsg(ok);
      refresh(); alertsApi.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function addDocToControl(c: ComplianceControl) {
    if (!docForm.title.trim()) { setMsg("Indica un título para el documento."); return; }
    setBusy(true); setMsg(null);
    try {
      await createComplianceDocument({
        requirementCode: c.code,
        title: docForm.title.trim(),
        documentType: docForm.documentType || undefined,
        fileName: docForm.fileName || undefined,
        mimeType: docForm.mimeType || undefined,
        fileSize: docForm.fileSize || undefined,
        issueDate: docForm.issueDate || undefined,
        expiryDate: docForm.expiryDate || undefined
      });
      setMsg("Documento registrado. El control se actualizó con su fecha de caducidad.");
      setDocForm({ title: "", documentType: c.requiredDocuments[0] ?? "", issueDate: "", expiryDate: "", fileName: "", mimeType: "", fileSize: 0 });
      await loadFichaDocs(c.code);
      refresh(); docsApi.refresh(); alertsApi.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo registrar el documento.");
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc(id: string, code?: string) {
    setBusy(true); setMsg(null);
    try {
      await deleteComplianceDocument(id);
      setMsg("Documento eliminado.");
      if (code) await loadFichaDocs(code);
      refresh(); docsApi.refresh(); alertsApi.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo eliminar.");
    } finally {
      setBusy(false);
    }
  }

  const alertCount = alerts?.count ?? 0;
  const openTaskCount = tasks.filter((t) => t.status !== "DONE").length;

  async function exportFolder() {
    setBusy(true); setMsg(null);
    try {
      const folder = await fetchInspectionFolder();
      const blob = new Blob([folder.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = folder.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg(`Carpeta de inspección generada (${folder.summary.applicable} obligaciones, ${folder.summary.documents} documentos). Ábrela e imprime a PDF.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo generar la carpeta.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <CocoaScreenInstructionsCard
        title={COMPLIANCE_INSTRUCTIONS.title}
        description={COMPLIANCE_INSTRUCTIONS.description}
        steps={COMPLIANCE_INSTRUCTIONS.steps}
        tip={COMPLIANCE_INSTRUCTIONS.tip}
        dismissible
        persistKey="compliance"
      />
      <CocoaPageHeader
        eyebrow="Cumplimiento"
        title="Centro de cumplimiento"
        subtitle="Qué obligaciones legales aplican a este hotel, qué documento las justifica, cuándo vencen, quién es responsable y qué riesgo hay si no se cumplen."
        actions={
          <>
            {busy ? <Spinner size="sm" /> : null}
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={exportFolder}
              disabled={busy || loading}
            >
              Carpeta de inspección
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => { refresh(); tasksApi.refresh(); docsApi.refresh(); alertsApi.refresh(); }}
              disabled={loading}
            >
              Actualizar
            </CocoaButton>
          </>
        }
      />

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {loading && !data ? (
        <LoadingBlock label="Cargando cumplimiento…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refresh} />
      ) : kpis ? (
        <>
          {/* KPIs (dashboard, always visible). Cada KPI muestra el chip semáforo
              (VeriFactu / SES / TBAI / IGIC y resto de controles compartidos)
              con el icono Cocoa correspondiente. */}
          <div className="rev-kpi-grid">
            <article className={`rev-kpi rev-kpi-${kpis.compliancePct >= 80 ? "ok" : kpis.compliancePct >= 50 ? "warn" : "error"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">% cumplimiento</span><StatusChip kind="info">{kpis.compliant}/{kpis.applicable}</StatusChip></div>
              <div className="rev-kpi-value">{kpis.compliancePct}%</div>
            </article>
            <article className={`rev-kpi rev-kpi-${kpis.criticalOpen > 0 ? "error" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Críticos abiertos</span><StatusChip kind={kpis.criticalOpen > 0 ? "error" : "ok"}>{kpis.criticalOpen > 0 ? "riesgo" : "ok"}</StatusChip></div><div className="rev-kpi-value">{kpis.criticalOpen}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.expired > 0 ? "error" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Vencidos</span><StatusChip kind={kpis.expired > 0 ? "error" : "ok"}>{kpis.expired > 0 ? "renovar" : "ninguno"}</StatusChip></div><div className="rev-kpi-value">{kpis.expired}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.expiringSoon > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Vencen pronto</span><StatusChip kind={kpis.expiringSoon > 0 ? "warn" : "ok"}>≤30 d</StatusChip></div><div className="rev-kpi-value">{kpis.expiringSoon}</div></article>
            <article className={`rev-kpi rev-kpi-${kpis.nonCompliant + kpis.pending > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Pendientes / No cumple</span><StatusChip kind="warn">{kpis.nonCompliant} no cumple</StatusChip></div><div className="rev-kpi-value">{kpis.pending + kpis.nonCompliant}</div></article>
          </div>

          {/* Tabs — CocoaSegmentedControl + chips de conteo con StatusIcon */}
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <CocoaSegmentedControl
              value={tab}
              onChange={(v) => setTab(v as Tab)}
              options={[
                { value: "matriz", label: "Matriz" },
                { value: "documentos", label: "Documentos" },
                { value: "tareas", label: "Tareas" },
                { value: "alertas", label: "Alertas" },
                { value: "asistente", label: "Asistente IA" },
                { value: "ajustes", label: "Ajustes" }
              ]}
              aria-label="Secciones de Centro de cumplimiento"
            />
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {tab === "matriz" ? <StatusChip kind="info" style={{ fontSize: 10 }}>{kpis.applicable}</StatusChip> : null}
              {tab === "documentos" ? <StatusChip kind="info" style={{ fontSize: 10 }}>{allDocs.length}</StatusChip> : null}
              {tab === "tareas" && openTaskCount > 0 ? <StatusChip kind="warn" style={{ fontSize: 10 }}>{openTaskCount}</StatusChip> : null}
              {tab === "alertas" && alertCount > 0 ? <StatusChip kind="error" style={{ fontSize: 10 }}>{alertCount}</StatusChip> : null}
            </div>
          </div>

          {tab === "matriz" ? (
            <MatrizTab
              areas={areas} visible={visible} controls={controls}
              area={area} setArea={setArea} risk={risk} setRisk={setRisk} status={status} setStatus={setStatus} query={query} setQuery={setQuery}
              openCode={openCode} openFicha={openFicha} draft={draft} setDraft={setDraft} busy={busy} saveItem={saveItem}
              fichaDocs={fichaDocs} fichaDocsLoading={fichaDocsLoading} docForm={docForm} setDocForm={setDocForm} addDocToControl={addDocToControl} removeDoc={removeDoc}
              onPickArea={(code) => { setArea(code); setOpenCode(null); }}
            />
          ) : tab === "documentos" ? (
            <DocumentosTab docsApi={docsApi} controls={controls} onChanged={() => { refresh(); alertsApi.refresh(); }} setBusy={setBusy} setMsg={setMsg} busy={busy} removeDoc={removeDoc} />
          ) : tab === "tareas" ? (
            <TareasTab tasksApi={tasksApi} controls={controls} onChanged={() => alertsApi.refresh()} setBusy={setBusy} setMsg={setMsg} busy={busy} />
          ) : tab === "alertas" ? (
            <AlertasTab alertsApi={alertsApi} onJump={(code) => { setTab("matriz"); setStatus("all"); setArea("all"); setQuery(code); }} />
          ) : tab === "asistente" ? (
            <AsistenteTab assistantApi={assistantApi} busy={busy} setBusy={setBusy} setMsg={setMsg} onTaskCreated={() => { tasksApi.refresh(); }} onJump={(code) => { setTab("matriz"); setStatus("all"); setArea("all"); setQuery(code); }} />
          ) : (
            <AjustesTab profile={data?.profile ?? null} kpis={kpis} busy={busy} setBusy={setBusy} setMsg={setMsg} onSaved={() => { refresh(); alertsApi.refresh(); docsApi.refresh(); }} />
          )}
        </>
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------------- Matriz tab */
function MatrizTab(props: {
  areas: ComplianceCenter["areas"]; visible: ComplianceControl[]; controls: ComplianceControl[];
  area: string; setArea: (v: string) => void; risk: string; setRisk: (v: string) => void; status: string; setStatus: (v: string) => void; query: string; setQuery: (v: string) => void;
  openCode: string | null; openFicha: (c: ComplianceControl) => void; draft: { status: string; responsibleName: string; expiryDate: string; notes: string }; setDraft: React.Dispatch<React.SetStateAction<{ status: string; responsibleName: string; expiryDate: string; notes: string }>>; busy: boolean; saveItem: (c: ComplianceControl, patch: Record<string, unknown>, ok: string) => void;
  fichaDocs: ComplianceDocument[]; fichaDocsLoading: boolean; docForm: { title: string; documentType: string; issueDate: string; expiryDate: string; fileName: string; mimeType: string; fileSize: number }; setDocForm: React.Dispatch<React.SetStateAction<{ title: string; documentType: string; issueDate: string; expiryDate: string; fileName: string; mimeType: string; fileSize: number }>>; addDocToControl: (c: ComplianceControl) => void; removeDoc: (id: string, code?: string) => void;
  onPickArea: (code: string) => void;
}) {
  const { areas, visible, area, setArea, risk, setRisk, status, setStatus, query, setQuery, openCode, openFicha, draft, setDraft, busy, saveItem, fichaDocs, fichaDocsLoading, docForm, setDocForm, addDocToControl, removeDoc, onPickArea } = props;
  return (
    <>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Por área</h3><span className="bo-chip">{areas.length} áreas</span></div>
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead><tr><th>Área</th><th>Cumplidos</th><th>Pendientes</th><th>Vencen pronto</th><th>Vencidos</th><th>No cumple</th><th>Críticos</th></tr></thead>
            <tbody>
              {areas.map((a) => (
                <tr key={a.code} style={{ cursor: "pointer" }} onClick={() => onPickArea(a.code)}>
                  <td><strong>{a.name}</strong></td>
                  <td>{a.compliant}/{a.total}</td>
                  <td>{a.pending || "—"}</td>
                  <td>{a.expiringSoon ? <StatusChip kind="warn">{a.expiringSoon}</StatusChip> : "—"}</td>
                  <td>{a.expired ? <StatusChip kind="error">{a.expired}</StatusChip> : "—"}</td>
                  <td>{a.nonCompliant ? <StatusChip kind="error">{a.nonCompliant}</StatusChip> : "—"}</td>
                  <td>{a.critical ? <StatusChip kind="error">{a.critical}</StatusChip> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <div className="bo-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar control…" style={{ minWidth: 200 }} />
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="all">Todas las áreas</option>
          {areas.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="all">Cualquier riesgo</option>
          <option value="CRITICAL">Crítico</option><option value="HIGH">Alto</option><option value="MEDIUM">Medio</option><option value="LOW">Bajo</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Cualquier estado</option>
          {(Object.keys(STATUS_LABEL) as ComplianceStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <span className="bo-muted" style={{ fontSize: 12 }}>{visible.length} controles</span>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="Sin controles" message="No hay controles que coincidan con los filtros." />
      ) : (
        <div className="bo-stack" style={{ gap: 6 }}>
          {visible.map((c) => {
            const open = openCode === c.code;
            return (
              <article key={c.code} className="bo-card" style={{ background: "var(--surface)", padding: "10px 12px" }}>
                <button type="button" onClick={() => openFicha(c)} style={{ all: "unset", cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
                  <span style={{ minWidth: 0, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="bo-muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{c.code}</span>
                    <strong style={{ color: "var(--ink)" }}>{c.title}</strong>
                    <StatusChip kind={RISK_KIND[c.riskLevel]} style={{ fontSize: 10 }}>{RISK_LABEL[c.riskLevel]}</StatusChip>
                    {c.autonomousCommunity ? <span className="bo-chip" style={{ fontSize: 10 }}>{COMUNIDAD_LABEL[c.autonomousCommunity] ?? c.autonomousCommunity}</span> : null}
                    {c.documentsCount > 0 ? <span className="bo-muted" style={{ fontSize: 11 }}>📎 {c.documentsCount}</span> : null}
                  </span>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {c.expiryDate ? <span className="bo-muted" style={{ fontSize: 12 }}>vence {fmtDate(c.expiryDate)}</span> : null}
                    <StatusChip kind={STATUS_KIND[c.status]}>{STATUS_LABEL[c.status]}</StatusChip>
                    <span className="bo-muted" aria-hidden>{open ? "▾" : "▸"}</span>
                  </span>
                </button>

                {open ? (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--line-soft)", paddingTop: 10, display: "grid", gap: 12 }}>
                    <div className="bo-muted" style={{ fontSize: 12.5, textTransform: "none" }}>
                      {c.areaName} · {c.jurisdiction === "STATE" ? "Estatal" : c.jurisdiction === "AUTONOMOUS_COMMUNITY" ? "Autonómica" : c.jurisdiction === "MUNICIPAL" ? "Municipal" : "Interna"}
                      {c.legalReference ? ` · ${c.legalReference}` : ""}
                      {c.appliesWhen ? ` · ${c.appliesWhen}` : ""}
                    </div>
                    {c.requiredDocuments.length ? (
                      <div style={{ fontSize: 12.5 }}><strong>Documentos requeridos:</strong> {c.requiredDocuments.join(", ")}</div>
                    ) : null}

                    {c.applies ? (
                      <>
                        <div className="bo-grid two" style={{ gap: 10 }}>
                          <label className="bo-form-field"><span>Estado</span>
                            <select value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))} disabled={busy}>
                              {EDITABLE_STATUS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
                            </select>
                          </label>
                          <label className="bo-form-field"><span>Responsable</span><input value={draft.responsibleName} onChange={(e) => setDraft((d) => ({ ...d, responsibleName: e.target.value }))} disabled={busy} /></label>
                          <label className="bo-form-field"><span>Vence el</span><input type="date" value={draft.expiryDate} onChange={(e) => setDraft((d) => ({ ...d, expiryDate: e.target.value }))} disabled={busy} /></label>
                          <label className="bo-form-field"><span>Notas</span><input value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} disabled={busy} /></label>
                        </div>
                        <div className="bo-row" style={{ gap: 6, flexWrap: "wrap" }}>
                          <button type="button" className="primary" disabled={busy} onClick={() => saveItem(c, { status: draft.status, responsibleName: draft.responsibleName || null, expiryDate: draft.expiryDate || null, notes: draft.notes || null }, "Control actualizado.")}>Guardar</button>
                          <button type="button" disabled={busy} onClick={() => saveItem(c, { applies: false, notApplicableReason: "Marcado manualmente" }, "Marcado como no aplica.")}>No aplica</button>
                        </div>

                        {/* Documentos del control */}
                        <div style={{ borderTop: "1px dashed var(--line-soft)", paddingTop: 10, display: "grid", gap: 8 }}>
                          <strong style={{ fontSize: 12.5 }}>Documentos que lo justifican</strong>
                          {fichaDocsLoading ? <span className="bo-muted" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner size="sm" /> Cargando…</span> : fichaDocs.length === 0 ? (
                            <span className="bo-muted" style={{ fontSize: 12 }}>Aún no hay documentos cargados para este control.</span>
                          ) : (
                            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                              {fichaDocs.map((d) => (
                                <li key={d.id} className="bo-row" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", fontSize: 12.5 }}>
                                  <span>📄 <strong>{d.title}</strong>{d.fileName && d.fileName !== d.title ? <span className="bo-muted"> · {d.fileName}</span> : null}{d.fileSize ? <span className="bo-muted"> · {fmtSize(d.fileSize)}</span> : null}</span>
                                  <span className="bo-row" style={{ gap: 8, alignItems: "center" }}>
                                    {d.expiryDate ? <span className="bo-muted">vence {fmtDate(d.expiryDate)}</span> : null}
                                    <button type="button" className="bo-link" disabled={busy} onClick={() => removeDoc(d.id, c.code)}>Eliminar</button>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="bo-grid two" style={{ gap: 8 }}>
                            <label className="bo-form-field"><span>Título del documento</span><input value={docForm.title} onChange={(e) => setDocForm((f) => ({ ...f, title: e.target.value }))} placeholder="p. ej. Licencia de apertura 2026" disabled={busy} /></label>
                            <label className="bo-form-field"><span>Tipo</span><input value={docForm.documentType} onChange={(e) => setDocForm((f) => ({ ...f, documentType: e.target.value }))} list={`doctypes-${c.code}`} disabled={busy} />
                              <datalist id={`doctypes-${c.code}`}>{c.requiredDocuments.map((rd) => <option key={rd} value={rd} />)}</datalist>
                            </label>
                            <label className="bo-form-field"><span>Fecha de emisión</span><input type="date" value={docForm.issueDate} onChange={(e) => setDocForm((f) => ({ ...f, issueDate: e.target.value }))} disabled={busy} /></label>
                            <label className="bo-form-field"><span>Fecha de caducidad</span><input type="date" value={docForm.expiryDate} onChange={(e) => setDocForm((f) => ({ ...f, expiryDate: e.target.value }))} disabled={busy} /></label>
                            <label className="bo-form-field" style={{ gridColumn: "1 / -1" }}><span>Archivo (opcional)</span>
                              <input type="file" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) setDocForm((s) => ({ ...s, fileName: f.name, mimeType: f.type, fileSize: f.size, title: s.title || f.name })); }} />
                            </label>
                          </div>
                          <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>Se registra la referencia del documento (nombre, tipo y fechas) y, si añades fecha de caducidad, el control pasa a «Cumple» con esa fecha. El archivo se conserva en tu gestor documental.</p>
                          <div><button type="button" className="primary" disabled={busy} onClick={() => addDocToControl(c)}>Registrar documento</button></div>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="bo-muted" style={{ textTransform: "none", fontSize: 12.5 }}>Marcado como no aplicable{c.notApplicableReason ? `: ${c.notApplicableReason}` : ""}.</p>
                        <div><button type="button" className="primary" disabled={busy} onClick={() => saveItem(c, { applies: true, status: "PENDING" }, "Reactivado como pendiente.")}>Marcar que aplica</button></div>
                      </>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ----------------------------------------------------------- Documentos tab */
function DocumentosTab(props: {
  docsApi: ReturnType<typeof useApiData<{ items: ComplianceDocument[] }>>;
  controls: ComplianceControl[];
  onChanged: () => void; setBusy: (v: boolean) => void; setMsg: (v: string | null) => void; busy: boolean;
  removeDoc: (id: string, code?: string) => void;
}) {
  const { docsApi, controls, onChanged, setBusy, setMsg, busy, removeDoc } = props;
  const docs = docsApi.data?.items ?? [];
  const [form, setForm] = useState<{ requirementCode: string; title: string; documentType: string; issueDate: string; expiryDate: string; issuingAuthority: string; fileName: string; mimeType: string; fileSize: number }>({ requirementCode: "", title: "", documentType: "", issueDate: "", expiryDate: "", issuingAuthority: "", fileName: "", mimeType: "", fileSize: 0 });
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const codeToTitle = useMemo(() => new Map(controls.map((c) => [c.code, c.title])), [controls]);

  function onPickFile(f: File | undefined) {
    if (!f) return;
    setForm((s) => ({ ...s, fileName: f.name, mimeType: f.type, fileSize: f.size, title: s.title || f.name }));
    if (f.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => setImageDataUrl(typeof reader.result === "string" ? reader.result : null);
      reader.readAsDataURL(f);
    } else {
      setImageDataUrl(null);
    }
  }
  async function readDatesWithAi() {
    if (!imageDataUrl) return;
    setOcrBusy(true); setMsg(null);
    try {
      const res = await extractDocumentDates(imageDataUrl);
      if (!res.aiGenerated) {
        setMsg("IA no configurada: introduce las fechas manualmente (configura AI_PROVIDER para activar la lectura automática).");
      } else {
        setForm((s) => ({
          ...s,
          documentType: res.fields.documentType || s.documentType,
          issuingAuthority: res.fields.issuingAuthority || s.issuingAuthority,
          issueDate: res.fields.issueDate || s.issueDate,
          expiryDate: res.fields.expiryDate || s.expiryDate
        }));
        setMsg(`IA (${res.provider}): datos leídos del documento. Revísalos antes de guardar.`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo leer el documento.");
    } finally { setOcrBusy(false); }
  }

  useEffect(() => { docsApi.refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function submit() {
    if (!form.title.trim()) { setMsg("Indica un título para el documento."); return; }
    setBusy(true); setMsg(null);
    try {
      await createComplianceDocument({
        requirementCode: form.requirementCode || undefined,
        title: form.title.trim(),
        documentType: form.documentType || undefined,
        issueDate: form.issueDate || undefined,
        expiryDate: form.expiryDate || undefined,
        issuingAuthority: form.issuingAuthority || undefined,
        fileName: form.fileName || undefined,
        mimeType: form.mimeType || undefined,
        fileSize: form.fileSize || undefined
      });
      setMsg("Documento registrado.");
      setForm({ requirementCode: "", title: "", documentType: "", issueDate: "", expiryDate: "", issuingAuthority: "", fileName: "", mimeType: "", fileSize: 0 });
      setImageDataUrl(null);
      docsApi.refresh(); onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo registrar.");
    } finally { setBusy(false); }
  }

  return (
    <div className="bo-stack" style={{ gap: 12 }}>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Registrar documento</h3></div>
        <div className="bo-grid two" style={{ gap: 8 }}>
          <label className="bo-form-field" style={{ gridColumn: "1 / -1" }}><span>Asociar a control (opcional)</span>
            <select value={form.requirementCode} onChange={(e) => setForm((f) => ({ ...f, requirementCode: e.target.value }))} disabled={busy}>
              <option value="">Sin asociar / general</option>
              {controls.filter((c) => c.applies).map((c) => <option key={c.code} value={c.code}>{c.code} · {c.title}</option>)}
            </select>
          </label>
          <label className="bo-form-field"><span>Título</span><input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} disabled={busy} /></label>
          <label className="bo-form-field"><span>Tipo</span><input value={form.documentType} onChange={(e) => setForm((f) => ({ ...f, documentType: e.target.value }))} disabled={busy} /></label>
          <label className="bo-form-field"><span>Emisión</span><input type="date" value={form.issueDate} onChange={(e) => setForm((f) => ({ ...f, issueDate: e.target.value }))} disabled={busy} /></label>
          <label className="bo-form-field"><span>Caducidad</span><input type="date" value={form.expiryDate} onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))} disabled={busy} /></label>
          <label className="bo-form-field"><span>Organismo / proveedor</span><input value={form.issuingAuthority} onChange={(e) => setForm((f) => ({ ...f, issuingAuthority: e.target.value }))} disabled={busy} /></label>
          <label className="bo-form-field"><span>Archivo (opcional)</span><input type="file" disabled={busy} onChange={(e) => onPickFile(e.target.files?.[0])} /></label>
        </div>
        {imageDataUrl ? (
          <div className="bo-row" style={{ gap: 8, alignItems: "center", marginTop: 6 }}>
            <button type="button" disabled={busy || ocrBusy} onClick={readDatesWithAi}>{ocrBusy ? "Leyendo…" : "✨ Leer fechas con IA"}</button>
            <span className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>Extrae tipo, organismo y fechas de la imagen del documento.</span>
          </div>
        ) : null}
        <p className="bo-muted" style={{ fontSize: 11, textTransform: "none", marginTop: 6 }}>Se guarda la ficha del documento (referencia y fechas). Si lo asocias a un control con fecha de caducidad, el control se marca «Cumple» con esa fecha automáticamente.</p>
        <div style={{ marginTop: 8 }}><button type="button" className="primary" disabled={busy} onClick={submit}>Registrar documento</button></div>
      </article>

      {docsApi.loading && docs.length === 0 ? <LoadingBlock label="Cargando documentos…" /> : docs.length === 0 ? (
        <EmptyState title="Sin documentos" message="Aún no se ha registrado ningún documento de cumplimiento." />
      ) : (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Carpeta de documentos</h3><span className="bo-chip">{docs.length}</span></div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead><tr><th>Documento</th><th>Control</th><th>Emisión</th><th>Caducidad</th><th></th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.title}</strong>{d.documentType ? <span className="bo-muted"> · {d.documentType}</span> : null}{d.fileSize ? <span className="bo-muted"> · {fmtSize(d.fileSize)}</span> : null}</td>
                    <td>{d.requirementCode ? <span className="bo-muted">{d.requirementCode}{codeToTitle.get(d.requirementCode) ? ` · ${codeToTitle.get(d.requirementCode)}` : ""}</span> : "—"}</td>
                    <td>{fmtDate(d.issueDate)}</td>
                    <td>{d.expiryDate ? (new Date(d.expiryDate).getTime() < Date.now() ? <StatusChip kind="error">{fmtDate(d.expiryDate)}</StatusChip> : <span className="bo-muted">{fmtDate(d.expiryDate)}</span>) : "—"}</td>
                    <td><button type="button" className="bo-link" disabled={busy} onClick={() => removeDoc(d.id, d.requirementCode ?? undefined)}>Eliminar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Tareas tab */
function TareasTab(props: {
  tasksApi: ReturnType<typeof useApiData<ComplianceTask[]>>;
  controls: ComplianceControl[];
  onChanged: () => void; setBusy: (v: boolean) => void; setMsg: (v: string | null) => void; busy: boolean;
}) {
  const { tasksApi, controls, onChanged, setBusy, setMsg, busy } = props;
  const tasks = useMemo(() => toArray<ComplianceTask>(tasksApi.data), [tasksApi.data]);
  const [form, setForm] = useState<{ requirementCode: string; title: string; priority: string; dueDate: string; assignedToName: string }>({ requirementCode: "", title: "", priority: "MEDIUM", dueDate: "", assignedToName: "" });

  async function create() {
    if (!form.title.trim()) { setMsg("Indica un título para la tarea."); return; }
    setBusy(true); setMsg(null);
    try {
      await createComplianceTask({ requirementCode: form.requirementCode || undefined, title: form.title.trim(), priority: form.priority, dueDate: form.dueDate || undefined, assignedToName: form.assignedToName || undefined });
      setMsg("Tarea creada.");
      setForm({ requirementCode: "", title: "", priority: "MEDIUM", dueDate: "", assignedToName: "" });
      tasksApi.refresh(); onChanged();
    } catch (e) { setMsg(e instanceof Error ? e.message : "No se pudo crear la tarea."); }
    finally { setBusy(false); }
  }
  async function setStatus(id: string, status: string) {
    setBusy(true); setMsg(null);
    try { await updateComplianceTask(id, { status }); tasksApi.refresh(); onChanged(); }
    catch (e) { setMsg(e instanceof Error ? e.message : "No se pudo actualizar."); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setMsg(null);
    try { await deleteComplianceTask(id); tasksApi.refresh(); onChanged(); }
    catch (e) { setMsg(e instanceof Error ? e.message : "No se pudo eliminar."); }
    finally { setBusy(false); }
  }

  const open = tasks.filter((t) => t.status !== "DONE");
  const done = tasks.filter((t) => t.status === "DONE");
  return (
    <div className="bo-stack" style={{ gap: 12 }}>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Nueva tarea correctiva</h3></div>
        <div className="bo-grid two" style={{ gap: 8 }}>
          <label className="bo-form-field" style={{ gridColumn: "1 / -1" }}><span>Título</span><input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="p. ej. Renovar revisión de extintores" disabled={busy} /></label>
          <label className="bo-form-field"><span>Control (opcional)</span>
            <select value={form.requirementCode} onChange={(e) => setForm((f) => ({ ...f, requirementCode: e.target.value }))} disabled={busy}>
              <option value="">Sin asociar</option>
              {controls.filter((c) => c.applies).map((c) => <option key={c.code} value={c.code}>{c.code} · {c.title}</option>)}
            </select>
          </label>
          <label className="bo-form-field"><span>Prioridad</span>
            <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} disabled={busy}>
              <option value="HIGH">Alta</option><option value="MEDIUM">Media</option><option value="LOW">Baja</option>
            </select>
          </label>
          <label className="bo-form-field"><span>Vence el</span><input type="date" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} disabled={busy} /></label>
          <label className="bo-form-field"><span>Responsable</span><input value={form.assignedToName} onChange={(e) => setForm((f) => ({ ...f, assignedToName: e.target.value }))} disabled={busy} /></label>
        </div>
        <div style={{ marginTop: 8 }}><button type="button" className="primary" disabled={busy} onClick={create}>Crear tarea</button></div>
      </article>

      {tasks.length === 0 ? (
        <EmptyState title="Sin tareas" message="No hay tareas correctivas. Crea una para hacer seguimiento de una acción." />
      ) : (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Tareas</h3><span className="bo-chip">{open.length} abiertas</span></div>
          <div className="bo-stack" style={{ gap: 6 }}>
            {[...open, ...done].map((t) => {
              const overdue = t.status !== "DONE" && t.dueDate && new Date(t.dueDate).getTime() < Date.now();
              return (
                <div key={t.id} className="bo-row" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <StatusChip kind={TASK_STATUS_KIND[t.status] ?? "info"}>{TASK_STATUS_LABEL[t.status] ?? t.status}</StatusChip>
                    <strong style={{ color: "var(--ink)" }}>{t.title}</strong>
                    {t.requirementCode ? <span className="bo-muted" style={{ fontSize: 11 }}>{t.requirementCode}</span> : null}
                    <StatusChip kind={t.priority === "HIGH" ? "error" : t.priority === "LOW" ? "info" : "warn"} style={{ fontSize: 10 }}>{t.priority === "HIGH" ? "Alta" : t.priority === "LOW" ? "Baja" : "Media"}</StatusChip>
                    {t.dueDate ? (overdue ? <StatusChip kind="error" style={{ fontSize: 12 }}>vence {fmtDate(t.dueDate)}</StatusChip> : <span className="bo-muted" style={{ fontSize: 12 }}>vence {fmtDate(t.dueDate)}</span>) : null}
                    {t.assignedToName ? <span className="bo-muted" style={{ fontSize: 12 }}>· {t.assignedToName}</span> : null}
                  </span>
                  <span className="bo-row" style={{ gap: 6 }}>
                    {t.status !== "IN_PROGRESS" && t.status !== "DONE" ? <button type="button" disabled={busy} onClick={() => setStatus(t.id, "IN_PROGRESS")}>Empezar</button> : null}
                    {t.status !== "DONE" ? <button type="button" className="primary" disabled={busy} onClick={() => setStatus(t.id, "DONE")}>Completar</button> : <button type="button" disabled={busy} onClick={() => setStatus(t.id, "OPEN")}>Reabrir</button>}
                    <button type="button" className="bo-link" disabled={busy} onClick={() => remove(t.id)}>Eliminar</button>
                  </span>
                </div>
              );
            })}
          </div>
        </article>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Alertas tab */
function AlertasTab(props: { alertsApi: ReturnType<typeof useApiData<ComplianceAlertsResponse>>; onJump: (code: string) => void }) {
  const { alertsApi, onJump } = props;
  const data = alertsApi.data;
  const alerts = data?.alerts ?? [];
  if (alertsApi.loading && !data) return <LoadingBlock label="Cargando alertas…" />;
  if (alerts.length === 0) return <EmptyState title="Sin alertas" message="No hay obligaciones vencidas, documentos faltantes ni tareas atrasadas. Todo en orden." />;
  return (
    <div className="bo-stack" style={{ gap: 8 }}>
      <div className="bo-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {Object.entries(data?.byKind ?? {}).map(([k, n]) => <span key={k} className="bo-chip">{ALERT_KIND_LABEL[k] ?? k}: {n}</span>)}
      </div>
      {alerts.map((a: ComplianceAlert) => (
        <article key={a.id} className="bo-card" style={{ background: "var(--surface)", padding: "10px 12px" }}>
          <div className="bo-row" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <StatusChip kind={SEVERITY_KIND[a.severity] ?? "info"} style={{ fontSize: 10 }}>{SEVERITY_LABEL[a.severity] ?? a.severity}</StatusChip>
              <span className="bo-chip">{ALERT_KIND_LABEL[a.kind] ?? a.kind}</span>
              <strong style={{ color: "var(--ink)" }}>{a.title}</strong>
              {a.areaName ? <span className="bo-muted" style={{ fontSize: 11 }}>{a.areaName}</span> : null}
            </span>
            {a.requirementCode ? <button type="button" className="bo-link" onClick={() => onJump(a.requirementCode!)}>Ver control →</button> : null}
          </div>
          <p className="bo-muted" style={{ fontSize: 12.5, textTransform: "none", marginTop: 4 }}>{a.detail}</p>
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Asistente tab */
const SUGGESTION_KIND_LABEL: Record<string, string> = {
  MISSING_DOCUMENT: "Falta documento", RENEW: "Renovar", CORRECT: "Corregir", REVIEW: "Revisar"
};
function AsistenteTab(props: {
  assistantApi: ReturnType<typeof useApiData<ComplianceAssistant>>;
  busy: boolean; setBusy: (v: boolean) => void; setMsg: (v: string | null) => void;
  onTaskCreated: () => void; onJump: (code: string) => void;
}) {
  const { assistantApi, busy, setBusy, setMsg, onTaskCreated, onJump } = props;
  const data = assistantApi.data;
  const [createdFor, setCreatedFor] = useState<Set<string>>(new Set());

  async function createTask(s: ComplianceSuggestion) {
    setBusy(true); setMsg(null);
    try {
      await createComplianceTask({ requirementCode: s.requirementCode, title: s.taskTitle, priority: s.taskPriority });
      setCreatedFor((prev) => new Set(prev).add(s.id));
      setMsg(`Tarea creada: ${s.taskTitle}`);
      onTaskCreated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo crear la tarea.");
    } finally { setBusy(false); }
  }

  if (assistantApi.loading && !data) return <LoadingBlock label="Analizando el cumplimiento…" />;
  if (assistantApi.error) return <ErrorState title="No se pudo analizar" message={assistantApi.error} onRetry={assistantApi.refresh} />;
  if (!data) return null;

  return (
    <div className="bo-stack" style={{ gap: 12 }}>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Resumen del asesor</h3>
          <StatusChip kind={data.narrativeSource === "ai" ? "info" : "ok"}>
            {data.narrativeSource === "ai" ? `IA (${data.provider})` : "Resumen por reglas"}
          </StatusChip>
        </div>
        <p style={{ textTransform: "none", lineHeight: 1.5, color: "var(--ink)" }}>{data.narrative}</p>
        {data.narrativeSource === "rules" ? (
          <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
            Resumen generado por reglas a partir de tus datos. Configura un proveedor de IA (AI_PROVIDER) para obtener un análisis redactado por IA. Las acciones de abajo son siempre deterministas y se basan en datos reales.
          </p>
        ) : null}
      </article>

      {data.suggestions.length === 0 ? (
        <EmptyState title="Nada pendiente" message="El asistente no detecta acciones recomendadas ahora mismo." />
      ) : (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Acciones recomendadas</h3><span className="bo-chip">{data.count}</span></div>
          <div className="bo-stack" style={{ gap: 6 }}>
            {data.suggestions.map((s) => {
              const done = createdFor.has(s.id);
              return (
                <div key={s.id} className="bo-row" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                    <StatusChip kind={s.priority === "HIGH" ? "error" : s.priority === "LOW" ? "info" : "warn"} style={{ fontSize: 10 }}>{s.priority === "HIGH" ? "Alta" : s.priority === "LOW" ? "Baja" : "Media"}</StatusChip>
                    <span className="bo-chip" style={{ fontSize: 10 }}>{SUGGESTION_KIND_LABEL[s.kind] ?? s.kind}</span>
                    <span style={{ textTransform: "none" }}>{s.action}</span>
                    <button type="button" className="bo-link" onClick={() => onJump(s.requirementCode)}>ver control →</button>
                  </span>
                  <span>
                    {done
                      ? <StatusChip kind="ok">Tarea creada</StatusChip>
                      : <button type="button" disabled={busy} onClick={() => createTask(s)}>Crear tarea</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </article>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Ajustes tab */
function AjustesTab(props: {
  profile: ComplianceProfile | null;
  kpis: { applicable: number } | undefined;
  busy: boolean; setBusy: (v: boolean) => void; setMsg: (v: string | null) => void;
  onSaved: () => void;
}) {
  const { profile, kpis, busy, setBusy, setMsg, onSaved } = props;
  const [draft, setDraft] = useState<Partial<ComplianceProfile>>({});
  // hydrate draft from profile when it loads / changes
  useEffect(() => {
    if (profile) setDraft({
      autonomousCommunity: profile.autonomousCommunity ?? "", hotelType: profile.hotelType ?? "",
      hasRestaurant: profile.hasRestaurant, hasKitchen: profile.hasKitchen, hasPool: profile.hasPool, hasSpa: profile.hasSpa,
      hasParking: profile.hasParking, hasEvents: profile.hasEvents, hasTerrace: profile.hasTerrace, hasLaundry: profile.hasLaundry,
      buildingProtected: profile.buildingProtected, expiringSoonDays: profile.expiringSoonDays
    });
  }, [profile]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await updateComplianceProfile({
        autonomousCommunity: draft.autonomousCommunity || null,
        hotelType: draft.hotelType || null,
        hasRestaurant: !!draft.hasRestaurant, hasKitchen: !!draft.hasKitchen, hasPool: !!draft.hasPool, hasSpa: !!draft.hasSpa,
        hasParking: !!draft.hasParking, hasEvents: !!draft.hasEvents, hasTerrace: !!draft.hasTerrace, hasLaundry: !!draft.hasLaundry,
        buildingProtected: !!draft.buildingProtected, expiringSoonDays: Number(draft.expiringSoonDays) || 30
      });
      setMsg("Perfil guardado. La matriz se ha recalculado según la plantilla.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo guardar el perfil.");
    } finally { setBusy(false); }
  }

  return (
    <div className="bo-stack" style={{ gap: 12 }}>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Plantilla del establecimiento</h3>{kpis ? <span className="bo-chip">{kpis.applicable} obligaciones aplican</span> : null}</div>
        <p className="bo-muted" style={{ fontSize: 12.5, textTransform: "none", marginTop: -4 }}>
          La comunidad autónoma, el tipo de hotel y los servicios determinan qué obligaciones legales aplican. Al guardar, la matriz se actualiza automáticamente (alta o baja de controles), respetando las marcas manuales de «No aplica».
        </p>
        <div className="bo-grid two" style={{ gap: 10, marginTop: 8 }}>
          <label className="bo-form-field"><span>Comunidad autónoma</span>
            <select value={draft.autonomousCommunity ?? ""} onChange={(e) => setDraft((d) => ({ ...d, autonomousCommunity: e.target.value }))} disabled={busy}>
              <option value="">— Sin definir —</option>
              {COMUNIDADES.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
            </select>
          </label>
          <label className="bo-form-field"><span>Tipo de establecimiento</span>
            <select value={draft.hotelType ?? ""} onChange={(e) => setDraft((d) => ({ ...d, hotelType: e.target.value }))} disabled={busy}>
              <option value="">— Sin definir —</option>
              {HOTEL_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
          </label>
          <label className="bo-form-field"><span>Aviso de caducidad (días)</span>
            <input type="number" min={1} max={365} value={draft.expiringSoonDays ?? 30} onChange={(e) => setDraft((d) => ({ ...d, expiringSoonDays: Number(e.target.value) }))} disabled={busy} />
          </label>
        </div>
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Servicios e instalaciones</h3></div>
        <div className="bo-row" style={{ gap: 10, flexWrap: "wrap" }}>
          {PROFILE_FEATURES.map((f) => (
            <label key={f.k} className="bo-row" style={{ gap: 6, alignItems: "center", fontSize: 13, border: "1px solid var(--line-soft)", borderRadius: 999, padding: "6px 12px", cursor: busy ? "default" : "pointer" }}>
              <input type="checkbox" checked={!!draft[f.k]} onChange={(e) => setDraft((d) => ({ ...d, [f.k]: e.target.checked }))} disabled={busy} />
              {f.l}
            </label>
          ))}
        </div>
        <p className="bo-muted" style={{ fontSize: 11, textTransform: "none", marginTop: 8 }}>Ej.: «Cocina propia» activa los controles de APPCC y alérgenos; «Piscina» activa el control sanitario de piscina; «Edificio protegido» activa la autorización de patrimonio.</p>
      </article>

      <div><button type="button" className="primary" disabled={busy} onClick={save}>Guardar plantilla y recalcular</button></div>
    </div>
  );
}
