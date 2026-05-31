import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { CocoaButton } from "../cocoa/CocoaButton";

export interface CocoaGuidedTourStep {
  /** CSS selector for the element to spotlight. If not found, the tooltip falls back to centered display. */
  target?: string;
  /** Title displayed at the top of the tooltip card. */
  title: string;
  /** Body content explaining this step. */
  body: ReactNode;
  /** Optional preferred placement for the tooltip relative to the target. Defaults to "auto". */
  placement?: "top" | "bottom" | "left" | "right" | "auto";
}

export interface CocoaGuidedTourProps {
  /** Ordered list of steps to display. */
  steps: CocoaGuidedTourStep[];
  /** Whether the tour is currently open. */
  open: boolean;
  /** Called when the user reaches the final step and clicks Terminar. */
  onComplete: () => void;
  /** Called when the user clicks Saltar to abandon the tour. */
  onSkip: () => void;
  /** localStorage key used to persist completion across sessions. If provided, the tour will not show again once completed/skipped. */
  persistKey?: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PADDING = 8;
const TOOLTIP_OFFSET = 16;
const TOOLTIP_WIDTH = 380;
const VIEWPORT_MARGIN = 16;
const POLL_INTERVAL_MS = 80;
const POLL_MAX_TRIES = 24;

const PERSIST_PREFIX = "cocoa-guided-tour:";

function isPersistComplete(persistKey?: string): boolean {
  if (!persistKey) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${PERSIST_PREFIX}${persistKey}`) === "1";
  } catch {
    return false;
  }
}

function markPersistComplete(persistKey?: string): void {
  if (!persistKey) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${PERSIST_PREFIX}${persistKey}`, "1");
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

function locateRect(selector: string | undefined): Rect | null {
  if (!selector) return null;
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const style = window.getComputedStyle(el);
  if (
    style.visibility === "hidden" ||
    style.display === "none" ||
    Number(style.opacity) === 0
  ) {
    return null;
  }
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function computeTooltipStyle(
  spotlight: Rect | null,
  placement: CocoaGuidedTourStep["placement"],
  viewport: { width: number; height: number }
): CSSProperties {
  const style: CSSProperties = {
    width: Math.min(TOOLTIP_WIDTH, viewport.width - VIEWPORT_MARGIN * 2)
  };

  if (!spotlight) {
    style.left = "50%";
    style.top = "50%";
    style.transform = "translate(-50%, -50%)";
    return style;
  }

  const tooltipW = (style.width as number) ?? TOOLTIP_WIDTH;
  const estimatedH = 220;

  const roomBelow = viewport.height - (spotlight.top + spotlight.height);
  const roomAbove = spotlight.top;
  const roomRight = viewport.width - (spotlight.left + spotlight.width);
  const roomLeft = spotlight.left;

  type Placement = "top" | "bottom" | "left" | "right";
  let resolved: Placement;
  if (!placement || placement === "auto") {
    if (roomBelow >= estimatedH + TOOLTIP_OFFSET) resolved = "bottom";
    else if (roomAbove >= estimatedH + TOOLTIP_OFFSET) resolved = "top";
    else if (roomRight >= tooltipW + TOOLTIP_OFFSET) resolved = "right";
    else if (roomLeft >= tooltipW + TOOLTIP_OFFSET) resolved = "left";
    else resolved = "bottom";
  } else {
    resolved = placement;
  }

  if (resolved === "bottom") {
    let left = spotlight.left + spotlight.width / 2 - tooltipW / 2;
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, viewport.width - tooltipW - VIEWPORT_MARGIN)
    );
    style.left = left;
    style.top = spotlight.top + spotlight.height + TOOLTIP_OFFSET;
  } else if (resolved === "top") {
    let left = spotlight.left + spotlight.width / 2 - tooltipW / 2;
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, viewport.width - tooltipW - VIEWPORT_MARGIN)
    );
    style.left = left;
    style.bottom = viewport.height - spotlight.top + TOOLTIP_OFFSET;
  } else if (resolved === "right") {
    style.left = spotlight.left + spotlight.width + TOOLTIP_OFFSET;
    let top = spotlight.top + spotlight.height / 2 - estimatedH / 2;
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, viewport.height - estimatedH - VIEWPORT_MARGIN)
    );
    style.top = top;
  } else {
    // left
    style.right = viewport.width - spotlight.left + TOOLTIP_OFFSET;
    let top = spotlight.top + spotlight.height / 2 - estimatedH / 2;
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, viewport.height - estimatedH - VIEWPORT_MARGIN)
    );
    style.top = top;
  }

  return style;
}

