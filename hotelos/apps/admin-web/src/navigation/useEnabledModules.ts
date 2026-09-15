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
//     `useNavGate` shares the simulation (§8).
// The stored session carries the last role snapshot (usersApi.persistSnapshot),
// so after a reload the tokens are known synchronously and only the module
// list is awaited. A profile that belongs to another user (the demo fallback
// before the login, or the previous session) is never trusted.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLE_PERMISSION_MAP } from "@hotelos/shared";
import { getActivePropertyId } from "../services/activeProperty";
import { getUser, onAuthChange } from "../services/auth-storage";
import { ENABLED_MODULES_CHANGED_EVENT, fetchEnabledModules, isModulesForbidden } from "../services/modulesApi";
import { getSessionRoleSnapshot, useCurrentUserProfile, templateKeysForProperty } from "../services/usersApi";
import { createForbiddenRegistry, type ForbiddenRegistry } from "./modules-forbidden";
import { landingFor, type LandingTarget } from "./nav-tree";
import { canSee, moduleAllows, resolveRoleTokens, type NavGate, type RoleTemplateKey, type RoleToken } from "./role-tokens";
import { applyViewAs, useViewAs } from "./view-as";
import { useIsMobileViewport } from "./viewport";

export { ENABLED_MODULES_CHANGED_EVENT, fetchEnabledModules, invalidateEnabledModules } from "../services/modulesApi";

const EMPTY: string[] = [];

/** Permission that unlocks «Activar módulo» on module-gated entries (§6.3). */
export const ENABLE_MODULES_PERMISSION = "modules.enable";

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
    const grantedPermissions = ownProfile ? ownProfile.grantedPermissions : snapshot.grantedPermissions;
    const known = ownProfile !== null || snapshot.known;
    const resolved = resolveRoleTokens({
      templateKeys,
      isPlatformAdmin,
      grantedPermissions,
      templatePermissions: ROLE_PERMISSION_MAP
    });
    return {
      tokens: resolved.tokens,
      templateKey: resolved.templateKey,
      isPlatformAdmin,
      grantedPermissions,
      canEnableModules: (grantedPermissions ?? []).includes(ENABLE_MODULES_PERMISSION),
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
  /** Token being simulated by the platform administrator (§8), or null. */
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
        { tokens: roles.tokens, templateKey: roles.templateKey, isPlatformAdmin: roles.isPlatformAdmin, canEnableModules: roles.canEnableModules },
        viewAsToken
      ),
    [roles.tokens, roles.templateKey, roles.isPlatformAdmin, roles.canEnableModules, viewAsToken]
  );
  const { tokens, realTokens, templateKey, canEnableModules, viewAs } = simulated;

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
