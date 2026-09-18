// Role/module gate of the navigation (Tanda 5 · L1b · lote sidebar; L1c).
//
// ONE source for the Sidebar, ⌘K, the tab containers, the guide and the
// session landing of App.tsx:
//   - role tokens: `resolveRoleTokens` over the template keys of the ACTIVE
//     property from GET /users/me (services/usersApi.ts) plus `admin` when the
//     profile says `isPlatformAdmin`; custom roles without template fall back
//     to the templates fully covered by `grantedPermissions` (never the demo
//     union of :3000); nothing known → no token (UI_STATES.noRole);
//   - enabled modules: GET /backoffice/properties/:id/modules through the
//     session cache of services/modulesApi.ts; `[]` while loading (and after a
//     403 for users without modules.read), so a module-gated entry is hidden
//     until the answer arrives and never opens a 403; ModuleManager invalidates
//     the cache (ENABLED_MODULES_CHANGED_EVENT) and every consumer refetches
//     ONE shared request (the invalidation already dropped the cache entry, so
//     no consumer forces its own); a 403 is remembered per property for the
//     session (`forbiddenModuleLists`) so a container that mounts later does
//     not repeat the request;
//   - «Ver como…» (navigation/view-as.ts): applied here, so every consumer of
//     `useNavGate` shares the simulation (§8). Tanda 8a (design §5.3): offered
//     to whoever manages users in the active scope — the platform administrator
//     or a user whose real grants in the ACTIVE property include `users.assign`
//     or `roles.manage` (`canViewAs`) — and capped by the rank of the templates
//     they hold (`maxViewAsRank`: ROLE_LEVEL_RANK of ROLE_TEMPLATE_LEVEL, both
//     from @hotelos/shared). Evaluated HERE, never in role-tokens.ts, which only
//     reads `grantedPermissions` for the custom-role fallback.
// The stored session carries the last role snapshot (usersApi.persistSnapshot),
// so after a reload the tokens are known synchronously and only the module
// list is awaited. A profile that belongs to another user (the demo fallback
// before the login, or the previous session) is never trusted.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLE_LEVEL_RANK, ROLE_PERMISSION_MAP, ROLE_TEMPLATE_LEVEL, type RoleKey } from "@hotelos/shared";
import { getActivePropertyId } from "../services/activeProperty";
import { getUser, onAuthChange } from "../services/auth-storage";
import { ENABLED_MODULES_CHANGED_EVENT, fetchEnabledModules, isModulesForbidden } from "../services/modulesApi";
import { getSessionRoleSnapshot, grantedPermissionsForProperty, useCurrentUserProfile, templateKeysForProperty } from "../services/usersApi";
import { createForbiddenRegistry, type ForbiddenRegistry } from "./modules-forbidden";
import { landingFor, type LandingTarget } from "./nav-tree";
import { ROLE_TOKEN_PRIORITY, canSee, moduleAllows, resolveRoleTokens, roleTokensFromTemplates, templatesCoveredByPermissions, type NavGate, type RoleTemplateKey, type RoleToken } from "./role-tokens";
import { applyViewAs, useViewAs } from "./view-as";
import type { TemplateRankMap } from "./view-as";
import { useIsMobileViewport } from "./viewport";

export { ENABLED_MODULES_CHANGED_EVENT, fetchEnabledModules, invalidateEnabledModules } from "../services/modulesApi";

const EMPTY: string[] = [];

/** Permission that unlocks «Activar módulo» on module-gated entries (§6.3). */
export const ENABLE_MODULES_PERMISSION = "modules.enable";

/** Permissions that unlock «Ver como…» in the active scope (design §5.3): assigning roles or managing them. */
export const VIEW_AS_PERMISSIONS: readonly string[] = ["users.assign", "roles.manage"];

/** Template → ROLE_LEVEL_RANK (N1 = 1 … ownership = 6), for the «rango ≤ propio» cap of «Ver como…». */
export const TEMPLATE_RANKS: TemplateRankMap = Object.fromEntries(
  (Object.keys(ROLE_TEMPLATE_LEVEL) as RoleKey[]).map((key) => [key, ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[key]]])
);

