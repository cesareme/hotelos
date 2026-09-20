// Activo inmobiliario · ficha, unidades, cargas y valoraciones (Tanda ACT · L1,
// diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §4 modelo, §5 «Alta del
// activo», §7 API y errores).
//
// Una ficha (`RealEstateAsset`) por centro (`@@unique([propertyId])`). El alta
// crea la primera `RealEstateUnit` prellenada con Property.cadastralReference /
// surfaceM2 cuando existen y la tenencia `propiedad` en borrador a nombre de la
// sociedad (tenure.service.ts la activa). Al crear una valoración se refresca la
// caché `lastValuationValue` / `lastValuationAt` del activo con la valoración
// más reciente por `valuedAt`; `valuePerRoom` = valor / roomsCount (o
// Property.bedCapacity si roomsCount es null).
//
// Tenencia: toda ruta cuelga de `/properties/:propertyId/*`, así que la guardia
// global de server.ts (pickPropertyId → grantPropertyAccess) ya responde el 404
// opaco para un centro ajeno; aquí cada fila se busca SIEMPRE a través del
// activo del centro (`asset: { propertyId }`) y responde 404 tipado (opaco: no
// distingue «no existe» de «es de otro centro»). Dinero como Prisma.Decimal en
// el servicio y MoneyString en los DTO (payables/money.ts); días como Date
// UTC-medianoche en Prisma e IsoDay en los DTO. Los estados y catálogos son
// columnas String cuyos valores fija packages/shared/src/real-estate-types.ts.
// Auditoría con recordAuditEvent en toda escritura (entityType real_estate_*).
//
// Los mapeadores y los cálculos puros van exportados para el test unitario
// (__tests__/real-estate-service.test.mts, sin BD).

