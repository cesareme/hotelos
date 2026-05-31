// rate-grid-utils — Pure helpers for the Cocoa Rate Grid.
//
// This module exports only deterministic, side-effect-free functions and the
// supporting types used by the rate grid surface. No React, no I/O, no
// Date.now()/Math.random() — every output is fully determined by inputs so
// the grid can be unit-tested in isolation and rendered identically on
// server and client.
//
// Domain model (high level):
//   - A rate grid is a sparse matrix of cells indexed by (roomTypeId, date)
//     and optionally by channelId for channel-specific overrides.
//   - Each cell carries a price (in minor units), an availability count,
//     and a set of restrictions (closed, stop-sell, min/max LOS, CTA, CTD).
//   - Editors apply a `BulkEditOperation` against a selection (list of cell
//     ids) which yields a list of `Patch` objects ready to be persisted.
//   - The `diffCells` helper compares a "before" snapshot with a list of
//     patches and produces a structured `Diff[]` for audit / undo / preview.
//
// Dates are ISO `YYYY-MM-DD` strings (UTC date-only, no timezone math here).
// Cell ids use `:` as a separator, which is forbidden inside any of the
// component fields by `assertNoSeparator()` so parsing is unambiguous.

// ---------- Types ----------

/**
 * Minor currency unit (e.g. cents). Always a non-negative integer.
 * Using integers avoids floating-point drift when summing many cells.
 */
export type Minor = number;

/** ISO date string in `YYYY-MM-DD` form, UTC date-only. */
export type IsoDate = string;

/**
 * A single cell of the rate grid. Per (roomType, date) the grid stores the
 * "master" cell (channelId === undefined). Channel-specific overrides live
 * in cells with the same (roomType, date) but a non-empty channelId.
 */
export interface RateGridCell {
  /** Stable identifier of the room type (e.g. "rt_double_deluxe"). */
  roomTypeId: string;
  /** Date the cell applies to (check-in date). */
  date: IsoDate;
  /** Optional channel scope. Undefined means "all channels / master". */
  channelId?: string;
  /** Current selling price in minor units. */
  price: Minor;
  /** Remaining inventory (rooms left to sell). Non-negative integer. */
  availability: number;
  /** Restrictions / status flags. All optional, default to "no restriction". */
  restrictions?: CellRestrictions;
}

/**
 * Cell-level restrictions. Any flag absent means "not restricted".
 *
 * Semantics:
 *   - `closed`     — Hotel is administratively closed (no arrivals/stays).
 *   - `stopSell`   — Channel/room is stopped; existing bookings honored.
 *   - `minLos`     — Minimum length of stay (nights). 1 means "no minimum".
 *   - `maxLos`     — Maximum length of stay (nights). 0/undefined = no max.
 *   - `closedToArrival`   (CTA) — Cannot start a stay on this date.
 *   - `closedToDeparture` (CTD) — Cannot end a stay on this date.
 */
export interface CellRestrictions {
  closed?: boolean;
  stopSell?: boolean;
  minLos?: number;
  maxLos?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
}

/** Status surfaced by `getCellStatus()` — drives visual treatment. */
export type CellStatus =
  | "open"
  | "closed"
  | "stop-sell"
  | "open-with-restrictions";

/**
 * Discriminated union of bulk edit operations. Each variant is fully
 * self-describing so the caller never needs out-of-band context.
 *
 * Supported variants:
 *   - `set-price`             — Replace price with `price` (minor units).
 *   - `adjust-price-delta`    — Add `delta` (signed minor units) to price,
 *                               flooring at 0 so cells never go negative.
 *   - `adjust-price-percent`  — Multiply price by `(1 + percent/100)`, then
 *                               round half-up to the nearest minor unit.
 *   - `set-availability`      — Replace availability with `value`.
 *   - `set-restriction`       — Set a single restriction key. `value` is the
 *                               new value (boolean for flags, number for LOS).
 *   - `clear-restriction`     — Remove a single restriction key.
 *   - `close` / `open`        — Convenience: flips `closed` to true/false.
 */
export type BulkEditOperation =
  | { type: "set-price"; price: Minor }
  | { type: "adjust-price-delta"; delta: number }
  | { type: "adjust-price-percent"; percent: number }
  | { type: "set-availability"; value: number }
  | {
      type: "set-restriction";
      key: keyof CellRestrictions;
      value: boolean | number;
    }
  | { type: "clear-restriction"; key: keyof CellRestrictions }
  | { type: "close" }
  | { type: "open" };

/**
 * A pending change to a single cell. Only the fields that actually change
 * are present, so `patches` are a minimal description of intent. Consumers
 * can apply patches to a base cell with `applyPatch()` or persist them.
 */
