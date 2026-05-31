import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

export type BalanceSheetItem = {
  accountCode: string;
  accountName: string;
  amount: number;
};

export type FormalBalanceSheet = {
  organizationId: string;
  propertyId?: string;
  asOf: string;
  generatedAt: string;
  assets: {
    nonCurrent: BalanceSheetItem[];
    current: BalanceSheetItem[];
    total: number;
  };
  liabilities: {
    nonCurrent: BalanceSheetItem[];
    current: BalanceSheetItem[];
    total: number;
  };
  equity: {
    items: BalanceSheetItem[];
    retainedEarnings: number;
    total: number;
  };
  totalLiabPlusEquity: number;
  balanced: boolean;
};

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Spanish PGC classification helpers.
// Asset codes starting with "20".."27" are non-current ("inmovilizado"),
// "28" is accumulated depreciation (subtracts from non-current).
const NON_CURRENT_ASSET_PREFIXES = ["20", "21", "22", "23", "24", "25", "26", "27"];
const ACC_DEPRECIATION_PREFIX = "28";

// Current asset prefixes / explicit codes (3-digit lookup against code's first 3 chars).
const CURRENT_ASSET_3 = new Set([
  "430", "431", "436", "440", "460", "470", "472", "473",
  "544", "550", "570", "572", "574"
]);
const CURRENT_ASSET_PREFIX1 = ["3"]; // 3xx stocks

// Non-current liabilities: 17x
const NON_CURRENT_LIABILITY_PREFIX2 = ["17"];

// Current liability 3-digit codes
const CURRENT_LIABILITY_3 = new Set([
  "400", "401", "410", "438", "475", "476", "477", "520", "523", "551", "555"
]);

// Equity 3-digit codes
const EQUITY_3 = new Set([
  "100", "110", "111", "112", "113", "114", "115", "118", "120", "121", "129"
]);

type AggregatedAccount = {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
};

function classifyAsset(code: string): "non_current" | "current" | "acc_depreciation" | "none" {
  const p2 = code.slice(0, 2);
  const p3 = code.slice(0, 3);
  if (p2 === ACC_DEPRECIATION_PREFIX) return "acc_depreciation";
  if (NON_CURRENT_ASSET_PREFIXES.includes(p2)) return "non_current";
  if (CURRENT_ASSET_3.has(p3)) return "current";
  if (CURRENT_ASSET_PREFIX1.includes(code.slice(0, 1))) return "current";
  return "none";
}

function classifyLiability(code: string): "non_current" | "current" | "none" {
  const p2 = code.slice(0, 2);
  const p3 = code.slice(0, 3);
  if (NON_CURRENT_LIABILITY_PREFIX2.includes(p2)) return "non_current";
  if (CURRENT_LIABILITY_3.has(p3)) return "current";
  return "none";
}

function isEquity(code: string): boolean {
  return EQUITY_3.has(code.slice(0, 3));
}

async function aggregateBalances(input: {
  organizationId: string;
  propertyId?: string;
  upToInclusive: Date;
}): Promise<AggregatedAccount[]> {
  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      status: "posted",
      postedAt: { lte: input.upToInclusive }
    },
    select: { id: true }
  });
  if (entries.length === 0) return [];

  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) } }
  });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const grouped = new Map<string, AggregatedAccount>();
  for (const line of lines) {
    const account = accountById.get(line.accountId);
    if (!account) continue;
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const existing = grouped.get(account.code);
    if (existing) {
      existing.debit += debit;
      existing.credit += credit;
    } else {
      grouped.set(account.code, {
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        debit,
        credit
      });
    }
  }
  return Array.from(grouped.values());
}

