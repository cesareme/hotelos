// Activo inmobiliario · calendario anual del activo (Tanda ACT · L6, diseño §5
// «Calendario anual del activo»): 12 meses por centro
// (GET /properties/:propertyId/real-estate/calendar?year=) y de grupo
// (GET /organizations/:organizationId/real-estate/calendar?year=) con eventos
// `RealEstateCalendarEvent` (packages/shared):
//   · periodos voluntarios de cada tributo activo (tax-calendar.ts vía
//     buildTaxCalendar de L2: inicio y fin de cada recibo del ejercicio y, para
//     los periodos que aún no tienen recibo, el periodo previsto);
//   · vencimientos de recibos (TAX_DUE · TAX_OVERDUE si venció sin pagar);
//   · plazo de las inspecciones abiertas (inspectionDueDate: scheduledAt mientras
//     está programada, nextDueAt después) → INSPECTION_DUE · INSPECTION_OVERDUE;
//   · validUntil de documentos vivos (DOCUMENT_EXPIRING · DOCUMENT_EXPIRED) y de
//     pólizas no canceladas (INSURANCE_EXPIRING);
//   · preaviso de la tenencia vigente (endDate − noticeMonths → TENURE_NOTICE), el
//     vencimiento del contrato cuando difiere del preaviso y la revisión de renta
//     (rentReviewMonth → RENT_REVIEW, día 1 del mes).
// Solo entran los eventos cuyo `dueAt` cae en el año pedido; orden cronológico
// (dueAt, centro, tipo, id, etiqueta). Puro (buildRealEstateCalendar) + carga por
// lotes (una consulta por tabla para N fichas). Sin escrituras. Las etiquetas no
// llevan datos personales (sin contrapartes ni titulares).
//
// El catálogo REAL_ESTATE_ALERT_ENTITY_TYPES (L0a) no tiene `property_tax`: un
// periodo previsto sin recibo se publica con entityType `property_tax_receipt` y
// entityId = PropertyTax.id (la etiqueta empieza por «… periodo voluntario
// previsto» para distinguirlo del recibo real).

import { prisma } from "@hotelos/database";
import type { RealEstateTenure } from "@prisma/client";
import type { IsoDay, RealEstateAlertKind, RealEstateCalendarEvent } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { RealEstateYearQuerySchema } from "../../schemas/real-estate.schemas.js";
import { utcDay } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { REAL_ESTATE_INSPECTION_KIND_LABELS, REAL_ESTATE_INSURANCE_KIND_LABELS, REAL_ESTATE_TENURE_KIND_LABELS, type AlertDocumentInput, type AlertInspectionInput, type AlertInsuranceInput, type AlertTenureInput } from "./alerts.pure.js";
import { documentAlertInput, inspectionAlertInput, insuranceAlertInput, inspectionsForAlerts } from "./alerts.service.js";
import { realEstateError } from "./errors.js";
import { listVisibleRealEstateProperties, type ScopeSubject } from "./group.service.js";
import { inspectionDueDate } from "./inspections.service.js";
import { buildTaxCalendar, expectedReceiptInputOf, receiptLabel, type CalendarTaxInput } from "./property-tax.service.js";
import { isoDayOrNull, tenureAlertInput } from "./real-estate.service.js";
import { expectedReceiptsFor } from "./tax-calendar.js";
import { addMonths, formatDay, formatMoneyEs, isIsoDay, toIsoDay } from "./vigencias.js";

// ---------------------------------------------------------------------------
// Tipos de respuesta (el contrato compartido solo fija el evento)
// ---------------------------------------------------------------------------

export type RealEstateCalendarProperty = { propertyId: string; propertyCode: string | null; propertyName: string };
export type RealEstateCalendarMonth = { month: number; events: RealEstateCalendarEvent[] };
export type RealEstateCalendarYear = {
  year: number;
  /** Centros que alimentan el calendario (uno en la vista de centro; los visibles en la de grupo). */
  properties: RealEstateCalendarProperty[];
  /** Siempre 12 entradas (1..12), cada una con sus eventos en orden cronológico. */
  months: RealEstateCalendarMonth[];
  totalEvents: number;
};

