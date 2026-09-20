// Activo inmobiliario · motor de alertas (Tanda ACT · L5, diseño §5 «Motor de
// alertas»). Calculado en cada lectura, como getComplianceAlerts del centro de
// cumplimiento: sin tabla, sin scheduler ni digest en esta tanda. Carga las
// filas del activo del centro y las proyecta a las entradas del motor puro
// (alerts.pure.ts `buildRealEstateAlerts`, umbrales 90 / 30 / 7):
//   · documentos vivos (sin deletedAt ni supersededById) con validUntil;
//   · inspecciones con status ≠ cerrada (las `realizada` cuya sucesora
//     `programada` ya existe no repiten el plazo: lo lleva la sucesora);
//   · pólizas (el motor omite las canceladas; dentro del preaviso propio de la
//     póliza, `noticeDays` (60 por defecto), una INSURANCE_EXPIRING «baja» sube a
//     «media»: el motor solo conoce 90 / 30 / 7);
//   · tenencias vigentes (preaviso y revisión de renta);
//   · recibos previsto | recibido | domiciliado | recurrido sin paidAt y con
//     dueTo (ACT-REV-09: el recurso no impide pagar ni oculta el vencimiento;
//     el motor puro etiqueta «(recurrido)»);
//   · obras in_progress con licenceRequired y sin licenceDocumentId.
// `alertsByProperty` sirve a la vista de grupo (ola 4): una consulta por tabla
// para N centros, sin tocar el motor.

import { prisma } from "@hotelos/database";
import type { CapexProject, PropertyTaxReceipt, RealEstateDocument, RealEstateInspection, RealEstateInsurance, RealEstateTenure } from "@prisma/client";
import type { IsoDay, PropertyTaxKind, RealEstateAlert, RealEstateInspectionKind, RealEstateInspectionResult, RealEstateInsuranceKind } from "@hotelos/shared";
import { dayOf } from "../payables/money.js";
import { buildRealEstateAlerts, sortRealEstateAlerts, type AlertCapexInput, type AlertDocumentInput, type AlertInspectionInput, type AlertInsuranceInput, type AlertReceiptInput, type BuildRealEstateAlertsInput } from "./alerts.pure.js";
import { realEstateError } from "./errors.js";
import { DEFAULT_INSURANCE_NOTICE_DAYS } from "./insurances.service.js";
import { isoDayOrNull, moneyOrNull, tenureAlertInput } from "./real-estate.service.js";
import { daysBetween, toIsoDay } from "./vigencias.js";

// ---------------------------------------------------------------------------
// Proyecciones fila → entrada del motor (exportadas para el test unitario)
// ---------------------------------------------------------------------------

export type DocumentAlertRow = Pick<RealEstateDocument, "id" | "propertyId" | "title" | "validUntil" | "supersededById" | "deletedAt">;
export type InspectionAlertRow = Pick<RealEstateInspection, "id" | "propertyId" | "kind" | "status" | "result" | "scheduledAt" | "performedAt" | "nextDueAt" | "correctionDueAt" | "correctedAt" | "installationRef">;
export type InsuranceAlertRow = Pick<RealEstateInsurance, "id" | "propertyId" | "kind" | "policyNumber" | "validUntil" | "status" | "noticeDays">;
/** Preaviso propio de una póliza (para `applyInsuranceNotice`). */
export type InsuranceNotice = { id: string; validUntil: IsoDay; noticeDays: number | null };
export type ReceiptAlertRow = Pick<PropertyTaxReceipt, "id" | "fiscalYear" | "period" | "status" | "dueTo" | "amount"> & { tax: { propertyId: string; kind: string } };
export type CapexAlertRow = Pick<CapexProject, "id" | "propertyId" | "name" | "status" | "licenceRequired" | "licenceDocumentId">;

export function documentAlertInput(row: DocumentAlertRow): AlertDocumentInput {
  return { id: row.id, propertyId: row.propertyId, title: row.title, validUntil: isoDayOrNull(row.validUntil), supersededById: row.supersededById ?? null, deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null };
}

export function inspectionAlertInput(row: InspectionAlertRow): AlertInspectionInput {
  return {
    id: row.id,
    propertyId: row.propertyId,
    kind: row.kind as RealEstateInspectionKind,
    status: row.status,
    result: (row.result ?? null) as RealEstateInspectionResult | null,
    scheduledAt: isoDayOrNull(row.scheduledAt),
    performedAt: isoDayOrNull(row.performedAt),
    nextDueAt: isoDayOrNull(row.nextDueAt),
    correctionDueAt: isoDayOrNull(row.correctionDueAt),
    correctedAt: isoDayOrNull(row.correctedAt),
    installationRef: row.installationRef ?? null
  };
}

