import { useEffect, useState } from "react";
import { ApiError, apiRequest } from "./api-client";
import { onAuthChange, type AuthUser } from "./auth-storage";
import type { PropertyKind } from "@hotelos/shared";

/**
 * Active-property context shared by every back-office screen.
 *
 * Historically each screen hardcoded `const PROPERTY_ID = "prop_123"`. The
 * helpers here replace those literals with a single source of truth backed by
 * localStorage so the property switcher can repoint every dashboard at the
 * selected property without a rebuild.
 *
 * Screens read the value at module-evaluation time, so switching properties
 * triggers a full page reload to guarantee every screen picks up the new id.
 *
 * The stored selection is validated against the user's real property list on
 * login (see ensureActiveProperty, driven by AuthGate in App.tsx): a user whose
 * stored id is not in their list — or who has nothing stored and would fall
 * back to the demo default — is repointed before the shell mounts, so the API
 * tenancy guard never answers 404 "Propiedad no encontrada." for the shell.
 */

const PROPERTY_KEY = "hotelos-active-property";
const ORG_KEY = "hotelos-active-org";
const NAME_KEY = "hotelos-active-property-name";

export const DEFAULT_PROPERTY_ID = "prop_123";
export const DEFAULT_ORGANIZATION_ID = "org_123";
export const DEFAULT_PROPERTY_NAME = "Anfitorio Madrid Centro";

export const ACTIVE_PROPERTY_EVENT = "hotelos-active-property-changed";

/**
 * Fired (by useApiData) when the API answers the opaque tenancy 404 for a
 * request scoped to the active property. The shell listens and re-validates
 * the selection (see ensureActiveProperty); if it is still listed for the
 * user it shows a "Selecciona otra propiedad" notice instead of N red cards.
 */
export const ACTIVE_PROPERTY_INVALID_EVENT = "hotelos-active-property-invalid";

/** Asks the mounted property switcher (Cocoa toolbar of the shell) to open. */
export const OPEN_PROPERTY_SWITCHER_EVENT = "hotelos-open-property-switcher";

/** Message of the opaque tenancy 404 emitted by the API preHandler (server.ts grantPropertyAccess). */
export const PROPERTY_NOT_FOUND_MESSAGE = "Propiedad no encontrada.";

export type ActiveProperty = {
  propertyId: string;
  organizationId: string;
  propertyName: string;
};

/** Row shape of GET /users/me/properties (server.ts listSwitchableProperties). */
export type SwitchableProperty = {
  id: string;
  name: string;
  organizationId: string;
  organizationName?: string;
  municipality?: string | null;
  province?: string | null;
  status?: string | null;
  // Tanda 6b (additive): centre kind and code plus its sociedad, for the grouped switcher and the finance scope.
  kind?: PropertyKind;
  code?: string | null;
  legalEntityId?: string | null;
  legalEntityName?: string | null;
};

function readStorage(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function getActivePropertyId(): string {
  return readStorage(PROPERTY_KEY, DEFAULT_PROPERTY_ID);
}

export function getActiveOrganizationId(): string {
  return readStorage(ORG_KEY, DEFAULT_ORGANIZATION_ID);
}

export function getActivePropertyName(): string {
  return readStorage(NAME_KEY, DEFAULT_PROPERTY_NAME);
}

export function getActiveProperty(): ActiveProperty {
  return {
    propertyId: getActivePropertyId(),
    organizationId: getActiveOrganizationId(),
    propertyName: getActivePropertyName()
  };
}

/**
 * Persist the selection silently: no event, no reload. Returns whether the
 * property id actually reached storage (false in private mode / quota
 * failures), so callers that plan a reload can avoid a reload loop.
 */
export function writeActiveProperty(next: ActiveProperty): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(PROPERTY_KEY, next.propertyId);
    window.localStorage.setItem(ORG_KEY, next.organizationId);
    window.localStorage.setItem(NAME_KEY, next.propertyName);
  } catch {
    return false;
  }
  return getActivePropertyId() === next.propertyId;
}

/**
 * Persist the selected property and reload so every screen re-evaluates its
 * module-level PROPERTY_ID/ORGANIZATION_ID against the new value.
 */
export function setActiveProperty(next: ActiveProperty): void {
  if (typeof window === "undefined") return;
  const current = getActiveProperty();
  if (
    current.propertyId === next.propertyId &&
    current.organizationId === next.organizationId &&
    current.propertyName === next.propertyName
  ) {
    return;
  }
  writeActiveProperty(next);
  window.dispatchEvent(new CustomEvent<ActiveProperty>(ACTIVE_PROPERTY_EVENT, { detail: next }));
  // Hard reload so module-level constants across all screens pick up the change.
  window.location.reload();
}

