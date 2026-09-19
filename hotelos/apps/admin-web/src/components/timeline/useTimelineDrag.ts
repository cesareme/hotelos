// Live Timeline · arrastre con pointer events (Tanda TL · lote TL-3; UX-1 · U9b: pulsación larga con el dedo).
//
// Hook + funciones puras exportadas (cellIndexAt, dropRoomFromElement,
// autoscrollDelta, isLongPressPointer, touchMoveBeforeArm) que el test carga
// bajo `node --import tsx`: importa solo `react`, el motor y
// timeline-presentation (puro: solo el motor, sin DOM ni barrel Cocoa), y no
// toca `window`/`document` fuera de los manejadores.
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
// Con el dedo (pointerType «touch», UX-1 §5.11 (3) y §7.2): la hoja deja
// `touch-action: pan-y` sobre las barras, así que un toque que se desplaza es
// un scroll de la parrilla (el navegador cancela la pulsación con
// pointercancel, o el hook la descarta al superar el umbral antes de tiempo);
// el arrastre solo se ARMA tras mantener LONG_PRESS_MS (250 ms) sin moverse:
// entonces la parrilla abre la tarjeta rápida (`onArm`), la barra se marca
// `data-armed` y un `touchmove` no pasivo impide que el navegador se lleve el
// gesto mientras dura el arrastre. Soltar armado sin mover deja la tarjeta
// abierta (no abre el detalle: eso lo hace el toque corto). Ratón y lápiz
// arrastran como siempre desde el umbral.
//
// Barra bloqueada (cerrada / en casa sin permiso para el modo): la pulsación
// sigue contando como clic (selecciona al soltar) pero nunca entra en «drag».
// Autoscroll en los dos ejes al rozar los bordes del scroller; soltar en
// modo «move» fuera de toda fila cancela (sin onDrop).

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { DRAG_THRESHOLD_PX, LONG_PRESS_MS, dragPhase, snapDays, type BarGeometry, type BarModel, type DragMode } from "../../screens/timeline/timeline-engine";
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

/** Con el dedo el arrastre exige pulsación larga; ratón y lápiz arrastran desde el umbral (puro). */
export function isLongPressPointer(pointerType: string | undefined): boolean {
  return pointerType === "touch";
}

/**
 * Qué significa un movimiento del dedo ANTES de armar el arrastre (puro):
 * dentro del umbral se sigue esperando; fuera, el toque era un desplazamiento
 * (scroll) y la pulsación se descarta sin clic ni arrastre.
 */
export function touchMoveBeforeArm(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): "wait" | "scroll" {
  return dragPhase(dx, dy, threshold) === "click" ? "wait" : "scroll";
}

export type DragState = {
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  originRoomId: string | null;
  phase: "click" | "drag";
  base: BarGeometry;
  /** Pulsación con el dedo: el arrastre solo empieza tras LONG_PRESS_MS. */
  longPress: boolean;
  /** Armado: ya puede arrastrar (siempre true con ratón; tras la pulsación larga con el dedo). */
  armed: boolean;
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
  /** Pulsación larga con el dedo: el arrastre queda armado (la parrilla abre la tarjeta rápida). */
  onArm?(id: string, el: HTMLElement): void;
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
  const elementRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef(0);
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

  const clearTimer = useCallback(() => {
    if (timerRef.current !== 0) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
  }, []);

  const end = useCallback(() => {
    clearTimer();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const ghost = inputRef.current.ghostRef.current;
    if (ghost) {
      for (const key of GHOST_VARS) ghost.style.removeProperty(key);
      ghost.removeAttribute("data-valid");
    }
    elementRef.current?.removeAttribute("data-armed");
    elementRef.current = null;
    stateRef.current = null;
    lockedRef.current = false;
    setDragging(null);
  }, [clearTimer]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = stateRef.current;
      if (!d || lockedRef.current) return;
      const { cellWidth, ghostRef, scrollerRef } = inputRef.current;
      const dy = e.clientY - d.startY;
      if (!d.armed) {
        // Dedo sin pulsación larga todavía: moverse es desplazar la parrilla, no arrastrar.
        if (touchMoveBeforeArm(e.clientX - d.startX, dy) === "scroll") {
          end();
          inputRef.current.onCancel();
        }
        return;
      }
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
    [contentDx, contentDy, end]
  );

  const onUp = useCallback(
    (e: PointerEvent) => {
      const d = stateRef.current;
      if (!d) return;
      const { cellWidth, onClick, onDrop, onCancel } = inputRef.current;
      const dxDays = snapDays(contentDx(e.clientX, d), cellWidth);
      const targetRoomId = d.mode === "move" ? dropRoomFromElement(document.elementFromPoint(e.clientX, e.clientY)) : null;
      const { phase, longPress, armed } = d;
      end();
      if (phase === "click") {
        // Pulsación larga soltada sin mover: la tarjeta rápida queda abierta; el detalle lo abre el toque corto.
        if (longPress && armed) return;
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

  /** Armado con el dedo: el navegador no se lleva el gesto (touch-action: pan-y) mientras se arrastra. */
  const onTouchMove = useCallback((e: TouchEvent) => {
    const d = stateRef.current;
    if (d?.longPress && d.armed && e.cancelable) e.preventDefault();
  }, []);

  /** Sin menú contextual ni selección de texto por mantener pulsado. */
  const onContextMenu = useCallback((e: Event) => {
    if (stateRef.current?.longPress) e.preventDefault();
  }, []);

  const arm = useCallback(() => {
    timerRef.current = 0;
    const d = stateRef.current;
    const el = elementRef.current;
    if (!d || d.armed || !el) return;
    d.armed = true;
    el.setAttribute("data-armed", "true");
    inputRef.current.onArm?.(d.id, el);
  }, []);

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, bar: BarModel, base: BarGeometry, mode: DragMode, allowed: DragAllowed) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (stateRef.current) return;
      const permitted = mode === "move" ? allowed.move || allowed.room : allowed.resize;
      const longPress = isLongPressPointer(e.pointerType);
      stateRef.current = {
        id: bar.id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        originRoomId: bar.res.assignedRoomId ?? null,
        phase: "click",
        base,
        longPress,
        armed: !longPress
      };
      elementRef.current = e.currentTarget;
      lockedRef.current = !permitted;
      scrollStartRef.current = inputRef.current.scrollerRef.current?.scrollLeft ?? 0;
      scrollTopStartRef.current = inputRef.current.scrollerRef.current?.scrollTop ?? 0;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey);
      if (longPress) {
        window.addEventListener("touchmove", onTouchMove, { passive: false });
        window.addEventListener("contextmenu", onContextMenu);
        if (permitted) timerRef.current = window.setTimeout(arm, LONG_PRESS_MS);
      }
      unsubscribeRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("contextmenu", onContextMenu);
      };
    },
    [onMove, onUp, cancel, onKey, onTouchMove, onContextMenu, arm]
  );

  useEffect(
    () => () => {
      clearTimer();
      unsubscribeRef.current?.();
    },
    [clearTimer]
  );

  return { begin, dragging };
}

export default useTimelineDrag;
