import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { isoDay, postJournalEntry, reverseJournalEntry, type PostedJournalEntry } from "../accounting.service.js";
import { buildPayrollSlipEntry } from "../posting-rules.js";

// Payroll posting rule (canonical rule «Nómina» of the runbook §2).
//
// `PayrollSlipsCalculated` (modules/payroll/periods.service.ts, entityId =
// period id, payload.slipIds) → one asiento per nómina through the engine:
//
//   D 640 Sueldos y salarios              grossSalary
//   D 642 Seguridad Social empresa        ssEmployer
//                                            H 4751 H.P. acreedora retenciones   irpfRetention
//                                            H 476  Seg. Social acreedora        ssEmployee + ssEmployer
//                                            H 465  Remuneraciones pendientes    netSalary
//
// Fecha contable = last day of the period. Idempotent by
// (sourceType "payroll_slip", sourceId slipId). RECALCULATION: the period
// service wipes the slips and emits the event again with NEW slip ids; the
// asientos of the slips that disappeared are REVERSED (marked, never deleted)
// before the new ones are posted, so the expense is never duplicated.
// PayrollPeriod.journalEntryIds / reversalJournalEntryIds / postedAt /
// reversedAt track the state for the payroll lot and the UI.

export type PayrollPostingResult = { periodId: string; posted: string[]; existing: string[]; reversed: string[]; skipped: string[] };

/**
 * Post (or re-post after a recalculation) the nóminas of a period. Exported
 * for the payroll lot, which may call it directly after calculatePeriod
 * instead of waiting for the event.
 */
export async function postPayrollPeriod(input: { periodId: string; slipIds?: string[]; actorUserId?: string | null; correlationId?: string }): Promise<PayrollPostingResult> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw new Error(`Payroll period ${input.periodId} was not found.`);
  const slips = await prisma.payrollSlip.findMany({ where: { periodId: period.id, ...(input.slipIds ? { id: { in: input.slipIds } } : {}) }, orderBy: { id: "asc" } });
  const currentSlipIds = new Set(slips.map((slip) => slip.id));
  const entryDate = isoDay(period.endDate);
  const result: PayrollPostingResult = { periodId: period.id, posted: [], existing: [], reversed: [], skipped: [] };

  // 1. Reverse the asientos of slips that no longer exist (recalculation).
  const tracked = await prisma.journalEntry.findMany({
    where: {
      organizationId: period.organizationId,
      sourceType: "payroll_slip",
      status: "posted",
      reversedById: null,
      OR: [{ id: { in: period.journalEntryIds } }, { reference: period.periodCode, ...(period.propertyId ? { propertyId: period.propertyId } : {}) }]
    },
    select: { id: true, sourceId: true }
  });
  const reversalIds: string[] = [];
  // Tanda L2 (L2-06): the slips that still stand (another calculation of the
  // same period) in ONE query instead of one findUnique per tracked entry.
  const candidateSlipIds = tracked
    .map((entry) => entry.sourceId)
    .filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.length > 0 && !currentSlipIds.has(sourceId));
  const standingSlipIds = new Set(
    candidateSlipIds.length > 0
      ? (await prisma.payrollSlip.findMany({ where: { id: { in: candidateSlipIds } }, select: { id: true } })).map((slip) => slip.id)
      : []
  );
  for (const entry of tracked) {
    if (!entry.sourceId || currentSlipIds.has(entry.sourceId)) continue;
    if (standingSlipIds.has(entry.sourceId)) continue; // a slip of another calculation that still stands
    const reversal = await reverseJournalEntry({
      organizationId: period.organizationId,
      journalEntryId: entry.id,
      reason: `recálculo de la nómina ${period.periodCode}`,
      entryDate,
      createdBy: input.actorUserId ?? null,
      correlationId: input.correlationId
    });
    reversalIds.push(reversal.id);
    result.reversed.push(entry.id);
  }

  // 2. Post the current slips (idempotent).
  // Tanda L2 (L2-06): the asientos already posted for these slips in ONE
  // query (same key as findJournalEntryBySource: organisation + source type +
  // source id) instead of one findFirst per slip.
  const alreadyPosted = slips.length > 0
    ? await prisma.journalEntry.findMany({
        where: { organizationId: period.organizationId, sourceType: "payroll_slip", sourceId: { in: slips.map((slip) => slip.id) } },
        select: { id: true, sourceId: true },
        orderBy: { id: "asc" }
      })
    : [];
  const postedBySlip = new Map<string, { id: string }>();
  for (const entry of alreadyPosted) {
    if (entry.sourceId && !postedBySlip.has(entry.sourceId)) postedBySlip.set(entry.sourceId, { id: entry.id });
  }
  const postedIds: string[] = [];
  for (const slip of slips) {
    const existing = postedBySlip.get(slip.id) ?? null;
    if (existing) {
      postedIds.push(existing.id);
      result.existing.push(existing.id);
      continue;
    }
    let posted: PostedJournalEntry;
    try {
      const entry = buildPayrollSlipEntry({
        organizationId: period.organizationId,
        propertyId: period.propertyId,
        slipId: slip.id,
        periodCode: period.periodCode,
        entryDate,
        grossSalary: slip.grossSalary,
        ssEmployer: slip.ssEmployer,
        irpfRetention: slip.irpfRetention,
        ssEmployee: slip.ssEmployee,
        netSalary: slip.netSalary
      });
      posted = await postJournalEntry({
        organizationId: period.organizationId,
        propertyId: period.propertyId,
        entryDate: entry.entryDate,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        description: entry.description,
        reference: entry.reference,
        lines: entry.lines,
        createdBy: input.actorUserId ?? null,
        correlationId: input.correlationId
      });
    } catch (error) {
      // A zero slip (contract prorated to 0 days) has no amounts: nothing to post, not a failure.
      const code = (error as { details?: { code?: string } }).details?.code;
      if (code === "PAYROLL_SLIP_EMPTY") {
        result.skipped.push(slip.id);
        continue;
      }
      throw error;
    }
    postedIds.push(posted.id);
    result.posted.push(posted.id);
  }

  await prisma.payrollPeriod.update({
    where: { id: period.id },
    data: {
      journalEntryIds: postedIds,
      reversalJournalEntryIds: [...period.reversalJournalEntryIds, ...reversalIds],
      ...(postedIds.length > 0 ? { postedAt: period.postedAt ?? new Date() } : {}),
      ...(reversalIds.length > 0 ? { reversedAt: new Date() } : {})
    }
  });
  return result;
}

/**
 * Side-effect entry point invoked by the projection dispatcher. Returns
 * silently for irrelevant events.
 */
export async function recordPayrollFromEvent(event: EventEnvelope): Promise<void> {
  if (event.eventType !== "PayrollSlipsCalculated") return;
  if (!event.organizationId || !event.entityId) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const slipIds = Array.isArray(payload.slipIds) ? payload.slipIds.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  await postPayrollPeriod({ periodId: event.entityId, slipIds, actorUserId: event.actorUserId ?? null, correlationId: event.correlationId });
}
