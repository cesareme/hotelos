// Fixed assets · permission entries of the fixed-assets routes (Finanzas 2026-09-15).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts)
// por el integrador; el contract test (tests/api-route-permissions-contract.test.mjs)
// lee este fichero: una ruta nueva en fixed-assets.routes.ts va con su entrada aquí.
// Keys reused from the existing catalogue: assets.read / assets.manage for the
// register, accounting.read for the runs, accounting.journal.post for
// anything that writes a journal entry (disposal, run, reversal).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const fixedAssetsRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/asset-register", permissions: ["assets.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/asset-register", permissions: ["assets.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/asset-register/:assetId", permissions: ["assets.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/asset-register/:assetId", permissions: ["assets.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/asset-register/:assetId/dispose", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "GET", path: "/organizations/:organizationId/depreciation-runs", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/depreciation-runs/preview", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/organizations/:organizationId/depreciation-runs", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "GET", path: "/organizations/:organizationId/depreciation-runs/:runId", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/organizations/:organizationId/depreciation-runs/:runId/reverse", permissions: ["accounting.journal.post"], riskLevel: "critical" }
];
