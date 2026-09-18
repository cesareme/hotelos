// ONE access decision for the menu, the router and the tab containers
// (Tanda 8a · L4, design §5.2 «Router = menú»).
//
// Generalises three decisions that used to live apart: `navVisibility` of
// role-tokens.ts (visible · locked · hidden), the no-role branch of
// `menuCategories` (a session without token only opens what every
// authenticated token can open, `roleAllowsEveryone`) and the dev-only guard
// of the router (`isDevRouteAllowed`: dev mode AND the platform administrator).
// The same function now answers for a menu entry, for the URL the router
// resolves and for the screen the shell is about to paint, so nothing can be
// hidden in the menu and still open by URL — or the other way round.
//
// Pure and free of permissions on purpose: the tree carries TOKENS, the API
// carries the permission keys (tests/rbac-nav-contract.test.mjs pins the
// premise «el front NO filtra por permiso»). `modulesKnown` travels with the
// scope so a consumer can tell «module off» from «module list unknown» (403
// on GET /modules): the menu hides both, the router lets the container paint
// its honest «no hemos podido comprobar los módulos» state instead of a 403.

import { moduleAllows, roleAllows, roleAllowsEveryone, type NavGate, type RoleToken } from "./role-tokens";

/** A menu entry, a tab or a dev-only screen of the tree (`devOnly` marks the latter). */
export type AccessEntry = NavGate & { devOnly?: boolean };

export type AccessScope = {
  /** Tokens the consumer filters with (already simulated by «Ver como…»); empty = no role in the property. */
  tokens: readonly RoleToken[];
  /** Enabled module codes of the active property; `[]` while unknown. */
  modules: readonly string[];
  /** False while the module list loads or after a 403 on GET /modules: a module gate then means «unknown», not «off». */
  modulesKnown: boolean;
  /** Real platform-admin flag of the session (never inferred from permissions). */
  isPlatformAdmin: boolean;
  /** `?dev=1` / storage flag of the tab (navigation/dev-mode.ts). */
  devMode: boolean;
  /** The user holds `modules.enable`: a module-gated entry is `locked` (painted dimmed) instead of hidden. */
  canEnableModules: boolean;
};

export type AccessDecisionKind =
  /** Role and module gates pass: the entry is painted and the URL opens. */
  | "visible"
  /** Role gate passes, the module is off and the user may enable modules (§6.3 «Activar módulo»). */
  | "locked"
  /** No token of the session is in `roles` (or, without token, the entry is not for everyone). */
  | "hidden-role"
  /** Role gate passes but no module of `modulesAny` is enabled (or the list is unknown, see `modulesKnown`). */
  | "hidden-module"
  /** Dev-only entry outside dev mode or for someone who is not the platform administrator. */
  | "dev-locked";

/** Decisions that open a screen (the router renders, the menu paints as an entry). */
export const OPEN_DECISIONS: readonly AccessDecisionKind[] = ["visible", "locked"];

/** True when the dev-only group / guard is unlocked: dev mode AND the `admin` token of the session (the platform administrator's, never simulated). */
export function devUnlocked(scope: Pick<AccessScope, "devMode" | "tokens">): boolean {
  return scope.devMode && scope.tokens.includes("admin");
}

/**
 * The decision, in the same order every consumer applies:
 *   1. a dev-only entry needs dev mode and the `admin` token → else `dev-locked`;
 *   2. role gate: with tokens, one of them must be in `roles`; without token
 *      the entry must be open to every authenticated token (§8) → else `hidden-role`;
 *   3. module gate: one code of `modulesAny` enabled → `visible`; otherwise
 *      `locked` for a user who may enable modules, `hidden-module` for the rest.
 */
export function accessDecision(entry: AccessEntry, scope: AccessScope): AccessDecisionKind {
  if (entry.devOnly && !devUnlocked(scope)) return "dev-locked";
  const roleOk = scope.tokens.length === 0 ? roleAllowsEveryone(entry) : roleAllows(entry, scope.tokens);
  if (!roleOk) return "hidden-role";
  if (moduleAllows(entry, scope.modules)) return "visible";
  return scope.canEnableModules ? "locked" : "hidden-module";
}

/**
 * Decision for a tab of an item: the tab only opens when its item does (a tab
 * lives inside the container of its item), so the stricter of both wins —
 * `hidden-role` before `hidden-module` before `locked` before `visible`.
 */
export function tabAccessDecision(item: AccessEntry, tab: AccessEntry, scope: AccessScope): AccessDecisionKind {
  const forItem = accessDecision(item, scope);
  const forTab = accessDecision(tab, scope);
  return SEVERITY[forItem] >= SEVERITY[forTab] ? forItem : forTab;
}

const SEVERITY: Record<AccessDecisionKind, number> = {
  visible: 0,
  locked: 1,
  "hidden-module": 2,
  "hidden-role": 3,
  "dev-locked": 4
};

/** True when the decision opens the entry (`visible` or `locked`). */
export function opensEntry(decision: AccessDecisionKind): boolean {
  return OPEN_DECISIONS.includes(decision);
}
