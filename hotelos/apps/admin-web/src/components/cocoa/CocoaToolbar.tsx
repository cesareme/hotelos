// CocoaToolbar — window toolbar and content toolbar (COCOA-22.md §3.1, §8).
//
//   variant="window" (default): sticky 48 px, padding 0 16, toolbar material
//   (the ONLY blur allowed in the kit), hairline bottom, three zones
//   (left / centered title / right), z --cocoa-z-toolbar. The shell's top bar.
//   variant="content": no material, no fixed height, gap 8, wraps on phones —
//   the filter/search row above a table or a grid (search left, selects and
//   segmented right). Hooks for the css lot: `c22-toolbar` + data-sticky,
//   zones `c22-toolbar__left/__right`.

import type { CSSProperties, ReactNode } from "react";

export type CocoaToolbarVariant = "window" | "content";

export interface CocoaToolbarProps {
  variant?: CocoaToolbarVariant;
  title?: string;
  subtitle?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  showTrafficLights?: boolean;
  /** Sticky at the top of its scroller (default: true for window, false for content). */
  sticky?: boolean;
  /** Let the zones wrap (default: true for content, false for window). */
  wrap?: boolean;
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

// macOS semaphore, painted with the semantic tones (no literal colours).
const TRAFFIC_LIGHT_TONES = ["var(--cocoa-danger)", "var(--cocoa-warning)", "var(--cocoa-success)"] as const;

function TrafficLights() {
  return (
    <div aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      {TRAFFIC_LIGHT_TONES.map((color) => (
        <span key={color} style={{ display: "inline-block", width: 12, height: 12, borderRadius: "var(--cocoa-radius-full)", background: color }} />
      ))}
    </div>
  );
}

export function CocoaToolbar({ variant = "window", title, subtitle, leftSlot, rightSlot, showTrafficLights = false, sticky, wrap, "aria-label": ariaLabel, className, style }: CocoaToolbarProps) {
  const isWindow = variant === "window";
  const isSticky = sticky ?? isWindow;
  const wraps = wrap ?? !isWindow;

  const containerStyle: CSSProperties = isWindow
    ? {
        position: isSticky ? "sticky" : "relative",
        top: isSticky ? 0 : undefined,
        zIndex: isSticky ? ("var(--cocoa-z-toolbar)" as CSSProperties["zIndex"]) : undefined,
        height: 48,
        minHeight: 48,
        padding: "0 16px",
        paddingTop: "env(safe-area-inset-top)",
        display: "flex",
        alignItems: "center",
        flexWrap: wraps ? "wrap" : "nowrap",
        background: "var(--cocoa-background-toolbar)",
        backdropFilter: "var(--cocoa-material-toolbar-blur)",
        WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
        borderBottom: "1px solid var(--cocoa-separator)",
        fontFamily: "var(--cocoa-font)",
        boxSizing: "content-box",
        ...style
      }
    : {
        position: isSticky ? "sticky" : "relative",
        top: isSticky ? 0 : undefined,
        zIndex: isSticky ? ("var(--cocoa-z-sticky)" as CSSProperties["zIndex"]) : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: wraps ? "wrap" : "nowrap",
        gap: "var(--cocoa-space-2)",
        background: isSticky ? "var(--cocoa-background-window)" : undefined,
        fontFamily: "var(--cocoa-font)",
        minWidth: 0,
        ...style
      };

  const zone = (justify: CSSProperties["justifyContent"], grow: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: isWindow ? (justify === "flex-start" ? 12 : 8) : "var(--cocoa-space-2)",
    flex: isWindow ? 1 : grow ? "1 1 auto" : "0 1 auto",
    minWidth: 0,
    flexWrap: wraps ? "wrap" : "nowrap",
    justifyContent: justify
  });

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-headline)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    color: "var(--cocoa-label)",
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.2,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%"
  };

  const subtitleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1.2,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%"
  };

  const hasCenter = Boolean(title || subtitle);

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className={[isWindow ? null : "c22-toolbar", "cocoa-toolbar", className].filter(Boolean).join(" ")}
      style={containerStyle}
      data-cocoa="toolbar"
      data-variant={variant}
      data-sticky={isSticky ? "true" : undefined}
    >
      <div className={isWindow ? undefined : "c22-toolbar__left"} style={zone("flex-start", true)}>
        {showTrafficLights ? <TrafficLights /> : null}
        {leftSlot}
      </div>
      {isWindow || hasCenter ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: isWindow ? 1 : "0 1 auto", minWidth: 0, textAlign: "center" }}>
          {title ? <span style={titleStyle}>{title}</span> : null}
          {subtitle ? <span style={subtitleStyle}>{subtitle}</span> : null}
        </div>
      ) : null}
      <div className={isWindow ? undefined : "c22-toolbar__right"} style={zone("flex-end", false)}>
        {rightSlot}
      </div>
    </div>
  );
}

export default CocoaToolbar;
