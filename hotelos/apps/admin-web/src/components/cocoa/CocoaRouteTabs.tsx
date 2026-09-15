// CocoaRouteTabs — routed tab container (Tanda 5 · L1a).
//
// The tree merges 80 screens into tabs of 43 items (`/x/y/:tab`). A tab
// container with local state would bring back the bug of the 34 screens
// without URL (F5 loses the view), so here the ACTIVE TAB IS THE URL:
//
//   - the tab strip reads `window.location.pathname` and paints the tab whose
//     path matches (static paths win over `:param` ones);
//   - clicking a tab dispatches a cancelable `hotelos-tab-nav` event (same
//     veto contract as App.tsx's `hotelos-nav`: a screen guard calls
//     preventDefault / stopImmediatePropagation in a capture listener and
//     re-dispatches with `commitTabNavigation(detail)` once the user confirms),
//     then pushState(href) — the query string is preserved so filters survive
//     the switch — and a `hotelos-tab-changed` event re-syncs every strip;
//   - Back/Forward (`popstate`) and shell navigations (`hotelos-nav`, decided by
//     App.tsx in a microtask queued before ours) re-resolve the tab from the URL;
//   - landing on the bare item URL writes the default tab with replaceState
//     (no extra history entry); below MOBILE_BREAKPOINT_PX a different default
//     can be given (housekeeping lands on «Mi turno»);
//   - each tab loads lazily (React.lazy + Suspense with a Cocoa skeleton);
//   - tabs the caller's `isVisible` rejects (role/module) are never painted;
//   - WAI-ARIA tabs pattern with manual activation: roving tabindex, arrows /
//     Home / End move focus, Enter or Space activate (panels are routes, so
//     arrowing through them must not load every chunk).
//
// App.tsx is NOT modified: `pathForScreen` keeps resolving a container screen
// to its first registered (base) path, and the container then lands the right
// tab. L1b registers `basePath` first and the tab paths right after it.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type LazyExoticComponent,
  type ReactNode
} from "react";
import { devQueryFrom, matchPath, normalizePathname } from "../../navigation/nav-tree";
import { MOBILE_BREAKPOINT_PX } from "../../navigation/role-tokens";
import { TAB_ITEM_RADIUS, tabSurfaceStyle } from "./CocoaSegmentedControl";
import { CocoaSkeleton } from "./CocoaState";

/** Cancelable event dispatched BEFORE a tab switch; guards veto with preventDefault. */
export const TAB_NAV_EVENT = "hotelos-tab-nav";
/** Informational event dispatched AFTER the URL changed; strips re-sync on it. */
export const TAB_CHANGED_EVENT = "hotelos-tab-changed";
/** Shell navigation event owned by App.tsx (listened to, never dispatched here). */
const SHELL_NAV_EVENT = "hotelos-nav";

export type TabNavDetail = {
  basePath: string;
  from: string | null;
  to: string;
  /** Path plus preserved query string. */
  href: string;
};

export type LazyTabLoader = () => Promise<{ default: ComponentType<Record<string, never>> }>;

export type CocoaRouteTab = {
  /** Last URL segment of the tab (`lista`, `cronograma`); kebab-case, unique in the container. */
  key: string;
  label: string;
  /** Absolute path override; defaults to `${basePath}/${key}`. Use `basePath` itself for the base tab. May carry `:param`s. */
  path?: string;
  /** Role tokens allowed (evaluated by the caller's `isVisible`, e.g. with `canSee`). */
  roles?: readonly string[];
  /** Module codes, any of which must be enabled (idem). */
  modulesAny?: readonly string[];
  /** Lazy screen: `() => import("../screens/x/Y")` (module scope, so the loader identity is stable). */
  lazy?: LazyTabLoader;
  /** Inline content when the tab is cheap (takes precedence over `lazy`). */
  element?: ReactNode;
  icon?: ReactNode;
  /** Reachable by URL but not painted unless active (detail sub-URLs like `:id`). */
  hidden?: boolean;
};

