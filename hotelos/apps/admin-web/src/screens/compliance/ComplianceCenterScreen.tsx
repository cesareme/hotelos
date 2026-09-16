// Centro de cumplimiento — Cumplimiento › Centro de cumplimiento
// (/cumplimiento/centro, standalone). Cocoa 22 · ola 8 · lote 8-A, archetype
// «dashboard» (docs/design/COCOA-22.md §4, plantilla DashboardStandalone).
//
// One page over the real compliance endpoints (center · tasks · documents ·
// alerts; the assistant only while its view is open): a KPI strip, a segmented
// control with six views (matriz · documentos · tareas · alertas · asistente ·
// ajustes) and, in the matrix, the table per area, the filter toolbar and the
// table of controls whose row opens the control record in a CocoaDrawer
// (status, responsible, expiry, notes and the documents that justify it).
// Every call and every business message of the legacy screen survives; only
// the paint changed (0 `.bo-*`, 0 raw controls, no emoji).

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
  type ComplianceAlert,
  type ComplianceAlertsResponse,
  type ComplianceAreaSummary,
  type ComplianceAssistant,
  type ComplianceCenter,
  type ComplianceControl,
  type ComplianceDocument,
  type ComplianceProfile,
  type ComplianceStatus,
  type ComplianceSuggestion,
  type ComplianceTask
} from "../../services/complianceApi";
import { toArray } from "../../utils/toArray";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance";
import { date, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  formatFileSize,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

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

// ----------------------------------------------------------------- labels and tones

const STATUS_LABEL: Record<ComplianceStatus, string> = {
  COMPLIANT: "Cumple", NON_COMPLIANT: "No cumple", PENDING: "Pendiente", EXPIRED: "Vencido",
  EXPIRING_SOON: "Vence pronto", NOT_APPLICABLE: "No aplica", UNDER_REVIEW: "En revisión"
};
const STATUS_TONE: Record<ComplianceStatus, CocoaTone> = {
  COMPLIANT: "success", NON_COMPLIANT: "danger", PENDING: "warning", EXPIRED: "danger",
  EXPIRING_SOON: "warning", NOT_APPLICABLE: "neutral", UNDER_REVIEW: "info"
};
const RISK_LABEL: Record<string, string> = { CRITICAL: "Crítico", HIGH: "Alto", MEDIUM: "Medio", LOW: "Bajo" };
const RISK_TONE: Record<string, CocoaTone> = { CRITICAL: "danger", HIGH: "warning", MEDIUM: "info", LOW: "success" };
const EDITABLE_STATUS_OPTIONS = [
  { value: "COMPLIANT", label: "Cumple" }, { value: "PENDING", label: "Pendiente" }, { value: "NON_COMPLIANT", label: "No cumple" }, { value: "UNDER_REVIEW", label: "En revisión" }
];
const ALERT_KIND_LABEL: Record<string, string> = {
  EXPIRED: "Vencido", EXPIRING_SOON: "Vence pronto", NON_COMPLIANT: "No cumple", MISSING_DOCUMENT: "Falta documento", TASK_OVERDUE: "Tarea vencida"
};
const SEVERITY_TONE: Record<string, CocoaTone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "info" };
const SEVERITY_LABEL: Record<string, string> = { CRITICAL: "Crítico", HIGH: "Alto", MEDIUM: "Medio", LOW: "Bajo" };
const TASK_STATUS_LABEL: Record<string, string> = { OPEN: "Abierta", IN_PROGRESS: "En curso", DONE: "Hecha" };
const TASK_STATUS_TONE: Record<string, CocoaTone> = { OPEN: "warning", IN_PROGRESS: "info", DONE: "success" };
const PRIORITY_LABEL: Record<string, string> = { HIGH: "Alta", MEDIUM: "Media", LOW: "Baja" };
const PRIORITY_TONE: Record<string, CocoaTone> = { HIGH: "danger", MEDIUM: "warning", LOW: "info" };
const PRIORITY_OPTIONS = [
  { value: "HIGH", label: "Alta" }, { value: "MEDIUM", label: "Media" }, { value: "LOW", label: "Baja" }
];
const JURISDICTION_LABEL: Record<string, string> = { STATE: "Estatal", AUTONOMOUS_COMMUNITY: "Autonómica", MUNICIPAL: "Municipal" };
const SUGGESTION_KIND_LABEL: Record<string, string> = {
  MISSING_DOCUMENT: "Falta documento", RENEW: "Renovar", CORRECT: "Corregir", REVIEW: "Revisar"
};
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
const COMUNIDAD_OPTIONS = [{ value: "", label: "Sin definir" }, ...COMUNIDADES.map((c) => ({ value: c.v, label: c.l }))];
const HOTEL_TYPE_OPTIONS = [{ value: "", label: "Sin definir" }, ...HOTEL_TYPES.map((t) => ({ value: t.v, label: t.l }))];
const RISK_FILTER_OPTIONS = [
  { value: "all", label: "Cualquier riesgo" }, { value: "CRITICAL", label: "Crítico" }, { value: "HIGH", label: "Alto" }, { value: "MEDIUM", label: "Medio" }, { value: "LOW", label: "Bajo" }
];
const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "Cualquier estado" },
  ...(Object.keys(STATUS_LABEL) as ComplianceStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))
];

function fmtDate(v?: string | null): string {
  return date(v, "medium");
}
function isPast(v?: string | null): boolean {
  return Boolean(v) && new Date(v as string).getTime() < Date.now();
}

// ----------------------------------------------------------------- notices

// One inline notice for the whole page (the legacy `msg`): success after a
// save, danger after a failed call, info for the assistant's hints.
type NoticeTone = "success" | "danger" | "info";
type Notice = { text: string; tone: NoticeTone };
type Notify = (text: string | null, tone?: NoticeTone) => void;

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

// ----------------------------------------------------------------- views

type Tab = "matriz" | "documentos" | "tareas" | "alertas" | "asistente" | "ajustes";
const TAB_OPTIONS: { value: Tab; label: string }[] = [
  { value: "matriz", label: "Matriz" },
  { value: "documentos", label: "Documentos" },
  { value: "tareas", label: "Tareas" },
  { value: "alertas", label: "Alertas" },
  { value: "asistente", label: "Asistente IA" },
  { value: "ajustes", label: "Ajustes" }
];
const TAB_LABEL: Record<Tab, string> = Object.fromEntries(TAB_OPTIONS.map((t) => [t.value, t.label])) as Record<Tab, string>;
const PANEL_ID = "compliance-center-panel";

type ControlDraft = { status: string; responsibleName: string; expiryDate: string; notes: string };
type DocDraft = { title: string; documentType: string; issueDate: string; expiryDate: string; fileName: string; mimeType: string; fileSize: number };

const EMPTY_DOC: DocDraft = { title: "", documentType: "", issueDate: "", expiryDate: "", fileName: "", mimeType: "", fileSize: 0 };

