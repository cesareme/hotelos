import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyJwt } from "@hotelos/database";
import { loadIsPlatformAdmin, loadUserContext } from "../modules/auth/auth.service.js";
import { demoStore, type UserContext } from "./demo-store.js";
import { HttpError } from "./http-error.js";

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
      .catch((error: unknown) => {
        // Fail closed: a DB outage must never promote the demo fallback to platform admin.
        console.warn("[auth-context] platform-admin lookup failed; failing closed for the cache window", error instanceof Error ? error.message : String(error));
        return false;
      })
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
//   - `/auth/forgot-password`, `/auth/reset-password`, `/auth/password-policy`
//     (Tanda 3 · invitaciones): the manifest already marked them `public`, but
//     without this list a production box (HOTELOS_ALLOW_DEMO_AUTH unset)
//     answered 401 before the handler ran, so nobody could recover a password.
//   - `/auth/invitations/:token` and `/auth/accept-invite` (Tanda 3): the
//     invitee has no account yet; the single-use token in the body/path is the
//     credential (invitations.service validates hash, expiry and single use).
const PUBLIC_PREFIXES = [
  "/auth/login",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/auth/password-policy",
  "/auth/accept-invite",
  "/auth/invitations",
  "/health",
  "/channel-manager/_sandbox",
  "/channel-manager/webhooks",
  "/guest-portal/sign-in",
  "/guest-portal/sign-out",
  "/guest-portal/reservation",
  "/guest-portal/pre-check-in",
  "/guest-portal/service-request",
  "/integrations/email/oauth/callback",
  // Finanzas (2026-09-16): PSP notifications (Stripe / Redsys → API, signed
  // over the raw body) and the customer's landing after the hosted payment
  // page. Both carry no staff token; their manifest entries are riskLevel public.
  "/payments/webhooks",
  "/payments/return"
];

/**
 * True for routes that are NOT staff-authenticated (see PUBLIC_PREFIXES). Also
 * used by the global tenant guard in server.ts: on these routes the staff
 * context is at most the demo fallback, so a propertyId in their body/query
 * (e.g. guest-portal sign-in) must not be checked against a staff org.
 */
export function isPublicRoute(url: string): boolean {
  return matchesPrefixList(url, PUBLIC_PREFIXES);
}

function matchesPrefixList(url: string, prefixes: readonly string[]): boolean {
  // Strip query string so `/path?x=1` still matches the `/path` prefix.
  const path = url.split("?")[0] ?? "";
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// ─── Forced password rotation (Tanda 3 · invitaciones) ───────────────────────
//
// A user whose context carries `mustChangePassword: true` (temp password from
// createTenant / regenerateTempPassword, or a set password never rotated) may
// only reach the routes below until they call POST /auth/change-password. The
// guard itself is a preHandler mounted in server.ts (lote server-rutas):
//
//   if (request.isAuthenticated && request.userContext.mustChangePassword &&
//       !isPasswordChangeAllowedRoute(request.url)) throw passwordChangeRequiredError();
//
// The list is prefix-matched exactly like PUBLIC_PREFIXES (`/users/me` also
// covers `/users/me/preferences`). `/auth/login` and `/health` are public
// anyway; they are listed so the intent is explicit and the guard stays cheap.
export const PASSWORD_CHANGE_ALLOWLIST: readonly string[] = [
  "/auth/change-password",
  "/auth/password-policy",
  "/auth/login",
  "/auth/sessions",
  "/users/me",
  "/health"
];

/** Machine-readable code carried in `details.code` of the 403 the guard throws. */
export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED" as const;

/** True when the route may be served to a user who still has to rotate their password. */
export function isPasswordChangeAllowedRoute(url: string): boolean {
  return matchesPrefixList(url, PASSWORD_CHANGE_ALLOWLIST);
}

/**
 * The 403 the guard throws. Built here (not in server.ts) so the message and
 * the `details.code` the front branches on live next to the allowlist.
 */
export function passwordChangeRequiredError(): HttpError {
  return new HttpError(
    403,
    "Debes cambiar tu contraseña temporal antes de continuar.",
    true,
    { code: PASSWORD_CHANGE_REQUIRED_CODE, changePasswordPath: "/auth/change-password" }
  );
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
    // H4 (Tanda 3 · cierre, documented on purpose): this hook runs BEFORE routing
    // is consulted, so in production (no demo flag) a request without a token
    // gets 401 even when the path does not exist — never 404. That is the
    // intended anti-enumeration behaviour: an anonymous caller must not be able
    // to tell registered routes from typos. The 404 for unknown paths is only
    // reachable once a caller is authenticated (or, in demo mode, through the
    // fallback context). Pinned by tests/integration/api-integration.test.mts.
    if (!allowDemoFallback && !isPublicRoute(request.url)) {
      throw Object.assign(new Error("Authentication required."), { statusCode: 401 });
    }
    // Note for the permission preHandler (server.ts, H1): the fallback context
    // below is flagged `isAuthenticated = false`; routes mapped as riskLevel
    // `high` / `critical` refuse it with 401 even when the demo flag is on.
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
