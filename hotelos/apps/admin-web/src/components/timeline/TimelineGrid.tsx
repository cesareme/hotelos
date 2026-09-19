// Live Timeline · parrilla virtualizada (Tanda TL · lote TL-3).
//
// Compone la cabecera de días, la fila global «Libres» (sticky bajo la
// cabecera), los grupos por tipo (TimelineAvailabilityRow colapsable) y las
// filas de habitación / «Sin asignar» (TimelineRow, memoizadas) dentro de un
// CocoaScrollArea con ambos ejes. Ventana de filas propia: sumas prefijas
// (rowOffsets) + búsqueda binaria (rowWindow) sobre scrollTop y la altura
// del scroller, medidos con un listener `scroll` pasivo y un ResizeObserver
// que coalescen en un requestAnimationFrame (una actualización por frame).
// Fuera de la ventana solo hay dos espaciadores (`tl-spacer`); durante un
// arrastre la fila origen queda fijada en la ventana (pinRow) para que el
// fantasma, montado en su carril, sobreviva al autoscroll vertical.
//
// Interacción: hover LOCAL (CocoaPopover con TimelineQuickCard, sin elevarse
// a la pantalla; no se monta en teléfonos, donde no hay ratón), arrastre
// (useTimelineDrag + fantasma TimelineDragLayer montado en el carril de la
// fila origen; el destino lo resuelve resolveDrop del motor —con las reservas
// cargadas para bloqueo/ocupación/solape— y sale como PendingChange / motivo
// de rechazo), selección de celdas en carriles vacíos de habitaciones no
// bloqueadas SOLO al arrastrar más de DRAG_THRESHOLD_PX (un clic o un toque
// en un hueco no crea nada), y teclado en las barras: las flechas SOLO mueven
// la selección (neighborBar + roving tabindex), Intro / Espacio y el clic
// abren el detalle (`onOpen`), Escape lo delega en la pantalla (`onEscape`:
// cierra el detalle antes de deseleccionar). `handleRef` expone `focusBar`
// para devolver el foco a la barra al cerrar el detalle. Tres estilos inline,
// todos variables CSS: la parrilla (gridVars) y los dos espaciadores (spacerVars).

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { CocoaPopover, CocoaScrollArea, useIsNarrow } from "../cocoa";
import {
  GROUP_ROW_HEIGHT,
  HEAD_HEIGHT,
  LEAD_WIDTH,
  LEAD_WIDTH_NARROW,
  barGeometry,
  dragAllowed,
  dragPhase,
  guestLabel,
  neighborBar,
  pinRow,
  resolveDrop,
  rowOffsets,
  rowWindow,
  type ArrowDirection,
  type BarGeometry,
  type BarModel,
  type CellSelection,
  type DayColumn,
  type DragMode,
  type PendingChange,
  type ResourceRow,
  type RoomOccupant,
  type RowWindow,
  type TimelineRange
} from "../../screens/timeline/timeline-engine";
import type { AdminRoom, AdminRoomType } from "../../services/pmsCommerceApi";
import { TimelineAvailabilityRow } from "./TimelineAvailabilityRow";
import { TimelineDragLayer } from "./TimelineDragLayer";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineQuickCard } from "./TimelineQuickCard";
import { TimelineRow } from "./TimelineRow";
import { gridVars, spacerVars } from "./timeline-presentation";
import { cellIndexAt, useTimelineDrag, type DragDropInput } from "./useTimelineDrag";

/** Cómo se ha pedido abrir el detalle: con teclado la pantalla mueve el foco al panel. */
export type TimelineOpenVia = "keyboard" | "pointer";

/** Mando imperativo de la parrilla (la pantalla devuelve el foco a la barra al cerrar el detalle). */
export type TimelineGridHandle = { focusBar(id: string): void };

