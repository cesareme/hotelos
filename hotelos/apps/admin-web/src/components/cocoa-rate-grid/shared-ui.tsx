// CocoaRateGrid v2 — small shared UI pieces for the editor's panels.
//
//   · RateGridSidePanel — 420 px right sheet, NOT modal for the grid (no
//     backdrop, the grid stays usable) but with a focus trap and Esc. Esc is
//     also caught at window level while open: after a click on a non-focusable
//     text of the panel the focus lands on <body> and the panel's own
//     onKeyDown would never see the key.
//   · RateGridPopover  — fixed-position popover anchored to a viewport rect
//     (selection bounding box or a cell), flips when it would overflow and is
//     re-placed whenever its own size changes (a mode switch that makes it
//     taller must not push its buttons below the viewport); placement math in
//     helpers.placePopover.
//   · TriStateChip / NumericTriChip — "sin cambio / activar / desactivar"
//     restriction chips used by quick edit and bulk edit.
//   · Weekday picker, tabs.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WEEKDAY_LABELS, placePopover } from "./helpers";
import type { TriState } from "./types";

const FOCUSABLE = [
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.hasAttribute("disabled") && n.getAttribute("aria-hidden") !== "true");
}

/* ------------------------------------------------------------------ */
/*  Side panel                                                         */
/* ------------------------------------------------------------------ */

export interface RateGridSidePanelProps {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** Keep the panel mounted while closed (animation). Default true. */
  labelledBy?: string;
}

export function RateGridSidePanel({ open, title, subtitle, children, footer, onClose, wide = false }: RateGridSidePanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const titleId = useMemo(() => `crg-sheet-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      previousFocus.current = document.activeElement as HTMLElement | null;
      const t = window.setTimeout(() => {
        const first = focusables(ref.current).find((n) => !n.classList.contains("crg-sheet__close")) ?? focusables(ref.current)[0];
        first?.focus();
      }, 30);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setMounted(false), 220);
    previousFocus.current?.focus?.();
    return () => window.clearTimeout(t);
  }, [open]);

  // Escape anywhere in the window closes the panel, except when the key is
  // aimed at another dialog stacked on top (alert, popover, confirm) or at the
  // panel itself (its own handler already closes and stops propagation).
  useEffect(() => {
    if (!open) return;
    function onWindowKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target instanceof Node ? e.target : null;
      if (target && ref.current?.contains(target)) return;
      const otherDialog = target instanceof Element ? target.closest('[role="dialog"], [role="alertdialog"]') : null;
      if (otherDialog && otherDialog !== ref.current) return;
      onClose();
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [open, onClose]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = focusables(ref.current);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="false" aria-labelledby={titleId} className={`crg-sheet${open ? " crg-sheet--open" : ""}${wide ? " crg-sheet--wide" : ""}`} onKeyDown={onKeyDown}>
      <div className="crg-sheet__head">
        <div style={{ minWidth: 0 }}>
          <h2 id={titleId} className="crg-sheet__title">
            {title}
          </h2>
          {subtitle ? <p className="crg-sheet__subtitle">{subtitle}</p> : null}
        </div>
        <button type="button" className="crg-sheet__close" aria-label="Cerrar" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="crg-sheet__body">{children}</div>
      {footer ? <div className="crg-sheet__foot">{footer}</div> : null}
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/*  Popover                                                            */
/* ------------------------------------------------------------------ */

export type AnchorRect = DOMRect | { top: number; left: number; width: number; height: number } | null;

export interface RateGridPopoverProps {
  open: boolean;
  anchorRect: AnchorRect;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  ariaLabel: string;
}

export function RateGridPopover({ open, anchorRect, onClose, children, wide = false, ariaLabel }: RateGridPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const anchor = anchorRect ? { top: anchorRect.top, left: anchorRect.left, width: anchorRect.width, height: anchorRect.height } : null;
    const next = placePopover({ anchor, width: el.offsetWidth, height: el.offsetHeight, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  }, [anchorRect]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  // Content changes (main → adjust → reject with «Otro») make the popover
  // taller after the first placement: re-place on every size change and on
  // viewport resizes so the confirm button never lands below the fold.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => place()) : null;
    observer?.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => focusables(ref.current)[0]?.focus(), 20);
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  const style: CSSProperties = pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 };
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={ariaLabel}
      className={`crg-pop${wide ? " crg-pop--wide" : ""}`}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/*  Tri-state chips                                                    */
/* ------------------------------------------------------------------ */

export function nextTriState(s: TriState): TriState {
  return s === "unchanged" ? "on" : s === "on" ? "off" : "unchanged";
}

export function TriStateChip({ label, state, onChange, title }: { label: string; state: TriState; onChange: (s: TriState) => void; title?: string }) {
  const desc = state === "on" ? "activar" : state === "off" ? "desactivar" : "sin cambio";
  return (
    <button
      type="button"
      className={`crg-tri${state === "on" ? " crg-tri--on" : state === "off" ? " crg-tri--off" : ""}`}
      aria-pressed={state !== "unchanged"}
      aria-label={`${label}: ${desc}. Pulsa para cambiar`}
      title={title ?? `${label} · ${desc}`}
      onClick={() => onChange(nextTriState(state))}
    >
      {state === "on" ? "✓ " : state === "off" ? "✕ " : ""}
      {label}
    </button>
  );
}

/** Numeric restriction: "sin cambio" → value (input) → "quitar". */
export function NumericTriChip({ label, state, value, onChange, min = 0, max = 365 }: { label: string; state: TriState; value: string; onChange: (s: TriState, v: string) => void; min?: number; max?: number }) {
  const desc = state === "on" ? `fijar a ${value || "…"}` : state === "off" ? "quitar" : "sin cambio";
  return (
    <span className={`crg-tri${state === "on" ? " crg-tri--on" : state === "off" ? " crg-tri--off" : ""}`} title={`${label} · ${desc}`}>
      <button
        type="button"
        style={{ all: "unset", cursor: "pointer" }}
        aria-pressed={state !== "unchanged"}
        aria-label={`${label}: ${desc}. Pulsa para cambiar`}
        onClick={() => onChange(nextTriState(state), value)}
      >
        {state === "off" ? "✕ " : ""}
        {label}
      </button>
      {state === "on" ? (
        <input
          className="crg-tri__num"
          type="number"
          min={min}
          max={max}
          value={value}
          aria-label={`${label}, valor`}
          onChange={(e) => onChange("on", e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Weekdays & tabs                                                    */
/* ------------------------------------------------------------------ */

export function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const set = new Set(value);
  return (
    <div className="crg-wd" role="group" aria-label="Días de la semana">
      {WEEKDAY_LABELS.map((d) => (
        <button
          key={d.value}
          type="button"
          className={`crg-wd__btn${set.has(d.value) ? " crg-wd__btn--on" : ""}`}
          aria-pressed={set.has(d.value)}
          aria-label={d.long}
          title={d.long}
          onClick={() => {
            const next = new Set(set);
            if (next.has(d.value)) next.delete(d.value);
            else next.add(d.value);
            onChange([...next].sort());
          }}
        >
          {d.short}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div className="crg-tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={`crg-tabs__btn${o.value === value ? " crg-tabs__btn--on" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="crg-field">
      <span className="crg-field__label">{label}</span>
      {children}
      {hint ? <span className="crg-note">{hint}</span> : null}
    </label>
  );
}
