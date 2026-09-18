import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

// Tanda 5 · L1b · lote sidebar: the menu is rendered from the navigation tree
// (nav-tree.generated.json) filtered by the role templates of GET /users/me
// and the enabled modules of the active property. This contract pins what
// the rewrite removed (persona views, placeholder flags, module spreads, the
// route→screen map) and the hooks the shell, the guide and the tab containers
// rely on.
//
// SCOPE (code-review#8): this file is a STRUCTURAL contract (readFileSync +
// regex over the sources, like every tests/*-contract.test.mjs): it fails
// when a module, hook or wiring disappears, not when its logic is wrong.
// Behaviour lives in apps/admin-web/src/navigation/__tests__ (sidebar-menu:
// menuCategories/landingFor/flatMenuEntries; nav-tree; role-tokens). Still
// WITHOUT behavioural coverage after L1c: view-as.ts `applyViewAs` and the
// App.tsx shell helpers (routeFromLocation / syncLocation /
// resolveScreenTarget / sessionLanding) — handoff to the admin-web-nav lot:
// extract them to a pure module and test them in routes/__tests__.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const sidebar = read("apps/admin-web/src/navigation/Sidebar.tsx");
const shellSheet = read("apps/admin-web/src/styles/cocoa-22-shell.css");
const navTree = read("apps/admin-web/src/navigation/nav-tree.ts");
const roleTokens = read("apps/admin-web/src/navigation/role-tokens.ts");
const gateHook = read("apps/admin-web/src/navigation/useEnabledModules.ts");
const viewAs = read("apps/admin-web/src/navigation/view-as.ts");
const devMode = read("apps/admin-web/src/navigation/dev-mode.ts");
const navItemTabs = read("apps/admin-web/src/screens/tabs/NavItemTabs.tsx");
const commandPalette = read("apps/admin-web/src/components/CommandPalette.tsx");
const guideProvider = read("apps/admin-web/src/components/guide/GuideProvider.tsx");
const helpCenter = read("apps/admin-web/src/components/guide/HelpCenter.tsx");
const authStorage = read("apps/admin-web/src/services/auth-storage.ts");
const usersApi = read("apps/admin-web/src/services/usersApi.ts");
const modulesApi = read("apps/admin-web/src/services/modulesApi.ts");
const moduleManager = read("apps/admin-web/src/screens/ModuleManager.tsx");
const generated = JSON.parse(read("apps/admin-web/src/navigation/nav-tree.generated.json"));