export type TimelineGridProps = {
  rows: ResourceRow[];
  range: TimelineRange;
  columns: DayColumn[];
  /** Libres totales por columna (fila «Libres» bajo la cabecera). */
  totalAvailability: number[];
  totalSellable: number;
  selectedId: string | null;
  /** Nombre resuelto por id de huésped principal (guestLabel del motor). */
  guestNames: Record<string, string>;
  /** Selección (aria-pressed, badge de la pantalla): flechas, clic e Intro. */
  onSelect(id: string | null): void;
  /** Abrir el detalle (inspector): clic, Intro o Espacio. */
  onOpen(id: string, via: TimelineOpenVia): void;
  /** Escape sobre una barra; sin manejador, deselecciona. */
  onEscape?(): void;
  /** Cambio propuesto por un arrastre (la pantalla pide confirmación). */
  onDrop(pending: PendingChange): void;
  /** Motivo por el que el motor rechaza el arrastre (toast de la pantalla). */
  onDropRejected?(reason: string): void;
  onToggleGroup(roomTypeId: string): void;
  /** Celdas seleccionadas en una habitación (crear reserva). */
  onCreateFromCells(sel: CellSelection): void;
  roomById: Map<string, AdminRoom>;
  roomTypeById: Map<string, AdminRoomType>;
  /** Reservas cargadas en el rango (sin filtrar): validación local del arrastre (resolveDrop). */
  reservations?: ReadonlyArray<RoomOccupant>;
  /** Altura del scroller (por defecto 640). */
  maxHeight?: number | string;
  ariaLabel?: string;
  handleRef?: RefObject<TimelineGridHandle | null>;
};

export const GRID_ARIA_LABEL = "Live Timeline de reservas por habitación";
export const QUICK_CARD_ARIA_LABEL = "Ficha rápida de la reserva";
export const TOTAL_AVAILABILITY_LABEL = "Libres";
export const DEFAULT_GRID_MAX_HEIGHT = 640;

/** Cabecera + fila «Libres» sticky: scrollTop relativo al inicio de las filas. */
const STICKY_TOP = HEAD_HEIGHT + GROUP_ROW_HEIGHT;
/** aria-rowindex de la primera fila de datos (cabecera 1, «Libres» 2). */
const FIRST_DATA_ROW_INDEX = 3;
/** Frames que se reintenta enfocar una barra recién entrada en la ventana. */
const FOCUS_RETRY_FRAMES = 8;
const SCROLLER_SELECTOR = '[data-cocoa="scroll-area"]';

const ARROWS: Record<string, ArrowDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

type Viewport = { scrollTop: number; viewportHeight: number };

type RowIndex = {
  barById: Map<string, BarModel>;
  rowIdByBar: Map<string, string>;
  rowIndexByBar: Map<string, number>;
  rowById: Map<string, ResourceRow>;
};

function indexRows(rows: ReadonlyArray<ResourceRow>): RowIndex {
  const barById = new Map<string, BarModel>();
  const rowIdByBar = new Map<string, string>();
  const rowIndexByBar = new Map<string, number>();
  const rowById = new Map<string, ResourceRow>();
  rows.forEach((row, rowIndex) => {
    rowById.set(row.id, row);
    if (row.kind === "group") return;
    for (const bar of row.bars) {
      barById.set(bar.id, bar);
      rowIdByBar.set(bar.id, row.id);
      rowIndexByBar.set(bar.id, rowIndex);
    }
  });
  return { barById, rowIdByBar, rowIndexByBar, rowById };
}

/** Primera barra de la ventana visible (tab stop cuando no hay selección). */
function firstVisibleBar(rows: ReadonlyArray<ResourceRow>, win: RowWindow): string | null {
  for (let i = win.start; i < win.end; i++) {
    const row = rows[i];
    if (row && row.kind !== "group" && row.bars.length) return row.bars[0].id;
  }
  return null;
}

/** Selección de celdas en curso: fase «click» hasta superar el umbral (como en useTimelineDrag). */
type CellDrag = { sel: CellSelection; lane: HTMLElement; startX: number; startY: number; phase: "click" | "drag" };

