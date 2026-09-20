// Activo inmobiliario · permisos de las rutas core (Tanda ACT · L1).
//
// Entradas fusionadas en route-permissions.partial.ts (agregador del módulo) y
// de ahí en routePermissionManifest (security/route-permissions.ts); el
// contract test (tests/api-route-permissions-contract.test.mjs) lee todo
// `*route-permissions.partial.ts`: una ruta nueva en core.routes.ts va con su
// entrada aquí. Claves de packages/shared/src/permissions.ts:260-261:
// real_estate.read (GET, medium) y real_estate.manage (escrituras, high).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const realEstateCoreRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/real-estate", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/real-estate/units", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/units/:unitId", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/real-estate/units/:unitId/charges", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/charges/:chargeId", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/real-estate/valuations", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate/valuations", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/real-estate/tenures", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate/tenures", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/tenures/:tenureId", permissions: ["real_estate.manage"], riskLevel: "high" }
];
