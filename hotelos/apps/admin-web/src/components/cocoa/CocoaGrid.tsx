// CocoaGrid + CocoaSpan — the 12-column grid of the canon (COCOA-22.md §3.4;
// replaces `gridRowStyle/spanStyle`, `.bo-grid.two/three`, `.rev-kpi-grid`
// and the `.gm-grid` rules of mobile.css).
//
// Responsive rules (§5.1) are CLASS-based, never inline (§8): the css lot
// owns them in styles/cocoa-22-layout.css.
//   < 600   phone   → 1 column (every span is full width)
//   600–899 tablet  → spans < 6 become 6 (half), spans ≥ 6 become 12
//   900–1199        → real spans; `.c22-min-{200,240,320,480}` promotes a
//                     span whose minimum does not fit to 6 or 12 columns
//   ≥ 1200          → real spans
//
// The grid also measures its own width (ResizeObserver) so a grid embedded
// in a narrow container (a 320 px inspector on a 1440 px screen) stacks too:
// `effectiveSpan` (pure, unit-tested) picks the class to emit — the
// promotion is still expressed as a class, so the stylesheet stays the single
// source of truth for the breakpoints.

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode
} from "react";
import { COCOA_BREAKPOINTS, useElementWidth } from "./cocoa-viewport";

export type CocoaGridColumns = 12 | 6 | 4;
export type CocoaGridGap = 2 | 3 | 4;
export type CocoaSpanCols = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface CocoaGridProps {
  columns?: CocoaGridColumns;
  /** Space token: 2 = 8 px · 3 = 12 px (canon) · 4 = 16 px. */
  gap?: CocoaGridGap;
  /** Cascade the children in (`cocoa-stagger`, 220 ms, 40 ms apart, up to 12). */
  stagger?: boolean;
  /** Align cells to the top instead of stretching them. */
  align?: "start" | "stretch";
  children: ReactNode;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  role?: string;
  "aria-label"?: string;
}

export interface CocoaSpanProps {
  cols: CocoaSpanCols;
  /** Minimum content width in px; promotes the span when the columns are narrower. Canon: 480 (8), 320 (4–5), 240 (3), 200 (2). */
  min?: number;
  rowSpan?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const GAP_PX: Record<CocoaGridGap, number> = { 2: 8, 3: 12, 4: 16 };

/** Minimum-width buckets the stylesheet knows (`.c22-min-N`). */
export const SPAN_MIN_BUCKETS = [200, 240, 320, 480] as const;
export type CocoaSpanMinBucket = (typeof SPAN_MIN_BUCKETS)[number];

/** Smallest stylesheet bucket that honours `min` (pure); null when there is no minimum. */
export function minBucket(min: number | undefined): CocoaSpanMinBucket | null {
  if (!min || min <= 0) return null;
  return SPAN_MIN_BUCKETS.find((bucket) => bucket >= min) ?? 480;
}

interface GridContextValue {
  columns: number;
  gap: number;
  /** Measured grid width; null before the first measurement. */
  width: number | null;
}

const GridContext = createContext<GridContextValue>({ columns: 12, gap: 12, width: null });

/** Width in px of `span` columns inside a grid of `width` px (pure). */
export function spanWidth(span: number, columns: number, width: number, gap: number): number {
  const columnWidth = (width - (columns - 1) * gap) / columns;
  return span * columnWidth + (span - 1) * gap;
}

/**
 * Grid width that corresponds to the desktop viewport tier (1200 − sidebar
 * 240 − gutters 48). Above it the real spans always apply, exactly like the
 * stylesheet: the canon paints its 2-column tiles at 176 px (min 200) on a
 * 1120 px grid and must keep doing so.
 */
export const GRID_DESKTOP_WIDTH = 912;

/**
 * Columns a cell actually occupies (pure).
 *   - unknown width → `cols` (desktop first paint; CSS covers the phone case)
 *   - width < 600 → full
 *   - width < 900 → at least half
 *   - width < 912 → `min` px that does not fit promotes to half, then full
 *   - otherwise `cols` (desktop: the canon spans, never promoted).
 */
export function effectiveSpan(input: { cols: number; columns: number; min?: number; width: number | null; gap: number }): number {
  const { cols, columns, min, width, gap } = input;
  const clamped = Math.max(1, Math.min(columns, cols));
  if (width === null) return clamped;
  if (width < COCOA_BREAKPOINTS.phone) return columns;
  const half = Math.ceil(columns / 2);
  let span = width < COCOA_BREAKPOINTS.tablet ? Math.max(clamped, half) : clamped;
  if (min && min > 0 && width < GRID_DESKTOP_WIDTH) {
    if (span < half && spanWidth(span, columns, width, gap) < min) span = half;
    if (span < columns && spanWidth(span, columns, width, gap) < min) span = columns;
  }
  return span;
}

/** Tablet-tier span (≥ half) for the CSS fallback variable. */
export function tabletSpan(cols: number, columns: number): number {
  return Math.max(Math.min(columns, cols), Math.ceil(columns / 2));
}

/** Class list of a span cell (pure): `c22-span-N` + `c22-min-B` + `c22-rowspan-R`. */
export function spanClassNames(input: { span: number; min?: number; rowSpan?: number }): string[] {
  const out = [`c22-span-${input.span}`];
  const bucket = minBucket(input.min);
  if (bucket) out.push(`c22-min-${bucket}`);
  if (input.rowSpan && input.rowSpan > 1) out.push(`c22-rowspan-${Math.min(3, Math.round(input.rowSpan))}`);
  return out;
}

export function CocoaGrid({ columns = 12, gap = 3, stagger = false, align, children, className, style, role, "aria-label": ariaLabel }: CocoaGridProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(ref);
  const gapPx = GAP_PX[gap];
  const value = useMemo<GridContextValue>(() => ({ columns, gap: gapPx, width }), [columns, gapPx, width]);

  return (
    <GridContext.Provider value={value}>
      <div
        ref={ref}
        className={["c22-grid", "cocoa-grid", stagger ? "cocoa-stagger" : null, className].filter(Boolean).join(" ")}
        style={{ minWidth: 0, ...style }}
        role={role}
        aria-label={ariaLabel}
        data-cocoa="grid"
        data-columns={columns}
        data-gap={gap}
        data-align={align}
      >
        {children}
      </div>
    </GridContext.Provider>
  );
}

export function CocoaSpan({ cols, min, rowSpan, children, className, style }: CocoaSpanProps) {
  const grid = useContext(GridContext);
  const span = effectiveSpan({ cols, columns: grid.columns, min, width: grid.width, gap: grid.gap });
  const classes = spanClassNames({ span, min, rowSpan });

  return (
    <div
      className={[...classes, "cocoa-span", className].filter(Boolean).join(" ")}
      style={{ minWidth: 0, display: "flex", flexDirection: "column", ...style }}
      data-cocoa="span"
      data-span={span}
      data-cols={cols}
    >
      {children}
    </div>
  );
}

export default CocoaGrid;
