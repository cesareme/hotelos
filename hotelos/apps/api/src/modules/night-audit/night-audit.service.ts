import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { processNoShows } from "../cancellation-policy/cancellation-policy.service.js";

export type NightAuditStatus = "not_started" | "in_progress" | "completed" | "failed";

export type NightAuditStepResult = {
  step: string;
  status: "ok" | "warning" | "skipped" | "failed";
  detail?: string;
  metrics?: Record<string, number>;
};

export type NightAuditRunRecord = {
  id: string;
  propertyId: string;
  businessDate: string;
  status: NightAuditStatus;
  startedAt?: string;
  completedAt?: string;
  startedBy?: string;
  stepResults: NightAuditStepResult[];
  errorMessage?: string;
  createdAt: string;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function nextDay(iso: string): string {
  const next = new Date(`${iso}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return isoDate(next);
}

function mapRun(row: NonNullable<Awaited<ReturnType<typeof prisma.nightAuditRun.findUnique>>>): NightAuditRunRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    businessDate: isoDate(row.businessDate),
    status: row.status as NightAuditStatus,
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    startedBy: row.startedBy ?? undefined,
    stepResults: (row.stepResultsJson as { steps?: NightAuditStepResult[] })?.steps ?? [],
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

export async function getCurrentBusinessDate(propertyId: string): Promise<string> {
  const row = await prisma.businessDate.findUnique({ where: { propertyId } });
  if (!row) {
    throw new Error(`No business date initialized for property ${propertyId}.`);
  }
  return isoDate(row.currentDate);
}

export async function listNightAuditRuns(propertyId: string): Promise<NightAuditRunRecord[]> {
  const rows = await prisma.nightAuditRun.findMany({
    where: { propertyId },
    orderBy: { businessDate: "desc" },
    take: 30
  });
  return rows.map(mapRun);
}

export async function runNightAudit(input: {
  context: UserContext;
  propertyId: string;
  correlationId: string;
}): Promise<NightAuditRunRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);

  const businessDate = await getCurrentBusinessDate(input.propertyId);
  const businessDateOnly = dateOnly(businessDate);

  const existing = await prisma.nightAuditRun.findUnique({
    where: { propertyId_businessDate: { propertyId: input.propertyId, businessDate: businessDateOnly } }
  });
  if (existing && existing.status === "completed") {
    throw new Error(`Night audit for ${businessDate} is already completed.`);
  }
  if (existing && existing.status === "in_progress") {
    throw new Error(`Night audit for ${businessDate} is already in progress (run ${existing.id}).`);
  }

  const run = await prisma.nightAuditRun.upsert({
    where: { propertyId_businessDate: { propertyId: input.propertyId, businessDate: businessDateOnly } },
    update: {
      status: "in_progress",
      startedAt: new Date(),
      startedBy: input.context.userId,
      errorMessage: null,
      correlationId: input.correlationId,
      stepResultsJson: {}
    },
    create: {
      propertyId: input.propertyId,
      businessDate: businessDateOnly,
      status: "in_progress",
      startedAt: new Date(),
      startedBy: input.context.userId,
      correlationId: input.correlationId
    }
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "NIGHT_AUDIT_STARTED",
    entityType: "night_audit_run",
    entityId: run.id,
    afterJson: { businessDate, runId: run.id },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  const steps: NightAuditStepResult[] = [];

  try {
    steps.push(await stepValidateOpenFolios(input.propertyId, businessDateOnly));
    steps.push(await stepSnapshotRoomStatus(input.propertyId));
    steps.push(await stepPostRoomChargesForInHouse(input));
    steps.push(await stepProcessNoShows(input, businessDateOnly));
    steps.push(await stepRevenueSnapshot(input.propertyId, businessDate));
    steps.push(await stepReconcilePayments(input.propertyId, businessDateOnly));
    steps.push(await stepAdvanceBusinessDate(input.propertyId, businessDate, input.context.userId));

    const completed = await prisma.nightAuditRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        stepResultsJson: { steps }
      }
    });

    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "NIGHT_AUDIT_COMPLETED",
      entityType: "night_audit_run",
      entityId: completed.id,
      afterJson: { businessDate, nextBusinessDate: nextDay(businessDate), steps },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });

    recordDomainEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      entityType: "night_audit_run",
      entityId: completed.id,
      eventType: "NightAuditCompleted",
      payload: { businessDate, nextBusinessDate: nextDay(businessDate), stepCount: steps.length },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });

    return mapRun(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await prisma.nightAuditRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
        stepResultsJson: { steps }
      }
    });

    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "NIGHT_AUDIT_FAILED",
      entityType: "night_audit_run",
      entityId: failed.id,
      afterJson: { businessDate, errorMessage: message, steps },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });

    return mapRun(failed);
  }
}

async function stepValidateOpenFolios(propertyId: string, businessDateOnly: Date): Promise<NightAuditStepResult> {
  // Folio has no Prisma @relation to Reservation, so we resolve in-house
  // reservations first and then filter open folios by id.
  const inHouse = await prisma.reservation.findMany({
    where: { propertyId, status: "checked_in" },
    select: { id: true }
  });
  const reservationIds = inHouse.map((r) => r.id);
  const openWithBalance = reservationIds.length === 0
    ? []
    : await prisma.folio.findMany({
        where: { status: "open", reservationId: { in: reservationIds } },
        select: { id: true, reservationId: true }
      });

  return {
    step: "validate_open_folios",
    status: "ok",
    detail: `Inspected ${openWithBalance.length} in-house folios for business date ${isoDate(businessDateOnly)}.`,
    metrics: { inHouseFolios: openWithBalance.length }
  };
}

async function stepSnapshotRoomStatus(propertyId: string): Promise<NightAuditStepResult> {
  const counts = await prisma.room.groupBy({
    by: ["status"],
    where: { propertyId },
    _count: { _all: true }
  });
  const metrics: Record<string, number> = {};
  for (const c of counts) {
    metrics[c.status] = c._count._all;
  }
  return {
    step: "snapshot_room_status",
    status: "ok",
    detail: `Snapshot of ${counts.reduce((sum, c) => sum + c._count._all, 0)} rooms by status.`,
    metrics
  };
}

async function stepPostRoomChargesForInHouse(input: {
  context: UserContext;
  propertyId: string;
  correlationId: string;
}): Promise<NightAuditStepResult> {
  const inHouse = await prisma.reservation.findMany({
    where: { propertyId: input.propertyId, status: "checked_in" },
    select: { id: true, code: true, totalAmount: true, currency: true, arrivalDate: true, departureDate: true }
  });

  if (inHouse.length === 0) {
    return { step: "post_room_charges", status: "skipped", detail: "No in-house reservations." };
  }

  let posted = 0;
  for (const reservation of inHouse) {
    const folio = await prisma.folio.findFirst({ where: { reservationId: reservation.id, status: "open" } });
    if (!folio) continue;
    const nights = Math.max(
      1,
      Math.round((reservation.departureDate.getTime() - reservation.arrivalDate.getTime()) / 86_400_000)
    );
    const dailyRate = Number(reservation.totalAmount) / nights;
    if (dailyRate <= 0) continue;
    await prisma.folioLine.create({
      data: {
        folioId: folio.id,
        type: "room",
        description: `Auto room charge (night audit) for ${reservation.code}`,
        quantity: 1,
        unitPrice: dailyRate,
        total: dailyRate,
        postedBy: input.context.userId
      }
    });
    posted += 1;
  }

  return {
    step: "post_room_charges",
    status: "ok",
    detail: `Auto-posted ${posted} nightly room charges for in-house reservations.`,
    metrics: { postedCharges: posted, inHouseReservations: inHouse.length }
  };
}

// Process no-shows: any confirmed/draft reservation whose arrival is in the
// past and that never checked in becomes status="no_show" and its
// CancellationPolicy auto-posts the no-show fee to the folio.
async function stepProcessNoShows(input: { context: UserContext; propertyId: string; correlationId: string }, businessDateOnly: Date): Promise<NightAuditStepResult> {
  const result = await processNoShows({
    context: input.context,
    propertyId: input.propertyId,
    businessDate: businessDateOnly,
    correlationId: input.correlationId
  });
  return {
    step: "process_no_shows",
    status: "ok",
    detail: result.processedCount > 0
      ? `Marked ${result.processedCount} reservation(s) as no_show and posted ${result.totalChargedEur.toFixed(2)} € in penalty fees.`
      : "No pending no-shows to process.",
    metrics: { processedCount: result.processedCount, totalChargedEur: result.totalChargedEur }
  };
}

async function stepRevenueSnapshot(propertyId: string, businessDate: string): Promise<NightAuditStepResult> {
  const businessDateOnly = dateOnly(businessDate);
  // Resolve property's folios first (no @relation declared on Folio).
  const reservations = await prisma.reservation.findMany({ where: { propertyId }, select: { id: true } });
  const reservationIds = reservations.map((r) => r.id);
  const folios = reservationIds.length === 0 ? [] : await prisma.folio.findMany({
    where: { reservationId: { in: reservationIds } },
    select: { id: true }
  });
  const folioIds = folios.map((f) => f.id);
  const lines = folioIds.length === 0 ? [] : await prisma.folioLine.findMany({
    where: {
      folioId: { in: folioIds },
      postedAt: { gte: businessDateOnly, lt: dateOnly(nextDay(businessDate)) }
    },
    select: { total: true, type: true }
  });

  const totalsByType: Record<string, number> = {};
  for (const line of lines) {
    const key = line.type;
    totalsByType[key] = (totalsByType[key] ?? 0) + Number(line.total);
  }
  const totalRevenue = Object.values(totalsByType).reduce((sum, v) => sum + v, 0);

  return {
    step: "revenue_snapshot",
    status: "ok",
    detail: `Captured €${totalRevenue.toFixed(2)} revenue across ${lines.length} lines on ${businessDate}.`,
    metrics: { totalRevenue: Math.round(totalRevenue * 100) / 100, lineCount: lines.length, ...Object.fromEntries(Object.entries(totalsByType).map(([k, v]) => [`revenue_${k}`, Math.round(v * 100) / 100])) }
  };
}

async function stepReconcilePayments(propertyId: string, businessDateOnly: Date): Promise<NightAuditStepResult> {
  const nextDayDate = dateOnly(nextDay(isoDate(businessDateOnly)));
  const captured = await prisma.payment.findMany({
    where: {
      propertyId,
      status: "captured",
      createdAt: { gte: businessDateOnly, lt: nextDayDate }
    },
    select: { amount: true, method: true }
  });
  const totalsByMethod: Record<string, number> = {};
  for (const p of captured) {
    totalsByMethod[p.method] = (totalsByMethod[p.method] ?? 0) + Number(p.amount);
  }
  const total = Object.values(totalsByMethod).reduce((sum, v) => sum + v, 0);
  return {
    step: "reconcile_payments",
    status: "ok",
    detail: `Reconciled €${total.toFixed(2)} captured across ${captured.length} payments.`,
    metrics: { totalCaptured: Math.round(total * 100) / 100, paymentCount: captured.length, ...Object.fromEntries(Object.entries(totalsByMethod).map(([k, v]) => [`captured_${k}`, Math.round(v * 100) / 100])) }
  };
}

async function stepAdvanceBusinessDate(propertyId: string, businessDate: string, userId: string): Promise<NightAuditStepResult> {
  const next = nextDay(businessDate);
  await prisma.businessDate.update({
    where: { propertyId },
    data: {
      currentDate: dateOnly(next),
      closedAt: new Date(),
      closedBy: userId
    }
  });
  return {
    step: "advance_business_date",
    status: "ok",
    detail: `Business date advanced from ${businessDate} to ${next}.`,
    metrics: {}
  };
}
