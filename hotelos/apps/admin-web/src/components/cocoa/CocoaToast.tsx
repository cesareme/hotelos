// CocoaToast — toast item and stack of Cocoa 22 (COCOA-22.md §3.9). The
// store, provider and `useToast()` stay in components/Toast.tsx (same API);
// `ToastHost` renders these.
//
//   item      content bg · label · radius 12 · shadow popover · hairline · 3 px
//             tone bar (inset) · slide-in-up 200 ms · click / Enter / Space /
//             Esc dismiss · role=alert (error) or status
//   stack     desktop: bottom-right, 24 px from the edge, bottom
//             `--hotelos-toast-offset` (default 120 px — the rate grid
//             contract: `RateGridStatusBar` publishes an ABSOLUTE bottom so the
//             toast clears its sticky bar, cierre 2026-09-15 browser-ux#21) ·
//             phone: below the toolbar (48 px + safe-area), full width minus
//             16 · z --cocoa-z-toast · max 3 (the store slices)
//
// Hooks for the css lot: `c22-toast` + data-variant/data-tone; stack
// `c22-toast-stack` (`data-cocoa="toast-stack"`). The stack keeps its inline
// position because the offset contract above is absolute, not additive.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { toneColor, type CocoaTone } from "./cocoa-tones";
import { useIsNarrow } from "./cocoa-viewport";

export type CocoaToastVariant = "success" | "error" | "info" | "warning";

/** Tone of a toast variant (pure): `error` → danger. */
export function toastTone(variant: CocoaToastVariant): CocoaTone {
  switch (variant) {
    case "success":
      return "success";
    case "error":
      return "danger";
    case "warning":
      return "warning";
    case "info":
    default:
      return "info";
  }
}

/** Fixed stack style by tier (pure). */
export function toastViewportStyle(isNarrow: boolean): CSSProperties {
  const base: CSSProperties = {
    position: "fixed",
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-2)",
    zIndex: "var(--cocoa-z-toast)" as CSSProperties["zIndex"],
    pointerEvents: "none",
    width: "auto"
  };
  if (isNarrow) {
    return { ...base, top: "calc(var(--cocoa-toolbar-height, 48px) + env(safe-area-inset-top) + var(--cocoa-space-2))", bottom: "auto", left: "var(--cocoa-space-4)", right: "var(--cocoa-space-4)" };
  }
  return { ...base, top: "auto", left: "auto", right: "var(--cocoa-space-5)", bottom: "var(--hotelos-toast-offset, 120px)" };
}

export interface CocoaToastProps {
  id: number | string;
  message: ReactNode;
  variant?: CocoaToastVariant;
  /** Auto-dismiss after ms; ≤ 0 keeps it until dismissed. */
  duration?: number;
  onDismiss: (id: number | string) => void;
}

export function CocoaToast({ id, message, variant = "info", duration = 4000, onDismiss }: CocoaToastProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNarrow = useIsNarrow();

  useEffect(() => {
    if (duration <= 0) return undefined;
    timer.current = setTimeout(() => onDismiss(id), duration);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [duration, id, onDismiss]);

  const tone = toastTone(variant);
  const isError = variant === "error";

  const style: CSSProperties = {
    display: "block",
    background: "var(--cocoa-background-content)",
    color: "var(--cocoa-label)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-lg)",
    boxShadow: `inset 3px 0 0 ${toneColor(tone)}, var(--cocoa-shadow-popover)`,
    padding: "var(--cocoa-space-3) var(--cocoa-space-4) var(--cocoa-space-3) calc(var(--cocoa-space-4) + 3px)",
    minWidth: isNarrow ? undefined : 260,
    maxWidth: isNarrow ? "100%" : 380,
    width: isNarrow ? "100%" : undefined,
    boxSizing: "border-box",
    cursor: "pointer",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: 1.35,
    animation: `${isNarrow ? "cocoa-slide-in-down" : "cocoa-slide-in-up"} var(--cocoa-duration-base) var(--cocoa-ease-out) both`,
    pointerEvents: "auto"
  };

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      tabIndex={0}
      className="c22-toast cocoa-toast cocoa-focus-ring"
      style={style}
      onClick={() => onDismiss(id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
          event.preventDefault();
          onDismiss(id);
        }
      }}
      data-cocoa="toast"
      data-variant={variant}
      data-tone={tone}
    >
      {message}
    </div>
  );
}

export interface CocoaToastViewportProps {
  children: ReactNode;
  "aria-label"?: string;
}

export function CocoaToastViewport({ children, "aria-label": ariaLabel = "Notificaciones" }: CocoaToastViewportProps) {
  const isNarrow = useIsNarrow();
  return (
    <div className="c22-toast-stack cocoa-toast-viewport" style={toastViewportStyle(isNarrow)} aria-label={ariaLabel} data-cocoa="toast-stack">
      {children}
    </div>
  );
}

/** Alias with the css lot's name. */
export const CocoaToastStack = CocoaToastViewport;

export default CocoaToast;
