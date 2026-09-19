// Live Timeline · arrastre con pointer events (Tanda TL · lote TL-3).
//
// Hook + funciones puras exportadas (cellIndexAt, dropRoomFromElement,
// autoscrollDelta) que el test carga bajo `node --import tsx`: importa solo
// `react`, el motor y timeline-presentation (puro: solo el motor, sin DOM ni
// barrel Cocoa), y no toca `window`/`document` fuera de los manejadores.
//
// Sin setPointerCapture ni librerías: como en el Cronograma actual, los
// listeners de pointermove/pointerup/pointercancel/keydown se cuelgan de
// `window` mientras dura la pulsación y se quitan al terminar. El estado del
// arrastre vive en un ref; el ÚNICO estado React es `dragging`, que cambia al
// entrar en la fase «drag» (a partir de DRAG_THRESHOLD_PX, así un clic no
// apaga la barra ni monta el fantasma) y al terminar. El fantasma se mueve
// IMPERATIVAMENTE con `style.setProperty` sobre las variables de ghostVars
// (snap visual por día) + `--tl-dy` en move: cero re-render por movimiento.
//
// Barra bloqueada (cerrada / en casa sin permiso para el modo): la pulsación
// sigue contando como clic (selecciona al soltar) pero nunca entra en «drag».
// Autoscroll en los dos ejes al rozar los bordes del scroller; soltar en
// modo «move» fuera de toda fila cancela (sin onDrop).

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { dragPhase, snapDays, type BarGeometry, type BarModel, type DragMode } from "../../screens/timeline/timeline-engine";
import { ghostVars } from "./timeline-presentation";

/** Índice de celda (día) para una X relativa al carril: floor, mínimo 0. */
export function cellIndexAt(offsetX: number, cellWidth: number): number {
  if (!(cellWidth > 0) || !Number.isFinite(offsetX)) return 0;
  return Math.max(0, Math.floor(offsetX / cellWidth));
}

/** Fila (`data-room-id`, UNASSIGNED_ID incluido) que contiene al elemento, o null. */
export function dropRoomFromElement(el: Element | null): string | null {
  return el?.closest("[data-room-id]")?.getAttribute("data-room-id") ?? null;
}

export const AUTOSCROLL_EDGE_PX = 40;
export const AUTOSCROLL_STEP_PX = 16;

/** Desplazamiento por movimiento (en un eje) cuando el puntero roza un borde del scroller (0 si no). */
export function autoscrollDelta(clientX: number, left: number, right: number, edge = AUTOSCROLL_EDGE_PX, step = AUTOSCROLL_STEP_PX): number {
  if (right - left <= edge * 2) return 0;
  if (clientX - left < edge) return -step;
  if (right - clientX < edge) return step;
  return 0;
}

export type DragState = {
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  originRoomId: string | null;
  phase: "click" | "drag";
  base: BarGeometry;
};

export type DragAllowed = { move: boolean; resize: boolean; room: boolean };

export type DragDropInput = { id: string; mode: DragMode; dxDays: number; targetRoomId: string | null };

export type UseTimelineDragInput = {
  cellWidth: number;
  /** Pulsación sin desplazamiento (≤ DRAG_THRESHOLD_PX). */
  onClick(id: string): void;
  onDrop(input: DragDropInput): void;
  /** Escape o pointercancel: sin onDrop. */
  onCancel(): void;
  ghostRef: RefObject<HTMLDivElement | null>;
  /** Scroller horizontal (autoscroll al rozar los bordes). */
  scrollerRef: RefObject<HTMLElement | null>;
};

export type UseTimelineDragResult = {
  begin(e: ReactPointerEvent<HTMLElement>, bar: BarModel, base: BarGeometry, mode: DragMode, allowed: DragAllowed): void;
  dragging: { id: string; mode: DragMode } | null;
};

/** Variables que el hook escribe en el fantasma (las de ghostVars + data-valid). */
const GHOST_VARS = ["--tl-left", "--tl-width", "--tl-top", "--tl-dx", "--tl-dy"] as const;

