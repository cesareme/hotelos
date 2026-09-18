import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { isIsoDate } from "../../lib/query-dates.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { isStructureEnabled } from "../../lib/finance-scope.js";

// Fiscal periods (month / quarter / year) — the lock of the diario: the
// engine (accounting.service.postJournalEntry) refuses any asiento whose
// fecha contable falls inside a CLOSED period (409 FISCAL_PERIOD_CLOSED).
// Closing a period requires that no draft asiento remains inside it (a draft
// posted later would land in a closed period); reopening is audited and
// requires the high-risk confirmation.

export type FiscalPeriodRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  periodType: "month" | "quarter" | "year";
  startDate: string;
  endDate: string;
  status: "open" | "closing" | "closed";
  closedAt?: string;
  closedBy?: string;
  closingNotes?: string;
  createdAt: string;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function requireDay(value: unknown, name: string): string {
  if (!isIsoDate(value)) throw new BadRequestError(`El parámetro ${name} debe ser una fecha YYYY-MM-DD.`);
  return value;
}

/**
 * Tanda 6b · L4 (design §5.2 R4): ejercicios and periodos fiscales belong to
 * the sociedad — one Diario per NIF (CCom 25), regularización / cierre against
 * 129 only at entity level. A `propertyId` on their creation (or on the
 * fiscal-year listing) is a 400 FISCAL_YEAR_IS_ENTITY_SCOPED; the UI never
 * sent it (YearEndCloseScreen.tsx:146) and the local database holds 0
 * property-scoped rows. Legacy rows, if any, stay readable. Gated by
 * STRUCTURE_ENABLED like the work-centre rule. Lives here (the leaf of the
 * accounting import graph) so fiscal-year.service.ts can reuse it without a
 * cycle through accounting.service.ts.
 */
export function assertEntityScopedFiscalInput(propertyId: string | null | undefined, subject: "ejercicio" | "periodo"): void {
  if (!propertyId) return;
  if (!isStructureEnabled()) return;
  const error = new BadRequestError(
    subject === "ejercicio"
      ? "Los ejercicios fiscales son de la sociedad: no admiten propertyId. Usa el ámbito «Sociedad»."
      : "Los periodos fiscales son de la sociedad: no admiten propertyId. Usa el ámbito «Sociedad»."
  );
  error.details = { code: "FISCAL_YEAR_IS_ENTITY_SCOPED", subject, propertyId };
  throw error;
}

function mapPeriod(row: NonNullable<Awaited<ReturnType<typeof prisma.fiscalPeriod.findUnique>>>): FiscalPeriodRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    periodCode: row.periodCode,
    periodType: row.periodType as FiscalPeriodRecord["periodType"],
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    status: row.status as FiscalPeriodRecord["status"],
    closedAt: row.closedAt?.toISOString(),
    closedBy: row.closedBy ?? undefined,
    closingNotes: row.closingNotes ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

export async function openFiscalPeriod(input: {
  context: UserContext;
  propertyId?: string;
  periodCode: string;
  periodType: FiscalPeriodRecord["periodType"];
  startDate: string;
  endDate: string;
  correlationId: string;
}): Promise<FiscalPeriodRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  assertEntityScopedFiscalInput(input.propertyId, "periodo");
  const startDate = requireDay(input.startDate, "startDate");
  const endDate = requireDay(input.endDate, "endDate");
  if (startDate >= endDate) throw new BadRequestError("startDate debe ser anterior a endDate.");
  if (!["month", "quarter", "year"].includes(input.periodType)) throw new BadRequestError("periodType debe ser month, quarter o year.");
  if (!input.periodCode || input.periodCode.length > 32) throw new BadRequestError("periodCode es obligatorio (máximo 32 caracteres).");

  const overlapping = await prisma.fiscalPeriod.findFirst({
    where: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      periodType: input.periodType,
      startDate: { lte: dateOnly(endDate) },
      endDate: { gte: dateOnly(startDate) }
    },
    select: { periodCode: true }
  });
  if (overlapping) {
    throw new ConflictError(`El periodo se solapa con ${overlapping.periodCode}.`, { periodCode: overlapping.periodCode, code: "FISCAL_PERIOD_OVERLAP" });
  }

  const created = await prisma.fiscalPeriod.create({
    data: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      periodCode: input.periodCode,
      periodType: input.periodType,
      startDate: dateOnly(startDate),
      endDate: dateOnly(endDate),
      status: "open"
    }
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_PERIOD_OPENED",
    entityType: "fiscal_period",
    entityId: created.id,
    afterJson: { periodCode: input.periodCode, periodType: input.periodType },
    correlationId: input.correlationId
  });

  return mapPeriod(created);
}

