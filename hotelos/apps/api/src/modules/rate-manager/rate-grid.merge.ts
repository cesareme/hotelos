// Rate grid v2 · read-side merge helpers (pure, no I/O).
//
// Everything a grid cell shows that is COMPUTED from several rows lives here so
// it can be unit-tested without Prisma:
//   · restriction precedence  (channel+plan > channel+* > plan > *)
//   · channel effective price (base × (1 + markup/100))
//   · per-cell sync state     (latest ChannelDelivery per channel)

import type { CellSyncState, CellSyncStatus, RateRestrictions, RateRestrictionsPatch } from "@hotelos/shared";
import { RATE_RESTRICTION_KEYS } from "@hotelos/shared";
import { round2 } from "./derivation.js";
import { cellKey } from "./bulk-ops.js";

// ---- restrictions -----------------------------------------------------------

/** Column view of a RestrictionDay row (what Prisma returns, minus ids/dates). */
export type RestrictionColumns = {
  minStay: number | null;
  maxStay: number | null;
  minStayThrough: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  closed: boolean;
  stopSell: boolean;
  minAdvanceDays: number | null;
  maxAdvanceDays: number | null;
};

export const EMPTY_RESTRICTION_COLUMNS: RestrictionColumns = {
  minStay: null,
  maxStay: null,
  minStayThrough: null,
  closedToArrival: false,
  closedToDeparture: false,
  closed: false,
  stopSell: false,
  minAdvanceDays: null,
  maxAdvanceDays: null
};

/** Wire key → RestrictionDay column. */
export const RESTRICTION_COLUMN_OF: Record<keyof RateRestrictions, keyof RestrictionColumns> = {
  minLos: "minStay",
  maxLos: "maxStay",
  minLosThrough: "minStayThrough",
  cta: "closedToArrival",
  ctd: "closedToDeparture",
  closed: "closed",
  stopSell: "stopSell",
  minAdvanceDays: "minAdvanceDays",
  maxAdvanceDays: "maxAdvanceDays"
};

const BOOLEAN_KEYS = new Set<keyof RateRestrictions>(["cta", "ctd", "closed", "stopSell"]);

