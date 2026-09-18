// Typed access to the Tanda 5 navigation tree (Tanda 5 · L1a).
//
// `nav-tree.generated.json` is produced by `node scripts/build-nav-tree.mjs`
// from the single source of truth pilots/tanda5-nav-tree.csv (git-ignored; the
// JSON is committed). Nine domain categories, 64 items, 80 tabs/sub-URLs, 20
// dev-only screens under /desarrollo/*, 72 retired screens, 24 key aliases and
// the 205 legacy /backoffice/* redirects. Nothing here touches `window`: every
// helper is pure so L1b (Sidebar/App/routes rewrite) and the tests share it.

import generated from "./nav-tree.generated.json";
import { accessDecision, devUnlocked, type AccessScope } from "./access-decision";
import {
  canSee,
  primaryRoleToken,
  roleHome,
  roleHomeForTokens,
  type NavGate,
  type RoleHomeOptions,
  type RoleToken
} from "./role-tokens";

export type NavTab = NavGate & {
  screenKey: string;
  label: string;
  url: string;
  roles: readonly string[];
  modulesAny: readonly string[];
  /** URL with a route parameter (`:id`, `:codigo`, `:propiedad`): reachable, never painted as a tab. */
  detail?: boolean;
};

export type NavItem = NavTab & {
  /** Label of the base screen when it is itself the first tab («Recepción» in Mi día); null when the base is the landing without a tab of its own. */
  baseTab: string | null;
  tabs: readonly NavTab[];
};

export type NavCategory = {
  key: string;
  label: string;
  items: readonly NavItem[];
};

export type NavLegacyRoute = { from: string; to: string };

export type NavDevOnlyScreen = NavGate & {
  screenKey: string;
  label: string;
  url: string;
  roles: readonly string[];
  modulesAny: readonly string[];
  /** Item (or dev-only screen) it hangs from. */
  parent: string;
};

export type NavRetiredScreen = { screenKey: string; coveredBy: string; url: string | null };
export type NavAlias = { screenKey: string; canonical: string; url: string | null };
export type NavPublicScreen = { screenKey: string; label: string; url: string };

export type NavTree = {
  meta: {
    source: string;
    generator: string;
    orderSource: string;
    legacyRoutesSource: string;
    counts: Record<string, number>;
  };
  categories: readonly NavCategory[];
  legacyRoutes: readonly NavLegacyRoute[];
  devOnly: readonly NavDevOnlyScreen[];
  retired: readonly NavRetiredScreen[];
  aliases: readonly NavAlias[];
  publicScreens: readonly NavPublicScreen[];
};

export const NAV_TREE: NavTree = generated;
export const NAV_CATEGORIES: readonly NavCategory[] = NAV_TREE.categories;

/** Every dev-only screen lives under this prefix; one router guard covers them all (§4.3). */
export const DEV_ONLY_PREFIX = "/desarrollo";
/** `?dev=1` or `localStorage["anfitorio.dev"] = "1"`, and platform admin, unlock /desarrollo/* (§4.3). */
export const DEV_MODE_QUERY_PARAM = "dev";
export const DEV_MODE_STORAGE_KEY = "anfitorio.dev";

// ----------------------------------------------------------------- paths

