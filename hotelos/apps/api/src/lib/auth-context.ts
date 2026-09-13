import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyJwt } from "@hotelos/database";
import { loadIsPlatformAdmin, loadUserContext } from "../modules/auth/auth.service.js";
import { demoStore, type UserContext } from "./demo-store.js";

// The demo fallback (no token → usr_123) does not go through loadUserContext,
// so it must derive `isPlatformAdmin` from the REAL DB grants itself. Memoized
// for a short window: the answer only changes when roles are reseeded, and the
// fallback fires on every request in demo mode. Fail-secure: a DB error yields
// `false` (and is not cached) rather than an unhandled 500.
const DEMO_PLATFORM_ADMIN_TTL_MS = 30_000;
let demoPlatformAdminCache: { value: boolean; expiresAt: number } | null = null;
let demoPlatformAdminInFlight: Promise<boolean> | null = null;

async function resolveDemoPlatformAdmin(): Promise<boolean> {
  const now = Date.now();
  if (demoPlatformAdminCache && demoPlatformAdminCache.expiresAt > now) {
    return demoPlatformAdminCache.value;
  }
  if (!demoPlatformAdminInFlight) {
    demoPlatformAdminInFlight = loadIsPlatformAdmin(demoStore.userContext.userId, demoStore.userContext.propertyId)
      .then((value) => {
        demoPlatformAdminCache = { value, expiresAt: Date.now() + DEMO_PLATFORM_ADMIN_TTL_MS };
        return value;
      })
      .catch(() => false)
      .finally(() => {
        demoPlatformAdminInFlight = null;
      });
  }
  return demoPlatformAdminInFlight;
}

declare module "fastify" {
  interface FastifyRequest {
    userContext: UserContext;
    isAuthenticated: boolean;
  }
}

// Public routes whose bearer token (when present) is NOT a staff JWT and must
// therefore not be rejected by the staff auth hook:
//   - `/auth/login`, `/health`: no auth at all.
//   - `/channel-manager/_sandbox`: a loopback OTA mock (Sprint 44) — a channel
//     adapter in sandbox mode POSTs to it with a placeholder bearer to prove the
//     real HTTP path works.
//   - `/guest-portal/{sign-in,sign-out,reservation,pre-check-in,service-request}`
//     (Sprint 40): the guest portal is guest-authenticated, not staff. Guests
//     present an OPAQUE session token (not a JWT) in the Authorization header.
//     The staff hook can't verify it, so it must let the request through and let
//     each handler call `verifyGuestToken`. NOTE: `/guest-portal/session/...`
//     routes are deliberately excluded — those are staff-authenticated.
//   - `/integrations/email/oauth/callback` (AUTH-03, audit 2026-09-13): the
//     browser redirect back from Google/Microsoft after the mailbox OAuth
//     consent. It carries no bearer token; its CSRF protection is the `state`
//     parameter that handleEmailOAuthCallback validates. Mapped as public in
//     routePermissionManifest as well.
const PUBLIC_PREFIXES = [
  "/auth/login",
  "/health",
  "/channel-manager/_sandbox",
  "/guest-portal/sign-in",
  "/guest-portal/sign-out",
  "/guest-portal/reservation",
  "/guest-portal/pre-check-in",
  "/guest-portal/service-request",
  "/integrations/email/oauth/callback"
];

/**
 * True for routes that are NOT staff-authenticated (see PUBLIC_PREFIXES). Also
 * used by the global tenant guard in server.ts: on these routes the staff
 * context is at most the demo fallback, so a propertyId in their body/query
 * (e.g. guest-portal sign-in) must not be checked against a staff org.
 */
export function isPublicRoute(url: string): boolean {
  // Strip query string so `/path?x=1` still matches the `/path` prefix.
  const path = url.split("?")[0];
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * AUTH-04 (audit 2026-09-13): the demo fallback (no bearer → demoStore
 * super-user with ~200 permissions, platform-admin resolved from the DB) must
 * never run in production. With NODE_ENV=production and
 * HOTELOS_ALLOW_DEMO_AUTH=true the API refuses to boot, unless the operator
 * explicitly acknowledges the risk with HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE
 * =true — a public demo box with no real tenant data, never a customer-facing
 * deployment; that path is logged as an error on every boot. Called from
 * registerAuthContext so buildApiServer (and therefore app.inject in tests)
 * enforces it, not only the listen path in server.ts.
 */
export function assertDemoAuthPolicy(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production" || env.HOTELOS_ALLOW_DEMO_AUTH !== "true") {
    return;
  }
  if (env.HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE === "true") {
    console.error(
      "[auth] PELIGRO: HOTELOS_ALLOW_DEMO_AUTH=true en producción con " +
        "HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true. Toda petición sin token recibe el " +
        "super-usuario demo. Solo aceptable en una demo pública sin datos reales de clientes."
    );
    return;
  }
  throw new Error(
    "HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción: elimínalo del entorno " +
      "(NODE_ENV=production). Solo una demo pública sin datos reales puede forzarlo con " +
      "HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true (peligroso: cualquier petición sin token " +
      "obtiene el super-usuario demo)."
  );
}

export function registerAuthContext(app: FastifyInstance): void {
  assertDemoAuthPolicy();

  app.decorateRequest("userContext", null as unknown as UserContext);
  app.decorateRequest("isAuthenticated", false);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      const result = verifyJwt(token);
      if (result.ok) {
        const ctx = await loadUserContext(result.claims.sessionId);
        if (ctx) {
          request.userContext = { ...ctx, deviceId: result.claims.deviceId };
          request.isAuthenticated = true;
          return;
        }
      }
      if (!isPublicRoute(request.url)) {
        throw Object.assign(new Error("Invalid or expired token."), { statusCode: 401 });
      }
    }
    // SECURITY (audit R2 · #7): gate on a positive flag instead of NODE_ENV.
    // If NODE_ENV is misconfigured the whole API was falling back to the demoStore
    // super-user (82 permissions). Now the demo fallback only activates when
    // HOTELOS_ALLOW_DEMO_AUTH=true is explicitly set — an intentional, revocable
    // choice — regardless of NODE_ENV. Production compose never sets this flag.
    const allowDemoFallback = process.env.HOTELOS_ALLOW_DEMO_AUTH === "true";
    if (!allowDemoFallback && !isPublicRoute(request.url)) {
      throw Object.assign(new Error("Authentication required."), { statusCode: 401 });
    }
    // Fresh object per request: the tenant guard may re-point organizationId
    // for platform admins and must never mutate the shared demoStore context.
    // Without the demo flag this context only reaches public routes, so skip
    // the DB lookup and never grant platform-admin there.
    request.userContext = {
      ...demoStore.userContext,
      isPlatformAdmin: allowDemoFallback ? await resolveDemoPlatformAdmin() : false
    };
    request.isAuthenticated = false;
  });
}