export type CocoaRouteTabsProps = {
  /** Item URL of the tree (`/recepcion/reservas`). */
  basePath: string;
  tabs: readonly CocoaRouteTab[];
  /** Tab to land on when the URL is the bare `basePath`. */
  defaultTab: string;
  /** Landing tab below `mobileBreakpoint` (e.g. `mi-turno` for housekeeping). */
  mobileDefaultTab?: string;
  /** Default MOBILE_BREAKPOINT_PX (700). */
  mobileBreakpoint?: number;
  /** Keep `?filters` when switching tabs. Default true. */
  preserveQuery?: boolean;
  /** Role/module gate injected by the caller: `(tab) => canSee(tab, tokens, modules)`. */
  isVisible?: (tab: CocoaRouteTab) => boolean;
  onTabChange?: (key: string) => void;
  /** Accessible name of the tab list. Default «Secciones». */
  ariaLabel?: string;
  size?: "small" | "regular";
  /** Suspense fallback; default CocoaTabSkeleton. */
  fallback?: ReactNode;
  /** Shown when no tab is visible for the user. */
  emptyMessage?: string;
  className?: string;
  style?: CSSProperties;
  panelStyle?: CSSProperties;
};

// ----------------------------------------------------------------- pure logic (unit-tested)

/** Absolute path of a tab: explicit `path`, or `${basePath}/${key}` (`key === ""` → basePath). */
export function tabPath(basePath: string, tab: Pick<CocoaRouteTab, "key" | "path">): string {
  if (tab.path) return normalizePathname(tab.path);
  const base = normalizePathname(basePath);
  if (tab.key === "") return base;
  return base === "/" ? `/${tab.key}` : `${base}/${tab.key}`;
}

export function isBaseTab(basePath: string, tab: Pick<CocoaRouteTab, "key" | "path">): boolean {
  return tabPath(basePath, tab) === normalizePathname(basePath);
}

/** Key of the tab whose path matches the pathname; static paths win over `:param` ones; null when none. */
export function resolveTabKey(pathname: string, basePath: string, tabs: readonly Pick<CocoaRouteTab, "key" | "path">[]): string | null {
  const normalized = normalizePathname(pathname);
  let best: { key: string; params: number } | null = null;
  for (const tab of tabs) {
    const pattern = tabPath(basePath, tab);
    if (!matchPath(pattern, normalized)) continue;
    const params = (pattern.match(/:[A-Za-z0-9_]+/g) ?? []).length;
    if (!best || params < best.params) best = { key: tab.key, params };
  }
  return best?.key ?? null;
}

export type LandingInput = {
  resolvedKey: string | null;
  visibleKeys: readonly string[];
  defaultTab: string;
  mobileDefaultTab?: string;
  isMobile: boolean;
};

/**
 * Which tab to show: the one in the URL when visible; else the mobile default
 * (only below the breakpoint); else the default; else the first visible; null
 * when nothing is visible for the user.
 */
export function pickLandingTab(input: LandingInput): string | null {
  const { resolvedKey, visibleKeys, defaultTab, mobileDefaultTab, isMobile } = input;
  if (resolvedKey && visibleKeys.includes(resolvedKey)) return resolvedKey;
  if (isMobile && mobileDefaultTab && visibleKeys.includes(mobileDefaultTab)) return mobileDefaultTab;
  if (visibleKeys.includes(defaultTab)) return defaultTab;
  return visibleKeys[0] ?? null;
}

/** Path plus the current query string when `preserveQuery` (hash is always dropped). */
export function hrefForTab(path: string, search: string, preserveQuery: boolean): string {
  if (!preserveQuery || !search || search === "?") return path;
  return `${path}${search.startsWith("?") ? search : `?${search}`}`;
}

/** Roving focus target for a keyboard key; null for keys the strip ignores. */
export function nextTabKey(currentKey: string | null, keys: readonly string[], key: string): string | null {
  if (keys.length === 0) return null;
  const index = Math.max(0, currentKey === null ? 0 : keys.indexOf(currentKey));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return keys[(index + 1) % keys.length];
    case "ArrowLeft":
    case "ArrowUp":
      return keys[(index - 1 + keys.length) % keys.length];
    case "Home":
      return keys[0];
    case "End":
      return keys[keys.length - 1];
    default:
      return null;
  }
}

// ----------------------------------------------------------------- navigation helpers

/** Writes the URL (push, or replace for landings) and tells every strip to re-sync. */
export function commitTabNavigation(detail: TabNavDetail, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== detail.href) {
    if (options.replace) window.history.replaceState(null, "", detail.href);
    else window.history.pushState(null, "", detail.href);
  }
  window.dispatchEvent(new CustomEvent<TabNavDetail>(TAB_CHANGED_EVENT, { detail }));
}

