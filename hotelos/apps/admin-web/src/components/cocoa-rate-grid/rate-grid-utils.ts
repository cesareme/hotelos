// CocoaRateGrid v2 — pure grid utilities (no React, no DOM).
//
//   · Row model (room type › plan › channel) and grid geometry.
//   · Client-side expansion of a `RateGridBulkOp` for the preview (the
//     backend expands for real; this mirrors its semantics: scope × weekdays,
//     price op, restrictions, derived children re-materialised, manual
//     overrides respected).
//   · Draft → diff items → consecutive date ranges grouped by type › plan.
//   · Fill / paste pattern geometry (spreadsheet behaviour).

import type {
  RateGridBulkOp,
  RateGridBulkUpdateRequest,
  RateGridCell,
  RateGridCellPatch,
  RateGridChannel,
  RateGridRatePlan,
  RateGridResponse,
  RateGridRoomType,
  RateRestrictionsPatch
} from "@hotelos/shared";
import {
  applyRestrictionsPatch,
  cellKey,
  computeDerivedPrice,
  eachDay,
  formatMoney,
  formatPercent,
  indexCells,
  isoWeekday,
  keyOfCell,
  parseCellKey,
  restrictionsEqual,
  round2,
  snapshotBefore,
  describeRestrictions,
  addDays,
  diffDays
} from "./helpers";
import type {
  PendingPush,
  BulkEditPreview,
  BulkEditPreviewRow,
  CellBeforeSnapshot,
  CellKey,
  ChannelProductMappingLite,
  DiffGroup,
  DiffItem,
  DiffRange,
  DraftEntry,
  DraftState,
  GridRow,
  RateGridView
} from "./types";
import { AVAILABILITY_PLAN_ID } from "./types";

/* ------------------------------------------------------------------ */
/*  Room type / plan ordering                                          */
/* ------------------------------------------------------------------ */

export function sortRoomTypes(roomTypes: RateGridRoomType[]): RateGridRoomType[] {
  return [...roomTypes].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.code.localeCompare(b.code));
}

/** Parents first (BAR at the very top), then derived children right under their parent. */
export function sortRatePlans(ratePlans: RateGridRatePlan[]): RateGridRatePlan[] {
  const active = ratePlans.filter((p) => p.active !== false);
  const parents = active.filter((p) => !p.parentRatePlanId);
  parents.sort((a, b) => {
    const aBar = isBarPlan(a) ? 0 : 1;
    const bBar = isBarPlan(b) ? 0 : 1;
    return aBar - bBar || a.code.localeCompare(b.code);
  });
  const out: RateGridRatePlan[] = [];
  const byParent = new Map<string, RateGridRatePlan[]>();
  for (const p of active) {
    if (!p.parentRatePlanId) continue;
    const list = byParent.get(p.parentRatePlanId) ?? [];
    list.push(p);
    byParent.set(p.parentRatePlanId, list);
  }
  const seen = new Set<string>();
  for (const parent of parents) {
    out.push(parent);
    seen.add(parent.id);
    for (const child of (byParent.get(parent.id) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      out.push(child);
      seen.add(child.id);
    }
  }
  // Orphans (parent inactive or missing) go last so nothing disappears silently.
  for (const p of active) if (!seen.has(p.id)) out.push(p);
  return out;
}

export function isBarPlan(plan: RateGridRatePlan): boolean {
  return plan.code.toUpperCase() === "BAR" || plan.ratePlanType?.toUpperCase() === "BAR";
}

export function findBarPlan(ratePlans: RateGridRatePlan[]): RateGridRatePlan | null {
  return ratePlans.find(isBarPlan) ?? null;
}

export function isDerivedPlan(plan: RateGridRatePlan): boolean {
  return Boolean(plan.parentRatePlanId) && plan.derivation?.mode !== undefined && plan.derivation.mode !== "none";
}

/* ------------------------------------------------------------------ */
/*  Channel mappings                                                   */
/* ------------------------------------------------------------------ */

/** Products (`${roomTypeId}|${ratePlanId}`) mapped per channel, from an explicit mapping list. */
export function indexProductMappings(mappings: ChannelProductMappingLite[] | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of mappings ?? []) {
    const set = out.get(m.channelId) ?? new Set<string>();
    set.add(`${m.roomTypeId}|${m.ratePlanId}`);
    out.set(m.channelId, set);
  }
  return out;
}

