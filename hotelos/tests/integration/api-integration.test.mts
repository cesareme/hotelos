/**
 * API integration tests — REAL HTTP via Fastify's app.inject (audit 2026-06 · #8).
 *
 * Unlike the readFileSync+regex contract tests, these boot the actual API
 * (buildApiServer, no network listen) and exercise the real request pipeline:
 * auth context, RBAC pre-handler, validation and the security fixes from this
 * audit (default-deny, IDOR tenant guard).
 *
 * Requires a reachable Postgres (DATABASE_URL). Run with:
 *   pnpm test:integration
 * It is intentionally NOT part of the default `pnpm test` (which runs in a
 * no-DB job); CI runs it in a dedicated job that provisions Postgres.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

// Minimal env for boot if not supplied by apps/api/.env.
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

// Importing server.js runs its inline .env loader in OVERRIDE mode, so the
// repo .env (HOTELOS_ALLOW_DEMO_AUTH=true, NODE_ENV=development) lands in this
// process. Tests that depend on the auth gate pin the env explicitly instead
// of trusting whatever the ambient .env / CI shell provides.
const { buildApiServer } = await import("../../apps/api/src/server.js");
// Imported dynamically for the same reason (env defaults above must win before
// @hotelos/database is evaluated through these modules' import graphs).
const { assertRoutePermission, resetRbacStrictModeForTests } = await import(
  "../../apps/api/src/security/route-permissions.js"
);
const { assertDemoAuthPolicy } = await import("../../apps/api/src/lib/auth-context.js");

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// `undefined` unsets a variable for the duration of `run`. RBAC strict mode is
// memoized on first use (route-permissions.ts); the memo is dropped on entry so
// the override is honoured on an already-booted server, and on exit so it does
// not leak into the next test.
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  resetRbacStrictModeForTests();
  return run().finally(() => {
    applyEnv(previous);
    resetRbacStrictModeForTests();
  });
}

describe("API integration (app.inject)", () => {
  let app: Awaited<ReturnType<typeof buildApiServer>>;

  before(async () => {
    app = buildApiServer();
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });

  it("rejects unauthenticated access to a protected route in production (default-deny)", async () => {
    // The gate is HOTELOS_ALLOW_DEMO_AUTH (auth-context.ts), not NODE_ENV: the
    // production compose never sets the flag, which is what we reproduce here.
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" }, async () => {
      const res = await app.inject({ method: "GET", url: "/properties" });
      assert.equal(res.statusCode, 401);
    });
  });

  it("blocks cross-tenant reservation writes — IDOR guard returns 404 (audit NUEVO-1)", async () => {
    // Demo mode: the demo super-user is the caller. Posting to a property that
    // does not belong to the caller's org (here a non-existent id) must 404
    // BEFORE creating anything — proving the tenant guard runs on the write path
    // rather than blindly trusting the path param.
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/properties/prop_nonexistent_other_tenant/reservations",
        payload: {
          arrivalDate: "2030-01-01",
          departureDate: "2030-01-03",
          adults: 1,
          children: 0,
          roomTypeId: "rt_fake" // required by schema; property check fires first → 404
        }
      });
      assert.equal(res.statusCode, 404);
    });
  });

  it("RBAC_STRICT=true: mapped GET routes never hit the manifest 403 (AUTH-03)", async () => {
    // Caller: the demo super-user (union of real + demo permissions). These
    // five routes were among the 62 GETs mapped in the 2026-09-13 audit and
    // take no :propertyId, so the check does not depend on seeded data. A 403
    // here would mean the manifest gate (or a permission key) is wrong.
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", RBAC_STRICT: "true" }, async () => {
      for (const url of [
        "/integrations/email/providers",
        "/procurement/suppliers",
        "/developer/webhooks",
        "/ai-governance/policies",
        "/accounting/fiscal-periods"
      ]) {
        const res = await app.inject({ method: "GET", url });
        assert.notEqual(res.statusCode, 403, `${url} → ${res.statusCode} ${res.body}`);
        assert.doesNotMatch(res.body, /manifiesto de permisos|manifest entry/i, `${url} rejected by the manifest gate: ${res.body}`);
      }
    });
  });

  it("RBAC strict mode: an unmapped GET is refused when RBAC_STRICT=true and, by default, in production", async () => {
    const unmapped = { method: "GET", path: "/__not_in_manifest__", userPermissions: [] };
    const isManifest403 = (err: unknown) =>
      (err as { statusCode?: number }).statusCode === 403 && /manifiesto de permisos/.test((err as Error).message);

    await withEnv({ RBAC_STRICT: "true", NODE_ENV: "development" }, async () => {
      assert.throws(() => assertRoutePermission(unmapped), isManifest403);
    });
    await withEnv({ RBAC_STRICT: undefined, NODE_ENV: "production" }, async () => {
      assert.throws(() => assertRoutePermission(unmapped), isManifest403, "production must be strict by default");
    });
    await withEnv({ RBAC_STRICT: "false", NODE_ENV: "production" }, async () => {
      assert.doesNotThrow(() => assertRoutePermission(unmapped), "RBAC_STRICT=false is the explicit opt-out");
    });
    await withEnv({ RBAC_STRICT: undefined, NODE_ENV: "development" }, async () => {
      assert.doesNotThrow(() => assertRoutePermission(unmapped), "dev/demo stays fail-open (logged) without the flag");
    });
    // Mutations are fail-closed regardless of mode.
    await withEnv({ RBAC_STRICT: "false", NODE_ENV: "development" }, async () => {
      assert.throws(() => assertRoutePermission({ ...unmapped, method: "POST" }), isManifest403);
    });
  });

  it("refuses to boot with HOTELOS_ALLOW_DEMO_AUTH=true in production (AUTH-04)", async () => {
    const forbidden = /HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción/;
    await withEnv(
      { NODE_ENV: "production", HOTELOS_ALLOW_DEMO_AUTH: "true", HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE: undefined },
      async () => {
        assert.throws(() => assertDemoAuthPolicy(), forbidden);
        // Real boot path: registerAuthContext (inside buildApiServer) enforces it.
        assert.throws(() => buildApiServer(), forbidden);
      }
    );
    await withEnv(
      { NODE_ENV: "production", HOTELOS_ALLOW_DEMO_AUTH: "true", HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE: "true" },
      async () => {
        // Documented, dangerous override: boots, logs an error.
        assert.doesNotThrow(() => assertDemoAuthPolicy());
      }
    );
    await withEnv({ NODE_ENV: "production", HOTELOS_ALLOW_DEMO_AUTH: "false" }, async () => {
      assert.doesNotThrow(() => assertDemoAuthPolicy());
    });
    await withEnv({ NODE_ENV: "development", HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      assert.doesNotThrow(() => assertDemoAuthPolicy());
    });
  });
});
