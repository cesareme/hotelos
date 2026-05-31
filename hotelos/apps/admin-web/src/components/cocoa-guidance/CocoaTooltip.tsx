// CocoaTooltip — lightweight hover tooltip with macOS-native visuals.
//
// Wraps a single child trigger and shows a small floating label on hover or
// keyboard focus, with a configurable show delay (matches the way AppKit
// debounces tooltip appearance so flick-overs don't spam the screen). The
// tooltip itself is rendered through createPortal into document.body so it
// escapes any parent overflow:hidden / transform contexts that would clip it.
//
// Visuals are intentionally hand-tuned (rather than going through
// --cocoa-background-content) because Cocoa tooltips use a dark translucent
// material even in light mode — that's what makes them feel like tooltips
// rather than popovers. Padding, radius and font-size still come from the
// Cocoa token CSS so they stay in lockstep with the design system.
//
// If a `shortcut` string is provided we render it inside a <kbd> at the end
// of the tooltip in a monospaced font, AppKit-style. This is the right place
// to surface a keyboard equivalent for a toolbar button or icon-only action.
//
// Motion: fade in + a small upward translate, easing-out. We intentionally
// don't scale (tooltips are small, scaling looks jittery) and the duration is
// fast — tooltips should feel responsive, not animated.

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type CocoaTooltipPlacement = "top" | "bottom" | "left" | "right";

export interface CocoaTooltipProps {
  /** Tooltip body — typically a short string, but ReactNode is allowed for
   *  things like an inline icon + label. */
  content: ReactNode;
  /** Side of the trigger the tooltip prefers to appear on. Defaults to "top",
   *  which is the AppKit default for toolbar tooltips. */
  placement?: CocoaTooltipPlacement;
  /** Milliseconds to wait after pointerenter / focus before showing. Matches
   *  AppKit's `NSToolTipManager` default-ish behavior (500ms feels native);
   *  callers can drop it to 0 for "instant" tooltips on power-user surfaces. */
  delay?: number;
  /** Optional keyboard shortcut hint, e.g. "⌘K", "⇧⌘P". Rendered inside a
   *  <kbd> at the end of the tooltip. */
  shortcut?: string;
  /** The trigger element. Must be a single React element — we attach event
   *  handlers and a ref to it via cloneElement. */
  children: ReactElement;
}

// Distance between the trigger edge and the tooltip edge.
const OFFSET = 6;
// How much we translate during the entry animation (px). Direction depends
// on placement so the tooltip appears to slide toward its trigger.
const ENTRY_TRANSLATE = 4;

interface Position {
  top: number;
  left: number;
}

function computePosition(
  anchorRect: DOMRect,
  tooltipRect: { width: number; height: number },
  placement: CocoaTooltipPlacement,
): Position {
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;

  switch (placement) {
    case "bottom":
      return {
        top: anchorRect.bottom + OFFSET,
        left: anchorCenterX - tooltipRect.width / 2,
      };
    case "left":
      return {
        top: anchorCenterY - tooltipRect.height / 2,
        left: anchorRect.left - tooltipRect.width - OFFSET,
      };
    case "right":
      return {
        top: anchorCenterY - tooltipRect.height / 2,
        left: anchorRect.right + OFFSET,
      };
    case "top":
    default:
      return {
        top: anchorRect.top - tooltipRect.height - OFFSET,
        left: anchorCenterX - tooltipRect.width / 2,
      };
  }
}

// Direction of the entry translate. The tooltip slides *toward* the trigger,
// which is the same convention native Cocoa tooltips use.
function getEntryTranslate(placement: CocoaTooltipPlacement): string {
  switch (placement) {
    case "bottom":
      return `translateY(-${ENTRY_TRANSLATE}px)`;
    case "left":
      return `translateX(${ENTRY_TRANSLATE}px)`;
    case "right":
      return `translateX(-${ENTRY_TRANSLATE}px)`;
    case "top":
    default:
      return `translateY(${ENTRY_TRANSLATE}px)`;
  }
}

