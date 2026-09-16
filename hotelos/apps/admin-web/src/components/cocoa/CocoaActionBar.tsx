// CocoaActionBar — the bottom action bar of forms, wizards and grids
// (COCOA-22.md §3.8 «Acciones», §5.1; replaces `.fp-sticky-actions`,
// `RateGridStatusBar`-style local bars).
//
//   desktop  sticky bottom 0 · window bg · hairline top · padding 12 · z sticky
//   phone    fixed bottom, full width, buttons stretch, padding-bottom safe-area,
//            the content scroller pads itself above it (`.cocoa-content:has(…)`)
//   status   left («3 celdas sin guardar»), extra nodes, secondary (bordered
//            neutral) and primary (filled accent) on the right
//   keyboard Ctrl/⌘ + Enter triggers the primary action (unless disabled/loading);
//            ignored while the key lands inside an open dialog / drawer / sheet
//            (`role="dialog"`), which owns Enter there (rate grid: the «Motivo»
//            sheet used to fire «Revisar y publicar»)
//   wrap     `wrap` lets a composed status (badge + text + chip + meta) break
//            onto several lines instead of the one-line ellipsis
//   toast    `publishToastOffset` writes `--hotelos-toast-offset` (bar height +
//            24) on <html> so toasts clear the bar (the rate grid contract).
//
// Placement (sticky / fixed / static, the phone breakpoint, the safe-area,
// the stretched buttons) is owned by the css lot through `.c22-action-bar`
// + data-sticky / data-mobile-only; the buttons are direct children so the
// `.c22-action-bar > button` rules reach them.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { CocoaButton, type CocoaButtonProps } from "./CocoaButton";
import { useIsNarrow } from "./cocoa-viewport";

export type CocoaActionBarAction = Omit<CocoaButtonProps, "children" | "ref"> & { label: string };

export interface CocoaActionBarProps {
  primary?: CocoaActionBarAction;
  secondary?: CocoaActionBarAction;
  /** Extra controls between the status and the buttons. */
  extra?: ReactNode;
  /** Status text at the left («Guardado a las 10:12», «3 celdas sin guardar»). */
  status?: ReactNode;
  /** Sticky on desktop (default true); false renders it in flow. */
  sticky?: boolean;
  /** Render only below 600 px (the desktop keeps its header actions). */
  mobileOnly?: boolean;
  /** Let the status wrap onto several lines (composed status: badge + text + chip); default one line with ellipsis. */
  wrap?: boolean;
  publishToastOffset?: boolean;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  "aria-label"?: string;
}

/** Ctrl/⌘ + Enter (pure). */
export function isPrimaryShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean }): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey;
}

/**
 * True when the shortcut's target sits inside an open overlay (dialog, drawer,
 * sheet: `role="dialog"` / `"alertdialog"`), which owns Enter there (pure; takes
 * anything with a `closest()` so tests need no DOM).
 */
export function shortcutInsideOverlay(target: unknown): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null | undefined)?.closest;
  if (typeof closest !== "function") return false;
  return Boolean(closest.call(target, '[role="dialog"], [role="alertdialog"]'));
}

/** Placement of the bar by tier (pure; informational `data-placement`, the stylesheet decides). */
export function actionBarPlacement(input: { isNarrow: boolean; sticky: boolean }): "fixed" | "sticky" | "static" {
  if (input.isNarrow) return "fixed";
  return input.sticky ? "sticky" : "static";
}

const TOAST_OFFSET_VAR = "--hotelos-toast-offset";

export function CocoaActionBar({ primary, secondary, extra, status, sticky = true, mobileOnly = false, wrap = false, publishToastOffset = false, className, style, "aria-label": ariaLabel }: CocoaActionBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const isNarrow = useIsNarrow();
  const placement = actionBarPlacement({ isNarrow, sticky });
  const hidden = mobileOnly && !isNarrow;

  // Ctrl/⌘ + Enter → primary.
  useEffect(() => {
    if (hidden || !primary || primary.disabled || primary.loading) return undefined;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isPrimaryShortcut(event) || shortcutInsideOverlay(event.target)) return;
      event.preventDefault();
      primaryRef.current?.click();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hidden, primary]);

  // Publish the bar height so the toast host clears it.
  useEffect(() => {
    if (!publishToastOffset || hidden) return undefined;
    const element = barRef.current;
    const root = document.documentElement;
    if (!element) return undefined;
    const write = () => root.style.setProperty(TOAST_OFFSET_VAR, `${Math.round(element.getBoundingClientRect().height) + 24}px`);
    write();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(write) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(TOAST_OFFSET_VAR);
    };
  }, [publishToastOffset, hidden]);

  if (hidden) return null;

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={ariaLabel ?? "Acciones"}
      className={["c22-action-bar", "cocoa-action-bar", className].filter(Boolean).join(" ")}
      style={style}
      data-cocoa="action-bar"
      data-placement={placement}
      data-sticky={sticky ? undefined : "false"}
      data-mobile-only={mobileOnly ? "true" : undefined}
      data-wrap={wrap ? "true" : undefined}
    >
      {status ? <div className="c22-action-bar__status">{status}</div> : null}
      {extra ? <div className="c22-action-bar__extra">{extra}</div> : null}
      {secondary ? (
        <CocoaButton {...secondary} variant={secondary.variant ?? "bordered"} tone={secondary.tone ?? "neutral"}>
          {secondary.label}
        </CocoaButton>
      ) : null}
      {primary ? (
        <CocoaButton {...primary} ref={primaryRef} variant={primary.variant ?? "filled"} tone={primary.tone ?? "accent"}>
          {primary.label}
        </CocoaButton>
      ) : null}
    </div>
  );
}

export default CocoaActionBar;
