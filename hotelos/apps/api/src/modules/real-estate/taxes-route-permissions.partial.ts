// Activo inmobiliario · permisos de tributos locales y recibos (IBI, IAE, tasas) (Tanda ACT · L2).
//
// Entradas fusionadas en route-permissions.partial.ts (agregador del módulo) y
// de ahí en routePermissionManifest (security/route-permissions.ts); el
// contract test (tests/api-route-permissions-contract.test.mjs) lee todo
// `*route-permissions.partial.ts`: una ruta nueva en taxes.routes.ts va con su
// entrada aquí. Claves de packages/shared/src/permissions.ts: real_estate.read
// (GET, medium) y property_tax.manage (escrituras, high; la propuesta del
// asiento 631 en borrador es critical).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const realEstateTaxRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/real-estate/taxes", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate/taxes", permissions: ["property_tax.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/taxes/:taxId", permissions: ["property_tax.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/real-estate/taxes/:taxId/receipts", permissions: ["property_tax.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/real-estate/taxes/:taxId/receipts/generate", permissions: ["property_tax.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/real-estate/receipts", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/receipts/:receiptId", permissions: ["property_tax.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/real-estate/receipts/:receiptId/propose-entry", permissions: ["property_tax.manage"], riskLevel: "critical" },
  { method: "GET", path: "/properties/:propertyId/real-estate/tax-calendar", permissions: ["real_estate.read"], riskLevel: "medium" }
];
