import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

// ---------------------------------------------------------------------------
// Spanish PGC year-end close
// ---------------------------------------------------------------------------
//
// A Spanish ejercicio close requires THREE asientos at 31/12:
//
//   1) Asiento de regularización (entryKind = "regularization"):
//      Closes the P&L accounts (6xx expenses + 7xx revenues) against
//      cuenta 129 "Resultado del ejercicio".
//        - DR 7xx (their credit balances)  → CR 129  (revenue side)
//        - CR 6xx (their debit balances)   → DR 129  (expense side)
//      The net plug on 129 is the year's result.
//
//   2) Asiento de cierre (entryKind = "closing"):
//      Brings every account with a non-zero balance to zero at 31/12 by
//      posting its inverse DR/CR. After regularization this includes assets,
//      liabilities, equity (incl. 129 with its final result).
//
//   3) Asiento de apertura (entryKind = "opening"), posted at 1/1 of the
//      NEXT year and stamped with the next year's fiscalYearId:
//      Replicates the closing balances in their original DR/CR direction so
//      the new year starts with the right opening balance per account.
//
// Cuenta 129 ends opening as 0; rolling its net into reservas (113 / 1130)
// is a SEPARATE manual asiento, intentionally out of scope for this sprint.
// ---------------------------------------------------------------------------

export type FiscalYearStatus = "open" | "closing" | "closed";

export type FiscalYearRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  code: string;
  startDate: string;
  endDate: string;
  status: FiscalYearStatus;
  closedAt?: string;
  closingEntryId?: string;
  openingEntryId?: string;
  netResult?: number;
  createdAt: string;
  updatedAt: string;
};

export type FiscalYearStatusReport = FiscalYearRecord & {
  openPeriods: number;
  draftJournals: number;
  hasOpenJournals: boolean;
  blockingChecks: Array<{ code: string; message: string; severity: "error" | "warn" }>;
  netResultPreview?: number;
  regularizationLinePreview?: Array<{
    accountCode: string;
    accountName: string;
    accountType: string;
    debit: number;
    credit: number;
  }>;
};

export type CloseFiscalYearResult = {
  fiscalYear: FiscalYearRecord;
  regularizationEntryId: string;
  closingEntryId: string;
  openingEntryId: string;
  nextFiscalYearId?: string;
  netResult: number;
  followUps: string[];
};

const RESULT_ACCOUNT_CODE = "129";
const RESULT_ACCOUNT_NAME = "Resultado del ejercicio";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

type FiscalYearRow = NonNullable<Awaited<ReturnType<typeof prisma.fiscalYear.findUnique>>>;

function mapYear(row: FiscalYearRow): FiscalYearRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    code: row.code,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    status: row.status as FiscalYearStatus,
    closedAt: row.closedAt?.toISOString(),
    closingEntryId: row.closingEntryId ?? undefined,
    openingEntryId: row.openingEntryId ?? undefined,
    netResult: row.netResult != null ? Number(row.netResult) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listFiscalYears(input: {
  context: UserContext;
  propertyId?: string;
}): Promise<FiscalYearRecord[]> {
  const rows = await prisma.fiscalYear.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {})
    },
    orderBy: { startDate: "desc" }
  });
  return rows.map(mapYear);
}

export async function createFiscalYear(input: {
  context: UserContext;
  propertyId?: string;
  code: string;
  startDate: string;
  endDate: string;
  correlationId: string;
}): Promise<FiscalYearRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  if (input.startDate >= input.endDate) {
    throw new Error("startDate must be before endDate.");
  }
  const created = await prisma.fiscalYear.create({
    data: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      code: input.code,
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
    action: "FISCAL_YEAR_OPENED",
    entityType: "fiscal_year",
    entityId: created.id,
    afterJson: { code: input.code, startDate: input.startDate, endDate: input.endDate },
    correlationId: input.correlationId
  });
  return mapYear(created);
}

