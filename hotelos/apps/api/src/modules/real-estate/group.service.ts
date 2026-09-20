// Activo inmobiliario · vista de grupo (Tanda ACT · L6, diseño §7 «Vista de
// grupo» y §8 «Grupo»): una fila por centro con tenencia, valor catastral,
// última tasación, carga fiscal anual, % de documentos vigentes, % de
// inspecciones en plazo y alertas, más los totales y las alertas altas del grupo.
//
// Ámbito (§7): la ruta comprueba la organización con assertEntityAccess; aquí
// se filtran los centros con las reglas de lib/finance-scope.ts:
//   · hasEntityReadScope → todos los centros de la sociedad (owner, quien tenga
//     accounting.entity.read o un ámbito explícito de organización);
//   · si no, propertyWithinScope → solo los centros asignados (un director con
//     una asignación ve su fila);
//   · filterOperationalProperties / isOperationalKind deja fuera la oficina
//     salvo que tenga ficha de activo (§7: «deja fuera la oficina salvo que
//     tenga activo»).
// Un centro operativo sin ficha aparece con la fila vacía (todo null / 0): la
// vista de grupo es el censo de centros visibles, no el de fichas.
//
// KPIs por fila (mismas definiciones que RealEstateKpis, packages/shared):
//   · cadastralValueTotal: cadastralValueTotalOf (ficha o Σ unidades);
//   · lastValuationValue: caché de la ficha;
//   · annualTaxBurden: computeAnnualTaxBurden (Σ expectedAnnualAmount de los
//     tributos activos con taxpayer = sociedad);
//   · documentsValidPct: % vigente | sin_fecha sobre los documentos vivos (sin
//     deletedAt ni supersededById) con documentStatusOf y los días de aviso por
//     defecto (30; 90 en inspecciones y seguros); null sin documentos;
//   · inspectionsOnTimePct: % de inspecciones abiertas (status ≠ cerrada) cuyo
//     plazo (inspectionDueDate) no ha vencido; sin fecha cuenta como en plazo;
//     null sin inspecciones;
//   · openAlerts / openAlertsHigh: alertsByProperty (alerts.service.ts).
// Todo se carga por lotes: una consulta por tabla para N centros. Sin escrituras.

import { prisma } from "@hotelos/database";
import type { IsoDay, MoneyString, PercentString, PropertyKind, RealEstateAlert, RealEstateGroupOverview, RealEstateGroupRow, RealEstateGroupTotals, RealEstateTenureKind } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { hasEntityReadScope, isOperationalKind, propertyWithinScope, type FinanceScopeContext } from "../../lib/finance-scope.js";
import { dec, money, type Decimal } from "../payables/money.js";
import { sortRealEstateAlerts } from "./alerts.pure.js";
import { alertsByProperty } from "./alerts.service.js";
import { documentStatusOf } from "./documents.service.js";
import { inspectionDueDate } from "./inspections.service.js";
import { computeAnnualTaxBurden } from "./property-tax.service.js";
import { cadastralValueTotalOf, isoDayOrNull, moneyOrNull } from "./real-estate.service.js";
import { toIsoDay } from "./vigencias.js";

// ---------------------------------------------------------------------------
// Centros visibles (ámbito del contexto + ficha)
// ---------------------------------------------------------------------------

export type VisibleRealEstateProperty = {
  propertyId: string;
  propertyCode: string | null;
  propertyName: string;
  kind: PropertyKind | string;
  /** Ficha del centro (RealEstateAsset.id) o null si aún no tiene. */
  assetId: string | null;
};

export type ScopeSubject = Pick<FinanceScopeContext, "permissions" | "assignedPropertyIds" | "isPlatformAdmin" | "orgScope">;

/**
 * Puro: centros que el contexto puede ver en la vista de grupo. Ámbito de
 * sociedad → todos; si no, los asignados. Los centros no operativos (oficina,
 * otros) solo entran si tienen ficha de activo.
 */
export function selectVisibleProperties<T extends { id: string; kind?: PropertyKind | string | null }>(context: ScopeSubject, rows: ReadonlyArray<T>, propertiesWithAsset: ReadonlySet<string>): T[] {
  const inScope = hasEntityReadScope(context) ? [...rows] : rows.filter((row) => propertyWithinScope(context, row.id));
  return inScope.filter((row) => isOperationalKind(row.kind) || propertiesWithAsset.has(row.id));
}

