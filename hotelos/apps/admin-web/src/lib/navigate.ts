// Typed navigation helper for the global `hotelos-nav` channel (NAV-02b).
//
// App.tsx owns the SCREEN_COMPONENTS registry and listens for a `hotelos-nav`
// CustomEvent whose detail is "<ScreenKey>" or "<ScreenKey>#<hash>". Screens
// historically declared their own untyped `navigateTo(screen: string)` helper,
// which let dead keys ship silently (the event is dropped with a DEV-only
// console.warn). This module is the shared, typed entry point: `screen` must be
// a real SCREEN_COMPONENTS key, so a stale key fails `pnpm typecheck` instead
// of producing a button that does nothing.
//
// `ScreenKey` comes from App.tsx through `import type` only. Type imports are
// erased at build time, so there is no value-level cycle for Vite even though
// App.tsx (lazily) imports the screens that import this module.

import type { ScreenKey as AppScreenKey } from "../App";

export type ScreenKey = AppScreenKey;

export const HOTELOS_NAV_EVENT = "hotelos-nav";

/**
 * Build the string detail App.tsx expects: the bare screen key, or
 * `key#hash` for deep-links (a leading `#` in `hash` is tolerated).
 */
export function navTarget(screen: ScreenKey, hash?: string): string {
  if (!hash) return screen;
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  return fragment ? `${screen}#${fragment}` : screen;
}

/** Switch the shell to `screen` (optionally with a `#hash` deep-link). */
export function navigateTo(screen: ScreenKey, hash?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(HOTELOS_NAV_EVENT, { detail: navTarget(screen, hash) }));
}
