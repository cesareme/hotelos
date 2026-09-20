// Asignación explicable (Tanda CHK · lote W3-B) · entradas del manifiesto de
// permisos de las 10 rutas de room-assignment.routes.ts. Segundo partial del
// módulo pms (el primero, route-permissions.partial.ts, es de la importación
// masiva de reservas): tests/api-route-permissions-contract.test.mjs descubre
// cualquier `*route-permissions.partial.ts` bajo modules/ y exige que sus
// entradas coincidan una a una con las rutas registradas (sin huérfanos ni
// duplicados).
//
// CABLEADO: security/route-permissions.ts importa `roomAssignmentRoutePermissions`
// junto a checkinRoutePermissions y hace spread tras `...checkinRoutePermissions,`.
//
// Claves (diseño §7.2; existentes en packages/shared/src/permissions.ts, sin
// rbac:sync): ejecutar el motor y leer sugerencias, bloqueos y comunicadas ·
// pms.reservation.read (low); confirmar una sugerencia y lanzar el lote ·
// pms.reservation.modify (high: ambos acaban en assignRoom o en N filas, y high
// rechaza el contexto demo sin token como POST /reservations/:id/assign-room);
// crear/borrar bloqueos y comunicadas · pms.reservation.modify (medium, espejo
// de createRoom; §7.2 no las lista y el servicio del lote W2-C ya exige modify
// para escribir y read para listar).
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const roomAssignmentRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/reservations/:id/assignment-suggestions", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "GET", path: "/reservations/:id/assignment-suggestions", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/assignment-suggestions/:id/confirm", permissions: ["pms.reservation.modify"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/check-in/assignments/run", permissions: ["pms.reservation.modify"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/room-blocks", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/room-blocks", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "DELETE", path: "/room-blocks/:id", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/room-connections", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/room-connections", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "DELETE", path: "/room-connections/:id", permissions: ["pms.reservation.modify"], riskLevel: "medium" }
];
