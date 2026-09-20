// Finanzas › Activo inmobiliario › Inspecciones y seguros (Tanda ACT · lote
// ACT-F3, diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8
// «Inspecciones» y «Seguros y contratos»): una pantalla con dos segmentos.
//
//   Inspecciones   tabla de las inspecciones obligatorias del centro (tipo con
//                  su instalación, base legal, periodicidad, última, resultado,
//                  defectos abiertos, próxima con CocoaBadge del plazo, estado)
//                  y el CocoaCallout de riesgo cuando hay un acta `negativa` sin
//                  subsanar o una OCA de ascensor vencida (el ascensor queda
//                  fuera de servicio a las 24 h). Cajón de acta: resultado
//                  (obligatorio con la fecha), defectos con gravedad y plazo,
//                  fichero = documento enlazado (categoría «Inspecciones»),
//                  subsanación (fixedAt por defecto y correctedAt) y cierre;
//                  «Nueva inspección» con el catálogo de tipos (la base legal
//                  y la periodicidad por defecto las pone el API).
//   Seguros        pólizas (tipo, aseguradora, tomador, suma, prima, vigencia,
//                  renovación, estado con «Vence en N días» en ámbar dentro del
//                  preaviso) con cajón de alta / edición y cancelación, y las
//                  tenencias en lectura (histórico, contrato vigente, renta,
//                  revisión, preaviso, quién paga IBI / seguro / capex).
//
// Cocoa 22 sin estilos inline. Lectura con useApiData sobre
// realEstateInspectionsPath · realEstateInsurancesPath · realEstateTenuresPath
// y los documentos por categoría (realEstateDocumentsPath; si el listado no
// responde el selector degrada a un campo con el id). Escrituras por
// services/realEstateApi.ts (createRealEstateInspection ·
// updateRealEstateInspection · createRealEstateInsurance ·
// updateRealEstateInsurance). Permiso de escritura: canDo(useNavGate(),
// "real_estate.manage"); sin él todo se lee y los botones se deshabilitan con
// la razón. Los helpers puros y las piezas sin hooks van exportados para
// __tests__/RealEstateInspectionsScreen.test.mts.

import { useEffect, useMemo, useState } from "react";
import type { RealEstateDefectSeverity, RealEstateInspectionDefect, RealEstateInspectionKind, RealEstateInspectionResult, RealEstateInsuranceKind, RealEstatePolicyholder } from "@hotelos/shared";
import { REAL_ESTATE_DEFECT_SEVERITIES, REAL_ESTATE_INSPECTION_KINDS, REAL_ESTATE_INSPECTION_RESULTS, REAL_ESTATE_INSURANCE_KINDS, REAL_ESTATE_POLICYHOLDERS } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
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
import { useNavGate } from "../../navigation/useEnabledModules";
import { useActiveProperty } from "../../services/activeProperty";
import {
  createRealEstateInspection,
  createRealEstateInsurance,
  realEstateDocumentListQuery,
  realEstateDocumentsPath,
  realEstateInspectionsPath,
  realEstateInsurancesPath,
  realEstateTenuresPath,
  updateRealEstateInspection,
  updateRealEstateInsurance,
  type RealEstateDocumentRecord,
  type RealEstateInspectionPatchRequest,
  type RealEstateInspectionRecord,
  type RealEstateInspectionRequest,
  type RealEstateInsurancePatchRequest,
  type RealEstateInsuranceRecord,
  type RealEstateInsuranceRequest,
  type RealEstateTenureRecord
} from "../../services/realEstateApi";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { decimalInput } from "../payables/payables-helpers";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  DEFECT_SEVERITY_LABELS,
  INSPECTION_KIND_LABELS,
  INSPECTION_RESULT_LABELS,
  INSURANCE_KIND_LABELS,
  POLICYHOLDER_LABELS,
  capexResponsibilityLabel,
  catalogOptions,
  costPayerLabel,
  defectSeverityLabel,
  formatDay,
  formatMoney,
  formatPercent,
  inspectionDueStateLabel,
  inspectionDueStateTone,
  inspectionKindLabel,
  inspectionResultLabel,
  inspectionResultTone,
  inspectionStatusLabel,
  inspectionStatusTone,
  insuranceKindLabel,
  policyholderLabel,
  realEstateErrorMessage,
  rentKindLabel,
  rentReviewIndexLabel,
  tenureKindLabel,
  tenureRenewalLabel,
  tenureStatusLabel,
  tenureStatusTone
} from "./real-estate-helpers";

const HEADER = treeHeaderFor("RealEstateInspectionsScreen", { eyebrow: "Finanzas · Activo inmobiliario", title: "Inspecciones y seguros" });
const LOAD_ERROR = errorStateFor("las inspecciones del centro");
const EMPTY_INSPECTIONS: RealEstateInspectionRecord[] = [];
const EMPTY_INSURANCES: RealEstateInsuranceRecord[] = [];
const EMPTY_TENURES: RealEstateTenureRecord[] = [];
const EMPTY_DOCUMENTS: RealEstateDocumentRecord[] = [];

export const NO_MANAGE_PERMISSION = "Necesitas el permiso de gestión del activo inmobiliario («real_estate.manage»)";
/** Preaviso por defecto de una póliza (diseño §4 · insurances.service.ts DEFAULT_INSURANCE_NOTICE_DAYS). */
export const DEFAULT_INSURANCE_NOTICE_DAYS = 60;

export type ScreenSegment = "inspecciones" | "seguros";
export const SEGMENTS: ReadonlyArray<{ value: ScreenSegment; label: string }> = [
  { value: "inspecciones", label: "Inspecciones" },
  { value: "seguros", label: "Seguros y contratos" }
];

// ---------------------------------------------------------------------------
// Helpers puros · fechas
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Días de hoy a `day` (negativo si ya pasó); null sin fecha válida. */
export function daysUntil(day: string | null | undefined, today: string): number | null {
  if (!day || !ISO_DAY_RE.test(day) || !ISO_DAY_RE.test(today)) return null;
  const to = Date.parse(`${day}T00:00:00.000Z`);
  const from = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(to) || Number.isNaN(from)) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Helpers puros · inspecciones
// ---------------------------------------------------------------------------

export type InspectionLike = Pick<RealEstateInspectionRecord, "id" | "kind" | "status" | "result" | "defectsJson" | "dueState" | "installationRef" | "correctionDueAt" | "scheduledAt" | "nextDueAt">;

/** Defectos del acta sin `fixedAt`. */
export function openDefects(inspection: Pick<InspectionLike, "defectsJson">): RealEstateInspectionDefect[] {
  return (inspection.defectsJson ?? []).filter((defect) => !defect.fixedAt);
}

/** Acta negativa sin subsanar (estado con defectos y resultado negativa). */
export function isNegativeOpen(inspection: Pick<InspectionLike, "status" | "result">): boolean {
  return inspection.status === "con_defectos" && inspection.result === "negativa";
}

/** OCA de ascensor con el plazo vencido y sin cerrar: fuera de servicio a las 24 h (RD 355/2024). */
export function isElevatorOverdue(inspection: Pick<InspectionLike, "kind" | "status" | "dueState">): boolean {
  return inspection.kind === "oca_ascensor" && inspection.dueState === "vencida" && inspection.status !== "cerrada";
}

/** Fecha de referencia del plazo: programada → scheduledAt (o nextDueAt); después nextDueAt (misma regla que el API). */
export function inspectionDueDay(inspection: Pick<InspectionLike, "status" | "scheduledAt" | "nextDueAt">): string | null {
  return inspection.status === "programada" ? (inspection.scheduledAt ?? inspection.nextDueAt) : inspection.nextDueAt;
}

export type InspectionRisk<T extends InspectionLike = InspectionLike> = { negatives: T[]; elevatorsOverdue: T[] };

export function inspectionRisk<T extends InspectionLike>(inspections: ReadonlyArray<T>): InspectionRisk<T> {
  return { negatives: inspections.filter(isNegativeOpen), elevatorsOverdue: inspections.filter(isElevatorOverdue) };
}

function inspectionRef(inspection: Pick<InspectionLike, "kind" | "installationRef">): string {
  return `${inspectionKindLabel(inspection.kind)}${inspection.installationRef ? ` (${inspection.installationRef})` : ""}`;
}

/** Líneas del aviso de riesgo (vacío = sin riesgo). */
export function inspectionRiskLines(risk: InspectionRisk): string[] {
  return [
    ...risk.negatives.map((inspection) => `${inspectionRef(inspection)}: acta negativa sin subsanar${inspection.correctionDueAt ? ` (plazo ${formatDay(inspection.correctionDueAt)})` : ""}; ${plural(openDefects(inspection).length, "defecto abierto", "defectos abiertos")}.`),
    ...risk.elevatorsOverdue.map((inspection) => `${inspectionRef(inspection)}: inspección vencida${inspectionDueDay(inspection) ? ` el ${formatDay(inspectionDueDay(inspection))}` : ""}: el ascensor debe quedar fuera de servicio a las 24 horas.`)
  ];
}

export type InspectionKpis = { open: number; overdue: number; negatives: number; openDefects: number };