/** Drops query/hash and trailing slashes ("/hoy/" → "/hoy"; "/" stays). */
export function normalizePathname(pathname: string): string {
  const bare = pathname.replace(/[?#].*$/, "");
  const trimmed = bare.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Segment-exact match of a `:param` pattern. Returns the captured params
 * (decoded) or null. `/recepcion/reservas/:id` matches `/recepcion/reservas/abc`
 * but not `/recepcion/reservas` nor `/recepcion/reservas/abc/recorrido`.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = normalizePathname(pattern).split("/");
  const pathSegments = normalizePathname(pathname).split("/");
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = pathSegments[index];
    if (expected.startsWith(":")) {
      if (actual === "") return null;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        params[expected.slice(1)] = actual;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export function hasRouteParams(url: string): boolean {
  return /(^|\/):[A-Za-z0-9_]+/.test(url);
}

/** Replaces `:param` placeholders with the given values (encoded). Unknown params are left as they are. */
export function fillParams(pattern: string, params: Record<string, string | number | null | undefined>): string {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, (placeholder, name: string) => {
    const value = params[name];
    return value === null || value === undefined ? placeholder : encodeURIComponent(String(value));
  });
}

export function isDevOnlyPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === DEV_ONLY_PREFIX || normalized.startsWith(`${DEV_ONLY_PREFIX}/`);
}

/** Pure check for the dev-only guard: `?dev=1` in `search` or "1" in the storage value. */
export function isDevModeEnabled(input: { search?: string | null; storageValue?: string | null }): boolean {
  const search = input.search ?? "";
  const fromQuery = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(DEV_MODE_QUERY_PARAM) === "1";
  return fromQuery || input.storageValue === "1";
}

/**
 * `?dev=1` of the current search, ready to append to a path the shell writes
 * by key (`syncLocation`, ⌘K entity hits, `openTabPath`): the switch travels
 * with the URL so the «Desarrollo» group stays reachable and a copied link
 * keeps the mode. Empty when the search does not carry it.
 */
export function devQueryFrom(search: string | null | undefined): string {
  return isDevModeEnabled({ search }) ? `?${DEV_MODE_QUERY_PARAM}=1` : "";
}

// ----------------------------------------------------------------- lookups

export type NavMatch =
  | { kind: "item"; category: NavCategory; item: NavItem; tab: null; params: Record<string, string> }
  | { kind: "tab"; category: NavCategory; item: NavItem; tab: NavTab; params: Record<string, string> }
  | { kind: "dev-only"; screen: NavDevOnlyScreen; params: Record<string, string> }
  | { kind: "public"; screen: NavPublicScreen; params: Record<string, string> };

type Candidate = { match: NavMatch; params: number };

function candidate(match: NavMatch, url: string): Candidate {
  return { match, params: (url.match(/:[A-Za-z0-9_]+/g) ?? []).length };
}

/** Which tree entry serves a pathname; static URLs win over parametrised ones. */
export function findByUrl(pathname: string, tree: NavTree = NAV_TREE): NavMatch | null {
  const candidates: Candidate[] = [];
  for (const category of tree.categories) {
    for (const item of category.items) {
      const itemParams = matchPath(item.url, pathname);
      if (itemParams) candidates.push(candidate({ kind: "item", category, item, tab: null, params: itemParams }, item.url));
      for (const tab of item.tabs) {
        const tabParams = matchPath(tab.url, pathname);
        if (tabParams) candidates.push(candidate({ kind: "tab", category, item, tab, params: tabParams }, tab.url));
      }
    }
  }
  for (const screen of tree.devOnly) {
    const params = matchPath(screen.url, pathname);
    if (params) candidates.push(candidate({ kind: "dev-only", screen, params }, screen.url));
  }
  for (const screen of tree.publicScreens) {
    const params = matchPath(screen.url, pathname);
    if (params) candidates.push(candidate({ kind: "public", screen, params }, screen.url));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.params - b.params);
  return candidates[0].match;
}

export type NavScreenMatch =
  | { kind: "item"; category: NavCategory; item: NavItem; url: string }
  | { kind: "tab"; category: NavCategory; item: NavItem; tab: NavTab; url: string }
  | { kind: "dev-only"; screen: NavDevOnlyScreen; url: string }
  | { kind: "public"; screen: NavPublicScreen; url: string }
  | { kind: "alias"; alias: NavAlias; url: string | null }
  | { kind: "retired"; retired: NavRetiredScreen; url: string | null };

/** Where a SCREEN_COMPONENTS key lives in the tree (aliases and retired keys report their cover). */
export function findByScreen(screenKey: string, tree: NavTree = NAV_TREE): NavScreenMatch | null {
  for (const category of tree.categories) {
    for (const item of category.items) {
      if (item.screenKey === screenKey) return { kind: "item", category, item, url: item.url };
      for (const tab of item.tabs) {
        if (tab.screenKey === screenKey) return { kind: "tab", category, item, tab, url: tab.url };
      }
    }
  }
  const dev = tree.devOnly.find((screen) => screen.screenKey === screenKey);
  if (dev) return { kind: "dev-only", screen: dev, url: dev.url };
  const pub = tree.publicScreens.find((screen) => screen.screenKey === screenKey);
  if (pub) return { kind: "public", screen: pub, url: pub.url };
  const alias = tree.aliases.find((entry) => entry.screenKey === screenKey);
  if (alias) return { kind: "alias", alias, url: alias.url };
  const retired = tree.retired.find((entry) => entry.screenKey === screenKey);
  if (retired) return { kind: "retired", retired, url: retired.url };
  return null;
}

/** New URL of a screen key (following aliases and retirements), optionally with params filled. */
export function urlForScreen(screenKey: string, params?: Record<string, string | number>, tree: NavTree = NAV_TREE): string | null {
  const match = findByScreen(screenKey, tree);
  if (!match || !match.url) return null;
  return params ? fillParams(match.url, params) : match.url;
}

/** Every URL the router must register: items, tabs, dev-only and public screens. */
export function allUrls(tree: NavTree = NAV_TREE): string[] {
  const urls: string[] = [];
  for (const category of tree.categories) {
    for (const item of category.items) {
      urls.push(item.url);
      for (const tab of item.tabs) urls.push(tab.url);
    }
  }
  for (const screen of tree.devOnly) urls.push(screen.url);
  for (const screen of tree.publicScreens) urls.push(screen.url);
  return urls;
}

// ----------------------------------------------------------------- legacy redirects

const legacyRoutesByPrecision = (tree: NavTree) =>
  [...tree.legacyRoutes].sort((a, b) => {
    const aParams = (a.from.match(/:[A-Za-z0-9_]+/g) ?? []).length;
    const bParams = (b.from.match(/:[A-Za-z0-9_]+/g) ?? []).length;
    return aParams - bParams;
  });

/**
 * Old `/backoffice/*` pathname → new URL (§5). Route params are mapped by
 * position (`/backoffice/reservations/:reservationId` → `/recepcion/reservas/:id`).
 * When the new URL needs a param the old one did not carry (`/backoffice/guest-journey`
 * → `/recepcion/reservas/:id/recorrido`) the path is cut before the first
 * unresolved param so the redirect lands on the nearest static ancestor
 * (`/recepcion/reservas`). Returns null for unknown paths.
 */
export function resolveLegacyPath(pathname: string, tree: NavTree = NAV_TREE): string | null {
  const normalized = normalizePathname(pathname);
  for (const route of legacyRoutesByPrecision(tree)) {
    const params = matchPath(route.from, normalized);
    if (!params) continue;
    const values = Object.values(params);
    let index = 0;
    const segments = route.to.split("/").map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const value = values[index];
      index += 1;
      return value === undefined ? segment : encodeURIComponent(value);
    });
    const firstUnresolved = segments.findIndex((segment) => segment.startsWith(":"));
    const resolved = firstUnresolved === -1 ? segments : segments.slice(0, firstUnresolved);
    return normalizePathname(resolved.join("/"));
  }
  return null;
}

