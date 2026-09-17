// Helpers for screens hosted inside a NavItemTabs container (Tanda 5 · L1c;
// the loader / prop bridge of L1c was retired in Cocoa 22 · ola 11).
//
// ONE convention for a hosted screen: it reads `useTabHost()` (TabHost.tsx)
// and, when the host is not null, drops its own eyebrow and H1 — the
// container already painted category and item label — keeping subtitle,
// inner views and the actions row. `CocoaPage` does it by itself and paints
// `HostedHead` (components/cocoa/HostedHead.tsx) when hosted. Nothing is
// passed down by the container: the host context is the source of truth, and
// every loader hands its screen over as it is (`{ default: m.Screen }`) or
// injects the URL param of a detail sub-URL. This module keeps:
//   - `treeHeaderFor(screenKey, fallback)`: eyebrow and title of a screen key
//     as the menu paints them, so a standalone header never drifts from its
//     menu entry;
//   - `useRouteParam(pattern, name)`: `:codigo` / `:id` of detail sub-URLs,
//     reactive to popstate, tab changes and shell navigations (usePathname);
//   - `shellNavigate(screen)`: untyped `hotelos-nav` for screens that take
//     `onNavigate?: (screen: string) => void`.

import { useMemo } from "react";
import { HOTELOS_NAV_EVENT } from "../../lib/navigate";
import { findByScreen, matchPath } from "../../navigation/nav-tree";
import { usePathname } from "./usePathname";

// ----------------------------------------------------------------- tree labels

export type TreeHeader = { eyebrow: string; title: string };

/**
 * Eyebrow (category label) and title (item or tab label) of a screen key as
 * the menu paints them, so a standalone screen's CocoaPageHeader never drifts
 * from its menu entry («Energía y agua» in the menu, «Consumo energético» in
 * the page). Falls back to the given labels for keys outside the tree.
 */
export function treeHeaderFor(screenKey: string, fallback: TreeHeader): TreeHeader {
  const match = findByScreen(screenKey);
  if (!match) return fallback;
  if (match.kind === "item") return { eyebrow: match.category.label, title: match.item.label };
  if (match.kind === "tab") return { eyebrow: `${match.category.label} · ${match.item.label}`, title: match.tab.label };
  return fallback;
}

// ----------------------------------------------------------------- navigation helpers

/** Untyped shell navigation for screens that take `onNavigate?: (screen: string) => void` (mirrors App.tsx's wired wrappers). */
export function shellNavigate(screen: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(HOTELOS_NAV_EVENT, { detail: screen }));
}

/** Value of `:name` in `pattern` for the current URL (null when the URL does not match). */
export function useRouteParam(pattern: string, name: string): string | null {
  const pathname = usePathname();
  return useMemo(() => matchPath(pattern, pathname)?.[name] ?? null, [pattern, pathname, name]);
}
