// Rate grid v2 · change journal (history + revert).
//
//   GET  /properties/:id/rate-journal            → getRateJournal (cursor by timestamp+id)
//   GET  /properties/:id/rate-journal/:journalId → getRateJournalEntry (with items)
//   POST /properties/:id/rate-journal/:journalId/revert → revertRateJournal
//
// A revert is a NEW journal entry (status "published") whose patches are the
// `before` of every item of the original, applied through the same engine and
// transaction as bulk-update; the original is marked `reverted` +
// `revertedByJournalId` in that transaction. Items of derived plans are not
// replayed: reverting the parent re-materialises them (a child cell converted
// to manual in the original IS replayed, as its own before/after).
// Safety (api-fix, 2026-09-15): the inverse patches carry `expected` = the
// `after` the entry wrote, so a revert that would overwrite a LATER edit is a
// 409 JOURNAL_STALE (nothing written) unless the body says `force: true`;
// plans deactivated after the write stay revertible (`allowInactivePlan`);
// restrictions of a channel that no longer exists are reported, not 400.
// Wording (cierre 2026-09-15): the inverse entry reads «Reversión: <motivo
// original>[ — <texto del body>]» and links the reverted entry through
// `revertsJournalId` (changesJson.revertsJournalId, no extra column: the
// forward link is RateChangeJournal.revertedByJournalId); entries written
// with the old wording («Reversión de <id> (…)») are linked by parsing it.
// The arithmetic (coalescing, inverse patches, stale check, wording) is pure
// in journal.core.ts.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { RateChangeJournalEntry, RateChangeJournalItem, RateChangeJournalListResponse, RateGridBulkUpdateResponse, RateJournalRevertRequest } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, decodeCursor, parsePageQuery } from "../../lib/pagination.js";
import { requirePermissions } from "../auth/auth.service.js";
import { isoDate } from "./bulk-ops.js";
import { buildRevertPatches, normalizePushStatus, parseJournalCursorDate, readRevertsJournalId, revertReason } from "./journal.core.js";
import { executeRateGridWrite, loadPropertyCatalog, toWireResponse } from "./rate-grid.engine.js";
import { parseOr400, revertBodySchema } from "./rate-grid.schemas.js";

export { buildRevertPatches } from "./journal.core.js";

type JournalRow = {
  id: string;
  propertyId: string;
  userId: string;
  userEmail: string | null;
  timestamp: Date;
  changesCount: number;
  reason: string | null;
  pushedTo: string[];
  pushStatus: string;
  status: string;
  revertedByJournalId: string | null;
  changesJson: Prisma.JsonValue;
};

function toEntry(row: JournalRow): RateChangeJournalEntry {
  const status = row.status === "published" || row.status === "reverted" ? row.status : "draft";
  return {
    id: row.id,
    propertyId: row.propertyId,
    userId: row.userId,
    userEmail: row.userEmail ?? null,
    timestamp: row.timestamp.toISOString(),
    changesCount: row.changesCount,
    reason: row.reason ?? null,
    pushedTo: row.pushedTo ?? [],
    pushStatus: normalizePushStatus(row.pushStatus),
    status,
    revertedByJournalId: row.revertedByJournalId ?? null,
    revertsJournalId: readRevertsJournalId(row.changesJson, row.reason)
  };
}

function jsonOut(value: Prisma.JsonValue | null): unknown {
  return value === null || value === undefined ? null : value;
}

/** Newest first; cursor = (timestamp ISO, id). Uses the shared pagination helpers. */
export async function getRateJournal(input: { propertyId: string; limit?: number | string; cursor?: string | null }): Promise<RateChangeJournalListResponse> {
  const page = parsePageQuery({ limit: input.limit, cursor: input.cursor ?? undefined }, { limit: 50, max: 200 });
  const key = decodeCursor(page.cursor);
  const at = parseJournalCursorDate(key);
  const where: Prisma.RateChangeJournalWhereInput = {
    propertyId: input.propertyId,
    ...(key && at
      ? {
          OR: [{ timestamp: { lt: at } }, { timestamp: at, id: { lt: key.id } }]
        }
      : {})
  };
  const [rows, total] = await Promise.all([
    prisma.rateChangeJournal.findMany({ where, orderBy: [{ timestamp: "desc" }, { id: "desc" }], take: page.limit + 1 }),
    prisma.rateChangeJournal.count({ where: { propertyId: input.propertyId } })
  ]);
  const built = buildPage(rows, page.limit, total, (row) => row.timestamp.toISOString());
  return { items: built.items.map(toEntry), nextCursor: built.nextCursor };
}

