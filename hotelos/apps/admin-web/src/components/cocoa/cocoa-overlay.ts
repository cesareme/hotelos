// Cocoa 22 · shared overlay mechanics for CocoaSheet, CocoaDrawer and
// CocoaDialog (COCOA-22.md §3.9): focus trap, Escape, body scroll lock and the
// mount/visible pair that lets an exit transition play before unmount.
//
// `trapTabTarget` is pure (unit-tested); the hooks wrap it for React.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

export const FOCUSABLE_SELECTOR = [
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

/** Focusable, visible descendants of `root` in DOM order. */
export function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

/**
 * Where a Tab press inside a trap must land (pure). Returns the index of the
 * element to focus, `"root"` when there is nothing focusable, or `null` when
 * the browser's default order is fine.
 */
export function trapTabTarget(input: {
  count: number;
  activeIndex: number; // -1 when the active element is outside the trap
  shiftKey: boolean;
}): number | "root" | null {
  const { count, activeIndex, shiftKey } = input;
  if (count === 0) return "root";
  if (shiftKey) {
    if (activeIndex === 0 || activeIndex === -1) return count - 1;
    return null;
  }
  if (activeIndex === count - 1) return 0;
  if (activeIndex === -1) return 0;
  return null;
}

/**
 * Traps Tab/Shift+Tab inside `ref` and moves the initial focus in (to
 * `initialFocus()` when given, else the first focusable, else the root).
 * Restores focus to the previously focused element on unmount.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  initialFocus?: () => HTMLElement | null | undefined
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    const root = ref.current;
    const raf = window.requestAnimationFrame(() => {
      const preferred = initialFocus?.();
      const target = preferred ?? getFocusableElements(root)[0] ?? root;
      target?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      const previous = previouslyFocused.current;
      if (previous && typeof previous.focus === "function") previous.focus({ preventScroll: true });
    };
    // `initialFocus` is read once on activation on purpose (not a dependency).
  }, [active, ref]);

  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const focusables = getFocusableElements(root);
      const active = document.activeElement as HTMLElement | null;
      const activeIndex = active && root.contains(active) ? focusables.indexOf(active) : -1;
      const target = trapTabTarget({ count: focusables.length, activeIndex, shiftKey: event.shiftKey });
      if (target === null) return;
      event.preventDefault();
      if (target === "root") root.focus({ preventScroll: true });
      else focusables[target]?.focus({ preventScroll: true });
    },
    [ref]
  );
}

/** Calls `onEscape` on Escape while `active` (stops propagation so shells don't double-handle). */
export function useEscapeKey(active: boolean, onEscape: (() => void) | undefined): void {
  useEffect(() => {
    if (!active || !onEscape) return undefined;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onEscape();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [active, onEscape]);
}

/** Locks body scroll while `active`, restoring the previous value after. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

/**
 * `mounted` stays true for `exitMs` after `open` flips to false so the exit
 * transition can play; `visible` flips a frame after mount so the entry
 * transition starts from the off-screen styles.
 */
export function useMountedTransition(open: boolean, exitMs: number): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState<boolean>(open);
  const [visible, setVisible] = useState<boolean>(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setVisible(false);
    if (!mounted) return undefined;
    const timeout = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timeout);
  }, [open, mounted, exitMs]);
  return { mounted, visible };
}

/** Scrim shared by drawers, sheets and dialogs: the `--cocoa-scrim` token (rgb(20 19 14 / .45), themes with the palette). */
export const COCOA_SCRIM = "var(--cocoa-scrim)";
