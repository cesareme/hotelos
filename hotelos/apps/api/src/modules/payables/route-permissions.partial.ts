// Payables · permission entries of the payables routes (Finanzas 2026-09-15).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts)
// por el integrador; el contract test (tests/api-route-permissions-contract.test.mjs)
// lee este fichero: una ruta nueva en payables.routes.ts va con su entrada aquí.
//
// Tanda 8a (RBAC · L2, design §4.6 / H6): the supplier bills carry their own
// keys — payables.read (listings, aging, detail, attachment),
// payables.create (register / edit a draft), payables.approve (approve by
// amount: creator ≠ approver, tier or the supplier_bill approval of the
// engine) and payables.pay (order the payment: creator ≠ payer, approver ≠
// payer unless controller). Suppliers keep procurement.*; posting, cancelling,
// expenses and reversals keep accounting.journal.post (journal writers).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const payablesRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/organizations/:organizationId/payables/suppliers", permissions: ["procurement.read"], riskLevel: "medium" },
  { method: "POST", path: "/organizations/:organizationId/payables/suppliers", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "GET", path: "/organizations/:organizationId/payables/suppliers/:supplierId", permissions: ["procurement.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/organizations/:organizationId/payables/suppliers/:supplierId", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/payables/supplier-bills", permissions: ["payables.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills", permissions: ["payables.create"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/payables/aging", permissions: ["payables.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/payables/supplier-bills/:billId", permissions: ["payables.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/payables/supplier-bills/:billId", permissions: ["payables.create"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/approve", permissions: ["payables.approve"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/post", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/pay", permissions: ["payables.pay"], riskLevel: "critical" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/cancel", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  { method: "GET", path: "/properties/:propertyId/payables/supplier-bills/:billId/attachment", permissions: ["payables.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/payables/expenses", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/payables/expenses", permissions: ["accounting.journal.post"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/payables/expenses/:expenseId", permissions: ["accounting.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/payables/expenses/:expenseId/reverse", permissions: ["accounting.journal.post"], riskLevel: "critical" }
];