export function CocoaTooltip({
  content,
  placement = "top",
  delay = 500,
  shortcut,
  children,
}: CocoaTooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // Show timeout — we hold the open in suspension during `delay` so a
  // quick mouse flicker doesn't pop the tooltip open and immediately closed.
  const showTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  // Stable id so we can wire aria-describedby on the trigger.
  const tooltipId = useId();

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  // Schedule open after `delay` ms; 0 means "synchronous open" which is what
  // power users on hotkey surfaces typically want.
  const scheduleOpen = useCallback(() => {
    clearShowTimer();
    if (delay <= 0) {
      setOpen(true);
      return;
    }
    showTimerRef.current = window.setTimeout(() => {
      setOpen(true);
      showTimerRef.current = null;
    }, delay);
  }, [clearShowTimer, delay]);

  const close = useCallback(() => {
    clearShowTimer();
    setOpen(false);
    // Clear position so the next open starts hidden until measured (avoids a
    // single-frame flash at the previous spot, which can be jarring when the
    // trigger has moved).
    setPosition(null);
  }, [clearShowTimer]);

  // Tear down any pending timer on unmount so we don't try to setOpen on an
  // unmounted component.
  useEffect(() => {
    return () => {
      clearShowTimer();
    };
  }, [clearShowTimer]);

  // Position once we have a tooltip element to measure. useLayoutEffect so we
  // place before paint and avoid a (0,0) flash on the first frame.
  useLayoutEffect(() => {
    if (!open) return;
    const triggerEl = triggerRef.current;
    const tooltipEl = tooltipRef.current;
    if (triggerEl === null || tooltipEl === null) return;
    const anchorRect = triggerEl.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    setPosition(
      computePosition(
        anchorRect,
        { width: tooltipRect.width, height: tooltipRect.height },
        placement,
      ),
    );
  }, [open, placement, content, shortcut]);

  // Reposition while open if the page scrolls or resizes underneath us.
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      const triggerEl = triggerRef.current;
      const tooltipEl = tooltipRef.current;
      if (triggerEl === null || tooltipEl === null) return;
      const anchorRect = triggerEl.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      setPosition(
        computePosition(
          anchorRect,
          { width: tooltipRect.width, height: tooltipRect.height },
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
  }, [open, placement]);

  // Hide on Escape — this is required for accessibility (a sighted keyboard
  // user must be able to dismiss the tooltip without moving focus).
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, close]);

  if (!isValidElement(children)) {
    // Defensive: caller passed a non-element child (e.g. a raw string). We
    // can't attach handlers, so just render it without a tooltip rather than
    // throwing — tooltips should never break the surrounding UI.
    return <>{children}</>;
  }

  // Type the wrapped child so we can read existing handlers off it without
  // tripping `noImplicitAny`. We intentionally keep this loose because the
  // child can be any host or custom component.
  type TriggerProps = {
    onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
    onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
    onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
    onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
    ref?: React.Ref<HTMLElement>;
    "aria-describedby"?: string;
  };
  const childElement = children as ReactElement<TriggerProps>;
  const childProps: TriggerProps = childElement.props;

  // Compose handlers so we don't clobber any that the caller already set on
  // the trigger.
  const handleMouseEnter = (event: ReactMouseEvent<HTMLElement>) => {
    scheduleOpen();
    childProps.onMouseEnter?.(event);
  };
  const handleMouseLeave = (event: ReactMouseEvent<HTMLElement>) => {
    close();
    childProps.onMouseLeave?.(event);
  };
  const handleFocus = (event: ReactFocusEvent<HTMLElement>) => {
    // Focus-driven tooltips skip the delay — a keyboard user has clearly
    // landed on this control deliberately and shouldn't have to wait.
    clearShowTimer();
    setOpen(true);
    childProps.onFocus?.(event);
  };
  const handleBlur = (event: ReactFocusEvent<HTMLElement>) => {
    close();
    childProps.onBlur?.(event);
  };

  // We capture the trigger element with a callback ref so we have it for
  // positioning, while preserving any caller-supplied ref.
  const setTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    const callerRef = childProps.ref;
    if (typeof callerRef === "function") {
      callerRef(node);
    } else if (callerRef !== undefined && callerRef !== null) {
      (callerRef as React.MutableRefObject<HTMLElement | null>).current = node;
    }
  };

  const triggerWithProps = cloneElement(childElement, {
    ref: setTriggerRef,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    // Wire the tooltip body as the accessible description so screen readers
    // announce it when the trigger is focused.
    "aria-describedby": open ? tooltipId : childProps["aria-describedby"],
  });

  const tooltipStyle: CSSProperties = {
    position: "fixed",
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    // Hide for the measurement frame so we don't flash at (0,0).
    visibility: position === null ? "hidden" : "visible",
    // Hand-tuned tooltip background — the dark translucent material is what
    // makes this read as a "tooltip" rather than a popover, regardless of
    // light/dark mode.
    background: "rgba(28, 28, 30, 0.92)",
    color: "#ffffff",
    padding: "6px 10px",
    borderRadius: "var(--cocoa-radius-sm)",
    fontFamily: "var(--cocoa-font-family)",
    fontSize: "var(--cocoa-fs-caption)",
    lineHeight: 1.3,
    maxWidth: 280,
    // Medium shadow — tighter than the popover token, since tooltips sit
    // closer to the surface and a heavy drop shadow reads as cartoony.
    boxShadow:
      "0 4px 6px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.08)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    pointerEvents: "none",
    zIndex: 2000,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    whiteSpace: "normal",
    wordBreak: "break-word",
    animation:
      "cocoa-tooltip-in var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    // CSS custom prop consumed by the keyframes — lets the entry translate
    // direction follow `placement` without per-placement keyframes.
    ["--cocoa-tooltip-entry-translate" as string]: getEntryTranslate(placement),
  };

  const kbdStyle: CSSProperties = {
    fontFamily: "var(--cocoa-font-mono)",
    fontSize: "var(--cocoa-fs-caption)",
    color: "rgba(255, 255, 255, 0.75)",
    background: "rgba(255, 255, 255, 0.12)",
    padding: "1px 5px",
    borderRadius: 3,
    whiteSpace: "nowrap",
    flexShrink: 0,
  };

  return (
    <>
      {/* Keyframes injected inline so the component is self-contained.
          Translate starts from the placement-aware custom prop above. */}
      <style>{`
        @keyframes cocoa-tooltip-in {
          from {
            opacity: 0;
            transform: var(--cocoa-tooltip-entry-translate);
          }
          to {
            opacity: 1;
            transform: translate(0, 0);
          }
        }
      `}</style>
      {triggerWithProps}
      {open &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            style={tooltipStyle}
          >
            <span>{content}</span>
            {shortcut !== undefined && shortcut !== "" && (
              <kbd style={kbdStyle}>{shortcut}</kbd>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export default CocoaTooltip;
