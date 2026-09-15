// Pure helpers behind the routed tab containers (Tanda 5 · L1a · lote tabs-a).
//
// A container is built from ONE item of nav-tree.generated.json: labels, URLs,
// roles, modulesAny and the `detail` flag of every tab come straight from the
// tree, so nothing is typed twice and the CSV stays the single source. The
// container only supplies the lazy loader of each screen key. Everything here
// is pure (no React, no window) and covered by __tests__/nav-item-tabs.test.mts.

import type { CocoaRouteTab, LazyTabLoader } from "../../components/cocoa/CocoaRouteTabs";
import {
  fillParams,
  findByScreen,
  findByUrl,
  landingTabFor,
  normalizePathname,
  type NavCategory,
  type NavItem,
  type NavTab
} from "../../navigation/nav-tree";
import { canSee, moduleAllows, type NavGate, type RoleHomeOptions, type RoleToken } from "../../navigation/role-tokens";

/** Lazy loader per screen key of the tree (`{ FrontDeskDashboard: () => import(...) }`). */
export type TabLoaders = Readonly<Record<string, LazyTabLoader>>;

export type ItemTabsOptions = {
  /** Current pathname: detail sub-URLs (`:id`) matching it are painted with their concrete path. */
  pathname?: string | null;
  /** Roles of the base tab when narrower than the item roles (Mi día: «Recepción» is not for pisos/fnb). */
  baseRoles?: readonly string[];
};

// ----------------------------------------------------------------- tree lookups

/** The menu item behind a container; throws when the key is a tab, alias or retired screen. */
export function itemForScreen(screenKey: string): { category: NavCategory; item: NavItem } {
  const match = findByScreen(screenKey);
  if (!match || match.kind !== "item") throw new Error(`nav-item-tabs: ${screenKey} no es un ítem de menú del árbol`);
  return { category: match.category, item: match.item };
}

export function slugify(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lastSegment(url: string): string {
  const segments = normalizePathname(url).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/** Tab key: the last static URL segment (`lista`, `mi-turno`); for `:param` sub-URLs the label's slug (`Detalle` → `detalle`). */
export function tabKeyFor(tab: Pick<NavTab, "url" | "label">): string {
  const segment = lastSegment(tab.url);
  return segment.startsWith(":") ? slugify(tab.label) : segment;
}

/** Key of the base tab: last segment of the item URL (`/operaciones/pisos` → `pisos`). */
export function baseKeyFor(item: Pick<NavItem, "url">): string {
  return lastSegment(item.url);
}

// ----------------------------------------------------------------- tabs

/**
 * Params of the detail sub-URL of the item that serves the pathname; null on
 * static URLs. Resolved through the tree (`findByUrl`: static wins over
 * `:param`), so `/recepcion/reservas/lista` is the Lista tab and
 * `/recepcion/reservas/nueva` the sibling item, never a reservation id.
 */
export function detailParamsFor(item: Pick<NavItem, "screenKey">, pathname: string | null | undefined): Record<string, string> | null {
  if (!pathname) return null;
  const match = findByUrl(pathname);
  if (!match || match.kind !== "tab" || match.item.screenKey !== item.screenKey || !match.tab.detail) return null;
  return match.params;
}

function hasEveryParam(url: string, params: Record<string, string>): boolean {
  const names = (url.match(/:([A-Za-z0-9_]+)/g) ?? []).map((placeholder) => placeholder.slice(1));
  return names.every((name) => params[name] !== undefined);
}

/**
 * CocoaRouteTabs entries of an item: the base tab first (only when the tree
 * names it with `baseTab` AND the container wires its loader), then the tabs
 * in tree order. Detail sub-URLs stay hidden with their `:param` pattern until
 * the pathname carries the params; then every detail tab those params satisfy
 * is painted with a concrete path (Detalle + Recorrido of the same reservation,
 * Ficha + Cronología of the same guest). Tabs without a loader are skipped —
 * the unit test reports them via `missingLoaders`.
 */
export function buildItemTabs(item: NavItem, loaders: TabLoaders, options: ItemTabsOptions = {}): CocoaRouteTab[] {
  const tabs: CocoaRouteTab[] = [];
  const baseLoader = loaders[item.screenKey];
  if (item.baseTab && baseLoader) {
    tabs.push({
      key: baseKeyFor(item),
      label: item.baseTab,
      path: item.url,
      roles: options.baseRoles ?? item.roles,
      modulesAny: item.modulesAny,
      lazy: baseLoader
    });
  }
  const params = detailParamsFor(item, options.pathname);
  for (const tab of item.tabs) {
    const lazy = loaders[tab.screenKey];
    if (!lazy) continue;
    const concrete = Boolean(tab.detail && params && hasEveryParam(tab.url, params));
    tabs.push({
      key: tabKeyFor(tab),
      label: tab.label,
      path: concrete && params ? fillParams(tab.url, params) : tab.url,
      roles: tab.roles,
      modulesAny: tab.modulesAny,
      ...(tab.detail ? { hidden: !concrete } : {}),
      lazy
    });
  }
  return tabs;
}

/** Screen keys of the item (base when it is a tab, plus every tab) that `loaders` does not cover. */
export function missingLoaders(item: NavItem, loaders: TabLoaders): string[] {
  const missing: string[] = [];
  if (item.baseTab && !loaders[item.screenKey]) missing.push(item.screenKey);
  for (const tab of item.tabs) if (!loaders[tab.screenKey]) missing.push(tab.screenKey);
  return missing;
}

// ----------------------------------------------------------------- visibility and landing

/**
 * Role/module gate of a tab. With no role token (custom role without template,
 * or permissions not loaded) only the module gate applies: hiding every tab
 * would leave an empty product, and L1b adds the permission gate per route.
 */
export function isTabVisible(gate: NavGate, tokens: readonly RoleToken[], modules: readonly string[]): boolean {
  return tokens.length === 0 ? moduleAllows(gate, modules) : canSee(gate, tokens, modules);
}

export type LandingKeys = { defaultTab: string; mobileDefaultTab: string };

function fallbackKey(item: NavItem, tabs: readonly CocoaRouteTab[]): string {
  const base = tabs.find((tab) => tab.path === item.url);
  if (base) return base.key;
  return tabs.find((tab) => !tab.hidden)?.key ?? tabs[0]?.key ?? baseKeyFor(item);
}

/**
 * `defaultTab` / `mobileDefaultTab` of a container from `landingTabFor` (§1/§3:
 * the role home when it is a tab of the item, the base tab when the tree names
 * one, else the first paintable tab). Null from `landingTabFor` means "stay on
 * the base screen": that is the base tab when present, else the first painted
 * tab (Reservas has no base tab: recepción lands on Lista, pisos on Cronograma).
 */
export function landingKeysFor(
  item: NavItem,
  tabs: readonly CocoaRouteTab[],
  tokens: readonly RoleToken[],
  modules: readonly string[],
  options: Omit<RoleHomeOptions, "mobile"> = {}
): LandingKeys {
  const fallback = fallbackKey(item, tabs);
  const keyFor = (mobile: boolean): string => {
    const landing = landingTabFor(item, tokens, modules, { ...options, mobile });
    if (!landing) return fallback;
    return tabs.find((tab) => tab.path === landing.url)?.key ?? fallback;
  };
  return { defaultTab: keyFor(false), mobileDefaultTab: keyFor(true) };
}