/**
 * Is `channel` mapped for a product? The explicit mapping list is authoritative
 * ONLY for the channels it covers (GET …/product-mappings per channel): a
 * channel absent from it (list not loaded, or its request failed) falls back to
 * the `cell.sync` keys of a sample cell (a delivery proves the mapping existed)
 * and finally to `mappedProducts > 0`. Treating a partial list as the whole
 * truth is what made «Revisar y publicar» offer «0 canales» for every product
 * except the one already synced in the window (browser-ux-final#1).
 */
export function isChannelMappedForProduct(
  channel: RateGridChannel,
  roomTypeId: string,
  ratePlanId: string,
  mappingIndex: Map<string, Set<string>>,
  sampleCell: RateGridCell | null | undefined
): boolean {
  const known = mappingIndex.get(channel.id);
  if (known) return known.has(`${roomTypeId}|${ratePlanId}`);
  if (sampleCell?.sync && channel.id in sampleCell.sync) return true;
  return channel.mappedProducts > 0;
}

/**
 * Channels mapped for a (roomType, ratePlan) product: see
 * `isChannelMappedForProduct` for the precedence (explicit mappings per
 * channel › sync keys › `mappedProducts`).
 */
export function channelsForProduct(
  roomTypeId: string,
  ratePlanId: string,
  channels: RateGridChannel[],
  mappings: ChannelProductMappingLite[] | undefined,
  sampleCell: RateGridCell | null | undefined
): RateGridChannel[] {
  const index = indexProductMappings(mappings);
  return channels.filter((c) => isChannelMappedForProduct(c, roomTypeId, ratePlanId, index, sampleCell));
}

/* ------------------------------------------------------------------ */
/*  Row model                                                          */
/* ------------------------------------------------------------------ */

export interface BuildRowsOptions {
  view: RateGridView;
  collapsed: Set<string>;
  showAvailability: boolean;
  channelMappings?: ChannelProductMappingLite[];
  /** Index used to sample a cell per product for mapping inference. */
  index: Map<CellKey, RateGridCell>;
  firstDate: string | null;
}

export function buildRows(response: RateGridResponse, opts: BuildRowsOptions): GridRow[] {
  const rows: GridRow[] = [];
  const roomTypes = sortRoomTypes(response.roomTypes);
  const plans = sortRatePlans(response.ratePlans);
  for (const rt of roomTypes) {
    const collapsed = opts.collapsed.has(rt.id);
    rows.push({ kind: "group", id: `group:${rt.id}`, roomType: rt, collapsed });
    if (collapsed) continue;
    if (opts.showAvailability) rows.push({ kind: "availability", id: `avail:${rt.id}`, roomType: rt });
    for (const plan of plans) {
      const derived = isDerivedPlan(plan);
      rows.push({ kind: "plan", id: `plan:${rt.id}:${plan.id}`, roomType: rt, ratePlan: plan, derived });
      if (opts.view === "channels") {
        const sample = opts.firstDate ? opts.index.get(cellKey(plan.id, rt.id, opts.firstDate)) : null;
        for (const channel of channelsForProduct(rt.id, plan.id, response.channels, opts.channelMappings, sample)) {
          rows.push({ kind: "channel", id: `channel:${rt.id}:${plan.id}:${channel.id}`, roomType: rt, ratePlan: plan, channel });
        }
      }
    }
  }
  return rows;
}

/** Key of the cell at (row, date); null for group rows. */
export function rowCellKey(row: GridRow, date: string): CellKey | null {
  switch (row.kind) {
    case "group":
      return null;
    case "availability":
      return cellKey(AVAILABILITY_PLAN_ID, row.roomType.id, date);
    case "plan":
      return cellKey(row.ratePlan.id, row.roomType.id, date);
    case "channel":
      return cellKey(row.ratePlan.id, row.roomType.id, date, row.channel.id);
    default:
      return null;
  }
}

export function isEditableRow(row: GridRow): boolean {
  return row.kind === "plan" || row.kind === "availability" || row.kind === "channel";
}

/* ------------------------------------------------------------------ */
/*  Geometry (selection rectangles, fill, paste)                        */
/* ------------------------------------------------------------------ */

export interface Coord {
  row: number;
  col: number;
}

export interface Rect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export function rectOf(a: Coord, b: Coord): Rect {
  return { r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row), c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) };
}

