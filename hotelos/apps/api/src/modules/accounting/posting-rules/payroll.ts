import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { isPostingAllowed } from "../fiscal-period.service.js";

// Payroll posting rule (Sprint 24 — Track Payroll).
//
// Listens to the `PayrollSlipsCalculated` domain event emitted by
// `modules/payroll/periods.service.ts`. For each slip in the period we post
// one journal entry per the Spanish PGC convention for monthly nóminas:
//
//   DR 640   Sueldos y salarios                — grossSalary
//   DR 642   Seguridad social a cargo empresa  — ssEmployer
//                                                 CR 4751 H.P. retenciones IRPF — irpfRetention
//                                                 CR 476  Organismos Seg. Social acreedores — ssEmployee + ssEmployer
//                                                 CR 465  Remuneraciones pendientes de pago — netSalary
//
// Identity (always holds, given how the slip is computed):
//   grossSalary + ssEmployer
//     == irpfRetention + (ssEmployee + ssEmployer) + netSalary
// because  netSalary = grossSalary − irpfRetention − ssEmployee.
//
// Idempotency: keyed by `(sourceType="payroll_slip", sourceId=<slipId>)`. A
// second delivery of the event (e.g. event-log replay, or recalculating the
// period — which wipes slips but keeps event history) finds the existing
// journal and short-circuits.
//
// Fiscal-period guard mirrors `commission.ts`: we ask `isPostingAllowed`
// against the event's createdAt; a closed period raises a clear error so the
// projection dispatcher surfaces it in its log.