// ----------------------------------------------------------------- visibility

export type VisibleNavItem = Omit<NavItem, "tabs"> & { tabs: readonly NavTab[] };
export type VisibleNavCategory = { key: string; label: string; items: readonly VisibleNavItem[] };

/**
 * The menu a user sees: items filtered by role tokens and enabled modules,
 * tabs filtered the same way, categories without visible items dropped.
 * Detail sub-URLs (`detail: true`) stay in `tabs` so the router can match them,
 * but a tab strip must skip them.
 */
export function visibleCategories(
  roleTokens: readonly RoleToken[],
  enabledModules: readonly string[],
  tree: NavTree = NAV_TREE
): VisibleNavCategory[] {
  const result: VisibleNavCategory[] = [];
  for (const category of tree.categories) {
    const items: VisibleNavItem[] = [];
    for (const item of category.items) {
      if (!canSee(item, roleTokens, enabledModules)) continue;
      items.push({ ...item, tabs: item.tabs.filter((tab) => canSee(tab, roleTokens, enabledModules)) });
    }
    if (items.length > 0) result.push({ key: category.key, label: category.label, items });
  }
  return result;
}

export function countVisible(roleTokens: readonly RoleToken[], enabledModules: readonly string[], tree: NavTree = NAV_TREE) {
  const categories = visibleCategories(roleTokens, enabledModules, tree);
  return {
    categories: categories.length,
    items: categories.reduce((sum, category) => sum + category.items.length, 0),
    tabs: categories.reduce((sum, category) => sum + category.items.reduce((inner, item) => inner + item.tabs.length, 0), 0)
  };
}