import { prisma } from "@hotelos/database";
import type { Prisma, RealEstateAsset, RealEstateCharge, RealEstateTenure, RealEstateUnit, RealEstateValuation } from "@prisma/client";
import type {
  IsoDay,
  MoneyString,
  PercentString,
  RealEstateAssetDetail,
  RealEstateAssetRecord,
  RealEstateAssetStatus,
  RealEstateCapexResponsibility,
  RealEstateChargeKind,
  RealEstateChargeRecord,
  RealEstateCostPayer,
  RealEstateEnergyRating,
  RealEstateKpis,
  RealEstateProtectionLevel,
  RealEstateRentKind,
  RealEstateRentReviewIndex,
  RealEstateRentVariableBase,
  RealEstateTenureKind,
  RealEstateTenureRecord,
  RealEstateTenureRenewal,
  RealEstateTenureStatus,
  RealEstateTitleKind,
  RealEstateUnitKind,
  RealEstateUnitRecord,
  RealEstateUnitWithCharges,
  RealEstateUseCode,
  RealEstateValuationKind,
  RealEstateValuationPurpose,
  RealEstateValuationRecord
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { NotFoundError } from "../../lib/http-error.js";
import {
  RealEstateAssetCreateSchema,
  RealEstateAssetPatchSchema,
  RealEstateChargeCreateSchema,
  RealEstateChargePatchSchema,
  RealEstateUnitCreateSchema,
  RealEstateUnitPatchSchema,
  RealEstateValuationCreateSchema
} from "../../schemas/real-estate.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { dayOf, dec, money, round2, utcDay, type Decimal } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import type { AlertTenureInput } from "./alerts.pure.js";
import { getRealEstateAlerts } from "./alerts.service.js";
import { documentsValidPctOf, inspectionsOnTimePctOf, type GroupDocumentRow, type GroupInspectionRow } from "./group.service.js";
import { computeAnnualTaxBurden, toPropertyTaxRecord } from "./property-tax.service.js";
import { assertCadastralReference, isValidCadastralReference, normalizeCadastralReference } from "./cadastral.js";
import { realEstateError } from "./errors.js";
import { toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type RealEstateCommandInput = { context: UserContext; propertyId: string; correlationId: string };

const UNIQUE_VIOLATION = "P2002";

const isUniqueViolation = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

// ---------------------------------------------------------------------------
// Conversión de valores (Prisma → DTO)
// ---------------------------------------------------------------------------

export function moneyOrNull(value: Decimal | string | number | null | undefined): MoneyString | null {
  return value === null || value === undefined ? null : money(value);
}

export function percentOrNull(value: Decimal | string | number | null | undefined): PercentString | null {
  return value === null || value === undefined ? null : dec(value).toFixed(2);
}

/** `dayOf` tipado como IsoDay (las columnas @db.Date vuelven como Date UTC-medianoche). */
export function isoDayOrNull(value: Date | null | undefined): IsoDay | null {
  return dayOf(value);
}

// ---------------------------------------------------------------------------
// Mapeadores (filas Prisma → DTO de packages/shared)
// ---------------------------------------------------------------------------

export function toRealEstateAssetRecord(row: RealEstateAsset): RealEstateAssetRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    legalEntityId: row.legalEntityId ?? null,
    propertyId: row.propertyId,
    name: row.name,
    yearBuilt: row.yearBuilt ?? null,
    yearLastRefurbished: row.yearLastRefurbished ?? null,
    builtSurfaceM2: moneyOrNull(row.builtSurfaceM2),
    plotSurfaceM2: moneyOrNull(row.plotSurfaceM2),
    floorsAbove: row.floorsAbove ?? null,
    floorsBelow: row.floorsBelow ?? null,
    roomsCount: row.roomsCount ?? null,
    protectionLevel: row.protectionLevel as RealEstateProtectionLevel,
    energyRating: (row.energyRating ?? null) as RealEstateEnergyRating | null,
    energyCertValidUntil: isoDayOrNull(row.energyCertValidUntil),
    cadastralValueTotal: moneyOrNull(row.cadastralValueTotal),
    cadastralValueYear: row.cadastralValueYear ?? null,
    referenceValue: moneyOrNull(row.referenceValue),
    lastValuationValue: moneyOrNull(row.lastValuationValue),
    lastValuationAt: isoDayOrNull(row.lastValuationAt),
    currentTenureKind: (row.currentTenureKind ?? null) as RealEstateTenureKind | null,
    status: row.status as RealEstateAssetStatus,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toRealEstateChargeRecord(row: RealEstateCharge): RealEstateChargeRecord {
  return {
    id: row.id,
    unitId: row.unitId,
    kind: row.kind as RealEstateChargeKind,
    holderName: row.holderName ?? null,
    holderTaxId: row.holderTaxId ?? null,
    amount: moneyOrNull(row.amount),
    outstandingAmount: moneyOrNull(row.outstandingAmount),
    registeredAt: isoDayOrNull(row.registeredAt),
    expiresAt: isoDayOrNull(row.expiresAt),
    cancelledAt: isoDayOrNull(row.cancelledAt),
    documentId: row.documentId ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

export function toRealEstateUnitRecord(row: RealEstateUnit): RealEstateUnitRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    assetId: row.assetId,
    kind: row.kind as RealEstateUnitKind,
    registryOffice: row.registryOffice ?? null,
    registryFincaNumber: row.registryFincaNumber ?? null,
    registryTomo: row.registryTomo ?? null,
    registryLibro: row.registryLibro ?? null,
    registryFolio: row.registryFolio ?? null,
    cru: row.cru ?? null,
    cadastralReference: row.cadastralReference ?? null,
    useCode: (row.useCode ?? null) as RealEstateUseCode | null,
    surfaceM2: moneyOrNull(row.surfaceM2),
    cadastralValueLand: moneyOrNull(row.cadastralValueLand),
    cadastralValueBuilding: moneyOrNull(row.cadastralValueBuilding),
    titleKind: row.titleKind as RealEstateTitleKind,
    titleHolderTaxId: row.titleHolderTaxId ?? null,
    titleHolderName: row.titleHolderName ?? null,
    titleDeedDate: isoDayOrNull(row.titleDeedDate),
    notary: row.notary ?? null,
    fixedAssetId: row.fixedAssetId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toRealEstateUnitWithCharges(row: RealEstateUnit & { charges: RealEstateCharge[] }): RealEstateUnitWithCharges {
  return { ...toRealEstateUnitRecord(row), charges: row.charges.map(toRealEstateChargeRecord) };
}

export function toRealEstateValuationRecord(row: RealEstateValuation): RealEstateValuationRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    kind: row.kind as RealEstateValuationKind,
    purpose: (row.purpose ?? null) as RealEstateValuationPurpose | null,
    valuedAt: dayOf(row.valuedAt) as IsoDay,
    value: money(row.value),
    valuePerRoom: moneyOrNull(row.valuePerRoom),
    capRatePct: percentOrNull(row.capRatePct),
    method: row.method ?? null,
    appraiser: row.appraiser ?? null,
    documentId: row.documentId ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Estado DERIVADO de una tenencia (diseño §5.1): una tenencia `vigente` cuya
 * `endDate` ya pasó se muestra `vencido`; nunca se persiste (la máquina TENURE
 * de state-machines.ts sigue viendo `vigente` y el motor de alertas la señala).
 */
export function deriveTenureStatus(tenure: { status: string; endDate: Date | null }, today: IsoDay): RealEstateTenureStatus {
  if (tenure.status === "vigente" && tenure.endDate && (dayOf(tenure.endDate) as IsoDay) < today) return "vencido";
  return tenure.status as RealEstateTenureStatus;
}

export function toRealEstateTenureRecord(row: RealEstateTenure, today: IsoDay): RealEstateTenureRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    kind: row.kind as RealEstateTenureKind,
    counterpartyName: row.counterpartyName ?? null,
    counterpartyTaxId: row.counterpartyTaxId ?? null,
    counterpartyNonResident: row.counterpartyNonResident,
    startDate: dayOf(row.startDate) as IsoDay,
    endDate: isoDayOrNull(row.endDate),
    noticeMonths: row.noticeMonths ?? null,
    renewal: row.renewal as RealEstateTenureRenewal,
    rentKind: (row.rentKind ?? null) as RealEstateRentKind | null,
    rentMonthly: moneyOrNull(row.rentMonthly),
    rentVariablePct: percentOrNull(row.rentVariablePct),
    rentVariableBase: (row.rentVariableBase ?? null) as RealEstateRentVariableBase | null,
    rentReviewIndex: (row.rentReviewIndex ?? null) as RealEstateRentReviewIndex | null,
    rentReviewMonth: row.rentReviewMonth ?? null,
    depositAmount: moneyOrNull(row.depositAmount),
    vatApplies: row.vatApplies,
    withholdingApplies: row.withholdingApplies,
    withholdingRatePct: percentOrNull(row.withholdingRatePct),
    ibiPayer: row.ibiPayer as RealEstateCostPayer,
    insurancePayer: row.insurancePayer as RealEstateCostPayer,
    capexResponsibility: row.capexResponsibility as RealEstateCapexResponsibility,
    ffeReservePct: percentOrNull(row.ffeReservePct),
    brandName: row.brandName ?? null,
    status: deriveTenureStatus(row, today),
    documentId: row.documentId ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Proyección de una tenencia para el motor de alertas (alerts.pure.ts): estado persistido, sin contrapartes. */
export function tenureAlertInput(row: RealEstateTenure, propertyId: string): AlertTenureInput {
  return {
    id: row.id,
    propertyId,
    kind: row.kind as RealEstateTenureKind,
    status: row.status,
    endDate: isoDayOrNull(row.endDate),
    noticeMonths: row.noticeMonths ?? null,
    renewal: row.renewal,
    rentReviewIndex: row.rentReviewIndex ?? null,
    rentReviewMonth: row.rentReviewMonth ?? null
  };
}

// ---------------------------------------------------------------------------
// Cálculos puros (diseño §4 KPIs, §5 alta)
// ---------------------------------------------------------------------------

/** Divisor de `valuePerRoom`: roomsCount del activo, si no Property.bedCapacity; null sin ninguno de los dos (> 0). */
export function roomsForValuation(asset: { roomsCount: number | null }, property: { bedCapacity: number | null } | null | undefined): number | null {
  if (asset.roomsCount !== null && asset.roomsCount > 0) return asset.roomsCount;
  const beds = property?.bedCapacity ?? null;
  if (beds !== null && beds > 0) return beds;
  return null;
}

/** valor / habitaciones al céntimo (ROUND_HALF_UP); null sin divisor. */
export function computeValuePerRoom(value: Decimal | string | number, rooms: number | null): Decimal | null {
  if (rooms === null || rooms <= 0) return null;
  return round2(dec(value).div(rooms));
}

/**
 * Datos de la primera unidad del alta (§5): la referencia catastral del censo
 * del centro, normalizada, solo si tiene la forma válida (un valor del censo
 * mal tecleado no bloquea el alta: la unidad nace sin referencia y se corrige
 * con PATCH …/units/:unitId), y la superficie tal cual.
 */
export function initialUnitFromProperty(property: { cadastralReference: string | null; surfaceM2: Decimal | null }): { cadastralReference: string | null; surfaceM2: Decimal | null } {
  const raw = property.cadastralReference?.trim() ?? "";
  const normalized = raw.length > 0 ? normalizeCadastralReference(raw) : null;
  return {
    cadastralReference: normalized !== null && isValidCadastralReference(normalized) ? normalized : null,
    surfaceM2: property.surfaceM2 ?? null
  };
}

/** Valor catastral total: el de la ficha; si falta, Σ (suelo + construcción) de las unidades que lo informan; null sin datos. */
export function cadastralValueTotalOf(asset: { cadastralValueTotal: Decimal | null }, units: ReadonlyArray<{ cadastralValueLand: Decimal | null; cadastralValueBuilding: Decimal | null }>): Decimal | null {
  if (asset.cadastralValueTotal !== null) return dec(asset.cadastralValueTotal);
  let total: Decimal | null = null;
  for (const unit of units) {
    for (const part of [unit.cadastralValueLand, unit.cadastralValueBuilding]) {
      if (part === null) continue;
      total = (total ?? dec(0)).plus(part);
    }
  }
  return total;
}

/** KPIs parciales de L1 (§4): catastral, última valoración y valor por habitación; tributos, documentos e inspecciones llegan en L2/L3/L5. */
/**
 * KPIs de la ficha (puro). Carga fiscal, % de documentos vigentes y % de
 * inspecciones en plazo usan las MISMAS definiciones que la fila de la vista de
 * grupo (group.service.ts: computeAnnualTaxBurden · documentsValidPctOf ·
 * inspectionsOnTimePctOf; ACT-REV-06); sin las filas correspondientes quedan
 * en null.
 */
export function computeRealEstateKpis(input: {
  asset: { cadastralValueTotal: Decimal | null; lastValuationValue: Decimal | null; roomsCount: number | null };
  units: ReadonlyArray<{ cadastralValueLand: Decimal | null; cadastralValueBuilding: Decimal | null }>;
  property: { bedCapacity: number | null } | null | undefined;
  openAlerts: number;
  taxes?: ReadonlyArray<{ status: string; taxpayer: string; expectedAnnualAmount: Decimal | string | null }>;
  documents?: ReadonlyArray<GroupDocumentRow>;
  inspections?: ReadonlyArray<GroupInspectionRow>;
  today?: IsoDay;
}): RealEstateKpis {
  const cadastral = cadastralValueTotalOf(input.asset, input.units);
  const lastValuation = input.asset.lastValuationValue === null ? null : dec(input.asset.lastValuationValue);
  const perRoom = lastValuation === null ? null : computeValuePerRoom(lastValuation, roomsForValuation(input.asset, input.property));
  return {
    cadastralValueTotal: moneyOrNull(cadastral),
    lastValuationValue: moneyOrNull(lastValuation),
    valuePerRoom: moneyOrNull(perRoom),
    annualTaxBurden: input.taxes ? computeAnnualTaxBurden(input.taxes) : null,
    documentsValidPct: input.documents && input.today ? documentsValidPctOf(input.documents, input.today) : null,
    inspectionsOnTimePct: input.inspections && input.today ? inspectionsOnTimePctOf(input.inspections, input.today) : null,
    openAlerts: input.openAlerts
  };
}

/** NIF / CIF en la auditoría: solo los tres últimos caracteres (ACT-REV-08: la cadena de auditoría no se borra). */
export function maskTaxId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= 3 ? "***" : `***${text.slice(-3)}`;
}

const MASKED_AUDIT_KEYS: ReadonlySet<string> = new Set(["titleHolderTaxId", "holderTaxId", "counterpartyTaxId"]);

/** Proyección auditable de `record` sobre `keys`: los identificadores fiscales van enmascarados. */
export function auditProjectionOf<T extends object>(record: T, keys: ReadonlyArray<keyof T>): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, MASKED_AUDIT_KEYS.has(String(key)) ? maskTaxId(record[key]) : ((record[key] as unknown) ?? null)]));
}

