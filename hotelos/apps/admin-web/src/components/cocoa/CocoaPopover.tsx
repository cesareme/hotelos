// CocoaPopover — floating panel anchored to an element with Cocoa visuals.
//
// Positions itself relative to `anchorEl` using getBoundingClientRect, with a
// chevron arrow pointing back to the anchor. Background, shadow, radius and
// padding all come from styles/cocoa-tokens.css so it stays consistent with
// the rest of the design system. Uses the popover backdrop-filter material
// for the translucent macOS feel.
//
// Closes on outside click (mousedown) and Escape key. Entry motion uses the
// spring easing token so it feels native to Cocoa.
//
// The popover is rendered in a fixed-position layer so it escapes any parent
// overflow:hidden / transform contexts that would otherwise clip it.
//
// Placement notes:
// - "top"    : above anchor, arrow on bottom edge pointing down.
// - "bottom" : below anchor, arrow on top edge pointing up.
// - "left"   : left of anchor, arrow on right edge pointing right.
// - "right"  : right of anchor, arrow on left edge pointing left.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export type CocoaPopoverPlacement = "top" | "bottom" | "left" | "right";

export interface CocoaPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  placement?: CocoaPopoverPlacement;
  onClose: () => void;
  children: ReactNode;
}

// Distance between the anchor edge and the popover edge (also leaves room
// for the arrow chevron).
const OFFSET = 8;
// Half of the arrow base — used for offset math.
const ARROW_HALF = 6;

interface Position {
  top: number;
  left: number;
}

function computePosition(
  anchorRect: DOMRect,
  popoverRect: { width: number; height: number },
  placement: CocoaPopoverPlacement,
): Position {
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;

  switch (placement) {
    case "top":
      return {
        top: anchorRect.top - popoverRect.height - OFFSET,
        left: anchorCenterX - popoverRect.width / 2,
      };
    case "left":
      return {
        top: anchorCenterY - popoverRect.height / 2,
        left: anchorRect.left - popoverRect.width - OFFSET,
      };
    case "right":
      return {
        top: anchorCenterY - popoverRect.height / 2,
        left: anchorRect.right + OFFSET,
      };
    case "bottom":
    default:
      return {
        top: anchorRect.bottom + OFFSET,
        left: anchorCenterX - popoverRect.width / 2,
      };
  }
}

function getArrowStyle(placement: CocoaPopoverPlacement): CSSProperties {
  // Triangle drawn with CSS borders. The "filled" border points toward the
  // anchor; the perpendicular borders are transparent to shape the triangle.
  const base: CSSProperties = {
    position: "absolute",
    width: 0,
    height: 0,
    borderStyle: "solid",
  };

  switch (placement) {
    case "top":
      // Popover above anchor → arrow on bottom edge pointing down.
      return {
        ...base,
        bottom: -ARROW_HALF,
        left: `calc(50% - ${ARROW_HALF}px)`,
        borderWidth: `${ARROW_HALF}px ${ARROW_HALF}px 0 ${ARROW_HALF}px`,
        borderColor:
          "var(--cocoa-background-content) transparent transparent transparent",
      };
    case "left":
      // Popover left of anchor → arrow on right edge pointing right.
      return {
        ...base,
        right: -ARROW_HALF,
        top: `calc(50% - ${ARROW_HALF}px)`,
        borderWidth: `${ARROW_HALF}px 0 ${ARROW_HALF}px ${ARROW_HALF}px`,
        borderColor:
          "transparent transparent transparent var(--cocoa-background-content)",
      };
    case "right":
      // Popover right of anchor → arrow on left edge pointing left.
      return {
        ...base,
        left: -ARROW_HALF,
        top: `calc(50% - ${ARROW_HALF}px)`,
        borderWidth: `${ARROW_HALF}px ${ARROW_HALF}px ${ARROW_HALF}px 0`,
        borderColor:
          "transparent var(--cocoa-background-content) transparent transparent",
      };
    case "bottom":
    default:
      // Popover below anchor → arrow on top edge pointing up.
      return {
        ...base,
        top: -ARROW_HALF,
        left: `calc(50% - ${ARROW_HALF}px)`,
        borderWidth: `0 ${ARROW_HALF}px ${ARROW_HALF}px ${ARROW_HALF}px`,
        borderColor:
          "transparent transparent var(--cocoa-background-content) transparent",
      };
  }
}

// Transform-origin for the entry scale so the popover blooms from the side
// closest to its anchor instead of from its own center.
function getTransformOrigin(placement: CocoaPopoverPlacement): string {
  switch (placement) {
    case "top":
      return "center bottom";
    case "left":
      return "right center";
    case "right":
      return "left center";
    case "bottom":
    default:
      return "center top";
  }
}

export function CocoaPopover({
  open,
  anchorEl,
  placement = "bottom",
  onClose,
  children,
}: CocoaPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);

  // Recompute position whenever we open, the anchor changes, or placement
  // changes. We use useLayoutEffect so the popover is measured + placed
  // before paint, avoiding a flash at (0,0).
  useLayoutEffect(() => {
    if (!open || anchorEl === null) {
      setPosition(null);
      return;
    }
    const popoverEl = popoverRef.current;
    if (popoverEl === null) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();
    setPosition(
      computePosition(
        anchorRect,
        { width: popoverRect.width, height: popoverRect.height },
        placement,
      ),
    );
  }, [open, anchorEl, placement, children]);

  // Reposition on scroll / resize so the popover sticks to its anchor.
  useEffect(() => {
    if (!open || anchorEl === null) return;
    const handler = () => {
      const popoverEl = popoverRef.current;
      if (popoverEl === null) return;
      const anchorRect = anchorEl.getBoundingClientRect();
      const popoverRect = popoverEl.getBoundingClientRect();
      setPosition(
        computePosition(
          anchorRect,
          { width: popoverRect.width, height: popoverRect.height },
          placement,
        ),
      );
    };
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, anchorEl, placement]);

  // Close on outside mousedown (using mousedown rather than click feels
  // snappier and matches native Cocoa popover behavior).
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current !== null && popoverRef.current.contains(target)) {
        return;
      }
      if (anchorEl !== null && anchorEl.contains(target)) {
        // Clicks on the anchor are owned by the caller (typically a toggle),
        // so don't double-close.
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open, anchorEl, onClose]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const popoverStyle: CSSProperties = {
    position: "fixed",
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    // Hide the first frame (before measurement) to avoid the (0,0) flash.
    visibility: position === null ? "hidden" : "visible",
    background: "var(--cocoa-background-content)",
    boxShadow: "var(--cocoa-shadow-popover)",
    borderRadius: "var(--cocoa-radius-md)",
    padding: "var(--cocoa-space-3)",
    backdropFilter: "var(--cocoa-material-popover-blur)",
    WebkitBackdropFilter: "var(--cocoa-material-popover-blur)",
    transformOrigin: getTransformOrigin(placement),
    animation:
      "cocoa-popover-in var(--cocoa-duration-base) var(--cocoa-ease-spring)",
    zIndex: 1000,
  };

  return (
    <>
      {/* Keyframes are injected once per render — cheap, and avoids needing
          a separate CSS file. */}
      <style>{`
        @keyframes cocoa-popover-in {
          from { opacity: 0; transform: scale(0.95); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div ref={popoverRef} role="dialog" style={popoverStyle}>
        <span aria-hidden="true" style={getArrowStyle(placement)} />
        {children}
      </div>
    </>
  );
}

export default CocoaPopover;
