import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { requireDateRange } from "../../lib/query-dates.js";
import { ZERO, aggregateAccountBalances, previousDay, type AccountBalanceRow, type Decimal } from "./accounting.service.js";

// Estado de flujos de efectivo (indirect method) over [fromDate, toDate]
// INCLUSIVE by fecha contable: opening balances = everything through the day
// before `fromDate`, closing = everything through `toDate`, period = the
// window itself (year-end asientos excluded from the period P&L; the cierre
// asiento dated on a balance day excluded from that balance, see
// aggregateAccountBalances.closingCutoff). Exact Decimal arithmetic throughout.

export type CashFlowItem = { description: string; amount: number };
export type WorkingCapitalChange = { category: string; amount: number };

export type CashFlowStatement = {
  organizationId: string;
  propertyId?: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  operating: {
    netIncome: number;
    depreciation: number;
    workingCapitalChanges: WorkingCapitalChange[];
    subtotal: number;
  };
  investing: {
    items: CashFlowItem[];
    subtotal: number;
  };
  financing: {
    items: CashFlowItem[];
    subtotal: number;
  };
  netChangeInCash: number;
  openingCash: number;
  closingCash: number;
  /** netChangeInCash == closingCash − openingCash (indirect method reconciles). */
  reconciled: boolean;
};

function toNumber(value: Decimal): number {
  return Number(value.toFixed(2));
}

// Cash and equivalents (PGC): 57x.
const CASH_PREFIX2 = "57";
// Receivables: 43x (clientes), 44x (deudores), 460 (anticipos de remuneraciones), 470/471/472/473/474 (AAPP deudoras).
const AR_3 = new Set(["430", "431", "432", "433", "434", "435", "436", "437", "440", "441", "446", "449", "460", "470", "471", "472", "473", "474"]);
// Payables: 40x/41x (proveedores, acreedores), 465 (remuneraciones pendientes), 475/476/477 (AAPP acreedoras), 438 (anticipos de clientes).
const AP_3 = new Set(["400", "401", "403", "405", "406", "410", "411", "419", "438", "465", "475", "476", "477"]);
const DEPRECIATION_PREFIX2 = "68";
const FIXED_ASSET_PREFIXES = ["20", "21", "22", "23", "24", "25", "26", "27"];
const LONG_TERM_DEBT_PREFIX2 = ["17", "18"];
const SHORT_TERM_DEBT_PREFIX2 = ["52"];
const CAPITAL_PREFIX2 = ["10"];
const RESERVES_PREFIX2 = ["11"];
const DIVIDENDS_3 = new Set(["526"]);

function kindOf(row: AccountBalanceRow): string {
  const kind = row.kind === "revenue" ? "income" : row.kind;
  return kind || (row.accountType === "revenue" ? "income" : row.accountType);
}

function isInventory(code: string): boolean {
  return code.startsWith("3");
}

function cashBalance(rows: AccountBalanceRow[]): Decimal {
  return rows.filter((row) => kindOf(row) === "asset" && row.accountCode.startsWith(CASH_PREFIX2)).reduce((acc, row) => acc.plus(row.debit).minus(row.credit), ZERO);
}

function netIncome(rows: AccountBalanceRow[]): Decimal {
  let result = ZERO;
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === "income") result = result.plus(row.credit).minus(row.debit);
    else if (kind === "expense") result = result.minus(row.debit).plus(row.credit);
  }
  return result;
}

function depreciation(rows: AccountBalanceRow[]): Decimal {
  return rows.filter((row) => kindOf(row) === "expense" && row.accountCode.startsWith(DEPRECIATION_PREFIX2)).reduce((acc, row) => acc.plus(row.debit).minus(row.credit), ZERO);
}

type Balance = { kind: string; debitNet: Decimal; creditNet: Decimal };

function balanceMap(rows: AccountBalanceRow[]): Map<string, Balance> {
  return new Map(rows.map((row) => [row.accountCode, { kind: kindOf(row), debitNet: row.debit.minus(row.credit), creditNet: row.credit.minus(row.debit) }]));
}

/**
 * Working capital (indirect method): an increase of a current asset uses cash
 * (opening − closing); an increase of a current liability preserves cash
 * (closing − opening).
 */