/** Copia de `data` sin las claves `undefined` (un PATCH solo escribe lo que envía; `null` sí borra). */
export function definedFields<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Búsquedas con tenencia (siempre a través del activo del centro)
// ---------------------------------------------------------------------------

/** Ficha del centro o 404 tipado `ASSET_NOT_FOUND` (opaco). */
export async function requireRealEstateAsset(db: Db, propertyId: string): Promise<RealEstateAsset> {
  const row = await db.realEstateAsset.findUnique({ where: { propertyId } });
  if (!row) throw realEstateError(404, "ASSET_NOT_FOUND", "Activo inmobiliario no encontrado.");
  return row;
}

export async function requireRealEstateUnit(db: Db, propertyId: string, unitId: string): Promise<RealEstateUnit> {
  const row = await db.realEstateUnit.findFirst({ where: { id: unitId, asset: { propertyId } } });
  if (!row) throw realEstateError(404, "UNIT_NOT_FOUND", "Unidad registral no encontrada.");
  return row;
}

async function requireRealEstateCharge(db: Db, propertyId: string, chargeId: string): Promise<RealEstateCharge> {
  const row = await db.realEstateCharge.findFirst({ where: { id: chargeId, unit: { asset: { propertyId } } } });
  if (!row) throw new NotFoundError("Carga no encontrada.");
  return row;
}

