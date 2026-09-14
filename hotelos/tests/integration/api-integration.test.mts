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
const { parsePageQuery, MAX_PAGE_LIMIT } = await import("../../apps/api/src/lib/pagination.js");
const { BadRequestError } = await import("../../apps/api/src/lib/http-error.js");

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
    // AUTH-05: buildApiServer is async (it awaits cors + rate-limit before
    // declaring routes); a sync call here would hand back a Promise.
    app = await buildApiServer();
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });

  it("GET /health carries the global x-ratelimit headers (AUTH-05)", async () => {
    // Before the fix no inline route had a limiter: the plugin loaded at
    // app.ready(), after every route had already been registered.
    // The global ceiling is `Number(process.env.RATE_LIMIT_MAX ?? 600)` in
    // server.ts (Tanda 2 · server-higiene); the exact default is pinned by
    // tests/rate-limit-contract.test.mjs, here we prove the limiter is wired.
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const limit = res.headers["x-ratelimit-limit"];
    assert.equal(limit, process.env.RATE_LIMIT_MAX ?? "600", `headers: ${JSON.stringify(res.headers)}`);
    const remaining = Number(res.headers["x-ratelimit-remaining"]);
    assert.ok(Number.isInteger(remaining) && remaining < Number(limit), `x-ratelimit-remaining not accounted: ${JSON.stringify(res.headers)}`);
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

  it("GET /guests?search=a&search=b (repeated query key) is a 400, never a 500 (Tanda 2 · cierre)", async () => {
    // Fastify's default query parser hands a repeated key to the handler as an
    // array. The old code called `.trim()` on it → TypeError → 500 with a
    // stack in the logs. A malformed query is the caller's fault: 400.
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      const res = await app.inject({ method: "GET", url: "/guests?search=a&search=b" });
      assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
      assert.equal(JSON.parse(res.body).error, "Bad Request");
    });
  });

  it("GET /properties/:id/reservations?cursor=a&cursor=b (array cursor) is a 400 (REC-05)", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      // Discover a property of the caller's org through the API itself so the
      // case does not hard-code seed ids; an empty box skips loudly.
      const list = await app.inject({ method: "GET", url: "/properties" });
      assert.equal(list.statusCode, 200, `GET /properties → ${list.statusCode}: ${list.body}`);
      const properties = JSON.parse(list.body) as Array<{ id: string }>;
      const propertyId = properties[0]?.id;
      if (!propertyId) {
        t.skip("no property visible to the demo user — seed the demo (packages/database prisma/seed.ts) to exercise this case");
        return;
      }
      const res = await app.inject({ method: "GET", url: `/properties/${propertyId}/reservations?cursor=a&cursor=b` });
      assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
      assert.equal(JSON.parse(res.body).message, "El cursor de paginación no es válido.");
      // A single malformed cursor is the documented 400 too (decodeCursor).
      const single = await app.inject({ method: "GET", url: `/properties/${propertyId}/reservations?cursor=not-a-cursor` });
      assert.equal(single.statusCode, 400, `expected 400, got ${single.statusCode}: ${single.body}`);
      assert.equal(JSON.parse(single.body).message, "El cursor de paginación no es válido.");
    });
  });

  it("an unknown route is a 404 for an authenticated caller with and without RBAC_STRICT (is404 guard)", async () => {
    // Root-level preHandler hooks also run for the not-found handler. Without
    // `if (request.is404) return;` in the permission preHandler the unknown
    // path is looked up in the manifest: RBAC_STRICT=true turned every 404 into
    // a manifest 403 (and mutations always did). RBAC strict mode is memoized,
    // so withEnv (which resets the memo) is enough — no second server needed.
    for (const rbacStrict of [undefined, "true", "false"]) {
      await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development", RBAC_STRICT: rbacStrict }, async () => {
        for (const method of ["GET", "POST"] as const) {
          const res = await app.inject({ method, url: "/__no_such_route__" });
          assert.equal(res.statusCode, 404, `RBAC_STRICT=${rbacStrict ?? "(unset)"} ${method}: ${res.statusCode} ${res.body}`);
          assert.equal(JSON.parse(res.body).error, "Not Found");
        }
      });
    }
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
        // buildApiServer is async since AUTH-05, so the policy error rejects.
        await assert.rejects(() => buildApiServer(), forbidden);
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

describe("rate limit (AUTH-05) — own app instance: the in-memory store is per instance and keyed by IP for public routes", () => {
  let app: Awaited<ReturnType<typeof buildApiServer>>;

  before(async () => {
    app = await buildApiServer();
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it("POST /auth/login: the 11th attempt from the same IP within a minute is 429 with retry-after", async () => {
    // Distinct non-existent emails so the per-account lockout (5 failures /
    // 15 min) never fires; the rate limit is per IP (127.0.0.1 under inject).
    for (let i = 1; i <= 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: `nobody-${i}@example.invalid`, password: "x" }
      });
      if (i <= 10) {
        assert.equal(res.statusCode, 401, `attempt ${i}: ${res.body}`);
        assert.equal(res.headers["x-ratelimit-limit"], "10", `attempt ${i}: ${JSON.stringify(res.headers)}`);
      } else {
        assert.equal(res.statusCode, 429, `attempt ${i}: ${res.body}`);
        assert.ok(res.headers["retry-after"], "retry-after header missing on 429");
        const body = JSON.parse(res.body) as { error: string; message: string };
        assert.equal(body.error, "Too Many Requests");
        assert.equal(body.message, "Demasiadas peticiones. Reintenta en unos segundos.");
      }
    }
  });
});


describe("cursor pagination contract (REC-05) — parsePageQuery, no DB", () => {
  const isInvalidCursor = (err: unknown) =>
    err instanceof BadRequestError && err.statusCode === 400 && err.message === "El cursor de paginación no es válido.";

  it("rejects a repeated ?cursor (array after query parsing) with a 400 instead of ignoring it", () => {
    assert.throws(() => parsePageQuery({ cursor: ["a", "b"] }), isInvalidCursor);
    assert.throws(() => parsePageQuery({ cursor: 42 }), isInvalidCursor);
  });

  it("keeps the documented shapes: absent/empty cursor → null, string cursor → envelope on", () => {
    assert.deepEqual(parsePageQuery(undefined), { limit: 100, cursor: null, envelope: false });
    assert.deepEqual(parsePageQuery({ cursor: "" }), { limit: 100, cursor: null, envelope: false });
    assert.deepEqual(parsePageQuery({ cursor: "abc" }), { limit: 100, cursor: "abc", envelope: true });
  });

  it("clamps limit to MAX_PAGE_LIMIT without an error; only a non-integer or non-positive limit is a 400", () => {
    assert.equal(parsePageQuery({ limit: "10000" }).limit, MAX_PAGE_LIMIT);
    assert.equal(parsePageQuery({ limit: "10000" }, { max: 200 }).limit, 200);
    for (const limit of ["0", "-1", "abc", "1.5"]) {
      assert.throws(() => parsePageQuery({ limit }), (err: unknown) => err instanceof BadRequestError);
    }
  });
});
