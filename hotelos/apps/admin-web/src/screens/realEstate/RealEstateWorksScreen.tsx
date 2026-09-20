// Finanzas › Activo inmobiliario › Obras (Tanda ACT · lote ACT-F3, diseño
// docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8 «Obras», adaptado a la
// decisión «ejecución por asientos reales»: la columna «Ejecutado» dice de
// dónde sale la cifra — CocoaBadge «Libro» cuando `executionSource = ledger`
// (diario 21x/23x del centro) o «Partidas» cuando es Σ actualCost — con la
// barra presupuesto / ejecutado).
//
// Cocoa 22 sin estilos inline: CocoaPage → tira de KPI (proyectos abiertos,
// presupuesto, ejecutado, obras sin licencia) → aviso de las alertas
// CAPEX_LICENCE_MISSING → CocoaTable de los proyectos `CapexProject` del centro
// (estado, presupuesto, ejecutado con origen y barra, licencia, ICIO,
// capitalización) con acciones «Obra» · «Capitalizar» · «Inmovilizado».
//
// Cajón «Obra»: el flujo propuesto → aprobado → licencia → en obra →
// terminado → capitalizado (WorkStageFlow: una fila de CocoaBadge, porque el
// CocoaStepper del sistema es el control numérico ±), los datos de obra de
// ACT-L4 (enlace a la ficha del activo, tipo, licencia exigida, documento de
// la licencia elegido entre los documentos de categoría «licencias»,
// concesión, ICIO, prefijos de cuenta de ejecución) y las transiciones
// «Iniciar obra» (409 LICENCE_REQUIRED → frase en el cajón), «Terminar» y
// «Capitalizar» (solo con assets.manage y estado completed; diálogo de
// confirmación; el alta del inmovilizado enlaza a Finanzas › Proveedores ›
// Inmovilizado con navigateTo).
//
// Lectura: useApiData sobre GET …/real-estate/works (realEstateWorksPath), la
// ficha del activo (realEstatePath, para el enlace realEstateAssetId) y los
// documentos de licencias (realEstateDocumentsPath ?category=licencias; si el
// listado no responde el selector degrada a un campo con el id). Escrituras por
// services/realEstateApi.ts (updateCapexWork · capitalizeCapexProject). La
// creación sigue en la ruta existente POST /capex-projects (capex.create) y la
// aprobación en la ruta propia POST /capex-projects/:id/approve
// (asset.capex.approve; ACT-REV-05: PATCH /capex-projects/:id exige capex.create
// en el manifiesto y ninguna plantilla reúne las dos claves): sin cliente tipado
// en services/, van por apiRequest desde los helpers locales de este fichero
// (nunca fetch crudo).
//
// Permisos (canDo sobre useNavGate): capex.create para crear proyectos y
// editar la obra; asset.capex.approve para aprobar (owner, general_manager,
// controller: nunca quien lo propuso); assets.manage para capitalizar. Sin
// ellos la pantalla se lee y los botones se deshabilitan con la razón.

import { useEffect, useMemo, useState } from "react";
import type { CapexWorkKind } from "@hotelos/shared";
import { CAPEX_WORK_KINDS } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  useViewportTier,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { number, plural } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useActiveProperty } from "../../services/activeProperty";
import { apiRequest } from "../../services/api-client";
import {
  capitalizeCapexProject,
  realEstateDocumentListQuery,
  realEstateDocumentsPath,
  realEstatePath,
  realEstateWorksPath,
  updateCapexWork,
  type CapexCapitalizationResult,
  type CapexWorkPatchRequest,
  type CapexWorkRecord,
  type RealEstateAlert,
  type RealEstateAssetDetail,
  type RealEstateDocumentRecord,
  type RealEstateWorksResponse
} from "../../services/realEstateApi";
import { canDo } from "../accounting/accounting-ui";
import { decimalInput } from "../payables/payables-helpers";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CAPEX_EXECUTION_SOURCE_LABELS,
  CAPEX_WORK_KIND_LABELS,
  alertSeverityTone,
  capexStatusLabel,
  capexStatusTone,
  capexWorkKindLabel,
  catalogOptions,
  formatDay,
  formatMoney,
  formatPercent,
  realEstateErrorMessage
} from "./real-estate-helpers";

const HEADER = treeHeaderFor("RealEstateWorksScreen", { eyebrow: "Finanzas · Activo inmobiliario", title: "Obras" });
const LOAD_ERROR = errorStateFor("las obras del centro");
const EMPTY_PROJECTS: CapexWorkRecord[] = [];
const EMPTY_ALERTS: RealEstateAlert[] = [];
const EMPTY_DOCUMENTS: RealEstateDocumentRecord[] = [];

export const NO_WORK_PERMISSION = "Necesitas el permiso de proyectos de inversión («capex.create»)";
export const NO_APPROVE_PERMISSION = "Necesitas el permiso de aprobación de inversiones («asset.capex.approve»)";
export const NO_CAPITALIZE_PERMISSION = "Necesitas el permiso de gestión de activos («assets.manage») para capitalizar";
const NO_ASSET_NOTE = "Este centro aún no tiene ficha de activo inmobiliario: créala en «Ficha» para poder enlazar la obra y capitalizarla.";

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Rutas existentes de proyectos (server.ts): sin cliente en services/, por apiRequest
// ---------------------------------------------------------------------------