/**
 * Asks to switch tab: cancelable `hotelos-tab-nav`, decided once every listener
 * ran (microtask, like App.tsx). A vetoing guard keeps `detail` and calls
 * `commitTabNavigation(detail)` after the user confirms.
 */
export function requestTabNavigation(detail: TabNavDetail): void {
  if (typeof window === "undefined") return;
  const event = new CustomEvent<TabNavDetail>(TAB_NAV_EVENT, { detail, cancelable: true });
  window.dispatchEvent(event);
  queueMicrotask(() => {
    if (event.defaultPrevented || event.cancelBubble) return;
    commitTabNavigation(detail);
  });
}

/**
 * Deep link to a tab URL from outside its container (⌘K, first-use chips,
 * cross-screen links): writes the URL and fires `popstate` so App.tsx
 * re-resolves the screen from the path. Requires the URL to be registered in
 * the routes table (L1b); inside a container prefer `useRouteTabs().select`.
 * A bare path keeps `?dev=1` of the current URL (navigation/dev-mode.ts).
 */
export function openTabPath(path: string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const href = path.includes("?") ? path : `${path}${devQueryFrom(window.location.search)}`;
  if (options.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ----------------------------------------------------------------- hooks

/** True below `breakpoint` px (default 700); reactive to resizes. */
export function useIsMobileViewport(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const read = useCallback(
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    [query]
  );
  const [mobile, setMobile] = useState<boolean>(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const list = window.matchMedia(query);
    const handler = () => setMobile(list.matches);
    handler();
    list.addEventListener?.("change", handler);
    return () => list.removeEventListener?.("change", handler);
  }, [query]);
  return mobile;
}

function usePathname(): string {
  const [pathname, setPathname] = useState<string>(() => (typeof window === "undefined" ? "/" : window.location.pathname));
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => setPathname(window.location.pathname);
    // App.tsx commits a shell navigation in a microtask queued by its own
    // listener, registered before this one: a microtask queued here runs after
    // that commit and sees the final URL (or the unchanged one when vetoed).
    const afterShellNav = () => queueMicrotask(sync);
    window.addEventListener("popstate", sync);
    window.addEventListener(TAB_CHANGED_EVENT, sync);
    window.addEventListener(SHELL_NAV_EVENT, afterShellNav);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(TAB_CHANGED_EVENT, sync);
      window.removeEventListener(SHELL_NAV_EVENT, afterShellNav);
    };
  }, []);
  return pathname;
}

export type UseRouteTabsInput = Pick<
  CocoaRouteTabsProps,
  "basePath" | "tabs" | "defaultTab" | "mobileDefaultTab" | "mobileBreakpoint" | "preserveQuery" | "isVisible" | "onTabChange"
>;

export type UseRouteTabsResult = {
  activeKey: string | null;
  activeTab: CocoaRouteTab | null;
  /** Tabs allowed for the user (hidden detail tabs included). */
  visibleTabs: CocoaRouteTab[];
  /** Tabs to paint: visible and not hidden, plus the active one. */
  paintedTabs: CocoaRouteTab[];
  isMobile: boolean;
  select: (key: string) => void;
  hrefFor: (key: string) => string | null;
};

/**
 * Headless version for screens that render their own strip (e.g. inside
 * CocoaPageHeader's `tabs`): same URL sync, guards, landing and lazy rules.
 */