/** Highest rank among the templates held (null when none is a known template). */
export function maxTemplateRank(templateKeys: readonly (string | null | undefined)[]): number | null {
  let max: number | null = null;
  for (const key of templateKeys) {
    const rank = typeof key === "string" ? TEMPLATE_RANKS[key.trim().toLowerCase()] : undefined;
    if (typeof rank === "number" && (max === null || rank > max)) max = rank;
  }
  return max;
}

/**
 * Transitional widening of the `owner` template (design §8.2 D1: Carmen =
 * Propiedad + Dirección general; corrector 8a · FSOD-03). A legacy Owner
 * (user_property_roles ×N, the 222-key role the `rbac:migrate-assignments
 * --general-manager` backfill has not split yet) maps to the `propiedad` token
 * alone (5 menu items) although the API keeps granting every key. While the
 * real grants of the property FULLY cover the `general_manager` template, the
 * tokens of every template those grants cover are added — never a template
 * the grants do not cover, so nothing shown answers 403. A narrowed Owner
 * (64 keys, template v2) covers no other template and stays on `propiedad`.
 * Pure; the platform `admin` token is never derived here.
 */
export function widenOwnerTokens(input: { tokens: readonly RoleToken[]; templateKeys: readonly (string | null | undefined)[]; grantedPermissions: readonly string[] | null | undefined }): RoleToken[] {
  const holdsOwner = input.templateKeys.some((key) => typeof key === "string" && key.trim().toLowerCase() === "owner");
  if (!holdsOwner) return [...input.tokens];
  const covered = templatesCoveredByPermissions(input.grantedPermissions, ROLE_PERMISSION_MAP);
  if (!covered.includes("general_manager")) return [...input.tokens];
  const union = new Set<RoleToken>([...input.tokens, ...roleTokensFromTemplates(covered)]);
  return ROLE_TOKEN_PRIORITY.filter((token) => union.has(token));
}

/** Pure: whether the session may simulate the menu of another role (platform admin, or `users.assign` / `roles.manage` in the property). */
export function canViewAsFor(isPlatformAdmin: boolean, grantedPermissions: readonly string[] | null | undefined): boolean {
  if (isPlatformAdmin) return true;
  const granted = grantedPermissions ?? [];
  return VIEW_AS_PERMISSIONS.some((permission) => granted.includes(permission));
}

/** Session registry of the 403 answers of GET /modules: a later mount asks nothing again (navigation/modules-forbidden.ts). */
export const forbiddenModuleLists: ForbiddenRegistry = createForbiddenRegistry();

// A login/logout may change who can read the list: forget every 403.
if (typeof window !== "undefined") {
  onAuthChange(() => forbiddenModuleLists.forget());
}

export type EnabledModulesState = {
  /** Enabled module codes; `[]` while loading or when the list is not readable. */
  modules: string[];
  loading: boolean;
  /** Failure other than 403 (network, 5xx); consumers still render with modules = []. */
  error: string | null;
  refresh: () => void;
};

