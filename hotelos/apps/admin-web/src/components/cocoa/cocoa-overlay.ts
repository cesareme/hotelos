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

type FocusCandidate = { disabled?: boolean; getAttribute?: (name: string) => string | null };

/** A preferred target that cannot take the focus (disabled / aria-disabled): `focus()` on it is a silent no-op. */
export function isFocusDisabled(element: FocusCandidate | null | undefined): boolean {
  if (!element) return true;
  if (element.disabled === true) return true;
  return element.getAttribute?.("aria-disabled") === "true";
}

/**
 * Where the initial focus of a trap lands (pure): the preferred element when it
 * can take the focus, else the first focusable, else the root. A CTA that is
 * born `disabled` (the check-in drawer while the room is being preselected,
 * UX-1 corrector L-01) must never leave the focus outside the panel.
 */
export function initialFocusTarget<E extends FocusCandidate>(preferred: E | null | undefined, focusables: readonly E[], root: E | null): E | null {
  if (preferred && !isFocusDisabled(preferred)) return preferred;
  return focusables[0] ?? root;
}

/** Frames tried before giving up on the initial focus (≈ 500 ms at 60 Hz). */
export const FOCUS_RETRY_FRAMES = 30;

/**
 * Focuses `pick()` on the next frame and RETRIES frame by frame while it does
 * not land (the panel is still `visibility: hidden` until `data-open` flips,
 * so an early `focus()` is a silent no-op — the check-in drawer opened from
 * the inspector with cached data hit exactly that, L-01). Stops as soon as the
 * focus is inside `root` (or `stop()` says the operator already moved it).
 * Returns the cancel function.
 */
export function focusWhenFocusable(root: HTMLElement | null, pick: () => HTMLElement | null | undefined, options: { maxFrames?: number; stop?: () => boolean } = {}): () => void {
  const maxFrames = options.maxFrames ?? FOCUS_RETRY_FRAMES;
  let raf = 0;
  let attempts = 0;
  const attempt = () => {
    attempts += 1;
    if (options.stop?.()) return;
    const target = pick();
    target?.focus({ preventScroll: true });
    const active = document.activeElement as HTMLElement | null;
    const landed = target ? active === target : Boolean(root && active && (active === root || root.contains(active)));
    if (!landed && attempts < maxFrames) raf = window.requestAnimationFrame(attempt);
  };
  raf = window.requestAnimationFrame(attempt);
  return () => window.cancelAnimationFrame(raf);
}

/** Active traps, innermost last: only the topmost one pulls a stray Tab back in (a dialog over a drawer). */
const activeTrapRoots: HTMLElement[] = [];

/** Whether `root` is the topmost active trap (pure over the stack). */
export function isTopmostTrap(stack: readonly HTMLElement[], root: HTMLElement): boolean {
  return stack.length > 0 && stack[stack.length - 1] === root;
}

/**
 * Traps Tab/Shift+Tab inside `ref` and moves the initial focus in (to
 * `initialFocus()` when given and focusable, else the first focusable, else
 * the root). A Tab pressed while the focus is OUTSIDE the panel (the trigger
 * row kept it because the CTA was disabled) is captured at document level and
 * brought back in (UX-1 corrector L-01). Restores focus to the previously
 * focused element on unmount.
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
    const cancel = focusWhenFocusable(root, () => initialFocusTarget(initialFocus?.(), getFocusableElements(root), root));
    return () => {
      cancel();
      const previous = previouslyFocused.current;
      if (previous && typeof previous.focus === "function") previous.focus({ preventScroll: true });
    };
    // `initialFocus` is read once on activation on purpose (not a dependency).
  }, [active, ref]);

  // Tab outside the panel while it is the topmost modal: pull the focus in.
  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current;
    if (!root) return undefined;
    activeTrapRoots.push(root);
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      if (!isTopmostTrap(activeTrapRoots, root)) return;
      const current = document.activeElement as HTMLElement | null;
      if (current && root.contains(current)) return; // the panel's own handler owns it
      const focusables = getFocusableElements(root);
      const target = trapTabTarget({ count: focusables.length, activeIndex: -1, shiftKey: event.shiftKey });
      event.preventDefault();
      if (target === "root" || target === null) root.focus({ preventScroll: true });
      else focusables[target]?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      const at = activeTrapRoots.lastIndexOf(root);
      if (at >= 0) activeTrapRoots.splice(at, 1);
    };
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
