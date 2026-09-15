import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireIsoDate } from "../../lib/query-dates.js";
import { ZERO, aggregateAccountBalances, type AccountBalanceRow, type Decimal } from "./accounting.service.js";

// Balance de situación (PGC Pymes layout) as of a date INCLUSIVE, read by
// fecha contable. The regularización and apertura asientos count (they move
// the result into 129 and reinstate the balances); the cierre asiento dated
// on the requested day is excluded so the 31/12 balance is the pre-close
// picture (a later date includes cierre + apertura). The result of the period
// not yet regularised (Σ7 − Σ6) is shown as «Resultado del ejercicio».

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
    /** Result of the period not yet regularised into 129 (Σ income − Σ expense). */
    retainedEarnings: number;
    total: number;
  };
  totalLiabPlusEquity: number;
  balanced: boolean;
};

function toNumber(value: Decimal): number {
  return Number(value.toFixed(2));
}

// Spanish PGC classification helpers.
// Asset codes starting with "20".."27" are non-current ("inmovilizado"),
// "28"/"29" accumulated depreciation / impairment (subtract from non-current).
const NON_CURRENT_ASSET_PREFIXES = ["20", "21", "22", "23", "24", "25", "26", "27"];
const CONTRA_ASSET_PREFIXES = ["28", "29"];

// Current asset 3-digit codes.
const CURRENT_ASSET_3 = new Set(["430", "431", "432", "433", "434", "435", "436", "437", "438", "440", "441", "460", "465", "470", "471", "472", "473", "474", "480", "540", "544", "548", "550", "551", "555", "558", "565", "566", "570", "571", "572", "573", "574", "575", "576"]);

// Non-current liabilities: 14x provisions, 17x long-term debts, 18x long-term deposits.
const NON_CURRENT_LIABILITY_PREFIX2 = ["14", "17", "18"];

type Classified = "non_current" | "current" | "contra";

function classifyAsset(code: string): Classified {
  const p2 = code.slice(0, 2);
  const p3 = code.slice(0, 3);
  if (CONTRA_ASSET_PREFIXES.includes(p2)) return "contra";
  if (NON_CURRENT_ASSET_PREFIXES.includes(p2)) return "non_current";
  if (CURRENT_ASSET_3.has(p3)) return "current";
  if (code.startsWith("3")) return "current";
  return "current";
}

function classifyLiability(code: string): "non_current" | "current" {
  return NON_CURRENT_LIABILITY_PREFIX2.includes(code.slice(0, 2)) ? "non_current" : "current";
}

function kindOf(row: AccountBalanceRow): "asset" | "liability" | "equity" | "income" | "expense" {
  const kind = row.kind === "revenue" ? "income" : row.kind;
  if (kind === "asset" || kind === "liability" || kind === "equity" || kind === "income" || kind === "expense") return kind;
  const legacy = row.accountType === "revenue" ? "income" : row.accountType;
  return (legacy as "asset" | "liability" | "equity" | "income" | "expense") ?? "asset";
}

export function classifyBalanceSheet(rows: AccountBalanceRow[]): Omit<FormalBalanceSheet, "organizationId" | "propertyId" | "asOf" | "generatedAt"> {
  const assetsNonCurrent: Array<BalanceSheetItem & { d: Decimal }> = [];
  const assetsCurrent: Array<BalanceSheetItem & { d: Decimal }> = [];
  const liabilitiesNonCurrent: Array<BalanceSheetItem & { d: Decimal }> = [];
  const liabilitiesCurrent: Array<BalanceSheetItem & { d: Decimal }> = [];
  const equityItems: Array<BalanceSheetItem & { d: Decimal }> = [];
  let income = ZERO;
  let expense = ZERO;

  for (const row of rows) {
    const kind = kindOf(row);
    const debitNatural = row.debit.minus(row.credit);
    const creditNatural = row.credit.minus(row.debit);
    if (kind === "income") {
      income = income.plus(creditNatural);
      continue;
    }
    if (kind === "expense") {
      expense = expense.plus(debitNatural);
      continue;
    }
    if (debitNatural.isZero()) continue;
    const item = (amount: Decimal): BalanceSheetItem & { d: Decimal } => ({ accountCode: row.accountCode, accountName: row.accountName, amount: toNumber(amount), d: amount });
    if (kind === "asset") {
      const cls = classifyAsset(row.accountCode);
      if (cls === "contra") assetsNonCurrent.push(item(debitNatural)); // credit balance → negative amount
      else if (cls === "non_current") assetsNonCurrent.push(item(debitNatural));
      else assetsCurrent.push(item(debitNatural));
      continue;
    }
    if (kind === "liability") {
      if (classifyLiability(row.accountCode) === "non_current") liabilitiesNonCurrent.push(item(creditNatural));
      else liabilitiesCurrent.push(item(creditNatural));
      continue;
    }
    // equity (129 included)
    equityItems.push(item(creditNatural));
  }

  const sortByCode = (a: BalanceSheetItem, b: BalanceSheetItem) => a.accountCode.localeCompare(b.accountCode);
  for (const list of [assetsNonCurrent, assetsCurrent, liabilitiesNonCurrent, liabilitiesCurrent, equityItems]) list.sort(sortByCode);

  const sum = (list: Array<{ d: Decimal }>) => list.reduce((acc, item) => acc.plus(item.d), ZERO);
  const assetsTotal = sum(assetsNonCurrent).plus(sum(assetsCurrent));
  const liabilitiesTotal = sum(liabilitiesNonCurrent).plus(sum(liabilitiesCurrent));
  const retainedEarnings = income.minus(expense);
  const equityTotal = sum(equityItems).plus(retainedEarnings);
  const totalLiabPlusEquity = liabilitiesTotal.plus(equityTotal);
  const strip = (list: Array<BalanceSheetItem & { d: Decimal }>): BalanceSheetItem[] => list.map(({ accountCode, accountName, amount }) => ({ accountCode, accountName, amount }));

  return {
    assets: { nonCurrent: strip(assetsNonCurrent), current: strip(assetsCurrent), total: toNumber(assetsTotal) },
    liabilities: { nonCurrent: strip(liabilitiesNonCurrent), current: strip(liabilitiesCurrent), total: toNumber(liabilitiesTotal) },
    equity: { items: strip(equityItems), retainedEarnings: toNumber(retainedEarnings), total: toNumber(equityTotal) },
    totalLiabPlusEquity: toNumber(totalLiabPlusEquity),
    balanced: assetsTotal.equals(totalLiabPlusEquity)
  };
}

export async function buildBalanceSheet(input: {
  context: UserContext;
  propertyId?: string;
  asOf: string;
}): Promise<FormalBalanceSheet> {
  requirePermissions(input.context, ["analytics.read"]);
  requireIsoDate(input.asOf, "asOf");
  const rows = await aggregateAccountBalances({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    to: input.asOf,
    closingCutoff: input.asOf
  });
  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    generatedAt: new Date().toISOString(),
    ...classifyBalanceSheet(rows)
  };
}
