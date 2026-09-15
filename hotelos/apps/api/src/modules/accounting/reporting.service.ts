import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireDateRange, requireIsoDate } from "../../lib/query-dates.js";
import { ZERO, aggregateAccountBalances, type AccountBalanceRow, type Decimal } from "./accounting.service.js";

// Cuenta de pérdidas y ganancias (PyG) over [fromDate, toDate] INCLUSIVE by
// fecha contable, grouped by the PGC Pymes headings, plus the legacy raw
// balance sheet (kept for `?legacy=1`). Year-end asientos (regularización,
// cierre, apertura) never enter the PyG: they would zero it.

export type PnlLine = {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
  netAmount: number;
};

export type PnlSection = {
  /** PGC Pymes heading code (1 · 4 · 6 · 7 · 8 · A · 12 · 13 · A.1 · A.2 · A.3 · A.4 · A.5). */
  code: string;
  label: string;
  lines: PnlLine[];
  total: number;
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
  /** PGC Pymes presentation: headings with their subtotals. */
  sections: PnlSection[];
  operatingResult: number;
  financialResult: number;
  resultBeforeTax: number;
  incomeTax: number;
};

function toNumber(value: Decimal): number {
  return Number(value.toFixed(2));
}

const PNL_HEADINGS: Array<{ code: string; label: string; match: (code: string) => boolean }> = [
  { code: "1", label: "Importe neto de la cifra de negocios", match: (c) => c.startsWith("70") },
  { code: "4", label: "Aprovisionamientos", match: (c) => c.startsWith("60") || c.startsWith("61") },
  { code: "5", label: "Otros ingresos de explotación", match: (c) => c.startsWith("75") },
  { code: "6", label: "Gastos de personal", match: (c) => c.startsWith("64") },
  { code: "7", label: "Otros gastos de explotación", match: (c) => c.startsWith("62") || c.startsWith("631") || c.startsWith("634") || c.startsWith("65") },
  { code: "8", label: "Amortización del inmovilizado", match: (c) => c.startsWith("68") },
  { code: "11", label: "Otros resultados", match: (c) => c.startsWith("67") || c.startsWith("69") || c.startsWith("71") || c.startsWith("73") || c.startsWith("74") || c.startsWith("77") || c.startsWith("79") },
  { code: "12", label: "Ingresos financieros", match: (c) => c.startsWith("76") },
  { code: "13", label: "Gastos financieros", match: (c) => c.startsWith("66") },
  { code: "17", label: "Impuesto sobre beneficios", match: (c) => c.startsWith("630") || c.startsWith("633") || c.startsWith("638") }
];

function headingFor(code: string): { code: string; label: string } {
  for (const heading of PNL_HEADINGS) if (heading.match(code)) return heading;
  return code.startsWith("7") ? { code: "5", label: "Otros ingresos de explotación" } : { code: "7", label: "Otros gastos de explotación" };
}

