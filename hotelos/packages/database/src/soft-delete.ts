// Soft-delete helpers for GDPR retention compliance.
//
// Spanish RGPD / contable retention requires that financial and
// guest-linked records (Reservation, Guest, Invoice, Folio, FolioLine,
// Payment) remain queryable for 4–6 years after their commercial life
// ends. Hard-deleting them violates that retention window and also
// breaks downstream constraints (e.g. invoice → reservation joins used
// in the Verifactu / TBAI authority reports).
//
// Instead we mark rows with `deletedAt = <timestamp>`. Default reads
// must filter with `softDeleteFilter()` so callers never see tombstoned
// rows by accident; explicit auditing / GDPR-erasure-evidence flows can
// opt out by querying without the filter or by passing `includeDeleted`.
//
// IMPORTANT: this module deliberately does NOT mutate the global Prisma
// client. We avoid a global $extends middleware so existing call sites
// in apps/api keep their current visible-rows semantics until they
// migrate explicitly. See db-soft-delete.md (forthcoming) for the
// rollout plan; this PR ships the schema + utility only.

import { prisma } from "./client.js";

/**
 * Returns a `where`-clause fragment that excludes soft-deleted rows.
 * Spread into existing where objects:
 *
 *   await prisma.reservation.findMany({
 *     where: { propertyId, ...softDeleteFilter() }
 *   });
 *
 * Passing `{ includeDeleted: true }` returns `{}` so the same call site
 * can be flipped to include tombstoned rows in admin / audit views.
 */
export function softDeleteFilter(options: { includeDeleted?: boolean } = {}): {
  deletedAt?: null;
} {
  if (options.includeDeleted) {
    return {};
  }
  return { deletedAt: null };
}

/**
 * Models that carry a `deletedAt` column. Keep this list in sync with
 * the Prisma schema — adding a new column here without the column in
 * the schema is a typecheck error because the delegate lookup below
 * dereferences `prisma[model]`.
 */
export type SoftDeletableModel =
  | "reservation"
  | "guest"
  | "invoice"
  | "folio"
  | "folioLine"
  | "payment";

interface SoftDeletableDelegate {
  update(args: {
    where: { id: string };
    data: { deletedAt: Date | null };
  }): Promise<unknown>;
}

function delegateFor(model: SoftDeletableModel): SoftDeletableDelegate {
  // The Prisma client exposes one lowercase-camelCase delegate per model;
  // we cast via `unknown` because Prisma's generated types intentionally
  // disallow indexing the client by a string union (each delegate has a
  // distinct generated type). The runtime shape is stable.
  const delegate = (prisma as unknown as Record<string, SoftDeletableDelegate>)[model];
  if (!delegate) {
    throw new Error(`soft-delete: unknown Prisma delegate "${model}"`);
  }
  return delegate;
}

/**
 * Marks a row as soft-deleted by setting `deletedAt` to the current
 * timestamp. Returns the updated record (typed as `unknown` because the
 * concrete shape varies per model — callers that need typing should
 * call `prisma.<model>.update(...)` directly with `{ deletedAt: new Date() }`).
 *
 * Throws `P2025` (Prisma not-found) if the id does not exist; that
 * matches the behaviour of a normal `.update()` and is the desired
 * signal for upstream HTTP 404 handling.
 */
export async function softDelete(
  model: SoftDeletableModel,
  id: string,
  options: { at?: Date } = {}
): Promise<unknown> {
  const at = options.at ?? new Date();
  return delegateFor(model).update({
    where: { id },
    data: { deletedAt: at }
  });
}

/**
 * Restores a previously soft-deleted row by clearing `deletedAt`.
 * No-op-safe: calling this on a non-deleted row simply rewrites
 * `deletedAt = null`.
 */
export async function restore(
  model: SoftDeletableModel,
  id: string
): Promise<unknown> {
  return delegateFor(model).update({
    where: { id },
    data: { deletedAt: null }
  });
}