type PropertyCensus = { id: string; organizationId: string; legalEntityId: string | null; cadastralReference: string | null; surfaceM2: Decimal | null; bedCapacity: number | null };

async function requireProperty(db: Db, propertyId: string): Promise<PropertyCensus> {
  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: { id: true, organizationId: true, legalEntityId: true, cadastralReference: true, surfaceM2: true, bedCapacity: true }
  });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property;
}

/**
 * Sociedad de la ficha: la del cuerpo (debe ser de la misma organización; si no,
 * 404 opaco), si no la del centro, si no la sociedad por defecto de la
 * organización; null cuando la organización no tiene ninguna.
 */
async function resolveLegalEntity(db: Db, property: PropertyCensus, requested: string | null | undefined): Promise<{ id: string; legalName: string; taxId: string | null } | null> {
  const select = { id: true, legalName: true, taxId: true } as const;
  if (requested) {
    const entity = await db.legalEntity.findFirst({ where: { id: requested, organizationId: property.organizationId }, select });
    if (!entity) throw new NotFoundError("Sociedad no encontrada.");
    return entity;
  }
  if (property.legalEntityId) {
    const entity = await db.legalEntity.findFirst({ where: { id: property.legalEntityId, organizationId: property.organizationId }, select });
    if (entity) return entity;
  }
  return db.legalEntity.findFirst({ where: { organizationId: property.organizationId, isDefault: true }, select, orderBy: { createdAt: "asc" } });
}