export async function closeFiscalPeriod(input: {
  context: UserContext;
  periodId: string;
  closingNotes?: string;
  correlationId: string;
}): Promise<FiscalPeriodRecord> {
  // Tanda 8a (RBAC · L2, design §4.6): closing a period is its own key
  // (accounting.period.close, dirección financiera), separated from the
  // manual asiento (accounting.journal.post); reopening is unchanged.
  requirePermissions(input.context, ["accounting.period.close"]);

  const period = await prisma.fiscalPeriod.findUnique({ where: { id: input.periodId } });
  if (!period || period.organizationId !== input.context.organizationId) throw new NotFoundError("Periodo fiscal no encontrado.");
  if (period.status === "closed") {
    throw new ConflictError(`El periodo ${period.periodCode} ya está cerrado.`, { code: "FISCAL_PERIOD_ALREADY_CLOSED", periodCode: period.periodCode });
  }

  // A draft inside the period would be posted into a closed period later.
  const drafts = await prisma.journalEntry.count({
    where: {
      organizationId: period.organizationId,
      ...(period.propertyId ? { propertyId: period.propertyId } : {}),
      status: "draft",
      entryDate: { gte: period.startDate, lte: period.endDate }
    }
  });
  if (drafts > 0) {
    throw new ConflictError(`El periodo ${period.periodCode} tiene ${drafts} asiento(s) en borrador: contabilízalos o elimínalos antes de cerrar.`, {
      code: "FISCAL_PERIOD_HAS_DRAFTS",
      periodCode: period.periodCode,
      drafts
    });
  }

  const before = mapPeriod(period);
  const updated = await prisma.fiscalPeriod.update({
    where: { id: period.id },
    data: { status: "closed", closedAt: new Date(), closedBy: input.context.userId, closingNotes: input.closingNotes ?? null }
  });
  const after = mapPeriod(updated);

  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_PERIOD_CLOSED",
    entityType: "fiscal_period",
    entityId: period.id,
    beforeJson: before,
    afterJson: after,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? "",
    entityType: "fiscal_period",
    entityId: period.id,
    eventType: "FiscalPeriodClosed",
    payload: { periodCode: period.periodCode, periodType: period.periodType, closedBy: input.context.userId },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export async function reopenFiscalPeriod(input: {
  context: UserContext;
  periodId: string;
  reason: string;
  correlationId: string;
}): Promise<FiscalPeriodRecord> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);
  const period = await prisma.fiscalPeriod.findUnique({ where: { id: input.periodId } });
  if (!period || period.organizationId !== input.context.organizationId) throw new NotFoundError("Periodo fiscal no encontrado.");
  if (period.status !== "closed") {
    throw new ConflictError(`El periodo ${period.periodCode} no está cerrado.`, { code: "FISCAL_PERIOD_NOT_CLOSED", periodCode: period.periodCode });
  }
  if (!input.reason || input.reason.trim().length === 0) throw new BadRequestError("Indica el motivo de la reapertura.");
  const before = mapPeriod(period);
  const updated = await prisma.fiscalPeriod.update({
    where: { id: period.id },
    data: { status: "open", closedAt: null, closedBy: null }
  });
  const after = mapPeriod(updated);
  recordAuditEvent({
    organizationId: period.organizationId,
    propertyId: period.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_PERIOD_REOPENED",
    entityType: "fiscal_period",
    entityId: period.id,
    beforeJson: before,
    afterJson: { ...after, reason: input.reason },
    correlationId: input.correlationId
  });
  return after;
}

export async function listFiscalPeriods(input: {
  context: UserContext;
  propertyId?: string;
}): Promise<FiscalPeriodRecord[]> {
  const rows = await prisma.fiscalPeriod.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {})
    },
    orderBy: { startDate: "desc" }
  });
  return rows.map(mapPeriod);
}

/**
 * True when no CLOSED period (organisation-wide or of the property) covers
 * the posting date. Used by the engine before every asiento.
 */
export async function isPostingAllowed(organizationId: string, propertyId: string | undefined, postingDate: Date): Promise<{ allowed: boolean; closedPeriodCode?: string }> {
  const period = await prisma.fiscalPeriod.findFirst({
    where: {
      organizationId,
      OR: [
        { propertyId: propertyId ?? null },
        { propertyId: null }
      ],
      startDate: { lte: postingDate },
      endDate: { gte: postingDate },
      status: "closed"
    },
    select: { periodCode: true }
  });
  if (period) return { allowed: false, closedPeriodCode: period.periodCode };
  return { allowed: true };
}
