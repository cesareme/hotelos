// Helpers for screens hosted inside a NavItemTabs container (Tanda 5 · L1c).
//
// ONE convention for a hosted screen: it reads `useTabHost()` (TabHost.tsx)
// and, when the host is not null, drops its own eyebrow and H1 — the
// container already painted category and item label — keeping subtitle,
// inner views and the actions row. Nothing is passed down by the container:
// the host context is the source of truth. This module adds:
//   - `HostedHead`: the head a hosted screen paints (subtitle, optional
//     segmented inner views, actions row; never an H1; its `eyebrow` is
//     registered with the container, which paints «Finanzas · <sociedad>»);
//   - `pageHead(embedded?)`: header component of a screen that takes the same
//     props standalone and hosted — HostedHead inside a container (context) or
//     when `embedded` is explicitly true, CocoaPageHeader otherwise; so a
//     screen written as `const Head = pageHead(embedded)` is already on the
//     context convention and its `embedded` prop can go;
//   - `embed(Screen, props)`: loader adapter that still passes
//     `embedded: true` to the screens that branch on that prop by hand
//     (`{embedded ? null : <h1>…}`) instead of reading the context. Bridge
//     only: once such a screen switches to `useTabHost()`, its loader goes
//     back to `{ default: m.Screen }` (the pending screens are listed in
//     TabHost.tsx);
//   - `useRouteParam(pattern, name)`: `:codigo` / `:id` of detail sub-URLs,
//     reactive to popstate, tab changes and shell navigations (usePathname);
//   - `shellNavigate(screen)`: untyped `hotelos-nav` for screens that take
//     `onNavigate?: (screen: string) => void`.

import { createElement, useMemo, type ComponentType } from "react";
import { CocoaPageHeader, type CocoaPageHeaderProps } from "../../components/cocoa/CocoaPageHeader";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { HOTELOS_NAV_EVENT } from "../../lib/navigate";
import { findByScreen, matchPath } from "../../navigation/nav-tree";
import { HOSTED_TOOLBAR, useHostedEyebrow, useTabHost } from "./TabHost";
import { usePathname } from "./usePathname";

// ----------------------------------------------------------------- hosted head

export type HostedHeadProps = Pick<CocoaPageHeaderProps, "title" | "subtitle" | "actions" | "tabs" | "activeTab" | "onTabChange"> & {
  /**
   * Not painted here (the container owns the eyebrow): registered with it through
   * `useHostedEyebrow` so «Finanzas · <sociedad>» qualifies the container's category
   * (design §5.3; fix:L7 qa#12). The title is never painted either (the container's H1).
   */
  eyebrow?: string;
};

// The subtitle sits in a COLUMN flex (leadStyle): a flex-basis here would become its height.
// `width: 0` + `minWidth: 100%`: the paragraph fills the column but adds nothing to its intrinsic
// width, so a long sentence never decides whether the actions wrap — only the segmented views do.
const subtitleStyle = { color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-body)", margin: 0, flex: "0 0 auto", width: 0, minWidth: "100%" } as const;
// Lead column: its flex basis is the width of its segmented views (fix:L7 qa#1: with a fixed 320 px
// basis the four USALI views were squeezed to 452 px beside a 688 px actions row at 1440 and the strip
// scrolled), at least 320 px — or the whole row on a phone — for a subtitle alone; items align to the
// start so the strip keeps its own width instead of stretching to the column.
const leadStyle = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--cocoa-space-3)", flex: "1 1 auto", minWidth: "min(320px, 100%)" } as const;
// Actions keep the right edge whichever line they land on (`marginLeft: auto` also on a wrapped line).
const actionsStyle = { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: "var(--cocoa-space-2)", marginLeft: "auto", minWidth: 0, maxWidth: "100%" } as const;

/** Hook carrier of HostedHead: keeps HostedHead a plain function (the tests call it directly) while its eyebrow reaches the container. */
function HostedEyebrow({ eyebrow }: { eyebrow: string }) {
  useHostedEyebrow(eyebrow);
  return null;
}
HostedEyebrow.displayName = "HostedEyebrow";

/**
 * Head of a hosted screen: subtitle (left), optional segmented inner views and
 * the actions row (right). No eyebrow, no title: the container already
 * painted them — the `eyebrow` prop is only registered with it (useHostedEyebrow)
 * so «Finanzas · <sociedad>» reaches the container's header. Paints nothing
 * when it has nothing to say. Layout: the lead column is as wide as its
 * segmented views and the actions wrap under them when both do not fit.
 */
export function HostedHead({ title, subtitle, actions, tabs, activeTab, onTabChange, eyebrow }: HostedHeadProps) {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  const register = eyebrow ? <HostedEyebrow eyebrow={eyebrow} /> : null;
  if (!subtitle && !hasTabs && !actions) return register;
  return (
    <div style={HOSTED_TOOLBAR} data-hosted-head={title}>
      {register}
      <div style={leadStyle}>
        {subtitle ? <p style={subtitleStyle}>{subtitle}</p> : null}
        {hasTabs ? (
          <CocoaSegmentedControl
            value={activeTab ?? tabs![0].value}
            onChange={(value) => onTabChange?.(value)}
            options={tabs!}
            size="small"
            aria-label={`${title}: vistas`}
          />
        ) : null}
      </div>
      {actions ? <div style={actionsStyle}>{actions}</div> : null}
    </div>
  );
}

/** Same props standalone and hosted: `HostedHead` inside a container, `CocoaPageHeader` elsewhere. */
function PageHead(props: HostedHeadProps) {
  const hosted = useTabHost() !== null;
  return hosted ? createElement(HostedHead, props) : createElement(CocoaPageHeader, props);
}
PageHead.displayName = "PageHead";

/**
 * Header component of a screen merged into a container. The host context
 * decides (`useTabHost()`); `embedded: true` forces the hosted head for a
 * screen rendered inside a container without the context (legacy prop).
 */
export function pageHead(embedded?: boolean): ComponentType<HostedHeadProps> {
  return embedded ? HostedHead : PageHead;
}

// ----------------------------------------------------------------- embedded prop (bridge)

/** Screens that still branch on this prop by hand accept it; new screens read `useTabHost()` instead. */
export type EmbeddedProps = { embedded?: boolean };

/**
 * Loader adapter for a screen that still reads `embedded` by hand:
 * `lazy: () => import("…").then((m) => embed(m.Screen))`. The wrapper is
 * created once per lazy instance (CocoaRouteTabs keeps one `React.lazy` per
 * tab key), so the screen keeps its state across renders.
 */
export function embed<P extends EmbeddedProps>(
  Screen: ComponentType<P>,
  props?: Omit<P, "embedded">
): { default: ComponentType<Record<string, never>> } {
  const Tab = () => createElement(Screen, { ...(props ?? {}), embedded: true } as unknown as P);
  Tab.displayName = `Embedded(${Screen.displayName ?? Screen.name ?? "Screen"})`;
  return { default: Tab };
}

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