// --- Switchable properties (memoized) ---------------------------------------

let switchablePromise: Promise<SwitchableProperty[]> | null = null;

/** Drop the memoized list so the next loadSwitchableProperties() refetches. */
export function invalidateSwitchableProperties(): void {
  switchablePromise = null;
}

/**
 * GET /users/me/properties, memoized per session so the AuthGate validation
 * and the property switcher(s) share a single request. Failures are never
 * memoized: the next caller retries.
 */
export function loadSwitchableProperties(options: { refresh?: boolean } = {}): Promise<SwitchableProperty[]> {
  if (options.refresh) switchablePromise = null;
  if (!switchablePromise) {
    const request = apiRequest<unknown>("/users/me/properties").then((payload) => {
      if (!Array.isArray(payload)) {
        throw new Error("Respuesta inesperada de /users/me/properties: se esperaba una lista.");
      }
      return payload as SwitchableProperty[];
    });
    request.catch(() => {
      if (switchablePromise === request) switchablePromise = null;
    });
    switchablePromise = request;
  }
  return switchablePromise;
}

// The memoized list belongs to the logged-in user: drop it on login/logout so
// a second user in the same browser never sees the previous user's list.
if (typeof window !== "undefined") {
  onAuthChange(() => invalidateSwitchableProperties());
}

// --- Validation against the user's list -------------------------------------

export type EnsureActivePropertyResult = {
  /** propertyId/organizationId in storage changed: the caller must reload. */
  changed: boolean;
  /** The user has no switchable property at all (nothing was written). */
  empty: boolean;
  /** false when the list could not be loaded and the stored value was kept as-is. */
  verified: boolean;
};

/**
 * Make sure the persisted active property is one the user can actually use.
 *
 * - stored id in the list → keep it (a platform admin keeps their last
 *   selection across orgs); org/name are resynced from the row.
 * - otherwise → user.propertyId (session default) if listed, else the first
 *   row.
 * - empty list → report `empty`; nothing is written, so the caller shows a
 *   "sin propiedades" state instead of falling back to the demo default.
 * - list unavailable (network/5xx) → keep the stored value, never block login.
 *
 * Writes silently (no event/reload); `changed` tells the caller to reload
 * because screens read the id at module-evaluation time.
 */
export async function ensureActiveProperty(
  user: AuthUser,
  options: { refresh?: boolean } = {}
): Promise<EnsureActivePropertyResult> {
  let list: SwitchableProperty[];
  try {
    list = await loadSwitchableProperties(options);
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[activeProperty] Could not verify the active property; keeping the stored selection.", err);
    }
    return { changed: false, empty: false, verified: false };
  }
  if (list.length === 0) {
    return { changed: false, empty: true, verified: true };
  }

  const stored = getActiveProperty();
  const target =
    list.find((row) => row.id === stored.propertyId) ??
    list.find((row) => row.id === user.propertyId) ??
    list[0];
  const next: ActiveProperty = {
    propertyId: target.id,
    organizationId: target.organizationId,
    propertyName: target.name
  };
  const scopeChanged = next.propertyId !== stored.propertyId || next.organizationId !== stored.organizationId;
  const drifted = scopeChanged || next.propertyName !== stored.propertyName;
  if (!drifted) {
    return { changed: false, empty: false, verified: true };
  }
  const persisted = writeActiveProperty(next);
  // Reloading only helps when the new scope actually reached storage;
  // otherwise the module-level constants would read the same stale value
  // after the reload and we would loop.
  return { changed: scopeChanged && persisted, empty: false, verified: true };
}

/** True for the opaque tenancy 404 the API returns for a foreign/unknown property. */
export function isPropertyNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.message === PROPERTY_NOT_FOUND_MESSAGE;
}

/** Notify the shell that a request scoped to the active property got the tenancy 404. */
export function reportActivePropertyInvalid(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ACTIVE_PROPERTY_INVALID_EVENT));
}

/** Ask the mounted property switcher to open its listbox. */
export function openPropertySwitcher(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_PROPERTY_SWITCHER_EVENT));
}

/**
 * React hook that returns the active property and stays in sync with changes
 * dispatched from any other component in the same tab.
 */
export function useActiveProperty(): ActiveProperty {
  const [value, setValue] = useState<ActiveProperty>(() => getActiveProperty());

  useEffect(() => {
    function onChange() {
      setValue(getActiveProperty());
    }
    window.addEventListener(ACTIVE_PROPERTY_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(ACTIVE_PROPERTY_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return value;
}