/** Cuerpo de `POST /capex-projects` (motor existente: el presupuesto viaja como número). */
export type CapexProjectCreateBody = { name: string; description?: string; budget: number; startDate?: string; targetEndDate?: string };

/** Respuesta del motor existente (modules/assets · CapexProjectRecord). */
export type CapexProjectSummary = { id: string; propertyId: string; name: string; status: string; budget: number };

/** `POST /capex-projects` (capex.create): nace `proposed`. */
export function createCapexProjectRequest(body: CapexProjectCreateBody, propertyId: string): Promise<CapexProjectSummary> {
  return apiRequest<CapexProjectSummary>("/capex-projects", { method: "POST", body: { ...body, propertyId } });
}

/** `POST /capex-projects/:id/approve` (asset.capex.approve + separación de funciones: nunca quien lo propuso). */
export function approveCapexProjectRequest(capexProjectId: string): Promise<CapexProjectSummary> {
  return apiRequest<CapexProjectSummary>(`/capex-projects/${enc(capexProjectId)}/approve`, { method: "POST", body: {} });
}

// ---------------------------------------------------------------------------
// Helpers puros (exportados para __tests__/RealEstateWorksScreen.test.mts)
// ---------------------------------------------------------------------------

export type WorkStageKey = "proposed" | "approved" | "licence" | "in_progress" | "completed" | "capitalized";

/** Flujo del diseño §8: propuesto → aprobado → licencia → en obra → terminado → capitalizado. */
export const WORK_STAGES: ReadonlyArray<{ key: WorkStageKey; label: string }> = [
  { key: "proposed", label: "Propuesto" },
  { key: "approved", label: "Aprobado" },
  { key: "licence", label: "Licencia" },
  { key: "in_progress", label: "En obra" },
  { key: "completed", label: "Terminado" },
  { key: "capitalized", label: "Capitalizado" }
];

export type WorkStageInput = Pick<CapexWorkRecord, "status" | "licenceRequired" | "licenceDocumentId" | "capitalizedFixedAssetId">;

/**
 * Fase actual de la obra: «licencia» cuando está aprobada y la licencia ya está
 * registrada (o no hace falta); «aprobado» mientras la licencia exigida falte.
 * `cancelled` no pertenece al flujo.
 */
export function workStageOf(project: WorkStageInput): WorkStageKey | "cancelled" {
  if (project.status === "cancelled") return "cancelled";
  if (project.capitalizedFixedAssetId) return "capitalized";
  if (project.status === "completed") return "completed";
  if (project.status === "in_progress") return "in_progress";
  if (project.status === "approved") return project.licenceRequired && !project.licenceDocumentId ? "approved" : "licence";
  return "proposed";
}

export function workStageIndex(stage: WorkStageKey | "cancelled"): number {
  return WORK_STAGES.findIndex((entry) => entry.key === stage);
}

export function licenceMissing(project: Pick<CapexWorkRecord, "licenceRequired" | "licenceDocumentId">): boolean {
  return project.licenceRequired && !project.licenceDocumentId;
}

/** «Capitalizar» solo con assets.manage, estado completed, sin capitalizar y enlazada a la ficha (CAPEX_NOT_LINKED). */
export function canCapitalize(project: Pick<CapexWorkRecord, "status" | "capitalizedFixedAssetId" | "realEstateAssetId">, canManageAssets: boolean): boolean {
  return canManageAssets && project.status === "completed" && !project.capitalizedFixedAssetId && Boolean(project.realEstateAssetId);
}

/** Razón (tooltip) por la que «Capitalizar» está deshabilitado; null cuando se puede. */
export function capitalizeBlockReason(project: Pick<CapexWorkRecord, "status" | "capitalizedFixedAssetId" | "realEstateAssetId">, canManageAssets: boolean): string | null {
  if (!canManageAssets) return NO_CAPITALIZE_PERMISSION;
  if (project.capitalizedFixedAssetId) return "La obra ya está capitalizada en el inmovilizado.";
  if (project.status !== "completed") return `Solo se capitaliza una obra terminada (esta está «${capexStatusLabel(project.status)}»).`;
  if (!project.realEstateAssetId) return "Enlaza la obra a la ficha del activo inmobiliario antes de capitalizarla.";
  return null;
}

export function canStartWork(project: Pick<CapexWorkRecord, "status">): boolean {
  return project.status === "approved";
}

export function canCompleteWork(project: Pick<CapexWorkRecord, "status">): boolean {
  return project.status === "in_progress";
}

/** Origen de la ejecución: «Libro» (diario 21x/23x, tono acento) o «Partidas» (Σ actualCost, neutro). */
export function executionSourceBadge(project: Pick<CapexWorkRecord, "executionSource">): { label: string; tone: CocoaTone; title: string } {
  if (project.executionSource === "ledger") return { label: "Libro", tone: "accent", title: CAPEX_EXECUTION_SOURCE_LABELS.ledger };
  return { label: "Partidas", tone: "neutral", title: CAPEX_EXECUTION_SOURCE_LABELS.items };
}

