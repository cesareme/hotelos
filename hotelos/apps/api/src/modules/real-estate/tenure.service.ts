// Activo inmobiliario · tenencia (Tanda ACT · L1, diseño §4 `RealEstateTenure`
// y §5.1 «Tenencia»): propiedad, arrendamiento (local / industria), gestión,
// franquicia, usufructo o concesión del inmueble de un centro.
//
// Ciclo: nace `borrador` (POST …/tenures, o la tenencia `propiedad` que crea el
// alta en real-estate.service.ts) → «Activar» (`PATCH {action: "activar"}`,
// real_estate.manage) → `vigente` → «Resolver» (`{action: "resolver"}`) →
// `resuelto`. Solo puede haber UNA tenencia vigente por activo (409
// `TENURE_ALREADY_ACTIVE`); la máquina TENURE de state-machines.ts decide las
// transiciones (409 `TENURE_INVALID_TRANSITION`). Al activar (o al cambiar el
// `kind` de la vigente) se refresca la caché `RealEstateAsset.currentTenureKind`;
// al resolver se vacía. El estado `vencido` NO se persiste: lo deriva el DTO
// (`deriveTenureStatus`) cuando `endDate` < hoy y el motor de alertas lo
// señala como TENURE_NOTICE alta.
//
// Los campos solo se editan en `borrador` o `vigente` con plazo abierto; una
// tenencia resuelta o vencida (derivada: `deriveTenureStatus`, ACT-REV-14) es
// historia (409 `TENURE_INVALID_TRANSITION`).
//
// Tributos (diseño §5.1, ACT-REV-08): al activar una tenencia (o al cambiar
// `kind` / `ibiPayer` de la vigente) se proponen los `PropertyTax.taxpayer` de
// los IBI activos de la ficha con `ibiTaxpayerFor`: la sociedad es el sujeto
// pasivo solo cuando es propietaria (`propiedad` + `ibiPayer propietario`); si
// repercute el IBI a su arrendatario → `arrendatario`; si el inmueble es de un
// tercero (arrendamiento, gestión, franquicia, usufructo, concesión) → 
// `propietario_tercero` (solo calendario; la repercusión llega por factura del
// arrendador, nunca por el recibo municipal). Auditado PROPERTY_TAX_UPDATED
// con `source: "tenure"`.

