// CocoaInspector — the NON-MODAL detail panel of Cocoa 22 (Tanda UX-1 · U4,
// docs/design/UX-RECEPCION-FEEL.md §4 «Inspector lateral», F26, §7.1 2.4.3 /
// 2.4.11). A list or Mi día opens it with Enter / click on a row and moves it
// with ↑↓ without closing it; the detail no longer costs a full screen.
//
//   panel     `<aside role="complementary" aria-label>` in the flow (no portal,
//             no scrim, no focus trap, no scroll lock: the table stays usable)
//             · 360–420 px at the right, sticky under the toolbar · stacks
//             UNDER the table below 900 px (`CocoaInspectorLayout`)
//   head      title-3 600 + «Cerrar»; `commands` = the reservation command bar
//             (primary contextual `filled`, ≤ 2 `bordered`, «Más ▾»)
//   keyboard  Esc closes it — unless the key lands inside a modal overlay
//             (dialog / drawer / sheet), which owns Esc there — and the focus
//             goes back to the row (`returnFocusTo`, else whatever had the
//             focus when it opened)
//
// Hooks for the css lot: `c22-inspector` + data-open/data-width, parts
// `c22-inspector__head/__title/__commands/__body`; `c22-inspector-layout`
// (row ≥ 900, column below). No inline styles.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { CocoaButton } from "./CocoaButton";

export type CocoaInspectorWidth = "sm" | "md";

/** Panel widths in px: `sm` 360 · `md` 420 (§4). */
export const INSPECTOR_WIDTH: Record<CocoaInspectorWidth, number> = { sm: 360, md: 420 };

/** Breakpoint under which the inspector stacks under the table (px). */
export const INSPECTOR_STACK_BREAKPOINT = 900;

export interface CocoaInspectorProps {
  open: boolean;
  title: string;
  /** Command bar of the inspected entity (buttons; painted as a toolbar under the title). */
  commands?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name of the panel (default: the title). */
  "aria-label"?: string;
  /** Element to focus when it closes (the active row); default: the element focused when it opened. */
  returnFocusTo?: () => HTMLElement | null | undefined;
  width?: CocoaInspectorWidth;
  id?: string;
  className?: string;
}

/**
 * Whether an Escape keydown closes the inspector (pure): plain Escape that
 * nobody handled, outside any modal overlay (dialog / drawer / sheet own it).
 */
export function inspectorEscapeCloses(event: { key: string; defaultPrevented?: boolean; insideModal: boolean }): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !event.insideModal;
}

/** Whether a key event target sits inside a modal overlay (pure; anything with `closest()`). */
export function targetInsideModal(target: unknown): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null | undefined)?.closest;
  if (typeof closest !== "function") return false;
  return Boolean(closest.call(target, '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
}

/**
 * Element that gets the focus when the inspector closes (pure): the row the
 * caller names, else the element focused when it opened; never a node that
 * left the document.
 */
export function inspectorReturnFocusTarget(input: { preferred: { isConnected?: boolean } | null | undefined; opener: { isConnected?: boolean } | null | undefined }): { isConnected?: boolean } | null {
  const alive = (node: { isConnected?: boolean } | null | undefined) => (node && node.isConnected !== false ? node : null);
  return alive(input.preferred) ?? alive(input.opener);
}

export function CocoaInspector({ open, title, commands, onClose, children, "aria-label": ariaLabel, returnFocusTo, width = "md", id, className }: CocoaInspectorProps) {
  const headingId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const returnFocusRef = useRef(returnFocusTo);
  useEffect(() => {
    returnFocusRef.current = returnFocusTo;
  }, [returnFocusTo]);

  // Remember who opened it; on close, hand the focus back (WCAG 2.4.3).
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) {
      opener.current = (document.activeElement as HTMLElement | null) ?? null;
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const target = inspectorReturnFocusTarget({ preferred: returnFocusRef.current?.(), opener: opener.current }) as HTMLElement | null;
    target?.focus?.({ preventScroll: true });
    opener.current = null;
  }, [open]);

  // Esc closes (non-modal: no stopPropagation, no trap); modal overlays keep their own Esc.
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const handler = (event: KeyboardEvent) => {
      if (!inspectorEscapeCloses({ key: event.key, defaultPrevented: event.defaultPrevented, insideModal: targetInsideModal(event.target) })) return;
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <aside
      id={id}
      role="complementary"
      aria-label={ariaLabel ?? title}
      className={["c22-inspector", "cocoa-inspector", className].filter(Boolean).join(" ")}
      data-cocoa="inspector"
      data-open="true"
      data-width={width}
    >
      <header className="c22-inspector__head">
        <h2 id={headingId} className="c22-inspector__title">
          {title}
        </h2>
        <CocoaButton variant="plain" tone="neutral" size="small" aria-label="Cerrar" title="Cerrar (Esc)" onClick={onClose} icon={<CloseGlyph />} />
      </header>
      {commands ? (
        <div className="c22-inspector__commands" role="toolbar" aria-label="Acciones">
          {commands}
        </div>
      ) : null}
      <div className="c22-inspector__body">{children}</div>
    </aside>
  );
}

export interface CocoaInspectorLayoutProps {
  /** The table (or list) first, the inspector second. */
  children: ReactNode;
  /** Mirrors the inspector's `open` so the stylesheet can widen the list when it is closed. */
  open?: boolean;
  className?: string;
}

/** Row of [list][inspector] ≥ 900 px; the inspector stacks under the list below. */
export function CocoaInspectorLayout({ children, open = false, className }: CocoaInspectorLayoutProps) {
  return (
    <div className={["c22-inspector-layout", className].filter(Boolean).join(" ")} data-cocoa="inspector-layout" data-open={open ? "true" : "false"}>
      {children}
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default CocoaInspector;