export function inspectionKpis(inspections: ReadonlyArray<InspectionLike>): InspectionKpis {
  const open = inspections.filter((inspection) => inspection.status !== "cerrada");
  return {
    open: open.length,
    overdue: open.filter((inspection) => inspection.dueState === "vencida").length,
    negatives: inspections.filter(isNegativeOpen).length,
    openDefects: open.reduce((acc, inspection) => acc + openDefects(inspection).length, 0)
  };
}

export function periodicityLabel(months: number | null | undefined): string {
  if (!months || months <= 0) return "Sin periodicidad";
  if (months % 12 === 0) return `Cada ${plural(months / 12, "año", "años")}`;
  return `Cada ${plural(months, "mes", "meses")}`;
}

/** Frase en español de un fallo (INSPECTION_INVALID_TRANSITION con las transiciones posibles, VALIDATION_ERROR…). */
export function inspectionsErrorMessage(error: unknown, fallback = "No se pudo guardar la inspección. Inténtalo de nuevo."): string {
  return realEstateErrorMessage(error, fallback);
}

// ---- Acta -------------------------------------------------------------------

export type DefectForm = { severity: RealEstateDefectSeverity; text: string; dueAt: string; fixedAt: string };

export function emptyDefect(): DefectForm {
  return { severity: "leve", text: "", dueAt: "", fixedAt: "" };
}

export type ActaForm = {
  performedAt: string;
  result: RealEstateInspectionResult | "";
  defects: DefectForm[];
  correctionDueAt: string;
  correctedAt: string;
  nextDueAt: string;
  documentId: string;
  providerName: string;
  scheduledAt: string;
  notes: string;
};

const DEFECT_RESULTS: ReadonlySet<string> = new Set(["condicionada", "negativa"]);

/** El resultado deja la inspección «con defectos» (condicionada o negativa). */
export function hasDefectResult(result: string | null | undefined): boolean {
  return DEFECT_RESULTS.has(result ?? "");
}

export function actaFormOf(inspection: RealEstateInspectionRecord): ActaForm {
  return {
    performedAt: inspection.performedAt ?? "",
    result: inspection.result ?? "",
    defects: (inspection.defectsJson ?? []).map((defect) => ({ severity: defect.severity, text: defect.text, dueAt: defect.dueAt ?? "", fixedAt: defect.fixedAt ?? "" })),
    correctionDueAt: inspection.correctionDueAt ?? "",
    correctedAt: inspection.correctedAt ?? "",
    nextDueAt: inspection.nextDueAt ?? "",
    documentId: inspection.documentId ?? "",
    providerName: inspection.providerName ?? "",
    scheduledAt: inspection.scheduledAt ?? "",
    notes: inspection.notes ?? ""
  };
}

export type ActaFormErrors = Partial<Record<"performedAt" | "result" | "defects", string>>;

/** Registrar el acta exige la fecha y el resultado; con defectos, cada defecto lleva su descripción. */
export function actaFormErrors(form: Pick<ActaForm, "performedAt" | "result" | "defects">): ActaFormErrors {
  const errors: ActaFormErrors = {};
  if (!form.performedAt) errors.performedAt = "Indica la fecha del acta.";
  if (!form.result) errors.result = "Indica el resultado del acta (favorable, con defectos, negativa o pendiente).";
  if (hasDefectResult(form.result) && form.defects.some((defect) => !defect.text.trim())) errors.defects = "Cada defecto necesita una descripción.";
  return errors;
}

function defectsBody(defects: ReadonlyArray<DefectForm>): NonNullable<RealEstateInspectionPatchRequest["defectsJson"]> {
  return defects.map((defect) => ({ severity: defect.severity, text: defect.text.trim(), dueAt: defect.dueAt || null, fixedAt: defect.fixedAt || null }));
}

/** Cuerpo de «Registrar acta»: fecha + resultado (+ defectos y plazo cuando el resultado los tiene), próxima, fichero y notas. */
export function actaPatchOf(form: ActaForm): RealEstateInspectionPatchRequest {
  const withDefects = hasDefectResult(form.result);
  return {
    performedAt: form.performedAt,
    result: form.result || null,
    defectsJson: withDefects ? defectsBody(form.defects) : null,
    ...(withDefects && form.correctionDueAt ? { correctionDueAt: form.correctionDueAt } : {}),
    ...(form.nextDueAt ? { nextDueAt: form.nextDueAt } : {}),
    documentId: form.documentId.trim() || null,
    providerName: form.providerName.trim() || null,
    notes: form.notes.trim() || null
  };
}

export type ClosureErrors = Partial<Record<"defects" | "correctedAt", string>>;

/** Cerrar una inspección con defectos exige la subsanación de todos (fixedAt) o, sin lista, la fecha de subsanación. */
export function closureErrors(form: Pick<ActaForm, "defects" | "correctedAt">): ClosureErrors {
  const errors: ClosureErrors = {};
  if (form.defects.some((defect) => !defect.fixedAt)) errors.defects = "Todos los defectos necesitan su fecha de subsanación.";
  if (form.defects.length === 0 && !form.correctedAt) errors.correctedAt = "Sin lista de defectos, indica la fecha de subsanación.";
  return errors;
}

/** Cuerpo de «Cerrar inspección» desde con defectos: defectos subsanados y fecha de subsanación. */
export function closurePatchOf(form: Pick<ActaForm, "defects" | "correctedAt" | "documentId" | "notes">): RealEstateInspectionPatchRequest {
  return {
    ...(form.defects.length > 0 ? { defectsJson: defectsBody(form.defects) } : {}),
    ...(form.correctedAt ? { correctedAt: form.correctedAt } : {}),
    documentId: form.documentId.trim() || null,
    notes: form.notes.trim() || null,
    status: "cerrada"
  };
}

/** Cuerpo de «Guardar» (campos sin transición). */
export function plainPatchOf(form: Pick<ActaForm, "providerName" | "scheduledAt" | "nextDueAt" | "documentId" | "notes">): RealEstateInspectionPatchRequest {
  return {
    providerName: form.providerName.trim() || null,
    scheduledAt: form.scheduledAt || null,
    nextDueAt: form.nextDueAt || null,
    documentId: form.documentId.trim() || null,
    notes: form.notes.trim() || null
  };
}

// ---- Nueva inspección -----------------------------------------------------------

export type InspectionForm = {
  kind: RealEstateInspectionKind | "";
  installationRef: string;
  providerName: string;
  scheduledAt: string;
  /** Vacío = la periodicidad por defecto del catálogo del API. */
  periodicityMonths: string;
  /** Vacío = la base legal por defecto del catálogo del API. */
  legalBasis: string;
  complianceRequirementCode: string;
  notes: string;
};

export function emptyInspectionForm(): InspectionForm {
  return { kind: "", installationRef: "", providerName: "", scheduledAt: "", periodicityMonths: "", legalBasis: "", complianceRequirementCode: "", notes: "" };
}

export type InspectionFormErrors = Partial<Record<"kind" | "periodicityMonths", string>>;

export function inspectionFormErrors(form: InspectionForm): InspectionFormErrors {
  const errors: InspectionFormErrors = {};
  if (!form.kind) errors.kind = "Elige el tipo de inspección.";
  if (form.periodicityMonths.trim() && !/^\d{1,3}$/.test(form.periodicityMonths.trim())) errors.periodicityMonths = "Meses entre 1 y 600 (número entero).";
  return errors;
}

export function inspectionBodyOf(form: InspectionForm): RealEstateInspectionRequest {
  return {
    kind: form.kind as RealEstateInspectionKind,
    ...(form.installationRef.trim() ? { installationRef: form.installationRef.trim() } : {}),
    ...(form.providerName.trim() ? { providerName: form.providerName.trim() } : {}),
    ...(form.scheduledAt ? { scheduledAt: form.scheduledAt } : {}),
    ...(form.periodicityMonths.trim() ? { periodicityMonths: Number(form.periodicityMonths.trim()) } : {}),
    ...(form.legalBasis.trim() ? { legalBasis: form.legalBasis.trim() } : {}),
    ...(form.complianceRequirementCode.trim() ? { complianceRequirementCode: form.complianceRequirementCode.trim() } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {})
  };
}

// ---------------------------------------------------------------------------
// Helpers puros · pólizas
// ---------------------------------------------------------------------------

export type InsuranceLike = Pick<RealEstateInsuranceRecord, "status" | "validUntil" | "noticeDays">;
export type InsuranceBadge = { label: string; tone: CocoaTone; daysLeft: number | null };

/** Estado de la póliza: cancelada gris · vencida roja · «Vence en N días» ámbar dentro del preaviso · vigente verde. */
export function insuranceBadge(insurance: InsuranceLike, today: string): InsuranceBadge {
  const daysLeft = daysUntil(insurance.validUntil, today);
  if (insurance.status === "cancelada") return { label: "Cancelada", tone: "neutral", daysLeft };
  if (insurance.status === "vencida" || (daysLeft !== null && daysLeft < 0)) return { label: `Vencida${daysLeft !== null && daysLeft < 0 ? ` hace ${plural(-daysLeft, "día", "días")}` : ""}`, tone: "danger", daysLeft };
  const notice = Math.max(0, insurance.noticeDays ?? DEFAULT_INSURANCE_NOTICE_DAYS);
  if (daysLeft !== null && daysLeft <= notice) return { label: daysLeft === 0 ? "Vence hoy" : `Vence en ${plural(daysLeft, "día", "días")}`, tone: "warning", daysLeft };
  return { label: "Vigente", tone: "success", daysLeft };
}