export function useTimelineDrag(input: UseTimelineDragInput): UseTimelineDragResult {
  const stateRef = useRef<DragState | null>(null);
  const lockedRef = useRef(false);
  const scrollStartRef = useRef(0);
  const scrollTopStartRef = useRef(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const inputRef = useRef(input);
  const [dragging, setDragging] = useState<{ id: string; mode: DragMode } | null>(null);

  useEffect(() => {
    inputRef.current = input;
  });

  /** dx en coordenadas del contenido: el autoscroll horizontal cuenta como desplazamiento. */
  const contentDx = useCallback((clientX: number, d: DragState): number => {
    const scrollLeft = inputRef.current.scrollerRef.current?.scrollLeft ?? scrollStartRef.current;
    return clientX - d.startX + (scrollLeft - scrollStartRef.current);
  }, []);

  /** dy en coordenadas del contenido: el autoscroll vertical también cuenta (el fantasma vive en el carril origen). */
  const contentDy = useCallback((clientY: number, d: DragState): number => {
    const scrollTop = inputRef.current.scrollerRef.current?.scrollTop ?? scrollTopStartRef.current;
    return clientY - d.startY + (scrollTop - scrollTopStartRef.current);
  }, []);

  const end = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const ghost = inputRef.current.ghostRef.current;
    if (ghost) {
      for (const key of GHOST_VARS) ghost.style.removeProperty(key);
      ghost.removeAttribute("data-valid");
    }
    stateRef.current = null;
    lockedRef.current = false;
    setDragging(null);
  }, []);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = stateRef.current;
      if (!d || lockedRef.current) return;
      const { cellWidth, ghostRef, scrollerRef } = inputRef.current;
      const dy = e.clientY - d.startY;
      if (d.phase === "click") {
        if (dragPhase(e.clientX - d.startX, dy) === "click") return;
        d.phase = "drag";
        setDragging({ id: d.id, mode: d.mode });
      }
      const scroller = scrollerRef.current;
      if (scroller) {
        // Autoscroll en ambos ejes al rozar un borde (mover entre habitaciones
        // lejanas exige desplazar la parrilla verticalmente).
        const rect = scroller.getBoundingClientRect();
        const delta = autoscrollDelta(e.clientX, rect.left, rect.right);
        if (delta !== 0) scroller.scrollLeft += delta;
        const deltaY = d.mode === "move" ? autoscrollDelta(e.clientY, rect.top, rect.bottom) : 0;
        if (deltaY !== 0) scroller.scrollTop += deltaY;
      }
      const ghost = ghostRef.current;
      if (!ghost) return;
      const vars = ghostVars(d.base, d.mode, snapDays(contentDx(e.clientX, d), cellWidth), cellWidth);
      for (const [key, value] of Object.entries(vars)) ghost.style.setProperty(key, value);
      if (d.mode === "move") ghost.style.setProperty("--tl-dy", `${contentDy(e.clientY, d)}px`);
      // El fantasma y la barra arrastrada llevan pointer-events: none, así que
      // elementFromPoint cae en la fila bajo el puntero (patrón del Cronograma).
      const under = dropRoomFromElement(document.elementFromPoint(e.clientX, e.clientY));
      ghost.setAttribute("data-valid", String(under !== null));
    },
    [contentDx, contentDy]
  );

  const onUp = useCallback(
    (e: PointerEvent) => {
      const d = stateRef.current;
      if (!d) return;
      const { cellWidth, onClick, onDrop, onCancel } = inputRef.current;
      const dxDays = snapDays(contentDx(e.clientX, d), cellWidth);
      const targetRoomId = d.mode === "move" ? dropRoomFromElement(document.elementFromPoint(e.clientX, e.clientY)) : null;
      const phase = d.phase;
      end();
      if (phase === "click") {
        onClick(d.id);
        return;
      }
      // Soltar fuera de cualquier fila (el fantasma iba marcado como inválido):
      // no se propone nada, ni siquiera el cambio de fechas.
      if (d.mode === "move" && targetRoomId === null) {
        onCancel();
        return;
      }
      onDrop({ id: d.id, mode: d.mode, dxDays, targetRoomId });
    },
    [contentDx, end]
  );

  const cancel = useCallback(() => {
    if (!stateRef.current) return;
    end();
    inputRef.current.onCancel();
  }, [end]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancel();
    },
    [cancel]
  );

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, bar: BarModel, base: BarGeometry, mode: DragMode, allowed: DragAllowed) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (stateRef.current) return;
      const permitted = mode === "move" ? allowed.move || allowed.room : allowed.resize;
      stateRef.current = {
        id: bar.id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        originRoomId: bar.res.assignedRoomId ?? null,
        phase: "click",
        base
      };
      lockedRef.current = !permitted;
      scrollStartRef.current = inputRef.current.scrollerRef.current?.scrollLeft ?? 0;
      scrollTopStartRef.current = inputRef.current.scrollerRef.current?.scrollTop ?? 0;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey);
      unsubscribeRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey);
      };
    },
    [onMove, onUp, cancel, onKey]
  );

  useEffect(() => () => unsubscribeRef.current?.(), []);

  return { begin, dragging };
}

export default useTimelineDrag;