/** 400 `INVALID_CADASTRAL_REFERENCE` (cadastral.ts) antes del parseo zod, para que el código tipado gane al VALIDATION_ERROR genérico. */
function assertCadastralReferenceInBody(body: unknown): void {
  const raw = (body as { cadastralReference?: unknown } | null | undefined)?.cadastralReference;
  if (typeof raw === "string") assertCadastralReference(raw);
}

// ---------------------------------------------------------------------------
// Ficha (GET · POST · PATCH /properties/:propertyId/real-estate)
// ---------------------------------------------------------------------------

export async function getRealEstateAssetDetail(propertyId: string, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateAssetDetail> {
  const asset = await prisma.realEstateAsset.findUnique({
    where: { propertyId },
    include: {
      units: { orderBy: { createdAt: "asc" }, include: { charges: { orderBy: { createdAt: "asc" } } } },
      valuations: { orderBy: [{ valuedAt: "desc" }, { createdAt: "desc" }] },
      tenures: { orderBy: [{ startDate: "desc" }, { createdAt: "desc" }] }
    }
  });
  if (!asset) throw realEstateError(404, "ASSET_NOT_FOUND", "Activo inmobiliario no encontrado.");
  // ACT-REV-06: la ficha usa el MISMO motor de alertas (alerts.service.ts) y las mismas definiciones de KPI que la
  // vista de grupo (tributos, documentos vivos, inspecciones abiertas); antes solo calculaba alertas de tenencia.
  const [property, alerts, taxRows, documents, inspections] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { bedCapacity: true } }),
    getRealEstateAlerts(propertyId, today),
    prisma.propertyTax.findMany({ where: { assetId: asset.id }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] }),
    prisma.realEstateDocument.findMany({ where: { assetId: asset.id, deletedAt: null, supersededById: null }, select: { category: true, validUntil: true, supersededById: true } }),
    prisma.realEstateInspection.findMany({ where: { assetId: asset.id, status: { not: "cerrada" } }, select: { status: true, scheduledAt: true, nextDueAt: true } })
  ]);
  const current = asset.tenures.find((tenure) => tenure.status === "vigente") ?? null;
  return {
    asset: toRealEstateAssetRecord(asset),
    units: asset.units.map(toRealEstateUnitWithCharges),
    valuations: asset.valuations.map(toRealEstateValuationRecord),
    currentTenure: current ? toRealEstateTenureRecord(current, today) : null,
    taxes: taxRows.map(toPropertyTaxRecord),
    kpis: computeRealEstateKpis({ asset, units: asset.units, property, openAlerts: alerts.length, taxes: taxRows, documents, inspections, today }),
    alerts
  };
}

