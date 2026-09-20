// Estado honesto de las integraciones (Tanda L8 · L8-05) · entrada de permisos
// de `GET /integrations/status` (integrations-status.routes.ts).
//
// Fusionada en routePermissionManifest (security/route-permissions.ts,
// `...INTEGRATIONS_STATUS_ROUTE_PERMISSIONS`); los contratos
// (tests/api-route-permissions-contract.test.mjs y tests/rbac-nav-contract.test.mjs)
// leen este fichero por su nombre exacto: una ruta nueva en
// integrations-status.routes.ts va con su entrada aquí, una por línea, con la
// forma { method, path, permissions, riskLevel }.
//
// Clave EXISTENTE `integrations.read` (sin rbac:sync): la tienen manager,
// operations_director, accountant, controller, compliance, general_manager,
// auditor y admin (packages/shared/src/permissions.ts); Recepción no. Lectura
// sin efectos ni datos de huéspedes → riskLevel low. El hub heredado
// (/integrations/categories|providers, /properties/:propertyId/integrations*)
// y el correo entrante (/integrations/email/*) siguen en el manifiesto principal.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const INTEGRATIONS_STATUS_ROUTE_PERMISSIONS: ApiRoutePermission[] = [
  { method: "GET", path: "/integrations/status", permissions: ["integrations.read"], riskLevel: "low" }
];
