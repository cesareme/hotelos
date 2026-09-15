import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireIsoDate } from "../../lib/query-dates.js";
import { BadRequestError } from "../../lib/http-error.js";
import { ZERO, aggregateAccountBalances, type AccountBalanceRow } from "./accounting.service.js";

// Sumas y saldos (balance de comprobación). Read from the diario by FECHA
// CONTABLE with INCLUSIVE bounds: `asOf` includes the day itself and a
// fromDate/toDate window includes both ends (the previous version filtered
// by postedAt and dropped the last day). Sums are SQL numeric sums (exact);
// the asiento de cierre dated on the last day of the window is excluded so a
// 31/12 balance stays readable after the year-end close (a later date
// includes cierre + apertura and shows the reinstated balances); drafts and
// reversed pairs never count.

export type TrialBalanceRow = {
  accountCode: string;
  accountName: string;
  kind: string;
  debitTotal: number;
  creditTotal: number;
  /** Signed: debit-natural (asset/expense) = debit − credit; credit-natural = credit − debit. */
  balance: number;
  /** PGC presentation: saldo deudor / saldo acreedor, never both. */
  debitBalance: number;
  creditBalance: number;
};

export type TrialBalanceReport = {
  organizationId: string;
  propertyId?: string;
  asOf: string;
  fromDate?: string;
  toDate?: string;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totals: { debit: number; credit: number; debitBalance: number; creditBalance: number };
  balanced: boolean;
};

function toNumber(value: { toFixed(dp: number): string }): number {
  return Number(value.toFixed(2));
}

export function trialBalanceRows(rows: AccountBalanceRow[]): { rows: TrialBalanceRow[]; totals: TrialBalanceReport["totals"]; balanced: boolean } {
  let debitSum = ZERO;
  let creditSum = ZERO;
  let debitBalanceSum = ZERO;
  let creditBalanceSum = ZERO;
  const out: TrialBalanceRow[] = [];
  for (const row of rows) {
    const isDebitNatural = row.kind === "asset" || row.kind === "expense" || row.accountType === "asset" || row.accountType === "expense";
    const net = row.debit.minus(row.credit);
    const balance = isDebitNatural ? net : net.negated();
    const debitBalance = net.isPositive() ? net : ZERO;
    const creditBalance = net.isNegative() ? net.negated() : ZERO;
    out.push({
      accountCode: row.accountCode,
      accountName: row.accountName,
      kind: row.kind,
      debitTotal: toNumber(row.debit),
      creditTotal: toNumber(row.credit),
      balance: toNumber(balance),
      debitBalance: toNumber(debitBalance),
      creditBalance: toNumber(creditBalance)
    });
    debitSum = debitSum.plus(row.debit);
    creditSum = creditSum.plus(row.credit);
    debitBalanceSum = debitBalanceSum.plus(debitBalance);
    creditBalanceSum = creditBalanceSum.plus(creditBalance);
  }
  out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  return {
    rows: out,
    totals: { debit: toNumber(debitSum), credit: toNumber(creditSum), debitBalance: toNumber(debitBalanceSum), creditBalance: toNumber(creditBalanceSum) },
    balanced: debitSum.equals(creditSum)
  };
}

export async function buildTrialBalance(input: {
  context: UserContext;
  propertyId?: string;
  asOf: string;
  fromDate?: string;
  toDate?: string;
  includeClosing?: boolean;
}): Promise<TrialBalanceReport> {
  requirePermissions(input.context, ["analytics.read"]);
  requireIsoDate(input.asOf, "asOf");
  if (input.fromDate) requireIsoDate(input.fromDate, "fromDate");
  if (input.toDate) requireIsoDate(input.toDate, "toDate");
  if (input.fromDate && input.toDate && input.fromDate > input.toDate) throw new BadRequestError("fromDate no puede ser posterior a toDate.");

  // Window: [fromDate, toDate] inclusive when given; otherwise cumulative through asOf inclusive.
  const from = input.fromDate ?? null;
  const to = input.toDate ?? input.asOf;
  const rows = await aggregateAccountBalances({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    from,
    to,
    closingCutoff: input.includeClosing ? null : to
  });
  const built = trialBalanceRows(rows);
  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    fromDate: input.fromDate,
    toDate: input.toDate,
    generatedAt: new Date().toISOString(),
    rows: built.rows,
    totals: built.totals,
    balanced: built.balanced
  };
}
