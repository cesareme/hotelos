// Check-in automatizado (Tanda CHK · lotes W2-A, W3-A y W4-D) · entradas del
// manifiesto de permisos de las 30 rutas de checkin.routes.ts (15 de huésped,
// 15 de personal). W4-D: POST /guest-portal/chat (bot del huésped, público
// por token; prefijo "/guest-portal/chat" en PUBLIC_PREFIXES).
//
// CABLEADO: security/route-permissions.ts importa `checkinRoutePermissions`
// junto a reputationRoutePermissions (:53) y hace spread tras
// `...reputationRoutePermissions,`. tests/api-route-permissions-contract.test.mjs
// descubre este partial por sufijo y exige que sus entradas coincidan una a
// una con las rutas registradas en checkin.routes.ts (sin huérfanos ni
// duplicados).
//
// Huésped (diseño §7.1): `permissions: [], riskLevel: "public"` como
// /guest-portal/pre-check-in (route-permissions.ts:392); el token opaco de
// GuestPortalSession es la autenticación y cada handler llama a
// verifyGuestToken. El prefijo "/guest-portal/check-in" está en
// PUBLIC_PREFIXES (lib/auth-context.ts, R18) para que el hook de personal no
// responda 401 antes del handler.
//
// Personal (diseño §7.2; claves existentes de packages/shared/src/permissions.ts,
// sin rbac:sync): pms.reservation.read (llegadas, detalle de sesión, vista de
// check-in de la reserva) · pms.reservation.modify (invitar / reenviar) ·
// guest_self_service.read (leer la política; jefatura de recepción y dirección
// la tienen junto a .manage) · guest_self_service.manage (escribir la política)
// · kiosk.configure (dispositivos y emparejamiento) · W3-A: ai.tool.execute +
// guest_register.create (scan desde el drawer, medium) · guest_register.sign
// (firma en recepción, high) · guest_register.edit (verify-identity, medium) ·
// pms.checkin.execute (complete, high; el servicio lo vuelve a exigir).
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const checkinRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/guest-portal/check-in", permissions: [], riskLevel: "public" },
  { method: "PATCH", path: "/guest-portal/check-in", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/guests", permissions: [], riskLevel: "public" },
  { method: "PATCH", path: "/guest-portal/check-in/guests/:id", permissions: [], riskLevel: "public" },
  { method: "DELETE", path: "/guest-portal/check-in/guests/:id", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/guests/:id/mrz", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/complete", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/guests/:id/document", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/guests/:id/signature", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/payment-link", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/otp/request", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/otp/verify", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/arrive", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/check-in/kiosk/claim", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/chat", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/properties/:propertyId/check-in/arrivals", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/check-in/sessions", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/check-in/sessions/:id", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/check-in/sessions/:id/resend", permissions: ["pms.reservation.modify"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/check-in/policy", permissions: ["guest_self_service.read"], riskLevel: "low" },
  { method: "PUT", path: "/properties/:propertyId/check-in/policy", permissions: ["guest_self_service.manage"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/kiosks", permissions: ["kiosk.configure"], riskLevel: "low" },
  { method: "POST", path: "/properties/:propertyId/kiosks", permissions: ["kiosk.configure"], riskLevel: "medium" },
  { method: "PATCH", path: "/properties/:propertyId/kiosks/:id", permissions: ["kiosk.configure"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/kiosks/:id/pair", permissions: ["kiosk.configure"], riskLevel: "medium" },
  { method: "GET", path: "/reservations/:id/check-in", permissions: ["pms.reservation.read"], riskLevel: "low" },
  { method: "POST", path: "/reservations/:id/check-in/scan", permissions: ["ai.tool.execute", "guest_register.create"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/check-in/signature", permissions: ["guest_register.sign"], riskLevel: "high" },
  { method: "POST", path: "/reservations/:id/check-in/verify-identity", permissions: ["guest_register.edit"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/check-in/complete", permissions: ["pms.checkin.execute"], riskLevel: "high" },
  // Corrector CHK (REV3-04): edición de viajeros y resolución de derivaciones desde el mostrador.
  { method: "PATCH", path: "/reservations/:id/check-in/guests/:guestId", permissions: ["guest_register.edit"], riskLevel: "medium" },
  { method: "POST", path: "/reservations/:id/check-in/resolve-handoff", permissions: ["pms.checkin.execute"], riskLevel: "medium" }
];
