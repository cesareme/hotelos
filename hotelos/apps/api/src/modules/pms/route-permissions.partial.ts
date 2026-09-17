// Importación masiva de reservas · Tanda 7 · L3 · entradas de permisos de las
// rutas /properties/:propertyId/reservations/imports* (reservation-import.routes.ts).
//
// Entradas fusionadas en routePermissionManifest (security/route-permissions.ts,
// `...reservationImportRoutePermissions`); los contratos (tests/api-route-
// permissions-contract.test.mjs y tests/rbac-nav-contract.test.mjs) leen este
// fichero por su nombre exacto: una ruta nueva en reservation-import.routes.ts va
// con su entrada aquí, una por línea, con la forma { method, path, permissions,
// riskLevel }.
//
// Claves (diseño docs/design/RESERVAS-IMPORTACION-MASIVA.md §1.11 y §7): la
// previsualización nunca escribe y exige `pms.reservation.create` (medium);
// importar exige `pms.reservation.create` Y `pms.reservation.modify` (high:
// el commit pasa por assignRoom y transitionReservation, que exigen modify;
// todas las plantillas con create tienen modify); deshacer exige
// `pms.reservation.modify` (high, espejo de POST /reservations/:id/cancel);
// listar, ver un lote y descargar la plantilla, `pms.reservation.read` (low).
// Sin claves nuevas → sin rbac:sync. high rechaza el contexto demo sin token.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const reservationImportRoutePermissions: ApiRoutePermission[] = [
  { method: "POST", path: "/properties/:propertyId/reservations/imports/preview", permissions: ["pms.reservation.create"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/reservations/imports", permissions: ["pms.reservation.create", "pms.reservation.modify"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/reservations/imports", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/reservations/imports/template", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "GET", path: "/properties/:propertyId/reservations/imports/:id", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/reservations/imports/:id/undo", permissions: ["pms.reservation.modify"], riskLevel: "high" }
];
