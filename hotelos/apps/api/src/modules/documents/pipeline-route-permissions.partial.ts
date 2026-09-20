// Documentos · Tanda T9 · lote T9-06a — entradas del manifiesto de permisos de
// las 2 rutas del pipeline (pipeline.routes.ts): POST …/documents/:id/classify
// y POST …/documents/:id/extract.
//
// Cableado (integrador T9-05b, ya hecho): security/route-permissions.ts importa
// `documentPipelineRoutePermissions` y lo hace spread tras
// `...documentsRoutePermissions`. tests/api-route-permissions-contract.test.mjs
// descubre este partial por sufijo y exige que sus entradas coincidan una a una
// con las rutas registradas en pipeline.routes.ts (sin huérfanos ni duplicados).
//
// Permisos (diseño §9: `documents.capture | documents.review`, medium): el
// manifiesto solo sabe de CONJUNCIONES (assertPermissions exige todas las
// claves), así que la disyunción se declara `authenticated`; como el gate de
// server.ts no exige sesión real en ese nivel, el handler la exige con
// requireRealSession (401 al fallback demo sin token; RV-02 / SEC-06) y aplica
// la disyunción con requireAnyPermission de documents.service.ts, igual que las
// lecturas del partial de T9-05a (GET …/documents, GET …/documents/:id).
// La tenencia de :propertyId la resuelve el hook global de server.ts (404
// opaco fuera del ámbito) y el handler recomprueba que el documento cuelga del
// centro y de la organización de la sesión.
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const documentPipelineRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/properties/:propertyId/documents/:id/classify", permissions: [], riskLevel: "authenticated" },
  { method: "POST", path: "/properties/:propertyId/documents/:id/extract", permissions: [], riskLevel: "authenticated" }
];
