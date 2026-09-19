// Live Timeline · presentación pura (Tanda TL · lote TL-2).
//
// Variables CSS (`--tl-*`) y datos de presentación SIN React, SIN el barrel
// Cocoa y SIN DOM: es el único módulo de components/timeline que los tests
// cargan bajo `node --import tsx` (el barrel arrastra CocoaRouteTabs,
// CocoaSidebar y el JSON del árbol de navegación). Los .tsx hacen el cast a
// CSSProperties del objeto que devuelve barVars; aquí solo hay cadenas.
//
// La hoja styles/cocoa-22-timeline.css consume estas variables:
//   --tl-left / --tl-width / --tl-top   → .tl-bar, .tl-ghost, .tl-cell-select
//   --tl-dx / --tl-dy                   → .tl-ghost (transform)
//   --tl-row-h                          → .tl-row, .tl-lane
//   --tl-col / --tl-days / --tl-today   → .tl-grid, .tl-lane__today
//   --tl-h                              → .tl-spacer (virtualización)

import {
  BAR_HEIGHT,
  BAR_KIND_LABEL,
  BAR_KIND_TONE,
  BAR_KINDS,
  HEAD_HEIGHT,
  LANE_GAP,
  LEAD_WIDTH,
  MIN_BAR_WIDTH,
  type BarGeometry,
  type BarKind,
  type CellSelection,
  type DragMode,
  type TimelineRange
} from "../../screens/timeline/timeline-engine";

/** Mapa de variables CSS del timeline (siempre con prefijo `--tl-`). */
export type TlVars = Record<`--tl-${string}`, string>;

const px = (n: number): string => `${n}px`;

/** Posición de un bloque en su carril (left/width/top en px). */
export function barVars(g: BarGeometry): TlVars {
  return { "--tl-left": px(g.left), "--tl-width": px(g.width), "--tl-top": px(g.top) };
}

/**
 * Fantasma durante el arrastre: `move` desplaza la copia con `--tl-dx`
 * (translate, sin relayout); `resize-end` alarga o acorta la anchura y
 * `resize-start` mueve el borde izquierdo. Nunca por debajo de MIN_BAR_WIDTH.
 */
export function ghostVars(base: BarGeometry, mode: DragMode, dxDays: number, cellWidth: number): TlVars {
  const dxPx = dxDays * cellWidth;
  if (mode === "move") {
    return { ...barVars(base), "--tl-dx": px(dxPx), "--tl-dy": "0px" };
  }
  if (mode === "resize-end") {
    return {
      "--tl-left": px(base.left),
      "--tl-width": px(Math.max(MIN_BAR_WIDTH, base.width + dxPx)),
      "--tl-top": px(base.top),
      "--tl-dx": "0px",
      "--tl-dy": "0px"
    };
  }
  return {
    "--tl-left": px(base.left + dxPx),
    "--tl-width": px(Math.max(MIN_BAR_WIDTH, base.width - dxPx)),
    "--tl-top": px(base.top),
    "--tl-dx": "0px",
    "--tl-dy": "0px"
  };
}

/** Altura de una fila (la calcula el motor con rowHeight). */
export function rowVars(height: number): TlVars {
  return { "--tl-row-h": px(height) };
}

/** Rectángulo de la selección de celdas (los índices pueden venir invertidos). */
export function selectionVars(sel: CellSelection, cellWidth: number): TlVars {
  const first = Math.min(sel.startIndex, sel.endIndex);
  const span = Math.abs(sel.endIndex - sel.startIndex) + 1;
  return { "--tl-left": px(first * cellWidth + 2), "--tl-width": px(span * cellWidth - 4) };
}

/**
 * Variables de la parrilla: anchura de columna, número de días, índice de hoy
 * (−1 si hoy no está en el rango), la columna de recursos (LEAD_WIDTH, o
 * LEAD_WIDTH_NARROW en teléfonos) y las medidas fijas del motor.
 */
export function gridVars(range: TimelineRange, todayIndex: number, leadWidth: number = LEAD_WIDTH): TlVars {
  const today = Number.isInteger(todayIndex) && todayIndex >= 0 && todayIndex < range.dayCount ? todayIndex : -1;
  return {
    "--tl-col": px(range.cellWidth),
    "--tl-days": String(range.dayCount),
    "--tl-today": String(today),
    "--tl-lead": px(leadWidth),
    "--tl-head-h": px(HEAD_HEIGHT),
    "--tl-bar-h": px(BAR_HEIGHT),
    "--tl-lane-gap": px(LANE_GAP)
  };
}

/** Altura de los espaciadores de la ventana virtual (filas fuera de la vista). */
export function spacerVars(h: number): TlVars {
  return { "--tl-h": px(Math.max(0, h)) };
}

export type AvailabilityLevel = "none" | "low" | "ok";

/** none = sin libres · low = ≤ 20 % de las vendibles (mínimo 1) · ok = el resto. */
export function availabilityLevel(n: number, sellable: number): AvailabilityLevel {
  if (n <= 0) return "none";
  if (n <= Math.max(1, Math.floor(sellable * 0.2))) return "low";
  return "ok";
}

/** 1-2 iniciales en mayúsculas («Ana García» → «AG»); «?» si la etiqueta está vacía. */
export function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Tono Cocoa tal y como lo tipa el motor (BAR_KIND_TONE), sin importar el barrel. */
export type LegendTone = (typeof BAR_KIND_TONE)[BarKind];
export type LegendVariant = "tinted" | "outline" | "dot";
export type LegendItem = { kind: BarKind | "blocked"; label: string; tone: LegendTone; variant: LegendVariant };

export const BLOCKED_LEGEND_LABEL = "Bloqueada · mantenimiento";

/**
 * Variante de la leyenda por estado: los rellenos son las estancias vivas;
 * el contorno, las que no ocupan con color pleno (borrador discontinuo,
 * no-show punteado, cancelada discontinua); el punto, la salida ya cerrada
 * (bloque atenuado). Espejo de los trazos `data-kind` de la hoja.
 */
export const LEGEND_VARIANT: Record<BarKind, LegendVariant> = {
  arrival_today: "tinted",
  in_house: "tinted",
  departure_today: "tinted",
  confirmed: "tinted",
  draft: "outline",
  checked_out: "dot",
  no_show: "outline",
  cancelled: "outline"
};

/** Los 8 BarKind (en el orden de BAR_KINDS) + la habitación bloqueada. */
export const LEGEND_ITEMS: readonly LegendItem[] = [
  ...BAR_KINDS.map(
    (kind): LegendItem => ({
      kind,
      label: BAR_KIND_LABEL[kind],
      tone: BAR_KIND_TONE[kind],
      variant: LEGEND_VARIANT[kind]
    })
  ),
  { kind: "blocked", label: BLOCKED_LEGEND_LABEL, tone: "neutral", variant: "outline" }
];