// ----------------------------------------------------------------- columns

const AREA_COLUMNS: CocoaTableColumn<ComplianceAreaSummary>[] = [
  { key: "name", label: "Área", minWidth: 160, render: (a) => <strong>{a.name}</strong> },
  { key: "compliant", label: "Cumplidos", align: "right", fit: true, render: (a) => `${number(a.compliant)} de ${number(a.total)}` },
  { key: "pending", label: "Pendientes", align: "right", fit: true, render: (a) => (a.pending ? number(a.pending) : "—") },
  {
    key: "expiringSoon",
    label: "Vencen pronto",
    align: "right",
    fit: true,
    showFrom: "tablet",
    render: (a) => (a.expiringSoon ? <CocoaBadge tone="warning" size="small">{number(a.expiringSoon)}</CocoaBadge> : "—")
  },
  { key: "expired", label: "Vencidos", align: "right", fit: true, render: (a) => (a.expired ? <CocoaBadge tone="danger" size="small">{number(a.expired)}</CocoaBadge> : "—") },
  {
    key: "nonCompliant",
    label: "No cumple",
    align: "right",
    fit: true,
    showFrom: "laptop",
    render: (a) => (a.nonCompliant ? <CocoaBadge tone="danger" size="small">{number(a.nonCompliant)}</CocoaBadge> : "—")
  },
  { key: "critical", label: "Críticos", align: "right", fit: true, showFrom: "laptop", render: (a) => (a.critical ? <CocoaBadge tone="danger" size="small">{number(a.critical)}</CocoaBadge> : "—") }
];

const CONTROL_COLUMNS: CocoaTableColumn<ComplianceControl>[] = [
  { key: "code", label: "Código", fit: true, render: (c) => <span className="cocoa-mono">{c.code}</span> },
  {
    key: "title",
    label: "Control",
    minWidth: 240,
    render: (c) => (
      <>
        <strong>{c.title}</strong>
        <span className="cocoa-note">
          {c.areaName}
          {c.autonomousCommunity ? ` · ${COMUNIDAD_LABEL[c.autonomousCommunity] ?? c.autonomousCommunity}` : ""}
          {c.documentsCount > 0 ? ` · ${plural(c.documentsCount, "documento", "documentos")}` : ""}
        </span>
      </>
    )
  },
  { key: "riskLevel", label: "Riesgo", fit: true, hideOnNarrow: true, render: (c) => <CocoaBadge tone={RISK_TONE[c.riskLevel]} size="small">{RISK_LABEL[c.riskLevel]}</CocoaBadge> },
  { key: "expiryDate", label: "Vence", fit: true, showFrom: "tablet", render: (c) => (c.expiryDate ? fmtDate(c.expiryDate) : "—") },
  { key: "status", label: "Estado", fit: true, render: (c) => <CocoaBadge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</CocoaBadge> }
];

const TASK_COLUMNS: CocoaTableColumn<ComplianceTask>[] = [
  { key: "status", label: "Estado", fit: true, render: (t) => <CocoaBadge tone={TASK_STATUS_TONE[t.status] ?? "info"}>{TASK_STATUS_LABEL[t.status] ?? t.status}</CocoaBadge> },
  {
    key: "title",
    label: "Tarea",
    minWidth: 220,
    render: (t) => (
      <>
        <strong>{t.title}</strong>
        {t.requirementCode ? <span className="cocoa-note">{t.requirementCode}</span> : null}
      </>
    )
  },
  { key: "priority", label: "Prioridad", fit: true, hideOnNarrow: true, render: (t) => <CocoaBadge tone={PRIORITY_TONE[t.priority] ?? "warning"} size="small">{PRIORITY_LABEL[t.priority] ?? "Media"}</CocoaBadge> },
  {
    key: "dueDate",
    label: "Vence",
    fit: true,
    showFrom: "tablet",
    render: (t) => (t.dueDate ? (t.status !== "DONE" && isPast(t.dueDate) ? <CocoaBadge tone="danger">{fmtDate(t.dueDate)}</CocoaBadge> : fmtDate(t.dueDate)) : "—")
  },
  { key: "assignedToName", label: "Responsable", showFrom: "laptop", render: (t) => t.assignedToName ?? "—" }
];

const ALERT_COLUMNS: CocoaTableColumn<ComplianceAlert>[] = [
  { key: "severity", label: "Gravedad", fit: true, render: (a) => <CocoaBadge tone={SEVERITY_TONE[a.severity] ?? "info"} size="small">{SEVERITY_LABEL[a.severity] ?? a.severity}</CocoaBadge> },
  { key: "kind", label: "Tipo", fit: true, hideOnNarrow: true, render: (a) => <CocoaBadge tone="neutral" size="small">{ALERT_KIND_LABEL[a.kind] ?? a.kind}</CocoaBadge> },
  {
    key: "title",
    label: "Alerta",
    minWidth: 240,
    render: (a) => (
      <>
        <strong>{a.title}</strong>
        <span className="cocoa-note">{a.detail}</span>
      </>
    )
  },
  { key: "areaName", label: "Área", showFrom: "laptop", render: (a) => a.areaName ?? "—" }
];

const SUGGESTION_COLUMNS: CocoaTableColumn<ComplianceSuggestion>[] = [
  { key: "priority", label: "Prioridad", fit: true, render: (s) => <CocoaBadge tone={PRIORITY_TONE[s.priority] ?? "warning"} size="small">{PRIORITY_LABEL[s.priority] ?? "Media"}</CocoaBadge> },
  { key: "kind", label: "Tipo", fit: true, hideOnNarrow: true, render: (s) => <CocoaBadge tone="neutral" size="small">{SUGGESTION_KIND_LABEL[s.kind] ?? s.kind}</CocoaBadge> },
  {
    key: "action",
    label: "Acción recomendada",
    minWidth: 240,
    render: (s) => (
      <>
        <span>{s.action}</span>
        <span className="cocoa-note">
          {s.requirementCode} · {s.controlTitle}
        </span>
      </>
    )
  }
];

// ----------------------------------------------------------------- skeleton

function ComplianceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton variant="row" />
      <CocoaSkeleton variant="card" height={320} />
    </div>
  );
}

