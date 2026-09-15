// Route table of the admin shell (Tanda 5 · L1b · lote router-app).
//
// Everything here derives from the navigation tree (navigation/nav-tree.ts →
// nav-tree.generated.json, built from pilots/tanda5-nav-tree.csv): nothing is
// typed twice.
//
//   - BACKOFFICE_ROUTES  = allUrls() of the tree: 64 items + 80 tabs/sub-URLs +
//                          20 dev-only + 2 public = 166 URLs. The base URL of a
//                          tab container always precedes its tabs, so
//                          `pathForScreen` returns the first static route.
//   - LEGACY_ROUTES      = the 205 old /backoffice/* paths (NAV_TREE.legacyRoutes),
//                          served as a client-side 308: `resolveLegacyLocation`
//                          maps them with `resolveLegacyPath` (params by
//                          position, cut before params the old URL did not
//                          carry) and App.tsx writes the new URL with
//                          replaceState — an old link never stays in history.
//   - LEGACY_SCREEN_KEYS = the 24 key aliases (NAV_TREE.aliases): still valid
//                          SCREEN_COMPONENTS keys, resolved to their canonical
//                          screen URL.
//   - /desarrollo/*      = the 20 dev-only screens behind ONE guard
//                          (`isDevRouteAllowed`: dev mode AND platform admin).
//
// Pure module: no `window`, no React; App.tsx owns the history writes.

import {
  NAV_TREE,
  allUrls,
  fillParams,
  findByScreen,
  findByUrl,
  hasRouteParams,
  isDevModeEnabled,
  isDevOnlyPath,
  matchPath,
  normalizePathname,
  resolveLegacyPath,
  screenKeyForUrl,
  urlForScreen,
  type NavAlias,
  type NavLegacyRoute,
  type NavRetiredScreen
} from "../navigation/nav-tree";

export type RouteKind = "item" | "tab" | "dev-only" | "public";

export type BackofficeRoute = {
  /** URL pattern (`/recepcion/reservas/:id`), relative to the shell origin. */
  path: string;
  /** SCREEN_COMPONENTS key that serves the URL (a tab key maps to its container). */
  screen: string;
  kind: RouteKind;
  /** Only reachable with dev mode + platform admin (see `isDevRouteAllowed`). */
  devOnly: boolean;
  /** Rendered outside the authenticated shell. */
  public: boolean;
};

/** Old paths lived under this prefix; anything still starting with it is a legacy link. */
export const LEGACY_ROUTE_PREFIX = "/backoffice";

function buildRoutes(): BackofficeRoute[] {
  const routes: BackofficeRoute[] = [];
  for (const category of NAV_TREE.categories) {
    for (const item of category.items) {
      // Base URL of the container BEFORE its tabs (pathForScreen contract).
      routes.push({ path: item.url, screen: item.screenKey, kind: "item", devOnly: false, public: false });
      for (const tab of item.tabs) {
        routes.push({ path: tab.url, screen: tab.screenKey, kind: "tab", devOnly: false, public: false });
      }
    }
  }
  for (const screen of NAV_TREE.devOnly) {
    routes.push({ path: screen.url, screen: screen.screenKey, kind: "dev-only", devOnly: true, public: false });
  }
  for (const screen of NAV_TREE.publicScreens) {
    routes.push({ path: screen.url, screen: screen.screenKey, kind: "public", devOnly: false, public: true });
  }
  return routes;
}

/** The 166 URLs the shell serves, in tree order (base URL before its tabs). */
export const BACKOFFICE_ROUTES: readonly BackofficeRoute[] = buildRoutes();

/** The 205 old /backoffice/* paths and the tree URL each one lands on (§5 of the plan). */
export const LEGACY_ROUTES: readonly NavLegacyRoute[] = NAV_TREE.legacyRoutes;

/** The 24 key aliases (old SCREEN_COMPONENTS keys that keep resolving to their canonical screen). */
export const LEGACY_SCREEN_KEYS: readonly NavAlias[] = NAV_TREE.aliases;

