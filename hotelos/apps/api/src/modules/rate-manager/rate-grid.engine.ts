// Rate grid v2 · write engine (ONE transaction per request).
//
// Every write path of the grid — bulk-update, journal revert, rederive of a
// derived plan, restriction patches from recommendations — ends up here:
//   1. validate that every id in the patches belongs to the property (400 with
//      details — the global tenancy hook only checks the property itself);
//   2. inside `prisma.$transaction`, read the current state of the touched
//      cells, apply the patches (RateDay / RestrictionDay / InventoryDay),
//      re-materialise derived children, and collect before/after per field;
//   3. write the RateChangeJournal + RateChangeJournalItem rows in the SAME
//      transaction, so a journal without its cells (or cells without journal)
//      cannot exist.
// Rules of the model (rate grid v2, see packages/shared/src/rate-manager-types.ts):
//   · a patch that carries only restrictions NEVER creates a RateDay (no fake 0);
//   · a derived plan is read-only: a direct price write is a conflict unless
//     `convertToManual`; `revertToDerived` drops the override;
//   · when a parent price changes, its derived children are re-materialised,
//     keeping the children's manual cells (`skippedManual`) unless the caller
//     set `respectManualOverrides: false`;
//   · a derivation that yields ≤ 0 € never materialises (the child row is
//     removed if it was derived) and is reported as a conflict — no fake 0;
//   · `manuallyOverridden` is the override flag of a DERIVED plan's cell: a
//     base-plan write keeps the flag it finds (it means nothing there);
//   · journal items are coalesced per (cell, field): first `before`, last
//     `after` (ops + cells on the same cell used to leave two items and the
//     revert restored the intermediate value).
// Concurrency (api-fix, 2026-09-15): the transaction takes a per-property
// advisory lock (`pg_advisory_xact_lock`) before reading, so two writes on the
// same property serialise (correct `before` in both journals) and a retried
// `clientRequestId` cannot slip past the idempotency check; a patch may carry
// `expected` (what the caller saw) and is skipped as a conflict when the cell
// changed meanwhile (`staleMode: "abort"` turns that into 409 JOURNAL_STALE).
// Idempotency (cierre 2026-09-15): a repeated `clientRequestId` answers the
// stored response flagged `replayed` (the service skips the publish and never
// puts the flag on the wire); the DB unique (propertyId, clientRequestId) is
// the belt to the lock's braces — a P2002 there re-reads the winner's entry.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type { RateCellSource, RateGridBulkUpdateResponse, RateGridCellPatch, RatePlanDerivation, RateRestrictions } from "@hotelos/shared";
import { RATE_RESTRICTION_KEYS } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { STAR, cellKey, dayUtc, isoDate } from "./bulk-ops.js";
import { applyDerivation, parseDerivation, round2 } from "./derivation.js";
import { coalesceJournalItems, sameJson, staleFields, staleReason, withIdempotentReplay, type StaleField } from "./journal.core.js";
import {
  EMPTY_RESTRICTION_COLUMNS,
  columnsToRestrictions,
  isEmptyRestrictionRow,
  mergeRestrictionPatch,
  type RestrictionColumns
} from "./rate-grid.merge.js";

type Tx = Prisma.TransactionClient;

export { STAR };

export type PlanInfo = {
  id: string;
  code: string;
  name: string;
  ratePlanType: string;
  mealPlan: string | null;
  parentRatePlanId: string | null;
  derivation: RatePlanDerivation;
  active: boolean;
};

export type RoomTypeInfo = {
  id: string;
  code: string;
  name: string;
  rooms: number;
  baseCapacity: number | null;
  maxOccupancy: number | null;
  sortOrder: number;
};

/** Catalogue of the property the engine (and the grid read) validates against. */
export type PropertyCatalog = {
  propertyId: string;
  organizationId: string;
  currency: string;
  roomTypes: RoomTypeInfo[];
  /** Active plans, sorted by code. */
  plans: PlanInfo[];
  /** Active plans by id (what the grid shows and bulk-update accepts). */
  planById: Map<string, PlanInfo>;
  /**
   * Soft-deleted plans (DELETE /rate-plans is `active: false`). Only a journal
   * revert may write their cells (`allowInactivePlan`), so an entry stays
   * revertible after the plan was deactivated; any other write answers 400
   * INACTIVE_RATE_PLANS instead of the misleading «no pertenecen».
   */
  inactivePlanById: Map<string, PlanInfo>;
  /** Active children per parent id. */
  childrenOf: Map<string, PlanInfo[]>;
  channelIds: Set<string>;
};