// ----------------------------------------------------------------- page

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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState<ControlDraft>({ status: "", responsibleName: "", expiryDate: "", notes: "" });

  // documents associated to the currently-open control record
  const [fichaDocs, setFichaDocs] = useState<ComplianceDocument[]>([]);
  const [fichaDocsLoading, setFichaDocsLoading] = useState(false);
  const [docForm, setDocForm] = useState<DocDraft>(EMPTY_DOC);

  const notify: Notify = (text, tone = "success") => setNotice(text ? { text, tone } : null);

  const kpis = data?.kpis;
  const areas = useMemo(() => toArray<ComplianceAreaSummary>(data?.areas), [data]);
  const controls = useMemo(() => toArray<ComplianceControl>(data?.controls), [data]);
  const tasks = useMemo(() => toArray<ComplianceTask>(tasksApi.data), [tasksApi.data]);
  const allDocs = useMemo(() => toArray<ComplianceDocument>(docsApi.data?.items), [docsApi.data]);
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
    setOpenCode(c.code);
    setNotice(null);
    setDraft({
      status: ["COMPLIANT", "PENDING", "NON_COMPLIANT", "UNDER_REVIEW"].includes(c.status) ? c.status : "PENDING",
      responsibleName: c.responsibleName ?? "",
      expiryDate: c.expiryDate ? c.expiryDate.slice(0, 10) : "",
      notes: c.notes ?? ""
    });
    setDocForm({ ...EMPTY_DOC, documentType: c.requiredDocuments[0] ?? "" });
    void loadFichaDocs(c.code);
  }

  async function saveItem(c: ComplianceControl, patch: Record<string, unknown>, ok: string) {
    setBusy(true); setNotice(null);
    try {
      await updateComplianceItem(c.code, patch);
      notify(ok);
      refresh(); alertsApi.refresh();
    } catch (e) {
      notify(errorText(e, "No se pudo guardar."), "danger");
    } finally {
      setBusy(false);
    }
  }

  async function addDocToControl(c: ComplianceControl) {
    if (!docForm.title.trim()) { notify("Indica un título para el documento.", "danger"); return; }
    setBusy(true); setNotice(null);
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
      notify("Documento registrado. El control se actualizó con su fecha de caducidad.");
      setDocForm({ ...EMPTY_DOC, documentType: c.requiredDocuments[0] ?? "" });
      await loadFichaDocs(c.code);
      refresh(); docsApi.refresh(); alertsApi.refresh();
    } catch (e) {
      notify(errorText(e, "No se pudo registrar el documento."), "danger");
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc(id: string, code?: string) {
    setBusy(true); setNotice(null);
    try {
      await deleteComplianceDocument(id);
      notify("Documento eliminado.");
      if (code) await loadFichaDocs(code);
      refresh(); docsApi.refresh(); alertsApi.refresh();
    } catch (e) {
      notify(errorText(e, "No se pudo eliminar."), "danger");
    } finally {
      setBusy(false);
    }
  }

  const alertCount = alerts?.count ?? 0;
  const openTaskCount = tasks.filter((t) => t.status !== "DONE").length;

  async function exportFolder() {
    setBusy(true); setNotice(null);
    try {
      const folder = await fetchInspectionFolder();
      const blob = new Blob([folder.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = folder.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`Carpeta de inspección generada (${plural(folder.summary.applicable, "obligación", "obligaciones")}, ${plural(folder.summary.documents, "documento", "documentos")}). Ábrela e imprime a PDF.`);
    } catch (e) {
      notify(errorText(e, "No se pudo generar la carpeta."), "danger");
    } finally {
      setBusy(false);
    }
  }

  function refreshAll() {
    refresh(); tasksApi.refresh(); docsApi.refresh(); alertsApi.refresh();
  }

  const jump = (code: string) => { setTab("matriz"); setStatus("all"); setArea("all"); setQuery(code); };

  // Count badge next to the segmented control (what the current view holds).
  const tabBadge =
    tab === "matriz" && kpis ? <CocoaBadge tone="info" size="small">{plural(kpis.applicable, "control", "controles")}</CocoaBadge>
    : tab === "documentos" ? <CocoaBadge tone="info" size="small">{plural(allDocs.length, "documento", "documentos")}</CocoaBadge>
    : tab === "tareas" && openTaskCount > 0 ? <CocoaBadge tone="warning" size="small">{plural(openTaskCount, "abierta", "abiertas")}</CocoaBadge>
    : tab === "alertas" && alertCount > 0 ? <CocoaBadge tone="danger" size="small">{plural(alertCount, "alerta", "alertas")}</CocoaBadge>
    : null;

  return (
    <CocoaPage
      eyebrow="Cumplimiento"
      title="Centro de cumplimiento"
      subtitle="Qué obligaciones legales aplican a este hotel, qué documento las justifica, cuándo vencen, quién es responsable y qué riesgo hay si no se cumplen."
      actions={
        <>
          <CocoaButton variant="filled" tone="accent" onClick={() => void exportFolder()} disabled={busy || loading} loading={busy}>
            Carpeta de inspección
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" onClick={refreshAll} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<ComplianceSkeleton />}
      error={{ title: "No se pudo cargar", message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "compliance-center-folder", label: "Generar la carpeta de inspección", run: () => void exportFolder() },
        { id: "compliance-center-refresh", label: "Actualizar el centro de cumplimiento", run: refreshAll }
      ]}
    >
      <CocoaScreenInstructionsCard
        title={COMPLIANCE_INSTRUCTIONS.title}
        description={COMPLIANCE_INSTRUCTIONS.description}
        steps={COMPLIANCE_INSTRUCTIONS.steps}
        tip={COMPLIANCE_INSTRUCTIONS.tip}
        dismissible
        persistKey="compliance"
      />

      {notice ? (
        <CocoaCallout
          tone={notice.tone}
          role={notice.tone === "danger" ? "alert" : "status"}
          actions={
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setNotice(null)}>
              {ACTIONS.close}
            </CocoaButton>
          }
        >
          {notice.text}
        </CocoaCallout>
      ) : null}

      {error && data ? (
        <CocoaCallout tone="danger" title="No se pudo actualizar" role="alert" actions={<CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>{ACTIONS.retry}</CocoaButton>}>
          {error}
        </CocoaCallout>
      ) : null}

      {kpis ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de cumplimiento">
            <CocoaKpi
              label="Cumplimiento"
              value={percent(kpis.compliancePct)}
              caption={`${number(kpis.compliant)} de ${plural(kpis.applicable, "obligación", "obligaciones")}`}
              polarity="neutral"
              status={kpis.compliancePct >= 80 ? "ok" : kpis.compliancePct >= 50 ? "warning" : "critical"}
            />
            <CocoaKpi label="Críticos abiertos" value={number(kpis.criticalOpen)} caption={kpis.criticalOpen > 0 ? "con riesgo" : "sin riesgo"} polarity="neutral" status={kpis.criticalOpen > 0 ? "critical" : "ok"} />
            <CocoaKpi label="Vencidos" value={number(kpis.expired)} caption={kpis.expired > 0 ? "por renovar" : "ninguno"} polarity="neutral" status={kpis.expired > 0 ? "critical" : "ok"} />
            <CocoaKpi label="Vencen pronto" value={number(kpis.expiringSoon)} caption="en 30 días o menos" polarity="neutral" status={kpis.expiringSoon > 0 ? "warning" : "ok"} />
            <CocoaKpi
              label="Pendientes o no cumplen"
              value={number(kpis.pending + kpis.nonCompliant)}
              caption={`${number(kpis.nonCompliant)} no cumplen`}
              polarity="neutral"
              status={kpis.nonCompliant + kpis.pending > 0 ? "warning" : "ok"}
            />
          </CocoaKpiStrip>

          <div className="cocoa-row" data-gap="2">
            <CocoaSegmentedControl value={tab} onChange={(v) => setTab(v as Tab)} options={TAB_OPTIONS} aria-label="Secciones del centro de cumplimiento" panelId={PANEL_ID} />
            {tabBadge}
          </div>

          <div id={PANEL_ID} role="tabpanel" aria-label={TAB_LABEL[tab]} className="cocoa-stack" data-gap="4">
            {tab === "matriz" ? (
              <MatrizTab
                areas={areas} visible={visible} controls={controls}
                area={area} setArea={setArea} risk={risk} setRisk={setRisk} status={status} setStatus={setStatus} query={query} setQuery={setQuery}
                openCode={openCode} openFicha={openFicha} closeFicha={() => setOpenCode(null)} draft={draft} setDraft={setDraft} busy={busy} saveItem={saveItem}
                fichaDocs={fichaDocs} fichaDocsLoading={fichaDocsLoading} docForm={docForm} setDocForm={setDocForm} addDocToControl={addDocToControl} removeDoc={removeDoc}
                onPickArea={(code) => { setArea(code); setOpenCode(null); }}
              />
            ) : tab === "documentos" ? (
              <DocumentosTab docsApi={docsApi} docs={allDocs} controls={controls} onChanged={() => { refresh(); alertsApi.refresh(); }} setBusy={setBusy} notify={notify} busy={busy} removeDoc={removeDoc} />
            ) : tab === "tareas" ? (
              <TareasTab tasksApi={tasksApi} tasks={tasks} controls={controls} onChanged={() => alertsApi.refresh()} setBusy={setBusy} notify={notify} busy={busy} />
            ) : tab === "alertas" ? (
              <AlertasTab alertsApi={alertsApi} onJump={jump} />
            ) : tab === "asistente" ? (
              <AsistenteTab assistantApi={assistantApi} busy={busy} setBusy={setBusy} notify={notify} onTaskCreated={() => { tasksApi.refresh(); }} onJump={jump} />
            ) : (
              <AjustesTab profile={data?.profile ?? null} kpis={kpis} busy={busy} setBusy={setBusy} notify={notify} onSaved={() => { refresh(); alertsApi.refresh(); docsApi.refresh(); }} />
            )}
          </div>
        </>
      ) : null}
    </CocoaPage>
  );
}

