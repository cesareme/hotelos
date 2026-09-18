// Finanzas (2026-09-15) · permission entries of the payments routes
// (payments.routes.ts). Merged into routePermissionManifest
// (security/route-permissions.ts) by the integrator; the contract test
// (tests/api-route-permissions-contract.test.mjs) reads this file: a new route
// in payments.routes.ts goes with its entry here. The webhook / return routes
// carry no staff token (PSP → API, customer browser → API) and therefore are
// public: they must also be listed in PUBLIC_PREFIXES (lib/auth-context.ts).
// The webhook is gated by the PSP signature over the raw body; the return
// page by the signed `?t=` return token (return-token.ts, t6#15) — without it
// the page is neutral. `GET /payment-intents/:id` is staff-only AND
// tenant-guarded (assertPaymentIntentAccess, t6#5).
//
// Tanda 8a (RBAC · L2, design §4.6): `POST /payments/:id/refund-requests`
// opens the approval request (maker key payments.refund_request; the decision
// lives in /approvals with payments.refund_approve and the execution in
// POST /payments/:id/refund with payment.refund + the engine gate);
// `POST /folios/:id/adjustments` posts an adjustment line with folio.adjust
// (≤ T1 with a reason code, above it the folio_adjust approval). Both
// tenant-guarded (assertEntityAccess of the folio / payment).

import type { ApiRoutePermission } from "../../security/route-permissions.js";

export const paymentsRoutePermissions: ApiRoutePermission[] = [
  { method: "GET", path: "/properties/:propertyId/payments/psp-status", permissions: ["payment.capture"], riskLevel: "low" },
  { method: "POST", path: "/folios/:id/payment-links", permissions: ["payment.capture"], riskLevel: "high" },
  { method: "GET", path: "/payment-intents/:id", permissions: ["payment.capture"], riskLevel: "low" },
  { method: "POST", path: "/payments/webhooks/:provider", permissions: [], riskLevel: "public" },
  { method: "GET", path: "/payments/return/:intentId", permissions: [], riskLevel: "public" },
  { method: "POST", path: "/payments/:id/refund-requests", permissions: ["payments.refund_request"], riskLevel: "high" },
  { method: "POST", path: "/folios/:id/adjustments", permissions: ["folio.adjust"], riskLevel: "high" }
];