export async function buildBalanceSheet(input: {
  context: UserContext;
  propertyId?: string;
  asOf: string;
}): Promise<FormalBalanceSheet> {
  requirePermissions(input.context, ["analytics.read"]);

  const cutoff = dateOnly(input.asOf);
  const aggregated = await aggregateBalances({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    upToInclusive: cutoff
  });

  const empty: FormalBalanceSheet = {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    generatedAt: new Date().toISOString(),
    assets: { nonCurrent: [], current: [], total: 0 },
    liabilities: { nonCurrent: [], current: [], total: 0 },
    equity: { items: [], retainedEarnings: 0, total: 0 },
    totalLiabPlusEquity: 0,
    balanced: true
  };
  if (aggregated.length === 0) return empty;

  const assetsNonCurrent: BalanceSheetItem[] = [];
  const assetsCurrent: BalanceSheetItem[] = [];
  const liabilitiesNonCurrent: BalanceSheetItem[] = [];
  const liabilitiesCurrent: BalanceSheetItem[] = [];
  const equityItems: BalanceSheetItem[] = [];

  let revenueTotal = 0;
  let expenseTotal = 0;

  for (const row of aggregated) {
    const code = row.accountCode;
    const debitNaturalBalance = row.debit - row.credit; // positive for assets/expenses
    const creditNaturalBalance = row.credit - row.debit; // positive for liab/equity/revenue

    if (row.accountType === "revenue") {
      revenueTotal += creditNaturalBalance;
      continue;
    }
    if (row.accountType === "expense") {
      expenseTotal += debitNaturalBalance;
      continue;
    }

    if (row.accountType === "asset") {
      const cls = classifyAsset(code);
      if (cls === "acc_depreciation") {
        // Accumulated depreciation has credit balance; it subtracts from non-current.
        assetsNonCurrent.push({
          accountCode: code,
          accountName: row.accountName,
          amount: round(-creditNaturalBalance)
        });
      } else if (cls === "non_current") {
        assetsNonCurrent.push({
          accountCode: code,
          accountName: row.accountName,
          amount: round(debitNaturalBalance)
        });
      } else if (cls === "current") {
        assetsCurrent.push({
          accountCode: code,
          accountName: row.accountName,
          amount: round(debitNaturalBalance)
        });
      } else {
        // Fallback: classify by debit-balance default to current.
        assetsCurrent.push({
          accountCode: code,
          accountName: row.accountName,
          amount: round(debitNaturalBalance)
        });
      }
      continue;
    }

    if (row.accountType === "liability") {
      const cls = classifyLiability(code);
      const amount = round(creditNaturalBalance);
      const item = { accountCode: code, accountName: row.accountName, amount };
      if (cls === "non_current") liabilitiesNonCurrent.push(item);
      else if (cls === "current") liabilitiesCurrent.push(item);
      else liabilitiesCurrent.push(item); // fallback to current
      continue;
    }

    if (row.accountType === "equity") {
      if (isEquity(code)) {
        equityItems.push({
          accountCode: code,
          accountName: row.accountName,
          amount: round(creditNaturalBalance)
        });
      } else {
        equityItems.push({
          accountCode: code,
          accountName: row.accountName,
          amount: round(creditNaturalBalance)
        });
      }
      continue;
    }
  }

  const sortByCode = (a: BalanceSheetItem, b: BalanceSheetItem) =>
    a.accountCode.localeCompare(b.accountCode);
  assetsNonCurrent.sort(sortByCode);
  assetsCurrent.sort(sortByCode);
  liabilitiesNonCurrent.sort(sortByCode);
  liabilitiesCurrent.sort(sortByCode);
  equityItems.sort(sortByCode);

  const assetsNCTotal = assetsNonCurrent.reduce((s, i) => s + i.amount, 0);
  const assetsCTotal = assetsCurrent.reduce((s, i) => s + i.amount, 0);
  const assetsTotal = round(assetsNCTotal + assetsCTotal);

  const liabNCTotal = liabilitiesNonCurrent.reduce((s, i) => s + i.amount, 0);
  const liabCTotal = liabilitiesCurrent.reduce((s, i) => s + i.amount, 0);
  const liabilitiesTotal = round(liabNCTotal + liabCTotal);

  const retainedEarnings = round(revenueTotal - expenseTotal);
  const equityBookTotal = equityItems.reduce((s, i) => s + i.amount, 0);
  const equityTotal = round(equityBookTotal + retainedEarnings);

  const totalLiabPlusEquity = round(liabilitiesTotal + equityTotal);

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    generatedAt: new Date().toISOString(),
    assets: { nonCurrent: assetsNonCurrent, current: assetsCurrent, total: assetsTotal },
    liabilities: {
      nonCurrent: liabilitiesNonCurrent,
      current: liabilitiesCurrent,
      total: liabilitiesTotal
    },
    equity: { items: equityItems, retainedEarnings, total: equityTotal },
    totalLiabPlusEquity,
    balanced: Math.abs(assetsTotal - totalLiabPlusEquity) < 0.01
  };
}
