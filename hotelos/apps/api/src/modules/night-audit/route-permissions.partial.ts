// Cierre del día — permission entries of the night-audit module routes
// (night-audit.routes.ts). Same convention as modules/pos/route-permissions.partial.ts:
// the contract test parses the FIRST exported array, so `nightAuditRoutePermissions`
// holds EVERY route of registerNightAuditRoutes — the four that were inline
// in server.ts until the integration of 2026-09-16 plus the run report.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const nightAuditRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/night-audit/business-date", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/night-audit/runs", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/night-audit/run", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/night-audit/preflight", permissions: ["analytics.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/night-audit/runs/:runId", permissions: ["analytics.read"], riskLevel: "low" }
];

/** The four routes that were inline in server.ts before 2026-09-16 (kept for callers that distinguished them). */
export const NIGHT_AUDIT_LEGACY_ROUTE_PERMISSIONS: ApiRoutePermission[] = nightAuditRoutePermissions.slice(0, 4);

/** Every route registered by registerNightAuditRoutes (tests mount the module under a prefix with these). */
export const nightAuditRoutePermissionsAll: ApiRoutePermission[] = nightAuditRoutePermissions;
