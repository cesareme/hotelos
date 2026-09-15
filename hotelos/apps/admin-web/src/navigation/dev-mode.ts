// Dev mode of the shell (Tanda 5 · L1c). ONE reactive source for the
// «Desarrollo» group (Sidebar), ⌘K, the /desarrollo/* guard of App.tsx and
// the dev-only links of the containers:
//
//   - `?dev=1` on any URL turns the mode on for the TAB (sessionStorage), so
//     it survives the navigations by key that drop the query and a reload;
//     `?dev=0` turns it off; closing the tab ends it;
//   - `localStorage["anfitorio.dev"] = "1"` keeps it on across tabs/sessions;
//   - readers subscribe with `useDevMode()` (DEV_MODE_CHANGED_EVENT, popstate,
//     storage) instead of capturing the value once at mount.
//
// The pure decisions stay in nav-tree.ts (`isDevModeEnabled`, `devQueryFrom`)
// and `devModeTransition` below; App.tsx calls `syncDevModeFromLocation` when
// it resolves the location.

import { useCallback, useSyncExternalStore } from "react";
import { DEV_MODE_QUERY_PARAM, DEV_MODE_STORAGE_KEY, isDevModeEnabled } from "./nav-tree";

/** Tab-scoped flag written from `?dev=1` (sessionStorage). */
export const DEV_MODE_SESSION_KEY = "anfitorio.dev.session";
/** Fired on `window` when the dev mode of the tab changes. */
export const DEV_MODE_CHANGED_EVENT = "hotelos-dev-mode-changed";

export type DevModeTransition = "enter" | "leave" | "keep";

/** What the `dev` query asks: `1` enters, `0` leaves, anything else keeps the current state. */
export function devModeTransition(search: string | null | undefined): DevModeTransition {
  const raw = search ?? "";
  const value = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw).get(DEV_MODE_QUERY_PARAM);
  if (value === "1") return "enter";
  if (value === "0") return "leave";
  return "keep";
}

/** Pure: the storage value the guard must see (permanent flag first, then the tab flag). */
export function devModeStorageValue(localValue: string | null, sessionValue: string | null): string | null {
  return localValue === "1" ? localValue : sessionValue;
}

function readLocal(): string | null {
  try {
    return window.localStorage.getItem(DEV_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readSession(): string | null {
  try {
    return window.sessionStorage.getItem(DEV_MODE_SESSION_KEY);
  } catch {
    return null;
  }
}

/** Storage value for `isDevModeEnabled` / `isDevRouteAllowed` in this tab. */
export function readDevModeStorage(): string | null {
  if (typeof window === "undefined") return null;
  return devModeStorageValue(readLocal(), readSession());
}

/** Dev mode of the tab right now: `?dev=1` in the URL, the tab flag or the permanent flag. */
export function isDevModeActive(): boolean {
  if (typeof window === "undefined") return false;
  return isDevModeEnabled({ search: window.location.search, storageValue: readDevModeStorage() });
}

/**
 * Applies `?dev=1` / `?dev=0` of a location to the tab flag and notifies the
 * readers when the mode changed. Returns whether it changed.
 */
export function syncDevModeFromLocation(search: string = typeof window === "undefined" ? "" : window.location.search): boolean {
  if (typeof window === "undefined") return false;
  const before = isDevModeActive();
  const transition = devModeTransition(search);
  try {
    if (transition === "enter") window.sessionStorage.setItem(DEV_MODE_SESSION_KEY, "1");
    else if (transition === "leave") window.sessionStorage.removeItem(DEV_MODE_SESSION_KEY);
  } catch {
    /* storage unavailable: the query itself still counts through isDevModeEnabled */
  }
  const after = isDevModeActive();
  if (before !== after) window.dispatchEvent(new CustomEvent(DEV_MODE_CHANGED_EVENT));
  return before !== after;
}

function subscribe(notify: () => void): () => void {
  window.addEventListener(DEV_MODE_CHANGED_EVENT, notify);
  window.addEventListener("popstate", notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(DEV_MODE_CHANGED_EVENT, notify);
    window.removeEventListener("popstate", notify);
    window.removeEventListener("storage", notify);
  };
}

function serverSnapshot(): boolean {
  return false;
}

/** Reactive dev mode of the tab (never captured once at mount). */
export function useDevMode(): boolean {
  const getSnapshot = useCallback(() => isDevModeActive(), []);
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
