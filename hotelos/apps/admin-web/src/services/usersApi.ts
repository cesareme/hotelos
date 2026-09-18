// GET /users/me — the signed-in user's profile with the template keys of every
// role they hold, per property (Tanda 5 · L1b · lote sidebar).
//
// The navigation tree derives its role tokens from `properties[].templateKeys`
// of the ACTIVE property (services/activeProperty.ts, not the session
// `activePropertyId`, which is the first assignment of the JWT context) plus
// the `admin` token when `isPlatformAdmin` is true. `grantedPermissions` are
// the real grants of the active property (never the demo union of :3000) and
// gate «Activar módulo» (`modules.enable`) and the custom-role fallback.
//
// The profile is memoized per session. Once loaded, the useful subset is
// written back into the stored session (auth-storage `setSession`) so a reload
// paints the menu synchronously (no skeleton) and every listener of
// `hotelos-auth-changed` (the guide, the toolbar) sees the same tokens. The
// write only happens when the subset actually changed, so it can never loop.

import { useCallback, useEffect, useState } from "react";
import type { UserScopeDto } from "@hotelos/shared";
import { ApiError, apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { getToken, getUser, onAuthChange, setSession, type AuthUser } from "./auth-storage";

export type CurrentUserPropertyRole = {
  id: string;
  name: string;
  /** Shared template the role follows (ROLE_TEMPLATE_KEYS); null = custom role. */
  templateKey: string | null;
};

export type CurrentUserProperty = {
  id: string;
  name: string;
  organizationId: string;
  roles: CurrentUserPropertyRole[];
  /** Distinct template keys of the roles held in this property. */
  templateKeys: string[];
  /** Tanda 8a (H1): keys REALLY granted in this property (union of the assignments covering it); absent on an older API. */
  grantedPermissions?: string[];
};

export type CurrentUserProfile = {
  userId: string;
  email: string | null;
  fullName: string;
  organizationId: string;
  organizationName: string | null;
  /** Property the JWT context is bound to (first assignment); the menu uses the ACTIVE property instead. */
  activePropertyId: string;
  /** Effective permissions of the session (demo union included on the dev API). */
  permissions: string[];
  /** Real grants of the session property (never the demo union): what the menu trusts. */
  grantedPermissions: string[];
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  /** Template keys held in the session property (shortcut of properties[].templateKeys). */
  templateKeys: string[];
  properties: CurrentUserProperty[];
  /** Tanda 8a: scopes of the live assignments (property / group / sociedad / organisation, expanded); absent on an older API. */
  scopes?: UserScopeDto[];
};

/**
 * Subset of the profile persisted next to the session (auth-storage) so the
 * menu, the guide and the toolbar share one source without a request each.
 * The fields are declared once on `AuthUser` (services/auth-storage.ts).
 */
export type SessionRoleSnapshot = Pick<AuthUser, "isPlatformAdmin" | "templateKeysByProperty" | "templateKeys" | "grantedPermissions">;

/** The stored session user; kept as an alias for readers of the snapshot fields. */
export type SessionUser = AuthUser;

/** Fired (on window) when the profile has been (re)loaded; detail = the profile. */
export const CURRENT_USER_PROFILE_EVENT = "hotelos-user-profile-loaded";

const EMPTY_KEYS: string[] = [];

let profilePromise: Promise<CurrentUserProfile> | null = null;
let cachedProfile: CurrentUserProfile | null = null;

function isProfile(value: unknown): value is CurrentUserProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    Array.isArray((value as { properties?: unknown }).properties)
  );
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);

