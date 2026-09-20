// Documentos · Tanda T9 · lote T9-13 — entradas del manifiesto de permisos de
// las 7 rutas de organización de archive.routes.ts (archivo, KPIs, ajustes,
// bloqueo / desbloqueo / purga).
//
// Cableado: security/route-permissions.ts importa
// `documentArchiveRoutePermissions` y lo hace spread tras
// `...documentWorkflowRoutePermissions`. tests/api-route-permissions-contract
// descubre este partial por sufijo y exige que sus entradas coincidan una a
// una con las rutas registradas en archive.routes.ts (sin huérfanos ni
// duplicados).
//
// Claves (diseño §9; catálogo v4 de T9-02):
//   · documents.archive.read (medium) → archivo (+ ámbito R11 en el servicio;
//     los bloqueados solo con documents.admin, includeBlocked y reason auditado);
//   · documents.review (medium) → KPIs (+ ámbito R11 en el servicio);
//   · documents.admin (high) → GET / PATCH de los ajustes por organización;
//   · documents.admin (critical) → block, unblock y purge (§7.5; purge solo con
//     blockedAt y sin legalHold → 409 DOCUMENT_LEGAL_HOLD).
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const documentArchiveRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/organizations/:organizationId/documents/archive", permissions: ["documents.archive.read"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/documents/kpis", permissions: ["documents.review"], riskLevel: "medium" },
  { method: "GET", path: "/organizations/:organizationId/documents/settings", permissions: ["documents.admin"], riskLevel: "high" },
  { method: "PATCH", path: "/organizations/:organizationId/documents/settings", permissions: ["documents.admin"], riskLevel: "high" },
  { method: "POST", path: "/organizations/:organizationId/documents/:id/block", permissions: ["documents.admin"], riskLevel: "critical" },
  { method: "POST", path: "/organizations/:organizationId/documents/:id/unblock", permissions: ["documents.admin"], riskLevel: "critical" },
  { method: "POST", path: "/organizations/:organizationId/documents/:id/purge", permissions: ["documents.admin"], riskLevel: "critical" }
];
