// CocoaRateGrid — pure helper functions.
//
// Indexing, formatting, status classification, and selection-rectangle math.
// Kept side-effect free so the main component stays focused on rendering and
// event wiring.

import type { RateGridCell, RateRestrictions } from "@hotelos/shared";
import type {
  CellCoord,
  CellId,
  CellStatus,
  RoomType
} from "./types";

/* ------------------------------------------------------------------ */
/*  Indexing                                                           */
/* ------------------------------------------------------------------ */

/** Local YYYY-MM-DD, avoiding timezone surprises from `toISOString`. */
export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function makeCellId(roomTypeId: string, isoDate: string): CellId {
  return `${roomTypeId}__${isoDate}`;
}

/**
 * Build a lookup map keyed by `${roomTypeId}__${isoDate}`. Cells whose channel
 * does not match the selected one are skipped (caller filters before this).
 */
export function indexCells(cells: RateGridCell[]): Map<CellId, RateGridCell> {
  const idx = new Map<CellId, RateGridCell>();
  for (const c of cells) {
    idx.set(makeCellId(c.roomTypeId, c.date), c);
  }
  return idx;
}

export function coordFromId(
  id: CellId,
  roomTypes: RoomType[],
  isoDates: string[]
): CellCoord | null {
  const [roomTypeId, date] = id.split("__");
  const row = roomTypes.findIndex((r) => r.id === roomTypeId);
  const col = isoDates.indexOf(date);
  if (row < 0 || col < 0) return null;
  return { row, col };
}

export function idFromCoord(
  coord: CellCoord,
  roomTypes: RoomType[],
  isoDates: string[]
): CellId | null {
  const rt = roomTypes[coord.row];
  const dt = isoDates[coord.col];
  if (!rt || !dt) return null;
  return makeCellId(rt.id, dt);
}

/* ------------------------------------------------------------------ */
/*  Formatting                                                         */
/* ------------------------------------------------------------------ */

const PRICE_FMT = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return PRICE_FMT.format(value);
}

/** Short weekday + day-of-month (e.g. "Lun 12"). Localized in Spanish. */
export function formatDateHeader(date: Date): { weekday: string; day: string } {
  const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "short" })
    .format(date)
    .replace(/\.$/, "");
  const day = String(date.getDate());
  return { weekday, day };
}

export function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

/* ------------------------------------------------------------------ */
/*  Status & restrictions                                              */
/* ------------------------------------------------------------------ */

export function hasAnyRestriction(r: RateRestrictions | undefined): boolean {
  if (!r) return false;
  return Boolean(
    r.cta ||
      r.ctd ||
      r.closed ||
      r.stopSell ||
      (typeof r.minLos === "number" && r.minLos > 1) ||
      (typeof r.maxLos === "number" && r.maxLos > 0)
  );
}

export function classifyStatus(cell: RateGridCell | undefined): CellStatus {
  if (!cell) return "open";
  const r = cell.restrictions;
  if (r?.stopSell) return "stop-sell";
  if (r?.closed) return "closed";
  if (hasAnyRestriction(r)) return "open-restricted";
  return "open";
}

/* ------------------------------------------------------------------ */
/*  Selection geometry                                                 */
/* ------------------------------------------------------------------ */

/** Inclusive rectangular range between two coords, in row-major order. */
export function rangeIds(
  a: CellCoord,
  b: CellCoord,
  roomTypes: RoomType[],
  isoDates: string[]
): CellId[] {
  const r0 = Math.min(a.row, b.row);
  const r1 = Math.max(a.row, b.row);
  const c0 = Math.min(a.col, b.col);
  const c1 = Math.max(a.col, b.col);
  const ids: CellId[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const id = idFromCoord({ row: r, col: c }, roomTypes, isoDates);
      if (id) ids.push(id);
    }
  }
  return ids;
}

/** Clamp a coord inside the grid bounds. */
export function clampCoord(
  coord: CellCoord,
  rows: number,
  cols: number
): CellCoord {
  return {
    row: Math.max(0, Math.min(rows - 1, coord.row)),
    col: Math.max(0, Math.min(cols - 1, coord.col))
  };
}

/* ------------------------------------------------------------------ */
/*  Set helpers                                                        */
/* ------------------------------------------------------------------ */

export function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function setToSortedArray<T>(s: Set<T>): T[] {
  return Array.from(s).sort();
}
