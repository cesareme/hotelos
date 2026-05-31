import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

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

  if (input.startDate >= input.endDate) {
    throw new Error("startDate must be before endDate.");
  }

  const created = await prisma.fiscalPeriod.create({
    data: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      periodCode: input.periodCode,
      periodType: input.periodType,
      startDate: dateOnly(input.startDate),
      endDate: dateOnly(input.endDate),
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
  requirePermissions(input.context, ["accounting.journal.post"]);

  const period = await prisma.fiscalPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new Error("Fiscal period was not found.");
  if (period.status === "closed") throw new Error(`Fiscal period ${period.periodCode} is already closed.`);

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
  if (!period) throw new Error("Fiscal period was not found.");
  if (period.status !== "closed") throw new Error(`Period ${period.periodCode} is not closed.`);
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

// Returns true if posting into the given date for the given property is allowed
// (no overlapping closed period). Used by the projection engine before persisting.
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
