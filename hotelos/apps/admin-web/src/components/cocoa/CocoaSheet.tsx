import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export type CocoaSheetSize = "sm" | "md" | "lg";

export interface CocoaSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: CocoaSheetSize;
  footer?: ReactNode;
}

const MAX_WIDTH_BY_SIZE: Record<CocoaSheetSize, number> = {
  sm: 480,
  md: 640,
  lg: 880
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

export function CocoaSheet({
  open,
  onClose,
  title,
  children,
  size = "md",
  footer
}: CocoaSheetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const headingId = useId();

  // Manage mount/unmount with motion enter/exit.
  useEffect(() => {
    if (open) {
      setIsMounted(true);
      // Trigger transition on next frame so initial styles apply first.
      const raf = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }

    setIsVisible(false);
    if (!isMounted) return undefined;
    const timeout = window.setTimeout(() => {
      setIsMounted(false);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [open, isMounted]);

  // Focus management: trap focus inside the sheet while open.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    if (root) {
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      // Defer focus so the element exists in DOM and is paint-ready.
      window.requestAnimationFrame(() => {
        first.focus({ preventScroll: true });
      });
    }

    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isMounted]);

  // Esc + body scroll lock.
  useEffect(() => {
    if (!isMounted) return undefined;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isMounted, onClose]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;

      const focusables = getFocusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    },
    []
  );

  const maxWidth = MAX_WIDTH_BY_SIZE[size];

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: 1000,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.32)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      opacity: isVisible ? 1 : 0,
      transition:
        "opacity var(--cocoa-duration-slow) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none"
    }),
    [isVisible]
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: "100%",
      maxWidth,
      maxHeight: "calc(100vh - 24px)",
      display: "flex",
      flexDirection: "column",
      background: "var(--cocoa-background-content)",
      boxShadow: "var(--cocoa-shadow-modal)",
      borderBottomLeftRadius: "var(--cocoa-radius-xl)",
      borderBottomRightRadius: "var(--cocoa-radius-xl)",
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      transform: isVisible ? "translateY(0)" : "translateY(-100%)",
      transition:
        "transform var(--cocoa-duration-slow) var(--cocoa-ease-out)",
      outline: "none",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      overflow: "hidden"
    }),
    [isVisible, maxWidth]
  );

  const headerStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "16px 20px",
      borderBottom: "1px solid var(--cocoa-separator)",
      flexShrink: 0
    }),
    []
  );

  const titleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-title-3)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      color: "var(--cocoa-label)",
      lineHeight: 1.2,
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }),
    []
  );

  const bodyStyle = useMemo<CSSProperties>(
    () => ({
      padding: "20px",
      overflow: "auto",
      flex: 1,
      minHeight: 0
    }),
    []
  );

  const footerStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8,
      padding: "12px 20px",
      borderTop: "1px solid var(--cocoa-separator)",
      flexShrink: 0
    }),
    []
  );

  const closeButtonStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 28,
      height: 28,
      borderRadius: "var(--cocoa-radius-md)",
      background: "transparent",
      border: "1px solid transparent",
      color: "var(--cocoa-label-secondary)",
      cursor: "pointer",
      flexShrink: 0,
      padding: 0,
      transition:
        "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
    }),
    []
  );

  const handleCloseHover = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "var(--cocoa-background-control)";
    event.currentTarget.style.color = "var(--cocoa-label)";
  };

  const handleCloseLeave = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "transparent";
    event.currentTarget.style.color = "var(--cocoa-label-secondary)";
  };

  if (!isMounted) return null;
  if (typeof document === "undefined") return null;

  const labelledBy = title ? headingId : undefined;

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropClick}
      aria-hidden={!isVisible}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        {title !== undefined ? (
          <div style={headerStyle}>
            <h2 id={headingId} style={titleStyle}>
              {title}
            </h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              onMouseEnter={handleCloseHover}
              onMouseLeave={handleCloseLeave}
              className="cocoa-focus-ring"
              style={closeButtonStyle}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M1 1L13 13M13 1L1 13"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ) : null}
        <div style={bodyStyle}>{children}</div>
        {footer !== undefined ? <div style={footerStyle}>{footer}</div> : null}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaSheet;