/** % ejecutado sobre el presupuesto (0 sin presupuesto) y tono de la barra (rojo por encima, ámbar desde el 90 %). */
export function executionProgress(project: Pick<CapexWorkRecord, "budget" | "executedAmount">): { pct: number; tone: CocoaTone } {
  const budget = Number(project.budget);
  const executed = Number(project.executedAmount);
  const pct = Number.isFinite(budget) && budget > 0 && Number.isFinite(executed) ? Math.max(0, (executed / budget) * 100) : 0;
  return { pct, tone: pct > 100 ? "danger" : pct >= 90 ? "warning" : "accent" };
}

/** Celda «Licencia»: no requiere · registrada / concedida · pendiente (roja si la obra ya está en curso). */
export function licenceState(project: Pick<CapexWorkRecord, "status" | "licenceRequired" | "licenceDocumentId" | "licenceGrantedAt">): { label: string; tone: CocoaTone } {
  if (!project.licenceRequired) return { label: "No requiere", tone: "neutral" };
  if (project.licenceDocumentId) return { label: project.licenceGrantedAt ? `Concedida ${formatDay(project.licenceGrantedAt)}` : "Registrada", tone: "success" };
  return { label: "Pendiente", tone: project.status === "in_progress" ? "danger" : "warning" };
}

export type WorksKpis = { open: number; budget: number; executed: number; withoutLicence: number };

/** Proyectos abiertos (ni terminados ni cancelados), presupuesto y ejecución totales de los abiertos y obras en curso sin licencia. */
export function worksKpis(projects: ReadonlyArray<Pick<CapexWorkRecord, "status" | "budget" | "executedAmount">>, alerts: ReadonlyArray<Pick<RealEstateAlert, "kind">>): WorksKpis {
  const open = projects.filter((project) => project.status !== "completed" && project.status !== "cancelled");
  const sum = (values: number[]) => Math.round(values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0) * 100) / 100;
  return {
    open: open.length,
    budget: sum(open.map((project) => Number(project.budget))),
    executed: sum(open.map((project) => Number(project.executedAmount))),
    withoutLicence: alerts.filter((alert) => alert.kind === "CAPEX_LICENCE_MISSING").length
  };
}

/** Frase en español de un fallo de obra: LICENCE_REQUIRED, CAPEX_NOT_COMPLETED, CAPEX_ALREADY_CAPITALIZED, CAPEX_NOT_LINKED… o el mensaje del API. */
export function worksErrorMessage(error: unknown, fallback = "No se pudo guardar la obra. Inténtalo de nuevo."): string {
  return realEstateErrorMessage(error, fallback);
}

// ---- Formulario de la obra ----------------------------------------------------

export type WorkForm = {
  linkAsset: boolean;
  workKind: CapexWorkKind | "";
  licenceRequired: boolean;
  licenceDocumentId: string;
  licenceGrantedAt: string;
  icioAmount: string;
  /** Prefijos separados por comas («211, 212»). */
  executionAccountPrefixes: string;
};

export function workFormOf(project: CapexWorkRecord): WorkForm {
  return {
    linkAsset: Boolean(project.realEstateAssetId),
    workKind: project.workKind ?? "",
    licenceRequired: project.licenceRequired,
    licenceDocumentId: project.licenceDocumentId ?? "",
    licenceGrantedAt: project.licenceGrantedAt ?? "",
    icioAmount: project.icioAmount ?? "",
    executionAccountPrefixes: project.executionAccountPrefixes ?? ""
  };
}

const PREFIX_RE = /^\d{2,10}$/;

/** «211, 212» → ["211","212"]; vacío → null (el API vuelve a los prefijos por defecto); inválido → undefined. */
export function parsePrefixes(raw: string): string[] | null | undefined {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((part) => !PREFIX_RE.test(part))) return undefined;
  return Array.from(new Set(parts));
}

export type WorkFormErrors = Partial<Record<"icioAmount" | "executionAccountPrefixes" | "licenceDocumentId", string>>;

export function workFormErrors(form: WorkForm): WorkFormErrors {
  const errors: WorkFormErrors = {};
  if (form.icioAmount.trim() && decimalInput(form.icioAmount) === null) errors.icioAmount = "Importe no válido: usa como máximo dos decimales.";
  if (parsePrefixes(form.executionAccountPrefixes) === undefined) errors.executionAccountPrefixes = "Cada prefijo debe ser numérico (2 a 10 cifras), separados por comas: 211, 212.";
  return errors;
}

/** Cuerpo de `PATCH /capex-projects/:id/work` a partir del formulario (`assetId` = ficha del centro para el enlace). */
export function workPatchOf(form: WorkForm, assetId: string | null): CapexWorkPatchRequest {
  return {
    realEstateAssetId: form.linkAsset && assetId ? assetId : null,
    workKind: form.workKind || null,
    licenceRequired: form.licenceRequired,
    licenceDocumentId: form.licenceDocumentId.trim() || null,
    licenceGrantedAt: form.licenceGrantedAt || null,
    icioAmount: decimalInput(form.icioAmount),
    executionAccountPrefixes: parsePrefixes(form.executionAccountPrefixes) ?? null
  };
}

// ---- Formulario del proyecto nuevo -------------------------------------------

export type ProjectForm = { name: string; description: string; budget: string; startDate: string; targetEndDate: string };

export function emptyProjectForm(): ProjectForm {
  return { name: "", description: "", budget: "", startDate: "", targetEndDate: "" };
}

export type ProjectFormErrors = Partial<Record<"name" | "budget" | "targetEndDate", string>>;