function workingCapital(opening: AccountBalanceRow[], closing: AccountBalanceRow[]): { changes: WorkingCapitalChange[]; total: Decimal } {
  const open = balanceMap(opening);
  const close = balanceMap(closing);
  let ar = ZERO;
  let inventory = ZERO;
  let ap = ZERO;
  for (const code of new Set([...open.keys(), ...close.keys()])) {
    const o = open.get(code);
    const c = close.get(code);
    const kind = (o ?? c)?.kind;
    if (!kind) continue;
    const p3 = code.slice(0, 3);
    if (kind === "asset" && AR_3.has(p3)) ar = ar.plus(o?.debitNet ?? ZERO).minus(c?.debitNet ?? ZERO);
    else if (kind === "asset" && isInventory(code)) inventory = inventory.plus(o?.debitNet ?? ZERO).minus(c?.debitNet ?? ZERO);
    else if (kind === "liability" && AP_3.has(p3)) ap = ap.plus(c?.creditNet ?? ZERO).minus(o?.creditNet ?? ZERO);
  }
  const changes = [
    { category: "Cambio en cuentas a cobrar (clientes, deudores y AAPP deudoras)", amount: toNumber(ar) },
    { category: "Cambio en existencias", amount: toNumber(inventory) },
    { category: "Cambio en cuentas a pagar (proveedores, acreedores, remuneraciones y AAPP acreedoras)", amount: toNumber(ap) }
  ];
  return { changes, total: ar.plus(inventory).plus(ap) };
}

function investing(rows: AccountBalanceRow[]): { items: CashFlowItem[]; total: Decimal } {
  const items: CashFlowItem[] = [];
  let total = ZERO;
  for (const row of rows) {
    if (kindOf(row) !== "asset" || !FIXED_ASSET_PREFIXES.includes(row.accountCode.slice(0, 2))) continue;
    const net = row.debit.minus(row.credit); // purchase → outflow
    if (net.isZero()) continue;
    items.push({ description: `${row.accountCode} ${row.accountName}`, amount: toNumber(net.negated()) });
    total = total.minus(net);
  }
  return { items, total };
}

function financing(rows: AccountBalanceRow[]): { items: CashFlowItem[]; total: Decimal } {
  const items: CashFlowItem[] = [];
  let total = ZERO;
  for (const row of rows) {
    const kind = kindOf(row);
    const p2 = row.accountCode.slice(0, 2);
    const p3 = row.accountCode.slice(0, 3);
    const delta = row.credit.minus(row.debit);
    if (delta.isZero()) continue;
    if (kind === "liability" && DIVIDENDS_3.has(p3)) {
      items.push({ description: `${row.accountCode} ${row.accountName} (dividendos)`, amount: toNumber(delta.negated()) });
      total = total.minus(delta);
    } else if (kind === "liability" && LONG_TERM_DEBT_PREFIX2.includes(p2)) {
      items.push({ description: `${row.accountCode} ${row.accountName} (deuda a largo plazo)`, amount: toNumber(delta) });
      total = total.plus(delta);
    } else if (kind === "liability" && SHORT_TERM_DEBT_PREFIX2.includes(p2)) {
      items.push({ description: `${row.accountCode} ${row.accountName} (deuda a corto plazo)`, amount: toNumber(delta) });
      total = total.plus(delta);
    } else if (kind === "equity" && CAPITAL_PREFIX2.includes(p2)) {
      items.push({ description: `${row.accountCode} ${row.accountName} (aportaciones de capital)`, amount: toNumber(delta) });
      total = total.plus(delta);
    } else if (kind === "equity" && RESERVES_PREFIX2.includes(p2)) {
      items.push({ description: `${row.accountCode} ${row.accountName} (reservas)`, amount: toNumber(delta) });
      total = total.plus(delta);
    }
  }
  return { items, total };
}

export async function buildCashFlow(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
}): Promise<CashFlowStatement> {
  requirePermissions(input.context, ["analytics.read"]);
  requireDateRange(input.fromDate, input.toDate, { strict: false });
  const scope = { organizationId: input.context.organizationId, propertyId: input.propertyId };
  const [periodRows, openingRows, closingRows] = await Promise.all([
    aggregateAccountBalances({ ...scope, from: input.fromDate, to: input.toDate, excludeKinds: ["regularization", "closing", "opening"] }),
    aggregateAccountBalances({ ...scope, to: previousDay(input.fromDate), closingCutoff: previousDay(input.fromDate) }),
    aggregateAccountBalances({ ...scope, to: input.toDate, closingCutoff: input.toDate })
  ]);

  const openingCash = cashBalance(openingRows);
  const closingCash = cashBalance(closingRows);
  const income = netIncome(periodRows);
  const dep = depreciation(periodRows);
  const wc = workingCapital(openingRows, closingRows);
  const operatingSubtotal = income.plus(dep).plus(wc.total);
  const inv = investing(periodRows);
  const fin = financing(periodRows);
  const netChange = operatingSubtotal.plus(inv.total).plus(fin.total);

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    periodStart: input.fromDate,
    periodEnd: input.toDate,
    generatedAt: new Date().toISOString(),
    operating: { netIncome: toNumber(income), depreciation: toNumber(dep), workingCapitalChanges: wc.changes, subtotal: toNumber(operatingSubtotal) },
    investing: { items: inv.items, subtotal: toNumber(inv.total) },
    financing: { items: fin.items, subtotal: toNumber(fin.total) },
    netChangeInCash: toNumber(netChange),
    openingCash: toNumber(openingCash),
    closingCash: toNumber(closingCash),
    reconciled: netChange.equals(closingCash.minus(openingCash))
  };
}