export function TimelineGrid(props: TimelineGridProps) {
  const { rows, range, columns, totalAvailability, totalSellable, selectedId, guestNames, roomById, roomTypeById, reservations } = props;
  const { onSelect, onOpen, onEscape, onDrop, onDropRejected, onToggleGroup, onCreateFromCells, maxHeight = DEFAULT_GRID_MAX_HEIGHT, ariaLabel, handleRef } = props;

  const narrow = useIsNarrow();
  const leadWidth = narrow ? LEAD_WIDTH_NARROW : LEAD_WIDTH;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const [viewport, setViewport] = useState<Viewport>({ scrollTop: 0, viewportHeight: typeof maxHeight === "number" ? maxHeight : DEFAULT_GRID_MAX_HEIGHT });
  const [hover, setHover] = useState<{ bar: BarModel; el: HTMLElement } | null>(null);
  const [focusState, setFocusState] = useState<string | null>(null);
  const [cellSelection, setCellSelection] = useState<CellSelection | null>(null);

  const todayIndex = useMemo(() => columns.findIndex((col) => col.isToday), [columns]);
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  const index = useMemo(() => indexRows(rows), [rows]);
  const baseWin = useMemo(
    () => rowWindow(offsets, Math.max(0, viewport.scrollTop - STICKY_TOP), viewport.viewportHeight),
    [offsets, viewport.scrollTop, viewport.viewportHeight]
  );

  // ---- scroller: ventana de filas ------------------------------------------
  useEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>(SCROLLER_SELECTOR) ?? null;
    scrollerRef.current = scroller;
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next: Viewport = { scrollTop: scroller.scrollTop, viewportHeight: scroller.clientHeight };
      setViewport((prev) => (prev.scrollTop === next.scrollTop && prev.viewportHeight === next.viewportHeight ? prev : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      scrollerRef.current = null;
    };
  }, []);

  // ---- foco (roving tabindex) ---------------------------------------------
  const focusBar = useCallback((id: string, retries: number = FOCUS_RETRY_FRAMES) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-reservation-id="${id}"]`) ?? null;
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (retries > 0) requestAnimationFrame(() => focusBar(id, retries - 1));
  }, []);

  useImperativeHandle(handleRef, () => ({ focusBar: (id: string) => focusBar(id) }), [focusBar]);

  // ---- arrastre -----------------------------------------------------------
  /** Pulsación sin desplazamiento: selecciona, enfoca y abre el detalle (como en Mews). */
  const handleBarClick = useCallback(
    (id: string) => {
      onSelect(id);
      setFocusState(id);
      focusBar(id);
      onOpen(id, "pointer");
    },
    [onSelect, onOpen, focusBar]
  );

  const handleDrop = useCallback(
    ({ id, mode, dxDays, targetRoomId }: DragDropInput) => {
      const bar = index.barById.get(id);
      if (!bar) return;
      const r = resolveDrop({ res: bar.res, mode, dxDays, targetRoomId, roomById, roomTypeById, reservations });
      if (r.pending) onDrop(r.pending);
      else if (r.rejected) onDropRejected?.(r.rejected);
    },
    [index, roomById, roomTypeById, reservations, onDrop, onDropRejected]
  );

  const handleDragCancel = useCallback(() => setHover(null), []);

  const drag = useTimelineDrag({ cellWidth: range.cellWidth, onClick: handleBarClick, onDrop: handleDrop, onCancel: handleDragCancel, ghostRef, scrollerRef });
  const { begin, dragging } = drag;

  const onBarPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, bar: BarModel, geometry: BarGeometry, mode: DragMode) => {
      begin(e, bar, geometry, mode, dragAllowed(bar.res));
    },
    [begin]
  );

  const draggingBar = dragging ? (index.barById.get(dragging.id) ?? null) : null;
  const draggingRowId = draggingBar ? (index.rowIdByBar.get(draggingBar.id) ?? null) : null;
  const draggingRowIndex = draggingBar ? (index.rowIndexByBar.get(draggingBar.id) ?? null) : null;
  const dragLayer = draggingBar ? (
    <TimelineDragLayer
      ghostRef={ghostRef}
      bar={draggingBar}
      geometry={barGeometry(draggingBar, range)}
      label={guestLabel(draggingBar.res, guestNames[draggingBar.res.primaryGuestId ?? ""])}
    />
  ) : null;

  // La fila origen del arrastre no sale de la ventana virtual (el fantasma vive en su carril).
  const win = useMemo(() => pinRow(baseWin, offsets, draggingRowIndex), [baseWin, offsets, draggingRowIndex]);

  // Última geometría para los manejadores estables (no entra en sus deps:
  // así el scroll no cambia la identidad de los handlers de las filas).
  const layoutRef = useRef({ win, offsets, index });
  useEffect(() => {
    layoutRef.current = { win, offsets, index };
  });

  const firstVisible = useMemo(() => firstVisibleBar(rows, win), [rows, win]);
  const focusId =
    selectedId && index.barById.has(selectedId) ? selectedId : focusState && index.barById.has(focusState) ? focusState : firstVisible;

  // ---- hover local (tarjeta rápida) ---------------------------------------
  const onBarHover = useCallback((bar: BarModel | null, el: HTMLElement | null) => {
    setHover(bar && el ? { bar, el } : null);
  }, []);
  const closeHover = useCallback(() => setHover(null), []);

  // ---- teclado en las barras ----------------------------------------------
  const onBarKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
      const dir = ARROWS[e.key];
      if (dir) {
        // Las flechas solo mueven la selección y el foco: nunca abren el detalle.
        e.preventDefault();
        const next = neighborBar(rows, id, dir);
        if (!next) return;
        onSelect(next);
        setFocusState(next);
        const layout = layoutRef.current;
        const rowIndex = layout.index.rowIndexByBar.get(next);
        const scroller = scrollerRef.current;
        if (scroller && rowIndex !== undefined && (rowIndex < layout.win.start || rowIndex >= layout.win.end)) {
          // Fila fuera de la ventana virtual: centrarla y enfocar en el siguiente frame.
          scroller.scrollTop = Math.max(0, layout.offsets[rowIndex] + STICKY_TOP - scroller.clientHeight / 2);
          requestAnimationFrame(() => focusBar(next));
        } else {
          focusBar(next);
        }
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(id);
        setFocusState(id);
        onOpen(id, "keyboard");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (onEscape) {
          // La pantalla decide el orden (diálogo → celdas → detalle → selección);
          // sin propagar, para que el manejador global no repita el paso.
          e.stopPropagation();
          onEscape();
        } else {
          onSelect(null);
        }
      }
    },
    [rows, onSelect, onOpen, onEscape, focusBar]
  );

  // ---- selección de celdas (crear reserva) --------------------------------
  const cellRef = useRef<CellDrag | null>(null);
  const cellUnsubscribeRef = useRef<(() => void) | null>(null);

  const endCellSelection = useCallback(() => {
    cellUnsubscribeRef.current?.();
    cellUnsubscribeRef.current = null;
    cellRef.current = null;
    setCellSelection(null);
  }, []);

  const onCellPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, roomId: string, dayIndex: number) => {
      if (e.button !== 0 || cellRef.current) return;
      const row = layoutRef.current.index.rowById.get(roomId);
      if (!row || row.kind !== "room" || row.blocked) return;
      e.preventDefault();
      const lane = e.currentTarget;
      const { cellWidth, dayCount } = range;
      const start = Math.min(dayIndex, dayCount - 1);
      // Nada se pinta ni se propone hasta superar el umbral: un clic (o un
      // toque para desplazar) en un hueco no abre «Nueva reserva».
      const current: CellDrag = { sel: { roomId, startIndex: start, endIndex: start }, lane, startX: e.clientX, startY: e.clientY, phase: "click" };
      cellRef.current = current;
      const onMove = (ev: PointerEvent) => {
        if (current.phase === "click") {
          if (dragPhase(ev.clientX - current.startX, ev.clientY - current.startY) === "click") return;
          current.phase = "drag";
          setCellSelection(current.sel);
        }
        const endIndex = Math.min(dayCount - 1, cellIndexAt(ev.clientX - lane.getBoundingClientRect().left, cellWidth));
        if (endIndex === current.sel.endIndex) return;
        current.sel = { ...current.sel, endIndex };
        setCellSelection(current.sel);
      };
      const onUp = () => {
        const { sel, phase } = current;
        endCellSelection();
        if (phase === "drag") onCreateFromCells(sel);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        endCellSelection();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", endCellSelection);
      window.addEventListener("keydown", onKey);
      cellUnsubscribeRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", endCellSelection);
        window.removeEventListener("keydown", onKey);
      };
    },
    [range, endCellSelection, onCreateFromCells]
  );

  useEffect(() => () => cellUnsubscribeRef.current?.(), []);

  // ---- render -------------------------------------------------------------
  /** Solo la fila que contiene la barra recibe el id (el resto, null estable → memo). */
  const onlyInRow = (id: string | null, rowId: string): string | null => (id && index.rowIdByBar.get(id) === rowId ? id : null);

  return (
    <>
      <CocoaScrollArea axis="both" maxHeight={maxHeight} aria-label={ariaLabel ?? GRID_ARIA_LABEL}>
        <div
          ref={rootRef}
          className="tl-grid"
          role="grid"
          aria-rowcount={rows.length + 2}
          aria-colcount={columns.length + 1}
          data-narrow={String(narrow)}
          style={gridVars(range, todayIndex, leadWidth) as CSSProperties}
        >
          <TimelineHeader columns={columns} />
          <TimelineAvailabilityRow label={TOTAL_AVAILABILITY_LABEL} counts={totalAvailability} sellable={totalSellable} sticky rowIndex={2} />
          <div className="tl-spacer" aria-hidden="true" style={spacerVars(win.topSpacer) as CSSProperties} />
          {rows.slice(win.start, win.end).map((row, offset) => {
            const rowIndex = win.start + offset + FIRST_DATA_ROW_INDEX;
            return row.kind === "group" ? (
              <TimelineAvailabilityRow
                key={row.id}
                label={row.label}
                counts={row.free}
                sellable={row.sellable}
                collapsible={{ collapsed: row.collapsed, onToggle: () => onToggleGroup(row.roomTypeId), roomCount: row.roomCount }}
                id={`tl-group-${row.roomTypeId}`}
                rowIndex={rowIndex}
              />
            ) : (
              <TimelineRow
                key={row.id}
                row={row}
                rowIndex={rowIndex}
                range={range}
                todayIndex={todayIndex}
                selectedId={onlyInRow(selectedId, row.id)}
                focusId={onlyInRow(focusId, row.id)}
                draggingId={draggingRowId === row.id && dragging ? dragging.id : null}
                guestNames={guestNames}
                onBarPointerDown={onBarPointerDown}
                onBarHover={onBarHover}
                onBarKeyDown={onBarKeyDown}
                onCellPointerDown={onCellPointerDown}
                cellSelection={cellSelection?.roomId === row.id ? cellSelection : null}
                dragChild={draggingRowId === row.id ? dragLayer : undefined}
              />
            );
          })}
          <div className="tl-spacer" aria-hidden="true" style={spacerVars(win.bottomSpacer) as CSSProperties} />
        </div>
      </CocoaScrollArea>
      <CocoaPopover
        open={hover !== null && dragging === null && !narrow}
        anchorEl={hover?.el ?? null}
        placement="top"
        role="tooltip"
        aria-label={QUICK_CARD_ARIA_LABEL}
        onClose={closeHover}
      >
        {hover ? (
          <TimelineQuickCard
            res={hover.bar.res}
            label={guestLabel(hover.bar.res, guestNames[hover.bar.res.primaryGuestId ?? ""])}
            room={roomById.get(hover.bar.res.assignedRoomId ?? "")}
            kind={hover.bar.kind}
          />
        ) : null}
      </CocoaPopover>
    </>
  );
}

export default TimelineGrid;
