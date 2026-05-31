// CocoaRateGrid — Header / body row renderers and grid-level layout styles.
//
// Pulled out of `CocoaRateGrid.tsx` so the parent file stays focused on the
// stateful logic (selection, drag, keyboard, clipboard). These components are
// pure presentational — they receive callbacks and the index Map and just
// render the right `<CocoaRateGridCell>` instances.

import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent
} from "react";
import type { RateGridCell } from "@hotelos/shared";
import { CocoaRateGridCell } from "./CocoaRateGridCell";
import { formatDateHeader, isWeekend, makeCellId } from "./helpers";
import type { CellId, RoomType } from "./types";

/* ------------------------------------------------------------------ */
/*  Layout constants (shared with the parent grid)                     */
/* ------------------------------------------------------------------ */

export const CORNER_WIDTH = 180;
export const HEADER_HEIGHT = 44;
export const CELL_WIDTH = 80; // matches CocoaRateGridCell
export const ROW_HEIGHT = 40;

/* ------------------------------------------------------------------ */
/*  Header row                                                         */
/* ------------------------------------------------------------------ */

export interface HeaderRowProps {
  dates: Date[];
  isoDates: string[];
}

export function HeaderRow({ dates, isoDates }: HeaderRowProps) {
  return (
    <div role="row" style={{ display: "contents" }}>
      <div
        role="columnheader"
        aria-label="Tipo de habitación"
        style={cornerStyle}
      />
      {dates.map((d, i) => {
        const { weekday, day } = formatDateHeader(d);
        const weekend = isWeekend(d);
        return (
          <div
            key={isoDates[i]}
            role="columnheader"
            data-date={isoDates[i]}
            style={headerCellStyle(weekend)}
          >
            <span style={weekdayStyle}>{weekday}</span>
            <span style={dayStyle}>{day}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Body row                                                           */
/* ------------------------------------------------------------------ */

export interface BodyRowProps {
  roomType: RoomType;
  rowIdx: number;
  isoDates: string[];
  dates: Date[];
  cellIndex: Map<CellId, RateGridCell>;
  selectedCellIds: Set<CellId>;
  activeCellId: CellId | null;
  editingCellId: CellId | null;
  readOnly: boolean;
  onCellMouseDown: (id: CellId, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCellMouseEnter: (id: CellId, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCellSelect: (cell: RateGridCell, event: ReactMouseEvent<HTMLDivElement>) => void;
  onCellEdit: (cell: RateGridCell) => void;
  onCellCommit: (cell: RateGridCell, value: number | null) => void;
}

export function BodyRow(props: BodyRowProps) {
  const {
    roomType,
    rowIdx,
    isoDates,
    dates,
    cellIndex,
    selectedCellIds,
    activeCellId,
    editingCellId,
    readOnly,
    onCellMouseDown,
    onCellMouseEnter,
    onCellSelect,
    onCellEdit,
    onCellCommit
  } = props;

  return (
    <div role="row" aria-rowindex={rowIdx + 2} style={{ display: "contents" }}>
      <div role="rowheader" style={rowHeaderStyle}>
        <div style={rowLabelTitleStyle}>{roomType.name}</div>
        <div style={rowLabelSubStyle}>
          {roomType.code}
          {typeof roomType.baseOccupancy === "number" ? ` · ${roomType.baseOccupancy} pax` : ""}
        </div>
      </div>
      {isoDates.map((iso, colIdx) => {
        const id = makeCellId(roomType.id, iso);
        const cell = cellIndex.get(id);
        const selected = selectedCellIds.has(id);
        const active = activeCellId === id;
        const editing = editingCellId === id;
        const weekend = isWeekend(dates[colIdx]);
        return (
          <div
            key={id}
            data-weekend={weekend || undefined}
            onMouseDown={(e) => onCellMouseDown(id, e)}
            onMouseEnter={(e) => onCellMouseEnter(id, e)}
          >
            {cell ? (
              <CocoaRateGridCell
                cell={cell}
                selected={selected}
                editing={editing}
                active={active}
                readOnly={readOnly}
                onSelect={onCellSelect}
                onEdit={onCellEdit}
                onCommit={onCellCommit}
              />
            ) : (
              <PlaceholderCell selected={selected} active={active} weekend={weekend} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Placeholder (no cell data for this room/date)                      */
/* ------------------------------------------------------------------ */

function PlaceholderCell({
  selected,
  active,
  weekend
}: {
  selected: boolean;
  active: boolean;
  weekend: boolean;
}) {
  const style: CSSProperties = {
    boxSizing: "border-box",
    width: CELL_WIDTH,
    height: ROW_HEIGHT,
    minWidth: CELL_WIDTH,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${
      active || selected ? "var(--cocoa-accent)" : "var(--cocoa-separator)"
    }`,
    background: selected
      ? "color-mix(in srgb, var(--cocoa-accent) 12%, var(--cocoa-background-content))"
      : weekend
        ? "rgba(0,0,0,0.025)"
        : "var(--cocoa-background-content)",
    color: "var(--cocoa-label-tertiary)",
    fontSize: "var(--cocoa-fs-body)",
    cursor: "cell",
    userSelect: "none"
  };
  return <div style={style}>—</div>;
}

/* ------------------------------------------------------------------ */
/*  Shared styles                                                      */
/* ------------------------------------------------------------------ */

export function gridContainerStyle(numCols: number): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `${CORNER_WIDTH}px repeat(${numCols}, ${CELL_WIDTH}px)`,
    gridAutoRows: `${ROW_HEIGHT}px`,
    maxHeight: "70vh",
    overflow: "auto",
    background: "var(--cocoa-background-content)",
    fontFamily: "var(--cocoa-font)"
  };
}

const cornerStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  left: 0,
  zIndex: 3,
  height: HEADER_HEIGHT,
  background: "var(--cocoa-background-sidebar)",
  borderRight: "1px solid var(--cocoa-separator)",
  borderBottom: "1px solid var(--cocoa-separator)",
  boxSizing: "border-box"
};

function headerCellStyle(weekend: boolean): CSSProperties {
  return {
    position: "sticky",
    top: 0,
    zIndex: 2,
    height: HEADER_HEIGHT,
    minWidth: CELL_WIDTH,
    padding: "4px 6px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: weekend
      ? "color-mix(in srgb, var(--cocoa-warning) 5%, var(--cocoa-background-sidebar))"
      : "var(--cocoa-background-sidebar)",
    borderRight: "1px solid var(--cocoa-separator)",
    borderBottom: "1px solid var(--cocoa-separator)",
    boxSizing: "border-box",
    textTransform: "capitalize"
  };
}

const weekdayStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.1,
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number
};

const dayStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-3)",
  color: "var(--cocoa-label)",
  lineHeight: 1.1,
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  fontVariantNumeric: "tabular-nums"
};

const rowHeaderStyle: CSSProperties = {
  position: "sticky",
  left: 0,
  zIndex: 1,
  width: CORNER_WIDTH,
  height: ROW_HEIGHT,
  padding: "4px 12px",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "center",
  background: "var(--cocoa-background-sidebar)",
  borderRight: "1px solid var(--cocoa-separator)",
  borderBottom: "1px solid var(--cocoa-separator)",
  boxSizing: "border-box"
};

const rowLabelTitleStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  lineHeight: 1.2,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: CORNER_WIDTH - 24
};

const rowLabelSubStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.2
};
