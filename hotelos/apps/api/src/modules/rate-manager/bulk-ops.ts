// Rate grid v2 · bulk operations expansion (pure, no I/O).
//
// A bulk op ("+10 % on weekends of October for BAR/DBL") is expanded here into
// one cell patch per (plan, roomType, date[, channel]) against a snapshot of the
// grid. Keeping this pure makes the arithmetic testable without a database and
// keeps the transaction (rate-grid.service.ts) free of business rules: it only
// receives patches.

import type { RateCellSource, RateGridBulkOp, RateGridCellPatch, RateGridPriceOp } from "@hotelos/shared";
import { round2 } from "./derivation.js";

const MS_DAY = 86_400_000;

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sentinel of «every plan» / «every channel» (RestrictionDay rows, the «Disponibles» row). */
export const STAR = "*";

/** Strict calendar check: "2026-13-99" matches the regex but is not a real day. */
export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function dayUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every calendar day from `from` to `to` inclusive (both `YYYY-MM-DD`). */
export function enumerateDates(from: string, to: string): string[] {
  const start = dayUtc(from).getTime();
  const end = dayUtc(to).getTime();
  const out: string[] = [];
  for (let t = start; t <= end; t += MS_DAY) out.push(isoDate(new Date(t)));
  return out;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const dow = dayUtc(date).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Stable key of a base cell (no channel dimension). */
export function cellKey(ratePlanId: string, roomTypeId: string, date: string): string {
  return `${ratePlanId}|${roomTypeId}|${date}`;
}

export type BulkGridCellState = {
  basePrice: number | null;
  source: RateCellSource;
  manuallyOverridden: boolean;
};

/** Minimal grid snapshot the expansion needs (the service builds it from Prisma). */
export type BulkGridSnapshot = {
  /** Active room types in display order. */
  roomTypeIds: string[];
  /** Active rate plans (any order). */
  ratePlanIds: string[];
  /**
   * Soft-deleted plans of the property (id → code). Never expanded; an op
   * scope that names one gets the warning «plan tarifario inactivo <código>»
   * instead of «desconocido», and the service answers 400 INACTIVE_RATE_PLANS
   * (not NO_CELLS) when every scope names only inactive plans — the same
   * answer the `cells` path gives (rate-grid.engine.ts#assertPatchIdsBelong).
   */
  inactivePlans?: Map<string, string>;
  /** Plans that derive from a parent (writes need convertToManual). */
  derivedPlanIds?: Set<string>;
  /** Channels of the property (for scope.channelIds validation). */
  channelIds?: string[];
  /** Current base cells keyed by cellKey(); absent = no RateDay. */
  cells: Map<string, BulkGridCellState>;
};

export type BulkOpSkip = { ratePlanId: string; roomTypeId: string; date: string; reason: string };

export type ExpandedBulkOps = {
  patches: RateGridCellPatch[];
  /** Cells a price op could not compute (no base price to derive from, missing source day…). */
  skipped: BulkOpSkip[];
  /** Diagnostics for the caller (unknown ids in scope, empty scope…). */
  warnings: string[];
  /** Inactive plans named by any op scope (first-seen order, no duplicates); nothing expands for them. */
  inactivePlanIds: string[];
  /**
   * True when every op names plans explicitly and ALL of them are inactive:
   * with 0 patches the request is «reactívalos» (INACTIVE_RATE_PLANS), not
   * «revisa el ámbito» (NO_CELLS). A scope with an active or unknown plan,
   * or with no `ratePlanIds` (= every active plan), keeps it false.
   */
  allScopesInactive: boolean;
};

/** Apply one price op to a current base price; null = cannot compute. */
export function computePriceOp(op: RateGridPriceOp, current: number | null, copySource: number | null): number | null {
  switch (op.mode) {
    case "set":
      return round2(Math.max(0, op.value));
    case "percent":
      return current === null ? null : round2(Math.max(0, current * (1 + op.value / 100)));
    case "amount":
      return current === null ? null : round2(Math.max(0, current + op.value));
    case "copyFrom":
      return copySource === null ? null : round2(copySource);
    case "floor":
      return current === null ? null : round2(Math.max(current, op.value));
    case "ceiling":
      return current === null ? null : round2(Math.min(current, op.value));
    default:
      return null;
  }
}

/**
 * Expand every op into cell patches. Patches are merged per cell in op order
 * (a later op wins on the same field), so a "set 100" followed by "+10 %" on
 * the same scope yields 110. Price ops chain on the running value of the
 * cell (snapshot price, then the previous op's result).
 */
export function expandBulkOps(ops: RateGridBulkOp[], grid: BulkGridSnapshot): ExpandedBulkOps {
  const patches = new Map<string, RateGridCellPatch>();
  const running = new Map<string, number | null>();
  const skipped: BulkOpSkip[] = [];
  const warnings: string[] = [];
  const knownTypes = new Set(grid.roomTypeIds);
  const knownPlans = new Set(grid.ratePlanIds);
  const inactivePlans = grid.inactivePlans ?? new Map<string, string>();
  const knownChannels = grid.channelIds ? new Set(grid.channelIds) : null;
  const inactiveSeen = new Set<string>();
  let allScopesInactive = ops.length > 0;

  const currentPrice = (key: string): number | null => {
    if (running.has(key)) return running.get(key) ?? null;
    return grid.cells.get(key)?.basePrice ?? null;
  };

  ops.forEach((op, index) => {
    const scope = op.scope;
    const dates = enumerateDates(scope.from, scope.to).filter((date) =>
      !scope.weekdays || scope.weekdays.length === 0 ? true : scope.weekdays.includes(isoWeekday(date))
    );
    const roomTypeIds = scope.roomTypeIds && scope.roomTypeIds.length > 0 ? scope.roomTypeIds : grid.roomTypeIds;
    const ratePlanIds = scope.ratePlanIds && scope.ratePlanIds.length > 0 ? scope.ratePlanIds : grid.ratePlanIds;
    const channelIds = scope.channelIds && scope.channelIds.length > 0 ? scope.channelIds : [null];

    for (const id of roomTypeIds) if (!knownTypes.has(id)) warnings.push(`op[${index}]: tipo de habitación desconocido ${id}`);
    const explicitPlans = Boolean(scope.ratePlanIds && scope.ratePlanIds.length > 0);
    if (!explicitPlans || !ratePlanIds.every((id) => inactivePlans.has(id))) allScopesInactive = false;
    for (const id of ratePlanIds) {
      if (knownPlans.has(id)) continue;
      const inactiveCode = inactivePlans.get(id);
      if (inactiveCode !== undefined) {
        inactiveSeen.add(id);
        warnings.push(`op[${index}]: plan tarifario inactivo ${inactiveCode}: reactívalo para editar sus celdas`);
      } else {
        warnings.push(`op[${index}]: plan tarifario desconocido ${id}`);
      }
    }
    if (knownChannels) {
      for (const id of channelIds) if (id && !knownChannels.has(id)) warnings.push(`op[${index}]: canal desconocido ${id}`);
    }
    if (dates.length === 0) warnings.push(`op[${index}]: el ámbito no contiene ningún día`);

    const hasPayload = op.price !== undefined || op.restrictions !== undefined || op.available !== undefined;
    if (!hasPayload) {
      warnings.push(`op[${index}]: sin precio, restricciones ni disponibilidad — ignorada`);
      return;
    }

    for (const ratePlanId of ratePlanIds) {
      if (!knownPlans.has(ratePlanId)) continue;
      for (const roomTypeId of roomTypeIds) {
        if (!knownTypes.has(roomTypeId)) continue;
        for (const date of dates) {
          for (const channelId of channelIds) {
            const baseKey = cellKey(ratePlanId, roomTypeId, date);
            const patchKey = channelId ? `${baseKey}|${channelId}` : baseKey;
            const patch: RateGridCellPatch = patches.get(patchKey) ?? {
              ratePlanId,
              roomTypeId,
              date,
              ...(channelId ? { channelId } : {})
            };

            if (op.price !== undefined && channelId === null) {
              const copySource =
                op.price.mode === "copyFrom" ? currentPrice(cellKey(ratePlanId, roomTypeId, op.price.fromDate)) : null;
              const next = computePriceOp(op.price, currentPrice(baseKey), copySource);
              if (next === null) {
                skipped.push({
                  ratePlanId,
                  roomTypeId,
                  date,
                  reason: op.price.mode === "copyFrom" ? `sin tarifa en ${op.price.fromDate}` : "sin tarifa base"
                });
              } else {
                patch.price = next;
                running.set(baseKey, next);
                if (op.respectManualOverrides === false) patch.respectManualOverrides = false;
              }
            } else if (op.price !== undefined && channelId !== null) {
              // Channel price overrides have no persistence (channel prices come
              // from the channel markup). The wire schema already answers 400 for
              // scope.channelIds + price (rate-grid.schemas.ts); this branch keeps the
              // pure expansion honest for direct callers: report, never write silently.
              skipped.push({ ratePlanId, roomTypeId, date, reason: `precio por canal ${channelId} no persistible (usa el markup del canal)` });
            }

            if (op.restrictions !== undefined) {
              patch.restrictions = { ...(patch.restrictions ?? {}), ...op.restrictions };
            }
            if (op.available !== undefined && channelId === null) {
              patch.available = op.available;
            }
            // A skipped price op on a cell nothing else touches must not leave an empty patch behind.
            if (patch.price !== undefined || patch.restrictions !== undefined || patch.available !== undefined) {
              patches.set(patchKey, patch);
            }
          }
        }
      }
    }
  });

  return { patches: [...patches.values()], skipped, warnings, inactivePlanIds: [...inactiveSeen], allScopesInactive };
}
