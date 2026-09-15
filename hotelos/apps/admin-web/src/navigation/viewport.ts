// Viewport hooks of the shell (Tanda 5 · L1c): one `matchMedia` subscription
// shared by the Sidebar (mobile landing tab, §3), the session landing and the
// layout chrome (compact toolbar + navigation drawer under
// COMPACT_BREAKPOINT_PX, the same width at which CocoaSplitView drops its
// sidebar column).

import { useCallback, useSyncExternalStore } from "react";
import { MOBILE_BREAKPOINT_PX } from "./role-tokens";

/** Below this width the shell paints the compact toolbar and the navigation drawer (CocoaSplitView: `innerWidth < 900`). */
export const COMPACT_BREAKPOINT_PX = 900;

function serverSnapshot(): boolean {
  return false;
}

/** True while the media query matches; false without `matchMedia` (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query]
  );
  const getSnapshot = useCallback(
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    [query]
  );
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

/** True under MOBILE_BREAKPOINT_PX (pisos/mantenimiento land on their mobile tab, §3). */
export function useIsMobileViewport(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
}

/** True under COMPACT_BREAKPOINT_PX: the layout swaps the split view sidebar for a drawer and the toolbar for its compact form. */
export function useIsCompactViewport(): boolean {
  return useMediaQuery(`(max-width: ${COMPACT_BREAKPOINT_PX - 1}px)`);
}