export async function getFiscalYearStatus(input: {
  context: UserContext;
  id: string;
}): Promise<FiscalYearStatusReport> {
  const year = await prisma.fiscalYear.findUnique({ where: { id: input.id } });
  if (!year) throw new Error("Fiscal year was not found.");

  const periodWhere = {
    organizationId: year.organizationId,
    ...(year.propertyId ? { propertyId: year.propertyId } : {}),
    startDate: { gte: year.startDate },
    endDate: { lte: year.endDate }
  } as const;

  const [openPeriods, draftJournals] = await Promise.all([
    prisma.fiscalPeriod.count({ where: { ...periodWhere, status: { not: "closed" } } }),
    prisma.journalEntry.count({
      where: {
        organizationId: year.organizationId,
        ...(year.propertyId ? { propertyId: year.propertyId } : {}),
        status: "draft",
        postedAt: { gte: year.startDate, lte: year.endDate }
      }
    })
  ]);

  // Preview the regularization lines so the UI can show what will be posted.
  const preview = await previewRegularization(year);

  const blockingChecks: FiscalYearStatusReport["blockingChecks"] = [];
  if (year.status === "closed") {
    blockingChecks.push({ code: "ALREADY_CLOSED", message: `Year ${year.code} is already closed.`, severity: "error" });
  }
  if (openPeriods > 0) {
    blockingChecks.push({
      code: "OPEN_PERIODS",
      message: `${openPeriods} fiscal period(s) within ${year.code} are not yet closed.`,
      severity: "error"
    });
  }
  if (draftJournals > 0) {
    blockingChecks.push({
      code: "DRAFT_JOURNALS",
      message: `${draftJournals} draft journal entry/entries exist in ${year.code}.`,
      severity: "error"
    });
  }
  if (preview.missingResultAccount) {
    blockingChecks.push({
      code: "MISSING_ACCOUNT_129",
      message: `Cuenta ${RESULT_ACCOUNT_CODE} "${RESULT_ACCOUNT_NAME}" not found in chart of accounts. Seed it before closing.`,
      severity: "error"
    });
  }

  return {
    ...mapYear(year),
    openPeriods,
    draftJournals,
    hasOpenJournals: draftJournals > 0,
    blockingChecks,
    netResultPreview: round(preview.netResult),
    regularizationLinePreview: preview.lines
  };
}

// ---------------------------------------------------------------------------
// Preview / aggregation helpers
// ---------------------------------------------------------------------------

type AccountBalance = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
};

type PreviewResult = {
  netResult: number;
  lines: Array<{
    accountCode: string;
    accountName: string;
    accountType: string;
    debit: number;
    credit: number;
  }>;
  missingResultAccount: boolean;
};

async function aggregateBalancesForYear(year: FiscalYearRow): Promise<AccountBalance[]> {
  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: year.organizationId,
      ...(year.propertyId ? { propertyId: year.propertyId } : {}),
      status: "posted",
      entryKind: "normal",
      postedAt: { gte: year.startDate, lte: year.endDate }
    },
    select: { id: true }
  });
  if (entries.length === 0) return [];

  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) } }
  });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const grouped = new Map<string, AccountBalance>();
  for (const line of lines) {
    const account = byId.get(line.accountId);
    if (!account) continue;
    const entry = grouped.get(account.id);
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (entry) {
      entry.debit += debit;
      entry.credit += credit;
    } else {
      grouped.set(account.id, {
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        debit,
        credit
      });
    }
  }
  return Array.from(grouped.values()).map((b) => ({
    ...b,
    debit: round(b.debit),
    credit: round(b.credit)
  }));
}

