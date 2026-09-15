// CocoaRateGrid v2 — spreadsheet-style rate editor (virtualised, keyboard-first).
//
// Layout: one scroll container (role=grid) with a sticky date header and a
// body sizer whose rows are absolutely positioned. Only the rows/columns in
// the visible window (+ overscan) are mounted — our own windowing on top of
// the scroll position, no third-party dependency. Target: 100 rows × 365
// days at 60 fps (≈ 1 500 mounted cells for a 1 400 × 700 viewport).
//
// State ownership
//   · `selection` and `draft` are owned by the screen (props); the grid only
//     emits `onSelectionChange` / `onCellEdit`.
//   · Local UI state: inline editor, fill-drag, collapse (unless controlled),
//     scroll window, "convert to manual" confirmation.
//
// Pointer: click (replace) · ctrl/cmd+click (toggle) · shift+click (range)
//   · drag (rectangle; on release with ≥ 2 cells → onOpenQuickEdit) · date
//   header = column · row label = row · fill handle (bottom-right of the
//   selection) drags a copy of value + restrictions.
// Keyboard: arrows (±shift) · Enter/F2 edit · Enter commits & moves down ·
//   Tab commits & moves right · Esc · Supr (clear draft / revertToDerived) ·
//   Ctrl/Cmd+Z / Shift+Z · Ctrl/Cmd+C/V (relative pattern) · Ctrl/Cmd+D fill
//   right · Ctrl/Cmd+Shift+D fill down · Ctrl/Cmd+B bulk edit · Ctrl/Cmd+A
//   select all · Ctrl/Cmd+Enter quick edit · typing a digit/+/−/= starts
//   editing with that character.
//
// Focus: mousedown is NOT prevented, so the clicked cell (tabIndex −1/0)
// receives focus natively and keydown bubbles to the container. When the
// active cell scrolls out of the mounted window we focus the container.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { RateGridCell, RateGridCellPatch, RateRestrictionsPatch } from "@hotelos/shared";
import { CocoaAlert } from "../cocoa-extras/CocoaAlert";
import type { CellCommitMode } from "./CocoaRateGridCell";
import { GridRowView } from "./CocoaRateGridRows";
import { RateGridHeader } from "./RateGridHeader";
import { evaluateInput, isExpressionStartChar } from "./expressions";
import { RESTRICTION_KEYS, cellKey, formatMoney, indexCells, parseCellKey, resolveViewCell, todayIso } from "./helpers";
import {
  boundingRect,
  buildRows,
  extendFillRect,
  fillDirectionTargets,
  fillTargets,
  findBarPlan,
  groupConsecutiveDates,
  isRectangular,
  pasteTargets,
  rectOf,
  rowCellKey,
  sortRatePlans,
  type Coord,
  type Rect
} from "./rate-grid-utils";
import { AVAILABILITY_PLAN_ID, EMPTY_SELECTION, type BulkEditPrefill, type CellKey, type CocoaRateGridProps, type GridRow, type Selection } from "./types";

// Styles are attached once per document. The import is DOM-guarded so the
// component can be rendered with react-dom/server (node:test benchmark)
// where a `.css` import has no meaning; Vite turns it into a CSS chunk.
if (typeof document !== "undefined") void import("./rate-grid.css");

const OVERSCAN_ROWS = 4;
const OVERSCAN_COLS = 4;

const SIZES = {
  comfortable: { cellWidth: 84, rowHeight: 44, labelWidth: 220, headerHeight: 44, demandHeight: 34 },
  compact: { cellWidth: 68, rowHeight: 34, labelWidth: 190, headerHeight: 40, demandHeight: 34 }
} as const;

type ClipEntry = { coord: Coord; price: number | null; restrictions: RateRestrictionsPatch; available: number | null };

function rowIdentity(row: GridRow): string | null {
  switch (row.kind) {
    case "availability":
      return `${AVAILABILITY_PLAN_ID}|${row.roomType.id}`;
    case "plan":
      return `${row.ratePlan.id}|${row.roomType.id}`;
    case "channel":
      return `${row.ratePlan.id}|${row.roomType.id}|${row.channel.id}`;
    default:
      return null;
  }
}

function identityOfKey(key: CellKey): string {
  const k = parseCellKey(key);
  return k.channelId ? `${k.ratePlanId}|${k.roomTypeId}|${k.channelId}` : `${k.ratePlanId}|${k.roomTypeId}`;
}

