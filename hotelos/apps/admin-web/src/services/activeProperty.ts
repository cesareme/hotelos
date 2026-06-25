import { useEffect, useState } from "react";

/**
 * Active-property context shared by every back-office screen.
 *
 * Historically each screen hardcoded `const PROPERTY_ID = "prop_123"`. The
 * helpers here replace those literals with a single source of truth backed by
 * localStorage so the TopBar property switcher can repoint every dashboard at
 * the selected property (e.g. Hotel Los Tilos / prop_tilos) without a rebuild.
 *
 * Screens read the value at module-evaluation time, so switching properties
 * triggers a full page reload to guarantee every screen picks up the new id.
 */

const PROPERTY_KEY = "hotelos-active-property";
const ORG_KEY = "hotelos-active-org";
const NAME_KEY = "hotelos-active-property-name";

export const DEFAULT_PROPERTY_ID = "prop_123";
export const DEFAULT_ORGANIZATION_ID = "org_123";
export const DEFAULT_PROPERTY_NAME = "Anfitorio Madrid Centro";

export const ACTIVE_PROPERTY_EVENT = "hotelos-active-property-changed";

export type ActiveProperty = {
  propertyId: string;
  organizationId: string;
  propertyName: string;
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
  try {
    window.localStorage.setItem(PROPERTY_KEY, next.propertyId);
    window.localStorage.setItem(ORG_KEY, next.organizationId);
    window.localStorage.setItem(NAME_KEY, next.propertyName);
  } catch {
    /* ignore quota / privacy-mode failures */
  }
  window.dispatchEvent(new CustomEvent<ActiveProperty>(ACTIVE_PROPERTY_EVENT, { detail: next }));
  // Hard reload so module-level constants across all screens pick up the change.
  window.location.reload();
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