/** The 72 retired keys: no component; `url` says where an orphan hotelos-nav is redirected. */
export const RETIRED_SCREEN_KEYS: readonly NavRetiredScreen[] = NAV_TREE.retired;

export const DEV_ONLY_ROUTES: readonly BackofficeRoute[] = BACKOFFICE_ROUTES.filter((route) => route.devOnly);
export const PUBLIC_ROUTES: readonly BackofficeRoute[] = BACKOFFICE_ROUTES.filter((route) => route.public);

const ROUTE_BY_PATH: ReadonlyMap<string, BackofficeRoute> = new Map(BACKOFFICE_ROUTES.map((route) => [route.path, route]));
const ALIAS_BY_KEY: ReadonlyMap<string, NavAlias> = new Map(LEGACY_SCREEN_KEYS.map((alias) => [alias.screenKey, alias]));
const RETIRED_BY_KEY: ReadonlyMap<string, NavRetiredScreen> = new Map(RETIRED_SCREEN_KEYS.map((entry) => [entry.screenKey, entry]));
const DEV_ONLY_KEYS: ReadonlySet<string> = new Set(DEV_ONLY_ROUTES.map((route) => route.screen));
const PUBLIC_KEYS: ReadonlySet<string> = new Set(PUBLIC_ROUTES.map((route) => route.screen));

// ----------------------------------------------------------------- matching

/** Segment-exact match of a route pattern against a pathname (`:param` segments accept any non-empty value). */
export function routeMatches(pattern: string, pathname: string): boolean {
  return matchPath(pattern, pathname) !== null;
}

/** `/backoffice` and `/backoffice/*`: the pre-Tanda 5 URL space. */
export function isLegacyPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === LEGACY_ROUTE_PREFIX || normalized.startsWith(`${LEGACY_ROUTE_PREFIX}/`);
}

/** Root paths that land on the role home instead of a fixed screen. */
export function isHomePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/" || normalized === LEGACY_ROUTE_PREFIX;
}

/** The registered route that serves a pathname (static URLs win over `:param` ones), or null. */
export function routeForPathname(pathname: string): BackofficeRoute | null {
  const match = findByUrl(pathname);
  if (!match) return null;
  const url = match.kind === "item" ? match.item.url : match.kind === "tab" ? match.tab.url : match.screen.url;
  return ROUTE_BY_PATH.get(url) ?? null;
}

/** SCREEN_COMPONENTS key that serves a pathname of the tree, or null. */
export function screenFromPathname(pathname: string): string | null {
  return screenKeyForUrl(pathname);
}

// ----------------------------------------------------------------- screen → URL

/** Alias → canonical key (retired keys and unknown keys are returned as they are). */
export function canonicalScreenKey(screen: string): string {
  let current = screen;
  for (let depth = 0; depth < 5; depth += 1) {
    const alias = ALIAS_BY_KEY.get(current);
    if (!alias) return current;
    current = alias.canonical;
  }
  return current;
}

export function isAliasScreenKey(screen: string): boolean {
  return ALIAS_BY_KEY.has(screen);
}

export function isDevOnlyScreen(screen: string): boolean {
  return DEV_ONLY_KEYS.has(canonicalScreenKey(screen));
}

export function isPublicScreen(screen: string): boolean {
  return PUBLIC_KEYS.has(screen);
}

/** Where an orphan `hotelos-nav` to a retired key must land (`null` when the screen has no cover URL). */
export function retiredScreenUrl(screen: string): string | null {
  return RETIRED_BY_KEY.get(screen)?.url ?? null;
}

export function isRetiredScreenKey(screen: string): boolean {
  return RETIRED_BY_KEY.has(screen);
}

/**
 * Static URL of a screen key: the item URL, the tab URL of a tab key (so a
 * `hotelos-nav` to a tab lands inside its container), the dev-only or public
 * URL, or the canonical URL of an alias / the cover of a retired key.
 * `undefined` for detail sub-URLs (`:id`): the caller writes the concrete URL.
 */
