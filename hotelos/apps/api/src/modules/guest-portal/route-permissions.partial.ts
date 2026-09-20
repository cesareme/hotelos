// Portal del huésped · estancia y salida (Tanda L7 · lote L7-02) · entradas
// del manifiesto de permisos de las rutas de guest-portal.routes.ts: 4 del
// lote L7-02 + 3 de la encuesta post-estancia (lote L7-04: GET/POST
// /guest-portal/survey públicas por token y POST /reservations/:id/post-stay/
// survey-invite de personal con pms.reservation.modify, riesgo medium —
// misma clave que POST /reservations/:id/check-in/guests de recepción).
//
// CABLEADO: security/route-permissions.ts importa `guestPortalRoutePermissions`
// junto a checkinRoutePermissions y hace spread tras `...checkinRoutePermissions,`.
// tests/api-route-permissions-contract.test.mjs descubre este partial por
// sufijo y exige que sus entradas coincidan una a una con las rutas
// registradas (sin huérfanos ni duplicados) y que toda ruta bajo
// PUBLIC_PREFIXES (lib/auth-context.ts: /guest-portal/stay,
// /guest-portal/invoices, /guest-portal/survey) tenga riskLevel "public".
//
// Huésped (recon §19.1): `permissions: [], riskLevel: "public"` como
// /guest-portal/pre-check-in y /guest-portal/check-in; el token opaco de
// GuestPortalSession (x-guest-token o, solo en GET, ?token=) ES la
// autenticación y cada handler llama a verifyGuestToken (401
// GUEST_SESSION_INVALID). Las escrituras van con el contexto de servicio de
// SOLO payment.capture (enlace de pago) o con Prisma directo + evento de
// dominio (peticiones), nunca con request.userContext.
//
// Formato: una entrada por línea, comillas dobles y el orden de claves
// { method, path, permissions, riskLevel } que parsea el contrato raíz.

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const guestPortalRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/guest-portal/stay", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/stay/requests", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/stay/payment-link", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/guest-portal/invoices/:id/pdf", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/guest-portal/survey", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/guest-portal/survey", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/reservations/:id/post-stay/survey-invite", permissions: ["pms.reservation.modify"], riskLevel: "medium" }
];