export function renewalLabel(insurance: Pick<RealEstateInsuranceRecord, "autoRenew" | "noticeDays">): string {
  return `${insurance.autoRenew ? "Automática" : "Manual"} · aviso ${plural(insurance.noticeDays, "día", "días")}`;
}

export type InsuranceForm = {
  kind: RealEstateInsuranceKind | "";
  insurerName: string;
  policyNumber: string;
  brokerName: string;
  policyholder: RealEstatePolicyholder;
  insuredSum: string;
  deductible: string;
  premiumAnnual: string;
  validFrom: string;
  validUntil: string;
  autoRenew: boolean;
  noticeDays: string;
  mandatoryBasis: string;
  documentId: string;
  notes: string;
};

export function emptyInsuranceForm(today: string): InsuranceForm {
  return { kind: "", insurerName: "", policyNumber: "", brokerName: "", policyholder: "sociedad", insuredSum: "", deductible: "", premiumAnnual: "", validFrom: today, validUntil: "", autoRenew: true, noticeDays: String(DEFAULT_INSURANCE_NOTICE_DAYS), mandatoryBasis: "", documentId: "", notes: "" };
}

export function insuranceFormOf(insurance: RealEstateInsuranceRecord): InsuranceForm {
  return {
    kind: insurance.kind,
    insurerName: insurance.insurerName,
    policyNumber: insurance.policyNumber,
    brokerName: insurance.brokerName ?? "",
    policyholder: insurance.policyholder,
    insuredSum: insurance.insuredSum ?? "",
    deductible: insurance.deductible ?? "",
    premiumAnnual: insurance.premiumAnnual ?? "",
    validFrom: insurance.validFrom,
    validUntil: insurance.validUntil,
    autoRenew: insurance.autoRenew,
    noticeDays: String(insurance.noticeDays),
    mandatoryBasis: insurance.mandatoryBasis ?? "",
    documentId: insurance.documentId ?? "",
    notes: insurance.notes ?? ""
  };
}

export type InsuranceFormErrors = Partial<Record<"kind" | "insurerName" | "policyNumber" | "validFrom" | "validUntil" | "insuredSum" | "deductible" | "premiumAnnual" | "noticeDays", string>>;

export function insuranceFormErrors(form: InsuranceForm): InsuranceFormErrors {
  const errors: InsuranceFormErrors = {};
  if (!form.kind) errors.kind = "Elige el tipo de póliza.";
  if (!form.insurerName.trim()) errors.insurerName = "Indica la aseguradora.";
  if (!form.policyNumber.trim()) errors.policyNumber = "Indica el número de póliza.";
  if (!form.validFrom) errors.validFrom = "Indica el inicio de la vigencia.";
  if (!form.validUntil) errors.validUntil = "Indica el fin de la vigencia.";
  else if (form.validFrom && form.validUntil < form.validFrom) errors.validUntil = "El fin de la vigencia no puede ser anterior al inicio.";
  for (const field of ["insuredSum", "deductible", "premiumAnnual"] as const) {
    if (form[field].trim() && decimalInput(form[field]) === null) errors[field] = "Importe no válido: usa como máximo dos decimales.";
  }
  if (!/^\d{1,3}$/.test(form.noticeDays.trim()) || Number(form.noticeDays) > 365) errors.noticeDays = "Días de preaviso entre 0 y 365.";
  return errors;
}

export function insuranceBodyOf(form: InsuranceForm): RealEstateInsuranceRequest {
  return {
    kind: form.kind as RealEstateInsuranceKind,
    insurerName: form.insurerName.trim(),
    policyNumber: form.policyNumber.trim(),
    brokerName: form.brokerName.trim() || null,
    policyholder: form.policyholder,
    insuredSum: decimalInput(form.insuredSum),
    deductible: decimalInput(form.deductible),
    premiumAnnual: decimalInput(form.premiumAnnual),
    validFrom: form.validFrom,
    validUntil: form.validUntil,
    autoRenew: form.autoRenew,
    noticeDays: Number(form.noticeDays.trim()),
    mandatoryBasis: form.mandatoryBasis.trim() || null,
    documentId: form.documentId.trim() || null,
    notes: form.notes.trim() || null
  };
}

// ---------------------------------------------------------------------------
// Helpers puros · tenencias (lectura)
// ---------------------------------------------------------------------------

export function tenureRentLabel(tenure: Pick<RealEstateTenureRecord, "kind" | "rentKind" | "rentMonthly" | "rentVariablePct" | "rentVariableBase">): string {
  if (tenure.kind === "propiedad") return "Sin renta (propiedad)";
  const parts: string[] = [];
  if (tenure.rentMonthly) parts.push(`${formatMoney(tenure.rentMonthly)}/mes`);
  if (tenure.rentVariablePct) parts.push(`${formatPercent(tenure.rentVariablePct)} ${tenure.rentVariableBase === "gop" ? "del GOP" : "de los ingresos"}`);
  return parts.length > 0 ? `${rentKindLabel(tenure.rentKind)} · ${parts.join(" + ")}` : rentKindLabel(tenure.rentKind);
}

export function tenureReviewLabel(tenure: Pick<RealEstateTenureRecord, "rentReviewIndex" | "rentReviewMonth">): string {
  if (!tenure.rentReviewIndex || tenure.rentReviewIndex === "ninguno") return "Sin revisión";
  return tenure.rentReviewMonth ? `${rentReviewIndexLabel(tenure.rentReviewIndex)} · mes ${tenure.rentReviewMonth}` : rentReviewIndexLabel(tenure.rentReviewIndex);
}

export function tenureNoticeLabel(tenure: Pick<RealEstateTenureRecord, "noticeMonths" | "renewal">): string {
  const notice = tenure.noticeMonths ? `Preaviso ${plural(tenure.noticeMonths, "mes", "meses")}` : "Sin preaviso";
  return `${notice} · renovación ${tenureRenewalLabel(tenure.renewal).toLowerCase()}`;
}