import { prisma } from "@hotelos/database";
import type { Prisma, RealEstateTenure } from "@prisma/client";
import type { IsoDay, PropertyTaxTaxpayer, RealEstateTenureRecord } from "@hotelos/shared";
import { NotFoundError } from "../../lib/http-error.js";
import { RealEstateTenureCreateSchema, RealEstateTenurePatchSchema } from "../../schemas/real-estate.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { realEstateError } from "./errors.js";
import { auditProjectionOf, definedFields, deriveTenureStatus, requireRealEstateAsset, toRealEstateTenureRecord, type RealEstateCommandInput } from "./real-estate.service.js";
import { assertTransition, nextStates } from "./state-machines.js";
import { toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

/** Estados (derivados con `deriveTenureStatus`) que admiten edición de campos; `vencido` y `resuelto` son historia. */
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(["borrador", "vigente"]);

const AUDIT_FIELDS = ["kind", "counterpartyTaxId", "startDate", "endDate", "noticeMonths", "renewal", "rentKind", "rentMonthly", "rentVariablePct", "rentVariableBase", "rentReviewIndex", "rentReviewMonth", "depositAmount", "vatApplies", "withholdingApplies", "withholdingRatePct", "ibiPayer", "insurancePayer", "capexResponsibility", "ffeReservePct", "brandName", "status", "documentId"] as const satisfies ReadonlyArray<keyof RealEstateTenureRecord>;

/** Proyección auditable de una tenencia: sin nombre de contraparte ni notas libres; el NIF de la contraparte enmascarado (ACT-REV-08). */
export function auditProjection(record: RealEstateTenureRecord, keys: ReadonlyArray<keyof RealEstateTenureRecord> = AUDIT_FIELDS): Record<string, unknown> {
  return auditProjectionOf(record, keys.filter((key) => key !== "counterpartyName" && key !== "notes"));
}

/** Sujeto pasivo del IBI que propone una tenencia (diseño §5.1; ACT-REV-08). Puro. */
export function ibiTaxpayerFor(tenure: { kind: string; ibiPayer: string }): PropertyTaxTaxpayer {
  if (tenure.kind === "propiedad") return tenure.ibiPayer === "arrendatario" ? "arrendatario" : "sociedad";
  return "propietario_tercero";
}

export type IbiTaxpayerChange = { taxId: string; before: string; after: string };

/** Propone `taxpayer` en los IBI activos de la ficha según la tenencia vigente; devuelve los que cambian. */
async function proposeIbiTaxpayer(db: Db, assetId: string, tenure: { kind: string; ibiPayer: string }): Promise<IbiTaxpayerChange[]> {
  const taxpayer = ibiTaxpayerFor(tenure);
  const taxes = await db.propertyTax.findMany({ where: { assetId, kind: "ibi", status: "activo", taxpayer: { not: taxpayer } }, select: { id: true, taxpayer: true } });
  if (taxes.length === 0) return [];
  await db.propertyTax.updateMany({ where: { id: { in: taxes.map((tax) => tax.id) } }, data: { taxpayer } });
  return taxes.map((tax) => ({ taxId: tax.id, before: tax.taxpayer, after: taxpayer }));
}

async function requireTenure(db: Db, assetId: string, tenureId: string): Promise<RealEstateTenure> {
  const row = await db.realEstateTenure.findFirst({ where: { id: tenureId, assetId } });
  if (!row) throw new NotFoundError("Tenencia no encontrada.");
  return row;
}

/** Tenencia vigente del activo distinta de `exceptId` (la restricción «una vigente por activo»). */
export async function findActiveTenure(db: Db, assetId: string, exceptId?: string): Promise<{ id: string; kind: string } | null> {
  return db.realEstateTenure.findFirst({ where: { assetId, status: "vigente", ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, kind: true }, orderBy: { startDate: "desc" } });
}

// ---------------------------------------------------------------------------
// GET · POST …/tenures
// ---------------------------------------------------------------------------

export async function listRealEstateTenures(propertyId: string, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateTenureRecord[]> {
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const rows = await prisma.realEstateTenure.findMany({ where: { assetId: asset.id }, orderBy: [{ startDate: "desc" }, { createdAt: "desc" }] });
  return rows.map((row) => toRealEstateTenureRecord(row, today));
}

export async function createRealEstateTenure(input: RealEstateCommandInput & { body: unknown }): Promise<RealEstateTenureRecord> {
  const data = parseOr400(RealEstateTenureCreateSchema, input.body ?? {}, "Tenencia");
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  const row = await prisma.realEstateTenure.create({ data: { ...data, assetId: asset.id, status: "borrador" } });
  const record = toRealEstateTenureRecord(row, toIsoDay(new Date()));
  recordAuditEvent({
    organizationId: asset.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "REAL_ESTATE_TENURE_CREATED",
    entityType: "real_estate_tenure",
    entityId: row.id,
    afterJson: { assetId: asset.id, ...auditProjection(record) },
    correlationId: input.correlationId
  });
  return record;
}

// ---------------------------------------------------------------------------
// PATCH …/tenures/:tenureId — campos y/o `action` (activar · resolver)
// ---------------------------------------------------------------------------

export async function updateRealEstateTenure(input: RealEstateCommandInput & { tenureId: string; body: unknown }): Promise<RealEstateTenureRecord> {
  const data = parseOr400(RealEstateTenurePatchSchema, input.body ?? {}, "Tenencia");
  const { action, ...rest } = data;
  const fields = definedFields(rest);
  const hasFields = Object.keys(fields).length > 0;
  const today = toIsoDay(new Date());

  const result = await prisma.$transaction(async (tx) => {
    const asset = await requireRealEstateAsset(tx, input.propertyId);
    const before = await requireTenure(tx, asset.id, input.tenureId);
    let current = before;

    if (hasFields) {
      // ACT-REV-14: el estado derivado manda (una vigente con endDate pasado es «vencido» aunque la fila diga vigente).
      const derived = deriveTenureStatus(current, today);
      if (!EDITABLE_STATUSES.has(derived)) {
        throw realEstateError(409, "TENURE_INVALID_TRANSITION", `La tenencia está ${derived === "resuelto" ? "resuelta" : "vencida"} y no admite cambios.`, { machine: "TENURE", from: derived, to: derived, allowed: nextStates("TENURE", derived) });
      }
      const startDate = fields.startDate ?? current.startDate;
      const endDate = fields.endDate === undefined ? current.endDate : fields.endDate;
      if (endDate && endDate.getTime() < startDate.getTime()) {
        throw realEstateError(400, "TENURE_INVALID_TRANSITION", "Tenencia no válida: endDate no puede ser anterior a startDate.", { field: "endDate" });
      }
      current = await tx.realEstateTenure.update({ where: { id: current.id }, data: fields });
    }

    let activated = false;
    let resolved = false;
    if (action === "activar") {
      assertTransition("TENURE", current.status, "vigente");
      const other = await findActiveTenure(tx, asset.id, current.id);
      if (other) throw realEstateError(409, "TENURE_ALREADY_ACTIVE", "El activo ya tiene una tenencia vigente: resuélvela antes de activar otra.", { activeTenureId: other.id, activeTenureKind: other.kind });
      current = await tx.realEstateTenure.update({ where: { id: current.id }, data: { status: "vigente" } });
      activated = true;
    } else if (action === "resolver") {
      assertTransition("TENURE", current.status, "resuelto");
      current = await tx.realEstateTenure.update({ where: { id: current.id }, data: { status: "resuelto" } });
      resolved = true;
    }

    // Caché del activo: la vigente (recién activada o editada) manda; al resolver se vacía.
    if (current.status === "vigente" && asset.currentTenureKind !== current.kind) {
      await tx.realEstateAsset.update({ where: { id: asset.id }, data: { currentTenureKind: current.kind } });
    } else if (resolved && before.status === "vigente") {
      const remaining = await findActiveTenure(tx, asset.id, current.id);
      await tx.realEstateAsset.update({ where: { id: asset.id }, data: { currentTenureKind: remaining?.kind ?? null } });
    }

    // Tributos (§5.1, ACT-REV-08): al activar, o al cambiar kind / ibiPayer de la vigente, se proponen los taxpayer del IBI.
    const taxpayerChanges = current.status === "vigente" && (activated || fields.kind !== undefined || fields.ibiPayer !== undefined) ? await proposeIbiTaxpayer(tx, asset.id, current) : [];

    return { asset, before, after: current, activated, resolved, taxpayerChanges };
  });

  const beforeRecord = toRealEstateTenureRecord(result.before, today);
  const afterRecord = toRealEstateTenureRecord(result.after, today);
  const changedKeys = [...(Object.keys(fields) as Array<keyof RealEstateTenureRecord>), ...(action ? (["status"] as const) : [])];
  const base = { organizationId: result.asset.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user" as const, entityType: "real_estate_tenure", entityId: result.after.id, correlationId: input.correlationId };
  if (hasFields) {
    recordAuditEvent({ ...base, action: "REAL_ESTATE_TENURE_UPDATED", beforeJson: auditProjection(beforeRecord, changedKeys), afterJson: auditProjection(afterRecord, changedKeys) });
  }
  if (result.activated) {
    recordAuditEvent({ ...base, action: "REAL_ESTATE_TENURE_ACTIVATED", beforeJson: { status: result.before.status, currentTenureKind: result.asset.currentTenureKind }, afterJson: { status: afterRecord.status, kind: afterRecord.kind, currentTenureKind: afterRecord.kind } });
  }
  if (result.resolved) {
    recordAuditEvent({ ...base, action: "REAL_ESTATE_TENURE_RESOLVED", beforeJson: { status: result.before.status, currentTenureKind: result.asset.currentTenureKind }, afterJson: { status: afterRecord.status, kind: afterRecord.kind } });
  }
  for (const change of result.taxpayerChanges) {
    recordAuditEvent({ ...base, entityType: "property_tax", entityId: change.taxId, action: "PROPERTY_TAX_UPDATED", beforeJson: { taxpayer: change.before }, afterJson: { taxpayer: change.after, source: "tenure", tenureId: result.after.id, kind: afterRecord.kind, ibiPayer: afterRecord.ibiPayer } });
  }
  return afterRecord;
}