/** Wire restrictions of ONE row: only set values (numbers non-null, booleans true) are emitted. */
export function columnsToRestrictions(row: RestrictionColumns): RateRestrictions {
  const out: RateRestrictions = {};
  for (const key of RATE_RESTRICTION_KEYS) {
    const value = row[RESTRICTION_COLUMN_OF[key]];
    if (BOOLEAN_KEYS.has(key)) {
      if (value === true) (out as Record<string, unknown>)[key] = true;
    } else if (typeof value === "number") {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Tri-state merge of a patch onto the current columns: `undefined` = keep,
 * `null` = clear (number → null, flag → false), value = set. Returns the new
 * columns and the wire keys whose value actually changed (journal source).
 */
export function mergeRestrictionPatch(
  current: RestrictionColumns,
  patch: RateRestrictionsPatch
): { next: RestrictionColumns; changed: Array<keyof RateRestrictions> } {
  const next: RestrictionColumns = { ...current };
  const changed: Array<keyof RateRestrictions> = [];
  for (const key of RATE_RESTRICTION_KEYS) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (raw === undefined) continue;
    const column = RESTRICTION_COLUMN_OF[key];
    if (BOOLEAN_KEYS.has(key)) {
      const value = raw === null ? false : Boolean(raw);
      if (next[column] !== value) {
        (next as Record<string, unknown>)[column] = value;
        changed.push(key);
      }
    } else {
      const value = raw === null ? null : Number(raw);
      if (next[column] !== value) {
        (next as Record<string, unknown>)[column] = value;
        changed.push(key);
      }
    }
  }
  return { next, changed };
}

/** True when the row carries no restriction at all (candidate for deletion). */
export function isEmptyRestrictionRow(row: RestrictionColumns): boolean {
  return (
    row.minStay === null &&
    row.maxStay === null &&
    row.minStayThrough === null &&
    !row.closedToArrival &&
    !row.closedToDeparture &&
    !row.closed &&
    !row.stopSell &&
    row.minAdvanceDays === null &&
    row.maxAdvanceDays === null
  );
}

export type RestrictionLayers = {
  /** ("*", "*") — every plan, every channel. */
  star?: RestrictionColumns | null;
  /** (plan, "*"). */
  plan?: RestrictionColumns | null;
  /** ("*", channel) — only when a channel is requested. */
  channelStar?: RestrictionColumns | null;
  /** (plan, channel) — only when a channel is requested. */
  channel?: RestrictionColumns | null;
};

/**
 * Effective restrictions of a cell. Precedence for NUMERIC values is
 * channel+plan > channel+* > plan > *: the most specific layer that has a
 * value wins (a `null` in the channel row falls through to the plan row).
 * FLAGS combine with OR: a closure set on any applicable layer applies (a
 * plan closed for everyone cannot be reopened by a channel row, which is what
 * OTAs expect — the base closure is the safety net).
 */
export function resolveRestrictions(layers: RestrictionLayers): RateRestrictions {
  const ordered = [layers.channel, layers.channelStar, layers.plan, layers.star].filter(
    (row): row is RestrictionColumns => Boolean(row)
  );
  const out: RateRestrictions = {};
  for (const key of RATE_RESTRICTION_KEYS) {
    const column = RESTRICTION_COLUMN_OF[key];
    if (BOOLEAN_KEYS.has(key)) {
      if (ordered.some((row) => row[column] === true)) (out as Record<string, unknown>)[key] = true;
    } else {
      const hit = ordered.find((row) => typeof row[column] === "number");
      if (hit) (out as Record<string, unknown>)[key] = hit[column];
    }
  }
  return out;
}

// ---- prices ------------------------------------------------------------------

/** Price the channel sees: base × (1 + markup/100), cents; null when there is no base. */
export function effectivePrice(base: number | null, markupPercent: number | null | undefined): number | null {
  if (base === null || base === undefined) return null;
  const markup = typeof markupPercent === "number" && Number.isFinite(markupPercent) ? markupPercent : 0;
  return round2(base * (1 + markup / 100));
}

// ---- sync --------------------------------------------------------------------

/** The subset of a ChannelDelivery row the merge needs. */
export type DeliveryLike = {
  id: string;
  channelId: string;
  kind: string;
  roomTypeId: string;
  ratePlanId: string;
  date: Date | string;
  status: string;
  lastError?: string | null;
  updatedAt: Date | string;
  createdAt?: Date | string;
};

/** cellKey(plan, type, date) → channelId → state. */
export type CellSyncMap = Record<string, Record<string, CellSyncState>>;

const SYNC_STATUSES: ReadonlySet<string> = new Set<CellSyncStatus>([
  "never",
  "queued",
  "sending",
  "sent",
  "confirmed",
  "rejected",
  "timeout",
  "superseded"
]);

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * Latest delivery per (channel, roomType, plan, date) → cell sync state. Only
 * `kind === "rates"` rows describe a price cell (availability rows are
 * room-level with ratePlanId "*"; restrictions rows are folded in when no
 * rates row exists for the cell, so a restriction-only push still shows).
 * "Latest" = greatest `updatedAt` (tie → createdAt → id) so a superseded
 * delivery never shadows its replacement.
 */
export function mergeCellSync(deliveries: DeliveryLike[]): CellSyncMap {
  const out: CellSyncMap = {};
  const stamp = new Map<string, { at: number; rank: number; id: string }>();
  const kindRank = (kind: string): number => (kind === "rates" ? 2 : kind === "restrictions" ? 1 : 0);
  for (const d of deliveries) {
    if (d.ratePlanId === "*" || d.kind === "availability") continue;
    const key = cellKey(d.ratePlanId, d.roomTypeId, dateKey(d.date));
    const at = new Date(d.updatedAt ?? d.createdAt ?? 0).getTime();
    const rank = kindRank(d.kind);
    const slot = `${key}|${d.channelId}`;
    const prev = stamp.get(slot);
    // A rates row always beats a restrictions row for the same cell; among the
    // same kind the most recent wins.
    if (prev && (prev.rank > rank || (prev.rank === rank && (prev.at > at || (prev.at === at && prev.id > d.id))))) continue;
    stamp.set(slot, { at, rank, id: d.id });
    const status = (SYNC_STATUSES.has(d.status) ? d.status : "never") as CellSyncStatus;
    (out[key] ??= {})[d.channelId] = {
      status,
      at: toIso(d.updatedAt ?? d.createdAt),
      error: d.status === "rejected" || d.status === "timeout" ? (d.lastError ?? null) : null,
      deliveryId: d.id
    };
  }
  return out;
}

/** Count of cells per channel per status (sync-status summary). */
export function summarizeSync(map: CellSyncMap): Record<string, Partial<Record<CellSyncStatus, number>>> {
  const summary: Record<string, Partial<Record<CellSyncStatus, number>>> = {};
  for (const byChannel of Object.values(map)) {
    for (const [channelId, state] of Object.entries(byChannel)) {
      const bucket = (summary[channelId] ??= {});
      bucket[state.status] = (bucket[state.status] ?? 0) + 1;
    }
  }
  return summary;
}