/** Tabs a strip may paint: visible for the role/modules and without route params. */
export function paintableTabs(item: NavItem, roleTokens: readonly RoleToken[], enabledModules: readonly string[]): NavTab[] {
  return item.tabs.filter((tab) => !tab.detail && canSee(tab, roleTokens, enabledModules));
}

/**
 * Landing tab of an item for a role (§1 «la pestaña de aterrizaje es la
 * primera visible para el rol»): the role home when it is one of the item's
 * tabs (Mi día → /hoy/operaciones for pisos/mantenimiento/fnb, /hoy/direccion
 * for revenue/finanzas/comercial, /hoy/propietario for the owner template),
 * otherwise the base screen when it is itself a tab (`baseTab`), otherwise the
 * first paintable tab. `null` means "stay on the item URL" (the base screen).
 */
export function landingTabFor(
  item: NavItem,
  roleTokens: readonly RoleToken[],
  enabledModules: readonly string[],
  options: RoleHomeOptions = {}
): NavTab | null {
  const tabs = paintableTabs(item, roleTokens, enabledModules);
  if (tabs.length === 0) return null;
  const home = roleHome(primaryRoleToken(roleTokens), options);
  const homeTab = tabs.find((tab) => tab.url === home);
  if (homeTab) return homeTab;
  if (home === item.url || item.baseTab) return null;
  return tabs[0];
}

export type ModuleUnlock = { category: NavCategory; item: NavItem; wholeItem: boolean; tabs: readonly NavTab[] };

/** §6.2: which menu entries an inactive module would unlock (for «Módulos e integraciones»). */
export function menuEntriesUnlockedBy(moduleCode: string, tree: NavTree = NAV_TREE): ModuleUnlock[] {
  const result: ModuleUnlock[] = [];
  for (const category of tree.categories) {
    for (const item of category.items) {
      if (item.modulesAny.includes(moduleCode)) {
        result.push({ category, item, wholeItem: true, tabs: item.tabs });
        continue;
      }
      const tabs = item.tabs.filter((tab) => tab.modulesAny.includes(moduleCode));
      if (tabs.length > 0) result.push({ category, item, wholeItem: false, tabs });
    }
  }
  return result;
}

/** Module codes referenced anywhere in the menu (items and tabs), for the ModuleManager cross-reference. */
export function gatingModuleCodes(tree: NavTree = NAV_TREE): string[] {
  const codes = new Set<string>();
  for (const category of tree.categories) {
    for (const item of category.items) {
      item.modulesAny.forEach((code) => codes.add(code));
      item.tabs.forEach((tab) => tab.modulesAny.forEach((code) => codes.add(code)));
    }
  }
  return [...codes].sort();
}

// ----------------------------------------------------------------- L1b · menu model (Sidebar, ⌘K, landing)


/** The «Desarrollo» group (§4.3): dev-only screens, only with dev mode AND the admin token. */
export const DEV_CATEGORY_KEY = "desarrollo";
export const DEV_CATEGORY_LABEL = "Desarrollo";

export type MenuItemVisibility = "visible" | "locked";

export type MenuItem = VisibleNavItem & {
  /** `locked`: hidden only by its module and the user may enable modules (§6.3 «Activar módulo»). */
  visibility: MenuItemVisibility;
  /** Module codes that would unlock a locked item (none when visible). */
  lockedBy: readonly string[];
};

export type MenuCategory = {
  key: string;
  label: string;
  items: readonly MenuItem[];
  /** True for the «Desarrollo» group. */
  devOnly?: boolean;
};

