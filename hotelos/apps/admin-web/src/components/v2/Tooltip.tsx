import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: string | ReactNode;
  children: ReactNode;
  placement?: TooltipPlacement;
  delayMs?: number;
}

interface Position {
  top: number;
  left: number;
}

export function Tooltip({
  content,
  children,
  placement = "top",
  delayMs = 200
}: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const tooltipId = useId();

  const clearShowTimer = () => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };

  const handleEnter = () => {
    clearShowTimer();
    showTimerRef.current = setTimeout(() => setOpen(true), delayMs);
  };

  const handleLeave = () => {
    clearShowTimer();
    setOpen(false);
  };

  useEffect(() => () => clearShowTimer(), []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const triggerEl = triggerRef.current;
    const tooltipEl = tooltipRef.current;
    if (!triggerEl || !tooltipEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const gap = 8;
    let top = 0;
    let left = 0;
    switch (placement) {
      case "top":
        top = triggerRect.top - tooltipRect.height - gap;
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
        break;
      case "bottom":
        top = triggerRect.bottom + gap;
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
        break;
      case "left":
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
        left = triggerRect.left - tooltipRect.width - gap;
        break;
      case "right":
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
        left = triggerRect.right + gap;
        break;
    }
    // Clamp within viewport
    const padding = 4;
    const maxLeft = window.innerWidth - tooltipRect.width - padding;
    const maxTop = window.innerHeight - tooltipRect.height - padding;
    left = Math.max(padding, Math.min(left, maxLeft));
    top = Math.max(padding, Math.min(top, maxTop));
    setPos({ top, left });
  }, [open, placement, content]);

  const tooltipStyle: CSSProperties = {
    position: "fixed",
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    background: "var(--inverse-surface, #1a1a1a)",
    color: "var(--inverse-ink, #ffffff)",
    padding: "6px 10px",
    borderRadius: "var(--radius-sm, 8px)",
    fontSize: "var(--fs-xs, 11px)",
    lineHeight: "var(--lh-snug, 1.35)",
    fontWeight: 500,
    maxWidth: 240,
    boxShadow: "var(--shadow-md, 0 2px 6px rgba(26,26,26,0.06))",
    pointerEvents: "none",
    zIndex: 2000,
    opacity: pos ? 1 : 0,
    transition: "opacity var(--duration, 180ms) var(--ease)",
    whiteSpace: "normal"
  };

  const triggerProps = {
    ref: triggerRef,
    onMouseEnter: handleEnter,
    onMouseLeave: handleLeave,
    onFocus: handleEnter,
    onBlur: handleLeave,
    "aria-describedby": open ? tooltipId : undefined,
    style: { display: "inline-flex" } as CSSProperties
  };

  const tooltipNode =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            style={tooltipStyle}
          >
            {content}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <span {...triggerProps}>{children}</span>
      {tooltipNode}
    </>
  );
}

export default Tooltip;
