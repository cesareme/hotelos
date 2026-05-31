import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

export type TrialBalanceRow = {
  accountCode: string;
  accountName: string;
  debitTotal: number;
  creditTotal: number;
  balance: number;
};

export type TrialBalanceReport = {
  organizationId: string;
  propertyId?: string;
  asOf: string;
  fromDate?: string;
  toDate?: string;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totals: { debit: number; credit: number };
  balanced: boolean;
};

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function buildTrialBalance(input: {
  context: UserContext;
  propertyId?: string;
  asOf: string;
  fromDate?: string;
  toDate?: string;
}): Promise<TrialBalanceReport> {
  requirePermissions(input.context, ["analytics.read"]);

  const cutoff = dateOnly(input.asOf);

  // Build postedAt filter:
  //  - If both fromDate/toDate provided -> [fromDate, toDate) period filter.
  //  - Otherwise -> cumulative balance up to and including asOf.
  const postedAt: { gte?: Date; lt?: Date; lte?: Date } = {};
  if (input.fromDate || input.toDate) {
    if (input.fromDate) postedAt.gte = dateOnly(input.fromDate);
    if (input.toDate) postedAt.lt = dateOnly(input.toDate);
    else postedAt.lte = cutoff;
  } else {
    postedAt.lte = cutoff;
  }

  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      status: "posted",
      postedAt
    },
    select: { id: true }
  });

  if (entries.length === 0) {
    return {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      asOf: input.asOf,
      fromDate: input.fromDate,
      toDate: input.toDate,
      generatedAt: new Date().toISOString(),
      rows: [],
      totals: { debit: 0, credit: 0 },
      balanced: true
    };
  }

  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) } }
  });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const grouped = new Map<string, TrialBalanceRow & { accountType: string }>();
  for (const line of lines) {
    const account = accountById.get(line.accountId);
    if (!account) continue;
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const existing = grouped.get(account.code);
    if (existing) {
      existing.debitTotal += debit;
      existing.creditTotal += credit;
    } else {
      grouped.set(account.code, {
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        debitTotal: debit,
        creditTotal: credit,
        balance: 0
      });
    }
  }

  const rows: TrialBalanceRow[] = [];
  let debitSum = 0;
  let creditSum = 0;
  for (const row of grouped.values()) {
    const debitTotal = round(row.debitTotal);
    const creditTotal = round(row.creditTotal);
    // Balance is signed: assets/expenses are debit-natural (DR - CR),
    // liabilities/equity/revenue are credit-natural (CR - DR).
    const isDebitNatural = row.accountType === "asset" || row.accountType === "expense";
    const balance = round(isDebitNatural ? debitTotal - creditTotal : creditTotal - debitTotal);
    rows.push({
      accountCode: row.accountCode,
      accountName: row.accountName,
      debitTotal,
      creditTotal,
      balance
    });
    debitSum += debitTotal;
    creditSum += creditTotal;
  }
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const debitTotalRounded = round(debitSum);
  const creditTotalRounded = round(creditSum);

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    fromDate: input.fromDate,
    toDate: input.toDate,
    generatedAt: new Date().toISOString(),
    rows,
    totals: { debit: debitTotalRounded, credit: creditTotalRounded },
    balanced: Math.abs(debitTotalRounded - creditTotalRounded) < 0.01
  };
}