export function projectFormErrors(form: ProjectForm): ProjectFormErrors {
  const errors: ProjectFormErrors = {};
  if (!form.name.trim()) errors.name = "Indica el nombre del proyecto.";
  const budget = decimalInput(form.budget);
  if (budget === null || Number(budget) <= 0) errors.budget = "Indica un presupuesto mayor que cero (máximo dos decimales).";
  if (form.startDate && form.targetEndDate && form.targetEndDate < form.startDate) errors.targetEndDate = "La fecha prevista de fin no puede ser anterior al inicio.";
  return errors;
}

export function projectBodyOf(form: ProjectForm): CapexProjectCreateBody {
  return {
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    budget: Number(decimalInput(form.budget) ?? "0"),
    ...(form.startDate ? { startDate: form.startDate } : {}),
    ...(form.targetEndDate ? { targetEndDate: form.targetEndDate } : {})
  };
}

// ---------------------------------------------------------------------------
// Piezas de presentación (sin hooks: se renderizan en los tests). Se declaran sin
// `export` y salen en la lista nombrada del final: scripts/check-sidebar-coverage.mjs
// toma el PRIMER `export function <PascalCase>` del fichero como la pantalla.
// ---------------------------------------------------------------------------

/** Fila de badges del flujo: hechas en verde, la actual en acento, pendientes neutras; cancelada aparte. */
function WorkStageFlow({ project }: { project: WorkStageInput }) {
  const stage = workStageOf(project);
  if (stage === "cancelled") {
    return (
      <CocoaBadge tone="danger" variant="tinted" uppercase={false}>
        {capexStatusLabel("cancelled")}
      </CocoaBadge>
    );
  }
  const current = workStageIndex(stage);
  return (
    <ol className="cocoa-row" data-gap="1" aria-label="Fases de la obra">
      {WORK_STAGES.map((entry, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={entry.key} aria-current={active ? "step" : undefined}>
            <CocoaBadge tone={done ? "success" : active ? "accent" : "neutral"} variant={done || active ? "tinted" : "outline"} size="small" uppercase={false} title={done ? `${entry.label}: hecho` : active ? `${entry.label}: fase actual` : `${entry.label}: pendiente`}>
              {entry.label}
            </CocoaBadge>
          </li>
        );
      })}
    </ol>
  );
}

/** Celda «Ejecutado»: importe, origen (Libro · Partidas) y barra presupuesto / ejecutado. */
function ExecutionCell({ project }: { project: Pick<CapexWorkRecord, "budget" | "executedAmount" | "executionSource"> }) {
  const source = executionSourceBadge(project);
  const progress = executionProgress(project);
  return (
    <div className="cocoa-stack" data-gap="1">
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <strong>{formatMoney(project.executedAmount)}</strong>
        <CocoaBadge tone={source.tone} variant="tinted" size="small" uppercase={false} title={source.title}>
          {source.label}
        </CocoaBadge>
      </div>
      <CocoaChart.Progress value={Math.min(progress.pct, 100)} tone={progress.tone} showValue={false} aria-label={`Ejecutado ${formatPercent(progress.pct, 0)} del presupuesto`} />
      <span className="cocoa-caption">{`${formatPercent(progress.pct, 0)} de ${formatMoney(project.budget)}`}</span>
    </div>
  );
}

function LicenceBadge({ project }: { project: Pick<CapexWorkRecord, "status" | "licenceRequired" | "licenceDocumentId" | "licenceGrantedAt"> }) {
  const state = licenceState(project);
  return (
    <CocoaBadge tone={state.tone} variant={state.tone === "neutral" ? "outline" : "tinted"} size="small" uppercase={false}>
      {state.label}
    </CocoaBadge>
  );
}

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

const WORK_KIND_OPTIONS = [{ value: "", label: "Sin tipo" }, ...catalogOptions(CAPEX_WORK_KINDS, CAPEX_WORK_KIND_LABELS)];

function licenceOptions(documents: ReadonlyArray<RealEstateDocumentRecord>): Array<{ value: string; label: string }> {
  return [{ value: "", label: "Sin documento" }, ...documents.map((doc) => ({ value: doc.id, label: `${doc.title}${doc.version > 1 ? ` (v${doc.version})` : ""}${doc.hasFile ? "" : " · sin fichero"}` }))];
}

const COLUMNS: CocoaTableColumn<CapexWorkRecord>[] = [
  {
    key: "name",
    label: "Proyecto",
    render: (project) => (
      <div className="cocoa-stack" data-gap="1">
        <strong>{project.name}</strong>
        <span className="cocoa-caption">{project.workKind ? capexWorkKindLabel(project.workKind) : "Sin tipo de obra"}</span>
      </div>
    )
  },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (project) => (
      <CocoaBadge tone={capexStatusTone(project.status)} variant="tinted" size="small" uppercase={false}>
        {capexStatusLabel(project.status)}
      </CocoaBadge>
    )
  },
  { key: "budget", label: "Presupuesto", align: "right", hideOnNarrow: true, render: (project) => formatMoney(project.budget) },
  { key: "executed", label: "Ejecutado", minWidth: 180, render: (project) => <ExecutionCell project={project} /> },
  { key: "licence", label: "Licencia", fit: true, render: (project) => <LicenceBadge project={project} /> },
  { key: "icio", label: "ICIO", align: "right", showFrom: "laptop", render: (project) => formatMoney(project.icioAmount) },
  { key: "capitalized", label: "Capitalizado", showFrom: "laptop", render: (project) => (project.capitalizedAt ? formatDay(project.capitalizedAt) : "—") }
];