export function pathForScreen(screen: string): string | undefined {
  const url = urlForScreen(screen);
  if (!url || hasRouteParams(url)) return undefined;
  return url;
}

/** URL pattern of a screen key (with `:param` placeholders), following aliases and retirements. */
export function urlPatternForScreen(screen: string): string | null {
  return urlForScreen(screen);
}

/** Concrete URL of a detail screen (`GuestDetail` + `{ id }` → `/recepcion/huespedes/abc`), or null when a param is missing. */
export function urlForScreenWithParams(screen: string, params: Record<string, string | number>): string | null {
  const pattern = urlForScreen(screen);
  if (!pattern) return null;
  const filled = fillParams(pattern, params);
  return hasRouteParams(filled) ? null : filled;
}

/** URL of the menu item that owns a screen key (the item itself, the item of a tab, or the dev-only/public URL). */
export function itemUrlForScreen(screen: string): string | null {
  const match = findByScreen(canonicalScreenKey(screen));
  if (!match) return null;
  switch (match.kind) {
    case "item":
      return match.item.url;
    case "tab":
      return match.item.url;
    case "dev-only":
    case "public":
      return match.screen.url;
    case "retired": {
      const cover = match.retired.url;
      return cover ? itemUrlForScreen(screenKeyForUrl(cover) ?? "") ?? cover : null;
    }
    default:
      return null;
  }
}

/** True when `pathname` is served by the same menu item as `screen` (a tab of it, or the item itself). */
export function pathnameBelongsToScreen(pathname: string, screen: string): boolean {
  const served = screenFromPathname(pathname);
  if (!served) return false;
  const a = itemUrlForScreen(served);
  const b = itemUrlForScreen(screen);
  return a !== null && a === b;
}

// ----------------------------------------------------------------- legacy (client-side 308)

export type LocationLike = { pathname: string; search?: string | null; hash?: string | null };

/**
 * Query/hash keys an old deep link may carry, by the `:param` they fill
 * (`?reservationId=` → `:id`, `#propertyId=` → `:propiedad`). A key is never
 * read into a param of another kind: `?guestId=g1&propertyId=p1` on
 * property-detail fills `:propiedad` with `p1`, not with the guest.
 */
export const LEGACY_ID_KEYS_BY_PARAM: Readonly<Record<string, readonly string[]>> = {
  id: ["id", "reservationId", "reservation", "guestId", "guest", "folioId", "folio", "orgId", "org"],
  propiedad: ["propertyId", "propiedad", "property"],
  codigo: ["codigo", "categoryCode"]
};

/** For `:id` the URL prefix of the target says which entity the id names; other prefixes accept every `:id` key. */
const ID_KEYS_BY_URL_PREFIX: readonly (readonly [prefix: string, keys: readonly string[]])[] = [
  ["/recepcion/reservas", ["id", "reservationId", "reservation"]],
  ["/recepcion/huespedes", ["id", "guestId", "guest"]],
  ["/finanzas/facturacion/folios", ["id", "folioId", "folio"]],
  ["/configuracion/sistema/organizaciones", ["id", "orgId", "org"]]
];

/** Every key, in param order, for callers that do not know the target (`idFromSearchOrHash` without options). */
const LEGACY_ID_KEYS: readonly string[] = Object.values(LEGACY_ID_KEYS_BY_PARAM).flat();