/** Bounding rect of a set of coords, or null when empty. */
export function boundingRect(coords: Coord[]): Rect | null {
  if (coords.length === 0) return null;
  let r0 = Infinity;
  let r1 = -Infinity;
  let c0 = Infinity;
  let c1 = -Infinity;
  for (const c of coords) {
    if (c.row < r0) r0 = c.row;
    if (c.row > r1) r1 = c.row;
    if (c.col < c0) c0 = c.col;
    if (c.col > c1) c1 = c.col;
  }
  return { r0, r1, c0, c1 };
}

/** True when coords fill the whole rect (rectangular selection). */
export function isRectangular(coords: Coord[], rect: Rect): boolean {
  const expected = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
  const set = new Set(coords.map((c) => `${c.row}:${c.col}`));
  return set.size === expected;
}

/**
 * Targets for a spreadsheet-style fill from `source` towards `target`
 * (either down or right, whichever the drag extended). Each target coord is
 * paired with the source coord whose value it copies (pattern tiles).
 */
export function fillTargets(source: Rect, target: Rect): Array<{ from: Coord; to: Coord }> {
  const out: Array<{ from: Coord; to: Coord }> = [];
  const h = source.r1 - source.r0 + 1;
  const w = source.c1 - source.c0 + 1;
  for (let r = target.r0; r <= target.r1; r++) {
    for (let c = target.c0; c <= target.c1; c++) {
      if (r >= source.r0 && r <= source.r1 && c >= source.c0 && c <= source.c1) continue;
      const from: Coord = {
        row: source.r0 + (((r - source.r0) % h) + h) % h,
        col: source.c0 + (((c - source.c0) % w) + w) % w
      };
      out.push({ from, to: { row: r, col: c } });
    }
  }
  return out;
}

/** Fill rect extended from `source` along the dominant axis of the drag end. */
export function extendFillRect(source: Rect, end: Coord): Rect {
  const dRow = end.row > source.r1 ? end.row - source.r1 : end.row < source.r0 ? end.row - source.r0 : 0;
  const dCol = end.col > source.c1 ? end.col - source.c1 : end.col < source.c0 ? end.col - source.c0 : 0;
  if (Math.abs(dRow) >= Math.abs(dCol)) {
    return dRow >= 0 ? { ...source, r1: Math.max(source.r1, end.row) } : { ...source, r0: Math.min(source.r0, end.row) };
  }
  return dCol >= 0 ? { ...source, c1: Math.max(source.c1, end.col) } : { ...source, c0: Math.min(source.c0, end.col) };
}

/** Ctrl+D / Ctrl+Shift+D: copy the first row (or column) of the rect over the rest. */
export function fillDirectionTargets(rect: Rect, direction: "right" | "down"): Array<{ from: Coord; to: Coord }> {
  const out: Array<{ from: Coord; to: Coord }> = [];
  if (direction === "right") {
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0 + 1; c <= rect.c1; c++) out.push({ from: { row: r, col: rect.c0 }, to: { row: r, col: c } });
  } else {
    for (let c = rect.c0; c <= rect.c1; c++) for (let r = rect.r0 + 1; r <= rect.r1; r++) out.push({ from: { row: rect.r0, col: c }, to: { row: r, col: c } });
  }
  return out;
}