export interface Patch {
  /** Cell id (`cellId(...)` output) the patch targets. */
  cellId: string;
  /** Room type the cell belongs to (denormalized for convenience). */
  roomTypeId: string;
  /** Date the cell applies to. */
  date: IsoDate;
  /** Optional channel scope. */
  channelId?: string;
  /** New price, if changed. */
  price?: Minor;
  /** New availability, if changed. */
  availability?: number;
  /**
   * Restriction overrides. Each key that is present is set to the given
   * value; setting a key to `null` clears it from the cell's restrictions.
   * Keys not present are left untouched.
   */
  restrictions?: Partial<Record<keyof CellRestrictions, boolean | number | null>>;
}

/** A field-level change emitted by `diffCells()`. */
export interface Diff {
  cellId: string;
  roomTypeId: string;
  date: IsoDate;
  channelId?: string;
  /** Name of the field that changed (`price`, `availability`, or a restriction key). */
  field: string;
  /** Value before the patch was applied. May be `undefined` if previously unset. */
  before: unknown;
  /** Value after the patch is applied. */
  after: unknown;
}

// ---------- Constants ----------

/** Separator used in `cellId()`. Forbidden inside any component field. */
const CELL_ID_SEPARATOR = ":";

// ---------- Helpers (internal) ----------

function assertNoSeparator(label: string, value: string): void {
  if (value.includes(CELL_ID_SEPARATOR)) {
    throw new Error(
      `rate-grid-utils: ${label} cannot contain "${CELL_ID_SEPARATOR}" (got: ${JSON.stringify(value)})`
    );
  }
}