export function CocoaGuidedTour({
  steps,
  open,
  onComplete,
  onSkip,
  persistKey
}: CocoaGuidedTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number }>(
    () => ({
      width: typeof window !== "undefined" ? window.innerWidth : 1024,
      height: typeof window !== "undefined" ? window.innerHeight : 768
    })
  );

  const shouldRender = open && !isPersistComplete(persistKey) && steps.length > 0;

  // Reset to first step every time the tour opens fresh.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const step = shouldRender ? steps[Math.min(index, steps.length - 1)] : undefined;
  const isLast = index >= steps.length - 1;
  const isFirst = index <= 0;

  // Locate the target for the current step. Poll briefly to handle async DOM updates.
  useEffect(() => {
    if (!step) {
      setRect(null);
      return undefined;
    }
    if (!step.target) {
      setRect(null);
      return undefined;
    }
    let cancelled = false;
    let tries = 0;
    let timer: number | undefined;

    function tick() {
      if (cancelled) return;
      const found = locateRect(step!.target);
      if (found) {
        setRect(found);
        return;
      }
      tries += 1;
      if (tries < POLL_MAX_TRIES) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      } else {
        setRect(null);
      }
    }
    setRect(null);
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [step]);

  // Recompute on resize/scroll to keep the spotlight aligned with the target.
  const recompute = useCallback(() => {
    if (typeof window !== "undefined") {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    if (step?.target) {
      const found = locateRect(step.target);
      setRect(found);
    }
  }, [step]);

  useEffect(() => {
    if (!shouldRender) return undefined;
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [recompute, shouldRender]);

  const handleNext = useCallback(() => {
    if (isLast) {
      markPersistComplete(persistKey);
      onComplete();
      return;
    }
    setIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [isLast, onComplete, persistKey, steps.length]);

  const handlePrev = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  const handleSkip = useCallback(() => {
    markPersistComplete(persistKey);
    onSkip();
  }, [onSkip, persistKey]);

  // Keyboard navigation.
  useEffect(() => {
    if (!shouldRender) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleSkip();
      else if (e.key === "ArrowRight" || e.key === "Enter") handleNext();
      else if (e.key === "ArrowLeft") handlePrev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNext, handlePrev, handleSkip, shouldRender]);

  const spotlight: Rect | null = useMemo(() => {
    if (!rect) return null;
    return {
      top: rect.top - SPOTLIGHT_PADDING,
      left: rect.left - SPOTLIGHT_PADDING,
      width: rect.width + SPOTLIGHT_PADDING * 2,
      height: rect.height + SPOTLIGHT_PADDING * 2
    };
  }, [rect]);

  const tooltipStyle = useMemo(
    () => computeTooltipStyle(spotlight, step?.placement, viewport),
    [spotlight, step?.placement, viewport]
  );

  if (!shouldRender || !step) return null;

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 9000,
    pointerEvents: "auto",
    fontFamily: "var(--cocoa-font)"
  };

  const dimColor = "rgba(0, 0, 0, 0.55)";

  // The spotlight mask: when there's a target rect, cut a hole using four
  // dimming rectangles around it; otherwise dim the whole viewport.
  const maskNodes: ReactNode = spotlight ? (
    <>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: Math.max(0, spotlight.top),
          background: dimColor,
          transition:
            "all var(--cocoa-duration-fast, 160ms) var(--cocoa-ease-out, ease)"
        }}
      />
      <div
        style={{
          position: "absolute",
          top: spotlight.top + spotlight.height,
          left: 0,
          right: 0,
          bottom: 0,
          background: dimColor,
          transition:
            "all var(--cocoa-duration-fast, 160ms) var(--cocoa-ease-out, ease)"
        }}
      />
      <div
        style={{
          position: "absolute",
          top: spotlight.top,
          left: 0,
          width: Math.max(0, spotlight.left),
          height: spotlight.height,
          background: dimColor,
          transition:
            "all var(--cocoa-duration-fast, 160ms) var(--cocoa-ease-out, ease)"
        }}
      />
      <div
        style={{
          position: "absolute",
          top: spotlight.top,
          left: spotlight.left + spotlight.width,
          right: 0,
          height: spotlight.height,
          background: dimColor,
          transition:
            "all var(--cocoa-duration-fast, 160ms) var(--cocoa-ease-out, ease)"
        }}
      />
      <div
        style={{
          position: "absolute",
          top: spotlight.top,
          left: spotlight.left,
          width: spotlight.width,
          height: spotlight.height,
          borderRadius: "var(--cocoa-radius-md, 8px)",
          boxShadow: "0 0 0 2px var(--cocoa-accent, #007aff), 0 8px 32px rgba(0,0,0,0.25)",
          pointerEvents: "none",
          transition:
            "all var(--cocoa-duration-fast, 160ms) var(--cocoa-ease-out, ease)"
        }}
      />
    </>
  ) : (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: dimColor
      }}
    />
  );

  const cardStyle: CSSProperties = {
    position: "absolute",
    background: "var(--cocoa-background-content, #ffffff)",
    color: "var(--cocoa-label, #1d1d1f)",
    borderRadius: "var(--cocoa-radius-lg, 12px)",
    boxShadow:
      "0 10px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)",
    padding: "var(--cocoa-space-5, 20px)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-3, 12px)",
    ...tooltipStyle
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12
  };

  const progressStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption, 12px)",
    color: "var(--cocoa-label-secondary, #6e6e73)",
    fontWeight: 500,
    letterSpacing: "var(--cocoa-tracking-wide, 0.02em)",
    textTransform: "uppercase"
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3, 18px)",
    fontWeight: 600,
    margin: 0,
    color: "var(--cocoa-label, #1d1d1f)",
    lineHeight: 1.3
  };

  const bodyStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-body, 14px)",
    lineHeight: 1.5,
    color: "var(--cocoa-label-secondary, #424245)",
    margin: 0
  };

  const footerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: "var(--cocoa-space-2, 8px)"
  };

  const actionsStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8
  };

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Recorrido guiado"
    >
      {maskNodes}
      <div style={cardStyle} role="document">
        <div style={headerStyle}>
          <span style={progressStyle}>
            Paso {index + 1} de {steps.length}
          </span>
          <CocoaButton
            variant="plain"
            tone="neutral"
            size="small"
            onClick={handleSkip}
            aria-label="Saltar recorrido"
          >
            Saltar
          </CocoaButton>
        </div>
        <h3 style={titleStyle}>{step.title}</h3>
        <div style={bodyStyle}>{step.body}</div>
        <div style={footerStyle}>
          <div style={actionsStyle}>
            {!isFirst ? (
              <CocoaButton
                variant="bordered"
                tone="neutral"
                size="regular"
                onClick={handlePrev}
              >
                Anterior
              </CocoaButton>
            ) : null}
          </div>
          <div style={actionsStyle}>
            <CocoaButton
              variant="filled"
              tone="accent"
              size="regular"
              onClick={handleNext}
            >
              {isLast ? "Terminar" : "Siguiente"}
            </CocoaButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CocoaGuidedTour;
