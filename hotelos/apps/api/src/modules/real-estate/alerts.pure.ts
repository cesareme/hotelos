// Motor de alertas del activo inmobiliario (Tanda ACT · L0a, diseño §5 «Motor de
// alertas»). Puro: recibe proyecciones ya cargadas (días ISO, sin Decimal) y el
// «hoy», devuelve `RealEstateAlert[]` ordenadas por gravedad y fecha. Quien
// consulta la BD (alerts.service.ts de L3) mapea las filas a estas entradas.
//
// Umbrales 90 / 30 / 7 (REAL_ESTATE_ALERT_THRESHOLD_DAYS): baja a ≤ 90 días,
// media a ≤ 30, alta a ≤ 7. Siempre alta: vencido (documento, inspección,
// póliza, recibo, preaviso), acta negativa o con defectos sin subsanar,
// ascensor vencido («fuera de servicio a las 24 h», RD 355/2024) y obra en curso
// sin licencia cuando la exige. Los mensajes no llevan datos personales
// (ni contrapartes ni titulares): solo tipo, título, referencia y fecha.

import type {
  IsoDay,
  MoneyString,
  PropertyTaxKind,
  RealEstateAlert,
  RealEstateAlertSeverity,
  RealEstateInspectionKind,
  RealEstateInspectionResult,
  RealEstateInsuranceKind,
  RealEstateTenureKind
} from "@hotelos/shared";
import { REAL_ESTATE_ALERT_THRESHOLD_DAYS } from "@hotelos/shared";
import { addMonths, daysBetween, isIsoDay } from "./vigencias.js";

// ---------------------------------------------------------------------------
// Entradas (proyecciones mínimas; los servicios mapean filas Prisma → esto)
// ---------------------------------------------------------------------------

export type AlertDocumentInput = {
  id: string;
  propertyId: string;
  title: string;
  validUntil: IsoDay | null;
  supersededById?: string | null;
  deletedAt?: string | null;
};

export type AlertInspectionInput = {
  id: string;
  propertyId: string;
  kind: RealEstateInspectionKind;
  status: string;
  result?: RealEstateInspectionResult | null;
  scheduledAt?: IsoDay | null;
  performedAt?: IsoDay | null;
  nextDueAt: IsoDay | null;
  correctionDueAt?: IsoDay | null;
  correctedAt?: IsoDay | null;
  installationRef?: string | null;
};

export type AlertInsuranceInput = {
  id: string;
  propertyId: string;
  kind: RealEstateInsuranceKind;
  policyNumber?: string | null;
  validUntil: IsoDay;
  status: string;
};

export type AlertTenureInput = {
  id: string;
  propertyId: string;
  kind: RealEstateTenureKind;
  status: string;
  endDate: IsoDay | null;
  noticeMonths?: number | null;
  renewal?: string | null;
  rentReviewIndex?: string | null;
  rentReviewMonth?: number | null;
};

export type AlertReceiptInput = {
  id: string;
  propertyId: string;
  taxKind: PropertyTaxKind;
  fiscalYear: number;
  period: string;
  status: string;
  dueTo: IsoDay | null;
  amount?: MoneyString | null;
};

export type AlertCapexInput = {
  id: string;
  propertyId: string;
  name: string;
  status: string;
  licenceRequired: boolean;
  licenceDocumentId: string | null;
};

export type BuildRealEstateAlertsInput = {
  today: IsoDay;
  documents?: AlertDocumentInput[];
  inspections?: AlertInspectionInput[];
  insurances?: AlertInsuranceInput[];
  tenures?: AlertTenureInput[];
  receipts?: AlertReceiptInput[];
  capexProjects?: AlertCapexInput[];
};

// ---------------------------------------------------------------------------
// Etiquetas en español (sin datos personales)
// ---------------------------------------------------------------------------

export const PROPERTY_TAX_KIND_LABELS: Record<PropertyTaxKind, string> = {
  ibi: "IBI",
  iae: "IAE",
  residuos: "Tasa de residuos",
  vados: "Vados",
  terrazas: "Terrazas",
  ocupacion_via_publica: "Ocupación de vía pública",
  icio: "ICIO",
  plusvalia: "Plusvalía municipal",
  otro_local: "Tributo local"
};

