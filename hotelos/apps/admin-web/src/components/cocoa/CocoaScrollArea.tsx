// CocoaScrollArea — the wrapped scroller of wide grids and calendars
// (COCOA-22.md §4 «Calendario / parrilla ancha», §9 rule 3 exception): the
// page never scrolls horizontally; the grid scrolls inside this box, which
// keeps a sticky date header WITHOUT blur, an optional sticky first column
// and a right-edge fade that signals hidden columns. Wrap the `<table>` (or
// the grid) inside; a raw table here must carry `data-cocoa-grid-table` for
// the contract test.
//
// Hooks for the css lot: `c22-scroll-area` + data-axis/sticky-first-column/
// fade (styles/cocoa-22-layout.css owns the geometry).

import type { CSSProperties, ReactNode } from "react";

export type CocoaScrollAxis = "x" | "y" | "both";

export interface CocoaScrollAreaProps {
  axis?: CocoaScrollAxis;
  /** First `th`/`td` of each row stays visible while scrolling horizontally. */
  stickyFirstColumn?: boolean;
  /** Fade the right edge (default: true when the axis includes x). */
  fade?: boolean;
  /** Fixed height (the box becomes the vertical scroller too). */
  maxHeight?: number | string;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  "aria-label"?: string;
  role?: string;
}

export function CocoaScrollArea({ axis = "x", stickyFirstColumn = false, fade, maxHeight, children, id, className, style, "aria-label": ariaLabel, role }: CocoaScrollAreaProps) {
  const fades = fade ?? axis !== "y";
  return (
    <div
      id={id}
      role={role ?? (ariaLabel ? "region" : undefined)}
      aria-label={ariaLabel}
      tabIndex={ariaLabel ? 0 : undefined}
      className={["c22-scroll-area", "cocoa-scroll-area", className].filter(Boolean).join(" ")}
      style={{ maxHeight, ...style }}
      data-cocoa="scroll-area"
      data-axis={axis === "both" ? undefined : axis}
      data-sticky-first-column={stickyFirstColumn ? "true" : undefined}
      data-fade={fades ? "true" : undefined}
    >
      {children}
    </div>
  );
}

export default CocoaScrollArea;