/** Relative paste: clipboard coords normalised to (0,0) placed at `origin`. */
export function pasteTargets(entries: Coord[], origin: Coord, rows: number, cols: number): Array<{ from: Coord; to: Coord }> {
  const bounds = boundingRect(entries);
  if (!bounds) return [];
  const out: Array<{ from: Coord; to: Coord }> = [];
  for (const e of entries) {
    const to = { row: origin.row + (e.row - bounds.r0), col: origin.col + (e.col - bounds.c0) };
    if (to.row < 0 || to.col < 0 || to.row >= rows || to.col >= cols) continue;
    out.push({ from: e, to });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Bulk op expansion (client preview)                                  */
/* ------------------------------------------------------------------ */

export interface ExpandedPatch {
  patch: RateGridCellPatch;
  before: CellBeforeSnapshot;
  /** Child cell re-materialised because its parent changed. */
  derived: boolean;
  /** Manual override on a derived plan that the op would touch. */
  conflict: boolean;
  afterPrice: number | null;
  afterRestrictions: RateRestrictionsPatch | undefined;
}

export interface ExpandBulkOpResult {
  patches: ExpandedPatch[];
  conflicts: CellKey[];
  affectedRoomTypes: Set<string>;
  affectedPlans: Set<string>;
  affectedDays: Set<string>;
  derivedRecalculated: number;
}

function scopeDates(op: RateGridBulkOp): string[] {
  const days = eachDay(op.scope.from, op.scope.to);
  const weekdays = op.scope.weekdays && op.scope.weekdays.length > 0 ? new Set(op.scope.weekdays) : null;
  return weekdays ? days.filter((d) => weekdays.has(isoWeekday(d))) : days;
}

function priceAfter(op: RateGridBulkOp, base: number | null, copyFromPrice: number | null | undefined): number | null | undefined {
  const p = op.price;
  if (!p) return undefined;
  switch (p.mode) {
    case "set":
      return round2(Math.max(0, p.value));
    case "percent":
      return base === null ? undefined : round2(Math.max(0, base * (1 + p.value / 100)));
    case "amount":
      return base === null ? undefined : round2(Math.max(0, base + p.value));
    case "copyFrom":
      return copyFromPrice === null || copyFromPrice === undefined ? undefined : round2(copyFromPrice);
    case "floor":
      return base === null ? undefined : base < p.value ? round2(p.value) : undefined;
    case "ceiling":
      return base === null ? undefined : base > p.value ? round2(p.value) : undefined;
    default:
      return undefined;
  }
}

/**
 * Expand a bulk op against the response + current draft. Mirrors the backend:
 * every (plan, type, date) in scope gets a price/restrictions/available patch;
 * derived children of the touched plans are re-materialised unless they hold
 * a manual override (conflict when `respectManualOverrides !== false`).
 */
export function expandBulkOp(op: RateGridBulkOp, response: RateGridResponse, draft: DraftState | null, overwriteManual = false): ExpandBulkOpResult {
  const index = indexCells(response.cells);
  const dates = scopeDates(op);
  const roomTypeIds = op.scope.roomTypeIds && op.scope.roomTypeIds.length > 0 ? op.scope.roomTypeIds : sortRoomTypes(response.roomTypes).map((r) => r.id);
  const planIds = op.scope.ratePlanIds && op.scope.ratePlanIds.length > 0 ? op.scope.ratePlanIds : sortRatePlans(response.ratePlans).filter((p) => !isDerivedPlan(p)).map((p) => p.id);
  const plansById = new Map(response.ratePlans.map((p) => [p.id, p]));
  const childrenOf = new Map<string, RateGridRatePlan[]>();
  for (const p of response.ratePlans) {
    if (!p.parentRatePlanId || !isDerivedPlan(p)) continue;
    const l = childrenOf.get(p.parentRatePlanId) ?? [];
    l.push(p);
    childrenOf.set(p.parentRatePlanId, l);
  }
  const respect = op.respectManualOverrides !== false && !overwriteManual;

  const result: ExpandBulkOpResult = {
    patches: [],
    conflicts: [],
    affectedRoomTypes: new Set(),
    affectedPlans: new Set(),
    affectedDays: new Set(),
    derivedRecalculated: 0
  };

  const currentPrice = (key: CellKey): number | null => {
    const entry = draft?.patches.get(key);
    if (entry?.patch.price !== undefined) return entry.patch.price;
    return index.get(key)?.basePrice ?? null;
  };
  const currentRestrictions = (key: CellKey) => {
    const cell = index.get(key);
    const entry = draft?.patches.get(key);
    return applyRestrictionsPatch(cell?.restrictions ?? {}, entry?.patch.restrictions);
  };

  const emitted = new Set<CellKey>();

  for (const rtId of roomTypeIds) {
    for (const planId of planIds) {
      const plan = plansById.get(planId);
      if (!plan) continue;
      for (const date of dates) {
        const key = cellKey(planId, rtId, date);
        const cell = index.get(key) ?? null;
        const before = snapshotBefore(cell);
        const base = currentPrice(key);
        const manualOnDerived = Boolean(cell?.derivedFrom) && cell?.source === "manual";
        if (manualOnDerived && respect) {
          result.conflicts.push(key);
          continue;
        }
        const copyKey = op.price?.mode === "copyFrom" ? cellKey(planId, rtId, op.price.fromDate) : null;
        const after = priceAfter(op, base, copyKey ? currentPrice(copyKey) : undefined);
        const patch: RateGridCellPatch = { ratePlanId: planId, roomTypeId: rtId, date };
        let changed = false;
        if (after !== undefined && after !== base) {
          patch.price = after;
          changed = true;
        }
        if (op.restrictions && Object.keys(op.restrictions).length > 0) {
          const merged = applyRestrictionsPatch(currentRestrictions(key), op.restrictions);
          if (!restrictionsEqual(merged, currentRestrictions(key))) {
            patch.restrictions = { ...op.restrictions };
            changed = true;
          }
        }
        if (op.available !== undefined && op.available !== null && op.available !== (cell?.inventory?.available ?? null)) {
          patch.available = op.available;
          changed = true;
        }
        if (manualOnDerived && !respect) patch.convertToManual = true;
        if (!changed) continue;
        emitted.add(key);
        result.patches.push({
          patch,
          before,
          derived: false,
          conflict: manualOnDerived,
          afterPrice: patch.price !== undefined ? patch.price : base,
          afterRestrictions: patch.restrictions
        });
        result.affectedRoomTypes.add(rtId);
        result.affectedPlans.add(planId);
        result.affectedDays.add(date);

        // Derived children re-materialised when the parent price changed.
        if (patch.price === undefined) continue;
        for (const child of childrenOf.get(planId) ?? []) {
          const childKey = cellKey(child.id, rtId, date);
          if (emitted.has(childKey)) continue;
          const childCell = index.get(childKey) ?? null;
          if (childCell?.source === "manual" && respect) {
            result.conflicts.push(childKey);
            continue;
          }
          const childAfter = computeDerivedPrice(patch.price, child.derivation);
          const childBefore = snapshotBefore(childCell);
          if (childAfter === null || childAfter === currentPrice(childKey)) continue;
          emitted.add(childKey);
          result.patches.push({
            patch: { ratePlanId: child.id, roomTypeId: rtId, date, price: childAfter },
            before: childBefore,
            derived: true,
            conflict: false,
            afterPrice: childAfter,
            afterRestrictions: undefined
          });
          result.derivedRecalculated += 1;
          result.affectedPlans.add(child.id);
        }
      }
    }
  }
  return result;
}

/** Same expansion, but for one cell edit: returns the derived children patches to add alongside. */
export function derivedChildPatches(patch: RateGridCellPatch, response: RateGridResponse, draft: DraftState | null): Array<{ patch: RateGridCellPatch; before: CellBeforeSnapshot }> {
  if (patch.price === undefined || patch.price === null || patch.channelId) return [];
  const index = indexCells(response.cells);
  const out: Array<{ patch: RateGridCellPatch; before: CellBeforeSnapshot }> = [];
  for (const child of response.ratePlans) {
    if (child.parentRatePlanId !== patch.ratePlanId || !isDerivedPlan(child)) continue;
    const key = cellKey(child.id, patch.roomTypeId, patch.date);
    const cell = index.get(key) ?? null;
    const entry = draft?.patches.get(key);
    const isManual = (cell?.source === "manual" && !entry?.patch.revertToDerived) || entry?.patch.convertToManual;
    if (isManual) continue;
    const after = computeDerivedPrice(patch.price, child.derivation);
    if (after === null) continue;
    out.push({ patch: { ratePlanId: child.id, roomTypeId: patch.roomTypeId, date: patch.date, price: after }, before: snapshotBefore(cell) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Preview summary                                                     */
/* ------------------------------------------------------------------ */

export function buildBulkPreview(expanded: ExpandBulkOpResult, response: RateGridResponse, sampleSize = 5): BulkEditPreview {
  const rtName = new Map(response.roomTypes.map((r) => [r.id, r.name]));
  const planCode = new Map(response.ratePlans.map((p) => [p.id, p.code]));
  const sample: BulkEditPreviewRow[] = expanded.patches.slice(0, sampleSize).map((p) => ({
    key: cellKey(p.patch.ratePlanId, p.patch.roomTypeId, p.patch.date),
    roomTypeName: rtName.get(p.patch.roomTypeId) ?? p.patch.roomTypeId,
    ratePlanCode: planCode.get(p.patch.ratePlanId) ?? p.patch.ratePlanId,
    date: p.patch.date,
    beforePrice: p.before.basePrice,
    afterPrice: p.afterPrice,
    restrictionsSummary: p.afterRestrictions ? describeRestrictions(applyRestrictionsPatch(p.before.restrictions, p.afterRestrictions)) : null,
    derived: p.derived,
    conflict: p.conflict
  }));

  // Headline: first non-derived price change → "BAR 118→130 € (+10 %)".
  const first = expanded.patches.find((p) => !p.derived && p.patch.price !== undefined);
  let headline: string | null = null;
  if (first) {
    const code = planCode.get(first.patch.ratePlanId) ?? first.patch.ratePlanId;
    const b = first.before.basePrice;
    const a = first.afterPrice;
    const pct = b && a !== null ? formatPercent(((a - b) / b) * 100) : "";
    headline = `${code} ${b === null ? "sin tarifa" : formatMoney(b, response.currency)}→${formatMoney(a, response.currency)}${pct ? ` (${pct})` : ""}`;
  }

  return {
    affectedCells: expanded.patches.filter((p) => !p.derived).length,
    roomTypes: expanded.affectedRoomTypes.size,
    days: expanded.affectedDays.size,
    ratePlans: expanded.affectedPlans.size,
    sample,
    conflicts: expanded.conflicts,
    derivedRecalculated: expanded.derivedRecalculated,
    headline
  };
}

/* ------------------------------------------------------------------ */
/*  Diff                                                                */
/* ------------------------------------------------------------------ */

const PRICE_FIELD = "price";
const AVAILABLE_FIELD = "available";

/** Field-level diff of the draft (before → after). Skips no-op entries. */
export function diffDraft(draft: DraftState, who?: string | null): DiffItem[] {
  const out: DiffItem[] = [];
  for (const entry of draft.patches.values()) {
    out.push(...diffEntry(entry, who));
  }
  return out;
}

export function diffEntry(entry: DraftEntry, who?: string | null): DiffItem[] {
  const parsed = parseCellKey(entry.key);
  const meta = { key: entry.key, ratePlanId: parsed.ratePlanId, roomTypeId: parsed.roomTypeId, date: parsed.date, channelId: parsed.channelId ?? null, who: who ?? null, at: entry.at };
  const out: DiffItem[] = [];
  const p = entry.patch;
  if (p.price !== undefined && p.price !== entry.before.basePrice) out.push({ ...meta, field: PRICE_FIELD, before: entry.before.basePrice, after: p.price });
  if (p.available !== undefined && p.available !== (entry.before.available ?? null)) out.push({ ...meta, field: AVAILABLE_FIELD, before: entry.before.available ?? null, after: p.available });
  if (p.restrictions) {
    const after = applyRestrictionsPatch(entry.before.restrictions, p.restrictions);
    for (const key of Object.keys(p.restrictions) as Array<keyof RateRestrictionsPatch>) {
      const b = entry.before.restrictions[key] ?? null;
      const a = after[key] ?? null;
      if ((b ?? false) === (a ?? false)) continue;
      out.push({ ...meta, field: key, before: b, after: a });
    }
  }
  if (p.convertToManual) out.push({ ...meta, field: "source", before: "derived", after: "manual" });
  if (p.revertToDerived) out.push({ ...meta, field: "source", before: "manual", after: "derived" });
  return out;
}

/** Split sorted ISO dates into consecutive runs. */
export function groupConsecutiveDates(dates: string[]): Array<{ from: string; to: string; count: number }> {
  const sorted = [...new Set(dates)].sort();
  const out: Array<{ from: string; to: string; count: number }> = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d) {
      last.to = d;
      last.count += 1;
    } else {
      out.push({ from: d, to: d, count: 1 });
    }
  }
  return out;
}

function valueKey(v: unknown): string {
  return v === undefined ? "∅" : JSON.stringify(v);
}

/**
 * Group diff items by (type, plan, field, before→after) into consecutive
 * date ranges, then nest by room type › plan for the review drawer.
 */
export function groupDiffRanges(items: DiffItem[]): DiffRange[] {
  const buckets = new Map<string, { sample: DiffItem; dates: string[] }>();
  for (const it of items) {
    const k = [it.roomTypeId, it.ratePlanId, it.channelId ?? "", it.field, valueKey(it.before), valueKey(it.after), it.who ?? ""].join("\u0000");
    const b = buckets.get(k) ?? { sample: it, dates: [] };
    b.dates.push(it.date);
    buckets.set(k, b);
  }
  const out: DiffRange[] = [];
  for (const { sample, dates } of buckets.values()) {
    for (const run of groupConsecutiveDates(dates)) {
      out.push({ ratePlanId: sample.ratePlanId, roomTypeId: sample.roomTypeId, field: sample.field, from: run.from, to: run.to, count: run.count, before: sample.before, after: sample.after, who: sample.who ?? null });
    }
  }
  out.sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId) || a.ratePlanId.localeCompare(b.ratePlanId) || a.from.localeCompare(b.from) || a.field.localeCompare(b.field));
  return out;
}

export function groupDiffByTypeAndPlan(items: DiffItem[], roomTypes: RateGridRoomType[], ratePlans: RateGridRatePlan[]): DiffGroup[] {
  const ranges = groupDiffRanges(items);
  const rtById = new Map(roomTypes.map((r) => [r.id, r]));
  const planById = new Map(ratePlans.map((p) => [p.id, p]));
  const cellsByTypePlan = new Map<string, Set<string>>();
  for (const it of items) {
    const k = `${it.roomTypeId}\u0000${it.ratePlanId}`;
    const s = cellsByTypePlan.get(k) ?? new Set<string>();
    s.add(it.key);
    cellsByTypePlan.set(k, s);
  }
  const groups = new Map<string, DiffGroup>();
  for (const r of ranges) {
    let g = groups.get(r.roomTypeId);
    if (!g) {
      g = { roomTypeId: r.roomTypeId, roomTypeName: rtById.get(r.roomTypeId)?.name ?? r.roomTypeId, plans: [], cellCount: 0 };
      groups.set(r.roomTypeId, g);
    }
    let p = g.plans.find((x) => x.ratePlanId === r.ratePlanId);
    if (!p) {
      const plan = planById.get(r.ratePlanId);
      const cellCount = cellsByTypePlan.get(`${r.roomTypeId}\u0000${r.ratePlanId}`)?.size ?? 0;
      p = { ratePlanId: r.ratePlanId, ratePlanCode: plan?.code ?? (r.ratePlanId === AVAILABILITY_PLAN_ID ? "Disponibles" : r.ratePlanId), ratePlanName: plan?.name ?? "", ranges: [], cellCount };
      g.plans.push(p);
      g.cellCount += cellCount;
    }
    p.ranges.push(r);
  }
  const order = new Map(sortRoomTypes(roomTypes).map((r, i) => [r.id, i]));
  return [...groups.values()].sort((a, b) => (order.get(a.roomTypeId) ?? 999) - (order.get(b.roomTypeId) ?? 999));
}

/* ------------------------------------------------------------------ */
/*  Draft summary                                                       */
/* ------------------------------------------------------------------ */

export interface DraftSummary {
  cells: number;
  roomTypes: number;
  ratePlans: number;
  days: number;
  from: string | null;
  to: string | null;
}

export function summarizeDraft(draft: DraftState): DraftSummary {
  const rts = new Set<string>();
  const plans = new Set<string>();
  const days = new Set<string>();
  let cells = 0;
  for (const entry of draft.patches.values()) {
    if (diffEntry(entry).length === 0) continue;
    cells += 1;
    const k = parseCellKey(entry.key);
    rts.add(k.roomTypeId);
    plans.add(k.ratePlanId);
    days.add(k.date);
  }
  const sorted = [...days].sort();
  return { cells, roomTypes: rts.size, ratePlans: plans.size, days: days.size, from: sorted[0] ?? null, to: sorted[sorted.length - 1] ?? null };
}

/** Count of draft cells that a channel would receive (mapped products only). */
export function countDraftCellsByChannel(draft: DraftState, response: RateGridResponse, mappings?: ChannelProductMappingLite[]): Record<string, number> {
  const index = indexCells(response.cells);
  const mappingIndex = indexProductMappings(mappings);
  const counts: Record<string, number> = {};
  for (const ch of response.channels) counts[ch.id] = 0;
  for (const entry of draft.patches.values()) {
    if (diffEntry(entry).length === 0) continue;
    const k = parseCellKey(entry.key);
    if (k.ratePlanId === AVAILABILITY_PLAN_ID) {
      // Availability goes to every channel mapped for any plan of the type
      // (same precedence as isChannelMappedForProduct: a channel the list
      // does not cover falls back to `mappedProducts`).
      for (const ch of response.channels) {
        const known = mappingIndex.get(ch.id);
        const mapped = known ? [...known].some((product) => product.startsWith(`${k.roomTypeId}|`)) : ch.mappedProducts > 0;
        if (mapped) counts[ch.id] = (counts[ch.id] ?? 0) + 1;
      }
      continue;
    }
    const sample = index.get(cellKey(k.ratePlanId, k.roomTypeId, k.date));
    for (const ch of response.channels) {
      if (!isChannelMappedForProduct(ch, k.roomTypeId, k.ratePlanId, mappingIndex, sample)) continue;
      if (k.channelId && k.channelId !== ch.id) continue;
      counts[ch.id] = (counts[ch.id] ?? 0) + 1;
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/*  Review / publish drawer mode                                       */
/* ------------------------------------------------------------------ */

export type ReviewDrawerMode = "publish" | "push";

/**
 * Which flow the drawer shows. While nothing is in flight it follows the data
 * (empty draft + saved-but-unsent cells → «Enviar a canales»); once a publish
 * or a send is running the draft (or the pendingPush) is already flushed, so
 * the drawer keeps the mode that STARTED it instead of flipping the title,
 * subtitle and callout to the other flow under the progress bar
 * (browser-ux-final#10).
 */
export function resolveReviewDrawerMode(input: { idle: boolean; draftCells: number; pendingPushCount: number; canPush: boolean; startedAsPush: boolean }): ReviewDrawerMode {
  if (!input.idle) return input.startedAsPush ? "push" : "publish";
  return input.draftCells === 0 && input.canPush && input.pendingPushCount > 0 ? "push" : "publish";
}

/** Draft → contract `cells` array (merged patches, no-ops dropped). */
export function draftToCellPatches(draft: DraftState): RateGridCellPatch[] {
  const out: RateGridCellPatch[] = [];
  for (const entry of draft.patches.values()) {
    if (diffEntry(entry).length === 0) continue;
    out.push({ ...entry.patch });
  }
  return out;
}

/** Visible span helper for the bulk sheet default range. */
export function spanOfDates(dates: string[]): { from: string; to: string } | null {
  if (dates.length === 0) return null;
  return { from: dates[0], to: dates[dates.length - 1] };
}

/* ------------------------------------------------------------------ */
/*  Saved-but-unsent cells (pendingPush)                               */
/* ------------------------------------------------------------------ */

/** Union of two pending ranges (a second save widens the window; the latest journal id wins). */
export function mergePendingPush(prev: PendingPush | null, next: PendingPush): PendingPush {
  if (!prev || prev.count === 0) return next;
  return {
    source: next.source,
    count: prev.count + next.count,
    from: prev.from < next.from ? prev.from : next.from,
    to: prev.to > next.to ? prev.to : next.to,
    ratePlanIds: Array.from(new Set([...prev.ratePlanIds, ...next.ratePlanIds])),
    roomTypeIds: Array.from(new Set([...prev.roomTypeIds, ...next.roomTypeIds])),
    journalId: next.journalId ?? prev.journalId,
    at: next.at,
    channelIds: next.channelIds && prev.channelIds ? Array.from(new Set([...prev.channelIds, ...next.channelIds])) : undefined
  };
}

/**
 * Scope of a bulk-update body (cells + ops) as a pendingPush: dates, plans and
 * room types touched. Ops without explicit ids cover every type/plan (the
 * push then fans out to all of them, which is what the backend does anyway).
 */
export function pendingPushFromRequest(req: RateGridBulkUpdateRequest, count: number, journalId: string | null, at: string): PendingPush | null {
  const dates: string[] = [];
  const plans = new Set<string>();
  const types = new Set<string>();
  for (const c of req.cells ?? []) {
    dates.push(c.date);
    if (c.ratePlanId !== AVAILABILITY_PLAN_ID) plans.add(c.ratePlanId);
    types.add(c.roomTypeId);
  }
  for (const o of req.ops ?? []) {
    dates.push(o.scope.from, o.scope.to);
    for (const id of o.scope.ratePlanIds ?? []) if (id !== AVAILABILITY_PLAN_ID) plans.add(id);
    for (const id of o.scope.roomTypeIds ?? []) types.add(id);
  }
  if (dates.length === 0 || count <= 0) return null;
  dates.sort();
  return { source: "save", count, from: dates[0], to: dates[dates.length - 1], ratePlanIds: [...plans], roomTypeIds: [...types], journalId, at };
}

export { diffDays, keyOfCell };
