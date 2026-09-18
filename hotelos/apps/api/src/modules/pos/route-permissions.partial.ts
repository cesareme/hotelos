// TPV · arqueo — permission entries of the POS module routes (pos.routes.ts).
//
// Convention (rate grid v2): the module contributes its manifest entries and
// the integrator spreads them into routePermissionManifest
// (security/route-permissions.ts, `...posRoutePermissions`). The contract test
// (tests/api-route-permissions-contract.test.mjs) parses the FIRST exported
// array of this file, so `posRoutePermissions` holds EVERY route registered by
// registerPosRoutes: the six routes that used to be inline in server.ts
// (integration 2026-09-16: their manifest entries moved here with the routes)
// plus the cash closures of the lote TPV/arqueo and, since Tanda 8a (RBAC ·
// L2, design §4.6), the void of a closed ticket.
//
// Keys (Tanda 8a): pos.read (listings), pos.order.create (open a ticket, add
// lines: waiter / reception), pos.order.pay (close a ticket, open / close a
// cash count: the cashier), pos.order.void (void a closed ticket of the day
// with a reason code: jefatura de A&B / recepción, or a supervisor PIN),
// accounting.journal.post (approve a cash count: management / accounting).
// The room-charge settlement still checks folio.charge.post in the service.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const posRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/pos/outlets", permissions: ["pos.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pos/tickets", permissions: ["pos.read"], riskLevel: "low" },
  { method: "POST", path: "/pos/tickets", permissions: ["pos.order.create"], riskLevel: "low" },
  { method: "POST", path: "/pos/tickets/:id/lines", permissions: ["pos.order.create"], riskLevel: "low" },
  { method: "POST", path: "/pos/tickets/:id/close", permissions: ["pos.order.pay"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/pos/cash-summary", permissions: ["pos.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/pos/cash-closures", permissions: ["pos.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pos/cash-closures", permissions: ["pos.order.pay"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/pos/cash-closures/:closureId", permissions: ["pos.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/pos/cash-closures/:closureId/close", permissions: ["pos.order.pay"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/pos/cash-closures/:closureId/approve", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "POST", path: "/pos/tickets/:id/void", permissions: ["pos.order.void"], riskLevel: "high" }
];

/** The six routes that were inline in server.ts before 2026-09-16 (kept for callers that distinguished them). */
export const POS_LEGACY_ROUTE_PERMISSIONS: ApiRoutePermission[] = posRoutePermissions.slice(0, 6);

/** Every route registered by registerPosRoutes (tests mount the module under a prefix with these). */
export const posRoutePermissionsAll: ApiRoutePermission[] = posRoutePermissions;
