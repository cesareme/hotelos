// Decimal helpers of the financial-statements module (Finanzas · lote
// usali-cuentas). Every amount is a Prisma.Decimal (decimal.js) until it is
// serialised as a MoneyString ("1234.56"); floats never enter a computation.

import { Prisma } from "@prisma/client";

export type Dec = Prisma.Decimal;

export const D = (value: Prisma.Decimal.Value = 0): Prisma.Decimal => new Prisma.Decimal(value);
export const ZERO: Prisma.Decimal = D(0);

/** Round half-up to cents. */
export function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** "1234.56" — two decimals, dot, no exponent, never "-0.00". */
export function money(value: Prisma.Decimal): string {
  const rounded = round2(value);
  if (rounded.isZero()) return "0.00";
  return rounded.toFixed(2);
}

export function sumDec(values: Iterable<Prisma.Decimal>): Prisma.Decimal {
  let total = ZERO;
  for (const value of values) total = total.plus(value);
  return total;
}

/** numerator / denominator with `places` decimals; null when the denominator is 0 (never a fake 0). */
export function ratio(numerator: Prisma.Decimal, denominator: Prisma.Decimal | number, places = 2): string | null {
  const den = D(denominator);
  if (den.isZero()) return null;
  const value = numerator.div(den).toDecimalPlaces(places, Prisma.Decimal.ROUND_HALF_UP);
  return value.isZero() ? (0).toFixed(places) : value.toFixed(places);
}

/** 100 × numerator / denominator with two decimals; null when the denominator is 0. */
export function pct(numerator: Prisma.Decimal, denominator: Prisma.Decimal | number): string | null {
  const den = D(denominator);
  if (den.isZero()) return null;
  return ratio(numerator.times(100), den, 2);
}

/** Parse a MoneyString / RatioString back to Decimal (snapshots, comparisons). */
export function fromMoney(value: string | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  return D(value);
}

/** Two amounts equal to the cent. */
export function sameCents(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return round2(a).minus(round2(b)).abs().lessThan("0.005");
}

/** "1234.56" → "1234,56" (Spanish decimal comma for CSV / ContaPlus). */
export function decimalComma(value: string): string {
  return value.replace(".", ",");
}

/** "YYYY-MM-DD" → "DD/MM/YYYY". */
export function spanishDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Normalises anything Prisma or raw SQL returns for a numeric column. */
export function toDec(value: Prisma.Decimal | number | string | bigint | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined) return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  return D(typeof value === "bigint" ? value.toString() : value);
}
