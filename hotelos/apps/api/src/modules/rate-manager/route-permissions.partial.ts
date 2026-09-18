// Rate grid v2 · permission entries of the rate-manager routes.
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts);
// el contract test (tests/api-route-permissions-contract.test.mjs) lee este
// fichero: una ruta nueva en rate-grid.routes.ts va con su entrada aquí.
//
// Tanda 8a (RBAC · L2, design §4.7): `POST /properties/:propertyId/rate-changes`
// abre la solicitud de aprobación de un cambio de tarifa (revenue.manage_rates;
// la decisión es revenue.rates.approve en /approvals y el motor aplica el
// cambio al aprobarse). `bulk-update` conserva revenue.manage_rates (critical):
// dentro de banda con motivo pasa; fuera de banda o > 50 celdas exige
// revenue.rates.approve en el actor o la solicitud aprobada (servicio).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const rateGridRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/rate-grid", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/rate-grid/bulk-update", permissions: ["revenue.manage_rates"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/rate-changes", permissions: ["revenue.manage_rates"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/rate-grid/push", permissions: ["distribution.sync"], riskLevel: "critical" },
  { method: "GET", path: "/properties/:propertyId/rate-grid/sync-status", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/rate-journal", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/rate-journal/:journalId", permissions: ["revenue.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/rate-journal/:journalId/revert", permissions: ["revenue.manage_rates"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/rate-plans/:ratePlanId/rederive", permissions: ["revenue.manage_rates"], riskLevel: "high" }
];
