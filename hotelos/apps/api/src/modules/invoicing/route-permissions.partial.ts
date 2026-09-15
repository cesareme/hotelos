// Finanzas (2026-09-15) · permission entries of the invoicing routes added by
// the facturación-cobros lote (invoicing.routes.ts). Merged into
// routePermissionManifest (security/route-permissions.ts) by the integrator;
// the contract test (tests/api-route-permissions-contract.test.mjs) reads this
// file: a new route in invoicing.routes.ts goes with its entry here.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const invoicingRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/invoices/:id/pdf", permissions: ["invoice.read"], riskLevel: "medium" }
];
