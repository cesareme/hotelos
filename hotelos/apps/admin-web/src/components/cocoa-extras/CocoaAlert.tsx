// CocoaAlert — NSAlert-style modal alert dialog following Cocoa visuals.
//
// Renders a centered, small modal (max-width 420px) with a large icon
// at the top, bold title, optional body message, and up to three actions
// in a horizontal row at the bottom:
//   - cancelAction   (left)
//   - secondaryAction (center)
//   - primaryAction  (right, supports `destructive` red styling)
//
// Type drives the leading icon and its tint:
//   - info     → InfoCircleIcon, var(--cocoa-info)     (blue)
//   - warning  → ExclamationCircleIcon, var(--cocoa-warning) (orange)
//   - critical → XCircleIcon, var(--cocoa-danger)      (red)
//
// Visuals: material popover blur backdrop with a fade, container with
// var(--cocoa-radius-lg) corners, var(--cocoa-shadow-modal), and a spring
// scale/translate entry powered by var(--cocoa-ease-spring). All colors
// resolve through cocoa-tokens so light/dark themes are picked up
// automatically.
//
// A11y:
// - role="alertdialog" + aria-modal="true"
// - aria-labelledby on the title and aria-describedby on the message
// - ESC triggers cancelAction.onClick (or onClose if no cancelAction)
// - Focus is moved into the dialog on open and restored on close; focus
//   is trapped within the dialog while open.
//
// Portal-mounted on document.body, so it escapes any stacking context.

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

import {
  ExclamationCircleIcon,
  InfoCircleIcon,
  XCircleIcon
} from "../cocoa-icons/StatusIcons";

export type CocoaAlertType = "info" | "warning" | "critical";

export interface CocoaAlertAction {
  label: string;
  onClick: () => void;
}

export interface CocoaAlertPrimaryAction extends CocoaAlertAction {
  destructive?: boolean;
}

export interface CocoaAlertProps {
  open: boolean;
  title: string;
  message?: string;
  type?: CocoaAlertType;
  primaryAction?: CocoaAlertPrimaryAction;
  secondaryAction?: CocoaAlertAction;
  cancelAction?: CocoaAlertAction;
  onClose: () => void;
}

interface TypeMeta {
  Icon: (props: { size?: number | string; "aria-hidden"?: boolean }) => ReactNode;
  color: string;
}

const TYPE_META: Record<CocoaAlertType, TypeMeta> = {
  info: {
    Icon: (props) => <InfoCircleIcon {...props} />,
    color: "var(--cocoa-info)"
  },
  warning: {
    Icon: (props) => <ExclamationCircleIcon {...props} />,
    color: "var(--cocoa-warning)"
  },
  critical: {
    Icon: (props) => <XCircleIcon {...props} />,
    color: "var(--cocoa-danger)"
  }
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

interface AlertButtonProps {
  label: string;
  onClick: () => void;
  variant: "primary" | "secondary" | "cancel";
  destructive?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

function AlertButton({
  label,
  onClick,
  variant,
  destructive = false,
  buttonRef
}: AlertButtonProps) {
  const isFilled = variant === "primary";
  const baseColor = destructive
    ? "var(--cocoa-danger)"
    : "var(--cocoa-accent)";

  const style = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: 80,
      height: 28,
      paddingInline: 14,
      paddingBlock: 0,
      borderRadius: "var(--cocoa-radius-md)",
      fontFamily: "var(--cocoa-font)",
      fontSize: "var(--cocoa-fs-body)",
      fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      lineHeight: 1,
      cursor: "pointer",
      userSelect: "none",
      WebkitAppearance: "none",
      appearance: "none",
      transition:
        "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), filter var(--cocoa-duration-fast) var(--cocoa-ease-out), transform var(--cocoa-duration-fast) var(--cocoa-ease-out)"
    };

    if (isFilled) {
      base.background = baseColor;
      base.color = destructive ? "#FFFFFF" : "var(--cocoa-accent-contrast)";
      base.border = "1px solid transparent";
    } else {
      base.background = "var(--cocoa-background-control)";
      base.color = "var(--cocoa-label)";
      base.border = "1px solid var(--cocoa-separator)";
      base.boxShadow = "var(--cocoa-shadow-control)";
    }

    return base;
  }, [isFilled, destructive, baseColor]);

  const handleMouseEnter = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    if (isFilled) {
      target.style.filter = "brightness(0.95)";
    } else {
      target.style.backgroundColor = "var(--cocoa-background-control-hover, var(--cocoa-background-control))";
      target.style.filter = "brightness(0.97)";
    }
  };

  const handleMouseLeave = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    target.style.filter = "";
    if (!isFilled) {
      target.style.backgroundColor = "var(--cocoa-background-control)";
    }
    target.style.transform = "";
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    if (isFilled) {
      target.style.filter = "brightness(0.85)";
    } else {
      target.style.transform = "scale(0.98)";
    }
  };

  const handleMouseUp = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    if (isFilled) {
      target.style.filter = "brightness(0.95)";
    } else {
      target.style.transform = "";
    }
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      className="cocoa-focus-ring"
      style={style}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {label}
    </button>
  );
}