/** Etiquetas en español de los tipos de evento (para la exportación y la UI). */
export const REAL_ESTATE_CALENDAR_KIND_LABELS: Record<RealEstateAlertKind, string> = {
  DOCUMENT_EXPIRED: "Documento caducado",
  DOCUMENT_EXPIRING: "Vigencia de documento",
  INSPECTION_DUE: "Inspección obligatoria",
  INSPECTION_OVERDUE: "Inspección vencida",
  INSPECTION_NEGATIVE_OPEN: "Acta con defectos",
  INSURANCE_EXPIRING: "Vencimiento de póliza",
  TENURE_NOTICE: "Preaviso de contrato",
  RENT_REVIEW: "Revisión de renta",
  TAX_DUE: "Tributo local",
  TAX_OVERDUE: "Tributo vencido",
  CAPEX_LICENCE_MISSING: "Obra sin licencia"
};

// ---------------------------------------------------------------------------
// Puro
// ---------------------------------------------------------------------------

export type CalendarTaxesInput = { propertyId: string; taxes: CalendarTaxInput[] };

export type BuildRealEstateCalendarInput = {
  year: number;
  today: IsoDay;
  documents?: AlertDocumentInput[];
  inspections?: AlertInspectionInput[];
  insurances?: AlertInsuranceInput[];
  tenures?: AlertTenureInput[];
  taxes?: CalendarTaxesInput[];
};

export function assertCalendarYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new RangeError(`año no válido: ${year}`);
}

/** True cuando el día ISO cae en el año. */
export function withinYear(day: IsoDay, year: number): boolean {
  return day.slice(0, 4) === String(year).padStart(4, "0");
}

/** DD/MM/AAAA para las etiquetas (vigencias.ts `formatDay`); el `dueAt` del evento sigue en ISO. */
export { formatDay };

const MONTH_RE = /^\d{4}-(\d{2})-\d{2}$/;

/** Mes (1..12) de un día ISO. */
export function monthOf(day: IsoDay): number {
  const match = MONTH_RE.exec(day);
  return match ? Number(match[1]) : 0;
}

export function sortCalendarEvents(events: ReadonlyArray<RealEstateCalendarEvent>): RealEstateCalendarEvent[] {
  return [...events].sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.propertyId.localeCompare(b.propertyId) || a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId) || a.label.localeCompare(b.label));
}

/** Reparte los eventos (ya ordenados) en 12 meses; los de otro año se descartan. */
export function groupEventsByMonth(events: ReadonlyArray<RealEstateCalendarEvent>, year: number): RealEstateCalendarMonth[] {
  const months: RealEstateCalendarMonth[] = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, events: [] }));
  for (const event of sortCalendarEvents(events)) {
    if (!withinYear(event.dueAt, year)) continue;
    const month = monthOf(event.dueAt);
    if (month >= 1 && month <= 12) months[month - 1].events.push(event);
  }
  return months;
}

export function buildCalendarYear(input: { year: number; properties: RealEstateCalendarProperty[]; events: ReadonlyArray<RealEstateCalendarEvent> }): RealEstateCalendarYear {
  const months = groupEventsByMonth(input.events, input.year);
  return { year: input.year, properties: input.properties, months, totalEvents: months.reduce((acc, month) => acc + month.events.length, 0) };
}

/**
 * Eventos del año a partir de las proyecciones del motor de alertas
 * (alerts.pure.ts) y del calendario de tributos de L2 (buildTaxCalendar).
 */