export async function loadPropertyCatalog(propertyId: string): Promise<PropertyCatalog> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, currency: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const [roomTypes, roomCounts, plans, channels] = await Promise.all([
    prisma.roomType.findMany({
      where: { propertyId, active: true },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true, baseCapacity: true, maxOccupancy: true, displayOrder: true }
    }),
    prisma.room.groupBy({ by: ["roomTypeId"], where: { propertyId, sellable: true, active: true }, _count: { _all: true } }),
    prisma.ratePlan.findMany({ where: { propertyId }, orderBy: { code: "asc" } }),
    prisma.channel.findMany({ where: { propertyId }, select: { id: true } })
  ]);
  const roomsByType = new Map(roomCounts.map((r) => [r.roomTypeId, r._count._all]));
  const allPlans: PlanInfo[] = plans.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    ratePlanType: p.ratePlanType,
    mealPlan: p.mealPlan ?? null,
    parentRatePlanId: p.parentRatePlanId ?? null,
    derivation: parseDerivation(p.derivationJson),
    active: p.active
  }));
  const planInfos = allPlans.filter((p) => p.active);
  const childrenOf = new Map<string, PlanInfo[]>();
  for (const p of planInfos) {
    if (!p.parentRatePlanId) continue;
    const list = childrenOf.get(p.parentRatePlanId) ?? [];
    list.push(p);
    childrenOf.set(p.parentRatePlanId, list);
  }
  return {
    propertyId,
    organizationId: property.organizationId,
    currency: property.currency || "EUR",
    roomTypes: roomTypes.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      rooms: roomsByType.get(t.id) ?? 0,
      baseCapacity: t.baseCapacity ?? null,
      maxOccupancy: t.maxOccupancy ?? null,
      sortOrder: t.displayOrder
    })),
    plans: planInfos,
    planById: new Map(planInfos.map((p) => [p.id, p])),
    inactivePlanById: new Map(allPlans.filter((p) => !p.active).map((p) => [p.id, p])),
    childrenOf,
    channelIds: new Set(channels.map((c) => c.id))
  };
}

/**
 * 400 with the unknown ids listed in `details` (never a silent no-op). A plan
 * of the property that is INACTIVE is a different 400 (`INACTIVE_RATE_PLANS`,
 * «reactívalo») unless the patch is a journal revert (`allowInactivePlan`).
 */
export function assertPatchIdsBelong(
  catalog: PropertyCatalog,
  patches: Array<Pick<EnginePatch, "ratePlanId" | "roomTypeId" | "channelId" | "allowInactivePlan">>
): void {
  const roomTypeIds = new Set(catalog.roomTypes.map((t) => t.id));
  const badPlans = new Set<string>();
  const inactivePlans = new Set<string>();
  const badTypes = new Set<string>();
  const badChannels = new Set<string>();
  for (const p of patches) {
    if (p.ratePlanId !== STAR && !catalog.planById.has(p.ratePlanId)) {
      if (catalog.inactivePlanById.has(p.ratePlanId)) {
        if (!p.allowInactivePlan) inactivePlans.add(p.ratePlanId);
      } else {
        badPlans.add(p.ratePlanId);
      }
    }
    if (!roomTypeIds.has(p.roomTypeId)) badTypes.add(p.roomTypeId);
    if (p.channelId && !catalog.channelIds.has(p.channelId)) badChannels.add(p.channelId);
  }
  if (badPlans.size + badTypes.size + badChannels.size > 0) {
    const error = new BadRequestError("Alguna celda referencia planes, tipos de habitación o canales que no pertenecen a la propiedad.");
    error.details = {
      code: "UNKNOWN_IDS",
      ratePlanIds: [...badPlans].slice(0, 20),
      roomTypeIds: [...badTypes].slice(0, 20),
      channelIds: [...badChannels].slice(0, 20)
    };
    throw error;
  }
  if (inactivePlans.size > 0) {
    const codes = [...inactivePlans].map((id) => catalog.inactivePlanById.get(id)?.code ?? id);
    const error = new BadRequestError(`Alguna celda referencia planes tarifarios inactivos (${codes.slice(0, 5).join(", ")}): reactívalos para editar sus celdas.`);
    error.details = { code: "INACTIVE_RATE_PLANS", ratePlanIds: [...inactivePlans].slice(0, 20) };
    throw error;
  }
}

// ---- engine ----------------------------------------------------------------

/**
 * What the caller saw before writing (optimistic concurrency). The wire only
 * exposes `price` + `lastModifiedAt` (RateGridCellPatch.expected); the journal
 * revert fills every field it is about to restore with the `after` it wrote.
 * A mismatch skips the patch as a conflict «la celda cambió desde que se cargó:
 * precio actual 92,00 € (esperado 91,46 €)…» (journal.core.ts#staleReason).
 */
export type ExpectedCellState = {
  price?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  occupancyPrices?: Record<string, number> | null;
  source?: string | null;
  available?: number | null;
  /** Wire restriction values per key (null = unset). */
  restrictions?: Partial<Record<keyof RateRestrictions, unknown>>;
  lastModifiedAt?: string | null;
};

/** Internal patch: the wire patch plus the engine-only fields (rederive trigger, revert hints). */
export type EnginePatch = Omit<RateGridCellPatch, "expected"> & {
  expected?: ExpectedCellState;
  /** Re-materialise the children of this (parent) cell from its current price; `onlyChildIds` narrows it. */
  rematerializeOnly?: boolean;
  onlyChildIds?: string[];
  /** Revert only: provenance to restore instead of "manual" (a reverted import/rms cell keeps its origin). */
  restoreSource?: RateCellSource;
  /** Revert only: the plan may be inactive (soft-deleted after the original write). */
  allowInactivePlan?: boolean;
};

export type JournalItemDraft = {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  channelId: string | null;
  field: string;
  before: unknown;
  after: unknown;
};