/* ---------------------------------------------------------------- Matriz tab */
function MatrizTab(props: {
  areas: ComplianceAreaSummary[]; visible: ComplianceControl[]; controls: ComplianceControl[];
  area: string; setArea: (v: string) => void; risk: string; setRisk: (v: string) => void; status: string; setStatus: (v: string) => void; query: string; setQuery: (v: string) => void;
  openCode: string | null; openFicha: (c: ComplianceControl) => void; closeFicha: () => void; draft: ControlDraft; setDraft: React.Dispatch<React.SetStateAction<ControlDraft>>; busy: boolean; saveItem: (c: ComplianceControl, patch: Record<string, unknown>, ok: string) => void;
  fichaDocs: ComplianceDocument[]; fichaDocsLoading: boolean; docForm: DocDraft; setDocForm: React.Dispatch<React.SetStateAction<DocDraft>>; addDocToControl: (c: ComplianceControl) => void; removeDoc: (id: string, code?: string) => void;
  onPickArea: (code: string) => void;
}) {
  const { areas, visible, controls, area, setArea, risk, setRisk, status, setStatus, query, setQuery, openCode, openFicha, closeFicha, draft, setDraft, busy, saveItem, fichaDocs, fichaDocsLoading, docForm, setDocForm, addDocToControl, removeDoc, onPickArea } = props;
  const open = openCode ? controls.find((c) => c.code === openCode) ?? null : null;
  const areaOptions = useMemo(() => [{ value: "all", label: "Todas las áreas" }, ...areas.map((a) => ({ value: a.code, label: a.name }))], [areas]);
  const filtered = area !== "all" || risk !== "all" || status !== "all" || query.trim() !== "";

  return (
    <>
      <CocoaSection title="Por área" meta={plural(areas.length, "área", "áreas")} padding="none" style={{ overflow: "clip" }}>
        <CocoaTable
          columns={AREA_COLUMNS}
          rows={areas}
          rowKey="code"
          density="compact"
          onSelect={(a) => onPickArea(a.code)}
          selectedKey={area !== "all" ? area : undefined}
          rowTitle={() => "Filtrar la matriz por esta área"}
          caption="Cumplimiento por área"
          aria-label="Cumplimiento por área"
        />
      </CocoaSection>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de la matriz"
        leftSlot={<CocoaSearchInput value={query} onChange={setQuery} placeholder="Buscar control…" aria-label="Buscar control por código, título o área" />}
        rightSlot={
          <>
            <CocoaSelect inline value={area} onChange={setArea} options={areaOptions} aria-label="Filtrar por área" />
            <CocoaSelect inline value={risk} onChange={setRisk} options={RISK_FILTER_OPTIONS} aria-label="Filtrar por riesgo" />
            <CocoaSelect inline value={status} onChange={setStatus} options={STATUS_FILTER_OPTIONS} aria-label="Filtrar por estado" />
          </>
        }
      />

      <CocoaSection
        padding={visible.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        aria-label="Controles de la matriz"
        footer={visible.length > 0 ? <span>{plural(visible.length, "control", "controles")}</span> : undefined}
      >
        {visible.length === 0 ? (
          <CocoaState kind="empty" illustration={filtered ? "search" : "box"} title="Sin controles" message="No hay controles que coincidan con los filtros." />
        ) : (
          <CocoaTable
            columns={CONTROL_COLUMNS}
            rows={visible}
            rowKey="code"
            selectedKey={openCode ?? undefined}
            onSelect={openFicha}
            rowTone={(c) => (c.status === "EXPIRED" || c.status === "NON_COMPLIANT" ? "danger" : c.status === "EXPIRING_SOON" ? "warning" : undefined)}
            rowTitle={() => "Abrir la ficha del control"}
            caption="Controles de la matriz"
            aria-label="Controles de la matriz"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={open !== null}
        onClose={closeFicha}
        title={open ? `${open.code} · ${open.title}` : "Control"}
        subtitle={open ? `${open.areaName} · ${JURISDICTION_LABEL[open.jurisdiction] ?? "Interna"}${open.legalReference ? ` · ${open.legalReference}` : ""}` : undefined}
        side="right"
        size="lg"
        focusKey={open?.code}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeFicha}>
              {ACTIONS.close}
            </CocoaButton>
            {open?.applies ? (
              <CocoaButton
                variant="filled"
                tone="accent"
                disabled={busy}
                loading={busy}
                onClick={() => saveItem(open, { status: draft.status, responsibleName: draft.responsibleName || null, expiryDate: draft.expiryDate || null, notes: draft.notes || null }, "Control actualizado.")}
              >
                {ACTIONS.save}
              </CocoaButton>
            ) : open ? (
              <CocoaButton variant="filled" tone="accent" disabled={busy} loading={busy} onClick={() => saveItem(open, { applies: true, status: "PENDING" }, "Reactivado como pendiente.")}>
                Marcar que aplica
              </CocoaButton>
            ) : null}
          </>
        }
      >
        {open ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-cluster">
              <CocoaBadge tone={STATUS_TONE[open.status]}>{STATUS_LABEL[open.status]}</CocoaBadge>
              <CocoaBadge tone={RISK_TONE[open.riskLevel]} size="small">{RISK_LABEL[open.riskLevel]}</CocoaBadge>
              {open.autonomousCommunity ? <CocoaBadge tone="neutral" size="small">{COMUNIDAD_LABEL[open.autonomousCommunity] ?? open.autonomousCommunity}</CocoaBadge> : null}
              {open.appliesWhen ? <span className="cocoa-note">{open.appliesWhen}</span> : null}
            </div>
            {open.requiredDocuments.length ? (
              <p className="cocoa-note">
                <strong>Documentos requeridos:</strong> {open.requiredDocuments.join(", ")}
              </p>
            ) : null}

            {open.applies ? (
              <>
                <CocoaFormSection
                  title="Estado del control"
                  description="Estado, responsable, fecha de vencimiento y notas internas del control."
                  actions={
                    <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => saveItem(open, { applies: false, notApplicableReason: "Marcado manualmente" }, "Marcado como no aplica.")}>
                      No aplica
                    </CocoaButton>
                  }
                >
                  <CocoaFormRow columns={2}>
                    <CocoaField label="Estado">
                      <CocoaSelect value={draft.status} onChange={(v) => setDraft((d) => ({ ...d, status: v }))} options={EDITABLE_STATUS_OPTIONS} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Responsable">
                      <CocoaInput value={draft.responsibleName} onChange={(v) => setDraft((d) => ({ ...d, responsibleName: v }))} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Vence el">
                      <CocoaDatePicker value={draft.expiryDate} onChange={(v) => setDraft((d) => ({ ...d, expiryDate: v }))} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Notas">
                      <CocoaInput value={draft.notes} onChange={(v) => setDraft((d) => ({ ...d, notes: v }))} disabled={busy} />
                    </CocoaField>
                  </CocoaFormRow>
                </CocoaFormSection>

                <CocoaSection title="Documentos que lo justifican" meta={plural(fichaDocs.length, "documento", "documentos")}>
                  {fichaDocsLoading ? (
                    <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
                  ) : fichaDocs.length === 0 ? (
                    <CocoaState kind="empty" inline title="Aún no hay documentos cargados para este control." />
                  ) : (
                    <ul className="c22-section__list" aria-label="Documentos del control">
                      {fichaDocs.map((d) => (
                        <li key={d.id}>
                          <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <strong>{d.title}</strong>
                            {d.fileName && d.fileName !== d.title ? ` · ${d.fileName}` : ""}
                            {d.fileSize ? ` · ${formatFileSize(d.fileSize)}` : ""}
                          </span>
                          {d.expiryDate ? <span className="cocoa-note">vence {fmtDate(d.expiryDate)}</span> : null}
                          <CocoaButton variant="plain" tone="destructive" size="small" disabled={busy} onClick={() => removeDoc(d.id, open.code)}>
                            {ACTIONS.delete}
                          </CocoaButton>
                        </li>
                      ))}
                    </ul>
                  )}
                  <CocoaFormRow columns={2}>
                    <CocoaField label="Título del documento" required>
                      <CocoaInput value={docForm.title} onChange={(v) => setDocForm((f) => ({ ...f, title: v }))} placeholder="p. ej. Licencia de apertura 2026" disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Tipo">
                      <CocoaInput value={docForm.documentType} onChange={(v) => setDocForm((f) => ({ ...f, documentType: v }))} suggestions={open.requiredDocuments} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Fecha de emisión">
                      <CocoaDatePicker value={docForm.issueDate} onChange={(v) => setDocForm((f) => ({ ...f, issueDate: v }))} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Fecha de caducidad">
                      <CocoaDatePicker value={docForm.expiryDate} onChange={(v) => setDocForm((f) => ({ ...f, expiryDate: v }))} disabled={busy} />
                    </CocoaField>
                  </CocoaFormRow>
                  <div className="cocoa-row" data-gap="2">
                    <CocoaFileInput
                      label="Archivo (opcional)"
                      fileName={docForm.fileName || null}
                      disabled={busy}
                      onPick={(f) => setDocForm((s) => ({ ...s, fileName: f.name, mimeType: f.type, fileSize: f.size, title: s.title || f.name }))}
                    />
                    <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} onClick={() => addDocToControl(open)}>
                      Registrar documento
                    </CocoaButton>
                  </div>
                  <p className="cocoa-note">
                    Se registra la referencia del documento (nombre, tipo y fechas) y, si añades fecha de caducidad, el control pasa a «Cumple» con esa fecha. El archivo se conserva en tu gestor documental.
                  </p>
                </CocoaSection>
              </>
            ) : (
              <CocoaCallout tone="neutral" title="No aplica a este establecimiento">
                Marcado como no aplicable{open.notApplicableReason ? `: ${open.notApplicableReason}` : ""}.
              </CocoaCallout>
            )}
          </div>
        ) : null}
      </CocoaDrawer>
    </>
  );
}