export function useRouteTabs(input: UseRouteTabsInput): UseRouteTabsResult {
  const { basePath, tabs, defaultTab, mobileDefaultTab, mobileBreakpoint = MOBILE_BREAKPOINT_PX, preserveQuery = true, isVisible, onTabChange } = input;
  const pathname = usePathname();
  const isMobile = useIsMobileViewport(mobileBreakpoint);

  const visibleTabs = useMemo(() => tabs.filter((tab) => (isVisible ? isVisible(tab) : true)), [tabs, isVisible]);
  const visibleKeys = useMemo(() => visibleTabs.map((tab) => tab.key), [visibleTabs]);
  const resolvedKey = useMemo(() => resolveTabKey(pathname, basePath, tabs), [pathname, basePath, tabs]);
  const activeKey = useMemo(
    () => pickLandingTab({ resolvedKey, visibleKeys, defaultTab, mobileDefaultTab, isMobile }),
    [resolvedKey, visibleKeys, defaultTab, mobileDefaultTab, isMobile]
  );
  const activeTab = useMemo(() => visibleTabs.find((tab) => tab.key === activeKey) ?? null, [visibleTabs, activeKey]);
  const paintedTabs = useMemo(() => visibleTabs.filter((tab) => !tab.hidden || tab.key === activeKey), [visibleTabs, activeKey]);

  // Landing: the URL does not name the tab we show (bare basePath, hidden or
  // unknown tab) → write it with replaceState so F5 and shared links keep it.
  useEffect(() => {
    if (!activeTab || typeof window === "undefined") return;
    if (resolvedKey === activeKey) return;
    const path = tabPath(basePath, activeTab);
    if (normalizePathname(window.location.pathname) === path) return;
    const href = hrefForTab(path, window.location.search, preserveQuery);
    commitTabNavigation({ basePath, from: null, to: activeTab.key, href }, { replace: true });
  }, [activeKey, activeTab, basePath, preserveQuery, resolvedKey]);

  const previousKey = useRef<string | null>(null);
  useEffect(() => {
    if (previousKey.current !== null && activeKey && activeKey !== previousKey.current) onTabChange?.(activeKey);
    previousKey.current = activeKey;
  }, [activeKey, onTabChange]);

  const hrefFor = useCallback(
    (key: string) => {
      const tab = visibleTabs.find((candidate) => candidate.key === key);
      if (!tab) return null;
      const search = typeof window === "undefined" ? "" : window.location.search;
      return hrefForTab(tabPath(basePath, tab), search, preserveQuery);
    },
    [visibleTabs, basePath, preserveQuery]
  );

  const select = useCallback(
    (key: string) => {
      if (key === activeKey) return;
      const href = hrefFor(key);
      if (!href) return;
      requestTabNavigation({ basePath, from: activeKey, to: key, href });
    },
    [activeKey, basePath, hrefFor]
  );

  return { activeKey, activeTab, visibleTabs, paintedTabs, isMobile, select, hrefFor };
}

// ----------------------------------------------------------------- lazy components

type LazyScreen = LazyExoticComponent<ComponentType<Record<string, never>>>;

/**
 * One React.lazy per tab KEY for the life of the container: a loader written
 * inline (`() => import(...)`) changes identity every render and a fresh
 * `lazy()` would remount the tab (and lose its state) on each render.
 */
function useLazyScreens(tabs: readonly CocoaRouteTab[]): Map<string, LazyScreen> {
  const cache = useRef(new Map<string, LazyScreen>());
  return useMemo(() => {
    const map = cache.current;
    for (const tab of tabs) {
      if (tab.lazy && !map.has(tab.key)) map.set(tab.key, lazy(tab.lazy));
    }
    return map;
  }, [tabs]);
}

// ----------------------------------------------------------------- skeleton

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0
};

/** Cocoa-spaced shimmer lines announced as «Cargando sección…»; the default Suspense fallback (CocoaSkeleton, no `.bo-*`). */
export function CocoaTabSkeleton(props: { lines?: number; label?: string }) {
  const lines = props.lines ?? 4;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-3)", padding: "var(--cocoa-space-4) 0" }}
    >
      <CocoaSkeleton variant="title" />
      <CocoaSkeleton variant="text" lines={lines} />
      <span style={visuallyHidden}>{props.label ?? "Cargando sección…"}</span>
    </div>
  );
}

// ----------------------------------------------------------------- component

const ITEM_PADDING: Record<"small" | "regular", string> = { small: "4px 12px", regular: "6px 16px" };
const FONT_SIZE: Record<"small" | "regular", string> = { small: "var(--cocoa-fs-subheadline)", regular: "var(--cocoa-fs-body)" };
const ICON_SIZE: Record<"small" | "regular", number> = { small: 12, regular: 14 };

/**
 * Strip geometry (COCOA-22.md §3.3). On phones the strip scrolls; the lateral
 * fade, the scroll-snap and the hidden scrollbar are owned by the css lot
 * (`.c22-tablist`, styles/cocoa-22-layout.css), which also pads the end of
 * the strip so the last tab clears the fade — hence no inline
 * `padding-inline-end` below 900 px.
 */
export function tablistStyle(isMobile: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "stretch",
    alignSelf: isMobile ? "stretch" : "flex-start",
    maxWidth: "100%",
    overflowX: isMobile ? "auto" : "visible",
    paddingBlock: 2,
    paddingInlineStart: 2,
    paddingInlineEnd: isMobile ? undefined : 2,
    background: "var(--cocoa-background-control)",
    borderRadius: "var(--cocoa-radius-md)",
    fontFamily: "var(--cocoa-font)",
    WebkitOverflowScrolling: "touch"
  };
}