/** Centros visibles de la organización (sin los cerrados), con su ficha si existe; orden de alta. */
export async function listVisibleRealEstateProperties(context: ScopeSubject, organizationId: string): Promise<VisibleRealEstateProperty[]> {
  const rows = await prisma.property.findMany({
    where: { organizationId, status: { not: "closed" } },
    select: { id: true, code: true, name: true, kind: true },
    orderBy: { createdAt: "asc" }
  });
  if (rows.length === 0) return [];
  const assets = await prisma.realEstateAsset.findMany({ where: { propertyId: { in: rows.map((row) => row.id) } }, select: { id: true, propertyId: true } });
  const assetOf = new Map(assets.map((asset) => [asset.propertyId, asset.id] as const));
  return selectVisibleProperties(context, rows, new Set(assetOf.keys())).map((row) => ({
    propertyId: row.id,
    propertyCode: row.code ?? null,
    propertyName: row.name,
    kind: row.kind,
    assetId: assetOf.get(row.id) ?? null
  }));
}

// ---------------------------------------------------------------------------
// Cálculos puros de la fila y de los totales
// ---------------------------------------------------------------------------

/** `part / total × 100` con dos decimales; null cuando no hay población. */
export function percentOf(part: number, total: number): PercentString | null {
  if (total <= 0) return null;
  return dec(part).mul(100).div(total).toDecimalPlaces(2).toFixed(2);
}

export type GroupDocumentRow = { category: string; validUntil: Date | null; supersededById: string | null };
export type GroupInspectionRow = { status: string; scheduledAt: Date | null; nextDueAt: Date | null };

/** % de documentos vivos con vigencia `vigente` o `sin_fecha`; null sin documentos. */
export function documentsValidPctOf(rows: ReadonlyArray<GroupDocumentRow>, today: IsoDay): PercentString | null {
  const valid = rows.filter((row) => {
    const status = documentStatusOf(row, today);
    return status === "vigente" || status === "sin_fecha";
  }).length;
  return percentOf(valid, rows.length);
}

/** % de inspecciones abiertas (≠ cerrada) cuyo plazo no ha vencido (sin fecha = en plazo); null sin inspecciones. */
export function inspectionsOnTimePctOf(rows: ReadonlyArray<GroupInspectionRow>, today: IsoDay): PercentString | null {
  const open = rows.filter((row) => row.status !== "cerrada");
  const onTime = open.filter((row) => {
    const due = inspectionDueDate({ status: row.status, scheduledAt: isoDayOrNull(row.scheduledAt), nextDueAt: isoDayOrNull(row.nextDueAt) });
    return due === null || due >= today;
  }).length;
  return percentOf(onTime, open.length);
}

export type GroupAssetRow = {
  id: string;
  propertyId: string;
  cadastralValueTotal: Decimal | null;
  lastValuationValue: Decimal | null;
  currentTenureKind: string | null;
  units: ReadonlyArray<{ cadastralValueLand: Decimal | null; cadastralValueBuilding: Decimal | null }>;
};

export type GroupRowInput = {
  property: Pick<VisibleRealEstateProperty, "propertyId" | "propertyCode" | "propertyName">;
  asset: GroupAssetRow | null;
  taxes: ReadonlyArray<{ status: string; taxpayer: string; expectedAnnualAmount: Decimal | string | null }>;
  documents: ReadonlyArray<GroupDocumentRow>;
  inspections: ReadonlyArray<GroupInspectionRow>;
  alerts: ReadonlyArray<RealEstateAlert>;
  today: IsoDay;
};

/** Fila de la vista de grupo (puro). Un centro sin ficha responde todo null / 0. */
export function buildGroupRow(input: GroupRowInput): RealEstateGroupRow {
  const { property, asset } = input;
  const openAlerts = input.alerts.length;
  const openAlertsHigh = input.alerts.filter((alert) => alert.severity === "alta").length;
  if (!asset) {
    return { propertyId: property.propertyId, propertyCode: property.propertyCode, propertyName: property.propertyName, tenureKind: null, cadastralValueTotal: null, lastValuationValue: null, annualTaxBurden: null, documentsValidPct: null, inspectionsOnTimePct: null, openAlertsHigh, openAlerts };
  }
  return {
    propertyId: property.propertyId,
    propertyCode: property.propertyCode,
    propertyName: property.propertyName,
    tenureKind: (asset.currentTenureKind ?? null) as RealEstateTenureKind | null,
    cadastralValueTotal: moneyOrNull(cadastralValueTotalOf(asset, asset.units)),
    lastValuationValue: moneyOrNull(asset.lastValuationValue),
    annualTaxBurden: computeAnnualTaxBurden(input.taxes),
    documentsValidPct: documentsValidPctOf(input.documents, input.today),
    inspectionsOnTimePct: inspectionsOnTimePctOf(input.inspections, input.today),
    openAlertsHigh,
    openAlerts
  };
}

