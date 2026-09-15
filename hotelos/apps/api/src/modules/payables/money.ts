// Payables · money helpers (Finanzas 2026-09-15, lote proveedores-activos).
//
// Every amount of the payables and fixed-assets modules is a Prisma.Decimal
// (decimal.js bundled by the Prisma client). Floats never enter a computation:
// the HTTP layer parses numbers/strings into Decimal through `moneyInput`, the
// services round to 2 decimals PER LINE (ROUND_HALF_UP, the rounding the
// Spanish invoicing rules assume) and check the totals to the cent.

import { Prisma } from "@prisma/client";
import { z } from "zod";

export type Decimal = Prisma.Decimal;

export const ZERO: Decimal = new Prisma.Decimal(0);
export const HUNDRED: Decimal = new Prisma.Decimal(100);

/** Decimal from a Decimal / string / number (numbers go through String() so 0.1 stays "0.1"). */
export function dec(value: Decimal | string | number): Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(typeof value === "number" ? String(value) : value);
}

/** Round to the cent, half-up (2.345 → 2.35, 2.344 → 2.34). */
export function round2(value: Decimal | string | number): Decimal {
  return dec(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Canonical 2-decimal string of an amount ("1060.00"). */
export function money(value: Decimal | string | number): string {
  return round2(value).toFixed(2);
}

export function sum(values: Iterable<Decimal | string | number>): Decimal {
  let total = ZERO;
  for (const value of values) total = total.plus(dec(value));
  return total;
}

/** base × rate % rounded to the cent (the per-line VAT quota / retention rule). */
export function pct(base: Decimal | string | number, ratePct: Decimal | string | number): Decimal {
  return round2(dec(base).times(dec(ratePct)).div(HUNDRED));
}

export function isZero(value: Decimal | string | number): boolean {
  return dec(value).isZero();
}

/** True when the value has at most 2 decimals (an amount the API accepts as-is). */
export function hasCentScale(value: Decimal): boolean {
  return value.decimalPlaces() <= 2;
}

const MONEY_STRING = /^-?\d{1,13}(\.\d{1,6})?$/;

/**
 * zod input for a money amount: a finite number or a decimal string. The
 * parsed value is a Decimal with at most 2 decimals (more → 400 in Spanish).
 * `min` defaults to 0 (amounts are positive; the direction is the field).
 */
export function moneyInput(options: { min?: Decimal | string | number; allowZero?: boolean } = {}): z.ZodType<Decimal, z.ZodTypeDef, string | number> {
  const min = options.min === undefined ? ZERO : dec(options.min);
  const allowZero = options.allowZero ?? true;
  return z
    .union([z.number().finite(), z.string().regex(MONEY_STRING, "importe no válido")])
    .transform((raw, ctx) => {
      const value = dec(raw);
      if (!hasCentScale(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "el importe no puede tener más de 2 decimales" });
        return z.NEVER;
      }
      if (value.lt(min)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `el importe no puede ser inferior a ${min.toFixed(2)}` });
        return z.NEVER;
      }
      if (!allowZero && value.isZero()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "el importe no puede ser cero" });
        return z.NEVER;
      }
      return value;
    });
}

/** zod input for a percentage (0..100, up to 2 decimals) parsed as Decimal. */
export function percentInput(): z.ZodType<Decimal, z.ZodTypeDef, string | number> {
  return z
    .union([z.number().finite(), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "porcentaje no válido")])
    .transform((raw, ctx) => {
      const value = dec(raw);
      if (value.lt(ZERO) || value.gt(HUNDRED)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "el porcentaje debe estar entre 0 y 100" });
        return z.NEVER;
      }
      if (!hasCentScale(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "el porcentaje no puede tener más de 2 decimales" });
        return z.NEVER;
      }
      return value;
    });
}

// ---------------------------------------------------------------------------
// Calendar days (Prisma @db.Date columns receive/return UTC-midnight Dates)
// ---------------------------------------------------------------------------

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day in YYYY-MM-DD (2026-02-30 is rejected). */
export function isRealIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** zod input for a calendar day parsed to a UTC-midnight Date (what @db.Date expects). */
export function dayInput(): z.ZodType<Date, z.ZodTypeDef, string> {
  return z
    .string()
    .regex(ISO_DAY, "fecha no válida (AAAA-MM-DD)")
    .transform((raw, ctx) => {
      if (!isRealIsoDay(raw)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fecha inexistente" });
        return z.NEVER;
      }
      return new Date(`${raw}T00:00:00.000Z`);
    });
}

export function dayOf(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

export function utcDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Whole calendar days from `from` to `to` (both UTC-midnight); negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