export function buildRealEstateCalendar(input: BuildRealEstateCalendarInput): RealEstateCalendarEvent[] {
  assertCalendarYear(input.year);
  if (!isIsoDay(input.today)) throw new RangeError(`today no es un día válido (AAAA-MM-DD): ${String(input.today)}`);
  const { year, today } = input;
  const out: RealEstateCalendarEvent[] = [];
  const push = (event: RealEstateCalendarEvent) => {
    if (withinYear(event.dueAt, year)) out.push(event);
  };

  // Documentos vivos con vigencia.
  for (const document of input.documents ?? []) {
    if (document.supersededById || document.deletedAt || !document.validUntil) continue;
    const expired = document.validUntil < today;
    push({
      kind: expired ? "DOCUMENT_EXPIRED" : "DOCUMENT_EXPIRING",
      dueAt: document.validUntil,
      entityType: "real_estate_document",
      entityId: document.id,
      propertyId: document.propertyId,
      label: expired ? `Documento «${document.title}» caducado el ${formatDay(document.validUntil)}` : `Documento «${document.title}» caduca el ${formatDay(document.validUntil)}`
    });
  }

  // Inspecciones abiertas: plazo (programada → scheduledAt; después → nextDueAt).
  for (const inspection of input.inspections ?? []) {
    if (inspection.status === "cerrada") continue;
    const due = inspectionDueDate({ status: inspection.status, scheduledAt: inspection.scheduledAt ?? null, nextDueAt: inspection.nextDueAt });
    if (!due) continue;
    const label = REAL_ESTATE_INSPECTION_KIND_LABELS[inspection.kind] ?? "Inspección";
    const ref = inspection.installationRef ? ` (${inspection.installationRef})` : "";
    const overdue = due < today;
    push({
      kind: overdue ? "INSPECTION_OVERDUE" : "INSPECTION_DUE",
      dueAt: due,
      entityType: "real_estate_inspection",
      entityId: inspection.id,
      propertyId: inspection.propertyId,
      label: overdue ? `${label}${ref} · vencida el ${formatDay(due)}` : `${label}${ref} · próxima inspección el ${formatDay(due)}`
    });
  }

  // Pólizas no canceladas.
  for (const insurance of input.insurances ?? []) {
    if (insurance.status === "cancelada") continue;
    const label = REAL_ESTATE_INSURANCE_KIND_LABELS[insurance.kind] ?? "Póliza";
    const ref = insurance.policyNumber ? ` ${insurance.policyNumber}` : "";
    const expired = insurance.validUntil < today;
    push({
      kind: "INSURANCE_EXPIRING",
      dueAt: insurance.validUntil,
      entityType: "real_estate_insurance",
      entityId: insurance.id,
      propertyId: insurance.propertyId,
      label: expired ? `${label}${ref} · vencida el ${formatDay(insurance.validUntil)}` : `${label}${ref} · vence el ${formatDay(insurance.validUntil)}`
    });
  }

  // Tenencia vigente: preaviso, vencimiento y revisión de renta.
  for (const tenure of input.tenures ?? []) {
    if (tenure.status !== "vigente") continue;
    const label = REAL_ESTATE_TENURE_KIND_LABELS[tenure.kind] ?? "Contrato";
    const base = { entityType: "real_estate_tenure" as const, entityId: tenure.id, propertyId: tenure.propertyId };
    if (tenure.endDate) {
      const noticeMonths = tenure.noticeMonths ?? 0;
      const noticeDeadline = noticeMonths > 0 ? addMonths(tenure.endDate, -noticeMonths) : tenure.endDate;
      if (noticeMonths > 0) {
        push({ ...base, kind: "TENURE_NOTICE", dueAt: noticeDeadline, label: `${label} · fin del preaviso (${noticeMonths} meses) el ${formatDay(noticeDeadline)}; vence el ${formatDay(tenure.endDate)}` });
        push({ ...base, kind: "TENURE_NOTICE", dueAt: tenure.endDate, label: `${label} · vencimiento del contrato el ${formatDay(tenure.endDate)}${tenure.renewal === "tacita" ? " (renovación tácita)" : ""}` });
      } else {
        push({ ...base, kind: "TENURE_NOTICE", dueAt: tenure.endDate, label: `${label} · vence el ${formatDay(tenure.endDate)}${tenure.renewal === "tacita" ? " (renovación tácita)" : ""}` });
      }
    }
    const reviewMonth = tenure.rentReviewMonth ?? null;
    if (tenure.rentReviewIndex && tenure.rentReviewIndex !== "ninguno" && reviewMonth !== null && reviewMonth >= 1 && reviewMonth <= 12) {
      const reviewDay: IsoDay = `${String(year).padStart(4, "0")}-${String(reviewMonth).padStart(2, "0")}-01`;
      if (!tenure.endDate || reviewDay <= tenure.endDate) {
        push({ ...base, kind: "RENT_REVIEW", dueAt: reviewDay, label: `${label} · revisión de renta (${tenure.rentReviewIndex === "ipc" ? "IPC" : "porcentaje fijo"}) el ${formatDay(reviewDay)}` });
      }
    }
  }

  // Tributos: recibos del ejercicio (L2) y periodos previstos sin recibo.
  for (const entry of input.taxes ?? []) {
    const calendar = buildTaxCalendar({ year, today, propertyId: entry.propertyId, taxes: entry.taxes });
    for (const event of calendar.events) push(event);
    for (const pending of calendar.pending) {
      const label = receiptLabel(pending.kind, year, pending.period);
      const amount = pending.amount ? ` · ${formatMoneyEs(pending.amount)}` : "";
      // Sin recibo: el evento enlaza al TRIBUTO (entityType property_tax, entityId = PropertyTax.id; ACT-REV-13).
      const base = { kind: "TAX_DUE" as const, entityType: "property_tax" as const, entityId: pending.taxId, propertyId: entry.propertyId };
      push({ ...base, dueAt: pending.dueFrom, label: `Inicio del periodo voluntario previsto · ${label} (sin recibo)` });
      push({ ...base, dueAt: pending.dueTo, label: `Fin del periodo voluntario previsto · ${label}${amount} (sin recibo)` });
    }
  }

  return sortCalendarEvents(out);
}