function sumMoney(values: ReadonlyArray<MoneyString | null>): MoneyString {
  let total = dec(0);
  for (const value of values) if (value !== null) total = total.plus(value);
  return money(total);
}

/** Totales del grupo (puro): sumas de las filas; los null suman 0. */
export function computeGroupTotals(rows: ReadonlyArray<RealEstateGroupRow>): RealEstateGroupTotals {
  return {
    properties: rows.length,
    cadastralValueTotal: sumMoney(rows.map((row) => row.cadastralValueTotal)),
    lastValuationValue: sumMoney(rows.map((row) => row.lastValuationValue)),
    annualTaxBurden: sumMoney(rows.map((row) => row.annualTaxBurden)),
    openAlertsHigh: rows.reduce((acc, row) => acc + row.openAlertsHigh, 0),
    openAlerts: rows.reduce((acc, row) => acc + row.openAlerts, 0)
  };
}

/** Alertas altas del grupo, ordenadas como el motor (gravedad, fecha, tipo, id). */
export function highAlertsOf(alerts: ReadonlyArray<RealEstateAlert>): RealEstateAlert[] {
  return sortRealEstateAlerts(alerts.filter((alert) => alert.severity === "alta"));
}

// ---------------------------------------------------------------------------
// Vista de grupo (GET /organizations/:organizationId/real-estate/overview)
// ---------------------------------------------------------------------------

function groupBy<T>(rows: ReadonlyArray<T>, keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

export async function getRealEstateGroupOverview(context: UserContext, organizationId: string, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateGroupOverview> {
  const visible = await listVisibleRealEstateProperties(context, organizationId);
  const assetIds = visible.flatMap((property) => (property.assetId ? [property.assetId] : []));
  const propertyIds = visible.map((property) => property.propertyId);

  const [assets, taxes, documents, inspections, alerts] = await Promise.all([
    assetIds.length === 0
      ? Promise.resolve([] as GroupAssetRow[])
      : prisma.realEstateAsset.findMany({
          where: { id: { in: assetIds } },
          select: { id: true, propertyId: true, cadastralValueTotal: true, lastValuationValue: true, currentTenureKind: true, units: { select: { cadastralValueLand: true, cadastralValueBuilding: true } } }
        }),
    assetIds.length === 0 ? Promise.resolve([]) : prisma.propertyTax.findMany({ where: { assetId: { in: assetIds } }, select: { assetId: true, status: true, taxpayer: true, expectedAnnualAmount: true } }),
    assetIds.length === 0 ? Promise.resolve([]) : prisma.realEstateDocument.findMany({ where: { assetId: { in: assetIds }, deletedAt: null, supersededById: null }, select: { assetId: true, category: true, validUntil: true, supersededById: true } }),
    assetIds.length === 0 ? Promise.resolve([]) : prisma.realEstateInspection.findMany({ where: { assetId: { in: assetIds }, status: { not: "cerrada" } }, select: { assetId: true, status: true, scheduledAt: true, nextDueAt: true } }),
    alertsByProperty(propertyIds, today)
  ]);

  const assetById = new Map(assets.map((asset) => [asset.id, asset] as const));
  const taxesByAsset = groupBy(taxes, (row) => row.assetId);
  const documentsByAsset = groupBy(documents, (row) => row.assetId);
  const inspectionsByAsset = groupBy(inspections, (row) => row.assetId);

  const rows = visible.map((property) => {
    const asset = property.assetId ? (assetById.get(property.assetId) ?? null) : null;
    const assetId = property.assetId ?? "";
    return buildGroupRow({
      property,
      asset,
      taxes: taxesByAsset.get(assetId) ?? [],
      documents: documentsByAsset.get(assetId) ?? [],
      inspections: inspectionsByAsset.get(assetId) ?? [],
      alerts: alerts.get(property.propertyId) ?? [],
      today
    });
  });

  return {
    rows,
    totals: computeGroupTotals(rows),
    alerts: highAlertsOf(propertyIds.flatMap((propertyId) => alerts.get(propertyId) ?? []))
  };
}