describe("Sidebar (L1b) · rendered from the navigation tree", () => {
  it("reads the menu from nav-tree.ts and the gate from useEnabledModules.ts", () => {
    assert.match(sidebar, /menuCategories\(/);
    assert.match(sidebar, /from "\.\/nav-tree"/);
    assert.match(sidebar, /useNavGate\(\)/);
    assert.match(sidebar, /from "\.\/useEnabledModules"/);
    assert.match(sidebar, /landingFor\(/);
    assert.match(sidebar, /MOBILE_BREAKPOINT_PX/);
  });

  it("keeps no hand-written tree: no persona views, no placeholder flags, no module spreads, no route map", () => {
    assert.doesNotMatch(sidebar, /getModuleRouteItems/);
    assert.doesNotMatch(sidebar, /adminRouteScreenMap/);
    assert.doesNotMatch(sidebar, /placeholder\s*:\s*true/);
    assert.doesNotMatch(sidebar, /function dedupe\(/);
    assert.doesNotMatch(sidebar, /HONEST_PLACEHOLDER_SCREENS/);
    assert.doesNotMatch(sidebar, /from "\.\/roles"/);
    assert.doesNotMatch(sidebar, /hotelos\.role\.v1/);
    assert.doesNotMatch(sidebar, /R_(RECEPTION|OPS|ASSET|FRONT|MGMT|ADMIN_ONLY)\b/);
    assert.doesNotMatch(sidebar, /screen:\s*"[A-Z][A-Za-z0-9]*"/, "no literal screen keys: labels and keys come from the JSON");
    assert.doesNotMatch(sidebar, /Próximamente|Proximamente/i);
  });

  it("paints «Activar módulo», «Ver como…» for whoever manages users in the scope (Tanda 8a: gate.canViewAs), the dev group and the no-role notice", () => {
    assert.match(sidebar, /ACTIONS\.enableModule/);
    assert.match(sidebar, /enableModuleTarget\(/);
    assert.match(sidebar, /visibility === "locked"/);
    // Corrector 8a (FX-12): the select is painted only with at least one token to simulate.
    assert.match(sidebar, /gate\.canViewAs && viewAsOptions\.length > 0 \?/);
    assert.match(sidebar, /Ver como…/);
    assert.match(sidebar, /Viendo como/);
    // Dev mode is reactive and owned by navigation/dev-mode.ts (L1c): the Sidebar only consumes the hook.
    assert.match(sidebar, /import \{ useDevMode \} from "\.\/dev-mode"/);
    assert.match(sidebar, /const devMode = useDevMode\(\)/);
    assert.match(devMode, /export function useDevMode\(\): boolean/);
    assert.match(devMode, /import \{ DEV_MODE_QUERY_PARAM, DEV_MODE_STORAGE_KEY, isDevModeEnabled \} from "\.\/nav-tree"/);
    assert.match(sidebar, /UI_STATES\.noRole/);
    assert.match(sidebar, /CocoaSkeleton|c22-skeleton/);
    assert.doesNotMatch(sidebar, /localStorage\.(setItem|getItem)/, "«Ver como…» lives in memory (view-as.ts); group toggles go through nav-preferences.ts");
  });

  it("«Ver como…» is applied by the gate (view-as.ts): the Sidebar feeds gate.tokens to menuCategories and never re-derives them (code-review#8 repro)", () => {
    // Pure gate transform: only the platform administrator simulates; a simulation
    // replaces the tokens, drops the landing template and switches «Activar módulo» off.
    assert.match(viewAs, /export function applyViewAs\(gate: ViewAsGateInput, viewAs: RoleToken \| null\): ViewAsGateResult/);
    // Tanda 8a (design §5.3): whoever manages users in the active scope simulates (`canViewAs`), not only the platform administrator.
    assert.match(viewAs, /if \(!gate\.canViewAs \|\| !viewAs\) return \{ \.\.\.gate, viewAs: null, realTokens: gate\.tokens \};/);
    assert.match(viewAs, /tokens: \[viewAs\],\s*templateKey: null,\s*isPlatformAdmin: gate\.isPlatformAdmin,\s*canEnableModules: false,/);
    assert.match(viewAs, /export function useViewAs\(\): RoleToken \| null/);
    assert.doesNotMatch(viewAs, /(localStorage|sessionStorage)\s*\./, "the simulated token lives in memory only (no storage calls)");
    // «rango ≤ propio»: the tokens offered are capped by the rank of the templates held (ROLE_LEVEL_RANK of @hotelos/shared,
    // evaluated in useEnabledModules.ts — never in role-tokens.ts); the platform administrator gets every hotel token.
    assert.match(viewAs, /export function viewAsTokensFor\(/);
    assert.match(viewAs, /maxViewAsRank: number \| null;/);
    assert.match(viewAs, /tokenMinRank\(token, ranks\) <= max/);
    assert.match(gateHook, /canViewAs: canViewAsFor\(isPlatformAdmin, grantedPermissions\)/);
    assert.match(gateHook, /maxViewAsRank: maxTemplateRank\(templateKeys\)/);
    assert.match(gateHook, /VIEW_AS_PERMISSIONS: readonly string\[\] = \["users\.assign", "roles\.manage"\]/);
    assert.match(gateHook, /ROLE_LEVEL_RANK\[ROLE_TEMPLATE_LEVEL\[key\]\]/);
    assert.match(sidebar, /viewAsTokensFor\(\{ canViewAs: gate\.canViewAs, isPlatformAdmin: gate\.isPlatformAdmin, maxViewAsRank: gate\.maxViewAsRank \}, TEMPLATE_RANKS\)/);
    assert.match(sidebar, /Viendo como \{ROLE_TOKEN_LABELS\[gate\.viewAs\]\} · solo menú/);
    assert.doesNotMatch(roleTokens, /canViewAs|maxViewAsRank|users\.assign/, "the «Ver como…» condition never lives in role-tokens.ts");
    // The gate hook applies it once for every consumer (Sidebar, ⌘K, tab containers, guide).
    assert.match(gateHook, /import \{ applyViewAs, useViewAs \} from "\.\/view-as"/);
    assert.match(gateHook, /applyViewAs\(/);
    assert.match(gateHook, /viewAs: RoleToken \| null;/);
    // The Sidebar renders the simulated gate as-is: no local viewAs state, no token substitution of its own.
    assert.match(sidebar, /const simulating = gate\.viewAs !== null;\s*const tokens = gate\.tokens;/);
    assert.match(sidebar, /menuCategories\(tokens, gate\.modules, \{ canEnableModules: gate\.canEnableModules, devMode \}\)/);
    assert.match(sidebar, /setViewAs\(event\.target\.value as RoleToken \| ""\)/);
    assert.match(sidebar, /setViewAs\(""\)/);
    assert.doesNotMatch(sidebar, /useState<RoleToken \| "">/, "no local viewAs state: the gate owns the simulation");
    assert.doesNotMatch(sidebar, /\[viewAs as RoleToken\]/, "the L1b in-component substitution is gone");
  });

  it("preserves the chrome hooks and the shell contract", () => {
    assert.match(sidebar, /data-tour="sidebar"/);
    assert.match(sidebar, /aria-label="Navegación del Back Office"/);
    assert.match(sidebar, /export function Sidebar\(props: SidebarProps\)/);
    assert.match(sidebar, /activeScreen: string;\s*onSelect: \(screen: string\) => void;\s*open\?: boolean;\s*onClose\?: \(\) => void;/);
    assert.match(sidebar, /data-nav-url=\{item\.url\}/);
  });
});

describe("Navigation tree helpers used by the sidebar", () => {
  it("nav-tree.ts exposes the L1b menu model", () => {
    for (const name of ["menuCategories", "countMenu", "activeMenuItemFor", "screenKeyForUrl", "landingFor", "flatMenuEntries", "enableModuleTarget", "menuItemMatches"]) {
      assert.match(navTree, new RegExp(`export function ${name}\\(`), `${name} missing`);
    }
    assert.match(navTree, /DEV_CATEGORY_KEY = "desarrollo"/);
  });

  it("role-tokens.ts resolves a session into tokens (templates first, admin flag, permission fallback for custom roles)", () => {
    assert.match(roleTokens, /export function resolveRoleTokens\(/);
    assert.match(roleTokens, /export function templatesCoveredByPermissions\(/);
    assert.match(roleTokens, /export function roleAllowsEveryone\(/);
    assert.doesNotMatch(roleTokens, /from "@hotelos\/shared"/, "stays free of runtime deps on the shared package");
  });

  it("the tree keeps the closing criteria: 9 categories, ≤ 12 items, every item with a URL, dev-only under /desarrollo", () => {
    assert.equal(generated.categories.length, 9);
    for (const category of generated.categories) {
      assert.ok(category.items.length <= 12, `${category.key}: ${category.items.length}`);
      for (const item of category.items) assert.match(item.url, /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/);
    }
    for (const screen of generated.devOnly) assert.match(screen.url, /^\/desarrollo\//);
  });
});

describe("One gate for the sidebar, the tab containers and the guide", () => {
  it("useEnabledModules.ts derives tokens from GET /users/me templates and modules from the session cache", () => {
    assert.match(gateHook, /export function useEnabledModules\(/);
    assert.match(gateHook, /export function useRoleTokens\(/);
    assert.match(gateHook, /export function useNavGate\(/);
    assert.match(gateHook, /export function useNavAudience\(/);
    assert.match(gateHook, /resolveRoleTokens\(/);
    assert.match(gateHook, /templateKeysForProperty\(/);
    assert.match(gateHook, /ENABLED_MODULES_CHANGED_EVENT/);
    assert.match(gateHook, /ENABLE_MODULES_PERMISSION = "modules\.enable"/);
    assert.doesNotMatch(gateHook, /roleTokensFromPermissions|templateKeyFromPermissions|matchedTemplates/, "the L1a permission heuristic is gone");
  });

  it("the tab containers and ⌘K import the gate from navigation/useEnabledModules.ts (L1c: the screens/tabs re-export is gone)", () => {
    assert.equal(existsSync(new URL("../apps/admin-web/src/screens/tabs/useNavGate.ts", import.meta.url)), false);
    assert.match(navItemTabs, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules"/);
    assert.match(commandPalette, /import \{ useNavGate \} from "\.\.\/navigation\/useEnabledModules"/);
    assert.doesNotMatch(navItemTabs + commandPalette, /screens\/tabs\/useNavGate|from "\.\/useNavGate"/);
  });

  it("the guide reads the same audience as the menu (useNavAudience: tokens + enabled modules); guideRoles.ts is gone", () => {
    assert.equal(existsSync(new URL("../apps/admin-web/src/components/guide/guideRoles.ts", import.meta.url)), false);
    assert.match(guideProvider, /useNavAudience\(\)/);
    assert.match(guideProvider, /tourStepsFor\(activeTour, \{ roleTokens, enabledModules \}\)/);
    assert.match(helpCenter, /useNavAudience\(\)/);
    assert.doesNotMatch(guideProvider + helpCenter, /guideRoleTokens|guideRoles|SIGNATURES|roleTokensFromPermissions/);
    // The role snapshot fields are declared once, on AuthUser (services/auth-storage.ts).
    for (const field of ["isPlatformAdmin?: boolean", "templateKeys?: string[]", "templateKeysByProperty?: Record<string, string[]>", "grantedPermissions?: string[]"]) {
      assert.ok(authStorage.includes(field), `AuthUser lacks ${field}`);
    }
    assert.match(usersApi, /export type SessionRoleSnapshot = Pick<AuthUser,/);
  });

  it("roles.ts (persona views in localStorage hotelos.role.v1) is gone and nothing imports it", () => {
    assert.equal(existsSync(new URL("../apps/admin-web/src/navigation/roles.ts", import.meta.url)), false);
    assert.doesNotMatch(sidebar + navTree + gateHook + guideProvider + helpCenter + usersApi, /navigation\/roles"|from "\.\/roles"/);
    assert.doesNotMatch(sidebar + guideProvider + helpCenter, /hotelos-role-changed|hotelos\.role\.v1/);
  });
});

describe("Shell chrome and routing (L1c · fix:admin-web-nav)", () => {
  const appSource = read("apps/admin-web/src/App.tsx");
  const layout = read("apps/admin-web/src/layouts/BackOfficeLayout.tsx");
  const routes = read("apps/admin-web/src/routes/backoffice.routes.tsx");
  const routeTabs = read("apps/admin-web/src/components/cocoa/CocoaRouteTabs.tsx");
  const navPreferences = read("apps/admin-web/src/navigation/nav-preferences.ts");

  it("App.tsx lands from the real tokens of the active property (useSessionLanding inside the AuthGate), never from the login payload", () => {
    assert.match(gateHook, /export function useSessionLanding\(/);
    assert.match(appSource, /function SessionLandingSync\(/);
    assert.match(appSource, /<AuthGate>\s*<SessionLandingSync onLanding=\{setLanding\} \/>/);
    assert.match(appSource, /kind: "landing"/);
    assert.doesNotMatch(appSource, /sessionLanding\(\)|SessionExtras|user\?\.permissions|extras\.templateKeys/, "code-review#1/#2: the login payload is not a role source");
    assert.match(appSource, /getSessionRoleSnapshot\(\)\.isPlatformAdmin/);
    // A public URL or `/` without a session is left untouched (AuthGate reads /acceso/recuperar-contrasena).
    assert.match(appSource, /return \{ kind: "landing", pathname \};/);
    // The Cocoa overlays unmount with the session (logout closes the notification center).
    assert.match(appSource, /<AuthGate>[\s\S]*<CocoaGlobalProvider commandPaletteHotkey=\{false\}>[\s\S]*<\/AuthGate>/);
  });

  it("the dev mode is ONE reactive source: ?dev=1 persists for the tab and travels with the URLs written by key", () => {
    assert.match(devMode, /DEV_MODE_SESSION_KEY = "anfitorio\.dev\.session"/);
    assert.match(devMode, /export function syncDevModeFromLocation\(/);
    assert.match(navTree, /export function devQueryFrom\(/);
    assert.match(appSource, /syncDevModeFromLocation\(search\)/);
    assert.match(appSource, /storageValue: readDevModeStorage\(\)/);
    assert.match(appSource, /const dev = devQueryFrom\(search\);/);
    assert.match(layout, /path \+ devQueryFrom\(window\.location\.search\)/);
    assert.match(routeTabs, /devQueryFrom\(window\.location\.search\)/);
    assert.match(commandPalette, /const devMode = useDevMode\(\)/);
    assert.doesNotMatch(commandPalette, /readDevStorage|isDevModeEnabled\(/);
  });

  it("legacy ids are read by param and entity, and a 308 never carries the consumed id (code-review#5, browser-roles#14)", () => {
    assert.match(routes, /export const LEGACY_ID_KEYS_BY_PARAM/);
    assert.match(routes, /export function legacyIdKeysFor\(/);
    assert.match(routes, /export function findLegacyId\(/);
    assert.match(routes, /export function stripLegacyId\(/);
    assert.match(routes, /consumed: LegacyIdMatch \| null;/);
    assert.match(appSource, /stripLegacyId\(search, hash, resolution\.consumed\)/);
    assert.match(appSource, /stripLegacyId\(search, hash, legacy\.consumed\)/);
    assert.match(appSource, /findLegacyId\(search, hash, \{ param: firstParam, targetUrl: pattern \}\)/);
  });

  it("the sidebar groups start expanded, remember a collapse per browser and reopen on arrival (browser-roles#6)", () => {
    assert.match(navPreferences, /NAV_GROUPS_STORAGE_KEY = "anfitorio\.nav\.groups"/);
    for (const name of ["isGroupOpen", "togglesOnArrival", "toggleGroup", "readGroupToggles", "writeGroupToggles"]) {
      assert.match(navPreferences, new RegExp(`export function ${name}\\(`), `${name} missing`);
    }
    assert.match(sidebar, /from "\.\/nav-preferences"/);
    assert.match(sidebar, /togglesOnArrival\(prev, activeCategoryKey\)/);
    assert.match(sidebar, /isGroupOpen\(\{ key: category\.key, toggled, searching: q\.length > 0 \}\)/);
    assert.doesNotMatch(sidebar, /category\.key === active\?\.categoryKey/, "the L1b «only the active group is open» rule is gone");
  });

  it("the layout owns the phone chrome: compact toolbar, its own drawer, «Nueva reserva» and the logout URL (browser-roles#2/#12/#16, §11 #5)", () => {
    assert.match(layout, /function CompactToolbar\(/);
    assert.match(layout, /aria-label="Abrir el menú"/);
    assert.match(layout, /aria-controls=\{SIDEBAR_ELEMENT_ID\}/);
    assert.match(sidebar, /export const SIDEBAR_ELEMENT_ID = "c22-sidebar"/);
    assert.match(sidebar, /id=\{SIDEBAR_ELEMENT_ID\}/);
    assert.match(layout, /const compact = useIsCompactViewport\(\);/);
    assert.match(layout, /sidebar=\{compact \? null : <div className="cocoa-sidebar-host">\{sidebar\}<\/div>\}/);
    assert.match(layout, /collapsibleSidebar=\{!compact\}/);
    assert.match(layout, /className=\{`c22-scrim\$\{navOpen \? " open" : ""\}`\}/);
    assert.match(shellSheet, /\.cocoa-shell \.cocoa-sidebar-host \.c22-sidebar \{ position: relative;[^}]*transform: none;/);
    assert.match(layout, /export const NEW_RESERVATION_SCREEN = "ReservationCreate"/);
    assert.match(layout, /function NewReservationButton\(/);
    assert.match(layout, /<PropertySwitcher compact \/>/);
    assert.match(layout, /<UserAvatar compact \/>/);
    assert.match(layout, /export function logoutFromShell\(/);
    assert.match(layout, /window\.history\.replaceState\(null, "", LOGIN_PATH\)/);
    assert.doesNotMatch(layout, /onClick=\{\(\) => \{\s*setOpen\(false\);\s*clearSession\(\);/, "«Cerrar sesión» goes through logoutFromShell");
  });

  it("useEnabledModules remembers a 403 per property and never forces a request per consumer (code-review#9); «Ver como…» is applied once in the gate", () => {
    assert.match(gateHook, /forbiddenModuleLists/);
    assert.match(gateHook, /forbiddenModuleLists\.add\(propertyId\)/);
    assert.match(gateHook, /forbiddenModuleLists\.forget\(propertyId\)/);
    assert.doesNotMatch(gateHook, /force: nonce > 0/);
    assert.match(gateHook, /ownProfile = profile && \(sessionUserId === null \|\| profile\.userId === sessionUserId\)/);
    assert.match(read("apps/admin-web/src/navigation/modules-forbidden.ts"), /export function createForbiddenRegistry\(/);
  });
});

describe("Services behind the gate", () => {
  it("usersApi.ts memoizes GET /users/me and mirrors the role snapshot into the stored session", () => {
    assert.match(usersApi, /apiRequest<unknown>\("\/users\/me"\)/);
    assert.match(usersApi, /export function fetchCurrentUserProfile\(/);
    assert.match(usersApi, /export function useCurrentUserProfile\(/);
    assert.match(usersApi, /export function templateKeysForProperty\(/);
    assert.match(usersApi, /grantedPermissions/);
    assert.match(usersApi, /templateKeysByProperty/);
    assert.match(usersApi, /setSession\(token, \{ \.\.\.user, \.\.\.next \}\)/);
  });

  it("modulesApi.ts owns the enabled-modules cache and invalidates it on enable/disable", () => {
    assert.match(modulesApi, /export function fetchEnabledModules\(/);
    assert.match(modulesApi, /export function invalidateEnabledModules\(/);
    assert.match(modulesApi, /export async function setPropertyModuleState\(/);
    assert.match(modulesApi, /method: "PATCH", body: \{ action \}/);
    assert.match(modulesApi, /ENABLED_MODULES_CHANGED_EVENT = "hotelos-enabled-modules-changed"/);
  });

  it("ModuleManager lists what each module unlocks, warns about in-memory data (§6.2) and accepts #modulo=<code>", () => {
    assert.match(moduleManager, /menuEntriesUnlockedBy\(/);
    assert.match(moduleManager, /module\.menuEntries/);
    assert.match(moduleManager, /setPropertyModuleState\(propertyId, module\.code, nextAction\)/);
    assert.match(moduleManager, /IN_MEMORY_MODULE_CODES/);
    assert.match(moduleManager, /guest_data_crm_loyalty", "reputation_quality", "procurement_inventory"/);
    assert.match(moduleManager, /export function moduleCodeFromHash\(/);
    assert.doesNotMatch(moduleManager, /apiRequest\(/, "writes go through services/modulesApi.ts");
  });
});
