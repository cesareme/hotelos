// CocoaToast — toast item and stack of Cocoa 22 (COCOA-22.md §3.9). The
// store, provider and `useToast()` stay in components/Toast.tsx (same API);
// `ToastHost` renders these.
//
//   item      content bg · label · radius 12 · shadow popover · hairline · 3 px
//             tone bar (inset) · slide-in-up 200 ms · click / Enter / Space /
//             Esc dismiss · role=alert (error) or status
//   action    (UX-1 · U4, §4 «Toast con acción», F17/F29) «Deshacer», «Ver
//             folio»: a CocoaButton plain reachable with Tab (the container
//             itself is tabIndex −1: Intro on it must never swallow the undo
//             window, L-21); the toast closes after it runs. The timer PAUSES
//             while the toast is hovered or holds the focus (`pauseOnHover`,
//             default true) and resumes with what was left.
//   announced the shell live region (CocoaLiveRegion `announce`) already read
//             it, so the item itself is silent (`aria-live="off"`, no live
//             role): one announcement per message (R5).
//   stack     desktop: bottom-right, 24 px from the edge, bottom
//             `--hotelos-toast-offset` (default 120 px — the rate grid
//             contract: `RateGridStatusBar` publishes an ABSOLUTE bottom so the
//             toast clears its sticky bar, cierre 2026-09-15 browser-ux#21) ·
//             phone: below the toolbar (48 px + safe-area), full width minus
//             16 · z --cocoa-z-toast · max 3 (the store slices) · WCAG 2.4.11
//             (focus not obscured): when the stack covers the focused element
//             it moves to the opposite edge (top-right on desktop, bottom on
//             a phone) until the stack empties (`toastStackObscures`).
//
// Hooks for the css lot: `c22-toast` + data-variant/data-tone/data-action/
// data-paused, parts `c22-toast__message` / `c22-toast__action`; stack
// `c22-toast-stack` (`data-cocoa="toast-stack"`, data-avoid-focus). The stack
// keeps its inline position because the offset contract above is absolute,
// not additive.

import { Children, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CocoaButton } from "./CocoaButton";
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

/**
 * Fixed stack style by tier (pure). `avoidFocus` (WCAG 2.4.11) flips the stack
 * to the opposite edge: top-right on desktop, bottom on a phone.
 */
export function toastViewportStyle(isNarrow: boolean, avoidFocus = false): CSSProperties {
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
    if (avoidFocus) {
      return { ...base, top: "auto", bottom: "calc(var(--cocoa-space-4) + env(safe-area-inset-bottom))", left: "var(--cocoa-space-4)", right: "var(--cocoa-space-4)" };
    }
    return { ...base, top: "calc(var(--cocoa-toolbar-height, 48px) + env(safe-area-inset-top) + var(--cocoa-space-2))", bottom: "auto", left: "var(--cocoa-space-4)", right: "var(--cocoa-space-4)" };
  }
  if (avoidFocus) {
    return { ...base, top: "calc(var(--cocoa-toolbar-height, 48px) + var(--cocoa-space-3))", bottom: "auto", left: "auto", right: "var(--cocoa-space-5)" };
  }
  return { ...base, top: "auto", left: "auto", right: "var(--cocoa-space-5)", bottom: "var(--hotelos-toast-offset, 120px)" };
}

