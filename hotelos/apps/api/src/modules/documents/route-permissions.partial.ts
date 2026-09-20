// Documentos (Tanda T9 · lote T9-05a) · entradas del manifiesto de permisos de
// las 9 rutas de documents.routes.ts (captura multi-fichero, fichero adicional,
// bandeja, detalle, descarga del original, imagen de página, enviar a la
// oficina, recaptura y cola de la oficina).
//
// CABLEADO (integrador T9-05b; este fichero NO se hace spread solo):
//   · security/route-permissions.ts, junto al import de reputationRoutePermissions:
//       import { documentsRoutePermissions } from "../modules/documents/route-permissions.partial.js";
//   · security/route-permissions.ts, tras `...reputationRoutePermissions,`:
//       // Documentos (Tanda T9): 9 entradas, ver modules/documents/route-permissions.partial.ts.
//       ...documentsRoutePermissions,
//   · server.ts: `import { registerDocumentsRoutes } from "./modules/documents/documents.routes.js";`
//     y `registerDocumentsRoutes(app, { uploadBodyLimit, onCaptured })` tras registerPayrollCostRoutes(app).
// Hasta la fusión, tests/api-route-permissions-contract.test.mjs descubre este
// partial por sufijo y exige que sus entradas coincidan una a una con las rutas
// registradas en documents.routes.ts (sin huérfanos ni duplicados).
//
// Claves (packages/shared/src/permissions.ts, T9-02; diseño §6.2 / §9):
//   · documents.capture (medium) → alta, fichero adicional, enviar a la oficina,
//     recaptura (escrituras del centro);
//   · documents.review (medium) → cola de la oficina (+ ámbito R11 en el servicio:
//     accounting.entity.read o todos los centros asignados; 404 ENTITY_SCOPE_REQUIRED).
//   · Lecturas compartidas «documents.capture | documents.review» (bandeja, detalle)
//     y «… | documents.archive.read» (descargas): assertPermissions del gate es una
//     CONJUNCIÓN (packages/shared/src/permissions.ts:2864) y las plantillas de T9-02
//     reparten capture (recepción, jefes de departamento) y review (contable,
//     controller, propietario) sin solaparlas, así que ninguna clave única ni par de
//     claves expresa la disyunción. Van como `authenticated`: el gate de server.ts
//     NO exige sesión real en ese nivel (solo rechaza el fallback demo en high /
//     critical), así que la exige el propio handler con requireRealSession
//     (documents.routes.ts → 401 «Authentication required.» al fallback demo sin
//     token; RV-02 / SEC-06) y documents.service.ts aplica la disyunción con
//     requireAnyPermission → PermissionDeniedError (mismo 403 que el gate; pinado
//     por documents-service.test.mts y por HTTP en documents-workflow /
//     documents-pipeline). Si el manifiesto gana un `anyOf`, subir estas cuatro a
//     medium con las dos/tres claves.
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const documentsRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/properties/:propertyId/documents", permissions: ["documents.capture"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/files", permissions: ["documents.capture"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/documents", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/properties/:propertyId/documents/:id", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/properties/:propertyId/documents/:id/file", permissions: [], riskLevel: "authenticated" },
  { method: "GET", path: "/properties/:propertyId/documents/:id/pages/:n/image", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/send-to-office", permissions: ["documents.capture"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/recapture", permissions: ["documents.capture"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/documents/queue", permissions: ["documents.review"], riskLevel: "medium" }
];