export const REAL_ESTATE_INSPECTION_KIND_LABELS: Record<RealEstateInspectionKind, string> = {
  oca_bt: "OCA de baja tensión",
  oca_ascensor: "OCA del ascensor",
  oca_pci: "OCA de PCI",
  rite: "Inspección RITE",
  gas: "Inspección de gas",
  equipos_presion: "Inspección de equipos a presión",
  legionella: "Control de legionela",
  piscina: "Control de piscina",
  iee_ite: "IEE / ITE",
  cee: "Certificado de eficiencia energética",
  simulacro: "Simulacro de emergencia",
  otra: "Inspección"
};

export const REAL_ESTATE_INSURANCE_KIND_LABELS: Record<RealEstateInsuranceKind, string> = {
  rc: "Póliza de responsabilidad civil",
  multirriesgo: "Póliza multirriesgo",
  perdida_beneficios: "Póliza de pérdida de beneficios",
  decenal: "Seguro decenal",
  todo_riesgo_construccion: "Póliza todo riesgo construcción",
  otro: "Póliza"
};

export const REAL_ESTATE_TENURE_KIND_LABELS: Record<RealEstateTenureKind, string> = {
  propiedad: "Propiedad",
  arrendamiento_local: "Arrendamiento de local",
  arrendamiento_industria: "Arrendamiento de industria",
  gestion: "Contrato de gestión",
  franquicia: "Franquicia",
  usufructo: "Usufructo",
  concesion: "Concesión"
};

// ---------------------------------------------------------------------------
// Umbrales
// ---------------------------------------------------------------------------

const [LOW_DAYS, MEDIUM_DAYS, HIGH_DAYS] = REAL_ESTATE_ALERT_THRESHOLD_DAYS;

/** alta ≤ 7 · media ≤ 30 · baja ≤ 90 · null más lejos (o negativo: el vencido lo decide quien llama). */
export function severityForDaysLeft(daysLeft: number): RealEstateAlertSeverity | null {
  if (daysLeft < 0) return null;
  if (daysLeft <= HIGH_DAYS) return "alta";
  if (daysLeft <= MEDIUM_DAYS) return "media";
  if (daysLeft <= LOW_DAYS) return "baja";
  return null;
}

const SEVERITY_RANK: Record<RealEstateAlertSeverity, number> = { alta: 0, media: 1, baja: 2 };

export function sortRealEstateAlerts(alerts: RealEstateAlert[]): RealEstateAlert[] {
  return [...alerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.dueAt.localeCompare(b.dueAt) || a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId));
}

function inDays(daysLeft: number): string {
  if (daysLeft === 0) return "hoy";
  if (daysLeft === 1) return "mañana";
  return `en ${daysLeft} días`;
}