/* ----------------------------------------------------------- Documentos tab */
function DocumentosTab(props: {
  docsApi: ReturnType<typeof useApiData<{ items: ComplianceDocument[] }>>;
  docs: ComplianceDocument[];
  controls: ComplianceControl[];
  onChanged: () => void; setBusy: (v: boolean) => void; notify: Notify; busy: boolean;
  removeDoc: (id: string, code?: string) => void;
}) {
  const { docsApi, docs, controls, onChanged, setBusy, notify, busy, removeDoc } = props;
  const [form, setForm] = useState<{ requirementCode: string; title: string; documentType: string; issueDate: string; expiryDate: string; issuingAuthority: string; fileName: string; mimeType: string; fileSize: number }>({ requirementCode: "", title: "", documentType: "", issueDate: "", expiryDate: "", issuingAuthority: "", fileName: "", mimeType: "", fileSize: 0 });
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const codeToTitle = useMemo(() => new Map(controls.map((c) => [c.code, c.title])), [controls]);
  const controlOptions = useMemo(
    () => [{ value: "", label: "Sin asociar / general" }, ...controls.filter((c) => c.applies).map((c) => ({ value: c.code, label: `${c.code} · ${c.title}` }))],
    [controls]
  );

  const columns = useMemo<CocoaTableColumn<ComplianceDocument>[]>(
    () => [
      {
        key: "title",
        label: "Documento",
        minWidth: 200,
        render: (d) => {
          const meta = [d.documentType, d.fileSize ? formatFileSize(d.fileSize) : null].filter(Boolean).join(" · ");
          return (
            <>
              <strong>{d.title}</strong>
              {meta ? <span className="cocoa-note">{meta}</span> : null}
            </>
          );
        }
      },
      {
        key: "control",
        label: "Control",
        showFrom: "tablet",
        render: (d) => (d.requirementCode ? `${d.requirementCode}${codeToTitle.get(d.requirementCode) ? ` · ${codeToTitle.get(d.requirementCode)}` : ""}` : "—")
      },
      { key: "issueDate", label: "Emisión", fit: true, showFrom: "laptop", render: (d) => fmtDate(d.issueDate) },
      {
        key: "expiryDate",
        label: "Caducidad",
        fit: true,
        render: (d) => (d.expiryDate ? (isPast(d.expiryDate) ? <CocoaBadge tone="danger">{fmtDate(d.expiryDate)}</CocoaBadge> : fmtDate(d.expiryDate)) : "—")
      }
    ],
    [codeToTitle]
  );

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
    setOcrBusy(true); notify(null);
    try {
      const res = await extractDocumentDates(imageDataUrl);
      if (!res.aiGenerated) {
        notify("IA no configurada: introduce las fechas manualmente (configura AI_PROVIDER para activar la lectura automática).", "info");
      } else {
        setForm((s) => ({
          ...s,
          documentType: res.fields.documentType || s.documentType,
          issuingAuthority: res.fields.issuingAuthority || s.issuingAuthority,
          issueDate: res.fields.issueDate || s.issueDate,
          expiryDate: res.fields.expiryDate || s.expiryDate
        }));
        notify(`IA (${res.provider}): datos leídos del documento. Revísalos antes de guardar.`, "info");
      }
    } catch (e) {
      notify(errorText(e, "No se pudo leer el documento."), "danger");
    } finally { setOcrBusy(false); }
  }

  useEffect(() => { docsApi.refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function submit() {
    if (!form.title.trim()) { notify("Indica un título para el documento.", "danger"); return; }
    setBusy(true); notify(null);
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
      notify("Documento registrado.");
      setForm({ requirementCode: "", title: "", documentType: "", issueDate: "", expiryDate: "", issuingAuthority: "", fileName: "", mimeType: "", fileSize: 0 });
      setImageDataUrl(null);
      docsApi.refresh(); onChanged();
    } catch (e) {
      notify(errorText(e, "No se pudo registrar."), "danger");
    } finally { setBusy(false); }
  }

  const loadingDocs = docsApi.loading && docs.length === 0;

  return (
    <>
      <CocoaFormSection
        title="Registrar documento"
        description="Se guarda la ficha del documento (referencia y fechas). Si lo asocias a un control con fecha de caducidad, el control se marca «Cumple» con esa fecha automáticamente."
        actions={
          <>
            {imageDataUrl ? (
              <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy || ocrBusy} loading={ocrBusy} onClick={() => void readDatesWithAi()} title="Extrae tipo, organismo y fechas de la imagen del documento.">
                Leer fechas con IA
              </CocoaButton>
            ) : null}
            <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} onClick={() => void submit()}>
              Registrar documento
            </CocoaButton>
          </>
        }
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Asociar a control" hint="opcional" fullWidth>
            <CocoaSelect value={form.requirementCode} onChange={(v) => setForm((f) => ({ ...f, requirementCode: v }))} options={controlOptions} disabled={busy} />
          </CocoaField>
          <CocoaField label="Título" required>
            <CocoaInput value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v }))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Tipo">
            <CocoaInput value={form.documentType} onChange={(v) => setForm((f) => ({ ...f, documentType: v }))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Emisión">
            <CocoaDatePicker value={form.issueDate} onChange={(v) => setForm((f) => ({ ...f, issueDate: v }))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Caducidad">
            <CocoaDatePicker value={form.expiryDate} onChange={(v) => setForm((f) => ({ ...f, expiryDate: v }))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Organismo o proveedor">
            <CocoaInput value={form.issuingAuthority} onChange={(v) => setForm((f) => ({ ...f, issuingAuthority: v }))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Archivo" hint="opcional" help="Con una imagen del documento, la IA puede leer el tipo, el organismo y las fechas.">
            <CocoaFileInput fileName={form.fileName || null} disabled={busy} onPick={onPickFile} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaSection
        title="Carpeta de documentos"
        meta={docs.length > 0 ? plural(docs.length, "documento", "documentos") : undefined}
        padding={loadingDocs || docs.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {loadingDocs ? (
          <CocoaTable columns={columns} rows={[]} loading caption="Carpeta de documentos" aria-label="Carpeta de documentos" />
        ) : docs.length === 0 ? (
          <CocoaState kind="empty" illustration="box" title="Sin documentos" message="Aún no se ha registrado ningún documento de cumplimiento." />
        ) : (
          <CocoaTable
            columns={columns}
            rows={docs}
            rowKey="id"
            rowActions={(d) => (
              <CocoaButton
                variant="plain"
                tone="destructive"
                size="small"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  removeDoc(d.id, d.requirementCode ?? undefined);
                }}
              >
                {ACTIONS.delete}
              </CocoaButton>
            )}
            caption="Carpeta de documentos"
            aria-label="Carpeta de documentos"
          />
        )}
      </CocoaSection>
    </>
  );
}

/* --------------------------------------------------------------- Tareas tab */
function TareasTab(props: {
  tasksApi: ReturnType<typeof useApiData<ComplianceTask[]>>;
  tasks: ComplianceTask[];
  controls: ComplianceControl[];
  onChanged: () => void; setBusy: (v: boolean) => void; notify: Notify; busy: boolean;
}) {
  const { tasksApi, tasks, controls, onChanged, setBusy, notify, busy } = props;
  const [form, setForm] = useState<{ requirementCode: string; title: string; priority: string; dueDate: string; assignedToName: string }>({ requirementCode: "", title: "", priority: "MEDIUM", dueDate: "", assignedToName: "" });
  const controlOptions = useMemo(
    () => [{ value: "", label: "Sin asociar" }, ...controls.filter((c) => c.applies).map((c) => ({ value: c.code, label: `${c.code} · ${c.title}` }))],
    [controls]
  );

  async function create() {
    if (!form.title.trim()) { notify("Indica un título para la tarea.", "danger"); return; }
    setBusy(true); notify(null);
    try {
      await createComplianceTask({ requirementCode: form.requirementCode || undefined, title: form.title.trim(), priority: form.priority, dueDate: form.dueDate || undefined, assignedToName: form.assignedToName || undefined });
      notify("Tarea creada.");
      setForm({ requirementCode: "", title: "", priority: "MEDIUM", dueDate: "", assignedToName: "" });
      tasksApi.refresh(); onChanged();
    } catch (e) { notify(errorText(e, "No se pudo crear la tarea."), "danger"); }
    finally { setBusy(false); }
  }
  async function setStatus(id: string, status: string) {
    setBusy(true); notify(null);
    try { await updateComplianceTask(id, { status }); tasksApi.refresh(); onChanged(); }
    catch (e) { notify(errorText(e, "No se pudo actualizar."), "danger"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); notify(null);
    try { await deleteComplianceTask(id); tasksApi.refresh(); onChanged(); }
    catch (e) { notify(errorText(e, "No se pudo eliminar."), "danger"); }
    finally { setBusy(false); }
  }

  const open = tasks.filter((t) => t.status !== "DONE");
  const done = tasks.filter((t) => t.status === "DONE");
  const rows = [...open, ...done];
  const loadingTasks = tasksApi.loading && tasks.length === 0;

  return (
    <>
      <CocoaFormSection
        title="Nueva tarea correctiva"
        description="Una acción con responsable y fecha para cerrar una obligación pendiente."
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} onClick={() => void create()}>
            Crear tarea
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Título" required fullWidth>
            <CocoaInput value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v }))} placeholder="p. ej. Renovar revisión de extintores" disabled={busy} />
          </CocoaField>
          <CocoaField label="Control" hint="opcional">
            <CocoaSelect value={form.requirementCode} onChange={(v) => setForm((f) => ({ ...f, requirementCode: v }))} options={controlOptions} disabled={busy} />
          </CocoaField>
          <CocoaField label="Prioridad">
            <CocoaSelect value={form.priority} onChange={(v) => setForm((f) => ({ ...f, priority: v }))} options={PRIORITY_OPTIONS} disabled={busy} />
          </CocoaField>
          <CocoaField label="Vence el">
            <CocoaDatePicker value={form.dueDate} onChange={(v) => setForm((f) => ({ ...f, dueDate: v }))} disabled={busy} />
          </CocoaField>
          <CocoaField label="Responsable">
            <CocoaInput value={form.assignedToName} onChange={(v) => setForm((f) => ({ ...f, assignedToName: v }))} disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaSection
        title="Tareas"
        meta={tasks.length > 0 ? plural(open.length, "abierta", "abiertas") : undefined}
        padding={loadingTasks || tasks.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {loadingTasks ? (
          <CocoaTable columns={TASK_COLUMNS} rows={[]} loading caption="Tareas correctivas" aria-label="Tareas correctivas" />
        ) : tasks.length === 0 ? (
          <CocoaState kind="empty" illustration="box" title="Sin tareas" message="No hay tareas correctivas. Crea una para hacer seguimiento de una acción." />
        ) : (
          <CocoaTable
            columns={TASK_COLUMNS}
            rows={rows}
            rowKey="id"
            rowActionsVisible="always"
            rowTone={(t) => (t.status !== "DONE" && isPast(t.dueDate) ? "danger" : undefined)}
            rowActions={(t) => (
              <span className="cocoa-cluster">
                {t.status !== "IN_PROGRESS" && t.status !== "DONE" ? (
                  <CocoaButton variant="plain" size="small" disabled={busy} onClick={(event) => { event.stopPropagation(); void setStatus(t.id, "IN_PROGRESS"); }}>
                    Empezar
                  </CocoaButton>
                ) : null}
                {t.status !== "DONE" ? (
                  <CocoaButton variant="plain" size="small" disabled={busy} onClick={(event) => { event.stopPropagation(); void setStatus(t.id, "DONE"); }}>
                    {ACTIONS.complete}
                  </CocoaButton>
                ) : (
                  <CocoaButton variant="plain" size="small" disabled={busy} onClick={(event) => { event.stopPropagation(); void setStatus(t.id, "OPEN"); }}>
                    {ACTIONS.reopen}
                  </CocoaButton>
                )}
                <CocoaButton variant="plain" tone="destructive" size="small" disabled={busy} onClick={(event) => { event.stopPropagation(); void remove(t.id); }}>
                  {ACTIONS.delete}
                </CocoaButton>
              </span>
            )}
            caption="Tareas correctivas"
            aria-label="Tareas correctivas"
          />
        )}
      </CocoaSection>
    </>
  );
}