export function insuranceAlertInput(row: InsuranceAlertRow): AlertInsuranceInput {
  return { id: row.id, propertyId: row.propertyId, kind: row.kind as RealEstateInsuranceKind, policyNumber: row.policyNumber, validUntil: dayOf(row.validUntil) as IsoDay, status: row.status };
}

export function insuranceNoticeOf(row: InsuranceAlertRow): InsuranceNotice {
  return { id: row.id, validUntil: dayOf(row.validUntil) as IsoDay, noticeDays: row.noticeDays };
}

/**
 * Preaviso de la póliza: una INSURANCE_EXPIRING «baja» (≤ 90 días para el
 * motor) sube a «media» cuando el vencimiento cae dentro de `noticeDays` (60
 * por defecto). Las «media»/«alta» del motor no bajan nunca. Puro.
 */
export function applyInsuranceNotice(alerts: RealEstateAlert[], insurances: ReadonlyArray<InsuranceNotice>, today: IsoDay): RealEstateAlert[] {
  if (insurances.length === 0) return alerts;
  const notice = new Map(insurances.map((row) => [row.id, Math.max(0, row.noticeDays ?? DEFAULT_INSURANCE_NOTICE_DAYS)] as const));
  let changed = false;
  const out = alerts.map((alert) => {
    if (alert.kind !== "INSURANCE_EXPIRING" || alert.severity !== "baja") return alert;
    const days = notice.get(alert.entityId);
    if (days === undefined || daysBetween(today, alert.dueAt) > days) return alert;
    changed = true;
    return { ...alert, severity: "media" as const };
  });
  return changed ? sortRealEstateAlerts(out) : alerts;
}

export function receiptAlertInput(row: ReceiptAlertRow): AlertReceiptInput {
  return { id: row.id, propertyId: row.tax.propertyId, taxKind: row.tax.kind as PropertyTaxKind, fiscalYear: row.fiscalYear, period: row.period, status: row.status, dueTo: isoDayOrNull(row.dueTo), amount: moneyOrNull(row.amount) };
}

export function capexAlertInput(row: CapexAlertRow): AlertCapexInput {
  return { id: row.id, propertyId: row.propertyId, name: row.name, status: row.status, licenceRequired: row.licenceRequired, licenceDocumentId: row.licenceDocumentId ?? null };
}

/**
 * Inspecciones que alimentan el motor: todas salvo `cerrada`, quitando las
 * `realizada` cuyo plazo ya lo lleva una sucesora `programada` del mismo tipo e
 * instalación con scheduledAt = nextDueAt (así el vencimiento no se avisa dos
 * veces). Puro: recibe filas ya proyectadas.
 */
