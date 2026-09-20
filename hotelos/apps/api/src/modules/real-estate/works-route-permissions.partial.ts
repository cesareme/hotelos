// Activo inmobiliario · permisos de obras (CapexProject ampliado) y capitalización (Tanda ACT · L4).
//
// Entradas fusionadas en route-permissions.partial.ts (agregador del módulo) y
// de ahí en routePermissionManifest; el contract test
// tests/api-route-permissions-contract.test.mjs lee todo
// `*route-permissions.partial.ts`: una ruta nueva en works.routes.ts va con su
// entrada aquí. Claves existentes: real_estate.read (GET, medium),
// asset.capex.approve (aprobar: owner / general_manager / controller, high;
// ACT-REV-05: ruta propia porque ninguna plantilla reúne capex.create +
// asset.capex.approve), capex.create (datos de obra y transiciones in_progress /
// completed, high; misma clave que PATCH /capex-projects/:id) y assets.manage
// (capitalizar: alta en el registro de inmovilizado, critical).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const realEstateWorksRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/real-estate/works", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/capex-projects/:id/approve", permissions: ["asset.capex.approve"], riskLevel: "high" },
  { method: "PATCH", path: "/capex-projects/:id/work", permissions: ["capex.create"], riskLevel: "high" },
  { method: "POST", path: "/capex-projects/:id/capitalize", permissions: ["assets.manage"], riskLevel: "critical" }
];