export type EngineOutcome = {
  updated: number;
  derivedUpdated: number;
  skippedManual: number;
  conflicts: Array<{ ratePlanId: string; roomTypeId: string; date: string; reason: string }>;
  /** Patches skipped because their `expected` no longer matched (also listed in `conflicts`). */
  stale: Array<{ ratePlanId: string; roomTypeId: string; date: string; channelId: string | null; fields: StaleField[] }>;
  items: JournalItemDraft[];
};

type RateRow = {
  price: number;
  minPrice: number | null;
  maxPrice: number | null;
  occupancyPrices: Record<string, number> | null;
  source: string;
  manuallyOverridden: boolean;
  /** RateDay.updatedAt as read; null once rewritten in this transaction. */
  updatedAt: Date | null;
};

function dec(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

function occupancyOf(raw: Prisma.JsonValue | null | undefined): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number") out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

function restrictionKey(roomTypeId: string, ratePlanId: string, channelId: string, date: string): string {
  return `${roomTypeId}|${ratePlanId}|${channelId}|${date}`;
}

/**
 * Apply the patches inside `tx`. Reads the touched rows once (superset by
 * date range × plans × types), then writes row by row keeping the in-memory
 * maps current so later patches (and child materialisation) see prior writes.
 */
export async function applyPatchesInTx(
  tx: Tx,
  catalog: PropertyCatalog,
  patches: EnginePatch[],
  actor: { userId: string }
): Promise<EngineOutcome> {
  const outcome: EngineOutcome = { updated: 0, derivedUpdated: 0, skippedManual: 0, conflicts: [], stale: [], items: [] };
  if (patches.length === 0) return outcome;
  const { propertyId } = catalog;
  const planOf = (patch: EnginePatch): PlanInfo | null =>
    patch.ratePlanId === STAR ? null : catalog.planById.get(patch.ratePlanId) ?? (patch.allowInactivePlan ? catalog.inactivePlanById.get(patch.ratePlanId) : undefined) ?? null;

  // ---- 1. read the current state of everything the patches may touch --------
  const dates = patches.map((p) => p.date).sort();
  const minDate = dayUtc(dates[0]!);
  const maxDate = dayUtc(dates[dates.length - 1]!);
  const planIds = new Set<string>();
  for (const p of patches) {
    if (p.ratePlanId !== STAR) planIds.add(p.ratePlanId);
    const plan = planOf(p);
    if (plan?.parentRatePlanId) planIds.add(plan.parentRatePlanId);
    for (const child of catalog.childrenOf.get(p.ratePlanId) ?? []) planIds.add(child.id);
  }
  const roomTypeIds = [...new Set(patches.map((p) => p.roomTypeId))];
  const dateFilter = { gte: minDate, lte: maxDate };

  const [rateRows, restrictionRows, inventoryRows] = await Promise.all([
    tx.rateDay.findMany({ where: { propertyId, date: dateFilter, ratePlanId: { in: [...planIds] }, roomTypeId: { in: roomTypeIds } } }),
    tx.restrictionDay.findMany({ where: { propertyId, date: dateFilter, roomTypeId: { in: roomTypeIds } } }),
    tx.inventoryDay.findMany({ where: { propertyId, date: dateFilter, roomTypeId: { in: roomTypeIds } } })
  ]);
  const rates = new Map<string, RateRow>();
  for (const r of rateRows) {
    rates.set(cellKey(r.ratePlanId, r.roomTypeId, isoDate(r.date)), {
      price: Number(r.price),
      minPrice: dec(r.minPrice),
      maxPrice: dec(r.maxPrice),
      occupancyPrices: occupancyOf(r.occupancyPricesJson),
      source: r.source,
      manuallyOverridden: r.manuallyOverridden,
      updatedAt: r.updatedAt
    });
  }
  const restrictions = new Map<string, RestrictionColumns>();
  for (const r of restrictionRows) {
    restrictions.set(restrictionKey(r.roomTypeId, r.ratePlanId, r.channelId, isoDate(r.date)), {
      minStay: r.minStay,
      maxStay: r.maxStay,
      minStayThrough: r.minStayThrough,
      closedToArrival: r.closedToArrival,
      closedToDeparture: r.closedToDeparture,
      closed: r.closed,
      stopSell: r.stopSell,
      minAdvanceDays: r.minAdvanceDays,
      maxAdvanceDays: r.maxAdvanceDays
    });
  }
  const inventory = new Map<string, { totalInventory: number; availableCount: number }>();
  for (const r of inventoryRows) inventory.set(`${r.roomTypeId}|${isoDate(r.date)}`, { totalInventory: r.totalInventory, availableCount: r.availableCount });
  const roomsOfType = new Map(catalog.roomTypes.map((t) => [t.id, t.rooms]));

  // ---- 1b. optimistic concurrency: compare `expected` with the state BEFORE any write --
  // Checked up front (not patch by patch) so a parent's re-materialisation
  // applied earlier in the same request cannot make a child patch look stale.
  const applicable: EnginePatch[] = [];
  for (const patch of patches) {
    if (!patch.expected) {
      applicable.push(patch);
      continue;
    }
    const row = patch.ratePlanId === STAR ? undefined : rates.get(cellKey(patch.ratePlanId, patch.roomTypeId, patch.date));
    const stale = staleFields(patch.expected, {
      rate: row ? { price: row.price, minPrice: row.minPrice, maxPrice: row.maxPrice, occupancyPrices: row.occupancyPrices, source: row.source, updatedAt: row.updatedAt } : null,
      available: inventory.get(`${patch.roomTypeId}|${patch.date}`)?.availableCount ?? null,
      restrictions: columnsToRestrictions(restrictions.get(restrictionKey(patch.roomTypeId, patch.ratePlanId, patch.channelId ?? STAR, patch.date)) ?? EMPTY_RESTRICTION_COLUMNS)
    });
    if (stale.length === 0) {
      applicable.push(patch);
      continue;
    }
    outcome.stale.push({ ratePlanId: patch.ratePlanId, roomTypeId: patch.roomTypeId, date: patch.date, channelId: patch.channelId ?? null, fields: stale });
    outcome.conflicts.push({ ratePlanId: patch.ratePlanId, roomTypeId: patch.roomTypeId, date: patch.date, reason: staleReason(stale, catalog.currency) });
  }

  // ---- 2. helpers --------------------------------------------------------------
  const item = (p: { ratePlanId: string; roomTypeId: string; date: string }, channelId: string | null, field: string, before: unknown, after: unknown) =>
    outcome.items.push({ ratePlanId: p.ratePlanId, roomTypeId: p.roomTypeId, date: p.date, channelId, field, before: before ?? null, after: after ?? null });

  const writeRate = async (
    cell: { ratePlanId: string; roomTypeId: string; date: string },
    next: RateRow
  ): Promise<void> => {
    const key = cellKey(cell.ratePlanId, cell.roomTypeId, cell.date);
    const data = {
      price: next.price,
      currency: catalog.currency,
      minPrice: next.minPrice,
      maxPrice: next.maxPrice,
      occupancyPricesJson: next.occupancyPrices === null ? Prisma.DbNull : (next.occupancyPrices as Prisma.InputJsonValue),
      source: next.source,
      manuallyOverridden: next.manuallyOverridden,
      updatedBy: actor.userId
    };
    await tx.rateDay.upsert({
      where: { propertyId_ratePlanId_roomTypeId_date: { propertyId, ratePlanId: cell.ratePlanId, roomTypeId: cell.roomTypeId, date: dayUtc(cell.date) } },
      create: { propertyId, ratePlanId: cell.ratePlanId, roomTypeId: cell.roomTypeId, date: dayUtc(cell.date), ...data },
      update: data
    });
    rates.set(key, { ...next, updatedAt: null });
  };

  const deleteRate = async (cell: { ratePlanId: string; roomTypeId: string; date: string }): Promise<void> => {
    await tx.rateDay.deleteMany({ where: { propertyId, ratePlanId: cell.ratePlanId, roomTypeId: cell.roomTypeId, date: dayUtc(cell.date) } });
    rates.delete(cellKey(cell.ratePlanId, cell.roomTypeId, cell.date));
  };

  /** Re-materialise the derived children of a parent cell from `parentPrice` (null = parent removed). */
  const materializeChildren = async (
    parent: PlanInfo,
    roomTypeId: string,
    date: string,
    parentPrice: number | null,
    respectManual: boolean,
    onlyChildIds?: string[]
  ): Promise<void> => {
    for (const child of catalog.childrenOf.get(parent.id) ?? []) {
      if (onlyChildIds && !onlyChildIds.includes(child.id)) continue;
      const cell = { ratePlanId: child.id, roomTypeId, date };
      const existing = rates.get(cellKey(child.id, roomTypeId, date));
      if (existing?.manuallyOverridden && respectManual) {
        outcome.skippedManual += 1;
        continue;
      }
      // Field "derivedPrice" (not "price"): the history shows it as automatic and
      // a revert never replays it — reverting the parent re-materialises the child.
      if (parentPrice === null) {
        if (existing) {
          item(cell, null, "derivedPrice", existing.price, null);
          await deleteRate(cell);
          outcome.derivedUpdated += 1;
        }
        continue;
      }
      const derived = applyDerivation(parentPrice, child.derivation);
      if (derived <= 0) {
        // A rule that yields 0 € (amount below the parent's price, −100 %…) must
        // never reach a channel: the derived row is removed (a manual one is kept)
        // and the caller sees why in `conflicts[]`.
        outcome.conflicts.push({
          ...cell,
          reason: `la derivación de ${child.code} produce 0 € desde ${parentPrice} € (${describeDerivation(child.derivation)}): revisa la regla del plan; celda sin tarifa`
        });
        if (existing && !existing.manuallyOverridden) {
          item(cell, null, "derivedPrice", existing.price, null);
          await deleteRate(cell);
          outcome.derivedUpdated += 1;
        }
        continue;
      }
      if (existing && existing.price === derived && existing.source === "derived" && !existing.manuallyOverridden) continue;
      if (existing?.manuallyOverridden) {
        // Overwriting a manual override (`respectManualOverrides: false`) is a
        // user decision, so it is journaled as "price" + "source" (not the
        // automatic "derivedPrice"): reverting the entry restores the override.
        if (existing.price !== derived) item(cell, null, "price", existing.price, derived);
        if (existing.source !== "derived") item(cell, null, "source", existing.source, "derived");
      } else {
        item(cell, null, "derivedPrice", existing?.price ?? null, derived);
      }
      await writeRate(cell, {
        price: derived,
        minPrice: existing?.minPrice ?? null,
        maxPrice: existing?.maxPrice ?? null,
        occupancyPrices: existing?.occupancyPrices ?? null,
        source: "derived",
        manuallyOverridden: false,
        updatedAt: null
      });
      outcome.derivedUpdated += 1;
    }
  };

  // ---- 3. apply patch by patch --------------------------------------------------
  for (const patch of applicable) {
    const plan = planOf(patch);
    if (patch.ratePlanId !== STAR && !plan) {
      outcome.conflicts.push({ ratePlanId: patch.ratePlanId, roomTypeId: patch.roomTypeId, date: patch.date, reason: "plan tarifario inactivo o inexistente" });
      continue;
    }
    const cell = { ratePlanId: patch.ratePlanId, roomTypeId: patch.roomTypeId, date: patch.date };
    const key = cellKey(patch.ratePlanId, patch.roomTypeId, patch.date);
    const respectManual = patch.respectManualOverrides !== false;
    let touched = false;

    // -- 3a. rederive trigger (no change on the parent itself) --
    if (plan && patch.rematerializeOnly) {
      const parentRow = rates.get(key);
      await materializeChildren(plan, patch.roomTypeId, patch.date, parentRow?.price ?? null, respectManual, patch.onlyChildIds);
    }

    // -- 3b. price-side fields --
    const hasPriceFields =
      patch.price !== undefined || patch.occupancyPrices !== undefined || patch.minPrice !== undefined || patch.maxPrice !== undefined;
    if (plan && !patch.rematerializeOnly && (hasPriceFields || patch.convertToManual || patch.revertToDerived)) {
      const existing = rates.get(key);
      const isDerived = Boolean(plan.parentRatePlanId);

      if (!isDerived && (patch.revertToDerived || (patch.convertToManual && !hasPriceFields))) {
        // The contract defines both flags «on a derived plan»: on a base plan
        // there is nothing to convert or revert, and silently flipping the
        // override flag used to leave an empty journal entry behind.
        outcome.conflicts.push({ ...cell, reason: `${plan.code} no es un plan derivado: revertToDerived/convertToManual solo aplican a celdas de planes derivados` });
      } else if (isDerived && patch.revertToDerived) {
        const parent = catalog.planById.get(plan.parentRatePlanId!);
        const parentRow = parent ? rates.get(cellKey(parent.id, patch.roomTypeId, patch.date)) : undefined;
        if (!parent || !parentRow) {
          outcome.conflicts.push({ ...cell, reason: "el plan padre no tiene tarifa ese día: no se puede rederivar" });
        } else {
          const derived = applyDerivation(parentRow.price, plan.derivation);
          if (!existing || existing.price !== derived || existing.manuallyOverridden || existing.source !== "derived") {
            if (!existing || existing.price !== derived) item(cell, null, "price", existing?.price ?? null, derived);
            if (existing && existing.source !== "derived") item(cell, null, "source", existing.source, "derived");
            await writeRate(cell, {
              price: derived,
              minPrice: existing?.minPrice ?? null,
              maxPrice: existing?.maxPrice ?? null,
              occupancyPrices: existing?.occupancyPrices ?? null,
              source: "derived",
              manuallyOverridden: false,
              updatedAt: null
            });
            touched = true;
          }
        }
      } else if (isDerived && !patch.convertToManual) {
        if (hasPriceFields) {
          outcome.conflicts.push({ ...cell, reason: `plan derivado de ${catalog.planById.get(plan.parentRatePlanId!)?.code ?? plan.parentRatePlanId}: la celda se calcula desde el padre (usa convertToManual)` });
        }
      } else if (patch.price === null) {
        // Remove the rate (journal revert of a cell that did not exist, or an explicit clear).
        if (existing) {
          item(cell, null, "price", existing.price, null);
          if (existing.minPrice !== null) item(cell, null, "minPrice", existing.minPrice, null);
          if (existing.maxPrice !== null) item(cell, null, "maxPrice", existing.maxPrice, null);
          if (existing.occupancyPrices) item(cell, null, "occupancyPrices", existing.occupancyPrices, null);
          // Provenance is journaled on removal too, so a revert recreates the row with its origin (import/rms/derived).
          if (existing.source !== "manual") item(cell, null, "source", existing.source, null);
          await deleteRate(cell);
          touched = true;
          if (!isDerived) await materializeChildren(plan, patch.roomTypeId, patch.date, null, respectManual);
        }
      } else {
        const nextPrice = typeof patch.price === "number" ? round2(patch.price) : existing?.price;
        if (nextPrice === undefined) {
          // Only min/max/occupancy (or convertToManual) on a cell without a rate:
          // there is no base to attach them to and a 0 € RateDay must never be invented.
          outcome.conflicts.push({ ...cell, reason: "sin tarifa base: indica un precio para crear la celda" });
        } else {
          const next: RateRow = {
            price: nextPrice,
            minPrice: patch.minPrice !== undefined ? patch.minPrice : existing?.minPrice ?? null,
            maxPrice: patch.maxPrice !== undefined ? patch.maxPrice : existing?.maxPrice ?? null,
            occupancyPrices: patch.occupancyPrices !== undefined ? patch.occupancyPrices : existing?.occupancyPrices ?? null,
            // A revert restores the provenance it journaled (import/rms); any other write is manual.
            source: patch.restoreSource ?? "manual",
            // The override flag only means something on a derived plan's cell
            // (convertToManual); a base-plan write keeps whatever it found.
            manuallyOverridden: isDerived ? true : existing?.manuallyOverridden ?? false,
            updatedAt: null
          };
          const changed =
            !existing ||
            existing.price !== next.price ||
            existing.minPrice !== next.minPrice ||
            existing.maxPrice !== next.maxPrice ||
            !sameJson(existing.occupancyPrices, next.occupancyPrices) ||
            existing.source !== next.source ||
            existing.manuallyOverridden !== next.manuallyOverridden;
          if (changed) {
            if (!existing || existing.price !== next.price) item(cell, null, "price", existing?.price ?? null, next.price);
            if ((existing?.minPrice ?? null) !== next.minPrice) item(cell, null, "minPrice", existing?.minPrice ?? null, next.minPrice);
            if ((existing?.maxPrice ?? null) !== next.maxPrice) item(cell, null, "maxPrice", existing?.maxPrice ?? null, next.maxPrice);
            if (!sameJson(existing?.occupancyPrices ?? null, next.occupancyPrices)) item(cell, null, "occupancyPrices", existing?.occupancyPrices ?? null, next.occupancyPrices);
            // Source transition (derived → manual on convertToManual, rms/import → manual, and back on a revert) is journaled so a revert restores it.
            if (existing && existing.source !== next.source) item(cell, null, "source", existing.source, next.source);
            await writeRate(cell, next);
            touched = true;
          }
          if (!isDerived && (!existing || existing.price !== next.price)) {
            await materializeChildren(plan, patch.roomTypeId, patch.date, next.price, respectManual);
          }
        }
      }
    }

    // -- 3c. restrictions (RestrictionDay keyed by plan|"*" and channel|"*") --
    if (patch.restrictions && Object.keys(patch.restrictions).length > 0) {
      const channelId = patch.channelId ?? STAR;
      const rKey = restrictionKey(patch.roomTypeId, patch.ratePlanId, channelId, patch.date);
      const current = restrictions.get(rKey) ?? EMPTY_RESTRICTION_COLUMNS;
      const { next, changed } = mergeRestrictionPatch(current, patch.restrictions);
      if (changed.length > 0) {
        const beforeWire = columnsToRestrictions(current);
        const afterWire = columnsToRestrictions(next);
        for (const k of changed) item(cell, patch.channelId ?? null, k, wireValue(beforeWire, k), wireValue(afterWire, k));
        const where = {
          propertyId_roomTypeId_ratePlanId_channelId_date: {
            propertyId,
            roomTypeId: patch.roomTypeId,
            ratePlanId: patch.ratePlanId,
            channelId,
            date: dayUtc(patch.date)
          }
        };
        if (isEmptyRestrictionRow(next)) {
          if (restrictions.has(rKey)) await tx.restrictionDay.deleteMany({ where: where.propertyId_roomTypeId_ratePlanId_channelId_date });
          restrictions.delete(rKey);
        } else {
          await tx.restrictionDay.upsert({
            where,
            create: { ...where.propertyId_roomTypeId_ratePlanId_channelId_date, ...next, restrictionSource: "manual", updatedBy: actor.userId },
            update: { ...next, restrictionSource: "manual", updatedBy: actor.userId }
          });
          restrictions.set(rKey, next);
        }
        touched = true;
      }
    }

    // -- 3d. distribution inventory (room level) --
    if (patch.available !== undefined) {
      const iKey = `${patch.roomTypeId}|${patch.date}`;
      const existing = inventory.get(iKey);
      const where = { propertyId_roomTypeId_date: { propertyId, roomTypeId: patch.roomTypeId, date: dayUtc(patch.date) } };
      if (patch.available === null) {
        if (existing) {
          item(cell, null, "available", existing.availableCount, null);
          await tx.inventoryDay.delete({ where });
          inventory.delete(iKey);
          touched = true;
        }
      } else if (!existing || existing.availableCount !== patch.available) {
        item(cell, null, "available", existing?.availableCount ?? null, patch.available);
        const total = existing?.totalInventory ?? Math.max(roomsOfType.get(patch.roomTypeId) ?? 0, patch.available);
        await tx.inventoryDay.upsert({
          where,
          create: { ...where.propertyId_roomTypeId_date, totalInventory: total, availableCount: patch.available, outOfOrderCount: 0 },
          update: { availableCount: patch.available }
        });
        inventory.set(iKey, { totalInventory: total, availableCount: patch.available });
        touched = true;
      }
    }

    if (touched) outcome.updated += 1;
  }

  // One item per (cell, field): the same cell written twice in one request
  // (op + manual cell) keeps the first `before` and the last `after`.
  outcome.items = coalesceJournalItems(outcome.items);
  return outcome;
}

function describeDerivation(d: RatePlanDerivation): string {
  if (d.mode === "percent") return `${d.value > 0 ? "+" : ""}${d.value} %`;
  if (d.mode === "amount") return `${d.value > 0 ? "+" : ""}${d.value} €`;
  return "copia del padre";
}

function wireValue(r: RateRestrictions, key: keyof RateRestrictions): unknown {
  const v = r[key];
  return v === undefined ? null : v;
}

/** Actor e-mail for the journal: the real user row when it exists (demo ids like usr_123 may not). */
export async function resolveActorEmail(userId: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user?.email ?? null;
  } catch {
    // Honest catch: an unknown id shape must not break a rate write; the journal keeps userId anyway.
    return null;
  }
}

