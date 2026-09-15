// Money helpers of the treasury / banking / commissions / payroll lot.
//
// Every amount that is added, multiplied or compared goes through
// Prisma.Decimal (decimal.js bundled with the Prisma client): never a float.
// Rounding is HALF_UP to 2 decimals per line; the caller squares the total to
// the cent (see `allocateProportional`).

import { Prisma } from "@prisma/client";

export type Dec = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

const ROUND = Prisma.Decimal.ROUND_HALF_UP;

/** Anything Prisma / JSON hands us (Decimal, string, number, null) → Decimal (null → 0). */
export function dec(value: unknown): Dec {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return new Decimal(0);
    return new Decimal(value.toString());
  }
  if (typeof value === "string") {
    const trimmed = value.trim().replace(",", ".");
    if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) return new Decimal(0);
    return new Decimal(trimmed);
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    return dec(String((value as { toString(): string }).toString()));
  }
  return new Decimal(0);
}

/** Strict parser for API bodies: throws on anything that is not a decimal literal. */
export function parseDecimal(value: unknown, what = "importe"): Dec {
  if (typeof value === "number" && Number.isFinite(value)) return new Decimal(value.toString());
  if (typeof value === "string" && /^[-+]?\d+([.,]\d+)?$/.test(value.trim())) return new Decimal(value.trim().replace(",", "."));
  throw new TypeError(`${what} no válido: ${String(value)}`);
}

export function round2(value: Dec): Dec {
  return value.toDecimalPlaces(2, ROUND);
}

export function zero(): Dec {
  return new Decimal(0);
}

export function sum(values: Iterable<Dec>): Dec {
  let total = new Decimal(0);
  for (const value of values) total = total.plus(value);
  return total;
}

/** Integer cents (CSB43 fields are 14-digit integers with 2 implied decimals). */
export function fromCents(cents: number | bigint | string): Dec {
  return new Decimal(cents.toString()).div(100);
}

export function toCents(value: Dec): number {
  return round2(value).mul(100).toNumber();
}

/** Wire representation: fixed 2 decimals, dot separator ("1234.50"). */
export function money(value: Dec | number | string | null | undefined): string {
  return round2(dec(value)).toFixed(2);
}

/** Wire representation for legacy consumers that expect numbers (dashboards). */
export function moneyNumber(value: Dec | number | string | null | undefined): number {
  return Number(money(value));
}

export function isZero(value: Dec): boolean {
  return round2(value).isZero();
}

/** |a − b| < 0.005 after rounding both to the cent. */
export function sameAmount(a: Dec, b: Dec): boolean {
  return round2(a).equals(round2(b));
}

/**
 * Split `total` proportionally to `weights`, rounding every share to the cent
 * and pushing the remainder onto the largest share so that the shares add up
 * to `total` exactly (never a cent lost, never a cent invented).
 */
export function allocateProportional(total: Dec, weights: Dec[]): Dec[] {
  if (weights.length === 0) return [];
  const weightSum = sum(weights);
  if (weightSum.isZero()) {
    const shares = weights.map(() => new Decimal(0));
    shares[0] = round2(total);
    return shares;
  }
  const shares = weights.map((w) => round2(total.mul(w).div(weightSum)));
  const diff = round2(total).minus(sum(shares));
  if (!diff.isZero()) {
    let idx = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i]!.abs().gt(shares[idx]!.abs())) idx = i;
    shares[idx] = shares[idx]!.plus(diff);
  }
  return shares;
}

/** `pct` percent of `base`, rounded to the cent (15 % of 100.00 → 15.00). */
export function percentOf(base: Dec, pct: Dec): Dec {
  return round2(base.mul(pct).div(100));
}

/** Calendar day (UTC midnight) for `@db.Date` columns. Accepts "YYYY-MM-DD", ISO strings or Dates. */
export function dayUtc(value: Date | string): Date {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`fecha no válida: ${value}`);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

export function daysBetween(later: Date, earlier: Date): number {
  return Math.round((dayUtc(later).getTime() - dayUtc(earlier).getTime()) / 86_400_000);
}
