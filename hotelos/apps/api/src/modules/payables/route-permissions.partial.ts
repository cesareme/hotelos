// Payables · permission entries of the payables routes (Finanzas 2026-09-15).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts)
// por el integrador; el contract test (tests/api-route-permissions-contract.test.mjs)
// lee este fichero: una ruta nueva en payables.routes.ts va con su entrada aquí.
// Keys reused from the existing catalogue (packages/shared/src/permissions.ts):
// suppliers = procurement.*, documents = accounting.read / procurement.manage,
// anything that writes a journal entry = accounting.journal.post. A finer
// `accounting.payables.*` pair can replace them once the catalogue carries it.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const payablesRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/organizations/:organizationId/payables/suppliers", permissions: ["procurement.read"], riskLevel: "medium" },
  { method: "POST", path: "/organizations/:organizationId/payables/suppliers", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "GET", path: "/organizations/:organizationId/payables/suppliers/:supplierId", permissions: ["procurement.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/organizations/:organizationId/payables/suppliers/:supplierId", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/payables/supplier-bills", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/payables/aging", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/payables/supplier-bills/:billId", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/payables/supplier-bills/:billId", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/approve", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/post", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/pay", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/cancel", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "GET", path: "/properties/:propertyId/payables/supplier-bills/:billId/attachment", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/payables/expenses", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/payables/expenses", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/payables/expenses/:expenseId", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/payables/expenses/:expenseId/reverse", permissions: ["accounting.journal.post"], riskLevel: "critical" }
];