export type RateGridWriteInput = {
  catalog: PropertyCatalog;
  context: UserContext;
  patches: EnginePatch[];
  reason: string;
  /** Journal status of the entry being written (draft for edits, published for a revert). */
  status?: "draft" | "published";
  clientRequestId?: string | null;
  /**
   * Revert only: id of the entry this write reverts. Stored in
   * changesJson.revertsJournalId (no column: the forward link already lives in
   * RateChangeJournal.revertedByJournalId, and the inverse row is read whole
   * by the history anyway) and exposed as `revertsJournalId`.
   */
  revertsJournalId?: string | null;
  correlationId?: string;
  /** Extra diagnostics merged into the response (bulk-op expansion). */
  skipped?: RateGridBulkUpdateResponse["skipped"];
  warnings?: string[];
  auditAction?: string;
  /** Runs inside the transaction after the journal row exists (revert marks the original). */
  afterJournal?: (tx: Tx, journalId: string) => Promise<void>;
  /**
   * When EVERY patch ended as a conflict (nothing written, no journal item)
   * roll back and answer 409 `ALL_CELLS_CONFLICT` with `details.conflicts`
   * instead of persisting an empty journal entry. Partial conflicts stay a
   * 200 with `conflicts[]` (bulk-update and revert set it; rederive keeps 200).
   */
  conflictIfAllFail?: boolean;
  /**
   * What to do when a patch's `expected` no longer matches the cell:
   * "conflict" (default) skips that patch and lists it in `conflicts[]`;
   * "abort" rolls the whole write back with 409 `JOURNAL_STALE` (revert).
   */
  staleMode?: "conflict" | "abort";
};