// ---------------------------------------------------------------------------
// Carga por lotes (una consulta por tabla para N fichas)
// ---------------------------------------------------------------------------

export type CalendarAssetRef = { id: string; propertyId: string };

export async function loadCalendarEvents(assets: ReadonlyArray<CalendarAssetRef>, year: number, today: IsoDay): Promise<RealEstateCalendarEvent[]> {
  assertCalendarYear(year);
  if (assets.length === 0) return [];
  const assetIds = assets.map((asset) => asset.id);
  const propertyOfAsset = new Map(assets.map((asset) => [asset.id, asset.propertyId] as const));
  const from = utcDay(`${String(year).padStart(4, "0")}-01-01`);
  const to = utcDay(`${String(year).padStart(4, "0")}-12-31`);

  const [documents, inspections, insurances, tenures, taxes] = await Promise.all([
    prisma.realEstateDocument.findMany({
      where: { assetId: { in: assetIds }, deletedAt: null, supersededById: null, validUntil: { gte: from, lte: to } },
      select: { id: true, propertyId: true, title: true, validUntil: true, supersededById: true, deletedAt: true }
    }),
    prisma.realEstateInspection.findMany({
      where: { assetId: { in: assetIds }, status: { not: "cerrada" } },
      select: { id: true, propertyId: true, kind: true, status: true, result: true, scheduledAt: true, performedAt: true, nextDueAt: true, correctionDueAt: true, correctedAt: true, installationRef: true }
    }),
    prisma.realEstateInsurance.findMany({
      where: { assetId: { in: assetIds }, status: { not: "cancelada" }, validUntil: { gte: from, lte: to } },
      select: { id: true, propertyId: true, kind: true, policyNumber: true, validUntil: true, status: true, noticeDays: true }
    }),
    prisma.realEstateTenure.findMany({ where: { assetId: { in: assetIds }, status: "vigente" } }),
    prisma.propertyTax.findMany({
      where: { assetId: { in: assetIds } },
      include: { receipts: { where: { fiscalYear: year }, orderBy: [{ dueTo: "asc" }, { createdAt: "asc" }] } },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }]
    })
  ]);

  // Inspecciones: la misma poda que el motor de alertas (una `realizada` cuya
  // sucesora `programada` ya existe no repite el plazo).
  const inspectionsByProperty = new Map<string, AlertInspectionInput[]>();
  for (const row of inspections) {
    const bucket = inspectionsByProperty.get(row.propertyId) ?? [];
    bucket.push(inspectionAlertInput(row));
    inspectionsByProperty.set(row.propertyId, bucket);
  }
  const inspectionInputs = [...inspectionsByProperty.values()].flatMap((rows) => inspectionsForAlerts(rows));

  const taxesByProperty = new Map<string, CalendarTaxInput[]>();
  for (const tax of taxes) {
    const propertyId = propertyOfAsset.get(tax.assetId) ?? tax.propertyId;
    const bucket = taxesByProperty.get(propertyId) ?? [];
    bucket.push({
      tax: { id: tax.id, kind: tax.kind, status: tax.status, expected: tax.status === "activo" ? expectedReceiptsFor(expectedReceiptInputOf(tax), year) : [] },
      receipts: tax.receipts.map((receipt) => ({ id: receipt.id, fiscalYear: receipt.fiscalYear, period: receipt.period, status: receipt.status, dueFrom: isoDayOrNull(receipt.dueFrom), dueTo: isoDayOrNull(receipt.dueTo), paidAt: isoDayOrNull(receipt.paidAt) }))
    });
    taxesByProperty.set(propertyId, bucket);
  }

  return buildRealEstateCalendar({
    year,
    today,
    documents: documents.map(documentAlertInput),
    inspections: inspectionInputs,
    insurances: insurances.map(insuranceAlertInput),
    tenures: (tenures as RealEstateTenure[]).flatMap((row) => {
      const propertyId = propertyOfAsset.get(row.assetId);
      return propertyId ? [tenureAlertInput(row, propertyId)] : [];
    }),
    taxes: [...taxesByProperty.entries()].map(([propertyId, rows]) => ({ propertyId, taxes: rows }))
  });
}

