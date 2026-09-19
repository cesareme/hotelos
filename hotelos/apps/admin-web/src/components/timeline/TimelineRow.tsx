// Live Timeline · fila de habitación o «Sin asignar» (Tanda TL · lote TL-3).
//
// Memoizada: la parrilla pinta hasta 120 habitaciones y el hover / la
// selección / el arrastre no deben re-renderizar cada fila. TimelineGrid
// pasa handlers estables (useCallback) y solo a la fila afectada le llegan
// `selectedId` / `focusId` / `draggingId` / `cellSelection` distintos de null.
//
// `role="row"` con `aria-rowindex` (posición absoluta en la parrilla
// virtualizada: cabecera 1, «Libres» 2, filas desde 3) y `data-room-id`
// (destino del arrastre vía elementFromPoint, UNASSIGNED_ID incluido); la
// celda de recursos lleva `data-sticky-column` (columna fija,
// cocoa-22-layout.css) y cabe en la altura fija que asume el motor (el badge
// «Bloqueada» va en la misma línea que el tipo, con elipsis). El carril
// (`tl-lane`, gridcell con aria-colspan) contiene la columna de hoy, las
// barras, la selección de celdas y el fantasma del arrastre (`dragChild`).
// Dos estilos inline: la altura de la fila (rowVars) y el rectángulo de la
// selección (selectionVars).

import { memo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CocoaBadge } from "../cocoa";
import {
  ROOM_STATUS_LABEL,
  ROOM_STATUS_TONE,
  barGeometry,
  dragAllowed,
  guestLabel,
  type BarGeometry,
  type BarModel,
  type CellSelection,
  type DragMode,
  type ResourceRow,
  type TimelineRange
} from "../../screens/timeline/timeline-engine";
import { TimelineBar } from "./TimelineBar";
import { rowVars, selectionVars } from "./timeline-presentation";
import { cellIndexAt } from "./useTimelineDrag";

export type TimelineRowModel = Extract<ResourceRow, { kind: "room" | "unassigned" }>;

export const UNASSIGNED_ROW_TITLE = "Sin asignar";
export const UNASSIGNED_ROW_CAPTION = "Reservas sin habitación";
export const BLOCKED_ROW_LABEL = "Bloqueada";

export type TimelineRowProps = {
  row: TimelineRowModel;
  /** aria-rowindex (1-based): cabecera 1, «Libres» 2, filas desde 3. */
  rowIndex: number;
  range: TimelineRange;
  /** Índice de la columna de hoy en el rango (−1 si no está). */
  todayIndex: number;
  selectedId: string | null;
  focusId: string | null;
  draggingId: string | null;
  guestNames: Record<string, string>;
  onBarPointerDown(e: ReactPointerEvent<HTMLElement>, bar: BarModel, geometry: BarGeometry, mode: DragMode): void;
  onBarHover(bar: BarModel | null, el: HTMLElement | null): void;
  onBarKeyDown(e: ReactKeyboardEvent<HTMLElement>, id: string): void;
  /** Pulsación sobre el carril vacío (selección de celdas para crear reserva). */
  onCellPointerDown(e: ReactPointerEvent<HTMLElement>, roomId: string, dayIndex: number): void;
  cellSelection: CellSelection | null;
  /** Fantasma del arrastre (TimelineDragLayer) cuando esta es la fila origen. */
  dragChild?: ReactNode;
};

export const TimelineRow = memo(function TimelineRow(props: TimelineRowProps) {
  const { row, rowIndex, range, todayIndex, selectedId, focusId, draggingId, guestNames, cellSelection, dragChild } = props;
  const { onBarPointerDown, onBarHover, onBarKeyDown, onCellPointerDown } = props;
  const blocked = row.kind === "room" && row.blocked;
  const selection = cellSelection && cellSelection.roomId === row.id ? cellSelection : null;
  const roomLabel = row.kind === "room" ? row.label : UNASSIGNED_ROW_TITLE;

  return (
    <div
      className={"tl-row" + (blocked ? " tl-row--blocked" : "")}
      role="row"
      aria-rowindex={rowIndex}
      data-room-id={row.id}
      data-kind={row.kind}
      style={rowVars(row.height) as CSSProperties}
    >
      <div className="tl-lead" role="rowheader" data-sticky-column="true">
        {row.kind === "room" ? (
          <>
            <CocoaBadge
              tone={ROOM_STATUS_TONE[row.statusKey]}
              variant="dot"
              title={ROOM_STATUS_LABEL[row.statusKey]}
              aria-label={`${row.label}, ${ROOM_STATUS_LABEL[row.statusKey]}`}
            >
              {row.label}
            </CocoaBadge>
            <span className="tl-lead__meta">
              <span className="cocoa-caption">
                {row.typeLabel}
                {row.capacity ? ` · ${row.capacity} pax` : ""}
                {row.room.floor ? ` · Planta ${row.room.floor}` : ""}
              </span>
              {row.blocked ? (
                <CocoaBadge tone="neutral" size="small" variant="outline">
                  {BLOCKED_ROW_LABEL}
                </CocoaBadge>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <strong>{UNASSIGNED_ROW_TITLE}</strong>
            <span className="cocoa-caption">{UNASSIGNED_ROW_CAPTION}</span>
          </>
        )}
      </div>
      <div
        className="tl-lane"
        role="gridcell"
        aria-colspan={range.dayCount}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onCellPointerDown(e, row.id, cellIndexAt(e.nativeEvent.offsetX, range.cellWidth));
        }}
      >
        {todayIndex >= 0 ? <span className="tl-lane__today" aria-hidden="true" /> : null}
        {row.bars.map((bar) => {
          const geometry = barGeometry(bar, range);
          return (
            <TimelineBar
              key={bar.id}
              bar={bar}
              geometry={geometry}
              label={guestLabel(bar.res, guestNames[bar.res.primaryGuestId ?? ""])}
              roomLabel={roomLabel}
              selected={selectedId === bar.id}
              focusable={focusId === bar.id}
              dragging={draggingId === bar.id}
              allowed={dragAllowed(bar.res)}
              onPointerDown={(e, mode) => onBarPointerDown(e, bar, geometry, mode)}
              onHover={(el) => onBarHover(el ? bar : null, el)}
              onKeyDown={(e) => onBarKeyDown(e, bar.id)}
            />
          );
        })}
        {selection ? (
          <span className="tl-cell-select" aria-hidden="true" style={selectionVars(selection, range.cellWidth) as CSSProperties} />
        ) : null}
        {dragChild}
      </div>
    </div>
  );
});

export default TimelineRow;
