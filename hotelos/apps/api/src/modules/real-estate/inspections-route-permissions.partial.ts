// Activo inmobiliario · permisos de inspecciones obligatorias, pólizas y alertas (Tanda ACT · L5).
//
// Entradas fusionadas en route-permissions.partial.ts (agregador del módulo) y
// de ahí en routePermissionManifest (security/route-permissions.ts); el
// contract test (tests/api-route-permissions-contract.test.mjs) lee todo
// `*route-permissions.partial.ts`: una ruta nueva en inspections.routes.ts va
// con su entrada aquí. Claves de packages/shared/src/permissions.ts:260-261:
// real_estate.read (GET, medium) y real_estate.manage (escrituras, high).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const realEstateInspectionRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/real-estate/inspections", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate/inspections", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/inspections/:inspectionId", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/real-estate/insurances", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate/insurances", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/insurances/:insuranceId", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/real-estate/alerts", permissions: ["real_estate.read"], riskLevel: "medium" }
];