export function inspectionsForAlerts(inspections: ReadonlyArray<AlertInspectionInput & { installationRef?: string | null }>): AlertInspectionInput[] {
  const scheduled = new Set(inspections.filter((row) => row.status === "programada" && row.scheduledAt).map((row) => `${row.propertyId}|${row.kind}|${row.installationRef ?? ""}|${row.scheduledAt}`));
  return inspections.filter((row) => {
    if (row.status === "cerrada") return false;
    if (row.status === "realizada" && row.nextDueAt && scheduled.has(`${row.propertyId}|${row.kind}|${row.installationRef ?? ""}|${row.nextDueAt}`)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Carga por lotes (una consulta por tabla para N activos)
// ---------------------------------------------------------------------------

/** Recibos que alimentan el motor: todo lo no pagado (`recurrido` incluido; ACT-REV-09); un recurrido tras pagar lleva paidAt y queda fuera. */
export const RECEIPT_STATUSES_WITH_ALERT = ["previsto", "recibido", "domiciliado", "recurrido"] as const;

type PropertyAlertInputs = { input: BuildRealEstateAlertsInput; notices: InsuranceNotice[] };

async function loadAlertInputs(assets: ReadonlyArray<{ id: string; propertyId: string }>, today: IsoDay): Promise<Map<string, PropertyAlertInputs>> {
  const byProperty = new Map<string, PropertyAlertInputs>();
  for (const asset of assets) byProperty.set(asset.propertyId, { input: { today, documents: [], inspections: [], insurances: [], tenures: [], receipts: [], capexProjects: [] }, notices: [] });
  if (assets.length === 0) return byProperty;
  const assetIds = assets.map((asset) => asset.id);
  const propertyIds = assets.map((asset) => asset.propertyId);
  const propertyOfAsset = new Map(assets.map((asset) => [asset.id, asset.propertyId] as const));

  const [documents, inspections, insurances, tenures, receipts, capexProjects] = await Promise.all([
    prisma.realEstateDocument.findMany({ where: { assetId: { in: assetIds }, deletedAt: null, supersededById: null, validUntil: { not: null } }, select: { id: true, propertyId: true, title: true, validUntil: true, supersededById: true, deletedAt: true } }),
    prisma.realEstateInspection.findMany({ where: { assetId: { in: assetIds }, status: { not: "cerrada" } }, select: { id: true, propertyId: true, kind: true, status: true, result: true, scheduledAt: true, performedAt: true, nextDueAt: true, correctionDueAt: true, correctedAt: true, installationRef: true } }),
    prisma.realEstateInsurance.findMany({ where: { assetId: { in: assetIds }, status: { not: "cancelada" } }, select: { id: true, propertyId: true, kind: true, policyNumber: true, validUntil: true, status: true, noticeDays: true } }),
    prisma.realEstateTenure.findMany({ where: { assetId: { in: assetIds }, status: "vigente" } }),
    prisma.propertyTaxReceipt.findMany({ where: { tax: { assetId: { in: assetIds } }, status: { in: [...RECEIPT_STATUSES_WITH_ALERT] }, paidAt: null, dueTo: { not: null } }, select: { id: true, fiscalYear: true, period: true, status: true, dueTo: true, amount: true, tax: { select: { propertyId: true, kind: true } } } }),
    prisma.capexProject.findMany({ where: { propertyId: { in: propertyIds }, status: "in_progress", licenceRequired: true, licenceDocumentId: null }, select: { id: true, propertyId: true, name: true, status: true, licenceRequired: true, licenceDocumentId: true } })
  ]);

  for (const row of documents) byProperty.get(row.propertyId)?.input.documents!.push(documentAlertInput(row));
  const inspectionInputs = new Map<string, AlertInspectionInput[]>();
  for (const row of inspections) (inspectionInputs.get(row.propertyId) ?? inspectionInputs.set(row.propertyId, []).get(row.propertyId)!).push(inspectionAlertInput(row));
  for (const [propertyId, rows] of inspectionInputs) byProperty.get(propertyId)?.input.inspections!.push(...inspectionsForAlerts(rows));
  for (const row of insurances) {
    const entry = byProperty.get(row.propertyId);
    if (!entry) continue;
    entry.input.insurances!.push(insuranceAlertInput(row));
    entry.notices.push(insuranceNoticeOf(row));
  }
  for (const row of tenures as RealEstateTenure[]) {
    const propertyId = propertyOfAsset.get(row.assetId);
    if (propertyId) byProperty.get(propertyId)?.input.tenures!.push(tenureAlertInput(row, propertyId));
  }
  for (const row of receipts) byProperty.get(row.tax.propertyId)?.input.receipts!.push(receiptAlertInput(row));
  for (const row of capexProjects) byProperty.get(row.propertyId)?.input.capexProjects!.push(capexAlertInput(row));
  return byProperty;
}

function buildFor(entry: PropertyAlertInputs): RealEstateAlert[] {
  return applyInsuranceNotice(buildRealEstateAlerts(entry.input), entry.notices, entry.input.today);
}

// ---------------------------------------------------------------------------
// API del servicio
// ---------------------------------------------------------------------------

/** Alertas del activo de un centro (404 tipado ASSET_NOT_FOUND sin ficha). */
export async function getRealEstateAlerts(propertyId: string, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateAlert[]> {
  const asset = await prisma.realEstateAsset.findUnique({ where: { propertyId }, select: { id: true, propertyId: true } });
  if (!asset) throw realEstateError(404, "ASSET_NOT_FOUND", "Activo inmobiliario no encontrado.");
  const inputs = await loadAlertInputs([asset], today);
  const entry = inputs.get(propertyId);
  return entry ? buildFor(entry) : [];
}

/**
 * Alertas por centro para la vista de grupo: un array (posiblemente vacío) por
 * cada propertyId pedido; los centros sin ficha devuelven [].
 */
export async function alertsByProperty(propertyIds: ReadonlyArray<string>, today: IsoDay = toIsoDay(new Date())): Promise<Map<string, RealEstateAlert[]>> {
  const out = new Map<string, RealEstateAlert[]>();
  const unique = [...new Set(propertyIds)];
  for (const propertyId of unique) out.set(propertyId, []);
  if (unique.length === 0) return out;
  const assets = await prisma.realEstateAsset.findMany({ where: { propertyId: { in: unique } }, select: { id: true, propertyId: true } });
  const inputs = await loadAlertInputs(assets, today);
  for (const [propertyId, entry] of inputs) out.set(propertyId, buildFor(entry));
  return out;
}