export type MenuModelOptions = {
  /** The user holds `modules.enable`: module-gated entries are painted dimmed instead of hidden. */
  canEnableModules?: boolean;
  /** `?dev=1` / localStorage anfitorio.dev=1 (see isDevModeEnabled): adds «Desarrollo» for the admin token. */
  devMode?: boolean;
};

function menuItem(item: NavItem, visibility: MenuItemVisibility, tabs: readonly NavTab[], enabledModules: readonly string[]): MenuItem {
  return {
    ...item,
    tabs,
    visibility,
    lockedBy: visibility === "locked" ? item.modulesAny.filter((code) => !enabledModules.includes(code)) : []
  };
}

/**
 * The menu of a session (L1b): `visibleCategories` plus the locked state of
 * §6.3, the no-role state of §8 and the dev-only group of §4.3. Since Tanda
 * 8a every entry goes through ONE decision, `accessDecision` of
 * ./access-decision.ts — the same the router (`resolveLocation`) and the
 * shell (`RouteAccessGate`) apply, so a URL never opens what the menu hides:
 *
 * - tokens present → each item is visible, locked (module off + canEnableModules) or dropped;
 * - no token (custom role without template, or no role in the property) → only the
 *   entries every authenticated token can open (none since Tanda 8a: `rrhh`,
 *   `activos` and `sistemas` do not see Mi día), so the Sidebar shows
 *   UI_STATES.noRole and «Activar módulo» is never offered;
 * - `devMode` and the `admin` token → «Desarrollo» with the dev-only screens.
 * Categories without items are dropped (never an empty group).
 */
export function menuCategories(
  roleTokens: readonly RoleToken[],
  enabledModules: readonly string[],
  options: MenuModelOptions = {},
  tree: NavTree = NAV_TREE
): MenuCategory[] {
  const scope: AccessScope = {
    tokens: roleTokens,
    modules: enabledModules,
    modulesKnown: true,
    isPlatformAdmin: roleTokens.includes("admin"),
    devMode: options.devMode === true,
    canEnableModules: roleTokens.length > 0 && options.canEnableModules === true
  };
  const result: MenuCategory[] = [];
  for (const category of tree.categories) {
    const items: MenuItem[] = [];
    for (const item of category.items) {
      const decision = accessDecision(item, scope);
      if (decision !== "visible" && decision !== "locked") continue;
      const tabs = decision === "visible" ? item.tabs.filter((tab) => accessDecision(tab, scope) === "visible") : [];
      items.push(menuItem(item, decision, tabs, enabledModules));
    }
    if (items.length > 0) result.push({ key: category.key, label: category.label, items });
  }
  if (devUnlocked(scope)) {
    const items: MenuItem[] = [];
    for (const screen of tree.devOnly) {
      if (accessDecision({ ...screen, devOnly: true }, scope) !== "visible") continue;
      items.push({ ...screen, baseTab: null, tabs: [], visibility: "visible", lockedBy: [] });
    }
    if (items.length > 0) result.push({ key: DEV_CATEGORY_KEY, label: DEV_CATEGORY_LABEL, items, devOnly: true });
  }
  return result;
}

export type MenuCounts = { categories: number; items: number; locked: number; tabs: number };

export function countMenu(categories: readonly MenuCategory[]): MenuCounts {
  let items = 0;
  let locked = 0;
  let tabs = 0;
  for (const category of categories) {
    for (const item of category.items) {
      items += 1;
      if (item.visibility === "locked") locked += 1;
      tabs += item.tabs.length;
    }
  }
  return { categories: categories.length, items, locked, tabs };
}

export type ActiveMenuItem = { categoryKey: string; screenKey: string };

/**
 * The menu item that owns a SCREEN_COMPONENTS key: the item itself, the item
 * of a tab, the parent of a dev-only screen (the «Desarrollo» entry when it
 * is painted), and the cover of an alias or retired key. Null for public
 * screens and unknown keys.
 */