export interface ToastRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Whether two boxes overlap (pure); touching edges do not count. */
export function rectsIntersect(a: ToastRect, b: ToastRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Whether the toast stack obscures the focused element (pure, WCAG 2.4.11):
 * only a real, painted stack (non-empty box) over an element outside it.
 */
export function toastStackObscures(input: { stack: ToastRect | null; focused: ToastRect | null; focusedInsideStack: boolean }): boolean {
  if (!input.stack || !input.focused || input.focusedInsideStack) return false;
  if (input.stack.right - input.stack.left <= 0 || input.stack.bottom - input.stack.top <= 0) return false;
  return rectsIntersect(input.stack, input.focused);
}

/** Time left on a paused timer (pure): what remained minus what elapsed since it (re)started, never below 0. */
export function remainingAfterPause(remainingMs: number, startedAt: number, now: number): number {
  return Math.max(0, remainingMs - Math.max(0, now - startedAt));
}

export interface CocoaToastAction {
  label: string;
  onAction: () => void | Promise<void>;
}

export interface CocoaToastProps {
  id: number | string;
  message: ReactNode;
  variant?: CocoaToastVariant;
  /** Auto-dismiss after ms; ≤ 0 keeps it until dismissed. */
  duration?: number;
  /** «Deshacer», «Ver folio»: a CocoaButton plain reachable with Tab; the toast closes after it runs. */
  action?: CocoaToastAction;
  /** Pause the auto-dismiss while hovered or focused (default true). */
  pauseOnHover?: boolean;
  /** The shell live region already announced it: the item stays silent (one announcement, R5). */
  announced?: boolean;
  onDismiss: (id: number | string) => void;
}

export function CocoaToast({ id, message, variant = "info", duration = 4000, action, pauseOnHover = true, announced = false, onDismiss }: CocoaToastProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);
  const [paused, setPaused] = useState(false);
  const isNarrow = useIsNarrow();

  const dismiss = useCallback(() => onDismiss(id), [id, onDismiss]);

  const stopTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = remainingAfterPause(remaining.current, startedAt.current, Date.now());
  }, []);

  const startTimer = useCallback(() => {
    if (duration <= 0 || timer.current !== null) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(dismiss, remaining.current);
  }, [duration, dismiss]);

  useEffect(() => {
    remaining.current = duration;
    startTimer();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [duration, startTimer]);

  const updatePause = useCallback(() => {
    if (!pauseOnHover) return;
    const shouldPause = hovered.current || focused.current;
    if (shouldPause) stopTimer();
    else startTimer();
    setPaused(shouldPause);
  }, [pauseOnHover, stopTimer, startTimer]);

  const tone = toastTone(variant);
  const isError = variant === "error";

  const style: CSSProperties = {
    display: action ? "flex" : "block",
    alignItems: action ? "center" : undefined,
    gap: action ? "var(--cocoa-space-3)" : undefined,
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
      // Announced by the shell region: a plain group named by its message (4.1.2, corrector UX1-REV-16); else its own live role.
      role={announced ? "group" : isError ? "alert" : "status"}
      aria-label={announced && typeof message === "string" ? message : undefined}
      aria-live={announced ? "off" : isError ? "assertive" : "polite"}
      // Not in the Tab order (corrector L-21): only the action button is reachable, so Intro never «descarta» a Deshacer by mistake.
      tabIndex={-1}
      className="c22-toast cocoa-toast cocoa-focus-ring"
      style={style}
      onClick={dismiss}
      onKeyDown={(event) => {
        // The action button owns its own Enter / Space (a prevented keydown would swallow its click).
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
          event.preventDefault();
          dismiss();
        }
      }}
      onMouseEnter={() => {
        hovered.current = true;
        updatePause();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        updatePause();
      }}
      onFocus={() => {
        focused.current = true;
        updatePause();
      }}
      onBlur={(event) => {
        // Focus moving to the action button keeps the toast paused.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        focused.current = false;
        updatePause();
      }}
      data-cocoa="toast"
      data-variant={variant}
      data-tone={tone}
      data-action={action ? "true" : undefined}
      data-paused={paused ? "true" : undefined}
      data-announced={announced ? "true" : undefined}
    >
      <span className="c22-toast__message">{message}</span>
      {action ? (
        <CocoaButton
          variant="plain"
          tone="accent"
          size="small"
          className="c22-toast__action"
          onClick={(event) => {
            event.stopPropagation();
            void action.onAction();
            dismiss();
          }}
        >
          {action.label}
        </CocoaButton>
      ) : null}
    </div>
  );
}

export interface CocoaToastViewportProps {
  children: ReactNode;
  "aria-label"?: string;
}

export function CocoaToastViewport({ children, "aria-label": ariaLabel = "Notificaciones" }: CocoaToastViewportProps) {
  const isNarrow = useIsNarrow();
  const stackRef = useRef<HTMLDivElement | null>(null);
  const [avoidFocus, setAvoidFocus] = useState(false);
  const count = Children.count(children);

  // WCAG 2.4.11: while toasts are visible, a focus that lands under the stack
  // moves it to the other edge; the stack comes back once it empties (no
  // oscillation: the flag only ever rises while toasts exist).
  useEffect(() => {
    if (count === 0) {
      setAvoidFocus(false);
      return undefined;
    }
    const check = () => {
      const stack = stackRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!stack || !active || active === document.body) return;
      const obscures = toastStackObscures({ stack: stack.getBoundingClientRect(), focused: active.getBoundingClientRect(), focusedInsideStack: stack.contains(active) });
      if (obscures) setAvoidFocus(true);
    };
    check();
    document.addEventListener("focusin", check);
    return () => document.removeEventListener("focusin", check);
  }, [count]);

  return (
    <div ref={stackRef} className="c22-toast-stack cocoa-toast-viewport" style={toastViewportStyle(isNarrow, avoidFocus)} aria-label={ariaLabel} data-cocoa="toast-stack" data-avoid-focus={avoidFocus ? "true" : undefined}>
      {children}
    </div>
  );
}

/** Alias with the css lot's name. */
export const CocoaToastStack = CocoaToastViewport;

export default CocoaToast;