function fmt(day: IsoDay): string {
  // DD/MM/AAAA para el mensaje; el `dueAt` de la alerta sigue en ISO.
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

export function buildRealEstateAlerts(input: BuildRealEstateAlertsInput): RealEstateAlert[] {
  const today = input.today;
  if (!isIsoDay(today)) throw new RangeError(`today no es un día válido (AAAA-MM-DD): ${String(today)}`);
  const out: RealEstateAlert[] = [];

  // Documentos con vigencia (las versiones sustituidas y los retirados no avisan).
  for (const document of input.documents ?? []) {
    if (document.supersededById || document.deletedAt || !document.validUntil) continue;
    const daysLeft = daysBetween(today, document.validUntil);
    if (daysLeft < 0) {
      out.push({ kind: "DOCUMENT_EXPIRED", severity: "alta", dueAt: document.validUntil, entityType: "real_estate_document", entityId: document.id, propertyId: document.propertyId, message: `Documento «${document.title}» caducado el ${fmt(document.validUntil)}.` });
      continue;
    }
    const severity = severityForDaysLeft(daysLeft);
    if (severity) out.push({ kind: "DOCUMENT_EXPIRING", severity, dueAt: document.validUntil, entityType: "real_estate_document", entityId: document.id, propertyId: document.propertyId, message: `Documento «${document.title}» caduca ${inDays(daysLeft)} (${fmt(document.validUntil)}).` });
  }

  // Inspecciones obligatorias.
  for (const inspection of input.inspections ?? []) {
    if (inspection.status === "cerrada") continue;
    const label = REAL_ESTATE_INSPECTION_KIND_LABELS[inspection.kind] ?? "Inspección";
    const ref = inspection.installationRef ? ` (${inspection.installationRef})` : "";
    const negativeOpen = (inspection.result === "negativa" || inspection.result === "condicionada" || inspection.status === "con_defectos") && !inspection.correctedAt;
    if (negativeOpen) {
      const dueAt = inspection.correctionDueAt ?? inspection.performedAt ?? today;
      out.push({ kind: "INSPECTION_NEGATIVE_OPEN", severity: "alta", dueAt, entityType: "real_estate_inspection", entityId: inspection.id, propertyId: inspection.propertyId, message: `${label}${ref} con resultado ${inspection.result ?? "con defectos"} sin subsanar${inspection.correctionDueAt ? ` (plazo ${fmt(inspection.correctionDueAt)})` : ""}.` });
    }
    const due = inspection.status === "programada" ? (inspection.scheduledAt ?? inspection.nextDueAt) : inspection.nextDueAt;
    if (!due) continue;
    const daysLeft = daysBetween(today, due);
    if (daysLeft < 0) {
      const elevator = inspection.kind === "oca_ascensor";
      out.push({ kind: "INSPECTION_OVERDUE", severity: "alta", dueAt: due, entityType: "real_estate_inspection", entityId: inspection.id, propertyId: inspection.propertyId, message: elevator ? `${label}${ref} vencida el ${fmt(due)}: el ascensor debe quedar fuera de servicio a las 24 h.` : `${label}${ref} vencida el ${fmt(due)}.` });
      continue;
    }
    const severity = severityForDaysLeft(daysLeft);
    if (severity) out.push({ kind: "INSPECTION_DUE", severity, dueAt: due, entityType: "real_estate_inspection", entityId: inspection.id, propertyId: inspection.propertyId, message: `${label}${ref} vence ${inDays(daysLeft)} (${fmt(due)}).` });
  }

  // Pólizas.
  for (const insurance of input.insurances ?? []) {
    if (insurance.status === "cancelada") continue;
    const label = REAL_ESTATE_INSURANCE_KIND_LABELS[insurance.kind] ?? "Póliza";
    const ref = insurance.policyNumber ? ` ${insurance.policyNumber}` : "";
    const daysLeft = daysBetween(today, insurance.validUntil);
    if (daysLeft < 0) {
      out.push({ kind: "INSURANCE_EXPIRING", severity: "alta", dueAt: insurance.validUntil, entityType: "real_estate_insurance", entityId: insurance.id, propertyId: insurance.propertyId, message: `${label}${ref} vencida el ${fmt(insurance.validUntil)} sin renovación registrada.` });
      continue;
    }
    const severity = severityForDaysLeft(daysLeft);
    if (severity) out.push({ kind: "INSURANCE_EXPIRING", severity, dueAt: insurance.validUntil, entityType: "real_estate_insurance", entityId: insurance.id, propertyId: insurance.propertyId, message: `${label}${ref} vence ${inDays(daysLeft)} (${fmt(insurance.validUntil)}).` });
  }

  // Tenencia vigente: preaviso del contrato y revisión de renta.
  for (const tenure of input.tenures ?? []) {
    if (tenure.status !== "vigente") continue;
    const label = REAL_ESTATE_TENURE_KIND_LABELS[tenure.kind] ?? "Contrato";
    if (tenure.endDate) {
      const noticeMonths = tenure.noticeMonths ?? 0;
      const noticeDeadline = noticeMonths > 0 ? addMonths(tenure.endDate, -noticeMonths) : tenure.endDate;
      const daysToEnd = daysBetween(today, tenure.endDate);
      const daysToNotice = daysBetween(today, noticeDeadline);
      if (daysToEnd < 0) {
        out.push({ kind: "TENURE_NOTICE", severity: "alta", dueAt: tenure.endDate, entityType: "real_estate_tenure", entityId: tenure.id, propertyId: tenure.propertyId, message: `${label} vencido el ${fmt(tenure.endDate)} y todavía vigente: resolver o prorrogar.` });
      } else if (daysToNotice < 0 && noticeMonths > 0) {
        out.push({ kind: "TENURE_NOTICE", severity: "alta", dueAt: noticeDeadline, entityType: "real_estate_tenure", entityId: tenure.id, propertyId: tenure.propertyId, message: `${label}: plazo de preaviso (${noticeMonths} meses) superado el ${fmt(noticeDeadline)}; vence el ${fmt(tenure.endDate)}${tenure.renewal === "tacita" ? " y se renueva tácitamente" : ""}.` });
      } else {
        const severity = severityForDaysLeft(daysToNotice);
        if (severity) out.push({ kind: "TENURE_NOTICE", severity, dueAt: noticeDeadline, entityType: "real_estate_tenure", entityId: tenure.id, propertyId: tenure.propertyId, message: noticeMonths > 0 ? `${label}: el preaviso (${noticeMonths} meses) termina ${inDays(daysToNotice)} (${fmt(noticeDeadline)}); vence el ${fmt(tenure.endDate)}.` : `${label} vence ${inDays(daysToEnd)} (${fmt(tenure.endDate)}).` });
      }
    }
    const reviewMonth = tenure.rentReviewMonth ?? null;
    if (tenure.rentReviewIndex && tenure.rentReviewIndex !== "ninguno" && reviewMonth !== null && reviewMonth >= 1 && reviewMonth <= 12) {
      const year = Number(today.slice(0, 4));
      let reviewDay: IsoDay = `${year}-${String(reviewMonth).padStart(2, "0")}-01`;
      if (reviewDay < today) reviewDay = `${year + 1}-${String(reviewMonth).padStart(2, "0")}-01`;
      const daysLeft = daysBetween(today, reviewDay);
      const severity = severityForDaysLeft(daysLeft);
      if (severity) out.push({ kind: "RENT_REVIEW", severity, dueAt: reviewDay, entityType: "real_estate_tenure", entityId: tenure.id, propertyId: tenure.propertyId, message: `${label}: revisión de renta (${tenure.rentReviewIndex === "ipc" ? "IPC" : "porcentaje fijo"}) ${inDays(daysLeft)} (${fmt(reviewDay)}).` });
    }
  }

  // Recibos de tributos sin pagar.
  for (const receipt of input.receipts ?? []) {
    if (receipt.status === "pagado" || !receipt.dueTo) continue;
    const label = `${PROPERTY_TAX_KIND_LABELS[receipt.taxKind] ?? "Tributo"} ${receipt.fiscalYear}${receipt.period && receipt.period !== "anual" ? ` (${receipt.period})` : ""}`;
    const amount = receipt.amount ? ` de ${receipt.amount} €` : "";
    const daysLeft = daysBetween(today, receipt.dueTo);
    if (daysLeft < 0) {
      out.push({ kind: "TAX_OVERDUE", severity: "alta", dueAt: receipt.dueTo, entityType: "property_tax_receipt", entityId: receipt.id, propertyId: receipt.propertyId, message: `Recibo ${label}${amount} vencido el ${fmt(receipt.dueTo)} sin pagar${receipt.status === "recurrido" ? " (recurrido)" : ""}.` });
      continue;
    }
    const severity = severityForDaysLeft(daysLeft);
    if (severity) out.push({ kind: "TAX_DUE", severity, dueAt: receipt.dueTo, entityType: "property_tax_receipt", entityId: receipt.id, propertyId: receipt.propertyId, message: `Recibo ${label}${amount}: fin del periodo voluntario ${inDays(daysLeft)} (${fmt(receipt.dueTo)}).` });
  }

  // Obras en curso sin licencia cuando la exigen.
  for (const project of input.capexProjects ?? []) {
    if (project.status !== "in_progress" || !project.licenceRequired || project.licenceDocumentId) continue;
    out.push({ kind: "CAPEX_LICENCE_MISSING", severity: "alta", dueAt: today, entityType: "capex_project", entityId: project.id, propertyId: project.propertyId, message: `Obra «${project.name}» en curso sin licencia de obras registrada.` });
  }

  return sortRealEstateAlerts(out);
}