/* -------------------------------------------------------------- Alertas tab */
function AlertasTab(props: { alertsApi: ReturnType<typeof useApiData<ComplianceAlertsResponse>>; onJump: (code: string) => void }) {
  const { alertsApi, onJump } = props;
  const data = alertsApi.data;
  const alerts = useMemo(() => toArray<ComplianceAlert>(data?.alerts), [data]);
  const loadingAlerts = alertsApi.loading && !data;

  return (
    <CocoaSection
      title="Alertas"
      meta={
        alerts.length > 0 ? (
          <span className="cocoa-cluster">
            {Object.entries(data?.byKind ?? {}).map(([k, n]) => (
              <CocoaBadge key={k} tone="neutral" size="small">
                {ALERT_KIND_LABEL[k] ?? k}: {number(n)}
              </CocoaBadge>
            ))}
          </span>
        ) : undefined
      }
      padding={loadingAlerts || alerts.length > 0 ? "none" : "md"}
      style={{ overflow: "clip" }}
    >
      {loadingAlerts ? (
        <CocoaTable columns={ALERT_COLUMNS} rows={[]} loading caption="Alertas de cumplimiento" aria-label="Alertas de cumplimiento" />
      ) : alertsApi.error && alerts.length === 0 ? (
        <CocoaState kind="error" title="No se pudieron cargar las alertas" message={alertsApi.error} onRetry={alertsApi.refresh} />
      ) : alerts.length === 0 ? (
        <CocoaState kind="empty" illustration="success" title="Sin alertas" message="No hay obligaciones vencidas, documentos faltantes ni tareas atrasadas. Todo en orden." />
      ) : (
        <CocoaTable
          columns={ALERT_COLUMNS}
          rows={alerts}
          rowKey="id"
          rowActionsVisible="always"
          rowTone={(a) => (a.severity === "CRITICAL" || a.severity === "HIGH" ? "danger" : undefined)}
          rowActions={(a) =>
            a.requirementCode ? (
              <CocoaButton variant="plain" size="small" onClick={(event) => { event.stopPropagation(); onJump(a.requirementCode!); }}>
                Ver control
              </CocoaButton>
            ) : null
          }
          caption="Alertas de cumplimiento"
          aria-label="Alertas de cumplimiento"
        />
      )}
    </CocoaSection>
  );
}

