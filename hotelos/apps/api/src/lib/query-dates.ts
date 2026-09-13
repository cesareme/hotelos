// Query-string date validation shared by report endpoints (accounting
// reports, tourist-tax applications). A missing or malformed date used to
// reach Prisma as `Invalid Date` and surface as an HTTP 500; these helpers
// turn it into a 400 with a Spanish message before any DB call runs.

import { BadRequestError } from "./http-error.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that denotes a real calendar day. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Returns the value when it is a valid `YYYY-MM-DD`; otherwise throws 400 naming the parameter. */
export function requireIsoDate(value: unknown, name: string): string {
  if (value === undefined || value === null || value === "") {
    throw new BadRequestError(`El parámetro ${name} es obligatorio (formato YYYY-MM-DD).`);
  }
  if (!isIsoDate(value)) {
    throw new BadRequestError(`El parámetro ${name} no es una fecha válida (formato YYYY-MM-DD).`);
  }
  return value;
}

/**
 * Validates a `fromDate`/`toDate` pair. `strict` (default, the accounting
 * reports' historical rule) requires fromDate < toDate; `strict: false`
 * accepts a same-day period (tourist-tax applications).
 */
export function requireDateRange(
  fromDate: unknown,
  toDate: unknown,
  options: { strict?: boolean } = {}
): { fromDate: string; toDate: string } {
  const from = requireIsoDate(fromDate, "fromDate");
  const to = requireIsoDate(toDate, "toDate");
  const strict = options.strict ?? true;
  if (strict ? from >= to : from > to) {
    throw new BadRequestError(
      strict ? "fromDate debe ser anterior a toDate." : "fromDate no puede ser posterior a toDate."
    );
  }
  return { fromDate: from, toDate: to };
}

/** Validates a fiscal year (integer 2000–2100); accepts the number a route already coerced with Number(). */
export function requireYear(value: unknown): number {
  const year = typeof value === "string" ? Number(value) : value;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new BadRequestError("El parámetro year es obligatorio (año de cuatro cifras, p. ej. 2026).");
  }
  return year;
}
