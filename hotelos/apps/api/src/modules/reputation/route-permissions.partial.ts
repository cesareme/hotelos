// Reputación (Tanda T8 · lote T8-D) · entradas del manifiesto de permisos de las
// 12 rutas NUEVAS de reputation.routes.ts (bandeja, detalle/PATCH/borrador/caso
// de una reseña, fuentes, sincronización manual, ejecuciones e importación CSV).
//
// CABLEADO (mergeLines del integrador; este fichero NO se hace spread solo):
//   · security/route-permissions.ts, junto a la línea 52 (tras el import de
//     rbacRoutePermissions):
//       import { reputationRoutePermissions } from "../modules/reputation/route-permissions.partial.js";
//   · security/route-permissions.ts, línea 172 (tras `...rbacRoutePermissions,`):
//       // Reputación y reseñas (Tanda T8): 12 entradas, ver modules/reputation/route-permissions.partial.ts.
//       ...reputationRoutePermissions,
//   · server.ts: `import { registerReputationRoutes } from "./modules/reputation/reputation.routes.js";`
//     y `registerReputationRoutes(app);` tras registerLedgerImportRoutes(app) (:2867).
// Hasta la fusión, tests/api-route-permissions-contract.test.mjs descubre este
// partial por sufijo y exige que sus 12 entradas coincidan una a una con las
// rutas registradas en reputation.routes.ts (sin huérfanos ni duplicados); el
// spread solo se exige al partial rbac. tests/integration/l8-reputation-routes.
// test.mts empuja estas entradas al manifiesto vivo antes de inyectar.
//
// Claves (packages/shared/src/permissions.ts:179-184, sin claves nuevas):
//   · reputation.read  → lecturas (bandeja, detalle, fuentes, ejecuciones);
//   · reputation.respond → escrituras sobre reseñas (PATCH, borrador) y sobre
//     fuentes (alta, cambio, baja, sincronización, importación). No existe
//     reputation.manage: la escritura de fuentes usa reputation.respond
//     (decisión documentada; alternativa integrations.connect en §6 de las
//     mergeLines del integrador);
//   · quality_cases.manage + reputation.read → abrir un caso de calidad desde
//     una reseña (la respuesta y el caso llevan texto de la reseña: ninguna
//     ruta del fichero se abre sin una clave reputation.*; corrección HP-05).
// Las 8 rutas vivas del motor genérico (reviews, respond, casos, encuestas:
// server.ts:3246-3277 y manifiesto :391-395/:1218-1220) NO se repiten aquí.
// Ninguna ruta termina en /dashboard (l2-motor-generico.test.mts:444-456).
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const reputationRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/reputation/properties/:propertyId/inbox", permissions: ["reputation.read"], riskLevel: "medium" },
  { method: "GET", path: "/reputation/properties/:propertyId/sources", permissions: ["reputation.read"], riskLevel: "low" },
  { method: "POST", path: "/reputation/properties/:propertyId/sources", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "GET", path: "/reputation/properties/:propertyId/runs", permissions: ["reputation.read"], riskLevel: "low" },
  { method: "POST", path: "/reputation/properties/:propertyId/imports", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "PATCH", path: "/reputation/properties/:propertyId/sources/:id", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "DELETE", path: "/reputation/properties/:propertyId/sources/:id", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "POST", path: "/reputation/properties/:propertyId/sources/:id/sync", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "GET", path: "/reputation/reviews/:id", permissions: ["reputation.read"], riskLevel: "medium" },
  { method: "PATCH", path: "/reputation/reviews/:id", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "POST", path: "/reputation/reviews/:id/draft", permissions: ["reputation.respond"], riskLevel: "high" },
  { method: "POST", path: "/reputation/reviews/:id/quality-case", permissions: ["quality_cases.manage", "reputation.read"], riskLevel: "medium" }
];
