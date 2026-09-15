// TPV · arqueo — permission entries of the POS module routes (pos.routes.ts).
//
// Convention (rate grid v2): the module contributes its manifest entries and
// the integrator spreads them into routePermissionManifest
// (security/route-permissions.ts, `...posRoutePermissions`). The contract test
// (tests/api-route-permissions-contract.test.mjs) parses the FIRST exported
// array of this file, so `posRoutePermissions` holds EVERY route registered by
// registerPosRoutes: the six routes that used to be inline in server.ts
// (integration 2026-09-16: their manifest entries moved here with the routes)
// plus the cash closures of the lote TPV/arqueo.
//
// Keys: pos.read (listings), folio.charge.post (open / add lines / close a
// ticket: reception and F&B), pos.order.pay (open / close a cash count: the
// cashier), accounting.journal.post (approve: management / accounting).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const posRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/pos/outlets", permissions: ["pos.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pos/tickets", permissions: ["pos.read"], riskLevel: "low" },
  { method: "POST", path: "/pos/tickets", permissions: ["folio.charge.post"], riskLevel: "low" },
  { method: "POST", path: "/pos/tickets/:id/lines", permissions: ["folio.charge.post"], riskLevel: "low" },
  { method: "POST", path: "/pos/tickets/:id/close", permissions: ["folio.charge.post"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/pos/cash-summary", permissions: ["pos.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pos/cash-closures", permissions: ["pos.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pos/cash-closures", permissions: ["pos.order.pay"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/pos/cash-closures/:closureId", permissions: ["pos.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pos/cash-closures/:closureId/close", permissions: ["pos.order.pay"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/pos/cash-closures/:closureId/approve", permissions: ["accounting.journal.post"], riskLevel: "high" }
];

/** The six routes that were inline in server.ts before 2026-09-16 (kept for callers that distinguished them). */
export const POS_LEGACY_ROUTE_PERMISSIONS: ApiRoutePermission[] = posRoutePermissions.slice(0, 6);

/** Every route registered by registerPosRoutes (tests mount the module under a prefix with these). */
export const posRoutePermissionsAll: ApiRoutePermission[] = posRoutePermissions;