export function activeMenuItemFor(screenKey: string, tree: NavTree = NAV_TREE, depth = 0): ActiveMenuItem | null {
  if (depth > 5) return null;
  const match = findByScreen(screenKey, tree);
  if (!match) return null;
  switch (match.kind) {
    case "item":
      return { categoryKey: match.category.key, screenKey: match.item.screenKey };
    case "tab":
      return { categoryKey: match.category.key, screenKey: match.item.screenKey };
    case "dev-only":
      return { categoryKey: DEV_CATEGORY_KEY, screenKey: match.screen.screenKey };
    case "alias":
      return activeMenuItemFor(match.alias.canonical, tree, depth + 1);
    case "retired":
      return activeMenuItemFor(match.retired.coveredBy, tree, depth + 1);
    default:
      return null;
  }
}

/** Screen key that serves a URL of the tree (item, tab, dev-only or public), or null. */
export function screenKeyForUrl(pathname: string, tree: NavTree = NAV_TREE): string | null {
  const match = findByUrl(pathname, tree);
  if (!match) return null;
  switch (match.kind) {
    case "item":
      return match.item.screenKey;
    case "tab":
      return match.tab.screenKey;
    default:
      return match.screen.screenKey;
  }
}

export type LandingTarget = { url: string; screenKey: string };

/** Screen key of the first item of the menu (the shell's last-resort landing). */
export const FALLBACK_LANDING_SCREEN = "FrontDeskDashboard";

/**
 * Landing of a session (§3): the role home URL (`roleHomeForTokens`, mobile
 * tab under MOBILE_BREAKPOINT_PX) and the screen key that serves it, so the
 * shell can navigate by key while the router registers the new URLs.
 */
export function landingFor(roleTokens: readonly RoleToken[], options: RoleHomeOptions = {}, tree: NavTree = NAV_TREE): LandingTarget {
  const url = roleHomeForTokens(roleTokens, options);
  return { url, screenKey: screenKeyForUrl(url, tree) ?? FALLBACK_LANDING_SCREEN };
}

export type MenuEntry = {
  categoryKey: string;
  categoryLabel: string;
  /** Item that owns the entry (equal to `screenKey` for an item entry). */
  itemScreenKey: string;
  itemLabel: string;
  screenKey: string;
  label: string;
  url: string;
  /** Tab label when the entry is a tab of the item; null for the item itself. */
  tab: string | null;
  visibility: MenuItemVisibility;
};

/** Flat catalogue of a menu (items, optionally their paintable tabs) for ⌘K and the help search. */
export function flatMenuEntries(categories: readonly MenuCategory[], options: { includeTabs?: boolean } = {}): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const category of categories) {
    for (const item of category.items) {
      entries.push({
        categoryKey: category.key,
        categoryLabel: category.label,
        itemScreenKey: item.screenKey,
        itemLabel: item.label,
        screenKey: item.screenKey,
        label: item.label,
        url: item.url,
        tab: null,
        visibility: item.visibility
      });
      if (!options.includeTabs || item.visibility !== "visible") continue;
      for (const tab of item.tabs) {
        if (tab.detail) continue;
        entries.push({
          categoryKey: category.key,
          categoryLabel: category.label,
          itemScreenKey: item.screenKey,
          itemLabel: item.label,
          screenKey: tab.screenKey,
          label: tab.label,
          url: tab.url,
          tab: tab.label,
          visibility: "visible"
        });
      }
    }
  }
  return entries;
}

/** Target of «Activar módulo» (§6.3): Módulos e integraciones with the first missing module preselected (`#modulo=<code>`). */
export function enableModuleTarget(item: Pick<MenuItem, "lockedBy">): string {
  const code = item.lockedBy[0];
  return code ? `ModuleManager#modulo=${encodeURIComponent(code)}` : "ModuleManager";
}

/** Accent- and case-insensitive text for the menu search («cronograma» finds «Cronograma»). */
export function normalizeMenuText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** An item matches the search when its label or one of its paintable tab labels contains the query. */
export function menuItemMatches(item: Pick<MenuItem, "label" | "tabs">, query: string): boolean {
  const needle = normalizeMenuText(query);
  if (!needle) return true;
  if (normalizeMenuText(item.label).includes(needle)) return true;
  return item.tabs.some((tab) => !tab.detail && normalizeMenuText(tab.label).includes(needle));
}