/* ------------------------------------------------------------ Asistente tab */
function AsistenteTab(props: {
  assistantApi: ReturnType<typeof useApiData<ComplianceAssistant>>;
  busy: boolean; setBusy: (v: boolean) => void; notify: Notify;
  onTaskCreated: () => void; onJump: (code: string) => void;
}) {
  const { assistantApi, busy, setBusy, notify, onTaskCreated, onJump } = props;
  const data = assistantApi.data;
  const suggestions = useMemo(() => toArray<ComplianceSuggestion>(data?.suggestions), [data]);
  const [createdFor, setCreatedFor] = useState<Set<string>>(new Set());

  async function createTask(s: ComplianceSuggestion) {
    setBusy(true); notify(null);
    try {
      await createComplianceTask({ requirementCode: s.requirementCode, title: s.taskTitle, priority: s.taskPriority });
      setCreatedFor((prev) => new Set(prev).add(s.id));
      notify(`Tarea creada: ${s.taskTitle}`);
      onTaskCreated();
    } catch (e) {
      notify(errorText(e, "No se pudo crear la tarea."), "danger");
    } finally { setBusy(false); }
  }

  if (assistantApi.loading && !data) return <CocoaState kind="loading" title="Analizando el cumplimiento…" />;
  if (assistantApi.error) return <CocoaState kind="error" title="No se pudo analizar" message={assistantApi.error} onRetry={assistantApi.refresh} />;
  if (!data) return null;

  return (
    <>
      <CocoaSection
        title="Resumen del asesor"
        meta={
          <CocoaBadge tone={data.narrativeSource === "ai" ? "ai" : "success"} size="small">
            {data.narrativeSource === "ai" ? `IA (${data.provider})` : "Resumen por reglas"}
          </CocoaBadge>
        }
      >
        <p>{data.narrative}</p>
        {data.narrativeSource === "rules" ? (
          <p className="cocoa-note">
            Resumen generado por reglas a partir de tus datos. Configura un proveedor de IA (AI_PROVIDER) para obtener un análisis redactado por IA. Las acciones de abajo son siempre deterministas y se basan en datos reales.
          </p>
        ) : null}
      </CocoaSection>

      <CocoaSection
        title="Acciones recomendadas"
        meta={suggestions.length > 0 ? plural(data.count, "acción", "acciones") : undefined}
        padding={suggestions.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {suggestions.length === 0 ? (
          <CocoaState kind="empty" illustration="success" title="Nada pendiente" message="El asistente no detecta acciones recomendadas ahora mismo." />
        ) : (
          <CocoaTable
            columns={SUGGESTION_COLUMNS}
            rows={suggestions}
            rowKey="id"
            rowActionsVisible="always"
            rowActions={(s) => (
              <span className="cocoa-cluster">
                <CocoaButton variant="plain" size="small" onClick={(event) => { event.stopPropagation(); onJump(s.requirementCode); }}>
                  Ver control
                </CocoaButton>
                {createdFor.has(s.id) ? (
                  <CocoaBadge tone="success" size="small">Tarea creada</CocoaBadge>
                ) : (
                  <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} onClick={(event) => { event.stopPropagation(); void createTask(s); }}>
                    Crear tarea
                  </CocoaButton>
                )}
              </span>
            )}
            caption="Acciones recomendadas por el asistente"
            aria-label="Acciones recomendadas por el asistente"
          />
        )}
      </CocoaSection>
    </>
  );
}

