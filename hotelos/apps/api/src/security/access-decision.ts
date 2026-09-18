// RBAC · decisión de acceso única (Tanda 8a · L1, design §5.2 / §6.2).
//
// Versión PURA (nunca lanza) de lo que el gate de server.ts aplica con
// `assertRoutePermission`: manifiesto ruta → claves (`findRoutePermission`),
// claves que faltan (`missingPermissions`) y modo estricto (`isRbacStrictMode`),
// devueltos como `AccessDecision` (packages/shared/src/rbac-types.ts) para que el
// menú, el router del front y la API lean la misma decisión. Se usa en el
// catch del gate (auditoría ACCESS_DENIED con `missing`, ámbito y riesgo) y en
// GET /rbac/access-log (claves exigidas por la ruta denegada). El gate sigue
// llamando a `assertRoutePermission` tal cual: esta función no lo sustituye.

import { missingPermissions, type AccessDecision, type PermissionKey, type ScopeType } from "@hotelos/shared";
import { findRoutePermission, isRbacStrictMode, type RiskLevel } from "./route-permissions.js";

export type AccessDecisionInput = {
  method: string;
  /** Route template (`request.routeOptions.url`), never the raw URL. */
  path: string;
  /** Permissions resolved for the property of the request (or the organisation scope). */
  permissions: readonly PermissionKey[];
  /** RBAC_STRICT resolution; defaults to `isRbacStrictMode()`. */
  strict?: boolean;
  /** False for the token-less demo fallback (refused on high / critical routes). */
  authenticated: boolean;
  propertyId: string | null;
  /** Scope the permissions were resolved for (null when not authenticated / unknown). */
  scopeType: ScopeType | null;
};

export type RouteAccessDecision = AccessDecision & {
  /** Keys the route requires (empty for public / unmapped routes). */
  required: PermissionKey[];
  riskLevel: RiskLevel | null;
};

/**
 * Same order as the runtime gate: unmapped route (fail-open GET outside strict
 * mode, else refused) → public route → demo fallback refused on high/critical
 * → missing permissions.
 */
export function accessDecision(input: AccessDecisionInput): RouteAccessDecision {
  const method = input.method.toUpperCase();
  const route = findRoutePermission(method, input.path);
  const strict = input.strict ?? isRbacStrictMode();
  const base = { scopeType: input.scopeType, propertyId: input.propertyId };
  if (!route) {
    const allowed = method === "GET" && !strict;
    return { ...base, allowed, missing: [], required: [], riskLevel: null, reason: "unmapped" };
  }
  if (route.riskLevel === "public") {
    return { ...base, allowed: true, missing: [], required: [], riskLevel: route.riskLevel };
  }
  if (!input.authenticated && (route.riskLevel === "high" || route.riskLevel === "critical")) {
    return { ...base, allowed: false, missing: route.permissions.slice(), required: route.permissions.slice(), riskLevel: route.riskLevel, reason: "not_authenticated" };
  }
  const missing = missingPermissions(input.permissions.slice(), route.permissions);
  if (missing.length > 0) {
    return { ...base, allowed: false, missing, required: route.permissions.slice(), riskLevel: route.riskLevel, reason: "missing_permission" };
  }
  return { ...base, allowed: true, missing: [], required: route.permissions.slice(), riskLevel: route.riskLevel };
}
