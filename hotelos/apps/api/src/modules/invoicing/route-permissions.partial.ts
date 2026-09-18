// Finanzas (2026-09-15) · permission entries of the invoicing routes added by
// the facturación-cobros lote (invoicing.routes.ts). Merged into
// routePermissionManifest (security/route-permissions.ts) by the integrator;
// the contract test (tests/api-route-permissions-contract.test.mjs) reads this
// file: a new route in invoicing.routes.ts goes with its entry here.
//
// Tanda 8a (RBAC · L2, design §4.6): `POST /invoices/:id/cancel-request` is
// the maker key of the anulación (invoice.cancel_request); the decision uses
// invoice.cancel_approve in /approvals and the execution keeps invoice.cancel
// on POST /invoices/:id/cancel (main manifest) plus the engine gate.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const invoicingRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/invoices/:id/pdf", permissions: ["invoice.read"], riskLevel: "medium" },
  { method: "POST", path: "/invoices/:id/cancel-request", permissions: ["invoice.cancel_request"], riskLevel: "high" }
];
