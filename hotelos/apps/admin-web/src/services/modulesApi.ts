// Property modules API (Tanda 5 · L1b · lote sidebar).
//
//   GET   /backoffice/properties/:propertyId/modules            (modules.read)
//   PATCH /backoffice/properties/:propertyId/modules/:code       { action: "enable" | "disable" }
//
// One cache of enabled module codes per property for the whole session: the
// menu (`useEnabledModules`), the tab containers and the ModuleManager read
// it; ModuleManager writes through `setPropertyModuleState`, which invalidates
// the cache and fires ENABLED_MODULES_CHANGED_EVENT so every mounted consumer
// refetches — an item unlocked by «Activar módulo» appears without a reload.

import { ApiError, apiRequest } from "./api-client";

export type PropertyModuleStatus = "enabled" | "disabled" | "available";
export type PropertyModuleHealth = "ok" | "needs_configuration" | "error";

/** Menu entry a module unlocks, as declared by the product manifest (`menuEntries`). */
export type PropertyModuleMenuEntry = {
  screenKey: string;
  label: string;
  url: string;
  category?: string;
  tab?: string | null;
};

/** Row of GET /backoffice/properties/:propertyId/modules (manifest spread + property state). */
export type PropertyModule = {
  code: string;
  name: string;
  category: string;
  description: string;
  isCore: boolean;
  dependencies: string[];
  status: PropertyModuleStatus;
  healthStatus: PropertyModuleHealth;
  recommendedNextAction?: string;
  enabledByDefault?: boolean;
  menuEntries?: PropertyModuleMenuEntry[];
};

export const ENABLED_MODULES_CHANGED_EVENT = "hotelos-enabled-modules-changed";

const enabledCache = new Map<string, Promise<string[]>>();

export function modulesPath(propertyId: string): string {
  return `/backoffice/properties/${encodeURIComponent(propertyId)}/modules`;
}

/** Full module list of a property (never cached: ModuleManager wants fresh state and health). */
export function fetchPropertyModules(propertyId: string): Promise<PropertyModule[]> {
  return apiRequest<unknown>(modulesPath(propertyId)).then((rows) => (Array.isArray(rows) ? (rows as PropertyModule[]) : []));
}

/** Enabled module codes of a property, memoized per session; `force` refetches. */
export function fetchEnabledModules(propertyId: string, options: { force?: boolean } = {}): Promise<string[]> {
  if (!options.force) {
    const cached = enabledCache.get(propertyId);
    if (cached) return cached;
  }
  const request = fetchPropertyModules(propertyId)
    .then((rows) => rows.filter((row) => row && row.status === "enabled").map((row) => row.code))
    .catch((error: unknown) => {
      if (enabledCache.get(propertyId) === request) enabledCache.delete(propertyId);
      throw error;
    });
  enabledCache.set(propertyId, request);
  return request;
}

/** Drop the memoized codes (one property or all) and tell mounted consumers to refetch. */
export function invalidateEnabledModules(propertyId?: string): void {
  if (propertyId) enabledCache.delete(propertyId);
  else enabledCache.clear();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<{ propertyId?: string }>(ENABLED_MODULES_CHANGED_EVENT, { detail: { propertyId } }));
  }
}

/** Enable or disable a module; the cache of the property is invalidated on success. */
export async function setPropertyModuleState(propertyId: string, code: string, action: "enable" | "disable"): Promise<void> {
  await apiRequest(`${modulesPath(propertyId)}/${encodeURIComponent(code)}`, { method: "PATCH", body: { action } });
  invalidateEnabledModules(propertyId);
}

/** True for the 403 a user without `modules.read` gets: unknown list, not an error to show. */
export function isModulesForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}