export async function getRateJournalEntry(input: { propertyId: string; journalId: string }): Promise<RateChangeJournalEntry> {
  const row = await prisma.rateChangeJournal.findFirst({
    where: { id: input.journalId, propertyId: input.propertyId },
    // `id` last: cuids are monotonic within a write, so two items of the same
    // (cell, field) — entries older than the coalescing — come in insertion order.
    include: { items: { orderBy: [{ roomTypeId: "asc" }, { ratePlanId: "asc" }, { date: "asc" }, { field: "asc" }, { id: "asc" }] } }
  });
  if (!row) throw new NotFoundError("Entrada del historial de tarifas no encontrada.");
  const items: RateChangeJournalItem[] = row.items.map((i) => ({
    ratePlanId: i.ratePlanId,
    roomTypeId: i.roomTypeId,
    date: isoDate(i.date),
    channelId: i.channelId ?? null,
    field: i.field,
    before: jsonOut(i.beforeJson),
    after: jsonOut(i.afterJson)
  }));
  return { ...toEntry(row), items };
}

export async function revertRateJournal(input: {
  propertyId: string;
  journalId: string;
  context: UserContext;
  correlationId?: string;
  /** Wire body (RateJournalRevertRequest): `force` overwrites cells changed after the entry. */
  body?: RateJournalRevertRequest | null;
}): Promise<RateGridBulkUpdateResponse> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const body = parseOr400(revertBodySchema, input.body ?? {}, "revert");
  const original = await getRateJournalEntry({ propertyId: input.propertyId, journalId: input.journalId });
  if (original.status === "reverted") {
    throw new ConflictError("La entrada ya fue revertida.", { code: "JOURNAL_ALREADY_REVERTED", revertedByJournalId: original.revertedByJournalId ?? null });
  }
  const catalog = await loadPropertyCatalog(input.propertyId);
  const derivedPlanIds = new Set([...catalog.plans, ...catalog.inactivePlanById.values()].filter((p) => p.parentRatePlanId).map((p) => p.id));
  const items = original.items ?? [];
  // A channel deleted after the write (hard delete) cannot receive its
  // restrictions back: report it instead of failing the whole revert with 400.
  const warnings: string[] = [];
  const revertible = items.filter((i) => {
    if (i.channelId && !catalog.channelIds.has(i.channelId)) {
      warnings.push(`restricciones del canal ${i.channelId} (${i.roomTypeId} ${i.date}) no revertidas: el canal ya no existe`);
      return false;
    }
    return true;
  });
  const patches = buildRevertPatches(revertible, derivedPlanIds, { withExpected: !body.force }).map((p) => ({ ...p, allowInactivePlan: true }));
  if (items.length > 0 && patches.some((p) => p.restrictions)) {
    requirePermissions(input.context, ["revenue.manage_restrictions"]);
  }
  const result = await executeRateGridWrite({
    catalog,
    context: input.context,
    patches,
    reason: revertReason(original.reason, body.reason),
    revertsJournalId: original.id,
    status: "published",
    correlationId: input.correlationId,
    auditAction: "RATE_GRID_REVERTED",
    warnings: warnings.length > 0 ? warnings : undefined,
    // Nothing applied → 409 (the original stays revertible) instead of an
    // empty inverse entry that marks it reverted without restoring anything.
    conflictIfAllFail: true,
    staleMode: body.force ? "conflict" : "abort",
    afterJournal: async (tx, inverseId) => {
      // Guard against a concurrent revert of the same entry inside the transaction.
      const marked = await tx.rateChangeJournal.updateMany({
        where: { id: original.id, propertyId: input.propertyId, status: { not: "reverted" } },
        data: { status: "reverted", revertedByJournalId: inverseId }
      });
      if (marked.count === 0) throw new ConflictError("La entrada ya fue revertida.", { code: "JOURNAL_ALREADY_REVERTED" });
    }
  });
  return toWireResponse(result);
}
