// Activo inmobiliario · permisos de documentación con fichero y vigencia (Tanda ACT · L3).
//
// Entradas fusionadas en route-permissions.partial.ts (agregador del módulo) y
// de ahí en routePermissionManifest (security/route-permissions.ts); el
// contract test (tests/api-route-permissions-contract.test.mjs) lee todo
// `*route-permissions.partial.ts`: una ruta nueva en documents.routes.ts va con
// su entrada aquí. Claves de packages/shared/src/permissions.ts:260-262:
// real_estate.read (listar y descargar, medium), real_estate.documents.manage
// (subir, versionar y editar metadatos) y real_estate.manage (retirar; en el
// servicio también `legalHold`). Descarga con sesión real (requireRealSession).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const realEstateDocumentRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/real-estate/documents", permissions: ["real_estate.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/real-estate/documents", permissions: ["real_estate.documents.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/real-estate/documents/:documentId/versions", permissions: ["real_estate.documents.manage"], riskLevel: "high" },
  { method: "PATCH", path: "/properties/:propertyId/real-estate/documents/:documentId", permissions: ["real_estate.documents.manage"], riskLevel: "medium" },
  { method: "DELETE", path: "/properties/:propertyId/real-estate/documents/:documentId", permissions: ["real_estate.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/real-estate/documents/:documentId/file", permissions: ["real_estate.read"], riskLevel: "medium" }
];
