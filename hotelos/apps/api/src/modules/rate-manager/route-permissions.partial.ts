// Rate grid v2 · permission entries of the rate-manager routes.
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts);
// el contract test (tests/api-route-permissions-contract.test.mjs) lee este
// fichero: una ruta nueva en rate-grid.routes.ts va con su entrada aquí.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const rateGridRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/rate-grid", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/rate-grid/bulk-update", permissions: ["revenue.manage_rates"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/rate-grid/push", permissions: ["distribution.sync"], riskLevel: "critical" },
  { method: "GET", path: "/properties/:propertyId/rate-grid/sync-status", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/rate-journal", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/rate-journal/:journalId", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/rate-journal/:journalId/revert", permissions: ["revenue.manage_rates"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/rate-plans/:ratePlanId/rederive", permissions: ["revenue.manage_rates"], riskLevel: "high" }
];