/* -------------------------------------------------------------- Ajustes tab */
function AjustesTab(props: {
  profile: ComplianceProfile | null;
  kpis: { applicable: number } | undefined;
  busy: boolean; setBusy: (v: boolean) => void; notify: Notify;
  onSaved: () => void;
}) {
  const { profile, kpis, busy, setBusy, notify, onSaved } = props;
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
    setBusy(true); notify(null);
    try {
      await updateComplianceProfile({
        autonomousCommunity: draft.autonomousCommunity || null,
        hotelType: draft.hotelType || null,
        hasRestaurant: !!draft.hasRestaurant, hasKitchen: !!draft.hasKitchen, hasPool: !!draft.hasPool, hasSpa: !!draft.hasSpa,
        hasParking: !!draft.hasParking, hasEvents: !!draft.hasEvents, hasTerrace: !!draft.hasTerrace, hasLaundry: !!draft.hasLaundry,
        buildingProtected: !!draft.buildingProtected, expiringSoonDays: Number(draft.expiringSoonDays) || 30
      });
      notify("Perfil guardado. La matriz se ha recalculado según la plantilla.");
      onSaved();
    } catch (e) {
      notify(errorText(e, "No se pudo guardar el perfil."), "danger");
    } finally { setBusy(false); }
  }

  return (
    <>
      <CocoaFormSection
        title="Plantilla del establecimiento"
        description={`La comunidad autónoma, el tipo de hotel y los servicios determinan qué obligaciones legales aplican${kpis ? ` (hoy ${plural(kpis.applicable, "obligación aplica", "obligaciones aplican")})` : ""}. Al guardar, la matriz se actualiza automáticamente (alta o baja de controles), respetando las marcas manuales de «No aplica».`}
      >
        <CocoaFormRow columns={3}>
          <CocoaField label="Comunidad autónoma">
            <CocoaSelect value={draft.autonomousCommunity ?? ""} onChange={(v) => setDraft((d) => ({ ...d, autonomousCommunity: v }))} options={COMUNIDAD_OPTIONS} disabled={busy} />
          </CocoaField>
          <CocoaField label="Tipo de establecimiento">
            <CocoaSelect value={draft.hotelType ?? ""} onChange={(v) => setDraft((d) => ({ ...d, hotelType: v }))} options={HOTEL_TYPE_OPTIONS} disabled={busy} />
          </CocoaField>
          <CocoaField label="Aviso de caducidad (días)" help="Con cuántos días de antelación un control pasa a «Vence pronto».">
            <CocoaInput type="number" inputMode="numeric" min={1} max={365} value={String(draft.expiringSoonDays ?? 30)} onChange={(v) => setDraft((d) => ({ ...d, expiringSoonDays: Number(v) }))} disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection
        title="Servicios e instalaciones"
        description="«Cocina propia» activa los controles de APPCC y alérgenos; «Piscina» activa el control sanitario de piscina; «Edificio protegido» activa la autorización de patrimonio."
        actions={
          <CocoaButton variant="filled" tone="accent" disabled={busy} loading={busy} onClick={() => void save()}>
            Guardar plantilla y recalcular
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={3} min={200}>
          {PROFILE_FEATURES.map((f) => (
            <CocoaField key={f.k} label={f.l} inline>
              <CocoaSwitch checked={!!draft[f.k]} onChange={(v) => setDraft((d) => ({ ...d, [f.k]: v }))} size="small" disabled={busy} />
            </CocoaField>
          ))}
        </CocoaFormRow>
      </CocoaFormSection>
    </>
  );
}
