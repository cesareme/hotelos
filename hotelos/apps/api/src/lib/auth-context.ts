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
const PUBLIC_PREFIXES = [
  "/auth/login",
  "/health",
  "/channel-manager/_sandbox",
  "/guest-portal/sign-in",
  "/guest-portal/sign-out",
  "/guest-portal/reservation",
  "/guest-portal/pre-check-in",
  "/guest-portal/service-request"
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

export function registerAuthContext(app: FastifyInstance): void {
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
