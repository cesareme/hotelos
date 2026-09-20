// Recorrido del huésped en recepción (Tanda L7 · lote L7-07) · entrada del
// manifiesto de permisos de la ruta de guest-journey.routes.ts. Segundo partial
// del módulo guest-portal (como modules/accounting: route-permissions.partial.ts
// + fiscal-route-permissions.partial.ts): el primero (route-permissions.partial.ts)
// lleva las rutas PÚBLICAS del huésped por token; este lleva la ruta de PERSONAL.
//
// CABLEADO: security/route-permissions.ts importa `guestJourneyRoutePermissions`
// y hace spread tras `...guestPortalRoutePermissions,`.
// tests/api-route-permissions-contract.test.mjs descubre este partial por
// sufijo `route-permissions.partial.ts` y exige que su entrada coincida con la
// ruta registrada (sin huérfanos ni duplicados).
//
// Clave existente pms.reservation.read (packages/shared/src/permissions.ts, sin
// rbac:sync): la misma que GET /reservations/:id/check-in y
// /properties/:propertyId/check-in/sessions/:id. Riesgo low: solo lectura, sin PII
// (destinatarios enmascarados, viajeros con el DTO de recepción).
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const guestJourneyRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/reservations/:id/guest-journey", permissions: ["pms.reservation.read"], riskLevel: "low" }
];