const accountIdCache = new Map<string, string>();
async function resolveAccountId(organizationId: string, code: string): Promise<string | null> {
  const key = `${organizationId}::${code}`;
  const cached = accountIdCache.get(key);
  if (cached) return cached;
  const row = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId, code } },
    select: { id: true }
  });
  if (!row) return null;
  accountIdCache.set(key, row.id);
  return row.id;
}

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function postJournalForSlip(
  event: EventEnvelope,
  slipId: string
): Promise<void> {
  // Idempotency at the journal layer.
  const existing = await prisma.journalEntry.findFirst({
    where: {
      organizationId: event.organizationId,
      sourceType: "payroll_slip",
      sourceId: slipId
    },
    select: { id: true }
  });
  if (existing) return;

  const slip = await prisma.payrollSlip.findUnique({ where: { id: slipId } });
  if (!slip) return; // event refers to a slip that was wiped during a recalculation

  const grossSalary = round2(decimalToNumber(slip.grossSalary));
  const irpfRetention = round2(decimalToNumber(slip.irpfRetention));
  const ssEmployee = round2(decimalToNumber(slip.ssEmployee));
  const ssEmployer = round2(decimalToNumber(slip.ssEmployer));
  const netSalary = round2(decimalToNumber(slip.netSalary));

  // Defensive: zero-amount slip (no contract gross / fully prorated to 0
  // days) produces no journal — there's nothing meaningful to post.
  if (
    grossSalary <= 0 &&
    ssEmployer <= 0 &&
    irpfRetention <= 0 &&
    ssEmployee <= 0 &&
    netSalary <= 0
  ) {
    return;
  }

  const postingDate = new Date(event.createdAt);
  const check = await isPostingAllowed(
    event.organizationId,
    event.propertyId || undefined,
    postingDate
  );
  if (!check.allowed) {
    throw new Error(
      `Payroll posting blocked: fiscal period ${check.closedPeriodCode} is closed.`
    );
  }

  // PGC account codes — looked up against the organization's chart.
  const DR_SALARIES = "640";       // Sueldos y salarios
  const DR_SS_EMPLOYER = "642";    // Seguridad social a cargo empresa
  const CR_IRPF = "4751";          // H.P. acreedora retenciones IRPF
  const CR_SS_PAYABLE = "476";     // Organismos Seg. Social acreedores
  const CR_NET_PAYABLE = "465";    // Remuneraciones pendientes de pago

  const [
    drSalariesId,
    drSsEmployerId,
    crIrpfId,
    crSsPayableId,
    crNetPayableId
  ] = await Promise.all([
    resolveAccountId(event.organizationId, DR_SALARIES),
    resolveAccountId(event.organizationId, DR_SS_EMPLOYER),
    resolveAccountId(event.organizationId, CR_IRPF),
    resolveAccountId(event.organizationId, CR_SS_PAYABLE),
    resolveAccountId(event.organizationId, CR_NET_PAYABLE)
  ]);

  const missing = [
    !drSalariesId ? DR_SALARIES : null,
    !drSsEmployerId ? DR_SS_EMPLOYER : null,
    !crIrpfId ? CR_IRPF : null,
    !crSsPayableId ? CR_SS_PAYABLE : null,
    !crNetPayableId ? CR_NET_PAYABLE : null
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Missing accounts in chart for organization ${event.organizationId}: ${missing.join(", ")}`
    );
  }

  const ssTotal = round2(ssEmployee + ssEmployer);
  const description = `Nómina slip ${slip.id}`;

  // Build the lines. Only emit lines with a strictly positive amount — a
  // contract with zero IRPF should not contaminate the journal with an empty
  // 4751 row, but the balance still holds.
  const debitLines: Array<{
    accountId: string;
    debit: string;
    credit: string;
    description: string;
  }> = [];
  const creditLines: Array<{
    accountId: string;
    debit: string;
    credit: string;
    description: string;
  }> = [];

  if (grossSalary > 0) {
    debitLines.push({
      accountId: drSalariesId!,
      debit: grossSalary.toFixed(2),
      credit: "0.00",
      description: `${description} — Sueldos y salarios`
    });
  }
  if (ssEmployer > 0) {
    debitLines.push({
      accountId: drSsEmployerId!,
      debit: ssEmployer.toFixed(2),
      credit: "0.00",
      description: `${description} — SS empresa`
    });
  }
  if (irpfRetention > 0) {
    creditLines.push({
      accountId: crIrpfId!,
      debit: "0.00",
      credit: irpfRetention.toFixed(2),
      description: `${description} — Retención IRPF`
    });
  }
  if (ssTotal > 0) {
    creditLines.push({
      accountId: crSsPayableId!,
      debit: "0.00",
      credit: ssTotal.toFixed(2),
      description: `${description} — SS organismos`
    });
  }
  if (netSalary > 0) {
    creditLines.push({
      accountId: crNetPayableId!,
      debit: "0.00",
      credit: netSalary.toFixed(2),
      description: `${description} — Líquido a pagar`
    });
  }

  if (debitLines.length === 0 || creditLines.length === 0) return;

  await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: event.organizationId,
        propertyId: event.propertyId || null,
        sourceType: "payroll_slip",
        sourceId: slip.id,
        status: "posted",
        postedAt: new Date(),
        createdBy: event.actorUserId ?? null
      }
    });
    await tx.journalLine.createMany({
      data: [...debitLines, ...creditLines].map((line) => ({
        journalEntryId: entry.id,
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
        currency: "EUR",
        description: line.description
      }))
    });
  });
}

/**
 * Side-effect entry point invoked by the projection dispatcher. Returns
 * silently for irrelevant events.
 */
export async function recordPayrollFromEvent(event: EventEnvelope): Promise<void> {
  if (event.eventType !== "PayrollSlipsCalculated") return;
  if (!event.organizationId) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const rawSlipIds = payload.slipIds;
  if (!Array.isArray(rawSlipIds) || rawSlipIds.length === 0) return;

  const slipIds = rawSlipIds.filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const slipId of slipIds) {
    try {
      await postJournalForSlip(event, slipId);
    } catch (error) {
      // Log and continue with remaining slips so a single bad row doesn't
      // block the whole batch. The dispatcher's outer try/catch will also
      // surface the final failure if this is the last handler in the queue.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[accounting/posting-rules/payroll] slip ${slipId} failed for event ${event.eventId}: ${message}`
      );
    }
  }
}