/** Round half-up to the nearest integer. Stable for negative numbers too. */
function roundHalfUp(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Shallow-clone restrictions and apply a single override. */
function applyRestrictionOverride(
  base: CellRestrictions | undefined,
  key: keyof CellRestrictions,
  value: boolean | number | null
): CellRestrictions | undefined {
  const next: CellRestrictions = { ...(base ?? {}) };
  if (value === null) {
    delete next[key];
  } else if (typeof value === "boolean") {
    // Type assertion is safe: boolean-only keys are typed as boolean.
    (next as Record<string, unknown>)[key] = value;
  } else {
    (next as Record<string, unknown>)[key] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

// ---------- Public API ----------

/**
 * Build a stable, parseable cell id.
 *
 * Format: `<roomTypeId>:<date>` or `<roomTypeId>:<date>:<channelId>`.
 * Throws if any component contains the separator character.
 */
export function cellId(
  roomTypeId: string,
  date: string,
  channelId?: string
): string {
  assertNoSeparator("roomTypeId", roomTypeId);
  assertNoSeparator("date", date);
  if (channelId !== undefined) {
    assertNoSeparator("channelId", channelId);
    return `${roomTypeId}${CELL_ID_SEPARATOR}${date}${CELL_ID_SEPARATOR}${channelId}`;
  }
  return `${roomTypeId}${CELL_ID_SEPARATOR}${date}`;
}

/**
 * Parse a cell id previously produced by `cellId()`. Throws on malformed
 * input so callers don't silently propagate bad ids.
 */
export function parseCellId(id: string): {
  roomTypeId: string;
  date: IsoDate;
  channelId?: string;
} {
  const parts = id.split(CELL_ID_SEPARATOR);
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(
      `rate-grid-utils: malformed cell id ${JSON.stringify(id)} — expected 2 or 3 parts`
    );
  }
  const [roomTypeId, date, channelId] = parts;
  if (!roomTypeId || !date) {
    throw new Error(
      `rate-grid-utils: malformed cell id ${JSON.stringify(id)} — empty component`
    );
  }
  if (parts.length === 3) {
    if (!channelId) {
      throw new Error(
        `rate-grid-utils: malformed cell id ${JSON.stringify(id)} — empty channelId`
      );
    }
    return { roomTypeId, date, channelId };
  }
  return { roomTypeId, date };
}

/**
 * Derive the visual status of a cell from its restrictions and availability.
 *
 * Priority (highest first):
 *   1. `closed`       → "closed"
 *   2. `stopSell`     → "stop-sell"
 *   3. any other restriction OR `availability === 0` → "open-with-restrictions"
 *   4. otherwise → "open"
 */
export function getCellStatus(cell: RateGridCell): CellStatus {
  const r = cell.restrictions;
  if (r?.closed) return "closed";
  if (r?.stopSell) return "stop-sell";

  const hasOtherRestriction =
    !!r &&
    ((r.minLos !== undefined && r.minLos > 1) ||
      (r.maxLos !== undefined && r.maxLos > 0) ||
      r.closedToArrival === true ||
      r.closedToDeparture === true);

  if (hasOtherRestriction || cell.availability === 0) {
    return "open-with-restrictions";
  }
  return "open";
}

/**
 * Apply a `BulkEditOperation` to the cells in `selectedIds`, returning a
 * minimal list of `Patch` objects (one per affected cell). Cells whose id
 * is not present in `cells` are skipped silently — callers can filter
 * upstream if they need a stricter contract.
 *
 * Pure: input arrays are not mutated; cell ordering is preserved.
 */
export function applyBulkEdit(
  cells: RateGridCell[],
  selectedIds: string[],
  operation: BulkEditOperation
): Patch[] {
  const cellById = new Map<string, RateGridCell>();
  for (const cell of cells) {
    cellById.set(cellId(cell.roomTypeId, cell.date, cell.channelId), cell);
  }

  const selected = new Set(selectedIds);
  const patches: Patch[] = [];

  for (const id of selectedIds) {
    if (!selected.has(id)) continue; // dedupe (Set already does this on iteration)
    const cell = cellById.get(id);
    if (!cell) continue;

    const patch: Patch = {
      cellId: id,
      roomTypeId: cell.roomTypeId,
      date: cell.date,
      channelId: cell.channelId
    };

    switch (operation.type) {
      case "set-price": {
        const next = Math.max(0, Math.trunc(operation.price));
        if (next !== cell.price) patch.price = next;
        break;
      }
      case "adjust-price-delta": {
        const next = Math.max(0, Math.trunc(cell.price + operation.delta));
        if (next !== cell.price) patch.price = next;
        break;
      }
      case "adjust-price-percent": {
        const raw = cell.price * (1 + operation.percent / 100);
        const next = Math.max(0, roundHalfUp(raw));
        if (next !== cell.price) patch.price = next;
        break;
      }
      case "set-availability": {
        const next = Math.max(0, Math.trunc(operation.value));
        if (next !== cell.availability) patch.availability = next;
        break;
      }
      case "set-restriction": {
        const current = cell.restrictions?.[operation.key];
        if (current !== operation.value) {
          patch.restrictions = { [operation.key]: operation.value };
        }
        break;
      }
      case "clear-restriction": {
        if (cell.restrictions?.[operation.key] !== undefined) {
          patch.restrictions = { [operation.key]: null };
        }
        break;
      }
      case "close": {
        if (cell.restrictions?.closed !== true) {
          patch.restrictions = { closed: true };
        }
        break;
      }
      case "open": {
        if (cell.restrictions?.closed === true) {
          patch.restrictions = { closed: false };
        }
        break;
      }
      default: {
        // Exhaustiveness check — compile-time error if a variant is missed.
        const _exhaustive: never = operation;
        void _exhaustive;
      }
    }

    // Only emit a patch if something actually changed.
    if (
      patch.price !== undefined ||
      patch.availability !== undefined ||
      patch.restrictions !== undefined
    ) {
      patches.push(patch);
    }
  }

  return patches;
}

/**
 * Apply a single patch to a cell, returning a new cell value. Pure.
 * Useful for previewing a patch before persisting it.
 */
export function applyPatch(cell: RateGridCell, patch: Patch): RateGridCell {
  let restrictions = cell.restrictions;
  if (patch.restrictions) {
    let next = restrictions;
    for (const [key, value] of Object.entries(patch.restrictions)) {
      next = applyRestrictionOverride(
        next,
        key as keyof CellRestrictions,
        value as boolean | number | null
      );
    }
    restrictions = next;
  }

  return {
    ...cell,
    price: patch.price ?? cell.price,
    availability: patch.availability ?? cell.availability,
    restrictions
  };
}

/**
 * Compute a structured diff between the "before" snapshot and the result of
 * applying `after` patches on top. One `Diff` entry per changed field per
 * cell. Patches whose targeted cell is not in `before` are skipped.
 *
 * Pure: inputs are not mutated.
 */
export function diffCells(before: RateGridCell[], after: Patch[]): Diff[] {
  const beforeById = new Map<string, RateGridCell>();
  for (const cell of before) {
    beforeById.set(cellId(cell.roomTypeId, cell.date, cell.channelId), cell);
  }

  const diffs: Diff[] = [];

  for (const patch of after) {
    const baseCell = beforeById.get(patch.cellId);
    if (!baseCell) continue;

    const meta = {
      cellId: patch.cellId,
      roomTypeId: baseCell.roomTypeId,
      date: baseCell.date,
      channelId: baseCell.channelId
    };

    if (patch.price !== undefined && patch.price !== baseCell.price) {
      diffs.push({
        ...meta,
        field: "price",
        before: baseCell.price,
        after: patch.price
      });
    }

    if (
      patch.availability !== undefined &&
      patch.availability !== baseCell.availability
    ) {
      diffs.push({
        ...meta,
        field: "availability",
        before: baseCell.availability,
        after: patch.availability
      });
    }

    if (patch.restrictions) {
      for (const [key, value] of Object.entries(patch.restrictions)) {
        const beforeValue = baseCell.restrictions?.[key as keyof CellRestrictions];
        const afterValue = value === null ? undefined : value;
        if (beforeValue !== afterValue) {
          diffs.push({
            ...meta,
            field: key,
            before: beforeValue,
            after: afterValue
          });
        }
      }
    }
  }

  return diffs;
}
