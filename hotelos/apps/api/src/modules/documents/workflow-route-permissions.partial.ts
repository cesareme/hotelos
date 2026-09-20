// Documentos · Tanda T9 · lote T9-08 — entradas del manifiesto de permisos de
// las 12 rutas de workflow.routes.ts (assign, review, approve, reject, archive,
// split, merge, tareas, valija y hoja de remesa).
//
// Cableado: security/route-permissions.ts importa
// `documentWorkflowRoutePermissions` y lo hace spread tras
// `...documentPipelineRoutePermissions`. tests/api-route-permissions-contract
// descubre este partial por sufijo y exige que sus entradas coincidan una a
// una con las rutas registradas en workflow.routes.ts (sin huérfanos ni
// duplicados).
//
// Claves (diseño §9; §6.2 adaptado en el servicio):
//   · documents.review (high) → assign, review, approve, reject, archive. La
//     clave EXTRA de la acción al aprobar (payables.create, accounting.journal.post,
//     purchase_orders.receive) la exige actions.service.ts (assertApprovePermissions):
//     el manifiesto solo sabe de conjunciones fijas por ruta y la clave depende
//     del cuerpo;
//   · documents.review (medium) → tareas (POST / PATCH …/actions), recibir la
//     valija;
//   · documents.capture (medium) → cerrar la valija;
//   · «documents.capture | documents.review» (medium en el diseño) → split,
//     merge y descarga de la hoja de remesa: disyunción no expresable en el
//     manifiesto (assertPermissions es conjunción) → `authenticated`; la sesión
//     real la exige el handler (requireRealSession → 401 al fallback demo sin
//     token; RV-02 / SEC-06) y requireAnyPermission en el servicio da el mismo
//     403 que el gate, patrón de las lecturas de T9-05a y del pipeline de T9-06a.
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const documentWorkflowRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/properties/:propertyId/documents/:id/assign", permissions: ["documents.review"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/review", permissions: ["documents.review"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/approve", permissions: ["documents.review"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/reject", permissions: ["documents.review"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/archive", permissions: ["documents.review"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/split", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/merge", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/actions", permissions: ["documents.review"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/documents/:id/actions/:actionId", permissions: ["documents.review"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/documents/dispatch-batches", permissions: ["documents.capture"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/documents/dispatch-batches/:batchId/receive", permissions: ["documents.review"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/documents/dispatch-batches/:batchId/sheet", permissions: [], riskLevel: "authenticated" }
];
