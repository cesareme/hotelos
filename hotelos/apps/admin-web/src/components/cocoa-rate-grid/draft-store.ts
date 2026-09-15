// CocoaRateGrid v2 — draft store (pure reducer, undo/redo, serialization).
//
// The draft is the set of unpublished cell patches. Every user operation
// (cell edit, quick edit, bulk op, recommendation action) is one undoable
// step: we keep immutable snapshots of `DraftState` in `past` / `future`
// (Map copies are cheap at the grid's scale: ≤ 36 500 entries).
//
// Merging rule: a later patch on the same cell merges over the earlier one
// (restrictions shallow-merged), keeping the FIRST `before` snapshot so the
// diff always shows persisted → draft. Entries that end up equal to their
// `before` are pruned so "edit then undo by hand" leaves no ghost change.
//
// Serialization targets localStorage per (property, user) for autosave and
// the "Tienes N cambios sin publicar de ayer · Restaurar / Descartar" banner.
// No DOM access here — the hook in `useRateGridDraft.ts` does the I/O.

import type { RateGridBulkOp, RateGridCellPatch } from "@hotelos/shared";
import { applyRestrictionsPatch, clientId, restrictionsEqual } from "./helpers";
import { diffEntry } from "./rate-grid-utils";
import type { CellBeforeSnapshot, CellKey, DraftBulkOp, DraftEntry, DraftOrigin, DraftState } from "./types";

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

export interface DraftStoreState {
  present: DraftState;
  past: DraftState[];
  future: DraftState[];
}

export const MAX_HISTORY = 100;

export function emptyDraft(): DraftState {
  return { patches: new Map(), ops: [], rejectedRecommendations: new Map(), updatedAt: null };
}

export function initialDraftStore(present: DraftState = emptyDraft()): DraftStoreState {
  return { present, past: [], future: [] };
}

export function draftIsEmpty(draft: DraftState): boolean {
  return draft.patches.size === 0 && draft.ops.length === 0 && draft.rejectedRecommendations.size === 0;
}

