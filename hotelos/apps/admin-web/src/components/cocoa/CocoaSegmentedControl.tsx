// CocoaSegmentedControl — inner views of a page (≤ 4 options; COCOA-22.md
// §3.3). Same skin as the routed tab strip: control bg, padding 2, radius 8;
// active 600 label on content bg with the inset control shadow, radius 6;
// inactive 500 secondary. WAI-ARIA tabs with roving tabindex: arrows / Home /
// End move AND select (automatic activation — the views are cheap, unlike
// the routed tabs which activate manually).
//
// Focus: the button itself never sets `box-shadow` inline — that would beat
// the stylesheet's `.cocoa-focus-ring:focus-visible` ring, and the active
// tab is the only tab stop of the strip. The active surface (content bg +
// inset control shadow) is a decorative child (`tabSurfaceStyle`) painted
// under the label, so the Esmeralda ring shows on whichever tab is focused.
//
// Overflow (fix:2-A qa#5): four options with counts measured 420 px in a
// 324 px column at 390 — the strip scrolled but nothing said so. The control
// measures `scrollWidth > clientWidth` (after every render, since the labels
// change with their counts; ResizeObserver for the box) and sets
// `data-fade="true"` plus an end padding so the last tab clears the fade;
// styles/cocoa-22-layout.css paints the same right-edge mask + scroll-snap
// as `.c22-tablist`, only while the strip overflows.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export type CocoaSegmentedControlSize = "small" | "regular";

export interface CocoaSegmentedControlOption {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface CocoaSegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CocoaSegmentedControlOption>;
  size?: CocoaSegmentedControlSize;
  /** Stretch every segment to share the width (phones). */
  fullWidth?: boolean;
  /**
   * id of the element the active tab controls (`aria-controls`, as CocoaRouteTabs
   * does): give that container `role="tabpanel"` and an `aria-label` — the
   * segmented control has no ids of its own to point `aria-labelledby` at.
   */
  panelId?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

const ITEM_PADDING_BY_SIZE: Record<CocoaSegmentedControlSize, string> = { small: "4px 12px", regular: "6px 16px" };
const FONT_SIZE_BY_SIZE: Record<CocoaSegmentedControlSize, string> = { small: "var(--cocoa-fs-subheadline)", regular: "var(--cocoa-fs-body)" };
const ICON_SIZE_BY_SIZE: Record<CocoaSegmentedControlSize, number> = { small: 12, regular: 14 };
const ITEM_GAP_BY_SIZE: Record<CocoaSegmentedControlSize, number> = { small: 4, regular: 6 };

/** Next enabled value for a navigation key (pure): wraps; null for other keys. */
export function nextSegmentValue(current: string, values: readonly string[], key: string): string | null {
  if (values.length === 0) return null;
  const index = Math.max(0, values.indexOf(current));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return values[(index + 1) % values.length];
    case "ArrowLeft":
    case "ArrowUp":
      return values[(index - 1 + values.length) % values.length];
    case "Home":
      return values[0];
    case "End":
      return values[values.length - 1];
    default:
      return null;
  }
}

/** True when the strip's content is wider than its box (pure; 1 px tolerance for subpixel rounding). */
export function segmentedOverflows(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

/** Radius of a tab inside the 2 px-padded strip (radius 8 − 2). */
export const TAB_ITEM_RADIUS = "calc(var(--cocoa-radius-md) - 2px)";

/**
 * Active surface of a tab (pure): content background + inset control shadow
 * on an absolutely positioned, decorative child; fades with `opacity` so the
 * switch keeps the 200 ms transition. Sits at z-index −1 inside the button's
 * own stacking context (`isolation: isolate`), i.e. under the label and
 * above the strip.
 */
export function tabSurfaceStyle(isActive: boolean): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    borderRadius: TAB_ITEM_RADIUS,
    background: "var(--cocoa-background-content)",
    boxShadow: "inset var(--cocoa-shadow-control)",
    opacity: isActive ? 1 : 0,
    transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
    pointerEvents: "none",
    zIndex: -1
  };
}

