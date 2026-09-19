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
  resolveMovedPath,
  type NavCategory,
  type NavItem,
  type NavTab
} from "../../navigation/nav-tree";
import { canSee, moduleAllows, roleAllows, type NavGate, type RoleHomeOptions, type RoleToken } from "../../navigation/role-tokens";
import { UI_STATES } from "../../content/actions";
import { moduleDisabledCopy } from "../operations/module-gate";

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
 * `/recepcion/reservas/nueva` the sibling item, never a reservation id. A moved
 * URL (`/recepcion/reservas/cronograma`, fusión TL) is a redirect, not an id.
 */
export function detailParamsFor(item: Pick<NavItem, "screenKey">, pathname: string | null | undefined): Record<string, string> | null {
  if (!pathname || resolveMovedPath(pathname)) return null;
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

// ----------------------------------------------------------------- empty container (qa#12)

export type EmptyTabsReason =
  /** Some tab passes the role gate, but none of those has an enabled module (paint «Módulo no activado»). */
  | "module"
  /** Idem, but the module list is not readable (403 on GET /modules, or it failed to load): unknown, never «no activado». */
  | "modules_unknown"
  /** No tab passes the role gate: the item is not for this profile. */
  | "role";

export type EmptyTabsOptions = {
  /** GET /modules answered 403 (or failed) for this user: the list is unknown, not empty. */
  listUnavailable?: boolean;
};

/**
 * Why a container paints no tab, or null when at least one is visible
 * (`isTabVisible`, the gate NavItemTabs injects). The role gate is judged
 * first: a profile with no tab in the item reads «Sin acceso» even if the
 * module is off too, while a profile the item IS for (the platform admin in
 * prop_123 with outlet_pos disabled, qa#12) reads that the module is not
 * enabled — never «para tu perfil». With no token only the module gate
 * applies (custom role, §8), so the reason is never `role` there.
 */
export function emptyTabsReason(
  tabs: readonly CocoaRouteTab[],
  tokens: readonly RoleToken[],
  modules: readonly string[],
  options: EmptyTabsOptions = {}
): EmptyTabsReason | null {
  if (tabs.some((tab) => isTabVisible(tab, tokens, modules))) return null;
  const roleAllowed = tokens.length === 0 ? tabs : tabs.filter((tab) => roleAllows(tab, tokens));
  if (roleAllowed.length === 0) return "role";
  return options.listUnavailable ? "modules_unknown" : "module";
}

/** Module codes that would unlock a tab of the container for these tokens, in tree order and deduplicated («Activar módulo» preselects the first). */
export function unlockingModulesFor(tabs: readonly CocoaRouteTab[], tokens: readonly RoleToken[]): string[] {
  const codes = new Set<string>();
  for (const tab of tabs) {
    if (tokens.length > 0 && !roleAllows(tab, tokens)) continue;
    for (const code of tab.modulesAny ?? []) codes.add(code);
  }
  return [...codes];
}

export type EmptyTabsCopy = {
  title: string;
  message: string;
  /** «Activar módulo», only for `module` and only when the user holds `modules.enable`. */
  cta?: string;
};

/**
 * Copy of the empty container per reason: the canonical UI_STATES entries
 * (`moduleDisabled` through `moduleDisabledCopy`, the same the module-gated
 * dashboards paint; `forbidden` for a role gap) plus an honest sentence when
 * the module list could not be read.
 */
export function emptyTabsCopy(reason: EmptyTabsReason, options: { canEnable: boolean }): EmptyTabsCopy {
  switch (reason) {
    case "module":
      return moduleDisabledCopy(options.canEnable);
    case "modules_unknown":
      return {
        title: "Secciones no disponibles",
        message: "No hemos podido comprobar qué módulos están activos en la propiedad, así que estas secciones quedan ocultas. Pide a dirección que revise tu acceso."
      };
    case "role":
      return { title: UI_STATES.forbidden.title, message: UI_STATES.forbidden.message };
  }
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
 * tab (Reservas has no base tab: recepción lands on Lista, pisos on Tablero since the fusión TL moved Cronograma to Hoy › Live Timeline).
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

// ----------------------------------------------------------------- eyebrow

/**
 * Eyebrow a container paints over its H1: the category label («Finanzas»),
 * extended by the hosted screen's own eyebrow ONLY when that eyebrow qualifies
 * the same category — «Finanzas · CELUISMA S.A.» / «Cumplimiento · Hotel Rías
 * Altas (RA)», the sociedad or centre of the finance scope (design §5.3 of
 * FINANZAS-ESTRUCTURA-SOCIETARIA.md; fix:L7 qa#12). Anything else keeps the
 * plain category so the header never drifts from the menu (runbook
 * navegación-tanda-5 §4): another category, the category alone, or
 * «Categoría · Ítem» (treeHeaderFor of a tab, already the H1 of the container).
 */
export function containerEyebrow(categoryLabel: string, itemLabel: string, screenEyebrow: string | null | undefined): string {
  const eyebrow = screenEyebrow?.trim();
  if (!eyebrow) return categoryLabel;
  const prefix = `${categoryLabel} · `;
  if (!eyebrow.startsWith(prefix)) return categoryLabel;
  const qualifier = eyebrow.slice(prefix.length).trim();
  if (!qualifier || qualifier === itemLabel) return categoryLabel;
  return `${categoryLabel} · ${qualifier}`;
}