export function tenurePayersLabel(tenure: Pick<RealEstateTenureRecord, "ibiPayer" | "insurancePayer" | "capexResponsibility">): string {
  return `IBI: ${costPayerLabel(tenure.ibiPayer).toLowerCase()} · seguro: ${costPayerLabel(tenure.insurancePayer).toLowerCase()} · capex: ${capexResponsibilityLabel(tenure.capexResponsibility).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Piezas de presentación (sin hooks: se renderizan en los tests). Se declaran sin
// `export` y salen en la lista nombrada del final: scripts/check-sidebar-coverage.mjs
// toma el PRIMER `export function <PascalCase>` del fichero como la pantalla.
// ---------------------------------------------------------------------------

/** Aviso de riesgo legal: negativa sin subsanar o ascensor vencido; null sin riesgo. */
function InspectionRiskCallout({ inspections }: { inspections: ReadonlyArray<InspectionLike> }) {
  const risk = inspectionRisk(inspections);
  const lines = inspectionRiskLines(risk);
  if (lines.length === 0) return null;
  return (
    <CocoaCallout tone="danger" role="alert" title={risk.negatives.length > 0 && risk.elevatorsOverdue.length > 0 ? "Riesgo: acta negativa sin subsanar y ascensor con la inspección vencida" : risk.negatives.length > 0 ? "Riesgo: acta negativa sin subsanar" : "Riesgo: ascensor con la inspección vencida"}>
      <ul className="c22-section__list">
        {lines.map((line, index) => (
          <li key={index}>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </CocoaCallout>
  );
}

function InsuranceStatusBadge({ insurance, today }: { insurance: InsuranceLike; today: string }) {
  const badge = insuranceBadge(insurance, today);
  return (
    <CocoaBadge tone={badge.tone} variant={badge.tone === "neutral" ? "outline" : "tinted"} size="small" uppercase={false} title={`Vigencia hasta ${formatDay(insurance.validUntil)}`}>
      {badge.label}
    </CocoaBadge>
  );
}

function InspectionDueBadge({ inspection }: { inspection: Pick<InspectionLike, "status" | "dueState" | "scheduledAt" | "nextDueAt"> }) {
  const day = inspectionDueDay(inspection);
  return (
    <div className="cocoa-stack" data-gap="1">
      <span>{day ? formatDay(day) : "—"}</span>
      <CocoaBadge tone={inspection.status === "cerrada" ? "neutral" : inspectionDueStateTone(inspection.dueState)} variant={inspection.status === "cerrada" ? "outline" : "tinted"} size="small" uppercase={false}>
        {inspection.status === "cerrada" ? inspectionStatusLabel("cerrada") : inspectionDueStateLabel(inspection.dueState)}
      </CocoaBadge>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columnas
// ---------------------------------------------------------------------------

const INSPECTION_COLUMNS: CocoaTableColumn<RealEstateInspectionRecord>[] = [
  {
    key: "kind",
    label: "Tipo",
    render: (row) => (
      <div className="cocoa-stack" data-gap="1">
        <strong>{inspectionKindLabel(row.kind)}</strong>
        <span className="cocoa-caption">{row.installationRef ?? "Sin instalación"}</span>
      </div>
    )
  },
  { key: "legalBasis", label: "Base legal", showFrom: "laptop", truncate: 36, render: (row) => row.legalBasis ?? "—" },
  { key: "periodicity", label: "Periodicidad", hideOnNarrow: true, fit: true, render: (row) => periodicityLabel(row.periodicityMonths) },
  { key: "performedAt", label: "Última", hideOnNarrow: true, fit: true, render: (row) => (row.performedAt ? formatDay(row.performedAt) : "—") },
  {
    key: "result",
    label: "Resultado",
    fit: true,
    render: (row) =>
      row.result ? (
        <CocoaBadge tone={inspectionResultTone(row.result)} variant="tinted" size="small" uppercase={false}>
          {inspectionResultLabel(row.result)}
        </CocoaBadge>
      ) : (
        "—"
      )
  },
  {
    key: "defects",
    label: "Defectos abiertos",
    align: "right",
    hideOnNarrow: true,
    render: (row) => {
      const count = openDefects(row).length;
      return count > 0 ? (
        <CocoaBadge tone={row.result === "negativa" ? "danger" : "warning"} variant="tinted" size="small">
          {number(count)}
        </CocoaBadge>
      ) : (
        number(0)
      );
    }
  },
  { key: "due", label: "Próxima", fit: true, render: (row) => <InspectionDueBadge inspection={row} /> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={inspectionStatusTone(row.status)} variant="tinted" size="small" uppercase={false}>
        {inspectionStatusLabel(row.status)}
      </CocoaBadge>
    )
  }
];

function insuranceColumns(today: string): CocoaTableColumn<RealEstateInsuranceRecord>[] {
  return [
    {
      key: "kind",
      label: "Tipo",
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{insuranceKindLabel(row.kind)}</strong>
          <span className="cocoa-caption cocoa-mono">{row.policyNumber}</span>
        </div>
      )
    },
    {
      key: "insurer",
      label: "Aseguradora",
      hideOnNarrow: true,
      render: (row) => (
        <div className="cocoa-stack" data-gap="1">
          <span>{row.insurerName}</span>
          {row.brokerName ? <span className="cocoa-caption">{`Corredor: ${row.brokerName}`}</span> : null}
        </div>
      )
    },
    { key: "policyholder", label: "Tomador", showFrom: "laptop", fit: true, render: (row) => policyholderLabel(row.policyholder) },
    { key: "insuredSum", label: "Suma asegurada", align: "right", hideOnNarrow: true, render: (row) => formatMoney(row.insuredSum) },
    { key: "premium", label: "Prima anual", align: "right", render: (row) => formatMoney(row.premiumAnnual) },
    { key: "validity", label: "Vigencia", fit: true, render: (row) => `${formatDay(row.validFrom)} → ${formatDay(row.validUntil)}` },
    { key: "renewal", label: "Renovación", showFrom: "laptop", fit: true, render: (row) => renewalLabel(row) },
    { key: "status", label: "Estado", fit: true, render: (row) => <InsuranceStatusBadge insurance={row} today={today} /> }
  ];
}

const TENURE_COLUMNS: CocoaTableColumn<RealEstateTenureRecord>[] = [
  {
    key: "kind",
    label: "Tenencia",
    render: (row) => (
      <div className="cocoa-stack" data-gap="1">
        <strong>{tenureKindLabel(row.kind)}</strong>
        <span className="cocoa-caption">{row.counterpartyName ?? "Sin contraparte"}{row.brandName ? ` · ${row.brandName}` : ""}</span>
      </div>
    )
  },
  { key: "validity", label: "Vigencia", fit: true, render: (row) => `${formatDay(row.startDate)} → ${row.endDate ? formatDay(row.endDate) : "indefinida"}` },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => (
      <CocoaBadge tone={tenureStatusTone(row.status)} variant="tinted" size="small" uppercase={false}>
        {tenureStatusLabel(row.status)}
      </CocoaBadge>
    )
  },
  { key: "rent", label: "Renta", hideOnNarrow: true, render: (row) => tenureRentLabel(row) },
  { key: "review", label: "Revisión", showFrom: "laptop", fit: true, render: (row) => tenureReviewLabel(row) },
  { key: "notice", label: "Preaviso", showFrom: "laptop", render: (row) => tenureNoticeLabel(row) },
  { key: "payers", label: "Quién paga", showFrom: "desktop", render: (row) => tenurePayersLabel(row) }
];

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

const KIND_OPTIONS = [{ value: "", label: "Elige el tipo" }, ...catalogOptions(REAL_ESTATE_INSPECTION_KINDS, INSPECTION_KIND_LABELS)];
const RESULT_OPTIONS = [{ value: "", label: "Sin resultado" }, ...catalogOptions(REAL_ESTATE_INSPECTION_RESULTS, INSPECTION_RESULT_LABELS)];
const SEVERITY_OPTIONS = catalogOptions(REAL_ESTATE_DEFECT_SEVERITIES, DEFECT_SEVERITY_LABELS);
const INSURANCE_KIND_OPTIONS = [{ value: "", label: "Elige el tipo" }, ...catalogOptions(REAL_ESTATE_INSURANCE_KINDS, INSURANCE_KIND_LABELS)];
const POLICYHOLDER_OPTIONS = catalogOptions(REAL_ESTATE_POLICYHOLDERS, POLICYHOLDER_LABELS);

function documentOptions(documents: ReadonlyArray<RealEstateDocumentRecord>, none: string): Array<{ value: string; label: string }> {
  return [{ value: "", label: none }, ...documents.map((doc) => ({ value: doc.id, label: `${doc.title}${doc.version > 1 ? ` (v${doc.version})` : ""}${doc.hasFile ? "" : " · sin fichero"}` }))];
}

type PageState = "loading" | "error" | "ready";

function pageStateOf(state: { loading: boolean; error: string | null; data: unknown }): PageState {
  if (state.loading && !state.data) return "loading";
  if (state.error && !state.data) return "error";
  return "ready";
}

type DocumentPickerProps = { label: string; value: string; onChange: (value: string) => void; documents: ReadonlyArray<RealEstateDocumentRecord>; unavailable: boolean; category: string; disabled: boolean };

/** Selector del documento enlazado; degrada a un campo con el id cuando el listado no responde. */
function DocumentPicker({ label, value, onChange, documents, unavailable, category, disabled }: DocumentPickerProps) {
  return (
    <CocoaField label={label} help={unavailable ? "El listado de documentos no está disponible: indica el identificador del documento." : `Documentos del activo de la categoría «${category}».`}>
      {unavailable ? <CocoaInput value={value} onChange={onChange} placeholder="Identificador del documento" disabled={disabled} /> : <CocoaSelect value={value} onChange={onChange} options={documentOptions(documents, "Sin documento")} disabled={disabled} />}
    </CocoaField>
  );
}

export function RealEstateInspectionsScreen() {
  const { propertyId, propertyName } = useActiveProperty();
  const canManage = canDo(useNavGate(), "real_estate.manage");
  const phone = useViewportTier() === "phone";
  const { showToast } = useToast();
  const today = todayIso();

  const [segment, setSegment] = useState<ScreenSegment>("inspecciones");

  const inspectionsState = useApiData<RealEstateInspectionRecord[]>(realEstateInspectionsPath(propertyId));
  const insurancesState = useApiData<RealEstateInsuranceRecord[]>(realEstateInsurancesPath(propertyId));
  const tenuresState = useApiData<RealEstateTenureRecord[]>(realEstateTenuresPath(propertyId), { enabled: segment === "seguros" });

  const inspections = inspectionsState.data ?? EMPTY_INSPECTIONS;
  const insurances = insurancesState.data ?? EMPTY_INSURANCES;
  const tenures = tenuresState.data ?? EMPTY_TENURES;
  const kpis = useMemo(() => inspectionKpis(inspections), [inspections]);
  const expiringInsurances = useMemo(() => insurances.filter((insurance) => insuranceBadge(insurance, today).tone === "warning").length, [insurances, today]);
  const pageState = pageStateOf(inspectionsState);

  // ── Inspección seleccionada (acta · subsanación · cierre) ──────────────────
  const [selectedInspectionId, setSelectedInspectionId] = useState<string | null>(null);
  const selectedInspection = useMemo(() => inspections.find((row) => row.id === selectedInspectionId) ?? null, [inspections, selectedInspectionId]);
  const [acta, setActa] = useState<ActaForm | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState<"save" | "acta" | "close" | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);

  useEffect(() => {
    setActa(selectedInspection ? actaFormOf(selectedInspection) : null);
    setInspectionError(null);
  }, [selectedInspection]);

  const inspectionDocuments = useApiData<RealEstateDocumentRecord[]>(realEstateDocumentsPath(propertyId), { query: realEstateDocumentListQuery({ category: "inspecciones" }), enabled: selectedInspection !== null });
  const insuranceDocuments = useApiData<RealEstateDocumentRecord[]>(realEstateDocumentsPath(propertyId), { query: realEstateDocumentListQuery({ category: "seguros" }) , enabled: segment === "seguros" });

  const actaErrors = acta ? actaFormErrors(acta) : {};
  const closeErrors = acta ? closureErrors(acta) : {};

  function patchActa(patch: Partial<ActaForm>) {
    setActa((current) => (current ? { ...current, ...patch } : current));
  }

  function patchDefect(index: number, patch: Partial<DefectForm>) {
    setActa((current) => (current ? { ...current, defects: current.defects.map((defect, i) => (i === index ? { ...defect, ...patch } : defect)) } : current));
  }

  async function submitInspection(kind: "save" | "acta" | "close") {
    if (!selectedInspection || !acta) return;
    setInspectionBusy(kind);
    setInspectionError(null);
    try {
      const body: RealEstateInspectionPatchRequest = kind === "acta" ? actaPatchOf(acta) : kind === "close" ? (selectedInspection.status === "con_defectos" ? closurePatchOf(acta) : { status: "cerrada" }) : plainPatchOf(acta);
      const updated = await updateRealEstateInspection(selectedInspection.id, body, propertyId);
      showToast(kind === "acta" ? `Acta de ${inspectionKindLabel(updated.kind)} registrada (${inspectionResultLabel(updated.result).toLowerCase()}).` : kind === "close" ? `Inspección de ${inspectionKindLabel(updated.kind)} cerrada${updated.nextDueAt ? `; la siguiente queda programada para el ${formatDay(updated.nextDueAt)}` : ""}.` : "Inspección guardada.", { variant: "success" });
      inspectionsState.refresh();
      if (kind !== "save") setSelectedInspectionId(null);
      else setActa(actaFormOf(updated));
    } catch (err) {
      setInspectionError(inspectionsErrorMessage(err));
    } finally {
      setInspectionBusy(null);
    }
  }

  // ── Nueva inspección ───────────────────────────────────────────────────────
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState<InspectionForm>(emptyInspectionForm);
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const newErrors = inspectionFormErrors(newForm);

  async function createInspection() {
    if (Object.keys(newErrors).length > 0) return;
    setNewBusy(true);
    setNewError(null);
    try {
      const created = await createRealEstateInspection(inspectionBodyOf(newForm), propertyId);
      setNewOpen(false);
      setNewForm(emptyInspectionForm());
      showToast(`Inspección de ${inspectionKindLabel(created.kind)} programada.`, { variant: "success" });
      inspectionsState.refresh();
    } catch (err) {
      setNewError(inspectionsErrorMessage(err, "No se pudo programar la inspección. Inténtalo de nuevo."));
    } finally {
      setNewBusy(false);
    }
  }

  // ── Pólizas ────────────────────────────────────────────────────────────────
  const [insuranceOpen, setInsuranceOpen] = useState(false);
  const [editingInsuranceId, setEditingInsuranceId] = useState<string | null>(null);
  const [insuranceForm, setInsuranceForm] = useState<InsuranceForm>(() => emptyInsuranceForm(today));
  const [insuranceBusy, setInsuranceBusy] = useState<"save" | "cancel" | null>(null);
  const [insuranceError, setInsuranceError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<RealEstateInsuranceRecord | null>(null);
  const insuranceErrors = insuranceFormErrors(insuranceForm);
  const editingInsurance = useMemo(() => insurances.find((row) => row.id === editingInsuranceId) ?? null, [insurances, editingInsuranceId]);

  function openInsurance(insurance: RealEstateInsuranceRecord | null) {
    setEditingInsuranceId(insurance?.id ?? null);
    setInsuranceForm(insurance ? insuranceFormOf(insurance) : emptyInsuranceForm(today));
    setInsuranceError(null);
    setInsuranceOpen(true);
  }

  function patchInsurance(patch: Partial<InsuranceForm>) {
    setInsuranceForm((current) => ({ ...current, ...patch }));
  }

  async function saveInsurance() {
    if (Object.keys(insuranceErrors).length > 0) return;
    setInsuranceBusy("save");
    setInsuranceError(null);
    try {
      const body = insuranceBodyOf(insuranceForm);
      const saved = editingInsuranceId ? await updateRealEstateInsurance(editingInsuranceId, body as RealEstateInsurancePatchRequest, propertyId) : await createRealEstateInsurance(body, propertyId);
      setInsuranceOpen(false);
      showToast(`Póliza ${saved.policyNumber} (${insuranceKindLabel(saved.kind).toLowerCase()}) guardada.`, { variant: "success" });
      insurancesState.refresh();
    } catch (err) {
      setInsuranceError(inspectionsErrorMessage(err, "No se pudo guardar la póliza. Inténtalo de nuevo."));
    } finally {
      setInsuranceBusy(null);
    }
  }

  async function cancelInsurance() {
    if (!cancelTarget) return;
    setInsuranceBusy("cancel");
    try {
      await updateRealEstateInsurance(cancelTarget.id, { status: "cancelada" }, propertyId);
      showToast(`Póliza ${cancelTarget.policyNumber} cancelada.`, { variant: "success" });
      setCancelTarget(null);
      setInsuranceOpen(false);
      insurancesState.refresh();
    } catch (err) {
      showToast(inspectionsErrorMessage(err, "No se pudo cancelar la póliza."), { variant: "error" });
    } finally {
      setInsuranceBusy(null);
    }
  }

  const drawerSide = phone ? "bottom" : "right";
  const inspectionDocsUnavailable = Boolean(inspectionDocuments.error) && !inspectionDocuments.data;
  const insuranceDocsUnavailable = Boolean(insuranceDocuments.error) && !insuranceDocuments.data;
  const inspectionReadOnly = !canManage || selectedInspection?.status === "cerrada";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Inspecciones obligatorias (OCA, RITE, gas, legionela, IEE/ITE, CEE…) con su acta y sus defectos, pólizas del inmueble y las tenencias del centro."
      tabs={SEGMENTS.map((entry) => ({ value: entry.value, label: entry.label }))}
      activeTab={segment}
      onTabChange={(value) => setSegment(value as ScreenSegment)}
      actions={
        <>
          {inspectionsState.error && inspectionsState.data ? (
            <CocoaBadge tone="danger" title={inspectionsState.error}>
              {STATUS_LABELS.loadError}
            </CocoaBadge>
          ) : null}
          <CocoaButton
            variant="bordered"
            tone="neutral"
            size="small"
            onClick={() => {
              inspectionsState.refresh();
              insurancesState.refresh();
              if (segment === "seguros") tenuresState.refresh();
            }}
            title={ACTIONS.refresh}
          >
            {ACTIONS.refresh}
          </CocoaButton>
          {segment === "inspecciones" ? (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setNewOpen(true)} disabled={!canManage} title={canManage ? undefined : NO_MANAGE_PERMISSION}>
              Nueva inspección
            </CocoaButton>
          ) : (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => openInsurance(null)} disabled={!canManage} title={canManage ? undefined : NO_MANAGE_PERMISSION}>
              Nueva póliza
            </CocoaButton>
          )}
        </>
      }
      state={pageState}
      error={{ title: LOAD_ERROR.title, message: inspectionsState.error ?? LOAD_ERROR.message, onRetry: () => inspectionsState.refresh() }}
      commands={[
        { id: "real-estate-inspection-new", label: "Programar una inspección", run: () => setNewOpen(true) },
        { id: "real-estate-insurance-new", label: "Registrar una póliza", run: () => openInsurance(null) },
        { id: "real-estate-inspections-refresh", label: "Actualizar inspecciones y pólizas", run: () => { inspectionsState.refresh(); insurancesState.refresh(); } }
      ]}
    >
      <CocoaKpiStrip aria-label="Indicadores de inspecciones y seguros">
        <CocoaKpi label="Inspecciones abiertas" value={number(kpis.open)} caption="programadas, realizadas o con defectos" polarity="neutral" status="ok" />
        <CocoaKpi label="Vencidas" value={number(kpis.overdue)} caption="con el plazo pasado" polarity="neutral" status={kpis.overdue > 0 ? "critical" : "ok"} />
        <CocoaKpi label="Defectos abiertos" value={number(kpis.openDefects)} caption={kpis.negatives > 0 ? plural(kpis.negatives, "acta negativa sin subsanar", "actas negativas sin subsanar") : "sin actas negativas"} polarity="neutral" status={kpis.negatives > 0 ? "critical" : kpis.openDefects > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Pólizas por vencer" value={number(expiringInsurances)} caption="dentro del preaviso" polarity="neutral" status={expiringInsurances > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      {!canManage ? <p className="cocoa-note">{NO_MANAGE_PERMISSION} para programar inspecciones, registrar actas o pólizas: todo se puede consultar.</p> : null}

      {segment === "inspecciones" ? (
        <>
          <InspectionRiskCallout inspections={inspections} />
          <CocoaSection title="Inspecciones obligatorias" meta={inspectionsState.data ? plural(inspections.length, "inspección", "inspecciones") : undefined}>
            <CocoaTable
              columns={INSPECTION_COLUMNS}
              rows={inspections}
              rowKey="id"
              caption="Inspecciones obligatorias del centro"
              density="compact"
              loading={inspectionsState.isValidating && inspections.length > 0}
              keepDataWhileLoading
              selectedKey={selectedInspectionId ?? undefined}
              onSelect={(row) => setSelectedInspectionId(row.id)}
              rowTitle={() => "Abrir el acta"}
              rowTone={(row) => (isNegativeOpen(row) || isElevatorOverdue(row) ? "danger" : row.dueState === "vencida" && row.status !== "cerrada" ? "warning" : undefined)}
              rowActionsVisible="always"
              rowActions={(row) => (
                <CocoaButton variant="plain" size="small" onClick={() => setSelectedInspectionId(row.id)}>
                  {row.status === "programada" ? "Acta" : row.status === "con_defectos" ? "Subsanar" : ACTIONS.view}
                </CocoaButton>
              )}
              emptyState={
                <CocoaState
                  kind="empty"
                  title="Sin inspecciones programadas"
                  message="Programa la primera (OCA de ascensor, baja tensión, RITE, legionela…): la base legal y la periodicidad se rellenan solas."
                  primaryAction={canManage ? { label: "Nueva inspección", onClick: () => setNewOpen(true) } : undefined}
                />
              }
            />
          </CocoaSection>
        </>
      ) : (
        <>
          <CocoaSection title="Pólizas" meta={insurancesState.data ? plural(insurances.length, "póliza", "pólizas") : undefined}>
            {insurancesState.error && !insurancesState.data ? (
              <CocoaState kind="error" inline title="No se pudieron cargar las pólizas" message={insurancesState.error} onRetry={() => insurancesState.refresh()} />
            ) : (
              <CocoaTable
                columns={insuranceColumns(today)}
                rows={insurances}
                rowKey="id"
                caption="Pólizas del inmueble"
                density="compact"
                loading={insurancesState.loading || (insurancesState.isValidating && insurances.length > 0)}
                keepDataWhileLoading
                selectedKey={editingInsuranceId ?? undefined}
                onSelect={(row) => openInsurance(row)}
                rowTitle={() => "Abrir la póliza"}
                rowTone={(row) => {
                  const tone = insuranceBadge(row, today).tone;
                  return tone === "danger" || tone === "warning" ? tone : undefined;
                }}
                rowActionsVisible="always"
                rowActions={(row) => (
                  <>
                    <CocoaButton variant="plain" size="small" onClick={() => openInsurance(row)}>
                      {canManage ? ACTIONS.edit : ACTIONS.view}
                    </CocoaButton>
                    {row.status !== "cancelada" ? (
                      <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => setCancelTarget(row)} disabled={!canManage || insuranceBusy !== null} title={canManage ? "Cancelar la póliza (queda en el histórico)" : NO_MANAGE_PERMISSION}>
                        Cancelar póliza
                      </CocoaButton>
                    ) : null}
                  </>
                )}
                emptyState={
                  <CocoaState
                    kind="empty"
                    title="Sin pólizas registradas"
                    message="Registra la responsabilidad civil, el multirriesgo o la pérdida de beneficios con su vigencia: avisamos antes del vencimiento."
                    primaryAction={canManage ? { label: "Nueva póliza", onClick: () => openInsurance(null) } : undefined}
                  />
                }
              />
            )}
          </CocoaSection>

          <CocoaSection title="Tenencias" meta={tenuresState.data ? plural(tenures.length, "tenencia", "tenencias") : undefined} footer={<span className="cocoa-note">Lectura: la tenencia (propiedad, arrendamiento, gestión, franquicia…) se edita en la ficha del activo.</span>}>
            {tenuresState.error && !tenuresState.data ? (
              <CocoaState kind="error" inline title="No se pudieron cargar las tenencias" message={tenuresState.error} onRetry={() => tenuresState.refresh()} />
            ) : (
              <CocoaTable
                columns={TENURE_COLUMNS}
                rows={tenures}
                rowKey="id"
                caption="Tenencias del centro (histórico y contrato vigente)"
                density="compact"
                loading={tenuresState.loading}
                rowTone={(row) => (row.status === "vigente" ? "success" : row.status === "vencido" ? "danger" : undefined)}
                emptyState={<CocoaState kind="empty" inline title="Sin tenencias registradas" message="La ficha del activo crea la tenencia de propiedad al nacer; los contratos de arrendamiento o gestión se añaden allí." />}
              />
            )}
          </CocoaSection>
        </>
      )}

      {/* ── Cajón del acta ─────────────────────────────────────────────────── */}
      <CocoaDrawer
        open={selectedInspection !== null}
        onClose={() => {
          if (!inspectionBusy) setSelectedInspectionId(null);
        }}
        title={selectedInspection ? `${inspectionKindLabel(selectedInspection.kind)}${selectedInspection.installationRef ? ` · ${selectedInspection.installationRef}` : ""}` : "Inspección"}
        subtitle={selectedInspection ? `${inspectionStatusLabel(selectedInspection.status)} · ${periodicityLabel(selectedInspection.periodicityMonths).toLowerCase()}${selectedInspection.legalBasis ? ` · ${selectedInspection.legalBasis}` : ""}` : undefined}
        side={drawerSide}
        size="lg"
        focusKey={selectedInspection?.id}
        footer={
          selectedInspection && acta ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedInspectionId(null)} disabled={inspectionBusy !== null}>
                {ACTIONS.close}
              </CocoaButton>
              {!inspectionReadOnly ? (
                <CocoaButton variant="bordered" tone="neutral" onClick={() => void submitInspection("save")} loading={inspectionBusy === "save"} disabled={inspectionBusy !== null}>
                  {ACTIONS.save}
                </CocoaButton>
              ) : null}
              {selectedInspection.status === "programada" && canManage ? (
                <CocoaButton variant="filled" tone="accent" onClick={() => void submitInspection("acta")} loading={inspectionBusy === "acta"} disabled={inspectionBusy !== null || Object.keys(actaErrors).length > 0} title={Object.keys(actaErrors).length > 0 ? Object.values(actaErrors).join(" ") : "Registra el acta: favorable deja la inspección realizada; con defectos o negativa, con defectos"}>
                  Registrar acta
                </CocoaButton>
              ) : null}
              {selectedInspection.status === "con_defectos" && canManage ? (
                <CocoaButton variant="filled" tone="accent" onClick={() => void submitInspection("close")} loading={inspectionBusy === "close"} disabled={inspectionBusy !== null || Object.keys(closeErrors).length > 0} title={Object.keys(closeErrors).length > 0 ? Object.values(closeErrors).join(" ") : "Cierra la inspección subsanada y programa la siguiente"}>
                  Cerrar inspección
                </CocoaButton>
              ) : null}
              {selectedInspection.status === "realizada" && canManage ? (
                <CocoaButton variant="filled" tone="accent" onClick={() => void submitInspection("close")} loading={inspectionBusy === "close"} disabled={inspectionBusy !== null} title="Archiva el acta favorable">
                  Cerrar
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selectedInspection && acta ? (
          <div className="cocoa-stack" data-gap="4">
            {inspectionError ? (
              <CocoaCallout tone="danger" title="No se pudo completar la acción" role="alert">
                {inspectionError}
              </CocoaCallout>
            ) : null}
            {isNegativeOpen(selectedInspection) || isElevatorOverdue(selectedInspection) ? <InspectionRiskCallout inspections={[selectedInspection]} /> : null}

            <ul className="c22-section__list" aria-label="Datos de la inspección">
              <li>
                <span>Plazo</span>
                <InspectionDueBadge inspection={selectedInspection} />
              </li>
              <li>
                <span>Proveedor</span>
                <strong>{selectedInspection.providerName ?? "—"}</strong>
              </li>
              {selectedInspection.complianceRequirementCode ? (
                <li>
                  <span>Obligación de cumplimiento</span>
                  <strong className="cocoa-mono">{selectedInspection.complianceRequirementCode}</strong>
                </li>
              ) : null}
            </ul>

            {selectedInspection.status === "programada" ? (
              <CocoaFormSection title="Acta" description="La fecha y el resultado son obligatorios. Favorable deja la inspección realizada; con defectos o negativa exige la lista de defectos con su plazo.">
                <CocoaFormRow columns={2}>
                  <CocoaField label="Fecha del acta" required error={acta.performedAt ? undefined : actaErrors.performedAt}>
                    <CocoaDatePicker value={acta.performedAt} onChange={(value) => patchActa({ performedAt: value })} max={today} disabled={inspectionReadOnly} />
                  </CocoaField>
                  <CocoaField label="Resultado" required error={actaErrors.result} help="Pendiente deja la inspección programada con la fecha anotada.">
                    <CocoaSelect value={acta.result} onChange={(value) => patchActa({ result: value as RealEstateInspectionResult | "" })} options={RESULT_OPTIONS} disabled={inspectionReadOnly} error={Boolean(actaErrors.result)} />
                  </CocoaField>
                </CocoaFormRow>
                <CocoaField label="Próxima inspección" help="Por defecto, la fecha del acta más la periodicidad.">
                  <CocoaDatePicker value={acta.nextDueAt} onChange={(value) => patchActa({ nextDueAt: value })} disabled={inspectionReadOnly} />
                </CocoaField>
              </CocoaFormSection>
            ) : (
              <CocoaFormSection title="Acta">
                <ul className="c22-section__list">
                  <li>
                    <span>Fecha</span>
                    <strong>{formatDay(selectedInspection.performedAt)}</strong>
                  </li>
                  <li>
                    <span>Resultado</span>
                    <strong>{inspectionResultLabel(selectedInspection.result)}</strong>
                  </li>
                  <li>
                    <span>Próxima</span>
                    <strong>{formatDay(selectedInspection.nextDueAt)}</strong>
                  </li>
                  {selectedInspection.correctedAt ? (
                    <li>
                      <span>Subsanada el</span>
                      <strong>{formatDay(selectedInspection.correctedAt)}</strong>
                    </li>
                  ) : null}
                </ul>
              </CocoaFormSection>
            )}

            {(selectedInspection.status === "programada" && hasDefectResult(acta.result)) || selectedInspection.status === "con_defectos" || (acta.defects.length > 0 && selectedInspection.status !== "programada") ? (
              <CocoaFormSection
                title="Defectos"
                description={selectedInspection.status === "con_defectos" ? "Anota la fecha de subsanación de cada defecto para cerrar la inspección." : "Gravedad, descripción y plazo de subsanación de cada defecto del acta."}
                actions={
                  !inspectionReadOnly && selectedInspection.status !== "realizada" ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => patchActa({ defects: [...acta.defects, emptyDefect()] })} disabled={inspectionBusy !== null}>
                      Añadir defecto
                    </CocoaButton>
                  ) : undefined
                }
              >
                {actaErrors.defects && selectedInspection.status === "programada" ? <span className="cocoa-note">{actaErrors.defects}</span> : null}
                {closeErrors.defects && selectedInspection.status === "con_defectos" ? <span className="cocoa-note">{closeErrors.defects}</span> : null}
                {acta.defects.length === 0 ? <span className="cocoa-note">Sin defectos anotados.</span> : null}
                <div className="cocoa-stack" data-gap="3" role="list" aria-label="Defectos del acta">
                  {acta.defects.map((defect, index) => (
                    <div key={index} className="cocoa-stack" data-gap="2" role="listitem">
                      <CocoaFormRow columns={2}>
                        <CocoaField label={`Defecto ${index + 1}`} required>
                          <CocoaInput value={defect.text} onChange={(value) => patchDefect(index, { text: value })} maxLength={500} disabled={inspectionReadOnly} error={!defect.text.trim()} />
                        </CocoaField>
                        <CocoaField label="Gravedad">
                          <CocoaSelect value={defect.severity} onChange={(value) => patchDefect(index, { severity: value as RealEstateDefectSeverity })} options={SEVERITY_OPTIONS} disabled={inspectionReadOnly} />
                        </CocoaField>
                      </CocoaFormRow>
                      <CocoaFormRow columns={3}>
                        <CocoaField label="Plazo de subsanación">
                          <CocoaDatePicker value={defect.dueAt} onChange={(value) => patchDefect(index, { dueAt: value })} disabled={inspectionReadOnly} />
                        </CocoaField>
                        <CocoaField label="Subsanado el">
                          <CocoaDatePicker value={defect.fixedAt} onChange={(value) => patchDefect(index, { fixedAt: value })} max={today} disabled={inspectionReadOnly} error={selectedInspection.status === "con_defectos" && !defect.fixedAt} />
                        </CocoaField>
                        {!inspectionReadOnly ? (
                          <CocoaField label="Quitar">
                            <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => patchActa({ defects: acta.defects.filter((_, i) => i !== index) })} disabled={inspectionBusy !== null} aria-label={`Quitar el defecto ${index + 1}`}>
                              {ACTIONS.remove}
                            </CocoaButton>
                          </CocoaField>
                        ) : (
                          <CocoaField label="Gravedad anotada">
                            <CocoaBadge tone={defect.severity === "muy_grave" ? "danger" : defect.severity === "grave" ? "warning" : "info"} variant="tinted" size="small" uppercase={false}>
                              {defectSeverityLabel(defect.severity)}
                            </CocoaBadge>
                          </CocoaField>
                        )}
                      </CocoaFormRow>
                    </div>
                  ))}
                </div>
                <CocoaFormRow columns={2}>
                  {selectedInspection.status === "programada" ? (
                    <CocoaField label="Plazo global de subsanación" help="Por defecto, el primer plazo de los defectos.">
                      <CocoaDatePicker value={acta.correctionDueAt} onChange={(value) => patchActa({ correctionDueAt: value })} disabled={inspectionReadOnly} />
                    </CocoaField>
                  ) : (
                    <CocoaField label="Fecha de subsanación" help="Por defecto, la última fecha de subsanación de los defectos." error={closeErrors.correctedAt}>
                      <CocoaDatePicker value={acta.correctedAt} onChange={(value) => patchActa({ correctedAt: value })} max={today} disabled={inspectionReadOnly} />
                    </CocoaField>
                  )}
                </CocoaFormRow>
              </CocoaFormSection>
            ) : null}

            <CocoaFormSection title="Fichero y seguimiento">
              <DocumentPicker label="Acta (documento enlazado)" value={acta.documentId} onChange={(value) => patchActa({ documentId: value })} documents={inspectionDocuments.data ?? EMPTY_DOCUMENTS} unavailable={inspectionDocsUnavailable} category="Inspecciones" disabled={inspectionReadOnly} />
              <CocoaFormRow columns={2}>
                <CocoaField label="Proveedor (OCA, mantenedor)">
                  <CocoaInput value={acta.providerName} onChange={(value) => patchActa({ providerName: value })} maxLength={200} disabled={inspectionReadOnly} />
                </CocoaField>
                {selectedInspection.status === "programada" ? (
                  <CocoaField label="Programada para">
                    <CocoaDatePicker value={acta.scheduledAt} onChange={(value) => patchActa({ scheduledAt: value })} disabled={inspectionReadOnly} />
                  </CocoaField>
                ) : (
                  <CocoaField label="Próxima inspección">
                    <CocoaDatePicker value={acta.nextDueAt} onChange={(value) => patchActa({ nextDueAt: value })} disabled={inspectionReadOnly} />
                  </CocoaField>
                )}
              </CocoaFormRow>
              <CocoaField label="Notas" hint="opcional">
                <CocoaInput value={acta.notes} onChange={(value) => patchActa({ notes: value })} multiline rows={2} maxLength={2000} disabled={inspectionReadOnly} />
              </CocoaField>
            </CocoaFormSection>
          </div>
        ) : (
          <CocoaState kind="loading" inline />
        )}
      </CocoaDrawer>

      {/* ── Nueva inspección ───────────────────────────────────────────────── */}
      <CocoaDrawer
        open={newOpen}
        onClose={() => {
          if (!newBusy) setNewOpen(false);
        }}
        title="Nueva inspección"
        subtitle="Nace programada; la base legal y la periodicidad del tipo se rellenan solas si no las indicas."
        side={drawerSide}
        size="md"
        submitOnEnter
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setNewOpen(false)} disabled={newBusy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void createInspection()} loading={newBusy} disabled={!canManage || newBusy || Object.keys(newErrors).length > 0} title={canManage ? undefined : NO_MANAGE_PERMISSION}>
              Programar
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Tipo" required error={newForm.kind ? undefined : newErrors.kind}>
            <CocoaSelect value={newForm.kind} onChange={(value) => setNewForm((current) => ({ ...current, kind: value as RealEstateInspectionKind | "" }))} options={KIND_OPTIONS} disabled={newBusy} />
          </CocoaField>
          <CocoaFormRow columns={2}>
            <CocoaField label="Instalación" help="Referencia del equipo o instalación (RAE del ascensor, cuadro, sala de calderas…).">
              <CocoaInput value={newForm.installationRef} onChange={(value) => setNewForm((current) => ({ ...current, installationRef: value }))} maxLength={120} disabled={newBusy} />
            </CocoaField>
            <CocoaField label="Proveedor (OCA, mantenedor)">
              <CocoaInput value={newForm.providerName} onChange={(value) => setNewForm((current) => ({ ...current, providerName: value }))} maxLength={200} disabled={newBusy} />
            </CocoaField>
          </CocoaFormRow>
          <CocoaFormRow columns={2}>
            <CocoaField label="Programada para">
              <CocoaDatePicker value={newForm.scheduledAt} onChange={(value) => setNewForm((current) => ({ ...current, scheduledAt: value }))} disabled={newBusy} />
            </CocoaField>
            <CocoaField label="Periodicidad (meses)" help="Vacío = la del catálogo del tipo." error={newErrors.periodicityMonths}>
              <CocoaInput value={newForm.periodicityMonths} onChange={(value) => setNewForm((current) => ({ ...current, periodicityMonths: value }))} inputMode="numeric" placeholder="24" disabled={newBusy} error={Boolean(newErrors.periodicityMonths)} />
            </CocoaField>
          </CocoaFormRow>
          <CocoaField label="Base legal" help="Vacío = la del catálogo del tipo (RD 355/2024, REBT ITC-BT-05, RITE IT 4.3…).">
            <CocoaInput value={newForm.legalBasis} onChange={(value) => setNewForm((current) => ({ ...current, legalBasis: value }))} maxLength={200} disabled={newBusy} />
          </CocoaField>
          <CocoaField label="Obligación de cumplimiento" hint="opcional" help="Código del requisito del centro de cumplimiento que sincroniza el acta.">
            <CocoaInput value={newForm.complianceRequirementCode} onChange={(value) => setNewForm((current) => ({ ...current, complianceRequirementCode: value }))} maxLength={80} disabled={newBusy} />
          </CocoaField>
          <CocoaField label="Notas" hint="opcional">
            <CocoaInput value={newForm.notes} onChange={(value) => setNewForm((current) => ({ ...current, notes: value }))} multiline rows={2} maxLength={2000} disabled={newBusy} />
          </CocoaField>
          {newError ? (
            <CocoaCallout tone="danger" title="No se pudo programar la inspección" role="alert">
              {newError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDrawer>

      {/* ── Póliza ─────────────────────────────────────────────────────────── */}
      <CocoaDrawer
        open={insuranceOpen}
        onClose={() => {
          if (!insuranceBusy) setInsuranceOpen(false);
        }}
        title={editingInsurance ? `Póliza ${editingInsurance.policyNumber}` : "Nueva póliza"}
        subtitle={editingInsurance ? `${insuranceKindLabel(editingInsurance.kind)} · ${editingInsurance.insurerName} · ${insuranceBadge(editingInsurance, today).label.toLowerCase()}` : "Responsabilidad civil, multirriesgo, pérdida de beneficios, decenal o todo riesgo construcción."}
        side={drawerSide}
        size="lg"
        focusKey={editingInsuranceId ?? "new"}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setInsuranceOpen(false)} disabled={insuranceBusy !== null}>
              {ACTIONS.cancel}
            </CocoaButton>
            {editingInsurance && editingInsurance.status !== "cancelada" ? (
              <CocoaButton variant="bordered" tone="destructive" onClick={() => setCancelTarget(editingInsurance)} disabled={!canManage || insuranceBusy !== null} title={canManage ? undefined : NO_MANAGE_PERMISSION}>
                Cancelar póliza
              </CocoaButton>
            ) : null}
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveInsurance()} loading={insuranceBusy === "save"} disabled={!canManage || insuranceBusy !== null || Object.keys(insuranceErrors).length > 0} title={canManage ? undefined : NO_MANAGE_PERMISSION}>
              {ACTIONS.save}
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {editingInsurance ? <InsuranceStatusBadge insurance={editingInsurance} today={today} /> : null}
          <CocoaFormSection title="Póliza" columns={2}>
            <CocoaField label="Tipo" required error={insuranceForm.kind ? undefined : insuranceErrors.kind}>
              <CocoaSelect value={insuranceForm.kind} onChange={(value) => patchInsurance({ kind: value as RealEstateInsuranceKind | "" })} options={INSURANCE_KIND_OPTIONS} disabled={!canManage} />
            </CocoaField>
            <CocoaField label="Tomador">
              <CocoaSelect value={insuranceForm.policyholder} onChange={(value) => patchInsurance({ policyholder: value as RealEstatePolicyholder })} options={POLICYHOLDER_OPTIONS} disabled={!canManage} />
            </CocoaField>
            <CocoaField label="Aseguradora" required error={insuranceForm.insurerName ? undefined : insuranceErrors.insurerName}>
              <CocoaInput value={insuranceForm.insurerName} onChange={(value) => patchInsurance({ insurerName: value })} maxLength={200} disabled={!canManage} required />
            </CocoaField>
            <CocoaField label="Número de póliza" required error={insuranceForm.policyNumber ? undefined : insuranceErrors.policyNumber}>
              <CocoaInput value={insuranceForm.policyNumber} onChange={(value) => patchInsurance({ policyNumber: value })} maxLength={80} disabled={!canManage} required />
            </CocoaField>
            <CocoaField label="Corredor" hint="opcional">
              <CocoaInput value={insuranceForm.brokerName} onChange={(value) => patchInsurance({ brokerName: value })} maxLength={200} disabled={!canManage} />
            </CocoaField>
            <CocoaField label="Base de obligatoriedad" hint="opcional" help="Norma que exige la póliza (RC turística autonómica, LOE para la decenal…).">
              <CocoaInput value={insuranceForm.mandatoryBasis} onChange={(value) => patchInsurance({ mandatoryBasis: value })} maxLength={200} disabled={!canManage} />
            </CocoaField>
          </CocoaFormSection>
          <CocoaFormSection title="Importes">
            <CocoaFormRow columns={3}>
              <CocoaField label="Suma asegurada" error={insuranceErrors.insuredSum}>
                <CocoaInput value={insuranceForm.insuredSum} onChange={(value) => patchInsurance({ insuredSum: value })} inputMode="decimal" placeholder="0,00" disabled={!canManage} error={Boolean(insuranceErrors.insuredSum)} />
              </CocoaField>
              <CocoaField label="Franquicia" error={insuranceErrors.deductible}>
                <CocoaInput value={insuranceForm.deductible} onChange={(value) => patchInsurance({ deductible: value })} inputMode="decimal" placeholder="0,00" disabled={!canManage} error={Boolean(insuranceErrors.deductible)} />
              </CocoaField>
              <CocoaField label="Prima anual" error={insuranceErrors.premiumAnnual}>
                <CocoaInput value={insuranceForm.premiumAnnual} onChange={(value) => patchInsurance({ premiumAnnual: value })} inputMode="decimal" placeholder="0,00" disabled={!canManage} error={Boolean(insuranceErrors.premiumAnnual)} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>
          <CocoaFormSection title="Vigencia y renovación" description="La renovación se registra ampliando el fin de la vigencia; el aviso salta los días de preaviso antes.">
            <CocoaFormRow columns={3}>
              <CocoaField label="Desde" required error={insuranceErrors.validFrom}>
                <CocoaDatePicker value={insuranceForm.validFrom} onChange={(value) => patchInsurance({ validFrom: value })} disabled={!canManage} error={Boolean(insuranceErrors.validFrom)} />
              </CocoaField>
              <CocoaField label="Hasta" required error={insuranceForm.validUntil ? insuranceErrors.validUntil : undefined}>
                <CocoaDatePicker value={insuranceForm.validUntil} onChange={(value) => patchInsurance({ validUntil: value })} min={insuranceForm.validFrom || undefined} disabled={!canManage} error={Boolean(insuranceForm.validUntil && insuranceErrors.validUntil)} />
              </CocoaField>
              <CocoaField label="Preaviso (días)" error={insuranceErrors.noticeDays}>
                <CocoaInput value={insuranceForm.noticeDays} onChange={(value) => patchInsurance({ noticeDays: value })} inputMode="numeric" disabled={!canManage} error={Boolean(insuranceErrors.noticeDays)} />
              </CocoaField>
            </CocoaFormRow>
            <CocoaSwitch checked={insuranceForm.autoRenew} onChange={(value) => patchInsurance({ autoRenew: value })} label="Renovación automática (tácita)" size="small" disabled={!canManage} />
          </CocoaFormSection>
          <CocoaFormSection title="Documento y notas">
            <DocumentPicker label="Póliza (documento enlazado)" value={insuranceForm.documentId} onChange={(value) => patchInsurance({ documentId: value })} documents={insuranceDocuments.data ?? EMPTY_DOCUMENTS} unavailable={insuranceDocsUnavailable} category="Seguros" disabled={!canManage} />
            <CocoaField label="Notas" hint="opcional">
              <CocoaInput value={insuranceForm.notes} onChange={(value) => patchInsurance({ notes: value })} multiline rows={2} maxLength={2000} disabled={!canManage} />
            </CocoaField>
          </CocoaFormSection>
          {insuranceError ? (
            <CocoaCallout tone="danger" title="No se pudo guardar la póliza" role="alert">
              {insuranceError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDrawer>

      <CocoaDialog
        open={cancelTarget !== null}
        onClose={() => {
          if (insuranceBusy !== "cancel") setCancelTarget(null);
        }}
        title={cancelTarget ? `Cancelar la póliza ${cancelTarget.policyNumber}` : "Cancelar la póliza"}
        description="La póliza queda cancelada en el histórico y deja de avisar del vencimiento. Para renovarla, amplía la vigencia en vez de cancelarla."
        tone="destructive"
        confirmLabel="Cancelar póliza"
        cancelLabel={ACTIONS.back}
        onConfirm={() => void cancelInsurance()}
        busy={insuranceBusy === "cancel"}
      />
    </CocoaPage>
  );
}

export { InspectionDueBadge, InspectionRiskCallout, InsuranceStatusBadge };
export default RealEstateInspectionsScreen;