/** Postgres SQLSTATE of `lock_timeout` expiry. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Serialise the writes of one property: a transaction-scoped advisory lock
 * (released at commit/rollback) taken BEFORE reading, so two concurrent
 * bulk-updates see each other's result (correct `before` in the journal) and
 * a retried `clientRequestId` finds the first attempt's journal. Waiting is
 * bounded by `lock_timeout` (30 s → 409 RATE_GRID_BUSY, never a 500).
 */
async function lockPropertyGrid(tx: Tx, propertyId: string): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '30s'");
  try {
    // $executeRaw (not $queryRaw): the function returns void, which the query client cannot deserialise.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rate-grid:${propertyId}`}))`;
  } catch (error) {
    const text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}` : String(error);
    if (text.includes(LOCK_NOT_AVAILABLE) || /lock timeout/i.test(text)) {
      throw new ConflictError("La parrilla de esta propiedad está siendo modificada por otra petición: reintenta en unos segundos.", { code: "RATE_GRID_BUSY" });
    }
    throw error;
  }
}

/**
 * What the engine hands back: the wire response plus `replayed` when the
 * write was NOT performed because `clientRequestId` had already been
 * processed. The flag is for the services (skip the publish, skip the audit
 * event); `toWireResponse` strips it before anything reaches the client.
 */
export type RateGridWriteResult = RateGridBulkUpdateResponse & { replayed?: true };

/** Drop the engine-only `replayed` flag (never on the wire). */
export function toWireResponse(result: RateGridWriteResult): RateGridBulkUpdateResponse {
  const { replayed: _replayed, ...response } = result;
  return response;
}

/** Client the replay lookup runs on: the transaction (under the lock) or the root client (P2002 path). */
type JournalReader = Pick<Tx, "rateChangeJournal">;

/**
 * The entry a previous attempt with the same `clientRequestId` wrote, as the
 * response it returned then (persisted in changesJson.response, journalId
 * included). Null when no such entry exists.
 */
async function findStoredResponse(db: JournalReader, propertyId: string, clientRequestId: string): Promise<RateGridWriteResult | null> {
  const previous = await db.rateChangeJournal.findFirst({
    where: { propertyId, clientRequestId },
    select: { id: true, changesJson: true }
  });
  if (!previous) return null;
  const stored = (previous.changesJson as { response?: RateGridBulkUpdateResponse } | null)?.response;
  return { ...(stored ?? { journalId: previous.id, updated: 0, derivedUpdated: 0, skippedManual: 0, conflicts: [] }), replayed: true };
}

/**
 * Transactional write + journal. When `clientRequestId` matches an existing
 * journal of the property the stored response is returned WITHOUT writing
 * (idempotent retries from the editor), flagged `replayed`.
 */
export async function executeRateGridWrite(input: RateGridWriteInput): Promise<RateGridWriteResult> {
  const { catalog, context } = input;
  assertPatchIdsBelong(catalog, input.patches);
  const userEmail = await resolveActorEmail(context.userId);

  const result = await withIdempotentReplay(
    input.clientRequestId,
    () => runRateGridWrite(input, userEmail),
    // Unique (propertyId, clientRequestId) fired: the other retry committed
    // first, so its entry is what this request must answer.
    () => findStoredResponse(prisma, catalog.propertyId, input.clientRequestId!)
  );

  if (!result.replayed) {
    recordAuditEvent({
      organizationId: context.organizationId,
      propertyId: catalog.propertyId,
      actorUserId: context.userId,
      actorType: "user",
      action: input.auditAction ?? "RATE_GRID_UPDATED",
      entityType: "rate_change_journal",
      entityId: result.journalId,
      afterJson: {
        journalId: result.journalId,
        updated: result.updated,
        derivedUpdated: result.derivedUpdated,
        skippedManual: result.skippedManual,
        conflicts: result.conflicts.length,
        changesCount: result.changesCount ?? 0,
        reason: input.reason
      },
      correlationId: input.correlationId
    });
  }
  return result;
}

/** The transaction itself (lock → replay check → apply → journal → afterJournal). */
async function runRateGridWrite(input: RateGridWriteInput, userEmail: string | null): Promise<RateGridWriteResult> {
  const { catalog, context } = input;
  return prisma.$transaction(
    async (tx) => {
      await lockPropertyGrid(tx, catalog.propertyId);
      if (input.clientRequestId) {
        const previous = await findStoredResponse(tx, catalog.propertyId, input.clientRequestId);
        if (previous) return previous;
      }

      const outcome = await applyPatchesInTx(tx, catalog, input.patches, { userId: context.userId });
      if (input.staleMode === "abort" && outcome.stale.length > 0) {
        // Throwing inside $transaction rolls back everything applied so far.
        throw new ConflictError(
          `${outcome.stale.length} ${outcome.stale.length === 1 ? "celda cambió" : "celdas cambiaron"} después de este asiento: revierte primero los asientos posteriores o fuerza la reversión (force).`,
          { code: "JOURNAL_STALE", cells: outcome.stale.slice(0, 200) }
        );
      }
      if (
        input.conflictIfAllFail &&
        input.patches.length > 0 &&
        outcome.conflicts.length >= input.patches.length &&
        outcome.updated === 0 &&
        outcome.derivedUpdated === 0 &&
        outcome.items.length === 0
      ) {
        // Throwing inside $transaction rolls back anything a partial branch wrote.
        throw new ConflictError("Ninguna celda se pudo aplicar: todas las celdas entran en conflicto.", {
          code: "ALL_CELLS_CONFLICT",
          conflicts: outcome.conflicts.slice(0, 200),
          ...(input.skipped && input.skipped.length > 0 ? { skipped: input.skipped.slice(0, 200) } : {}),
          ...(input.warnings && input.warnings.length > 0 ? { warnings: input.warnings } : {})
        });
      }
      const response: RateGridBulkUpdateResponse = {
        journalId: "",
        updated: outcome.updated,
        derivedUpdated: outcome.derivedUpdated,
        skippedManual: outcome.skippedManual,
        conflicts: outcome.conflicts,
        changesCount: outcome.items.length,
        ...(input.skipped && input.skipped.length > 0 ? { skipped: input.skipped } : {}),
        ...(input.warnings && input.warnings.length > 0 ? { warnings: input.warnings } : {})
      };
      const changesJson = (): Prisma.InputJsonValue =>
        ({ summary: summarize(outcome), response, ...(input.revertsJournalId ? { revertsJournalId: input.revertsJournalId } : {}) }) as unknown as Prisma.InputJsonValue;
      const journal = await tx.rateChangeJournal.create({
        data: {
          propertyId: catalog.propertyId,
          userId: context.userId,
          userEmail,
          changesCount: outcome.items.length,
          changesJson: changesJson(),
          reason: input.reason,
          pushedTo: [],
          pushStatus: "draft",
          status: input.status ?? "draft",
          clientRequestId: input.clientRequestId ?? null
        },
        select: { id: true }
      });
      response.journalId = journal.id;
      // Persist the final response (with the id) so an idempotent replay returns the same body.
      await tx.rateChangeJournal.update({ where: { id: journal.id }, data: { changesJson: changesJson() } });
      if (outcome.items.length > 0) {
        await tx.rateChangeJournalItem.createMany({
          data: outcome.items.map((i) => ({
            journalId: journal.id,
            ratePlanId: i.ratePlanId,
            roomTypeId: i.roomTypeId,
            date: dayUtc(i.date),
            channelId: i.channelId,
            field: i.field,
            beforeJson: i.before === null || i.before === undefined ? Prisma.JsonNull : (i.before as Prisma.InputJsonValue),
            afterJson: i.after === null || i.after === undefined ? Prisma.JsonNull : (i.after as Prisma.InputJsonValue)
          }))
        });
      }
      if (input.afterJournal) await input.afterJournal(tx, journal.id);
      return response;
    },
    { maxWait: 10_000, timeout: 120_000 }
  );
}

function summarize(outcome: EngineOutcome) {
  return {
    updated: outcome.updated,
    derivedUpdated: outcome.derivedUpdated,
    skippedManual: outcome.skippedManual,
    conflicts: outcome.conflicts.length,
    items: outcome.items.length,
    fields: RATE_RESTRICTION_KEYS.filter((k) => outcome.items.some((i) => i.field === k)).length
  };
}

/** Typed 409 helper shared by revert (already reverted) and rederive (not a derived plan). */
export function conflict(message: string, details?: unknown): ConflictError {
  return new ConflictError(message, details);
}
