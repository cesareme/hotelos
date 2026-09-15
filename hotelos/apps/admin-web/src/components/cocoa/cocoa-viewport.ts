// Cocoa 22 · viewport + container helpers (COCOA-22.md §5.1).
//
// Breakpoints: phone < 600 · tablet 600–899 · laptop 900–1199 · desktop ≥ 1200.
// `viewportTier` is pure (unit-tested); the hooks are SSR-safe wrappers over
// `matchMedia` / `ResizeObserver` shared by every primitive so the whole kit
// changes tier at the same pixel.

import { useEffect, useState, type RefObject } from "react";

export const COCOA_BREAKPOINTS = {
  /** Below this the layout is a single column (phone). */
  phone: 600,
  /** Below this spans < half collapse to half (tablet portrait). */
  tablet: 900,
  /** Below this the sidebar is collapsible (laptop). */
  desktop: 1200
} as const;

export type CocoaViewportTier = "phone" | "tablet" | "laptop" | "desktop";

/** Tier of a width in CSS px (pure). */
export function viewportTier(width: number): CocoaViewportTier {
  if (width < COCOA_BREAKPOINTS.phone) return "phone";
  if (width < COCOA_BREAKPOINTS.tablet) return "tablet";
  if (width < COCOA_BREAKPOINTS.desktop) return "laptop";
  return "desktop";
}

function readMediaQuery(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

/** Reactive `matchMedia` (false during SSR and in environments without it). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => readMediaQuery(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const list = window.matchMedia(query);
    const handler = () => setMatches(list.matches);
    handler();
    list.addEventListener?.("change", handler);
    return () => list.removeEventListener?.("change", handler);
  }, [query]);
  return matches;
}

/** True below `breakpoint` px (default: the phone breakpoint, 600). */
export function useIsNarrow(breakpoint: number = COCOA_BREAKPOINTS.phone): boolean {
  return useMediaQuery(`(max-width: ${breakpoint - 1}px)`);
}

/** Current viewport tier, reactive to resizes. */
export function useViewportTier(): CocoaViewportTier {
  const phone = useIsNarrow(COCOA_BREAKPOINTS.phone);
  const tablet = useIsNarrow(COCOA_BREAKPOINTS.tablet);
  const laptop = useIsNarrow(COCOA_BREAKPOINTS.desktop);
  if (phone) return "phone";
  if (tablet) return "tablet";
  if (laptop) return "laptop";
  return "desktop";
}

/**
 * Content-box width of an element, measured with ResizeObserver; `null` until
 * the first measurement (callers fall back to their desktop layout).
 */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = entry.contentRect.width;
      setWidth((prev) => (prev !== null && Math.abs(prev - next) < 0.5 ? prev : next));
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