export async function createRealEstateAsset(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateAssetDetail> {
  const data = parseOr400(RealEstateAssetCreateSchema, input.body ?? {}, "Activo inmobiliario");
  const property = await requireProperty(prisma, input.propertyId);
  const existing = await prisma.realEstateAsset.findUnique({ where: { propertyId: input.propertyId }, select: { id: true } });
  if (existing) throw realEstateError(409, "ASSET_ALREADY_EXISTS", "Este centro ya tiene ficha de activo inmobiliario.", { assetId: existing.id });
  const legalEntity = await resolveLegalEntity(prisma, property, data.legalEntityId);
  const today = toIsoDay(new Date());
  const firstUnit = initialUnitFromProperty(property);
  const { legalEntityId: _ignored, ...fields } = data;
  let created: RealEstateAsset & { units: RealEstateUnit[]; tenures: RealEstateTenure[] };
  try {
    created = await prisma.realEstateAsset.create({
      data: {
        ...fields,
        organizationId: property.organizationId,
        propertyId: property.id,
        legalEntityId: legalEntity?.id ?? null,
        status: "active",
        units: {
          create: [{ organizationId: property.organizationId, kind: "finca_registral", cadastralReference: firstUnit.cadastralReference, surfaceM2: firstUnit.surfaceM2, useCode: "hotelero", titleKind: "pleno_dominio" }]
        },
        tenures: {
          create: [{ kind: "propiedad", counterpartyName: legalEntity?.legalName ?? null, counterpartyTaxId: legalEntity?.taxId ?? null, startDate: utcDay(today), renewal: "ninguna", status: "borrador" }]
        }
      },
      include: { units: true, tenures: true }
    });
  } catch (error) {
    // Carrera entre dos altas simultáneas del mismo centro (@@unique([propertyId])).
    if (isUniqueViolation(error)) throw realEstateError(409, "ASSET_ALREADY_EXISTS", "Este centro ya tiene ficha de activo inmobiliario.");
    throw error;
  }
  const unit = created.units[0];
  const tenure = created.tenures[0];
  const audit = { organizationId: property.organizationId, propertyId: property.id, actorUserId: input.context.userId, actorType: "user" as const, correlationId: input.correlationId };
  recordAuditEvent({ ...audit, action: "REAL_ESTATE_ASSET_CREATED", entityType: "real_estate_asset", entityId: created.id, afterJson: { name: created.name, legalEntityId: created.legalEntityId, roomsCount: created.roomsCount, unitId: unit?.id ?? null, tenureId: tenure?.id ?? null } });
  if (unit) recordAuditEvent({ ...audit, action: "REAL_ESTATE_UNIT_CREATED", entityType: "real_estate_unit", entityId: unit.id, afterJson: { assetId: created.id, kind: unit.kind, cadastralReference: unit.cadastralReference, surfaceM2: moneyOrNull(unit.surfaceM2), source: "alta" } });
  if (tenure) recordAuditEvent({ ...audit, action: "REAL_ESTATE_TENURE_CREATED", entityType: "real_estate_tenure", entityId: tenure.id, afterJson: { assetId: created.id, kind: tenure.kind, status: tenure.status, legalEntityId: legalEntity?.id ?? null, source: "alta" } });
  return getRealEstateAssetDetail(input.propertyId, today);
}

export async function updateRealEstateAsset(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateAssetDetail> {
  const data = parseOr400(RealEstateAssetPatchSchema, input.body ?? {}, "Activo inmobiliario");
  const before = await requireRealEstateAsset(prisma, input.propertyId);
  const patch = definedFields(data) as Prisma.RealEstateAssetUncheckedUpdateInput;
  if (data.legalEntityId) {
    const property = await requireProperty(prisma, input.propertyId);
    const entity = await resolveLegalEntity(prisma, property, data.legalEntityId);
    patch.legalEntityId = entity?.id ?? null;
  }
  const after = await prisma.realEstateAsset.update({ where: { id: before.id }, data: patch });
  const beforeRecord = toRealEstateAssetRecord(before);
  const afterRecord = toRealEstateAssetRecord(after);
  const changed = Object.keys(patch) as Array<keyof RealEstateAssetRecord>;
  recordAuditEvent({
    organizationId: before.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_ASSET_UPDATED",
    entityType: "real_estate_asset",
    entityId: before.id,
    beforeJson: Object.fromEntries(changed.map((key) => [key, beforeRecord[key] ?? null])),
    afterJson: Object.fromEntries(changed.map((key) => [key, afterRecord[key] ?? null])),
    correlationId: input.correlationId
  });
  return getRealEstateAssetDetail(input.propertyId);
}

// ---------------------------------------------------------------------------
// Unidades (POST …/units · PATCH …/units/:unitId)
// ---------------------------------------------------------------------------

export async function createRealEstateUnit(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateUnitWithCharges> {
  assertCadastralReferenceInBody(input.body);
  const data = parseOr400(RealEstateUnitCreateSchema, input.body ?? {}, "Unidad registral");
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  const row = await prisma.realEstateUnit.create({ data: { ...definedFields(data), organizationId: asset.organizationId, assetId: asset.id }, include: { charges: true } });
  const record = toRealEstateUnitWithCharges(row);
  recordAuditEvent({
    organizationId: asset.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_UNIT_CREATED",
    entityType: "real_estate_unit",
    entityId: row.id,
    afterJson: { assetId: asset.id, kind: record.kind, cadastralReference: record.cadastralReference, registryFincaNumber: record.registryFincaNumber, surfaceM2: record.surfaceM2, titleKind: record.titleKind },
    correlationId: input.correlationId
  });
  return record;
}

export async function updateRealEstateUnit(input: RealEstateCommandInput & { unitId: string; body: unknown }): Promise<RealEstateUnitWithCharges> {
  assertCadastralReferenceInBody(input.body);
  const data = parseOr400(RealEstateUnitPatchSchema, input.body ?? {}, "Unidad registral");
  const before = await requireRealEstateUnit(prisma, input.propertyId, input.unitId);
  const patch = definedFields(data);
  const after = await prisma.realEstateUnit.update({ where: { id: before.id }, data: patch, include: { charges: { orderBy: { createdAt: "asc" } } } });
  const beforeRecord = toRealEstateUnitRecord(before);
  const afterRecord = toRealEstateUnitRecord(after);
  const changed = Object.keys(patch) as Array<keyof RealEstateUnitRecord>;
  recordAuditEvent({
    organizationId: before.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_UNIT_UPDATED",
    entityType: "real_estate_unit",
    entityId: before.id,
    beforeJson: auditProjectionOf(beforeRecord, changed),
    afterJson: auditProjectionOf(afterRecord, changed),
    correlationId: input.correlationId
  });
  return toRealEstateUnitWithCharges(after);
}

// ---------------------------------------------------------------------------
// Cargas (POST …/units/:unitId/charges · PATCH …/charges/:chargeId)
// ---------------------------------------------------------------------------

export async function createRealEstateCharge(input: RealEstateCommandInput & { unitId: string; body: unknown }): Promise<RealEstateChargeRecord> {
  const data = parseOr400(RealEstateChargeCreateSchema, input.body ?? {}, "Carga");
  const unit = await requireRealEstateUnit(prisma, input.propertyId, input.unitId);
  const row = await prisma.realEstateCharge.create({ data: { ...data, unitId: unit.id } });
  const record = toRealEstateChargeRecord(row);
  recordAuditEvent({
    organizationId: unit.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_CHARGE_CREATED",
    entityType: "real_estate_charge",
    entityId: row.id,
    afterJson: { unitId: unit.id, kind: record.kind, amount: record.amount, outstandingAmount: record.outstandingAmount, registeredAt: record.registeredAt },
    correlationId: input.correlationId
  });
  return record;
}

export async function updateRealEstateCharge(input: RealEstateCommandInput & { chargeId: string; body: unknown }): Promise<RealEstateChargeRecord> {
  const data = parseOr400(RealEstateChargePatchSchema, input.body ?? {}, "Carga");
  const before = await requireRealEstateCharge(prisma, input.propertyId, input.chargeId);
  const unit = await requireRealEstateUnit(prisma, input.propertyId, before.unitId);
  const patch = definedFields(data);
  const after = await prisma.realEstateCharge.update({ where: { id: before.id }, data: patch });
  const beforeRecord = toRealEstateChargeRecord(before);
  const afterRecord = toRealEstateChargeRecord(after);
  const changed = Object.keys(patch) as Array<keyof RealEstateChargeRecord>;
  recordAuditEvent({
    organizationId: unit.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_CHARGE_UPDATED",
    entityType: "real_estate_charge",
    entityId: before.id,
    beforeJson: auditProjectionOf(beforeRecord, changed),
    afterJson: auditProjectionOf(afterRecord, changed),
    correlationId: input.correlationId
  });
  return afterRecord;
}

// ---------------------------------------------------------------------------
// Valoraciones (GET · POST …/valuations)
// ---------------------------------------------------------------------------

export async function listRealEstateValuations(propertyId: string): Promise<RealEstateValuationRecord[]> {
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const rows = await prisma.realEstateValuation.findMany({ where: { assetId: asset.id }, orderBy: [{ valuedAt: "desc" }, { createdAt: "desc" }] });
  return rows.map(toRealEstateValuationRecord);
}

/**
 * Registra una valoración manual (sin tasadora externa, decisión del brief) y
 * refresca la caché del activo con la valoración más reciente por `valuedAt`
 * (una tasación antigua registrada tarde no pisa a la última).
 */
export async function createRealEstateValuation(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateValuationRecord> {
  const data = parseOr400(RealEstateValuationCreateSchema, input.body ?? {}, "Valoración");
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { bedCapacity: true } });
  const valuePerRoom = data.valuePerRoom ?? computeValuePerRoom(data.value, roomsForValuation(asset, property));
  const { row, cache } = await prisma.$transaction(async (tx) => {
    const created = await tx.realEstateValuation.create({ data: { ...data, valuePerRoom, assetId: asset.id } });
    const latest = await tx.realEstateValuation.findFirst({ where: { assetId: asset.id }, orderBy: [{ valuedAt: "desc" }, { createdAt: "desc" }], select: { value: true, valuedAt: true } });
    const updated = await tx.realEstateAsset.update({ where: { id: asset.id }, data: { lastValuationValue: latest?.value ?? created.value, lastValuationAt: latest?.valuedAt ?? created.valuedAt }, select: { lastValuationValue: true, lastValuationAt: true } });
    return { row: created, cache: updated };
  });
  const record = toRealEstateValuationRecord(row);
  recordAuditEvent({
    organizationId: asset.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_VALUATION_CREATED",
    entityType: "real_estate_valuation",
    entityId: row.id,
    beforeJson: { lastValuationValue: moneyOrNull(asset.lastValuationValue), lastValuationAt: isoDayOrNull(asset.lastValuationAt) },
    afterJson: { assetId: asset.id, kind: record.kind, purpose: record.purpose, valuedAt: record.valuedAt, value: record.value, valuePerRoom: record.valuePerRoom, lastValuationValue: moneyOrNull(cache.lastValuationValue), lastValuationAt: isoDayOrNull(cache.lastValuationAt) },
    correlationId: input.correlationId
  });
  return record;
}