export function CocoaRateGrid(props: CocoaRateGridProps) {
  const {
    response,
    dates,
    view,
    layers,
    draft,
    selection,
    onSelectionChange,
    onCellEdit,
    onOpenQuickEdit,
    onOpenBulkEdit,
    onOpenRecommendation,
    onCellRecommendationAction,
    readOnly = false,
    density = "comfortable",
    propertyName,
    showAvailability,
    canEditAvailability = true,
    channelMappings,
    onUndo,
    onRedo,
    onDiscardCells,
    collapsedRoomTypeIds,
    onCollapsedChange,
    maxHeight = "70vh",
    today: todayProp,
    initialViewport,
    onEditRefused,
    syncUnavailable = false
  } = props;

  const sizes = SIZES[density];
  const { cellWidth, rowHeight, labelWidth, headerHeight, demandHeight } = sizes;
  const today = todayProp ?? todayIso();
  const showDemand = layers.demand && Boolean(response.demand && response.demand.length);
  const headerTotal = headerHeight + (showDemand ? demandHeight : 0);

  /* ------------------ Derived data ------------------ */

  const index = useMemo(() => indexCells(response.cells), [response.cells]);
  const [collapsedInternal, setCollapsedInternal] = useState<string[]>([]);
  const collapsedIds = collapsedRoomTypeIds ?? collapsedInternal;
  const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const hasInventory = useMemo(() => response.cells.some((c) => c.inventory), [response.cells]);
  const showAvail = showAvailability ?? hasInventory;

  const rows = useMemo(
    () => buildRows(response, { view, collapsed: collapsedSet, showAvailability: showAvail, channelMappings, index, firstDate: dates[0] ?? null }),
    [response, view, collapsedSet, showAvail, channelMappings, index, dates]
  );
  const rowIndexByIdentity = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      const id = rowIdentity(r);
      if (id) m.set(id, i);
    });
    return m;
  }, [rows]);
  const colByDate = useMemo(() => new Map(dates.map((d, i) => [d, i])), [dates]);
  const editableRowCount = useMemo(() => rows.filter((r) => r.kind !== "group").length, [rows]);
  const sortedPlans = useMemo(() => sortRatePlans(response.ratePlans), [response.ratePlans]);
  const barPlan = useMemo(() => findBarPlan(response.ratePlans), [response.ratePlans]);
  const inventoryPlanId = barPlan?.id ?? sortedPlans[0]?.id ?? null;
  const channelNames = useMemo(() => Object.fromEntries(response.channels.map((c) => [c.id, c.name])), [response.channels]);

  const selectionSet = useMemo(() => new Set(selection.keys), [selection.keys]);
  const { selectedColumns, selectedRowIdentities } = useMemo(() => {
    const perCol = new Map<number, number>();
    const perRow = new Map<string, number>();
    for (const key of selection.keys) {
      const k = parseCellKey(key);
      const col = colByDate.get(k.date);
      if (col !== undefined) perCol.set(col, (perCol.get(col) ?? 0) + 1);
      const id = identityOfKey(key);
      perRow.set(id, (perRow.get(id) ?? 0) + 1);
    }
    const cols = new Set<number>();
    for (const [c, n] of perCol) if (editableRowCount > 0 && n >= editableRowCount) cols.add(c);
    const rowsSel = new Set<string>();
    for (const [id, n] of perRow) if (n >= dates.length && dates.length > 0) rowsSel.add(id);
    return { selectedColumns: cols, selectedRowIdentities: rowsSel };
  }, [selection.keys, colByDate, editableRowCount, dates.length]);

  /* ------------------ Coordinates ------------------ */

  const coordOfKey = useCallback(
    (key: CellKey): Coord | null => {
      const k = parseCellKey(key);
      const row = rowIndexByIdentity.get(identityOfKey(key));
      const col = colByDate.get(k.date);
      if (row === undefined || col === undefined) return null;
      return { row, col };
    },
    [rowIndexByIdentity, colByDate]
  );
  const keyOfCoord = useCallback(
    (c: Coord): CellKey | null => {
      const row = rows[c.row];
      const date = dates[c.col];
      if (!row || !date) return null;
      return rowCellKey(row, date);
    },
    [rows, dates]
  );
  const keysInRect = useCallback(
    (rect: Rect): CellKey[] => {
      const out: CellKey[] = [];
      for (let r = rect.r0; r <= rect.r1; r++) {
        if (!rows[r] || rows[r].kind === "group") continue;
        for (let c = rect.c0; c <= rect.c1; c++) {
          const k = keyOfCoord({ row: r, col: c });
          if (k) out.push(k);
        }
      }
      return out;
    },
    [rows, keyOfCoord]
  );
  const nextEditableRow = useCallback(
    (from: number, dir: 1 | -1): number => {
      let r = from + dir;
      while (r >= 0 && r < rows.length && rows[r].kind === "group") r += dir;
      if (r < 0 || r >= rows.length) return from;
      return r;
    },
    [rows]
  );

  /* ------------------ Cell lookups ------------------ */

  const cellForKey = useCallback(
    (key: CellKey): RateGridCell | null => {
      const k = parseCellKey(key);
      if (k.ratePlanId === AVAILABILITY_PLAN_ID) return inventoryPlanId ? (index.get(cellKey(inventoryPlanId, k.roomTypeId, k.date)) ?? null) : null;
      return index.get(cellKey(k.ratePlanId, k.roomTypeId, k.date)) ?? null;
    },
    [index, inventoryPlanId]
  );
  const viewOfKey = useCallback((key: CellKey) => resolveViewCell(key, cellForKey(key), draft.patches.get(key) ?? null), [cellForKey, draft.patches]);
  const barPriceFor = useCallback(
    (roomTypeId: string, date: string): number | null => {
      if (!barPlan) return null;
      return viewOfKey(cellKey(barPlan.id, roomTypeId, date)).basePrice;
    },
    [barPlan, viewOfKey]
  );
  const rowOfKey = useCallback((key: CellKey): GridRow | null => {
    const i = rowIndexByIdentity.get(identityOfKey(key));
    return i === undefined ? null : rows[i];
  }, [rowIndexByIdentity, rows]);
  const isLockedDerived = useCallback(
    (key: CellKey): boolean => {
      const row = rowOfKey(key);
      if (!row || row.kind !== "plan" || !row.derived) return false;
      return viewOfKey(key).derivedLocked;
    },
    [rowOfKey, viewOfKey]
  );
  const isCellEditable = useCallback(
    (key: CellKey): boolean => {
      if (readOnly) return false;
      const row = rowOfKey(key);
      if (!row || row.kind === "group") return false;
      if (row.kind === "availability" && !canEditAvailability) return false;
      return true;
    },
    [readOnly, rowOfKey, canEditAvailability]
  );

  /* ------------------ Selection emit ------------------ */

  const selectionRef = useRef<Selection>(selection);
  selectionRef.current = selection;
  const emitSelection = useCallback(
    (next: Selection) => {
      selectionRef.current = next;
      onSelectionChange(next);
    },
    [onSelectionChange]
  );
  const selectSingle = useCallback((key: CellKey) => emitSelection({ keys: [key], active: key, anchor: key }), [emitSelection]);
  const selectRange = useCallback(
    (anchorKey: CellKey, toKey: CellKey, additive: boolean) => {
      const a = coordOfKey(anchorKey);
      const b = coordOfKey(toKey);
      if (!a || !b) return;
      const keys = keysInRect(rectOf(a, b));
      const base = additive ? selectionRef.current.keys.filter((k) => !keys.includes(k)) : [];
      emitSelection({ keys: [...base, ...keys], active: toKey, anchor: anchorKey });
    },
    [coordOfKey, keysInRect, emitSelection]
  );

  /* ------------------ Scroll window ------------------ */

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() => ({ scrollTop: 0, scrollLeft: 0, width: initialViewport?.width ?? 0, height: initialViewport?.height ?? 0 }));
  const rafRef = useRef<number | null>(null);
  const syncViewport = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewport((prev) => {
      const next = { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, width: el.clientWidth, height: el.clientHeight };
      return prev.scrollTop === next.scrollTop && prev.scrollLeft === next.scrollLeft && prev.width === next.width && prev.height === next.height ? prev : next;
    });
  }, []);
  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      syncViewport();
    });
  }, [syncViewport]);
  useLayoutEffect(() => {
    syncViewport();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncViewport());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncViewport]);

  const totalWidth = labelWidth + dates.length * cellWidth;
  const totalHeight = rows.length * rowHeight;
  const rowStart = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - OVERSCAN_ROWS);
  const rowEnd = Math.min(rows.length - 1, Math.ceil((viewport.scrollTop + Math.max(viewport.height, 1) - headerTotal) / rowHeight) + OVERSCAN_ROWS);
  const colStart = Math.max(0, Math.floor(viewport.scrollLeft / cellWidth) - OVERSCAN_COLS);
  const colEnd = Math.min(dates.length - 1, Math.ceil((viewport.scrollLeft + Math.max(viewport.width, 1) - labelWidth) / cellWidth) + OVERSCAN_COLS);

  const ensureVisible = useCallback(
    (coord: Coord) => {
      const el = containerRef.current;
      if (!el) return;
      const top = coord.row * rowHeight;
      const bottom = top + rowHeight;
      const left = coord.col * cellWidth; // relative to label edge
      const right = left + cellWidth;
      const viewTop = el.scrollTop;
      const viewBottom = el.scrollTop + el.clientHeight - headerTotal;
      if (top < viewTop) el.scrollTop = top;
      else if (bottom > viewBottom) el.scrollTop = bottom - (el.clientHeight - headerTotal);
      const viewLeft = el.scrollLeft;
      const viewRight = el.scrollLeft + el.clientWidth - labelWidth;
      if (left < viewLeft) el.scrollLeft = left;
      else if (right > viewRight) el.scrollLeft = right - (el.clientWidth - labelWidth);
    },
    [rowHeight, cellWidth, headerTotal, labelWidth]
  );

  /* ------------------ Focus management ------------------ */

  const [editing, setEditing] = useState<{ key: CellKey; initial: string; convert: boolean } | null>(null);
  const focusActive = useCallback(() => {
    const el = containerRef.current;
    const active = selectionRef.current.active;
    if (!el || !active) return;
    if (!el.contains(document.activeElement)) return; // don't steal focus from popovers
    const node = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    if (node) node.focus({ preventScroll: true });
    else el.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (editing) return;
    focusActive();
  }, [selection.active, editing, focusActive, rowStart, colStart]);

  /* ------------------ Collapse ------------------ */

  const toggleGroup = useCallback(
    (roomTypeId: string) => {
      const next = collapsedIds.includes(roomTypeId) ? collapsedIds.filter((id) => id !== roomTypeId) : [...collapsedIds, roomTypeId];
      if (onCollapsedChange) onCollapsedChange(next);
      if (!collapsedRoomTypeIds) setCollapsedInternal(next);
    },
    [collapsedIds, onCollapsedChange, collapsedRoomTypeIds]
  );

  /* ------------------ Edits ------------------ */

  const emitPatch = useCallback(
    (key: CellKey, fields: Omit<RateGridCellPatch, "ratePlanId" | "roomTypeId" | "date" | "channelId">) => {
      const k = parseCellKey(key);
      const patch: RateGridCellPatch = { ratePlanId: k.ratePlanId, roomTypeId: k.roomTypeId, date: k.date, ...fields };
      if (k.channelId) patch.channelId = k.channelId;
      // A derived plan is read-only for the API: ANY price write on it (also on
      // a cell that already carries a manual override) needs convertToManual,
      // otherwise every cell conflicts (409 ALL_CELLS_CONFLICT on save).
      const row = rowOfKey(key);
      if (row?.kind === "plan" && row.derived && typeof patch.price === "number" && !patch.revertToDerived && !patch.convertToManual) {
        patch.convertToManual = true;
      }
      onCellEdit(patch);
    },
    [onCellEdit, rowOfKey]
  );

  const [convertPrompt, setConvertPrompt] = useState<{ key: CellKey; initial: string } | null>(null);

  const startEditing = useCallback(
    (key: CellKey, initial?: string) => {
      if (!isCellEditable(key)) return;
      const row = rowOfKey(key);
      if (row?.kind === "channel") {
        // No per-channel price on the API (base × markup): refuse the editor
        // up front instead of dropping the value on commit. Restrictions on
        // channel rows still go through quick / bulk edit.
        onEditRefused?.(key, "channel_price");
        return;
      }
      if (isLockedDerived(key)) {
        setConvertPrompt({ key, initial: initial ?? "" });
        return;
      }
      const v = viewOfKey(key);
      const current = row?.kind === "availability" ? (v.available === null ? "" : String(v.available)) : v.basePrice === null ? "" : String(v.basePrice).replace(".", ",");
      setEditing({ key, initial: initial ?? current, convert: false });
    },
    [isCellEditable, isLockedDerived, viewOfKey, rowOfKey, onEditRefused]
  );

  const confirmConvert = useCallback(() => {
    if (!convertPrompt) return;
    const { key, initial } = convertPrompt;
    const v = viewOfKey(key);
    emitPatch(key, { price: v.basePrice, convertToManual: true });
    setConvertPrompt(null);
    setEditing({ key, initial: initial || (v.basePrice === null ? "" : String(v.basePrice).replace(".", ",")), convert: true });
  }, [convertPrompt, viewOfKey, emitPatch]);

  const moveActive = useCallback(
    (dRow: number, dCol: number, extend: boolean) => {
      const sel = selectionRef.current;
      const activeKey = sel.active ?? keyOfCoord({ row: nextEditableRow(-1, 1), col: 0 });
      if (!activeKey) return;
      const c = coordOfKey(activeKey);
      if (!c) return;
      let row = c.row;
      if (dRow !== 0) {
        const n = nextEditableRow(row, dRow > 0 ? 1 : -1);
        row = n;
      }
      const col = Math.max(0, Math.min(dates.length - 1, c.col + dCol));
      const nextKey = keyOfCoord({ row, col });
      if (!nextKey) return;
      ensureVisible({ row, col });
      if (extend) selectRange(sel.anchor ?? activeKey, nextKey, false);
      else selectSingle(nextKey);
    },
    [keyOfCoord, nextEditableRow, coordOfKey, dates.length, ensureVisible, selectRange, selectSingle]
  );

  const commitEdit = useCallback(
    (key: CellKey, raw: string, mode: CellCommitMode) => {
      // Keep focus inside the grid before the input unmounts: otherwise the
      // browser drops it on <body> and `focusActive` (which refuses to steal
      // focus from outside the grid) leaves Ctrl+Z / arrows dead right after
      // Enter until the user clicks a cell again. The editor's onBlur commit
      // is a no-op here (already committed).
      containerRef.current?.focus({ preventScroll: true });
      setEditing(null);
      const trimmed = raw.trim();
      if (mode !== "escape" && trimmed !== "") {
        const row = rowOfKey(key);
        const k = parseCellKey(key);
        if (row?.kind === "availability") {
          const n = Number.parseInt(trimmed, 10);
          if (Number.isFinite(n) && n >= 0) emitPatch(key, { available: n });
        } else if (row) {
          const v = viewOfKey(key);
          const result = evaluateInput(trimmed, { current: v.basePrice, bar: barPriceFor(k.roomTypeId, k.date), hasBar: Boolean(barPlan) });
          if (result.ok && result.value !== v.basePrice) emitPatch(key, { price: result.value });
        }
      }
      if (mode === "enter") moveActive(1, 0, false);
      else if (mode === "shift-enter") moveActive(-1, 0, false);
      else if (mode === "tab") moveActive(0, 1, false);
      else if (mode === "shift-tab") moveActive(0, -1, false);
      else window.requestAnimationFrame(() => focusActive());
    },
    [rowOfKey, viewOfKey, barPriceFor, barPlan, emitPatch, moveActive, focusActive]
  );

  const restrictionsAsPatch = useCallback((r: Record<string, unknown>): RateRestrictionsPatch => {
    const out: RateRestrictionsPatch = {};
    for (const k of RESTRICTION_KEYS) (out as Record<string, unknown>)[k] = r[k] ?? null;
    return out;
  }, []);

  /** Copy value + restrictions from one cell to another (fill / paste). */
  const copyCell = useCallback(
    (fromKey: CellKey, toKey: CellKey) => {
      if (!isCellEditable(toKey)) return;
      const from = viewOfKey(fromKey);
      const toRow = rowOfKey(toKey);
      if (!toRow) return;
      if (toRow.kind === "availability") {
        if (from.available !== null) emitPatch(toKey, { available: from.available });
        return;
      }
      const fields: Omit<RateGridCellPatch, "ratePlanId" | "roomTypeId" | "date"> = { restrictions: restrictionsAsPatch(from.restrictions as Record<string, unknown>) };
      if (from.basePrice !== null) fields.price = from.basePrice;
      if (isLockedDerived(toKey)) fields.convertToManual = true;
      emitPatch(toKey, fields);
    },
    [isCellEditable, viewOfKey, rowOfKey, emitPatch, restrictionsAsPatch, isLockedDerived]
  );

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current;
    const discard: CellKey[] = [];
    for (const key of sel.keys) {
      if (!isCellEditable(key)) continue;
      const row = rowOfKey(key);
      const v = viewOfKey(key);
      if (row?.kind === "plan" && row.derived && (v.manualOverride || v.entry?.patch.convertToManual)) {
        emitPatch(key, { revertToDerived: true });
      } else if (v.entry) {
        discard.push(key);
      }
    }
    if (discard.length && onDiscardCells) onDiscardCells(discard);
  }, [isCellEditable, rowOfKey, viewOfKey, emitPatch, onDiscardCells]);

  /* ------------------ Clipboard ------------------ */

  const clipboardRef = useRef<ClipEntry[]>([]);
  const copySelection = useCallback(() => {
    const entries: ClipEntry[] = [];
    for (const key of selectionRef.current.keys) {
      const c = coordOfKey(key);
      if (!c) continue;
      const v = viewOfKey(key);
      entries.push({ coord: c, price: v.basePrice, restrictions: restrictionsAsPatch(v.restrictions as Record<string, unknown>), available: v.available });
    }
    clipboardRef.current = entries;
  }, [coordOfKey, viewOfKey, restrictionsAsPatch]);
  const pasteAtActive = useCallback(() => {
    const active = selectionRef.current.active;
    const clip = clipboardRef.current;
    if (!active || clip.length === 0) return;
    const origin = coordOfKey(active);
    if (!origin) return;
    const targets = pasteTargets(clip.map((e) => e.coord), origin, rows.length, dates.length);
    const pasted: CellKey[] = [];
    for (const t of targets) {
      const entry = clip.find((e) => e.coord.row === t.from.row && e.coord.col === t.from.col);
      const toKey = keyOfCoord(t.to);
      if (!entry || !toKey || !isCellEditable(toKey)) continue;
      const toRow = rowOfKey(toKey);
      if (toRow?.kind === "availability") {
        if (entry.available !== null) emitPatch(toKey, { available: entry.available });
      } else {
        const fields: Omit<RateGridCellPatch, "ratePlanId" | "roomTypeId" | "date"> = { restrictions: entry.restrictions };
        if (entry.price !== null) fields.price = entry.price;
        if (isLockedDerived(toKey)) fields.convertToManual = true;
        emitPatch(toKey, fields);
      }
      pasted.push(toKey);
    }
    if (pasted.length) emitSelection({ keys: pasted, active, anchor: active });
  }, [coordOfKey, rows.length, dates.length, keyOfCoord, isCellEditable, rowOfKey, emitPatch, isLockedDerived, emitSelection]);

  const selectionRect = useMemo(() => {
    const coords: Coord[] = [];
    for (const k of selection.keys) {
      const c = coordOfKey(k);
      if (c) coords.push(c);
    }
    const rect = boundingRect(coords);
    if (!rect) return null;
    return { rect, rectangular: isRectangular(coords, rect) };
  }, [selection.keys, coordOfKey]);

  const fillDirection = useCallback(
    (direction: "right" | "down") => {
      if (!selectionRect) return;
      for (const t of fillDirectionTargets(selectionRect.rect, direction)) {
        const from = keyOfCoord(t.from);
        const to = keyOfCoord(t.to);
        if (from && to) copyCell(from, to);
      }
    },
    [selectionRect, keyOfCoord, copyCell]
  );

  const prefillFromSelection = useCallback((): BulkEditPrefill | undefined => {
    const sel = selectionRef.current;
    if (sel.keys.length === 0) return undefined;
    const dts = new Set<string>();
    const rts = new Set<string>();
    const plans = new Set<string>();
    const chans = new Set<string>();
    for (const key of sel.keys) {
      const k = parseCellKey(key);
      dts.add(k.date);
      rts.add(k.roomTypeId);
      if (k.ratePlanId !== AVAILABILITY_PLAN_ID) plans.add(k.ratePlanId);
      if (k.channelId) chans.add(k.channelId);
    }
    return { ranges: groupConsecutiveDates([...dts]).map((r) => ({ from: r.from, to: r.to })), roomTypeIds: [...rts], ratePlanIds: [...plans], channelIds: [...chans] };
  }, []);

  /* ------------------ Pointer ------------------ */

  const dragAnchorRef = useRef<Coord | null>(null);
  const dragMovedRef = useRef(false);
  const lastEnteredRectRef = useRef<DOMRect | null>(null);
  const [fill, setFill] = useState<{ source: Rect; current: Rect } | null>(null);
  const fillRef = useRef<{ source: Rect; current: Rect } | null>(null);

  const onCellMouseDown = useCallback(
    (key: CellKey, e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (editing && editing.key !== key) setEditing(null);
      const sel = selectionRef.current;
      if (e.shiftKey && (sel.anchor ?? sel.active)) selectRange(sel.anchor ?? sel.active!, key, e.ctrlKey || e.metaKey);
      else if (e.ctrlKey || e.metaKey) {
        const keys = sel.keys.includes(key) ? sel.keys.filter((k) => k !== key) : [...sel.keys, key];
        emitSelection({ keys, active: key, anchor: key });
      } else selectSingle(key);
      dragAnchorRef.current = e.shiftKey ? (coordOfKey(sel.anchor ?? key) ?? coordOfKey(key)) : coordOfKey(key);
      dragMovedRef.current = false;
      lastEnteredRectRef.current = e.currentTarget.getBoundingClientRect();
    },
    [editing, selectRange, emitSelection, selectSingle, coordOfKey]
  );

  const onCellMouseEnter = useCallback(
    (key: CellKey, e: ReactMouseEvent<HTMLDivElement>) => {
      if ((e.buttons & 1) === 0) return;
      const coord = coordOfKey(key);
      if (!coord) return;
      lastEnteredRectRef.current = e.currentTarget.getBoundingClientRect();
      if (fillRef.current) {
        const next = { source: fillRef.current.source, current: extendFillRect(fillRef.current.source, coord) };
        fillRef.current = next;
        setFill(next);
        return;
      }
      const anchor = dragAnchorRef.current;
      if (!anchor) return;
      if (anchor.row === coord.row && anchor.col === coord.col) return;
      dragMovedRef.current = true;
      const anchorKey = keyOfCoord(anchor);
      if (anchorKey) selectRange(anchorKey, key, false);
    },
    [coordOfKey, keyOfCoord, selectRange]
  );

  const onCellDoubleClick = useCallback((key: CellKey) => startEditing(key), [startEditing]);

  const fillKeys = useMemo(() => {
    if (!fill) return null;
    const s = new Set<CellKey>();
    for (const t of fillTargets(fill.source, fill.current)) {
      const k = keyOfCoord(t.to);
      if (k) s.add(k);
    }
    return s;
  }, [fill, keyOfCoord]);

  useEffect(() => {
    function onUp() {
      if (fillRef.current) {
        const { source, current } = fillRef.current;
        for (const t of fillTargets(source, current)) {
          const from = keyOfCoord(t.from);
          const to = keyOfCoord(t.to);
          if (from && to) copyCell(from, to);
        }
        const keys = keysInRect(current);
        const sel = selectionRef.current;
        if (keys.length) emitSelection({ keys, active: sel.active, anchor: sel.anchor });
        fillRef.current = null;
        setFill(null);
        return;
      }
      if (dragAnchorRef.current && dragMovedRef.current) {
        const sel = selectionRef.current;
        if (sel.keys.length >= 2) onOpenQuickEdit(sel, lastEnteredRectRef.current ?? undefined);
      }
      dragAnchorRef.current = null;
      dragMovedRef.current = false;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [keyOfCoord, copyCell, keysInRect, emitSelection, onOpenQuickEdit]);

  const onSelectColumn = useCallback(
    (col: number, mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      const sel = selectionRef.current;
      const anchorCoord = sel.anchor ? coordOfKey(sel.anchor) : null;
      const c0 = mods.shiftKey && anchorCoord ? Math.min(anchorCoord.col, col) : col;
      const c1 = mods.shiftKey && anchorCoord ? Math.max(anchorCoord.col, col) : col;
      const keys = keysInRect({ r0: 0, r1: rows.length - 1, c0, c1 });
      const first = keys[0] ?? null;
      const base = mods.ctrlKey || mods.metaKey ? sel.keys.filter((k) => !keys.includes(k)) : [];
      emitSelection({ keys: [...base, ...keys], active: first, anchor: mods.shiftKey ? (sel.anchor ?? first) : first });
      containerRef.current?.focus({ preventScroll: true });
    },
    [coordOfKey, keysInRect, rows.length, emitSelection]
  );

  const onRowHeadMouseDown = useCallback(
    (rowIndex: number, e: ReactMouseEvent<HTMLDivElement>) => {
      const sel = selectionRef.current;
      const anchorCoord = sel.anchor ? coordOfKey(sel.anchor) : null;
      const r0 = e.shiftKey && anchorCoord ? Math.min(anchorCoord.row, rowIndex) : rowIndex;
      const r1 = e.shiftKey && anchorCoord ? Math.max(anchorCoord.row, rowIndex) : rowIndex;
      const keys = keysInRect({ r0, r1, c0: 0, c1: dates.length - 1 });
      const first = keys[0] ?? null;
      const base = e.ctrlKey || e.metaKey ? sel.keys.filter((k) => !keys.includes(k)) : [];
      emitSelection({ keys: [...base, ...keys], active: first, anchor: e.shiftKey ? (sel.anchor ?? first) : first });
      containerRef.current?.focus({ preventScroll: true });
    },
    [coordOfKey, keysInRect, dates.length, emitSelection]
  );

  const onFillHandleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !selectionRect?.rectangular) return;
      e.preventDefault();
      e.stopPropagation();
      const f = { source: selectionRect.rect, current: selectionRect.rect };
      fillRef.current = f;
      setFill(f);
    },
    [selectionRect]
  );

  const onRecommendationClick = useCallback(
    (key: CellKey, e: ReactMouseEvent<HTMLElement>) => {
      selectSingle(key);
      if (onOpenRecommendation) onOpenRecommendation(key, e.currentTarget.getBoundingClientRect());
      // Fallback convention used by the screen: "accept" without a value = open the popover.
      else onCellRecommendationAction(key, "accept");
    },
    [selectSingle, onOpenRecommendation, onCellRecommendationAction]
  );

  /* ------------------ Keyboard ------------------ */

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing) return; // the input handles its own keys
      const meta = e.ctrlKey || e.metaKey;
      const key = e.key;
      const sel = selectionRef.current;

      if (meta && (key === "z" || key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (meta && (key === "y" || key === "Y")) {
        e.preventDefault();
        onRedo?.();
        return;
      }
      if (meta && (key === "c" || key === "C")) {
        e.preventDefault();
        copySelection();
        return;
      }
      if (meta && (key === "v" || key === "V")) {
        e.preventDefault();
        if (!readOnly) pasteAtActive();
        return;
      }
      if (meta && (key === "d" || key === "D")) {
        e.preventDefault();
        if (!readOnly) fillDirection(e.shiftKey ? "down" : "right");
        return;
      }
      if (meta && (key === "b" || key === "B")) {
        e.preventDefault();
        if (!readOnly) onOpenBulkEdit(prefillFromSelection());
        return;
      }
      if (meta && (key === "a" || key === "A")) {
        e.preventDefault();
        const keys = keysInRect({ r0: 0, r1: rows.length - 1, c0: 0, c1: dates.length - 1 });
        emitSelection({ keys, active: sel.active ?? keys[0] ?? null, anchor: keys[0] ?? null });
        return;
      }
      if (meta && key === "Enter") {
        e.preventDefault();
        if (!readOnly && sel.keys.length > 0) onOpenQuickEdit(sel, activeRect());
        return;
      }
      switch (key) {
        case "ArrowUp":
          e.preventDefault();
          moveActive(-1, 0, e.shiftKey);
          return;
        case "ArrowDown":
          e.preventDefault();
          moveActive(1, 0, e.shiftKey);
          return;
        case "ArrowLeft":
          e.preventDefault();
          moveActive(0, -1, e.shiftKey);
          return;
        case "ArrowRight":
          e.preventDefault();
          moveActive(0, 1, e.shiftKey);
          return;
        case "Home":
          e.preventDefault();
          if (sel.active) {
            const c = coordOfKey(sel.active);
            if (c) {
              const k = keyOfCoord({ row: c.row, col: 0 });
              if (k) {
                ensureVisible({ row: c.row, col: 0 });
                selectSingle(k);
              }
            }
          }
          return;
        case "End":
          e.preventDefault();
          if (sel.active) {
            const c = coordOfKey(sel.active);
            if (c) {
              const k = keyOfCoord({ row: c.row, col: dates.length - 1 });
              if (k) {
                ensureVisible({ row: c.row, col: dates.length - 1 });
                selectSingle(k);
              }
            }
          }
          return;
        case "PageDown":
        case "PageUp": {
          e.preventDefault();
          const el = containerRef.current;
          const step = el ? Math.max(1, Math.floor((el.clientHeight - headerTotal) / rowHeight) - 1) : 10;
          moveActive(key === "PageDown" ? step : -step, 0, e.shiftKey);
          return;
        }
        case "Enter":
        case "F2":
          e.preventDefault();
          if (sel.active) startEditing(sel.active);
          return;
        case "Escape":
          e.preventDefault();
          if (sel.keys.length > 1 && sel.active) selectSingle(sel.active);
          else emitSelection({ ...EMPTY_SELECTION, active: sel.active, anchor: sel.active });
          return;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (!readOnly) deleteSelection();
          return;
        default:
          break;
      }
      // Type-to-edit: a digit, sign or "=" starts editing with that character.
      if (!meta && !e.altKey && key.length === 1 && isExpressionStartChar(key) && sel.active && !readOnly) {
        e.preventDefault();
        startEditing(sel.active, key);
      }

      function activeRect(): DOMRect | undefined {
        const el = containerRef.current;
        const a = selectionRef.current.active;
        if (!el || !a) return undefined;
        return el.querySelector<HTMLElement>(`[data-key="${CSS.escape(a)}"]`)?.getBoundingClientRect();
      }
    },
    [editing, onRedo, onUndo, copySelection, readOnly, pasteAtActive, fillDirection, onOpenBulkEdit, prefillFromSelection, keysInRect, rows.length, dates.length, emitSelection, onOpenQuickEdit, moveActive, coordOfKey, keyOfCoord, ensureVisible, selectSingle, headerTotal, rowHeight, startEditing, deleteSelection]
  );

  /* ------------------ Initial active cell ------------------ */

  useEffect(() => {
    if (selection.active || rows.length === 0 || dates.length === 0) return;
    const r = nextEditableRow(-1, 1);
    const k = keyOfCoord({ row: r, col: 0 });
    if (k) emitSelection({ keys: [], active: k, anchor: k });
  }, [selection.active, rows.length, dates.length, nextEditableRow, keyOfCoord, emitSelection]);

  /* ------------------ Render ------------------ */

  const fillHandleStyle = useMemo(() => {
    if (!selectionRect?.rectangular || readOnly) return null;
    const { rect } = selectionRect;
    return { left: labelWidth + (rect.c1 + 1) * cellWidth - 6, top: (rect.r1 + 1) * rowHeight - 6 };
  }, [selectionRect, readOnly, labelWidth, cellWidth, rowHeight]);
  const outlineStyle = useMemo(() => {
    if (!selectionRect?.rectangular || selection.keys.length < 2) return null;
    const { rect } = selectionRect;
    return { left: labelWidth + rect.c0 * cellWidth, top: rect.r0 * rowHeight, width: (rect.c1 - rect.c0 + 1) * cellWidth, height: (rect.r1 - rect.r0 + 1) * rowHeight };
  }, [selectionRect, selection.keys.length, labelWidth, cellWidth, rowHeight]);

  const convertView = convertPrompt ? viewOfKey(convertPrompt.key) : null;
  const convertRow = convertPrompt ? rowOfKey(convertPrompt.key) : null;

  if (rows.length === 0 || dates.length === 0) {
    return (
      <div className="crg" style={{ height: 160 }} role="grid" aria-label={`Tarifas de ${propertyName ?? "la propiedad"}`} aria-rowcount={1} aria-colcount={1}>
        <div className="crg__empty">Sin tipos de habitación o fechas que mostrar.</div>
      </div>
    );
  }

  const mountedRows = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    const row = rows[r];
    if (!row) continue;
    const identity = rowIdentity(row);
    mountedRows.push(
      <GridRowView
        key={row.id}
        row={row}
        rowIndex={r}
        top={r * rowHeight}
        totalWidth={totalWidth}
        dates={dates}
        colStart={colStart}
        colEnd={colEnd}
        cellWidth={cellWidth}
        labelWidth={labelWidth}
        index={index}
        patches={draft.patches}
        rejected={draft.rejectedRecommendations}
        selection={selectionSet}
        rowSelected={identity ? selectedRowIdentities.has(identity) : false}
        active={selection.active}
        editing={editing?.key ?? null}
        editInitial={editing?.initial ?? ""}
        fillKeys={fillKeys}
        today={today}
        currency={response.currency}
        readOnly={readOnly}
        canEditAvailability={canEditAvailability}
        showRecommendation={layers.recommendations || view === "recommendations"}
        showSync={(layers.sync || view === "channels") && !syncUnavailable}
        restrictionsView={view === "restrictions"}
        channelNames={channelNames}
        inventoryPlanId={inventoryPlanId}
        onCellMouseDown={onCellMouseDown}
        onCellMouseEnter={onCellMouseEnter}
        onCellDoubleClick={onCellDoubleClick}
        onCommitEdit={commitEdit}
        onRecommendationClick={onRecommendationClick}
        onRowHeadMouseDown={onRowHeadMouseDown}
        onToggleGroup={toggleGroup}
      />
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        role="grid"
        aria-label={`Tarifas de ${propertyName ?? "la propiedad"}`}
        aria-rowcount={rows.length + 1}
        aria-colcount={dates.length + 1}
        aria-multiselectable="true"
        aria-readonly={readOnly || undefined}
        tabIndex={0}
        className={`crg${density === "compact" ? " crg--compact" : ""}`}
        style={{ height: maxHeight }}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="crg__sizer" style={{ width: totalWidth, height: totalHeight + headerTotal }}>
          <RateGridHeader
            dates={dates}
            today={today}
            demand={response.demand}
            selectedColumns={selectedColumns}
            onSelectColumn={onSelectColumn}
            cellWidth={cellWidth}
            labelWidth={labelWidth}
            headerHeight={headerHeight}
            colStart={colStart}
            colEnd={colEnd}
            totalWidth={totalWidth}
            showDemand={showDemand}
            demandStripHeight={demandHeight}
          />
          <div className="crg__body" style={{ height: totalHeight, width: totalWidth }}>
            {mountedRows}
            {outlineStyle ? <div className="crg__selection-outline" style={outlineStyle} aria-hidden="true" /> : null}
            {fillHandleStyle ? <div className="crg__fill-handle" style={fillHandleStyle} title="Arrastra para rellenar (copia precio y restricciones)" onMouseDown={onFillHandleMouseDown} /> : null}
          </div>
        </div>
      </div>
      <CocoaAlert
        open={Boolean(convertPrompt)}
        type="warning"
        title="Convertir en manual"
        message={
          convertView && convertRow && convertRow.kind === "plan"
            ? `Esta celda es ${convertView.cell?.derivedFrom ? `derivada de ${convertView.cell.derivedFrom.ratePlanCode}` : "derivada"} (${formatMoney(convertView.basePrice, response.currency)}). Si la editas dejará de seguir al plan padre hasta que la devuelvas a derivado (Supr).`
            : "La celda dejará de seguir al plan padre."
        }
        primaryAction={{ label: "Convertir en manual", onClick: confirmConvert }}
        cancelAction={{ label: "Cancelar", onClick: () => setConvertPrompt(null) }}
        onClose={() => setConvertPrompt(null)}
      />
    </>
  );
}

export default CocoaRateGrid;