export function CocoaAlert({
  open,
  title,
  message,
  type = "info",
  primaryAction,
  secondaryAction,
  cancelAction,
  onClose
}: CocoaAlertProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const titleId = useId();
  const messageId = useId();

  // Manage mount/unmount with motion enter/exit.
  useEffect(() => {
    if (open) {
      setIsMounted(true);
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

  // Focus management — focus the primary action (or first focusable) on open,
  // and restore focus on close.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    window.requestAnimationFrame(() => {
      if (primaryButtonRef.current) {
        primaryButtonRef.current.focus({ preventScroll: true });
        return;
      }
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      first?.focus({ preventScroll: true });
    });

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
        if (cancelAction) {
          cancelAction.onClick();
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isMounted, onClose, cancelAction]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        if (cancelAction) {
          cancelAction.onClick();
        } else {
          onClose();
        }
      }
    },
    [onClose, cancelAction]
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

  const meta = TYPE_META[type];

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: 1100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      background: "rgba(0, 0, 0, 0.32)",
      backdropFilter: "blur(8px) saturate(180%)",
      WebkitBackdropFilter: "blur(8px) saturate(180%)",
      opacity: isVisible ? 1 : 0,
      transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none"
    }),
    [isVisible]
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: "100%",
      maxWidth: 420,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 12,
      padding: "24px 24px 18px",
      background: "var(--cocoa-background-content)",
      borderRadius: "var(--cocoa-radius-lg)",
      boxShadow: "var(--cocoa-shadow-modal)",
      transform: isVisible ? "scale(1) translateY(0)" : "scale(0.94) translateY(-8px)",
      opacity: isVisible ? 1 : 0,
      transition:
        "transform var(--cocoa-duration-slow) var(--cocoa-ease-spring), opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      outline: "none",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)"
    }),
    [isVisible]
  );

  const iconWrapStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 48,
      height: 48,
      borderRadius: "50%",
      color: meta.color,
      marginBottom: 4,
      flexShrink: 0
    }),
    [meta.color]
  );

  const titleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-title-2)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      color: "var(--cocoa-label)",
      lineHeight: 1.25,
      textAlign: "center"
    }),
    []
  );

  const messageStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-body)",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-secondary)",
      lineHeight: 1.45,
      textAlign: "center"
    }),
    []
  );

  const actionsRowStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8,
      width: "100%",
      marginTop: 8
    }),
    []
  );

  const cancelSlotStyle = useMemo<CSSProperties>(
    () => ({
      marginRight: "auto",
      display: "inline-flex"
    }),
    []
  );

  if (!isMounted) return null;
  if (typeof document === "undefined") return null;

  const Icon = meta.Icon;
  const labelledBy = titleId;
  const describedBy = message ? messageId : undefined;

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropClick}
      aria-hidden={!isVisible}
    >
      <div
        ref={containerRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        <span style={iconWrapStyle} aria-hidden="true">
          <Icon size={40} aria-hidden={true} />
        </span>

        <h2 id={titleId} style={titleStyle}>
          {title}
        </h2>

        {message ? (
          <p id={messageId} style={messageStyle}>
            {message}
          </p>
        ) : null}

        {primaryAction || secondaryAction || cancelAction ? (
          <div style={actionsRowStyle}>
            {cancelAction ? (
              <span style={cancelSlotStyle}>
                <AlertButton
                  label={cancelAction.label}
                  onClick={cancelAction.onClick}
                  variant="cancel"
                />
              </span>
            ) : null}
            {secondaryAction ? (
              <AlertButton
                label={secondaryAction.label}
                onClick={secondaryAction.onClick}
                variant="secondary"
              />
            ) : null}
            {primaryAction ? (
              <AlertButton
                label={primaryAction.label}
                onClick={primaryAction.onClick}
                variant="primary"
                destructive={primaryAction.destructive}
                buttonRef={(el) => {
                  primaryButtonRef.current = el;
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaAlert;