/** Button style of a segment (pure): NO `boxShadow` and a transparent background — both live on the surface child. */
export function segmentItemStyle(input: { isActive: boolean; disabled?: boolean; size: CocoaSegmentedControlSize; fullWidth: boolean }): CSSProperties {
  const { isActive, disabled = false, size, fullWidth } = input;
  return {
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: ITEM_GAP_BY_SIZE[size],
    padding: ITEM_PADDING_BY_SIZE[size],
    flex: fullWidth ? 1 : undefined,
    borderRadius: TAB_ITEM_RADIUS,
    border: "1px solid transparent",
    background: "transparent",
    color: isActive ? "var(--cocoa-label)" : "var(--cocoa-label-secondary)",
    fontFamily: "inherit",
    fontSize: FONT_SIZE_BY_SIZE[size],
    fontWeight: (isActive ? "var(--cocoa-fw-semibold)" : "var(--cocoa-fw-medium)") as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    cursor: disabled ? "not-allowed" : isActive ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    userSelect: "none",
    WebkitAppearance: "none",
    appearance: "none",
    transition: "color var(--cocoa-duration-base) var(--cocoa-ease-out)"
  };
}

export function CocoaSegmentedControl({ value, onChange, options, size = "regular", fullWidth = false, panelId, className, style, "aria-label": ariaLabel }: CocoaSegmentedControlProps) {
  const iconSize = ICON_SIZE_BY_SIZE[size];
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabledValues = useMemo(() => options.filter((opt) => !opt.disabled).map((opt) => opt.value), [options]);

  // Overflow → `data-fade` (the stylesheet paints the fade + snap). Measured
  // after every render (labels change) and whenever the box resizes.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const measure = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    setOverflows(segmentedOverflows(element.scrollWidth, element.clientWidth));
  }, []);
  useEffect(measure);
  useEffect(() => {
    const element = listRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      display: fullWidth ? "flex" : "inline-flex",
      alignItems: "stretch",
      padding: 2,
      // Inline `padding` would beat the stylesheet: the end padding that keeps
      // the last tab clear of the 32 px fade is set here, only while faded.
      paddingInlineEnd: overflows ? "var(--cocoa-space-6)" : undefined,
      background: "var(--cocoa-background-control)",
      borderRadius: "var(--cocoa-radius-md)",
      fontFamily: "var(--cocoa-font)",
      maxWidth: "100%",
      overflowX: "auto",
      WebkitAppearance: "none",
      appearance: "none",
      ...style
    }),
    [fullWidth, overflows, style]
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = nextSegmentValue(value, enabledValues, event.key);
    if (!target) return;
    event.preventDefault();
    onChange(target);
    refs.current.get(target)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={["cocoa-segmented", className].filter(Boolean).join(" ")}
      style={containerStyle}
      onKeyDown={onKeyDown}
      data-cocoa="segmented"
      data-size={size}
      data-fade={overflows ? "true" : undefined}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        const itemStyle = segmentItemStyle({ isActive, disabled: opt.disabled, size, fullWidth });

        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={isActive && panelId ? panelId : undefined}
            aria-disabled={opt.disabled || undefined}
            disabled={opt.disabled}
            tabIndex={isActive ? 0 : -1}
            className="cocoa-focus-ring"
            style={itemStyle}
            ref={(element) => {
              if (element) refs.current.set(opt.value, element);
              else refs.current.delete(opt.value);
            }}
            onClick={() => {
              if (isActive || opt.disabled) return;
              onChange(opt.value);
            }}
          >
            <span aria-hidden="true" className="c22-tab__surface" style={tabSurfaceStyle(isActive)} />
            {opt.icon ? (
              <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: iconSize, height: iconSize, flexShrink: 0 }}>
                {opt.icon}
              </span>
            ) : null}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default CocoaSegmentedControl;
