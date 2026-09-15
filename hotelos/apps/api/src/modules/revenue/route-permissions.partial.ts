// Entradas del manifiesto de permisos del lote de recomendaciones (rate grid v2).
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts:25-27);
// el contract test (tests/api-route-permissions-contract.test.mjs) lee este
// fichero y exige una entrada exacta por ruta registrada en
// recommendations.routes.ts. Misma forma que el manifiesto principal.
import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const recommendationsRoutePermissions: ApiRoutePermission[] = [
  // RMS recommendations per day × room type for the grid editor.
  { method: "GET", path: "/properties/:propertyId/rate-grid/recommendations", permissions: ["revenue.read"], riskLevel: "medium" },
  // Persists the accepted recommendations and returns cell patches; rate_days are written by bulk-update.
  { method: "POST", path: "/properties/:propertyId/rate-grid/recommendations/apply", permissions: ["revenue.apply_recommendations"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/rate-grid/recommendations/config", permissions: ["revenue.read"], riskLevel: "low" },
  { method: "PUT", path: "/properties/:propertyId/rate-grid/recommendations/config", permissions: ["revenue.configure"], riskLevel: "medium" },
  // Demand calendar (Prisma DemandCalendarEvent).
  { method: "GET", path: "/revenue/properties/:propertyId/demand-calendar", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/revenue/properties/:propertyId/demand-calendar", permissions: ["revenue.manage_rates"], riskLevel: "medium" },
  { method: "PATCH", path: "/revenue/properties/:propertyId/demand-calendar/:eventId", permissions: ["revenue.manage_rates"], riskLevel: "medium" },
  { method: "DELETE", path: "/revenue/properties/:propertyId/demand-calendar/:eventId", permissions: ["revenue.manage_rates"], riskLevel: "high" }
];