function normalizeProfile(raw: CurrentUserProfile): CurrentUserProfile {
  const properties = (raw.properties ?? []).map((property) => ({
    id: property.id,
    name: property.name,
    organizationId: property.organizationId,
    roles: Array.isArray(property.roles) ? property.roles : [],
    templateKeys: stringList(property.templateKeys),
    ...(Array.isArray(property.grantedPermissions) ? { grantedPermissions: stringList(property.grantedPermissions) } : {})
  }));
  return {
    ...raw,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    grantedPermissions: stringList(raw.grantedPermissions),
    isPlatformAdmin: raw.isPlatformAdmin === true,
    mustChangePassword: raw.mustChangePassword === true,
    templateKeys: stringList(raw.templateKeys),
    properties,
    ...(Array.isArray(raw.scopes) ? { scopes: raw.scopes } : {})
  };
}

/** Template keys the user holds in `propertyId` (falls back to the session property's keys). */
export function templateKeysForProperty(profile: Pick<CurrentUserProfile, "properties" | "templateKeys">, propertyId: string): string[] {
  const property = profile.properties.find((row) => row.id === propertyId);
  return property ? property.templateKeys : profile.templateKeys;
}

/**
 * Tanda 8a (H1): the grants of `propertyId` — `properties[].grantedPermissions`
 * when the API serves them, else the session-property grants (older API).
 */
export function grantedPermissionsForProperty(profile: Pick<CurrentUserProfile, "properties" | "grantedPermissions">, propertyId: string): string[] {
  const property = profile.properties.find((row) => row.id === propertyId);
  return property?.grantedPermissions ?? profile.grantedPermissions;
}

/** Tanda 8a: true with a live assignment of scope organisation or sociedad (the «Sociedad» tab of Usuarios y roles). */
export function hasWideScope(profile: Pick<CurrentUserProfile, "scopes"> | null | undefined): boolean {
  return (profile?.scopes ?? []).some((scope) => scope.scopeType === "organization" || scope.scopeType === "legal_entity");
}

/** The snapshot to persist next to the session for a loaded profile. */
export function sessionSnapshotFor(profile: CurrentUserProfile): Required<SessionRoleSnapshot> {
  const templateKeysByProperty: Record<string, string[]> = {};
  for (const property of profile.properties) templateKeysByProperty[property.id] = [...property.templateKeys];
  return {
    isPlatformAdmin: profile.isPlatformAdmin,
    templateKeysByProperty,
    templateKeys: [...profile.templateKeys],
    // The snapshot keeps the grants of the ACTIVE property (Tanda 8a): what the gate trusts after a reload.
    grantedPermissions: [...grantedPermissionsForProperty(profile, getActivePropertyId())]
  };
}

function sameSnapshot(user: SessionRoleSnapshot, next: Required<SessionRoleSnapshot>): boolean {
  if (user.isPlatformAdmin !== next.isPlatformAdmin) return false;
  if (JSON.stringify(user.templateKeys ?? null) !== JSON.stringify(next.templateKeys)) return false;
  if (JSON.stringify(user.templateKeysByProperty ?? null) !== JSON.stringify(next.templateKeysByProperty)) return false;
  return JSON.stringify(user.grantedPermissions ?? null) === JSON.stringify(next.grantedPermissions);
}

/**
 * Copies the role snapshot into the stored session when it differs. Only for
 * a real login (stored token + user of the same id): the demo fallback of the
 * dev API has no stored session and keeps working from the memoized profile.
 */
function persistSnapshot(profile: CurrentUserProfile): void {
  const token = getToken();
  const user = getUser();
  if (!token || !user || user.userId !== profile.userId) return;
  const next = sessionSnapshotFor(profile);
  if (sameSnapshot(user, next)) return;
  setSession(token, { ...user, ...next });
}

/** Last loaded profile (sync), or null before the first `fetchCurrentUserProfile`. */
export function getCachedCurrentUserProfile(): CurrentUserProfile | null {
  return cachedProfile;
}

export function invalidateCurrentUserProfile(): void {
  profilePromise = null;
  cachedProfile = null;
}

/**
 * GET /users/me memoized per session; `force` refetches (after a role change
 * in Usuarios y roles, for instance). Failures are never memoized.
 */