/**
 * Tab button style (pure). NO `boxShadow` inline: the active surface (content
 * bg + inset control shadow) is the decorative `tabSurfaceStyle` child, so the
 * stylesheet's `.cocoa-focus-ring:focus-visible` ring can paint on the active
 * tab — the only tab stop of the strip under roving tabindex.
 */
export function routeTabStyle(isActive: boolean, size: "small" | "regular"): CSSProperties {
  return {
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: size === "small" ? 4 : 6,
    padding: ITEM_PADDING[size],
    borderRadius: TAB_ITEM_RADIUS,
    border: "1px solid transparent",
    background: "transparent",
    color: isActive ? "var(--cocoa-label)" : "var(--cocoa-label-secondary)",
    fontFamily: "inherit",
    fontSize: FONT_SIZE[size],
    fontWeight: (isActive ? "var(--cocoa-fw-semibold)" : "var(--cocoa-fw-medium)") as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    cursor: isActive ? "default" : "pointer",
    userSelect: "none",
    flexShrink: 0,
    WebkitAppearance: "none",
    appearance: "none",
    transition: "color var(--cocoa-duration-base) var(--cocoa-ease-out)"
  };
}

/** Tab panel: reachable by Tab (APG), with the single Esmeralda ring instead of the browser/Aurora outline. */
const panelBaseStyle: CSSProperties = { minWidth: 0, borderRadius: "var(--cocoa-radius-md)" };

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: "var(--cocoa-space-4) 0",
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-body)"
};

export function CocoaRouteTabs(props: CocoaRouteTabsProps) {
  const { basePath, tabs, size = "regular", ariaLabel, fallback, emptyMessage, className, style, panelStyle } = props;
  const { activeKey, activeTab, paintedTabs, isMobile, select } = useRouteTabs(props);
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const tabId = (key: string) => `${idBase}-tab-${key}`;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const lazyScreens = useLazyScreens(tabs);
  const paintedKeys = paintedTabs.map((tab) => tab.key);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const focused = (event.target as HTMLElement | null)?.dataset?.tabKey ?? activeKey;
    const target = nextTabKey(focused ?? null, paintedKeys, event.key);
    if (!target) return;
    event.preventDefault();
    tabRefs.current.get(target)?.focus();
  };

  let content: ReactNode = null;
  if (activeTab) {
    if (activeTab.element !== undefined) content = activeTab.element;
    else {
      const LazyScreen = lazyScreens.get(activeTab.key);
      content = LazyScreen ? <LazyScreen /> : null;
    }
  }

  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)", minWidth: 0, ...style }}
      data-cocoa-route-tabs={basePath}
    >
      {paintedTabs.length > 0 ? (
        <div role="tablist" aria-label={ariaLabel ?? "Secciones"} aria-orientation="horizontal" className="c22-tablist" style={tablistStyle(isMobile)} onKeyDown={onKeyDown} data-cocoa="tablist">
          {paintedTabs.map((tab) => {
            const isActive = tab.key === activeKey;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={tabId(tab.key)}
                aria-selected={isActive}
                aria-controls={isActive ? panelId : undefined}
                tabIndex={isActive ? 0 : -1}
                data-tab-key={tab.key}
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.key, element);
                  else tabRefs.current.delete(tab.key);
                }}
                className="cocoa-focus-ring"
                style={routeTabStyle(isActive, size)}
                onClick={() => select(tab.key)}
              >
                <span aria-hidden="true" className="c22-tab__surface" style={tabSurfaceStyle(isActive)} />
                {tab.icon ? (
                  <span
                    aria-hidden="true"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: ICON_SIZE[size], height: ICON_SIZE[size], flexShrink: 0 }}
                  >
                    {tab.icon}
                  </span>
                ) : null}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {activeTab ? (
        <div role="tabpanel" id={panelId} aria-labelledby={activeKey ? tabId(activeKey) : undefined} tabIndex={0} className="cocoa-focus-ring" style={{ ...panelBaseStyle, ...panelStyle }}>
          <Suspense fallback={fallback ?? <CocoaTabSkeleton />}>{content}</Suspense>
        </div>
      ) : (
        <p role="status" style={emptyStyle}>
          {emptyMessage ?? "No hay secciones disponibles para tu perfil."}
        </p>
      )}
    </div>
  );
}

export default CocoaRouteTabs;
