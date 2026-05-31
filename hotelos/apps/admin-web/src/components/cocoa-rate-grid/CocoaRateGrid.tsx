// CocoaRateGrid — Spreadsheet-style editor for hotel rates and restrictions.
//
// Renders the matrix of cells as a (room types) x (dates) grid inside a
// `CocoaCard`. The grid owns the interactive plumbing (selection, drag, edit,
// keyboard nav, clipboard) and delegates per-cell visuals to
// `CocoaRateGridCell`. Each user-confirmed change is reported through
// `onCellChange(cellId, patch)`; the consumer turns these into bulk updates.
//
// Layout
//   Header row : empty corner + sticky-top date columns
//   Body rows  : sticky-left room-type label + N price cells
//   Container  : CocoaCard padding=none, overflow auto (both axes)
// The render of header / body rows lives in `CocoaRateGridRows.tsx` so this
// file can stay under the agreed LOC ceiling.
//
// Selection model
//   - selectedCellIds Set<CellId>   — what is highlighted
//   - activeCellId   CellId | null  — cursor / focus cell
//   - anchorCellId   CellId | null  — start of last range op (shift / drag)
//   - editingCellId  CellId | null  — cell currently in edit mode
//
// Pointer
//   click             → replace selection with this cell
//   ctrl/meta+click   → toggle this cell in selection
//   shift+click       → range from anchor to this cell
//   mousedown + drag  → rectangular selection
//
// Keyboard
//   arrows            → move active cell (extends if shift)
//   Enter / F2        → enter edit mode
//   Tab               → move right after edit commit
//   Esc               → cancel edit (or clear selection)
//   Ctrl/Cmd+A        → select all
//   Ctrl/Cmd+C        → copy selection into internal clipboard
//   Ctrl/Cmd+V        → paste pattern starting at active cell

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { RateGridCell } from "@hotelos/shared";
import { CocoaCard } from "../cocoa/CocoaCard";
import {
  BodyRow,
  HeaderRow,
  gridContainerStyle
} from "./CocoaRateGridRows";
import {
  clampCoord,
  coordFromId,
  idFromCoord,
  indexCells,
  makeCellId,
  rangeIds,
  setToSortedArray,
  setsEqual,
  toIsoDate
} from "./helpers";
import type {
  CellCoord,
  CellId,
  ClipboardEntry,
  CocoaRateGridProps
} from "./types";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function CocoaRateGrid(props: CocoaRateGridProps) {
  const {
    cells,
    roomTypes,
    dates,
    onCellChange,
    onSelectionChange,
    readOnly = false
  } = props;

  // Index dates → ISO strings once. The grid keys cells by (roomType, isoDate),
  // but the public API exposes the original Date[] for caller convenience.
  const isoDates = useMemo(() => dates.map(toIsoDate), [dates]);
  const cellIndex = useMemo(() => indexCells(cells), [cells]);

  // Selection / focus state. Selection is a Set<CellId> internally so we can
  // dedupe trivially; we emit a sorted array to the parent via
  // `onSelectionChange` to keep its contract stable.
  const [selectedCellIds, setSelectedCellIds] = useState<Set<CellId>>(() => new Set());
  const [activeCellId, setActiveCellId] = useState<CellId | null>(null);
  const [anchorCellId, setAnchorCellId] = useState<CellId | null>(null);
  const [editingCellId, setEditingCellId] = useState<CellId | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);

  // Drag-selection state. We track the anchor on mousedown and rebuild the
  // selection on every mousemove against that anchor.
  const dragAnchorRef = useRef<CellCoord | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Notify parent on selection change. We use a memoized sorted array so the
  // parent can use referential equality safely. `setsEqual` avoids an extra
  // notification when an identical Set is set.
  const lastNotifiedRef = useRef<Set<CellId>>(new Set());
  useEffect(() => {
    if (!setsEqual(lastNotifiedRef.current, selectedCellIds)) {
      lastNotifiedRef.current = new Set(selectedCellIds);
      onSelectionChange(setToSortedArray(selectedCellIds));
    }
  }, [selectedCellIds, onSelectionChange]);

  /* ------------------ Selection helpers ------------------ */

  const selectSingle = useCallback((id: CellId) => {
    setSelectedCellIds(new Set([id]));
    setActiveCellId(id);
    setAnchorCellId(id);
  }, []);

  const toggleOne = useCallback((id: CellId) => {
    setSelectedCellIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setActiveCellId(id);
    setAnchorCellId(id);
  }, []);

  const selectRangeFromAnchor = useCallback(
    (toId: CellId) => {
      const anchor = anchorCellId ?? activeCellId ?? toId;
      const a = coordFromId(anchor, roomTypes, isoDates);
      const b = coordFromId(toId, roomTypes, isoDates);
      if (!a || !b) return;
      setSelectedCellIds(new Set(rangeIds(a, b, roomTypes, isoDates)));
      setActiveCellId(toId);
    },
    [anchorCellId, activeCellId, roomTypes, isoDates]
  );

  const selectAll = useCallback(() => {
    const all: CellId[] = [];
    for (const rt of roomTypes) {
      for (const dt of isoDates) all.push(makeCellId(rt.id, dt));
    }
    setSelectedCellIds(new Set(all));
    if (all[0]) setAnchorCellId(all[0]);
  }, [roomTypes, isoDates]);

  /* ------------------ Pointer interactions ------------------ */

  const handleCellMouseDown = useCallback(
    (id: CellId, event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return; // ignore secondary buttons
      event.preventDefault();
      const isToggle = event.ctrlKey || event.metaKey;
      const isRange = event.shiftKey;
      if (isRange) selectRangeFromAnchor(id);
      else if (isToggle) toggleOne(id);
      else selectSingle(id);
      const coord = coordFromId(id, roomTypes, isoDates);
      if (coord) dragAnchorRef.current = coord;
    },
    [roomTypes, isoDates, selectRangeFromAnchor, toggleOne, selectSingle]
  );

  const handleCellMouseEnter = useCallback(
    (id: CellId, event: ReactMouseEvent<HTMLDivElement>) => {
      const anchor = dragAnchorRef.current;
      // Only treat as drag if primary button is held (buttons bit 0).
      if (!anchor || (event.buttons & 1) === 0) return;
      const b = coordFromId(id, roomTypes, isoDates);
      if (!b) return;
      setSelectedCellIds(new Set(rangeIds(anchor, b, roomTypes, isoDates)));
      setActiveCellId(id);
    },
    [roomTypes, isoDates]
  );

  // Release drag anchor on any global mouseup so a click outside the grid
  // still ends the rectangular selection cleanly.
  useEffect(() => {
    function onUp() {
      dragAnchorRef.current = null;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  /* ------------------ Cell-level callbacks ------------------ */

  const handleCellSelect = useCallback(
    (cell: RateGridCell, event: ReactMouseEvent<HTMLDivElement>) => {
      const id = makeCellId(cell.roomTypeId, cell.date);
      handleCellMouseDown(id, event);
    },
    [handleCellMouseDown]
  );

  const handleCellEdit = useCallback(
    (cell: RateGridCell) => {
      if (readOnly) return;
      const id = makeCellId(cell.roomTypeId, cell.date);
      setEditingCellId(id);
      setActiveCellId(id);
    },
    [readOnly]
  );

  const handleCellCommit = useCallback(
    (cell: RateGridCell, value: number | null) => {
      const id = makeCellId(cell.roomTypeId, cell.date);
      if (value !== null && Number.isFinite(value) && value !== cell.effectivePrice) {
        onCellChange(id, { price: value });
      }
      setEditingCellId(null);
    },
    [onCellChange]
  );

  /* ------------------ Clipboard ------------------ */

  const copySelection = useCallback(() => {
    if (selectedCellIds.size === 0) return;
    const entries: ClipboardEntry[] = [];
    for (const id of selectedCellIds) {
      const coord = coordFromId(id, roomTypes, isoDates);
      const cell = cellIndex.get(id);
      if (!coord || !cell) continue;
      entries.push({
        coord,
        price: cell.effectivePrice,
        restrictions: { ...(cell.restrictions ?? {}) }
      });
    }
    if (entries.length === 0) return;
    // Normalize coords so the top-left is (0,0) — paste anchors at active cell.
    let minRow = Infinity;
    let minCol = Infinity;
    for (const e of entries) {
      if (e.coord.row < minRow) minRow = e.coord.row;
      if (e.coord.col < minCol) minCol = e.coord.col;
    }
    const normalized = entries.map((e) => ({
      ...e,
      coord: { row: e.coord.row - minRow, col: e.coord.col - minCol }
    }));
    setClipboard(normalized);
  }, [selectedCellIds, roomTypes, isoDates, cellIndex]);

  const pasteAtActive = useCallback(() => {
    if (readOnly) return;
    if (clipboard.length === 0 || !activeCellId) return;
    const origin = coordFromId(activeCellId, roomTypes, isoDates);
    if (!origin) return;
    const pastedIds: CellId[] = [];
    for (const entry of clipboard) {
      const target = clampCoord(
        { row: origin.row + entry.coord.row, col: origin.col + entry.coord.col },
        roomTypes.length,
        isoDates.length
      );
      const id = idFromCoord(target, roomTypes, isoDates);
      if (!id) continue;
      const current = cellIndex.get(id);
      const patchPrice =
        entry.price !== current?.effectivePrice ? entry.price : undefined;
      if (patchPrice !== undefined) {
        onCellChange(id, { price: patchPrice, restrictions: entry.restrictions });
      } else {
        onCellChange(id, { restrictions: entry.restrictions });
      }
      pastedIds.push(id);
    }
    if (pastedIds.length > 0) setSelectedCellIds(new Set(pastedIds));
  }, [
    readOnly,
    clipboard,
    activeCellId,
    roomTypes,
    isoDates,
    cellIndex,
    onCellChange
  ]);

  /* ------------------ Keyboard navigation ------------------ */

  const moveActive = useCallback(
    (dRow: number, dCol: number, extendSelection: boolean) => {
      const anchor = activeCellId;
      if (!anchor) {
        const first = idFromCoord({ row: 0, col: 0 }, roomTypes, isoDates);
        if (first) {
          setActiveCellId(first);
          setAnchorCellId(first);
          setSelectedCellIds(new Set([first]));
        }
        return;
      }
      const coord = coordFromId(anchor, roomTypes, isoDates);
      if (!coord) return;
      const next = clampCoord(
        { row: coord.row + dRow, col: coord.col + dCol },
        roomTypes.length,
        isoDates.length
      );
      const nextId = idFromCoord(next, roomTypes, isoDates);
      if (!nextId) return;
      setActiveCellId(nextId);
      if (extendSelection) {
        selectRangeFromAnchor(nextId);
      } else {
        setSelectedCellIds(new Set([nextId]));
        setAnchorCellId(nextId);
      }
    },
    [activeCellId, roomTypes, isoDates, selectRangeFromAnchor]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // While editing, only Enter / Tab / Esc are handled at the grid level;
      // the input owns the rest. Enter / Tab let the cell's onBlur emit the
      // commit, then we advance the cursor here.
      const editing = editingCellId !== null;

      if (editing && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        setEditingCellId(null);
        moveActive(
          event.key === "Enter" ? 1 : 0,
          event.key === "Tab" ? 1 : 0,
          false
        );
        return;
      }
      if (editing && event.key === "Escape") {
        event.preventDefault();
        setEditingCellId(null);
        return;
      }
      if (editing) return;

      const meta = event.ctrlKey || event.metaKey;

      if (meta && (event.key === "a" || event.key === "A")) {
        event.preventDefault();
        selectAll();
        return;
      }
      if (meta && (event.key === "c" || event.key === "C")) {
        event.preventDefault();
        copySelection();
        return;
      }
      if (meta && (event.key === "v" || event.key === "V")) {
        event.preventDefault();
        pasteAtActive();
        return;
      }

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          moveActive(-1, 0, event.shiftKey);
          return;
        case "ArrowDown":
          event.preventDefault();
          moveActive(1, 0, event.shiftKey);
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveActive(0, -1, event.shiftKey);
          return;
        case "ArrowRight":
          event.preventDefault();
          moveActive(0, 1, event.shiftKey);
          return;
        case "Enter":
        case "F2":
          if (activeCellId && !readOnly) {
            event.preventDefault();
            setEditingCellId(activeCellId);
          }
          return;
        case "Escape":
          setSelectedCellIds(new Set());
          return;
        default:
          return;
      }
    },
    [
      editingCellId,
      activeCellId,
      moveActive,
      selectAll,
      copySelection,
      pasteAtActive,
      readOnly
    ]
  );

  /* ------------------ Initial active cell ------------------ */

  useEffect(() => {
    if (activeCellId) return;
    if (roomTypes.length === 0 || isoDates.length === 0) return;
    const first = makeCellId(roomTypes[0].id, isoDates[0]);
    setActiveCellId(first);
    setAnchorCellId(first);
  }, [activeCellId, roomTypes, isoDates]);

  /* ------------------ Render ------------------ */

  return (
    <CocoaCard padding="none" variant="bordered">
      <div
        ref={containerRef}
        role="grid"
        aria-rowcount={roomTypes.length + 1}
        aria-colcount={isoDates.length + 1}
        aria-readonly={readOnly || undefined}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        style={gridContainerStyle(isoDates.length)}
      >
        <HeaderRow dates={dates} isoDates={isoDates} />
        {roomTypes.map((rt, rowIdx) => (
          <BodyRow
            key={rt.id}
            roomType={rt}
            rowIdx={rowIdx}
            isoDates={isoDates}
            dates={dates}
            cellIndex={cellIndex}
            selectedCellIds={selectedCellIds}
            activeCellId={activeCellId}
            editingCellId={editingCellId}
            readOnly={readOnly}
            onCellMouseDown={handleCellMouseDown}
            onCellMouseEnter={handleCellMouseEnter}
            onCellSelect={handleCellSelect}
            onCellEdit={handleCellEdit}
            onCellCommit={handleCellCommit}
          />
        ))}
      </div>
    </CocoaCard>
  );
}

export default CocoaRateGrid;
