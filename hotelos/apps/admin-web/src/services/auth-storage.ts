// Auth session storage backed by localStorage. Centralises read/write of the
// JWT + user profile so the rest of the app (api-client, AuthGate, TopBar)
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
  permissions?: string[];
  email?: string;
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
