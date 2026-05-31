// CocoaRateGrid — shared types for the rate grid editor.
//
// `RateGridCell` (the wire format) and `RateRestrictions` come from
// `@hotelos/shared`. Here we add only the UI-local types that the grid
// component, its sub-files, and its consumers need.

import type { RateGridCell, RateRestrictions } from "@hotelos/shared";

/** Minimal room type shape consumed by the grid (rows). */
export interface RoomType {
  id: string;
  code: string;
  name: string;
  baseOccupancy?: number;
}

/**
 * Patch applied to one cell on user edit. The grid only ever produces partial
 * updates: a price change, a restriction tweak, or both. Consumers translate
 * this into a backend bulk-update request.
 */
export interface RateGridCellPatch {
  price?: number;
  restrictions?: Partial<RateRestrictions>;
}

/** Unique cell id used internally for selection & focus tracking. */
export type CellId = string;

export interface CellCoord {
  row: number;
  col: number;
}

export interface CocoaRateGridProps {
  cells: RateGridCell[];
  roomTypes: RoomType[];
  dates: Date[];
  selectedChannelId?: string;
  onCellChange: (cellId: CellId, patch: RateGridCellPatch) => void;
  onSelectionChange: (cellIds: CellId[]) => void;
  readOnly?: boolean;
}

/**
 * Internal clipboard entry. We store the snapshot of effective price and
 * restrictions so paste can re-create both. The source coord lets us paste
 * patterns (e.g. a row of restrictions across a different row).
 */
export interface ClipboardEntry {
  coord: CellCoord;
  price: number;
  restrictions: RateRestrictions;
}

/** Visual status used to pick a cell background color. */
export type CellStatus =
  | "open"
  | "open-restricted"
  | "closed"
  | "stop-sell";