// ---------------------------------------------------------------------------
// API del servicio
// ---------------------------------------------------------------------------

function yearOf(query: unknown, today: IsoDay): number {
  const filter = parseOr400(RealEstateYearQuerySchema, query ?? {}, "Filtro del calendario");
  return filter.year ?? Number(today.slice(0, 4));
}

/** Calendario del año de un centro (404 tipado ASSET_NOT_FOUND sin ficha, como el resto de rutas del activo). */
export async function getRealEstateCalendar(propertyId: string, query: unknown, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateCalendarYear> {
  const year = yearOf(query, today);
  const asset = await prisma.realEstateAsset.findUnique({ where: { propertyId }, select: { id: true, propertyId: true } });
  if (!asset) throw realEstateError(404, "ASSET_NOT_FOUND", "Activo inmobiliario no encontrado.");
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, code: true, name: true } });
  const events = await loadCalendarEvents([asset], year, today);
  return buildCalendarYear({ year, properties: [{ propertyId, propertyCode: property?.code ?? null, propertyName: property?.name ?? propertyId }], events });
}

/** Calendario del año de los centros visibles del contexto (vista de grupo); los centros sin ficha solo figuran en `properties`. */
export async function getRealEstateGroupCalendar(context: UserContext & ScopeSubject, organizationId: string, query: unknown, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateCalendarYear> {
  const year = yearOf(query, today);
  const visible = await listVisibleRealEstateProperties(context, organizationId);
  const assets = visible.flatMap((property) => (property.assetId ? [{ id: property.assetId, propertyId: property.propertyId }] : []));
  const events = await loadCalendarEvents(assets, year, today);
  return buildCalendarYear({ year, properties: visible.map(({ propertyId, propertyCode, propertyName }) => ({ propertyId, propertyCode, propertyName })), events });
}
