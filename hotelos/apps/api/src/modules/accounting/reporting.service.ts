import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

export type PnlLine = {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
  netAmount: number;
};

export type PnlReport = {
  organizationId: string;
  propertyId?: string;
  fromDate: string;
  toDate: string;
  generatedAt: string;
  revenue: PnlLine[];
  expense: PnlLine[];
  revenueTotal: number;
  expenseTotal: number;
  netResult: number;
};

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getProfitAndLoss(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
}): Promise<PnlReport> {
  requirePermissions(input.context, ["analytics.read"]);

  if (input.fromDate >= input.toDate) {
    throw new Error("fromDate must be before toDate.");
  }

  const start = dateOnly(input.fromDate);
  const end = dateOnly(input.toDate);

  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      status: "posted",
      postedAt: { gte: start, lt: end }
    },
    select: { id: true }
  });

  if (entries.length === 0) {
    return {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      generatedAt: new Date().toISOString(),
      revenue: [],
      expense: [],
      revenueTotal: 0,
      expenseTotal: 0,
      netResult: 0
    };
  }

  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) } }
  });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const grouped = new Map<string, PnlLine>();
  for (const line of lines) {
    const account = accountById.get(line.accountId);
    if (!account) continue;
    const accountType = account.accountType;
    if (accountType !== "revenue" && accountType !== "expense") continue;
    const key = `${account.code}::${accountType}`;
    const existing = grouped.get(key);
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (existing) {
      existing.debit += debit;
      existing.credit += credit;
      existing.netAmount = accountType === "revenue" ? existing.credit - existing.debit : existing.debit - existing.credit;
    } else {
      grouped.set(key, {
        accountCode: account.code,
        accountName: account.name,
        accountType,
        debit,
        credit,
        netAmount: accountType === "revenue" ? credit - debit : debit - credit
      });
    }
  }

  const revenue: PnlLine[] = [];
  const expense: PnlLine[] = [];
  for (const line of grouped.values()) {
    line.debit = round(line.debit);
    line.credit = round(line.credit);
    line.netAmount = round(line.netAmount);
    if (line.accountType === "revenue") revenue.push(line);
    else expense.push(line);
  }
  revenue.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  expense.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const revenueTotal = round(revenue.reduce((s, l) => s + l.netAmount, 0));
  const expenseTotal = round(expense.reduce((s, l) => s + l.netAmount, 0));

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    generatedAt: new Date().toISOString(),
    revenue,
    expense,
    revenueTotal,
    expenseTotal,
    netResult: round(revenueTotal - expenseTotal)
  };
}

export type BalanceSheetLine = {
  accountCode: string;
  accountName: string;
  accountType: string;
  balance: number;
};

export type BalanceSheet = {
  organizationId: string;
  propertyId?: string;
  asOf: string;
  generatedAt: string;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  equity: BalanceSheetLine[];
  assetsTotal: number;
  liabilitiesTotal: number;
  equityTotal: number;
};

export async function getBalanceSheet(input: {
  context: UserContext;
  propertyId?: string;
  asOf: string;
}): Promise<BalanceSheet> {
  requirePermissions(input.context, ["analytics.read"]);
  const cutoff = dateOnly(input.asOf);

  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      status: "posted",
      postedAt: { lte: cutoff }
    },
    select: { id: true }
  });
  if (entries.length === 0) {
    return {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      asOf: input.asOf,
      generatedAt: new Date().toISOString(),
      assets: [],
      liabilities: [],
      equity: [],
      assetsTotal: 0,
      liabilitiesTotal: 0,
      equityTotal: 0
    };
  }
  const lines = await prisma.journalLine.findMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const grouped = new Map<string, BalanceSheetLine>();
  for (const line of lines) {
    const account = accountById.get(line.accountId);
    if (!account) continue;
    const type = account.accountType;
    if (type !== "asset" && type !== "liability" && type !== "equity") continue;
    const key = account.code;
    const existing = grouped.get(key);
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (existing) {
      existing.balance += type === "asset" ? debit - credit : credit - debit;
    } else {
      grouped.set(key, {
        accountCode: account.code,
        accountName: account.name,
        accountType: type,
        balance: type === "asset" ? debit - credit : credit - debit
      });
    }
  }

  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];
  const equity: BalanceSheetLine[] = [];
  for (const row of grouped.values()) {
    row.balance = round(row.balance);
    if (row.accountType === "asset") assets.push(row);
    else if (row.accountType === "liability") liabilities.push(row);
    else equity.push(row);
  }
  assets.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  liabilities.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  equity.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    generatedAt: new Date().toISOString(),
    assets,
    liabilities,
    equity,
    assetsTotal: round(assets.reduce((s, l) => s + l.balance, 0)),
    liabilitiesTotal: round(liabilities.reduce((s, l) => s + l.balance, 0)),
    equityTotal: round(equity.reduce((s, l) => s + l.balance, 0))
  };
}