/** Enabled module codes of a property, shared through the session cache and refetched on ModuleManager changes. */
export function useEnabledModules(propertyId: string = getActivePropertyId()): EnabledModulesState {
  const [modules, setModules] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    if (forbiddenModuleLists.has(propertyId)) {
      // Remembered 403: the list is unknown for this user, no request.
      setModules(EMPTY);
      return undefined;
    }
    // No `force`: an invalidation (ModuleManager, refresh) already dropped the
    // cache entry, so the first consumer refetches and the rest share it.
    fetchEnabledModules(propertyId)
      .then((list) => {
        if (alive) setModules(list);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setModules(EMPTY);
        if (isModulesForbidden(err)) {
          forbiddenModuleLists.add(propertyId);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [propertyId, nonce]);

  useEffect(() => {
    function onChanged(event: Event) {
      const detail = (event as CustomEvent<{ propertyId?: string } | undefined>).detail;
      if (detail?.propertyId && detail.propertyId !== propertyId) return;
      forbiddenModuleLists.forget(propertyId);
      setNonce((value) => value + 1);
    }
    window.addEventListener(ENABLED_MODULES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ENABLED_MODULES_CHANGED_EVENT, onChanged);
  }, [propertyId]);

  // An explicit retry asks again, even after a remembered 403.
  const refresh = useCallback(() => {
    forbiddenModuleLists.forget(propertyId);
    setNonce((value) => value + 1);
  }, [propertyId]);
  return { modules: modules ?? EMPTY, loading: modules === null, error, refresh };
}

export type RoleTokensState = {
  tokens: RoleToken[];
  /** Most privileged template held (owner/manager decide the landing tab); null for admin-only or custom roles. */
  templateKey: RoleTemplateKey | null;
  isPlatformAdmin: boolean;
  /** Real grants of the active property (never the demo union); null until the profile is known. */
  grantedPermissions: string[] | null;
  /** The user may enable modules: module-gated entries are painted dimmed with «Activar módulo». */
  canEnableModules: boolean;
  /** Tanda 8a: the user manages users in the active scope (platform admin, `users.assign` or `roles.manage`): «Ver como…» is offered. */
  canViewAs: boolean;
  /** Tanda 8a: highest ROLE_LEVEL_RANK of the templates held in the property (null when unknown); caps the tokens «Ver como…» offers. */
  maxViewAsRank: number | null;
  /** The tokens are known (session snapshot or profile); false only on the very first load. */
  known: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** Role tokens of the session for `propertyId`, from GET /users/me (with the stored snapshot as a synchronous start). */
export function useRoleTokens(propertyId: string = getActivePropertyId()): RoleTokensState {
  const { profile, loading, error, unavailable, refresh } = useCurrentUserProfile();

  return useMemo(() => {
    // The memoized profile may still belong to the previous session (or to the
    // demo fallback served before the login) while the new one loads: only a
    // profile of the signed-in user counts, the rest waits on the snapshot.
    const sessionUserId = getUser()?.userId ?? null;
    const ownProfile = profile && (sessionUserId === null || profile.userId === sessionUserId) ? profile : null;
    const snapshot = getSessionRoleSnapshot(propertyId);
    const templateKeys = ownProfile ? templateKeysForProperty(ownProfile, propertyId) : snapshot.templateKeys;
    const isPlatformAdmin = ownProfile ? ownProfile.isPlatformAdmin : snapshot.isPlatformAdmin;
    // Tanda 8a (H1): the grants of the ACTIVE property (`properties[].grantedPermissions`), not of the first assignment.
    const grantedPermissions = ownProfile ? grantedPermissionsForProperty(ownProfile, propertyId) : snapshot.grantedPermissions;
    const known = ownProfile !== null || snapshot.known;
    const resolved = resolveRoleTokens({
      templateKeys,
      isPlatformAdmin,
      grantedPermissions,
      templatePermissions: ROLE_PERMISSION_MAP
    });
    // Corrector 8a (FSOD-03): a legacy Owner with the general-manager grants keeps the direccion menu until the D1 backfill.
    const tokens = widenOwnerTokens({ tokens: resolved.tokens, templateKeys, grantedPermissions });
    return {
      tokens,
      templateKey: resolved.templateKey,
      isPlatformAdmin,
      grantedPermissions,
      canEnableModules: (grantedPermissions ?? []).includes(ENABLE_MODULES_PERMISSION),
      canViewAs: canViewAsFor(isPlatformAdmin, grantedPermissions),
      maxViewAsRank: maxTemplateRank(templateKeys),
      known,
      loading: loading && !known,
      error: unavailable ? null : error,
      refresh
    };
  }, [profile, loading, error, unavailable, refresh, propertyId]);
}

export type NavGateState = {
  /** Tokens the consumers filter with (the simulated one during «Ver como…»). */
  tokens: RoleToken[];
  /** Real tokens of the session, untouched by «Ver como…». */
  realTokens: RoleToken[];
  templateKey: string | null;
  /** Enabled module codes; `[]` while loading or when the list is not readable. */
  modules: string[];
  isPlatformAdmin: boolean;
  grantedPermissions: string[] | null;
  canEnableModules: boolean;
  /** Tanda 8a: «Ver como…» is offered (platform admin, or `users.assign` / `roles.manage` in the active property). */
  canViewAs: boolean;
  /** Tanda 8a: rank cap of the tokens «Ver como…» offers (null = unknown / platform admin). */
  maxViewAsRank: number | null;
  /** Token being simulated by «Ver como…» (§8), or null. */
  viewAs: RoleToken | null;
  /** The role tokens are known (session snapshot or profile); false only on the very first load. */
  known: boolean;
  /** Tokens or modules still unknown: paint a skeleton, never a half menu. */
  loading: boolean;
  /** Module list failure other than 403 (network, 5xx); entries still render with modules = []. */
  error: string | null;
  refresh: () => void;
  /** Role/module gate of an entry: with no token only the module gate applies (custom role, §8). */
  isVisible: (gate: NavGate) => boolean;
};

/** Tokens + enabled modules of the active property (with «Ver como…» applied), for the Sidebar, ⌘K, the containers and the guide. */
export function useNavGate(propertyId: string = getActivePropertyId()): NavGateState {
  const roles = useRoleTokens(propertyId);
  const enabled = useEnabledModules(propertyId);
  const viewAsToken = useViewAs();
  const { isPlatformAdmin, grantedPermissions, known } = roles;
  const { modules } = enabled;

  const simulated = useMemo(
    () =>
      applyViewAs(
        {
          tokens: roles.tokens,
          templateKey: roles.templateKey,
          isPlatformAdmin: roles.isPlatformAdmin,
          canEnableModules: roles.canEnableModules,
          canViewAs: roles.canViewAs,
          maxViewAsRank: roles.maxViewAsRank
        },
        viewAsToken
      ),
    [roles.tokens, roles.templateKey, roles.isPlatformAdmin, roles.canEnableModules, roles.canViewAs, roles.maxViewAsRank, viewAsToken]
  );
  const { tokens, realTokens, templateKey, canEnableModules, canViewAs, maxViewAsRank, viewAs } = simulated;

  const isVisible = useCallback(
    (gate: NavGate) => (tokens.length === 0 ? moduleAllows(gate, modules) : canSee(gate, tokens, modules)),
    [tokens, modules]
  );
  const refreshRoles = roles.refresh;
  const refreshModules = enabled.refresh;
  const refresh = useCallback(() => {
    refreshRoles();
    refreshModules();
  }, [refreshRoles, refreshModules]);

  return {
    tokens,
    realTokens,
    templateKey,
    modules,
    isPlatformAdmin,
    grantedPermissions,
    canEnableModules,
    canViewAs,
    maxViewAsRank,
    viewAs,
    known,
    loading: roles.loading || enabled.loading,
    error: enabled.error,
    refresh,
    isVisible
  };
}

export type NavAudience = {
  roleTokens: RoleToken[];
  /** Enabled module codes, or undefined while unknown (module gates are then not applied, see guideContent.tourStepsFor). */
  enabledModules: string[] | undefined;
  loading: boolean;
};

/** Audience for the guide (HelpCenter / GuideProvider → `tourStepsFor`): tokens plus the enabled modules once known. */
export function useNavAudience(propertyId: string = getActivePropertyId()): NavAudience {
  const gate = useNavGate(propertyId);
  return useMemo(
    () => ({ roleTokens: gate.tokens, enabledModules: gate.loading ? undefined : gate.modules, loading: gate.loading }),
    [gate.tokens, gate.modules, gate.loading]
  );
}

/**
 * Landing of the session (§3) for App.tsx: the role home of the REAL tokens
 * of the active property (never the login payload nor the demo union), the
 * mobile tab under MOBILE_BREAKPOINT_PX. `null` while there is no session or
 * the profile of a fresh login is still loading — the shell waits instead of
 * landing on the no-role home.
 */
export function useSessionLanding(propertyId: string = getActivePropertyId()): LandingTarget | null {
  const [userId, setUserId] = useState<string | null>(() => getUser()?.userId ?? null);
  useEffect(() => onAuthChange(() => setUserId(getUser()?.userId ?? null)), []);
  const roles = useRoleTokens(propertyId);
  const mobile = useIsMobileViewport();
  const { tokens, templateKey, loading } = roles;
  return useMemo(() => {
    if (!userId || loading) return null;
    return landingFor(tokens, { mobile, templateKey });
  }, [userId, loading, tokens, templateKey, mobile]);
}
