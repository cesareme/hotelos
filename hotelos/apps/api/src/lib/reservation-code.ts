// Reservation code allocator (T4 regression fix).
//
// Reservation codes are unique per property (`@@unique([propertyId, code])`)
// and were generated as `RES-${count + 1}`. Any gap in the sequence (deleted
// rows, a refreshed demo dataset, a manual insert) makes `count + 1` collide
// with an existing code — deterministically and forever, since the count only
// grows once a row does get inserted. The allocator below derives the next
// code from the MAX numeric suffix already present instead, serialised per
// (property, prefix) with a transactional advisory lock so two concurrent
// bookings cannot compute the same maximum (same pattern as the VeriFactu
// chain lock in invoice.service.ts).

// Value import (not the type-only re-export of @hotelos/database): `Prisma.sql`
// is needed to build the parameterised query. Same generated client as the
// database package — a single @prisma/client copy in the pnpm store.
import { Prisma } from "@prisma/client";
import { ConflictError } from "./http-error.js";

/** Default prefix for regular (non-group) reservations. */
export const DEFAULT_RESERVATION_PREFIX = "RES";
/** Default zero-padding of the numeric suffix (`RES-00042`). */
export const DEFAULT_RESERVATION_PAD = 5;
/** Attempts before giving up when the unique index still rejects the code. */
export const RESERVATION_CODE_ATTEMPTS = 3;

/**
 * Escape a literal so it can be embedded in a Postgres (ARE) / JS regular
 * expression. Group codes are free text (`AUDIT-T4.REG+1`), so the prefix
 * must never be interpolated raw into the pattern.
 */
export function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/**
 * Regex (as a string, usable both by Postgres `~` / `substring(... from ...)`
 * and by `new RegExp`) matching `<prefix>-<digits>` and capturing the digits.
 */
export function suffixPattern(prefix: string): string {
  return `^${escapeRegex(prefix)}-([0-9]+)$`;
}

/**
 * `prefix-NNNNN`: zero-padded to `pad` digits but never truncated — once the
 * sequence passes 10^pad the suffix simply grows (`RES-100000`).
 */
export function formatReservationCode(prefix: string, n: number, pad = DEFAULT_RESERVATION_PAD): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`Reservation code suffix must be a non-negative integer, got ${String(n)}`);
  }
  return `${prefix}-${String(n).padStart(pad, "0")}`;
}

/**
 * Pure counterpart of the SQL aggregate in `allocateReservationCode`: the
 * highest numeric suffix among `codes` that match `<prefix>-<digits>`, or 0
 * when none does. Codes with other prefixes (or a non-numeric suffix) are
 * ignored, exactly like the `code ~ pattern` filter does in the database.
 */
export function maxSuffixOf(codes: Iterable<string>, prefix: string): number {
  const re = new RegExp(suffixPattern(prefix));
  let max = 0;
  for (const code of codes) {
    const m = re.exec(code);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

/** Advisory-lock key: one lock per (property, prefix) sequence. */
export function reservationCodeLockKey(propertyId: string, prefix: string): string {
  return `${propertyId}:reservation-code:${prefix}`;
}

// Prisma deserialises Postgres `bigint` as a JS BigInt and `int` as a number;
// accept both (plus the string form some drivers emit) so the aggregate cast
// below can be widened without touching the caller.
function toSafeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint" || typeof value === "string") {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error(`Unexpected reservation-code aggregate value: ${String(value)}`);
}

/**
 * Allocate the next free reservation code for `propertyId` INSIDE the
 * caller's interactive transaction. Takes `pg_advisory_xact_lock` keyed by
 * (property, prefix) — released automatically at COMMIT/ROLLBACK — then
 * returns `prefix-<max existing suffix + 1>`. The lock is what makes the
 * MAX+1 safe under concurrency: a parallel allocation for the same sequence
 * blocks until this transaction (and its INSERT) has ended.
 *
 * `reservations` is the mapped table of `model Reservation`; `property_id`
 * and `code` its mapped columns. The regexp is passed as a bind parameter
 * (prefix escaped), never interpolated as SQL text.
 */
export async function allocateReservationCode(
  tx: Prisma.TransactionClient,
  propertyId: string,
  prefix: string = DEFAULT_RESERVATION_PREFIX,
  pad: number = DEFAULT_RESERVATION_PAD
): Promise<string> {
  const lockKey = reservationCodeLockKey(propertyId, prefix);
  // Prisma ≥6.19 cannot deserialise the `void` returned by
  // pg_advisory_xact_lock through $queryRaw → $executeRaw (no row decoding).
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const pattern = suffixPattern(prefix);
  // `substring(code from pattern)` returns the first capture group (the digits).
  // Cast to bigint so a runaway sequence (> 2^31) cannot break allocation.
  const rows = await tx.$queryRaw<Array<{ max: unknown }>>(
    Prisma.sql`
      SELECT COALESCE(MAX((substring(code from ${pattern}))::bigint), 0) AS max
      FROM reservations
      WHERE property_id = ${propertyId}
        AND code ~ ${pattern}
    `
  );
  const current = toSafeNumber(rows[0]?.max ?? 0);
  return formatReservationCode(prefix, current + 1, pad);
}

/**
 * True when `error` is Prisma's P2002 (unique violation) on a constraint that
 * involves the `code` column — i.e. the reservation-code index, not some
 * unrelated unique (guest email, folio number…). Postgres reports the
 * constraint columns in `meta.target` (array of column names, occasionally a
 * single string).
 */
export function isReservationCodeConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => typeof t === "string" && t === "code");
  // Constraint names join columns with `_` (reservations_property_id_code_key),
  // which `\b` treats as a word char — split on anything non-alphanumeric.
  if (typeof target === "string") return /(^|[^A-Za-z0-9])code(?![A-Za-z0-9])/.test(target);
  // No metadata at all: cannot prove it is another index — treat as ours so
  // the safety net retries rather than surfacing a raw Prisma message.
  return true;
}

/**
 * Safety net around a transaction that allocates a reservation code: if,
 * despite the advisory lock, the unique index on (property_id, code) still
 * rejects the INSERT (e.g. a code inserted out-of-band with the same suffix
 * between our SELECT and INSERT by a session that did not take the lock),
 * re-run the whole transaction up to `attempts` times; on the last failure
 * surface a typed 409 with a Spanish message instead of Prisma's invocation
 * dump. Any other error propagates untouched on the first occurrence.
 */
export async function withReservationCodeRetry<T>(
  run: (attempt: number) => Promise<T>,
  attempts: number = RESERVATION_CODE_ATTEMPTS
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be a positive integer, got ${String(attempts)}`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!isReservationCodeConflict(error)) throw error;
      lastError = error;
    }
  }
  const conflict = new ConflictError(
    "No se pudo asignar un código de reserva único tras varios intentos. Vuelve a intentarlo.",
    { code: "RESERVATION_CODE_CONFLICT", attempts }
  );
  // Keep the original Prisma error reachable for logs (never serialised on
  // the 4xx body — only `message` and `details` are exposed).
  (conflict as Error & { cause?: unknown }).cause = lastError;
  throw conflict;
}