type PageState = "loading" | "error" | "ready";

function pageStateOf(state: { loading: boolean; error: string | null; data: unknown }): PageState {
  if (state.loading && !state.data) return "loading";
  if (state.error && !state.data) return "error";
  return "ready";
}

export function RealEstateWorksScreen() {
  const { propertyId, propertyName } = useActiveProperty();
  const gate = useNavGate();
  const canWork = canDo(gate, "capex.create");
  const canApprove = canDo(gate, "asset.capex.approve");
  const canManageAssets = canDo(gate, "assets.manage");
  const phone = useViewportTier() === "phone";
  const { showToast } = useToast();

  const works = useApiData<RealEstateWorksResponse>(realEstateWorksPath(propertyId));
  const assetState = useApiData<RealEstateAssetDetail>(realEstatePath(propertyId));
  const licences = useApiData<RealEstateDocumentRecord[]>(realEstateDocumentsPath(propertyId), { query: realEstateDocumentListQuery({ category: "licencias" }) });

  const projects = works.data?.projects ?? EMPTY_PROJECTS;
  const alerts = works.data?.alerts ?? EMPTY_ALERTS;
  const assetId = assetState.data?.asset.id ?? null;
  const licenceDocuments = licences.data ?? EMPTY_DOCUMENTS;
  const kpis = useMemo(() => worksKpis(projects, alerts), [projects, alerts]);
  const pageState = pageStateOf(works);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<WorkForm | null>(null);
  const [busy, setBusy] = useState<"save" | "start" | "complete" | "capitalize" | "approve" | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [capitalizeOpen, setCapitalizeOpen] = useState(false);
  const [capitalized, setCapitalized] = useState<CapexCapitalizationResult | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectForm>(emptyProjectForm);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);

  // El formulario sigue a la fila seleccionada (y a lo que devuelva el API tras cada escritura).
  useEffect(() => {
    setForm(selected ? workFormOf(selected) : null);
    setWorkError(null);
  }, [selected]);

  const formErrors = form ? workFormErrors(form) : {};
  const formValid = Object.keys(formErrors).length === 0;

  function openProject(project: CapexWorkRecord) {
    setSelectedId(project.id);
    setCapitalized(null);
  }

  function closeDrawer() {
    if (busy) return;
    setSelectedId(null);
    setCapitalized(null);
  }

  function patchForm(patch: Partial<WorkForm>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  async function submitWork(kind: "save" | "start" | "complete") {
    if (!selected || !form || !formValid) return;
    setBusy(kind);
    setWorkError(null);
    try {
      const body: CapexWorkPatchRequest = { ...workPatchOf(form, assetId), ...(kind === "start" ? { status: "in_progress" } : kind === "complete" ? { status: "completed" } : {}) };
      const updated = await updateCapexWork(selected.id, body);
      setForm(workFormOf(updated));
      showToast(kind === "start" ? `Obra «${updated.name}» iniciada.` : kind === "complete" ? `Obra «${updated.name}» terminada.` : `Datos de obra de «${updated.name}» guardados.`, { variant: "success" });
      works.refresh();
    } catch (err) {
      setWorkError(worksErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function confirmCapitalize() {
    if (!selected) return;
    setBusy("capitalize");
    setWorkError(null);
    try {
      const result = await capitalizeCapexProject(selected.id);
      setCapitalizeOpen(false);
      setCapitalized(result);
      showToast(`Obra «${result.project.name}» capitalizada en el inmovilizado (${formatMoney(result.fixedAsset.acquisitionCost)}).`, { variant: "success" });
      works.refresh();
    } catch (err) {
      setCapitalizeOpen(false);
      setWorkError(worksErrorMessage(err, "No se pudo capitalizar la obra. Inténtalo de nuevo."));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!selected) return;
    setBusy("approve");
    setWorkError(null);
    try {
      await approveCapexProjectRequest(selected.id);
      showToast(`Proyecto «${selected.name}» aprobado.`, { variant: "success" });
      works.refresh();
    } catch (err) {
      setWorkError(worksErrorMessage(err, "No se pudo aprobar el proyecto. Inténtalo de nuevo."));
    } finally {
      setBusy(null);
    }
  }

  const projectErrors = projectFormErrors(projectForm);

  async function createProject() {
    if (Object.keys(projectErrors).length > 0) return;
    setProjectBusy(true);
    setProjectError(null);
    try {
      const created = await createCapexProjectRequest(projectBodyOf(projectForm), propertyId);
      setProjectOpen(false);
      setProjectForm(emptyProjectForm());
      showToast(`Proyecto «${created.name}» creado (propuesto).`, { variant: "success" });
      works.refresh();
    } catch (err) {
      setProjectError(worksErrorMessage(err, "No se pudo crear el proyecto. Inténtalo de nuevo."));
    } finally {
      setProjectBusy(false);
    }
  }

  const drawerSide = phone ? "bottom" : "right";
  const licenceListUnavailable = Boolean(licences.error) && !licences.data;

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Proyectos de inversión del centro con su ejecución real (diario 21x/23x o partidas), la licencia de obras, el ICIO y la capitalización en el inmovilizado al terminar."
      actions={
        <>
          {works.error && works.data ? (
            <CocoaBadge tone="danger" title={works.error}>
              {STATUS_LABELS.loadError}
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => works.refresh()} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setProjectOpen(true)} disabled={!canWork} title={canWork ? undefined : NO_WORK_PERMISSION}>
            Nuevo proyecto
          </CocoaButton>
        </>
      }
      state={pageState}
      error={{ title: LOAD_ERROR.title, message: works.error ?? LOAD_ERROR.message, onRetry: () => works.refresh() }}
      commands={[
        { id: "real-estate-works-new", label: "Nuevo proyecto de inversión", run: () => setProjectOpen(true) },
        { id: "real-estate-works-refresh", label: "Actualizar las obras", run: () => works.refresh() }
      ]}
    >
      <CocoaKpiStrip aria-label="Indicadores de obras del centro">
        <CocoaKpi label="Proyectos abiertos" value={number(kpis.open)} caption="propuestos, aprobados o en obra" polarity="neutral" status="ok" />
        <CocoaKpi label="Presupuesto abierto" value={formatMoney(kpis.budget)} caption="de los proyectos abiertos" polarity="neutral" status="ok" />
        <CocoaKpi label="Ejecutado" value={formatMoney(kpis.executed)} caption="diario del centro o partidas" polarity="neutral" status={kpis.budget > 0 && kpis.executed > kpis.budget ? "warning" : "ok"} />
        <CocoaKpi label="Obras sin licencia" value={number(kpis.withoutLicence)} caption="en curso con licencia exigida" polarity="neutral" status={kpis.withoutLicence > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      {!canWork ? <p className="cocoa-note">{NO_WORK_PERMISSION} para crear proyectos o editar los datos de obra: la lista se puede consultar.</p> : null}

      {alerts.length > 0 ? (
        <CocoaCallout tone={alertSeverityTone(alerts[0].severity)} title={plural(alerts.length, "obra en curso sin licencia de obras", "obras en curso sin licencia de obras")} role="alert">
          <ul className="c22-section__list">
            {alerts.map((alert) => (
              <li key={`${alert.kind}-${alert.entityId}`}>
                <span>{alert.message}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}

      <CocoaSection title="Proyectos de inversión" meta={works.data ? plural(projects.length, "proyecto", "proyectos") : undefined}>
        <CocoaTable
          columns={COLUMNS}
          rows={projects}
          rowKey="id"
          caption="Proyectos de inversión del centro"
          density="compact"
          loading={works.isValidating && projects.length > 0}
          keepDataWhileLoading
          selectedKey={selectedId ?? undefined}
          onSelect={openProject}
          rowTitle={() => "Abrir los datos de obra"}
          rowTone={(project) => (project.status === "in_progress" && licenceMissing(project) ? "danger" : undefined)}
          rowActionsVisible="always"
          rowActions={(project) => (
            <>
              <CocoaButton variant="plain" size="small" onClick={() => openProject(project)}>
                Obra
              </CocoaButton>
              <CocoaButton
                variant="plain"
                size="small"
                onClick={() => {
                  openProject(project);
                  setCapitalizeOpen(true);
                }}
                disabled={!canCapitalize(project, canManageAssets) || busy !== null}
                title={capitalizeBlockReason(project, canManageAssets) ?? "Dar de alta el inmovilizado con el coste ejecutado"}
              >
                Capitalizar
              </CocoaButton>
              {project.capitalizedFixedAssetId ? (
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("FixedAssetsScreen")} title="Abrir Finanzas › Proveedores › Inmovilizado">
                  Inmovilizado
                </CocoaButton>
              ) : null}
            </>
          )}
          emptyState={
            <CocoaState
              kind="empty"
              title="Sin proyectos de inversión"
              message="Crea el proyecto (propuesto), apruébalo y registra la licencia antes de iniciar la obra."
              primaryAction={canWork ? { label: "Nuevo proyecto", onClick: () => setProjectOpen(true) } : undefined}
            />
          }
        />
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={closeDrawer}
        title={selected ? `Obra · ${selected.name}` : "Obra"}
        subtitle={selected ? `${capexStatusLabel(selected.status)} · presupuesto ${formatMoney(selected.budget)} · ejecutado ${formatMoney(selected.executedAmount)} (${executionSourceBadge(selected).label})` : undefined}
        side={drawerSide}
        size="lg"
        focusKey={selected?.id}
        footer={
          selected && form ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeDrawer} disabled={busy !== null}>
                {ACTIONS.close}
              </CocoaButton>
              {selected.status === "proposed" ? (
                <CocoaButton variant="bordered" tone="neutral" onClick={() => void approve()} loading={busy === "approve"} disabled={!canApprove || busy !== null} title={canApprove ? "Aprobar el proyecto (nunca quien lo propuso)" : NO_APPROVE_PERMISSION}>
                  {ACTIONS.approve}
                </CocoaButton>
              ) : null}
              {selected.status !== "completed" && selected.status !== "cancelled" ? (
                <CocoaButton variant="bordered" tone="neutral" onClick={() => void submitWork("save")} loading={busy === "save"} disabled={!canWork || !formValid || busy !== null} title={canWork ? undefined : NO_WORK_PERMISSION}>
                  {ACTIONS.save}
                </CocoaButton>
              ) : null}
              {canStartWork(selected) ? (
                <CocoaButton variant="filled" tone="accent" onClick={() => void submitWork("start")} loading={busy === "start"} disabled={!canWork || !formValid || busy !== null} title={canWork ? "Pasa la obra a en curso; con licencia exigida hace falta el documento" : NO_WORK_PERMISSION}>
                  Iniciar obra
                </CocoaButton>
              ) : null}
              {canCompleteWork(selected) ? (
                <CocoaButton variant="filled" tone="accent" onClick={() => void submitWork("complete")} loading={busy === "complete"} disabled={!canWork || !formValid || busy !== null} title={canWork ? "Marca la obra como terminada (estado final)" : NO_WORK_PERMISSION}>
                  Terminar
                </CocoaButton>
              ) : null}
              {selected.status === "completed" && !selected.capitalizedFixedAssetId ? (
                <CocoaButton variant="filled" tone="accent" onClick={() => setCapitalizeOpen(true)} disabled={!canCapitalize(selected, canManageAssets) || busy !== null} title={capitalizeBlockReason(selected, canManageAssets) ?? "Dar de alta el inmovilizado con el coste ejecutado"}>
                  Capitalizar
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected && form ? (
          <div className="cocoa-stack" data-gap="4">
            <WorkStageFlow project={selected} />

            {capitalized ? (
              <CocoaCallout
                tone="success"
                role="status"
                title="Obra capitalizada en el inmovilizado"
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("FixedAssetsScreen")}>
                    Ver en Inmovilizado
                  </CocoaButton>
                }
              >
                {`Elemento «${capitalized.fixedAsset.name}» (cuenta ${capitalized.fixedAsset.accountCode ?? "21x"}) por ${formatMoney(capitalized.fixedAsset.acquisitionCost)} con fecha ${formatDay(capitalized.project.capitalizedAt)}.`}
              </CocoaCallout>
            ) : selected.capitalizedFixedAssetId ? (
              <CocoaCallout
                tone="success"
                title={`Capitalizada el ${formatDay(selected.capitalizedAt)}`}
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("FixedAssetsScreen")}>
                    Ver en Inmovilizado
                  </CocoaButton>
                }
              >
                El coste ejecutado (más el ICIO) ya figura como elemento del inmovilizado del centro.
              </CocoaCallout>
            ) : null}

            {workError ? (
              <CocoaCallout tone="danger" title="No se pudo completar la acción" role="alert">
                {workError}
              </CocoaCallout>
            ) : null}

            {selected.status === "in_progress" && licenceMissing(selected) ? (
              <CocoaCallout tone="danger" title="Obra en curso sin licencia de obras">
                Registra el documento de la licencia (categoría «Licencias» de la documentación del activo) y enlázalo aquí.
              </CocoaCallout>
            ) : null}

            <CocoaFormSection title="Ejecución" description="La cifra sale del diario del centro cuando hay asientos contabilizados en las cuentas de ejecución; si no, de las partidas del proyecto.">
              <ExecutionCell project={selected} />
              <ul className="c22-section__list" aria-label="Detalle de la ejecución">
                <li>
                  <span>Diario (cuentas {selected.executionAccountPrefixes ?? "21x / 23x por defecto"})</span>
                  <strong>{selected.executedAmountLedger === null ? "Sin líneas" : formatMoney(selected.executedAmountLedger)}</strong>
                </li>
                <li>
                  <span>Partidas del proyecto</span>
                  <strong>{formatMoney(selected.executedAmountItems)}</strong>
                </li>
                <li>
                  <span>Plazo</span>
                  <strong>{selected.startDate || selected.targetEndDate ? `${formatDay(selected.startDate)} → ${formatDay(selected.targetEndDate)}` : "Sin fechas"}</strong>
                </li>
              </ul>
            </CocoaFormSection>

            <CocoaFormSection title="Datos de obra" description={selected.status === "completed" ? "La obra está terminada: los datos quedan como registro." : undefined}>
              {assetId ? null : <p className="cocoa-note">{NO_ASSET_NOTE}</p>}
              <CocoaSwitch checked={form.linkAsset} onChange={(value) => patchForm({ linkAsset: value })} label="Enlazar a la ficha del activo inmobiliario (necesario para capitalizar)" size="small" disabled={!canWork || !assetId || selected.status === "completed"} />
              <CocoaFormRow columns={2}>
                <CocoaField label="Tipo de obra">
                  <CocoaSelect value={form.workKind} onChange={(value) => patchForm({ workKind: value as CapexWorkKind | "" })} options={WORK_KIND_OPTIONS} disabled={!canWork || selected.status === "completed"} />
                </CocoaField>
                <CocoaField label="ICIO" help="Impuesto sobre construcciones: se suma al coste capitalizado." error={formErrors.icioAmount}>
                  <CocoaInput value={form.icioAmount} onChange={(value) => patchForm({ icioAmount: value })} inputMode="decimal" placeholder="0,00" disabled={!canWork || selected.status === "completed"} error={Boolean(formErrors.icioAmount)} />
                </CocoaField>
              </CocoaFormRow>
              <CocoaField label="Cuentas de ejecución" help="Prefijos de cuenta separados por comas (211, 212, 231…); vacío = los de por defecto del inmovilizado." error={formErrors.executionAccountPrefixes}>
                <CocoaInput value={form.executionAccountPrefixes} onChange={(value) => patchForm({ executionAccountPrefixes: value })} placeholder="211, 212" disabled={!canWork || selected.status === "completed"} error={Boolean(formErrors.executionAccountPrefixes)} />
              </CocoaField>
            </CocoaFormSection>

            <CocoaFormSection title="Licencia de obras" description="Con licencia exigida no se puede iniciar la obra sin el documento de la licencia.">
              <CocoaSwitch checked={form.licenceRequired} onChange={(value) => patchForm({ licenceRequired: value })} label="La obra exige licencia de obras" size="small" disabled={!canWork || selected.status === "completed"} />
              <CocoaFormRow columns={2}>
                <CocoaField label="Documento de la licencia" help={licenceListUnavailable ? "El listado de documentos no está disponible: indica el identificador del documento." : "Documentos del activo de la categoría «Licencias»."}>
                  {licenceListUnavailable ? (
                    <CocoaInput value={form.licenceDocumentId} onChange={(value) => patchForm({ licenceDocumentId: value })} placeholder="Identificador del documento" disabled={!canWork || selected.status === "completed"} />
                  ) : (
                    <CocoaSelect value={form.licenceDocumentId} onChange={(value) => patchForm({ licenceDocumentId: value })} options={licenceOptions(licenceDocuments)} disabled={!canWork || selected.status === "completed"} />
                  )}
                </CocoaField>
                <CocoaField label="Concedida el">
                  <CocoaDatePicker value={form.licenceGrantedAt} onChange={(value) => patchForm({ licenceGrantedAt: value })} disabled={!canWork || selected.status === "completed"} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>
          </div>
        ) : (
          <CocoaState kind="loading" inline />
        )}
      </CocoaDrawer>

      <CocoaDialog
        open={capitalizeOpen && selected !== null}
        onClose={() => {
          if (busy !== "capitalize") setCapitalizeOpen(false);
        }}
        title={selected ? `Capitalizar «${selected.name}»` : "Capitalizar"}
        description={selected ? `Se da de alta un elemento del inmovilizado (${selected.workKind === "eficiencia_energetica" ? "212 instalaciones técnicas" : "211 construcciones"}) por ${formatMoney(selected.executedAmount)} ejecutados${selected.icioAmount ? ` más ${formatMoney(selected.icioAmount)} de ICIO` : ""}. No genera asiento: los 21x ya vienen del diario o de las facturas de inversión.` : undefined}
        confirmLabel="Capitalizar"
        onConfirm={() => void confirmCapitalize()}
        busy={busy === "capitalize"}
        confirmDisabled={!selected || !canCapitalize(selected, canManageAssets)}
      />

      <CocoaDrawer
        open={projectOpen}
        onClose={() => {
          if (!projectBusy) setProjectOpen(false);
        }}
        title="Nuevo proyecto de inversión"
        subtitle="Nace propuesto; lo aprueba una persona distinta con permiso de aprobación y después se registran los datos de obra."
        side={drawerSide}
        size="md"
        submitOnEnter
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setProjectOpen(false)} disabled={projectBusy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void createProject()} loading={projectBusy} disabled={!canWork || projectBusy || Object.keys(projectErrors).length > 0} title={canWork ? undefined : NO_WORK_PERMISSION}>
              Crear proyecto
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Nombre" required help="Como figura en la aprobación de la inversión (ej.: «Sustitución enfriadora»).">
            <CocoaInput value={projectForm.name} onChange={(value) => setProjectForm((current) => ({ ...current, name: value }))} maxLength={200} disabled={projectBusy} required />
          </CocoaField>
          <CocoaField label="Descripción" hint="opcional">
            <CocoaInput value={projectForm.description} onChange={(value) => setProjectForm((current) => ({ ...current, description: value }))} multiline rows={2} maxLength={2000} disabled={projectBusy} />
          </CocoaField>
          <CocoaFormRow columns={3}>
            <CocoaField label="Presupuesto" required error={projectForm.budget ? projectErrors.budget : undefined}>
              <CocoaInput value={projectForm.budget} onChange={(value) => setProjectForm((current) => ({ ...current, budget: value }))} inputMode="decimal" placeholder="0,00" disabled={projectBusy} error={Boolean(projectForm.budget && projectErrors.budget)} />
            </CocoaField>
            <CocoaField label="Inicio previsto">
              <CocoaDatePicker value={projectForm.startDate} onChange={(value) => setProjectForm((current) => ({ ...current, startDate: value }))} disabled={projectBusy} />
            </CocoaField>
            <CocoaField label="Fin previsto" error={projectErrors.targetEndDate}>
              <CocoaDatePicker value={projectForm.targetEndDate} onChange={(value) => setProjectForm((current) => ({ ...current, targetEndDate: value }))} min={projectForm.startDate || undefined} disabled={projectBusy} error={Boolean(projectErrors.targetEndDate)} />
            </CocoaField>
          </CocoaFormRow>
          {projectError ? (
            <CocoaCallout tone="danger" title="No se pudo crear el proyecto" role="alert">
              {projectError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export { ExecutionCell, LicenceBadge, WorkStageFlow };
export default RealEstateWorksScreen;
