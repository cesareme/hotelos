// Activo inmobiliario · permisos de vista de grupo, calendario anual y
// exportación CSV (Tanda ACT · L6).
//
// Entradas fusionadas en route-permissions.partial.ts (agregador del módulo) y
// de ahí en routePermissionManifest (security/route-permissions.ts); el
// contract test (tests/api-route-permissions-contract.test.mjs) lee todo
// `*route-permissions.partial.ts`: una ruta nueva en group.routes.ts va con
// su entrada aquí. Las 4 rutas son lecturas con real_estate.read (medium) más
// el ámbito del contexto (assertEntityAccess + propertyWithinScope /
// hasEntityReadScope en el servicio); la exportación NO tiene clave propia
// (decisión del plan: sin `real_estate.export`).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const realEstateGroupRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/organizations/:organizationId/real-estate/overview", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/real-estate/calendar", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/real-estate/export", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/real-estate/calendar", permissions: ["real_estate.read"], riskLevel: "medium" }
];
