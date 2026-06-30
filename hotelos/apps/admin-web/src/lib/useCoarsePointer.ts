import { useEffect, useState } from "react";

/**
 * True when the primary input is a coarse pointer (finger), i.e. a phone or
 * tablet. Components use this to grow controls to a ≥44px tap target on touch
 * (Apple HIG / WCAG 2.5.8) while keeping the dense desktop sizing for a mouse.
 *
 * SSR-safe and reactive to device changes (e.g. iPad with/without trackpad).
 */
export function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const get = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;

  const [coarse, setCoarse] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mql = window.matchMedia(query);
    const handler = () => setCoarse(mql.matches);
    handler();
    mql.addEventListener?.("change", handler);
    return () => mql.removeEventListener?.("change", handler);
  }, []);

  return coarse;
}

/** Minimum comfortable tap target on touch devices (CSS px). */
export const TAP_TARGET_PX = 44;