export function pnlFromBalances(rows: AccountBalanceRow[]): Omit<PnlReport, "organizationId" | "propertyId" | "fromDate" | "toDate" | "generatedAt"> {
  const revenue: Array<PnlLine & { d: Decimal }> = [];
  const expense: Array<PnlLine & { d: Decimal }> = [];
  const sections = new Map<string, { code: string; label: string; lines: PnlLine[]; total: Decimal }>();
  for (const row of rows) {
    const kind = row.kind === "revenue" ? "income" : row.kind;
    const legacy = row.accountType === "revenue" ? "income" : row.accountType;
    const isIncome = kind === "income" || (kind !== "expense" && legacy === "income") || (kind !== "expense" && kind !== "income" && row.accountCode.startsWith("7"));
    const isExpense = kind === "expense" || (kind !== "income" && legacy === "expense") || (kind !== "expense" && kind !== "income" && row.accountCode.startsWith("6"));
    if (!isIncome && !isExpense) continue;
    const net = isIncome ? row.credit.minus(row.debit) : row.debit.minus(row.credit);
    const line: PnlLine & { d: Decimal } = {
      accountCode: row.accountCode,
      accountName: row.accountName,
      accountType: isIncome ? "revenue" : "expense",
      debit: toNumber(row.debit),
      credit: toNumber(row.credit),
      netAmount: toNumber(net),
      d: net
    };
    (isIncome ? revenue : expense).push(line);
    const heading = headingFor(row.accountCode);
    const section = sections.get(heading.code) ?? { code: heading.code, label: heading.label, lines: [], total: ZERO };
    section.lines.push({ accountCode: line.accountCode, accountName: line.accountName, accountType: line.accountType, debit: line.debit, credit: line.credit, netAmount: line.netAmount });
    // Signed contribution to the result: income +, expense −.
    section.total = section.total.plus(isIncome ? net : net.negated());
    sections.set(heading.code, section);
  }
  const byCode = (a: PnlLine, b: PnlLine) => a.accountCode.localeCompare(b.accountCode);
  revenue.sort(byCode);
  expense.sort(byCode);
  const revenueTotal = revenue.reduce((acc, l) => acc.plus(l.d), ZERO);
  const expenseTotal = expense.reduce((acc, l) => acc.plus(l.d), ZERO);
  const total = (code: string) => sections.get(code)?.total ?? ZERO;
  const financialResult = total("12").plus(total("13"));
  const incomeTax = total("17");
  const operatingResult = revenueTotal.minus(expenseTotal).minus(financialResult).minus(incomeTax);
  const resultBeforeTax = operatingResult.plus(financialResult);
  const orderedSections = Array.from(sections.values())
    .sort((a, b) => Number(a.code) - Number(b.code))
    .map((s) => ({ code: s.code, label: s.label, lines: s.lines.sort(byCode), total: toNumber(s.total) }));
  return {
    revenue: revenue.map(({ d: _d, ...line }) => line),
    expense: expense.map(({ d: _d, ...line }) => line),
    revenueTotal: toNumber(revenueTotal),
    expenseTotal: toNumber(expenseTotal),
    netResult: toNumber(revenueTotal.minus(expenseTotal)),
    sections: orderedSections,
    operatingResult: toNumber(operatingResult),
    financialResult: toNumber(financialResult),
    resultBeforeTax: toNumber(resultBeforeTax),
    incomeTax: toNumber(incomeTax)
  };
}

export async function getProfitAndLoss(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
}): Promise<PnlReport> {
  requirePermissions(input.context, ["analytics.read"]);
  // Inclusive window: a one-day PyG is valid.
  requireDateRange(input.fromDate, input.toDate, { strict: false });
  const rows = await aggregateAccountBalances({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    from: input.fromDate,
    to: input.toDate,
    excludeKinds: ["regularization", "closing", "opening"],
    kinds: ["income", "expense"]
  });
  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    generatedAt: new Date().toISOString(),
    ...pnlFromBalances(rows)
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

/** Legacy raw balance (`?legacy=1`): every balance-sheet account with its signed balance as of the date, inclusive. */
export async function getBalanceSheet(input: {
  context: UserContext;
  propertyId?: string;
  asOf: string;
}): Promise<BalanceSheet> {
  requirePermissions(input.context, ["analytics.read"]);
  requireIsoDate(input.asOf, "asOf");
  const rows = await aggregateAccountBalances({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    to: input.asOf,
    closingCutoff: input.asOf,
    kinds: ["asset", "liability", "equity"]
  });
  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];
  const equity: BalanceSheetLine[] = [];
  let assetsTotal = ZERO;
  let liabilitiesTotal = ZERO;
  let equityTotal = ZERO;
  for (const row of rows) {
    const balance = row.kind === "asset" ? row.debit.minus(row.credit) : row.credit.minus(row.debit);
    const line = { accountCode: row.accountCode, accountName: row.accountName, accountType: row.kind, balance: toNumber(balance) };
    if (row.kind === "asset") {
      assets.push(line);
      assetsTotal = assetsTotal.plus(balance);
    } else if (row.kind === "liability") {
      liabilities.push(line);
      liabilitiesTotal = liabilitiesTotal.plus(balance);
    } else {
      equity.push(line);
      equityTotal = equityTotal.plus(balance);
    }
  }
  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    asOf: input.asOf,
    generatedAt: new Date().toISOString(),
    assets,
    liabilities,
    equity,
    assetsTotal: toNumber(assetsTotal),
    liabilitiesTotal: toNumber(liabilitiesTotal),
    equityTotal: toNumber(equityTotal)
  };
}