export function fetchCurrentUserProfile(options: { force?: boolean } = {}): Promise<CurrentUserProfile> {
  if (options.force) profilePromise = null;
  if (!profilePromise) {
    const request = apiRequest<unknown>("/users/me").then((payload) => {
      if (!isProfile(payload)) {
        throw new Error("Respuesta inesperada de /users/me: se esperaba el perfil del usuario.");
      }
      const profile = normalizeProfile(payload);
      cachedProfile = profile;
      persistSnapshot(profile);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent<CurrentUserProfile>(CURRENT_USER_PROFILE_EVENT, { detail: profile }));
      }
      return profile;
    });
    request.catch(() => {
      if (profilePromise === request) profilePromise = null;
    });
    profilePromise = request;
  }
  return profilePromise;
}

// The memoized profile belongs to the logged-in user: drop it on login/logout.
// (setSession from persistSnapshot also fires the event; the next fetch then
// simply reloads the same profile — no loop, because persistSnapshot writes
// nothing when the snapshot is unchanged.)
if (typeof window !== "undefined") {
  onAuthChange(() => {
    const user = getUser();
    if (!user || !cachedProfile || user.userId !== cachedProfile.userId) invalidateCurrentUserProfile();
  });
}

/** Role snapshot readable synchronously: stored session first, then the memoized profile. */
export function getSessionRoleSnapshot(propertyId: string = getActivePropertyId()): {
  templateKeys: string[];
  isPlatformAdmin: boolean;
  grantedPermissions: string[] | null;
  known: boolean;
} {
  const user = getUser();
  if (user && (user.templateKeysByProperty || user.templateKeys || typeof user.isPlatformAdmin === "boolean")) {
    const byProperty = user.templateKeysByProperty?.[propertyId];
    return {
      templateKeys: byProperty ?? user.templateKeys ?? EMPTY_KEYS,
      isPlatformAdmin: user.isPlatformAdmin === true,
      grantedPermissions: user.grantedPermissions ?? null,
      known: Boolean(user.templateKeysByProperty || user.templateKeys)
    };
  }
  if (cachedProfile) {
    return {
      templateKeys: templateKeysForProperty(cachedProfile, propertyId),
      isPlatformAdmin: cachedProfile.isPlatformAdmin,
      grantedPermissions: grantedPermissionsForProperty(cachedProfile, propertyId),
      known: true
    };
  }
  return { templateKeys: EMPTY_KEYS, isPlatformAdmin: false, grantedPermissions: null, known: false };
}

export type CurrentUserProfileState = {
  profile: CurrentUserProfile | null;
  loading: boolean;
  /** Message of a failure other than "endpoint not served" (404 on an API without GET /users/me). */
  error: string | null;
  /** True when the API does not serve GET /users/me yet (older process): callers fall back to the session. */
  unavailable: boolean;
  refresh: () => void;
};

/** React hook over `fetchCurrentUserProfile`, re-fetching on login/logout. */
export function useCurrentUserProfile(): CurrentUserProfileState {
  const [profile, setProfile] = useState<CurrentUserProfile | null>(() => cachedProfile);
  const [loading, setLoading] = useState<boolean>(() => cachedProfile === null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchCurrentUserProfile({ force: nonce > 0 })
      .then((next) => {
        if (!alive) return;
        setProfile(next);
        setError(null);
        setUnavailable(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) {
          setUnavailable(true);
          setError(null);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  // Login/logout only: the snapshot write of persistSnapshot also fires the
  // auth event, but for the same user id, so it must not trigger a refetch.
  useEffect(
    () =>
      onAuthChange(() => {
        const nextId = getUser()?.userId ?? null;
        if (nextId !== (cachedProfile?.userId ?? null)) setNonce((value) => value + 1);
      }),
    []
  );

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { profile, loading, error, unavailable, refresh };
}
