// CocoaPopover — floating panel anchored to an element (COCOA-22.md §2.3
// «Popover / menú»): content bg, shadow popover, radius 8, padding 12, arrow
// pointing at the anchor, `cocoa-scale-in` entry (keyframes in
// styles/cocoa-motion.css), z --cocoa-z-popover.
//
// Positions itself with getBoundingClientRect in a fixed layer so it escapes
// any parent overflow/transform; re-positions on scroll/resize; closes on
// outside mousedown and Escape.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type CocoaPopoverPlacement = "top" | "bottom" | "left" | "right";

export interface CocoaPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  placement?: CocoaPopoverPlacement;
  onClose: () => void;
  children: ReactNode;
  /** `dialog` (default) or `menu`/`listbox` when the content is a list. */
  role?: "dialog" | "menu" | "listbox" | "tooltip";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

const OFFSET = 8;
const ARROW_HALF = 6;

interface Position {
  top: number;
  left: number;
}

/** Popover origin for a placement (pure). */
export function computePosition(anchorRect: { top: number; left: number; right: number; bottom: number; width: number; height: number }, popoverRect: { width: number; height: number }, placement: CocoaPopoverPlacement): Position {
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  switch (placement) {
    case "top":
      return { top: anchorRect.top - popoverRect.height - OFFSET, left: anchorCenterX - popoverRect.width / 2 };
    case "left":
      return { top: anchorCenterY - popoverRect.height / 2, left: anchorRect.left - popoverRect.width - OFFSET };
    case "right":
      return { top: anchorCenterY - popoverRect.height / 2, left: anchorRect.right + OFFSET };
    case "bottom":
    default:
      return { top: anchorRect.bottom + OFFSET, left: anchorCenterX - popoverRect.width / 2 };
  }
}

function getArrowStyle(placement: CocoaPopoverPlacement): CSSProperties {
  const base: CSSProperties = { position: "absolute", width: 0, height: 0, borderStyle: "solid" };
  switch (placement) {
    case "top":
      return { ...base, bottom: -ARROW_HALF, left: `calc(50% - ${ARROW_HALF}px)`, borderWidth: `${ARROW_HALF}px ${ARROW_HALF}px 0 ${ARROW_HALF}px`, borderColor: "var(--cocoa-background-content) transparent transparent transparent" };
    case "left":
      return { ...base, right: -ARROW_HALF, top: `calc(50% - ${ARROW_HALF}px)`, borderWidth: `${ARROW_HALF}px 0 ${ARROW_HALF}px ${ARROW_HALF}px`, borderColor: "transparent transparent transparent var(--cocoa-background-content)" };
    case "right":
      return { ...base, left: -ARROW_HALF, top: `calc(50% - ${ARROW_HALF}px)`, borderWidth: `${ARROW_HALF}px ${ARROW_HALF}px ${ARROW_HALF}px 0`, borderColor: "transparent var(--cocoa-background-content) transparent transparent" };
    case "bottom":
    default:
      return { ...base, top: -ARROW_HALF, left: `calc(50% - ${ARROW_HALF}px)`, borderWidth: `0 ${ARROW_HALF}px ${ARROW_HALF}px ${ARROW_HALF}px`, borderColor: "transparent transparent var(--cocoa-background-content) transparent" };
  }
}

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

export function CocoaPopover({ open, anchorEl, placement = "bottom", onClose, children, role = "dialog", "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, className }: CocoaPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!open || anchorEl === null) {
      setPosition(null);
      return;
    }
    const popoverEl = popoverRef.current;
    if (popoverEl === null) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();
    setPosition(computePosition(anchorRect, { width: popoverRect.width, height: popoverRect.height }, placement));
  }, [open, anchorEl, placement, children]);

  useEffect(() => {
    if (!open || anchorEl === null) return;
    const handler = () => {
      const popoverEl = popoverRef.current;
      if (popoverEl === null) return;
      const anchorRect = anchorEl.getBoundingClientRect();
      const popoverRect = popoverEl.getBoundingClientRect();
      setPosition(computePosition(anchorRect, { width: popoverRect.width, height: popoverRect.height }, placement));
    };
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, anchorEl, placement]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current !== null && popoverRef.current.contains(target)) return;
      if (anchorEl !== null && anchorEl.contains(target)) return; // the anchor toggles by itself
      onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open, anchorEl, onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const popoverStyle: CSSProperties = {
    position: "fixed",
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    visibility: position === null ? "hidden" : "visible",
    background: "var(--cocoa-background-content)",
    boxShadow: "var(--cocoa-shadow-popover)",
    borderRadius: "var(--cocoa-radius-md)",
    padding: "var(--cocoa-space-3)",
    transformOrigin: getTransformOrigin(placement),
    animation: "cocoa-scale-in var(--cocoa-duration-base) var(--cocoa-ease-out) both",
    zIndex: "var(--cocoa-z-popover)" as CSSProperties["zIndex"],
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)"
  };

  return (
    <div ref={popoverRef} role={role} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} className={["cocoa-popover", className].filter(Boolean).join(" ")} style={popoverStyle} data-cocoa="popover" data-placement={placement}>
      <span aria-hidden="true" style={getArrowStyle(placement)} />
      {children}
    </div>
  );
}

export default CocoaPopover;