async function previewRegularization(year: FiscalYearRow): Promise<PreviewResult> {
  const balances = await aggregateBalancesForYear(year);
  const lines: PreviewResult["lines"] = [];
  let revenueCredit = 0;
  let expenseDebit = 0;
  for (const bal of balances) {
    const code1 = bal.accountCode.slice(0, 1);
    if (code1 === "7" || bal.accountType === "revenue") {
      // Revenue: natural credit balance. Reverse with a DR so it goes to 0.
      const net = round(bal.credit - bal.debit);
      if (Math.abs(net) < 0.005) continue;
      lines.push({
        accountCode: bal.accountCode,
        accountName: bal.accountName,
        accountType: bal.accountType,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0
      });
      revenueCredit += net;
    } else if (code1 === "6" || bal.accountType === "expense") {
      // Expense: natural debit balance. Reverse with a CR so it goes to 0.
      const net = round(bal.debit - bal.credit);
      if (Math.abs(net) < 0.005) continue;
      lines.push({
        accountCode: bal.accountCode,
        accountName: bal.accountName,
        accountType: bal.accountType,
        debit: net < 0 ? -net : 0,
        credit: net > 0 ? net : 0
      });
      expenseDebit += net;
    }
  }
  const netResult = round(revenueCredit - expenseDebit);

  // Resolve cuenta 129 to know whether the close can run at all.
  const resultAccount = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId: year.organizationId, code: RESULT_ACCOUNT_CODE } },
    select: { id: true, name: true }
  });

  // Plug 129 into the preview so the UI shows the full balanced asiento.
  if (Math.abs(netResult) >= 0.005) {
    lines.push({
      accountCode: RESULT_ACCOUNT_CODE,
      accountName: resultAccount?.name ?? RESULT_ACCOUNT_NAME,
      accountType: "equity",
      // Profit: revenues > expenses → net plugs as CR 129 (equity ↑).
      // Loss:   expenses > revenues → net plugs as DR 129 (equity ↓).
      debit: netResult < 0 ? -netResult : 0,
      credit: netResult > 0 ? netResult : 0
    });
  }

  return { netResult, lines, missingResultAccount: !resultAccount };
}

// ---------------------------------------------------------------------------
// Close orchestration
// ---------------------------------------------------------------------------