/** Number of cells with a visible change (no-ops excluded). */
export function draftChangeCount(draft: DraftState): number {
  let n = 0;
  for (const e of draft.patches.values()) if (diffEntry(e).length > 0) n += 1;
  return n;
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

export interface PatchWithBefore {
  patch: RateGridCellPatch;
  before: CellBeforeSnapshot;
}

export type DraftAction =
  | { type: "cell"; patch: RateGridCellPatch; before: CellBeforeSnapshot; origin?: DraftOrigin; extra?: PatchWithBefore[]; now?: string }
  | { type: "quick"; patches: PatchWithBefore[]; now?: string }
  | { type: "bulk"; op: RateGridBulkOp; reason: string; patches: PatchWithBefore[]; id?: string; now?: string }
  | { type: "recommendation"; key: CellKey; action: "accept" | "adjust" | "reject"; patch?: PatchWithBefore; reason?: string; now?: string }
  | { type: "discardCells"; keys: CellKey[]; now?: string }
  /**
   * Cierre 2026-09-15 · after a 409 «la celda cambió desde que se cargó» the
   * grid is reloaded and the kept entries must be re-based on the fresh
   * server values: `before` (and therefore `expected`) is replaced by the
   * given snapshot so the diff reads server → draft and the next save no
   * longer conflicts. Entries equal to their new `before` are pruned; keys
   * without a snapshot are left untouched. Not an undo step by itself.
   */
  | { type: "rebase"; snapshots: Map<CellKey, CellBeforeSnapshot>; now?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" }
  | { type: "restore"; draft: DraftState };

/* ------------------------------------------------------------------ */
/*  Merge helpers                                                      */
/* ------------------------------------------------------------------ */

function keyOf(patch: RateGridCellPatch): CellKey {
  const base = `${patch.ratePlanId}|${patch.roomTypeId}|${patch.date}`;
  return patch.channelId ? `${base}|${patch.channelId}` : base;
}

function mergePatch(prev: RateGridCellPatch | undefined, next: RateGridCellPatch): RateGridCellPatch {
  if (!prev) return { ...next };
  const merged: RateGridCellPatch = { ...prev, ...next };
  if (prev.restrictions || next.restrictions) merged.restrictions = { ...(prev.restrictions ?? {}), ...(next.restrictions ?? {}) };
  // convertToManual / revertToDerived are mutually exclusive: the latest wins.
  if (next.convertToManual) delete merged.revertToDerived;
  if (next.revertToDerived) {
    delete merged.convertToManual;
    delete merged.price;
  }
  return merged;
}

/** True when the merged patch changes nothing vs the persisted snapshot. */
export function isNoopEntry(entry: DraftEntry): boolean {
  const p = entry.patch;
  if (p.convertToManual || p.revertToDerived) return false;
  if (p.price !== undefined && p.price !== entry.before.basePrice) return false;
  if (p.available !== undefined && p.available !== (entry.before.available ?? null)) return false;
  if (p.restrictions && !restrictionsEqual(applyRestrictionsPatch(entry.before.restrictions, p.restrictions), entry.before.restrictions)) return false;
  if (p.occupancyPrices !== undefined || p.minPrice !== undefined || p.maxPrice !== undefined) return false;
  return true;
}

function upsert(patches: Map<CellKey, DraftEntry>, item: PatchWithBefore, origin: DraftOrigin, now: string, reason?: string | null): void {
  const key = keyOf(item.patch);
  const prev = patches.get(key);
  const entry: DraftEntry = {
    key,
    patch: mergePatch(prev?.patch, item.patch),
    before: prev?.before ?? item.before,
    origin,
    at: now,
    reason: reason ?? prev?.reason ?? null
  };
  if (isNoopEntry(entry)) patches.delete(key);
  else patches.set(key, entry);
}

function commit(state: DraftStoreState, next: DraftState): DraftStoreState {
  const past = [...state.past, state.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { present: next, past, future: [] };
}

function nowIso(explicit?: string): string {
  return explicit ?? new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/*  Reducer                                                            */
/* ------------------------------------------------------------------ */

export function draftReducer(state: DraftStoreState, action: DraftAction): DraftStoreState {
  switch (action.type) {
    case "cell": {
      const now = nowIso(action.now);
      const patches = new Map(state.present.patches);
      upsert(patches, { patch: action.patch, before: action.before }, action.origin ?? "cell", now);
      for (const extra of action.extra ?? []) upsert(patches, extra, action.origin ?? "cell", now);
      return commit(state, { ...state.present, patches, updatedAt: now });
    }
    case "quick": {
      if (action.patches.length === 0) return state;
      const now = nowIso(action.now);
      const patches = new Map(state.present.patches);
      for (const item of action.patches) upsert(patches, item, "quick", now);
      return commit(state, { ...state.present, patches, updatedAt: now });
    }
    case "bulk": {
      const now = nowIso(action.now);
      const patches = new Map(state.present.patches);
      for (const item of action.patches) upsert(patches, item, "bulk", now, action.reason);
      const op: DraftBulkOp = { id: action.id ?? clientId("bulk"), op: action.op, reason: action.reason, previewKeys: action.patches.map((p) => keyOf(p.patch)), at: now };
      return commit(state, { ...state.present, patches, ops: [...state.present.ops, op], updatedAt: now });
    }
    case "recommendation": {
      const now = nowIso(action.now);
      const patches = new Map(state.present.patches);
      const rejected = new Map(state.present.rejectedRecommendations);
      if (action.action === "reject") {
        rejected.set(action.key, action.reason ?? "");
        patches.delete(action.key);
      } else {
        rejected.delete(action.key);
        if (action.patch) upsert(patches, action.patch, "recommendation", now, action.reason ?? (action.action === "accept" ? "Recomendación aceptada" : "Recomendación ajustada"));
      }
      return commit(state, { ...state.present, patches, rejectedRecommendations: rejected, updatedAt: now });
    }
    case "discardCells": {
      if (action.keys.length === 0) return state;
      const patches = new Map(state.present.patches);
      let touched = false;
      for (const k of action.keys) if (patches.delete(k)) touched = true;
      if (!touched) return state;
      return commit(state, { ...state.present, patches, updatedAt: nowIso(action.now) });
    }
    case "rebase": {
      if (action.snapshots.size === 0) return state;
      const patches = new Map(state.present.patches);
      let touched = false;
      for (const [key, before] of action.snapshots) {
        const entry = patches.get(key);
        if (!entry) continue;
        touched = true;
        const next: DraftEntry = { ...entry, before };
        if (isNoopEntry(next)) patches.delete(key);
        else patches.set(key, next);
      }
      if (!touched) return state;
      return commit(state, { ...state.present, patches, updatedAt: nowIso(action.now) });
    }
    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { present: prev, past: state.past.slice(0, -1), future: [state.present, ...state.future] };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return { present: next, past: [...state.past, state.present], future: state.future.slice(1) };
    }
    case "clear": {
      if (draftIsEmpty(state.present)) return state;
      return commit(state, emptyDraft());
    }
    case "restore":
      return { present: action.draft, past: [], future: [] };
    default:
      return state;
  }
}

export function canUndo(state: DraftStoreState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: DraftStoreState): boolean {
  return state.future.length > 0;
}

/* ------------------------------------------------------------------ */
/*  Serialization (localStorage autosave)                              */
/* ------------------------------------------------------------------ */

export const DRAFT_STORAGE_VERSION = 2;

export interface SerializedDraft {
  v: number;
  propertyId: string;
  userId: string;
  savedAt: string;
  updatedAt: string | null;
  patches: DraftEntry[];
  ops: DraftBulkOp[];
  rejected: Array<[CellKey, string]>;
}

export function draftStorageKey(propertyId: string, userId: string): string {
  return `anfitorio.rate-grid.draft.${propertyId}.${userId}`;
}

export function serializeDraft(draft: DraftState, propertyId: string, userId: string, savedAt: string = new Date().toISOString()): string {
  const payload: SerializedDraft = {
    v: DRAFT_STORAGE_VERSION,
    propertyId,
    userId,
    savedAt,
    updatedAt: draft.updatedAt,
    patches: [...draft.patches.values()],
    ops: draft.ops,
    rejected: [...draft.rejectedRecommendations.entries()]
  };
  return JSON.stringify(payload);
}

/** Returns null on any malformed / foreign payload (never throws). */
export function deserializeDraft(raw: string | null | undefined, propertyId?: string, userId?: string): { draft: DraftState; savedAt: string } | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<SerializedDraft>;
    if (!data || data.v !== DRAFT_STORAGE_VERSION || !Array.isArray(data.patches)) return null;
    if (propertyId && data.propertyId !== propertyId) return null;
    if (userId && data.userId !== userId) return null;
    const patches = new Map<CellKey, DraftEntry>();
    for (const e of data.patches) {
      if (!e || typeof e.key !== "string" || !e.patch || !e.before) continue;
      patches.set(e.key, { key: e.key, patch: e.patch, before: e.before, origin: e.origin ?? "cell", at: e.at ?? data.savedAt ?? new Date(0).toISOString(), reason: e.reason ?? null });
    }
    const rejected = new Map<CellKey, string>();
    for (const pair of data.rejected ?? []) if (Array.isArray(pair) && typeof pair[0] === "string") rejected.set(pair[0], String(pair[1] ?? ""));
    const draft: DraftState = { patches, ops: Array.isArray(data.ops) ? data.ops : [], rejectedRecommendations: rejected, updatedAt: data.updatedAt ?? null };
    return { draft, savedAt: typeof data.savedAt === "string" ? data.savedAt : new Date(0).toISOString() };
  } catch {
    // Corrupt localStorage payload: treat as "no saved draft" rather than crashing the editor.
    return null;
  }
}

/** "de ayer" / "de hoy" / "del 12 mar" for the restore banner. */
export function describeSavedAt(savedAtIso: string, now: Date = new Date()): string {
  const saved = new Date(savedAtIso);
  if (Number.isNaN(saved.getTime())) return "";
  const dayMs = 86_400_000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (saved.getTime() >= startOfToday) return "de hoy";
  if (saved.getTime() >= startOfToday - dayMs) return "de ayer";
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `del ${saved.getDate()} ${months[saved.getMonth()]}`;
}