/** Keys accepted for `param` when filling `targetUrl` (all of them when the param is unknown). */
export function legacyIdKeysFor(param: string | null | undefined, targetUrl?: string | null): readonly string[] {
  if (!param) return LEGACY_ID_KEYS;
  const keys = LEGACY_ID_KEYS_BY_PARAM[param];
  if (!keys) return LEGACY_ID_KEYS;
  if (param !== "id" || !targetUrl) return keys;
  const normalized = normalizePathname(targetUrl);
  const scoped = ID_KEYS_BY_URL_PREFIX.find(([prefix]) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  return scoped ? scoped[1] : keys;
}

function parseParams(raw: string | null | undefined, leading: string): URLSearchParams {
  const value = raw ?? "";
  return new URLSearchParams(value.startsWith(leading) ? value.slice(1) : value);
}

export type LegacyIdSource = "search" | "hash";

/** An id read from an old deep link: its value, the key it came from and where (`?query` or `#hash`). */
export type LegacyIdMatch = { value: string; key: string; source: LegacyIdSource };

export type LegacyIdOptions = {
  /** Param the id fills (`id`, `propiedad`, `codigo`); unknown → every key. */
  param?: string | null;
  /** URL pattern being filled: scopes the `:id` keys to the entity of the prefix. */
  targetUrl?: string | null;
};

/** First accepted key found in `?query` then `#hash` (`?reservationId=res_1`, `#org=abc`), or null. */
export function findLegacyId(search: string | null | undefined, hash: string | null | undefined, options: LegacyIdOptions = {}): LegacyIdMatch | null {
  const keys = legacyIdKeysFor(options.param, options.targetUrl);
  const sources: readonly [LegacyIdSource, URLSearchParams][] = [
    ["search", parseParams(search, "?")],
    ["hash", parseParams(hash, "#")]
  ];
  for (const [source, params] of sources) {
    for (const key of keys) {
      const value = params.get(key);
      if (value && value.trim()) return { value: value.trim(), key, source };
    }
  }
  return null;
}

/** Value of `findLegacyId`, or null. */
export function idFromSearchOrHash(search: string | null | undefined, hash: string | null | undefined, options: LegacyIdOptions = {}): string | null {
  return findLegacyId(search, hash, options)?.value ?? null;
}

/**
 * `search` and `hash` without the key a redirect consumed, so the new URL
 * never carries the id twice (`/recepcion/reservas/res_1/recorrido` instead of
 * `…/recorrido?reservationId=res_1`); the rest of the query (`?dev=1`,
 * filters) is kept. Both come back ready to append (`?…`/`#…` or empty).
 */
export function stripLegacyId(search: string | null | undefined, hash: string | null | undefined, consumed: LegacyIdMatch | null | undefined): { search: string; hash: string } {
  const searchParams = parseParams(search, "?");
  const hashParams = parseParams(hash, "#");
  if (consumed?.source === "search") searchParams.delete(consumed.key);
  if (consumed?.source === "hash") hashParams.delete(consumed.key);
  const nextSearch = searchParams.toString();
  const rawHash = hash ?? "";
  // A hash that is not `key=value` pairs (an anchor like `#nuevo-grupo`) is kept as it is.
  const nextHash = consumed?.source === "hash" ? hashParams.toString() : rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  return { search: nextSearch ? `?${nextSearch}` : "", hash: nextHash ? `#${nextHash}` : "" };
}

function legacyPattern(pathname: string): string | null {
  const normalized = normalizePathname(pathname);
  const exact = LEGACY_ROUTES.find((route) => route.from === normalized);
  if (exact) return exact.to;
  const match = [...LEGACY_ROUTES]
    .sort((a, b) => (a.from.match(/:[A-Za-z0-9_]+/g) ?? []).length - (b.from.match(/:[A-Za-z0-9_]+/g) ?? []).length)
    .find((route) => matchPath(route.from, normalized));
  return match?.to ?? null;
}

export type LegacyResolution = {
  pathname: string;
  screen: string;
  devOnly: boolean;
  /** The `?query`/`#hash` id the new URL took (App.tsx drops it from the redirect), or null. */
  consumed: LegacyIdMatch | null;
};

/**
 * Old `/backoffice/*` location → new URL + screen key. Params travel by
 * position (`/backoffice/guests/:guestId` → `/recepcion/huespedes/:id`); when
 * the new URL needs a param the old path did not carry (guest-journey,
 * guest-portal, property-detail) the id is read from `?query`/`#hash` and,
 * failing that, the redirect lands on the nearest static ancestor (§5).
 * `null` for paths outside the legacy table.
 */
export function resolveLegacyLocation(location: LocationLike): LegacyResolution | null {
  const resolved = resolveLegacyPath(location.pathname);
  if (!resolved) return null;
  let target = resolved;
  let consumed: LegacyIdMatch | null = null;
  const pattern = legacyPattern(location.pathname);
  if (pattern && hasRouteParams(pattern) && !routeMatches(pattern, resolved)) {
    const firstParam = pattern.match(/:([A-Za-z0-9_]+)/)?.[1] ?? null;
    const match = findLegacyId(location.search, location.hash, { param: firstParam, targetUrl: pattern });
    if (match && firstParam) {
      const filled = fillParams(pattern, { [firstParam]: match.value });
      if (!hasRouteParams(filled) && routeForPathname(filled)) {
        target = filled;
        consumed = match;
      }
    }
  }
  const route = routeForPathname(target);
  if (!route) return null;
  return { pathname: target, screen: route.screen, devOnly: route.devOnly, consumed };
}

// ----------------------------------------------------------------- dev-only guard

export type DevGuardInput = {
  /** `window.location.search` (`?dev=1`). */
  search?: string | null;
  /** `localStorage["anfitorio.dev"]`. */
  storageValue?: string | null;
  /** Real platform-admin flag of the session (never the demo union). */
  isPlatformAdmin?: boolean | null;
};

/** ONE guard for the 20 /desarrollo/* screens: dev mode (`?dev=1` or storage) AND the platform admin. */
export function isDevRouteAllowed(input: DevGuardInput): boolean {
  return isDevModeEnabled({ search: input.search, storageValue: input.storageValue }) && input.isPlatformAdmin === true;
}

// ----------------------------------------------------------------- location → screen

export type RouteResolution =
  | { kind: "home" }
  | {
      kind: "screen";
      screen: string;
      route: BackofficeRoute;
      /** Set when the location was a legacy path: the new pathname to write with replaceState. */
      redirect?: string;
      /** With `redirect`: the `?query`/`#hash` id the new URL consumed (to drop from the redirect), or null. */
      consumed?: LegacyIdMatch | null;
    }
  | { kind: "dev-locked"; pathname: string }
  | { kind: "not-found"; pathname: string };

/**
 * What the shell renders for a location: the role home for `/` and
 * `/backoffice`, a legacy redirect (308 on the client), a registered screen,
 * the dev-only lock, or not-found. Public URLs resolve to their public route;
 * App.tsx decides what to do with them for an authenticated session.
 */
export function resolveLocation(location: LocationLike, guard: DevGuardInput = {}): RouteResolution {
  const pathname = normalizePathname(location.pathname);
  if (isHomePath(pathname)) return { kind: "home" };
  if (isLegacyPath(pathname)) {
    const legacy = resolveLegacyLocation({ ...location, pathname });
    if (!legacy) return { kind: "not-found", pathname };
    if (legacy.devOnly && !isDevRouteAllowed(guard)) return { kind: "dev-locked", pathname: legacy.pathname };
    const route = routeForPathname(legacy.pathname);
    if (!route) return { kind: "not-found", pathname };
    return { kind: "screen", screen: legacy.screen, route, redirect: legacy.pathname, consumed: legacy.consumed };
  }
  const route = routeForPathname(pathname);
  if (!route) return { kind: "not-found", pathname };
  if (route.devOnly && !isDevRouteAllowed(guard)) return { kind: "dev-locked", pathname };
  return { kind: "screen", screen: route.screen, route };
}

/** True when the pathname is a dev-only URL (registered or not). */
export function isDevOnlyPathname(pathname: string): boolean {
  return isDevOnlyPath(pathname);
}

/** Every URL the shell serves (same order as BACKOFFICE_ROUTES). */
export function registeredUrls(): string[] {
  return allUrls();
}
