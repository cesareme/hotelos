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

function withEnv<T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
});
