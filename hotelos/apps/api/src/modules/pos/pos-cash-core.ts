// Cash closure ("arqueo") — pure core (no database).
//
// Finanzas (2026-09-15, lote «pos-noche»). Everything here is Decimal
// arithmetic on decimal strings so a signed cash count round-trips exactly:
//   expected(method) = fondo (cash only) + cobros − devoluciones + ventas TPV
//                      − gastos de caja pagados en efectivo (cash only)
//   difference       = counted − expected   (positive = sobrante, negative = faltante)
// Only the CASH difference generates a journal entry (D 659 / H 570 faltante ·
// D 570 / H 759 sobrante, rule buildCashClosureDifferenceEntry of
// accounting/posting-rules.ts): a card difference is a datáfono batch to
// reconcile against the acquirer settlement (card_settlement), not a loss.
import { Prisma } from "@prisma/client";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export type CashMethod = "cash" | "card_terminal" | "card_online" | "bank_transfer" | "payment_link" | "other";
export const CASH_METHODS: readonly CashMethod[] = ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"];

export type MethodAmounts = Record<CashMethod, string>;
export type MethodFigures = { expected: string; counted: string | null; difference: string | null };

export type CashExpectationInput = {
  openingFloat: number | string;
  /** Captured folio payments of the day (Payment rows), amount positive. */
  payments: ReadonlyArray<{ method: CashMethod; amount: number | string }>;
  /** Refunds of the day (PaymentRefund rows, or reversal Payments), amount positive. */
  refunds: ReadonlyArray<{ method: CashMethod; amount: number | string }>;
  /** POS tickets settled cash/card on the day (no Payment row), amount positive. */
  posSales: ReadonlyArray<{ method: CashMethod; amount: number | string }>;
  /** Petty-cash expenses paid in cash on the day, amount positive. */
  cashExpenses: ReadonlyArray<number | string>;
};

export type CashExpectation = {
  expectedByMethod: MethodAmounts;
  /** Shortcut for expectedByMethod.cash. */
  expectedCash: string;
  detail: {
    openingFloat: string;
    payments: MethodAmounts;
    refunds: MethodAmounts;
    posSales: MethodAmounts;
    cashExpenses: string;
  };
};

export type CashReconciliation = {
  byMethod: Record<CashMethod, MethodFigures>;
  countedCash: string;
  /** countedCash − expectedCash. */
  difference: string;
  countedTotal: string;
  expectedTotal: string;
};

function money(value: number | string | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  const d = new Decimal(value);
  if (!d.isFinite()) throw new Error(`Importe no válido: ${String(value)}`);
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function zeroByMethod(): Record<CashMethod, Decimal> {
  const out = {} as Record<CashMethod, Decimal>;
  for (const method of CASH_METHODS) out[method] = new Decimal(0);
  return out;
}

function toStrings(values: Record<CashMethod, Decimal>): MethodAmounts {
  const out = {} as MethodAmounts;
  for (const method of CASH_METHODS) out[method] = values[method].toFixed(2);
  return out;
}

/** Legacy Payment.method (free text) → canonical method. Pure. */
export function legacyMethodToCode(method: string | null | undefined): CashMethod {
  switch ((method ?? "").trim().toLowerCase()) {
    case "cash":
    case "efectivo":
      return "cash";
    case "card":
    case "card_terminal":
    case "tarjeta":
    case "datafono":
    case "datáfono":
      return "card_terminal";
    case "card_online":
      return "card_online";
    case "bank_transfer":
    case "transfer":
    case "transferencia":
      return "bank_transfer";
    case "payment_link":
      return "payment_link";
    default:
      return "other";
  }
}

/** POS settlement (cash | card) → canonical method. Pure. */
export function settlementToMethod(settlement: "cash" | "card"): CashMethod {
  return settlement === "cash" ? "cash" : "card_terminal";
}

/** Σ denomination × quantity of a physical count, as a decimal string. Throws on a negative or non-integer quantity. Pure. */
export function sumDenominations(counts: ReadonlyArray<{ denomination: string | number; quantity: number }>): { total: string; rows: Array<{ denomination: string; quantity: number; amount: string }> } {
  let total = new Decimal(0);
  const rows = counts.map((row) => {
    const face = new Decimal(row.denomination);
    if (!face.isFinite() || face.lte(0)) throw new Error(`Denominación no válida: ${String(row.denomination)}`);
    if (!Number.isInteger(row.quantity) || row.quantity < 0) throw new Error(`Cantidad no válida para la denominación ${face.toString()}: ${String(row.quantity)}`);
    const amount = face.mul(row.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    total = total.plus(amount);
    return { denomination: face.toString(), quantity: row.quantity, amount: amount.toFixed(2) };
  });
  return { total: total.toFixed(2), rows };
}

/** Expected amount per method from the day's movements. Pure. */
export function computeCashExpectation(input: CashExpectationInput): CashExpectation {
  const payments = zeroByMethod();
  const refunds = zeroByMethod();
  const posSales = zeroByMethod();
  for (const p of input.payments) payments[p.method] = payments[p.method].plus(money(p.amount));
  for (const r of input.refunds) refunds[r.method] = refunds[r.method].plus(money(r.amount));
  for (const s of input.posSales) posSales[s.method] = posSales[s.method].plus(money(s.amount));
  const cashExpenses = input.cashExpenses.reduce((sum, e) => sum.plus(money(e)), new Decimal(0));
  const openingFloat = money(input.openingFloat);
  if (openingFloat.lt(0)) throw new Error("El fondo de caja no puede ser negativo.");

  const expected = zeroByMethod();
  for (const method of CASH_METHODS) {
    expected[method] = payments[method].minus(refunds[method]).plus(posSales[method]);
  }
  expected.cash = expected.cash.plus(openingFloat).minus(cashExpenses);
  return {
    expectedByMethod: toStrings(expected),
    expectedCash: expected.cash.toFixed(2),
    detail: {
      openingFloat: openingFloat.toFixed(2),
      payments: toStrings(payments),
      refunds: toStrings(refunds),
      posSales: toStrings(posSales),
      cashExpenses: cashExpenses.toFixed(2)
    }
  };
}

/** Counted vs expected per method; a method not counted is 0. Pure. */
export function reconcileCashCount(expectedByMethod: MethodAmounts, countedByMethod: Partial<Record<CashMethod, number | string | null | undefined>>): CashReconciliation {
  const byMethod = {} as Record<CashMethod, MethodFigures>;
  let countedTotal = new Decimal(0);
  let expectedTotal = new Decimal(0);
  for (const method of CASH_METHODS) {
    const expected = money(expectedByMethod[method]);
    const counted = money(countedByMethod[method]);
    if (counted.lt(0)) throw new Error(`El recuento de ${method} no puede ser negativo.`);
    countedTotal = countedTotal.plus(counted);
    expectedTotal = expectedTotal.plus(expected);
    byMethod[method] = { expected: expected.toFixed(2), counted: counted.toFixed(2), difference: counted.minus(expected).toFixed(2) };
  }
  return {
    byMethod,
    countedCash: byMethod.cash.counted as string,
    difference: byMethod.cash.difference as string,
    countedTotal: countedTotal.toFixed(2),
    expectedTotal: expectedTotal.toFixed(2)
  };
}
