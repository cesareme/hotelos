// Auth session storage backed by localStorage. Centralises read/write of the
// JWT + user profile so the rest of the app (api-client, AuthGate, the shell)
// can react to login/logout without duplicating storage keys.

const TOKEN_KEY = "hotelos.auth.token";
const USER_KEY = "hotelos.auth.user";
const AUTH_EVENT = "hotelos-auth-changed";

export type AuthUser = {
  userId: string;
  organizationId: string;
  propertyId: string;
  fullName: string;
  deviceId?: string;
  /** Effective permissions of the session (the demo union on the dev API); never a role source. */
  permissions?: string[];
  email?: string;
  // Role snapshot (Tanda 5 · L1c): POST /auth/login sends `isPlatformAdmin`;
  // services/usersApi.ts copies the template keys and the real grants from
  // GET /users/me once the profile loads (`persistSnapshot`). Optional because
  // a session stored before the profile answers only carries the login
  // payload. App.tsx (landing, /desarrollo/* guard), the guide and
  // navigation/useEnabledModules.ts read these fields from this one type.
  /** Platform administrator flag of the session (never inferred from permissions). */
  isPlatformAdmin?: boolean;
  /** Template keys held in the session property (ROLE_TEMPLATE_KEYS order). */
  templateKeys?: string[];
  /** Template keys per property id, so the active property can change without a refetch. */
  templateKeysByProperty?: Record<string, string[]>;
  /** Real grants of the active property (never the demo union): what the menu trusts. */
  grantedPermissions?: string[];
};

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function getToken(): string | null {
  if (!hasWindow()) return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUser(): AuthUser | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    window.dispatchEvent(new CustomEvent(AUTH_EVENT));
  } catch {
    /* storage unavailable */
  }
}

// Deliberately leaves the `hotelos-active-*` keys (services/activeProperty.ts)
// untouched: AuthGate validates the stored selection against the next user's
// property list on login, and a platform admin keeps their last selection
// across sessions.
export function clearSession(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new CustomEvent(AUTH_EVENT));
  } catch {
    /* storage unavailable */
  }
}

export function onAuthChange(callback: () => void): () => void {
  if (!hasWindow()) return () => undefined;
  const handler = () => callback();
  window.addEventListener(AUTH_EVENT, handler);
  // Also react to changes in OTHER tabs (storage event fires only cross-tab).
  const storageHandler = (event: StorageEvent) => {
    if (event.key === TOKEN_KEY || event.key === USER_KEY) callback();
  };
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(AUTH_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
}

export const AUTH_EVENT_NAME = AUTH_EVENT;