export async function closeFiscalYear(input: {
  context: UserContext;
  id: string;
  correlationId: string;
  createNextYear?: boolean;
}): Promise<CloseFiscalYearResult> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);

  const year = await prisma.fiscalYear.findUnique({ where: { id: input.id } });
  if (!year) throw new Error("Fiscal year was not found.");
  if (year.status === "closed") throw new Error(`Fiscal year ${year.code} is already closed.`);

  // (a) All fiscal periods in the year must be closed.
  const openPeriodCount = await prisma.fiscalPeriod.count({
    where: {
      organizationId: year.organizationId,
      ...(year.propertyId ? { propertyId: year.propertyId } : {}),
      startDate: { gte: year.startDate },
      endDate: { lte: year.endDate },
      status: { not: "closed" }
    }
  });
  if (openPeriodCount > 0) {
    throw new Error(`Cannot close ${year.code}: ${openPeriodCount} fiscal period(s) are still open.`);
  }

  // (b) No draft journal entry inside the year.
  const draftCount = await prisma.journalEntry.count({
    where: {
      organizationId: year.organizationId,
      ...(year.propertyId ? { propertyId: year.propertyId } : {}),
      status: "draft",
      postedAt: { gte: year.startDate, lte: year.endDate }
    }
  });
  if (draftCount > 0) {
    throw new Error(`Cannot close ${year.code}: ${draftCount} draft journal entry/entries exist within the year.`);
  }

  // (c) Aggregate balances for every account that had movement in normal entries.
  const balances = await aggregateBalancesForYear(year);

  // (d) Resolve cuenta 129. Without it we cannot post regularización/cierre.
  const resultAccount = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId: year.organizationId, code: RESULT_ACCOUNT_CODE } }
  });
  if (!resultAccount) {
    throw new Error(
      `Cuenta ${RESULT_ACCOUNT_CODE} "${RESULT_ACCOUNT_NAME}" is missing from the chart of accounts for organization ${year.organizationId}. Seed it before closing.`
    );
  }

  // Compute regularization lines + net result.
  const regularizationLines: Array<{ accountId: string; debit: number; credit: number; description: string }> = [];
  let revenueCredit = 0;
  let expenseDebit = 0;
  for (const bal of balances) {
    const code1 = bal.accountCode.slice(0, 1);
    if (code1 === "7" || bal.accountType === "revenue") {
      const net = round(bal.credit - bal.debit);
      if (Math.abs(net) < 0.005) continue;
      regularizationLines.push({
        accountId: bal.accountId,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0,
        description: `Regularización ${year.code} — ${bal.accountCode} ${bal.accountName}`
      });
      revenueCredit += net;
    } else if (code1 === "6" || bal.accountType === "expense") {
      const net = round(bal.debit - bal.credit);
      if (Math.abs(net) < 0.005) continue;
      regularizationLines.push({
        accountId: bal.accountId,
        debit: net < 0 ? -net : 0,
        credit: net > 0 ? net : 0,
        description: `Regularización ${year.code} — ${bal.accountCode} ${bal.accountName}`
      });
      expenseDebit += net;
    }
  }
  const netResult = round(revenueCredit - expenseDebit);

  // Plug cuenta 129 to balance the regularization asiento.
  if (Math.abs(netResult) >= 0.005) {
    regularizationLines.push({
      accountId: resultAccount.id,
      debit: netResult < 0 ? -netResult : 0,
      credit: netResult > 0 ? netResult : 0,
      description: `Regularización ${year.code} — 129 Resultado del ejercicio`
    });
  }

  // After regularization, every account in `balances` that is a P&L account is
  // logically at zero. We must now close everything else (assets, liabilities,
  // equity) AND cuenta 129 with its new balance. Build the closing lines.
  const closingLines: Array<{ accountId: string; debit: number; credit: number; description: string }> = [];
  let closing129Net = netResult; // 129 starts the closing entry with the just-plugged net result
  for (const bal of balances) {
    const code1 = bal.accountCode.slice(0, 1);
    const isPnl = code1 === "6" || code1 === "7" || bal.accountType === "revenue" || bal.accountType === "expense";
    if (isPnl) continue;
    const net = round(bal.debit - bal.credit); // signed: + = debit-side balance
    if (Math.abs(net) < 0.005) continue;
    closingLines.push({
      accountId: bal.accountId,
      // Inverse posting: a debit-side balance closes with a CR.
      debit: net < 0 ? -net : 0,
      credit: net > 0 ? net : 0,
      description: `Cierre ${year.code} — ${bal.accountCode} ${bal.accountName}`
    });
    // If we happened to find prior 129 movements in `balances`, fold them in.
    if (bal.accountId === resultAccount.id) {
      closing129Net += -net; // bring its sign convention into our credit-natural 129 tracker
    }
  }
  // Close cuenta 129 with the regularization-derived net result.
  if (Math.abs(closing129Net) >= 0.005) {
    closingLines.push({
      accountId: resultAccount.id,
      // 129 is credit-natural with a profit → credit balance → close with a DR.
      debit: closing129Net > 0 ? closing129Net : 0,
      credit: closing129Net < 0 ? -closing129Net : 0,
      description: `Cierre ${year.code} — 129 Resultado del ejercicio`
    });
  }

  // Opening (next year) mirrors the closing lines in their original DR/CR
  // direction so balances are reinstated at 1/1.
  const openingLines = closingLines.map((line) => ({
    accountId: line.accountId,
    debit: line.credit, // swap: closing-CR → opening-DR (reinstates a debit balance)
    credit: line.debit,
    description: line.description.replace("Cierre", "Apertura")
  }));

  // Resolve / create the next fiscal year (always — opening must land somewhere).
  const nextYearStart = new Date(year.endDate);
  nextYearStart.setUTCDate(nextYearStart.getUTCDate() + 1);
  const nextYearEnd = new Date(nextYearStart);
  nextYearEnd.setUTCFullYear(nextYearEnd.getUTCFullYear() + 1);
  nextYearEnd.setUTCDate(nextYearEnd.getUTCDate() - 1);
  const nextCode = String(Number(year.code) + 1);

  const result = await prisma.$transaction(async (tx) => {
    // Ensure next year exists. We use findFirst (not findUnique on the
    // composite unique) because `propertyId` may be null and Prisma's typed
    // composite-unique key isn't ergonomic with nulls.
    let nextYear = await tx.fiscalYear.findFirst({
      where: {
        organizationId: year.organizationId,
        propertyId: year.propertyId,
        code: nextCode
      }
    });
    if (!nextYear) {
      nextYear = await tx.fiscalYear.create({
        data: {
          organizationId: year.organizationId,
          propertyId: year.propertyId,
          code: nextCode,
          startDate: nextYearStart,
          endDate: nextYearEnd,
          status: "open"
        }
      });
    }

    const yearEndDate = new Date(year.endDate);
    yearEndDate.setUTCHours(23, 59, 59, 0);

    // Asiento 1: Regularización
    const regEntry = await tx.journalEntry.create({
      data: {
        organizationId: year.organizationId,
        propertyId: year.propertyId,
        sourceType: "manual",
        sourceId: `year-close:${year.id}:regularization`,
        status: "posted",
        postedAt: yearEndDate,
        createdBy: input.context.userId,
        fiscalYearId: year.id,
        entryKind: "regularization"
      }
    });
    if (regularizationLines.length > 0) {
      await tx.journalLine.createMany({
        data: regularizationLines.map((l) => ({
          journalEntryId: regEntry.id,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          currency: "EUR",
          description: l.description
        }))
      });
    }

    // Asiento 2: Cierre
    const closeEntry = await tx.journalEntry.create({
      data: {
        organizationId: year.organizationId,
        propertyId: year.propertyId,
        sourceType: "manual",
        sourceId: `year-close:${year.id}:closing`,
        status: "posted",
        postedAt: yearEndDate,
        createdBy: input.context.userId,
        fiscalYearId: year.id,
        entryKind: "closing"
      }
    });
    if (closingLines.length > 0) {
      await tx.journalLine.createMany({
        data: closingLines.map((l) => ({
          journalEntryId: closeEntry.id,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          currency: "EUR",
          description: l.description
        }))
      });
    }

    // Asiento 3: Apertura del año siguiente
    const openEntry = await tx.journalEntry.create({
      data: {
        organizationId: year.organizationId,
        propertyId: year.propertyId,
        sourceType: "manual",
        sourceId: `year-close:${year.id}:opening`,
        status: "posted",
        postedAt: nextYearStart,
        createdBy: input.context.userId,
        fiscalYearId: nextYear.id,
        entryKind: "opening"
      }
    });
    if (openingLines.length > 0) {
      await tx.journalLine.createMany({
        data: openingLines.map((l) => ({
          journalEntryId: openEntry.id,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          currency: "EUR",
          description: l.description
        }))
      });
    }

    const updatedYear = await tx.fiscalYear.update({
      where: { id: year.id },
      data: {
        status: "closed",
        closedAt: new Date(),
        closingEntryId: closeEntry.id,
        openingEntryId: openEntry.id,
        netResult: netResult
      }
    });

    return {
      year: updatedYear,
      nextYear,
      regEntryId: regEntry.id,
      closeEntryId: closeEntry.id,
      openEntryId: openEntry.id
    };
  });

  const followUps: string[] = [];
  followUps.push(
    `Roll cuenta 129 net result (${netResult.toFixed(2)} EUR) into reservas (cuenta 113/1130) via a separate manual asiento.`
  );
  if (Math.abs(netResult) >= 0.005) {
    followUps.push("Distribute result of the year per shareholder resolution; this sprint only handles the close mechanics.");
  }

  recordAuditEvent({
    organizationId: year.organizationId,
    propertyId: year.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_YEAR_CLOSED",
    entityType: "fiscal_year",
    entityId: year.id,
    beforeJson: mapYear(year),
    afterJson: {
      ...mapYear(result.year),
      regularizationEntryId: result.regEntryId,
      closingEntryId: result.closeEntryId,
      openingEntryId: result.openEntryId,
      netResult
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: year.organizationId,
    propertyId: year.propertyId ?? "",
    entityType: "fiscal_year",
    entityId: year.id,
    eventType: "FiscalYearClosed",
    payload: {
      code: year.code,
      netResult,
      regularizationEntryId: result.regEntryId,
      closingEntryId: result.closeEntryId,
      openingEntryId: result.openEntryId,
      nextFiscalYearId: result.nextYear.id
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    fiscalYear: mapYear(result.year),
    regularizationEntryId: result.regEntryId,
    closingEntryId: result.closeEntryId,
    openingEntryId: result.openEntryId,
    nextFiscalYearId: result.nextYear.id,
    netResult,
    followUps
  };
}

// ---------------------------------------------------------------------------
// Reopen
// ---------------------------------------------------------------------------

export async function reopenFiscalYear(input: {
  context: UserContext;
  id: string;
  reason: string;
  correlationId: string;
}): Promise<FiscalYearRecord> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);
  const year = await prisma.fiscalYear.findUnique({ where: { id: input.id } });
  if (!year) throw new Error("Fiscal year was not found.");
  if (year.status !== "closed") throw new Error(`Fiscal year ${year.code} is not closed.`);

  // Refuse if any subsequent year is also closed — reopen has to cascade in
  // reverse chronological order, and that's out of scope for an automated path.
  const laterClosed = await prisma.fiscalYear.findFirst({
    where: {
      organizationId: year.organizationId,
      propertyId: year.propertyId,
      startDate: { gt: year.startDate },
      status: "closed"
    },
    select: { code: true }
  });
  if (laterClosed) {
    throw new Error(
      `Cannot reopen ${year.code}: a subsequent year (${laterClosed.code}) is also closed. Reopen later years first.`
    );
  }

  // Remove the regularización/cierre/apertura asientos so a subsequent close
  // does not POST A DUPLICATE SET (the previous behaviour left them in place,
  // which double-counted closing balances on re-close). The reopen is itself an
  // audited action (FISCAL_YEAR_REOPENED below), preserving the paper trail.
  const closeEntries = await prisma.journalEntry.findMany({
    where: {
      OR: [
        { fiscalYearId: year.id, entryKind: { in: ["regularization", "closing", "opening"] } },
        ...(year.closingEntryId ? [{ id: year.closingEntryId }] : []),
        ...(year.openingEntryId ? [{ id: year.openingEntryId }] : [])
      ]
    },
    select: { id: true }
  });
  const closeEntryIds = closeEntries.map((e) => e.id);

  const updated = await prisma.$transaction(async (tx) => {
    if (closeEntryIds.length > 0) {
      await tx.journalLine.deleteMany({ where: { journalEntryId: { in: closeEntryIds } } });
      await tx.journalEntry.deleteMany({ where: { id: { in: closeEntryIds } } });
    }
    return tx.fiscalYear.update({
      where: { id: year.id },
      data: { status: "open", closedAt: null, closingEntryId: null, openingEntryId: null, netResult: null }
    });
  });

  recordAuditEvent({
    organizationId: year.organizationId,
    propertyId: year.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_YEAR_REOPENED",
    entityType: "fiscal_year",
    entityId: year.id,
    beforeJson: mapYear(year),
    afterJson: { ...mapYear(updated), reason: input.reason },
    correlationId: input.correlationId
  });

  return mapYear(updated);
}
