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

// ── Tanda 3 · cierre (server-rutas) helpers ─────────────────────────────────
// The cases below discover their fixtures through the API itself (never
// hard-coded seed ids) and skip loudly when the box has none. Every helper
// runs under HOTELOS_ALLOW_DEMO_AUTH=true unless it is handed a session.
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

/** Prisma cuid (e.g. cmrhyk26c000dfy69l00bc1z8): the ids the SES pipeline persists. */
const CUID = /^c[a-z0-9]{20,}$/;

async function getJson<T>(app: ApiApp, url: string, headers: Headers = {}): Promise<T | null> {
  const res = await app.inject({ method: "GET", url, headers });
  return res.statusCode === 200 ? (JSON.parse(res.body) as T) : null;
}

/** Properties visible to the caller (the demo super-user is platform admin → every property). */
async function listPropertyIds(app: ApiApp, headers: Headers = {}): Promise<string[]> {
  const properties = (await getJson<Array<{ id: string }>>(app, "/properties", headers)) ?? [];
  return properties.map((property) => property.id);
}

/**
 * A real session for the routes the token-less demo fallback may no longer
 * reach (riskLevel high/critical, H1). Uses the demo super-admin from the
 * seed; override with INTEGRATION_LOGIN_EMAIL / INTEGRATION_LOGIN_PASSWORD.
 * Cached: /auth/login is hard-limited to 10/min per IP on this app instance.
 */
let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com",
      password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo",
      deviceId: "integration-tests"
    }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

async function listReservationIds(app: ApiApp, propertyId: string, headers: Headers = {}): Promise<string[]> {
  const rows = (await getJson<Array<{ id: string }>>(app, `/properties/${propertyId}/reservations?limit=25`, headers)) ?? [];
  return rows.map((row) => row.id);
}

/** Partes de viajeros of a reservation (GET /compliance/spain/reservations/:id/guest-register). */
async function listPartes(app: ApiApp, reservationId: string, headers: Headers = {}): Promise<Array<{ id: string; status: string }>> {
  return (await getJson<Array<{ id: string; status: string }>>(app, `/compliance/spain/reservations/${reservationId}/guest-register`, headers)) ?? [];
}

/** First OPEN folio reachable through the API (POST /folios/:id/lines needs one). */
async function findOpenFolioId(app: ApiApp): Promise<string | null> {
  for (const propertyId of (await listPropertyIds(app)).slice(0, 4)) {
    for (const reservationId of await listReservationIds(app, propertyId)) {
      const folios = await getJson<{ items: Array<{ id: string; status: string }> }>(app, `/reservations/${reservationId}/folios`);
      const open = folios?.items.find((folio) => folio.status === "open");
      if (open) return open.id;
    }
  }
  return null;
}

/** A reservation of `propertyId` with zero partes (the write-free 409 of POST /ses/submissions). */
async function findReservationWithoutPartes(app: ApiApp, propertyId: string, headers: Headers): Promise<string | null> {
  for (const reservationId of await listReservationIds(app, propertyId, headers)) {
    if ((await listPartes(app, reservationId, headers)).length === 0) return reservationId;
  }
  return null;
}

/**
 * A reservation with partes, anywhere the caller can see. Prefers one whose
 * partes are all `accepted` (already communicated: the blocked/queued row the
 * test leaves behind is then a modificación of an accepted parte, the least
 * intrusive fixture) over any reservation with partes.
 */
async function findReservationWithPartes(app: ApiApp, headers: Headers): Promise<{ propertyId: string; reservationId: string; partes: number } | null> {
  let fallback: { propertyId: string; reservationId: string; partes: number } | null = null;
  for (const propertyId of await listPropertyIds(app, headers)) {
    for (const reservationId of await listReservationIds(app, propertyId, headers)) {
      const partes = await listPartes(app, reservationId, headers);
      if (partes.length === 0) continue;
      const candidate = { propertyId, reservationId, partes: partes.length };
      if (partes.every((parte) => parte.status === "accepted")) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
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

  // ── Tanda 3 · cierre (server-rutas) ───────────────────────────────────────

  it("H1: the token-less demo fallback is refused (401) on high/critical routes and still serves reads", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      // No token → demo fallback (isAuthenticated=false). A critical/high route
      // must be refused by the permission preHandler BEFORE any entity lookup:
      // with fake ids the tenancy guard would otherwise answer 404, not 401.
      for (const [method, url] of [
        ["POST", "/invoices/inv_integration_fake/cancel"], // critical
        ["POST", "/payments/pay_integration_fake/refund"], // critical
        ["POST", "/onboarding/projects/proj_integration_fake/go-live"], // critical
        ["POST", "/users"] // high
      ] as const) {
        const res = await app.inject({ method, url, payload: {} });
        assert.equal(res.statusCode, 401, `${method} ${url} without token → ${res.statusCode}: ${res.body}`);
        assert.equal(JSON.parse(res.body).message, "Authentication required.");
      }
      // Reads (low) keep working for the fallback: that is what the demo is for.
      const propertyId = (await listPropertyIds(app))[0];
      if (!propertyId) {
        t.skip("no property visible to the demo user — seed the demo to exercise the read half");
        return;
      }
      const rooms = await app.inject({ method: "GET", url: `/properties/${propertyId}/rooms` });
      assert.equal(rooms.statusCode, 200, `GET /properties/${propertyId}/rooms without token → ${rooms.statusCode}: ${rooms.body}`);
      // The same critical route with a REAL session passes the gate (whatever
      // the handler then answers for a fake id, it is no longer the 401).
      const session = await loginDemo(app);
      if (!session) {
        t.diagnostic("demo login unavailable (reception@example.com) — authenticated half of H1 not exercised");
        return;
      }
      const withToken = await app.inject({
        method: "POST",
        url: "/invoices/inv_integration_fake/cancel",
        headers: { authorization: `Bearer ${session.token}` },
        payload: {}
      });
      assert.notEqual(withToken.statusCode, 401, `authenticated cancel still refused: ${withToken.body}`);
    });
  });

  it("H4: in production an anonymous request to an unknown path is 401, never 404 (anti-enumeration)", async () => {
    // The staff auth hook runs before routing is consulted, so without the demo
    // flag an anonymous caller cannot tell a registered route from a typo. The
    // 404 of the is404 case above is only reachable once authenticated.
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" }, async () => {
      for (const method of ["GET", "POST"] as const) {
        const res = await app.inject({ method, url: "/__no_such_route__" });
        assert.equal(res.statusCode, 401, `${method} /__no_such_route__ anonymous in production → ${res.statusCode}: ${res.body}`);
        assert.equal(JSON.parse(res.body).message, "Authentication required.");
      }
      // Public routes are untouched by the gate.
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
    });
  });

  it("H2: POST /folios/:id/lines persists taxCategory and GET /folios/:id/balance returns it", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      const folioId = await findOpenFolioId(app);
      if (!folioId) {
        t.skip("no open folio reachable through the API — seed the demo (prisma/seed.ts + db:seed:commercial) to exercise this case");
        return;
      }
      // An unknown category is refused by the schema before anything is written.
      const bad = await app.inject({
        method: "POST",
        url: `/folios/${folioId}/lines`,
        payload: { type: "misc", description: "[integration] categoría fiscal inválida", quantity: 1, unitPrice: 0, taxCategory: "bogus" }
      });
      assert.equal(bad.statusCode, 400, `bogus taxCategory → ${bad.statusCode}: ${bad.body}`);
      // Zero-amount line: the folio balance is untouched, the category is the
      // only thing under test. Before the fix the override was validated and
      // then dropped on the way to postFolioLine (taxCategory: null).
      const post = await app.inject({
        method: "POST",
        url: `/folios/${folioId}/lines`,
        payload: {
          type: "misc",
          description: "[integration] taxCategory general_services (importe 0)",
          quantity: 1,
          unitPrice: 0,
          taxCategory: "general_services"
        }
      });
      assert.equal(post.statusCode, 200, `POST /folios/${folioId}/lines → ${post.statusCode}: ${post.body}`);
      const line = JSON.parse(post.body) as { id: string; taxCategory: string | null };
      assert.equal(line.taxCategory, "general_services");
      const balance = await app.inject({ method: "GET", url: `/folios/${folioId}/balance` });
      assert.equal(balance.statusCode, 200, `GET /folios/${folioId}/balance → ${balance.statusCode}: ${balance.body}`);
      const stored = (JSON.parse(balance.body) as { lines: Array<{ id: string; taxCategory: string | null }> }).lines.find((row) => row.id === line.id);
      assert.ok(stored, `line ${line.id} not returned by GET /folios/${folioId}/balance`);
      assert.equal(stored.taxCategory, "general_services");
    });
  });

  it("GET /properties/:id/verifactu/submissions follows the pagination contract (cursor, envelope, filters, malformed cursor → 400)", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      const propertyId = (await listPropertyIds(app))[0];
      if (!propertyId) {
        t.skip("no property visible to the demo user — seed the demo to exercise this case");
        return;
      }
      const base = `/properties/${propertyId}/verifactu/submissions`;
      type Item = { id: string; registroType?: string };
      type Envelope = { items: Item[]; nextCursor: string | null; total: number };
      // Bare array by default, X-Total-Count always; X-Next-Cursor exactly when
      // the filtered set is larger than the page (the service pages by cursor:
      // createdAt desc, id desc).
      const bare = await app.inject({ method: "GET", url: `${base}?limit=2` });
      assert.equal(bare.statusCode, 200, `${base}?limit=2 → ${bare.statusCode}: ${bare.body}`);
      const rows = JSON.parse(bare.body) as Item[];
      assert.ok(Array.isArray(rows), `bare response must be an array: ${bare.body.slice(0, 200)}`);
      assert.ok(rows.length <= 2, "limit not honoured");
      const total = Number(bare.headers["x-total-count"]);
      assert.ok(Number.isInteger(total), `X-Total-Count missing: ${JSON.stringify(bare.headers)}`);
      assert.ok(total >= rows.length, `total ${total} < rows ${rows.length}`);
      assert.equal(bare.headers["x-next-cursor"] !== undefined, total > 2, `X-Next-Cursor vs total=${total}: ${JSON.stringify(bare.headers)}`);
      // Envelope on demand, same page.
      const enveloped = await app.inject({ method: "GET", url: `${base}?envelope=1&limit=2` });
      assert.equal(enveloped.statusCode, 200, `${enveloped.statusCode}: ${enveloped.body}`);
      const page = JSON.parse(enveloped.body) as Envelope;
      assert.deepEqual(Object.keys(page).sort(), ["items", "nextCursor", "total"]);
      assert.equal(page.total, total);
      assert.deepEqual(page.items.map((item) => item.id), rows.map((item) => item.id));
      assert.equal(page.nextCursor !== null, total > 2);
      assert.equal(enveloped.headers["x-total-count"], String(page.total));
      assert.equal(enveloped.headers["x-next-cursor"], page.nextCursor ?? undefined);
      // Following the cursor yields the next rows (disjoint from the first page)
      // and a cursor request implies the envelope even without ?envelope=1.
      if (page.nextCursor) {
        const next = await app.inject({ method: "GET", url: `${base}?limit=2&cursor=${encodeURIComponent(page.nextCursor)}` });
        assert.equal(next.statusCode, 200, `cursor page → ${next.statusCode}: ${next.body}`);
        const nextPage = JSON.parse(next.body) as Envelope;
        assert.deepEqual(Object.keys(nextPage).sort(), ["items", "nextCursor", "total"]);
        assert.ok(nextPage.items.length >= 1, "second page empty although nextCursor was issued");
        const firstIds = new Set(page.items.map((item) => item.id));
        assert.ok(nextPage.items.every((item) => !firstIds.has(item.id)), "second page repeats rows of the first one");
        assert.equal(nextPage.total, total);
      } else {
        t.diagnostic(`only ${total} VeriFactu submissions on ${propertyId}: the cursor-follow half was not exercised`);
      }
      // Filters: registroType is validated, status passes through.
      const alta = await app.inject({ method: "GET", url: `${base}?envelope=1&registroType=alta` });
      assert.equal(alta.statusCode, 200, `registroType=alta → ${alta.statusCode}: ${alta.body}`);
      const altaPage = JSON.parse(alta.body) as Envelope;
      assert.ok(altaPage.items.every((item) => item.registroType === "alta"), "registroType filter leaked other registros");
      assert.ok(altaPage.total <= page.total, "filtered total larger than the unfiltered one");
      const badType = await app.inject({ method: "GET", url: `${base}?registroType=bogus` });
      assert.equal(badType.statusCode, 400, `registroType=bogus → ${badType.statusCode}: ${badType.body}`);
      // A cursor this route never issued is the contract's 400, never a 500 or a silent first page.
      for (const malformed of ["abc", encodeURIComponent(Buffer.from(JSON.stringify({ k: "not-a-date", id: "x" })).toString("base64url"))]) {
        const cursor = await app.inject({ method: "GET", url: `${base}?cursor=${malformed}` });
        assert.equal(cursor.statusCode, 400, `?cursor=${malformed} → ${cursor.statusCode}: ${cursor.body}`);
        assert.equal(JSON.parse(cursor.body).message, "El cursor de paginación no es válido.");
      }
    });
  });

  it("POST /properties/:id/ses/submissions: session required (high), 400 without reservationId, 404 unknown reservation, typed 409 without partes", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      const propertyId = (await listPropertyIds(app))[0];
      if (!propertyId) {
        t.skip("no property visible to the demo user — seed the demo to exercise this case");
        return;
      }
      const url = `/properties/${propertyId}/ses/submissions`;
      // H1: sending partes to the MIR is riskLevel high → the demo fallback is refused.
      const anonymous = await app.inject({ method: "POST", url, payload: { reservationId: "res_integration_fake" } });
      assert.equal(anonymous.statusCode, 401, `anonymous → ${anonymous.statusCode}: ${anonymous.body}`);
      const session = await loginDemo(app);
      if (!session) {
        t.skip("demo login unavailable (reception@example.com / INTEGRATION_LOGIN_*) — authenticated cases not exercised");
        return;
      }
      const headers = { authorization: `Bearer ${session.token}` };
      const missing = await app.inject({ method: "POST", url, headers, payload: {} });
      assert.equal(missing.statusCode, 400, `no reservationId → ${missing.statusCode}: ${missing.body}`);
      const unknown = await app.inject({ method: "POST", url, headers, payload: { reservationId: "res_integration_does_not_exist" } });
      assert.equal(unknown.statusCode, 404, `unknown reservation → ${unknown.statusCode}: ${unknown.body}`);
      // Write-free 409: nothing is queued (and nothing crashes) when the
      // reservation has no partes yet. Before the fix this was a 200 "no_records".
      const reservationId = await findReservationWithoutPartes(app, propertyId, headers);
      if (!reservationId) {
        t.diagnostic(`every reservation of ${propertyId} already has partes — SES_NO_GUEST_REGISTER_RECORDS not exercised`);
        return;
      }
      const res = await app.inject({ method: "POST", url, headers, payload: { reservationId } });
      assert.equal(res.statusCode, 409, `reservation without partes → ${res.statusCode}: ${res.body}`);
      const body = JSON.parse(res.body) as { error: string; details?: { code?: string; reservationId?: string } };
      assert.equal(body.error, "Conflict");
      assert.equal(body.details?.code, "SES_NO_GUEST_REGISTER_RECORDS");
      assert.equal(body.details?.reservationId, reservationId);
    });
  });

  it("POST /properties/:id/ses/submissions with partes: every parte awaited — cuid ids when queued, 409 SES_ESTABLISHMENT_INCOMPLETE with details.missing otherwise", async (t) => {
    // This case WRITES through the pipeline: a queued row per parte when the
    // establishment profile is complete, or ONE blocked `failed` row
    // (SES_ESTABLISHMENT_INCOMPLETE, re-queued by the scheduler once the profile
    // is fixed) when it is not — exactly what a check-in does. Opt out on a box
    // whose SES history must stay untouched with INTEGRATION_SKIP_SES_WRITES=true.
    if (process.env.INTEGRATION_SKIP_SES_WRITES === "true") {
      t.skip("INTEGRATION_SKIP_SES_WRITES=true");
      return;
    }
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true" }, async () => {
      const session = await loginDemo(app);
      if (!session) {
        t.skip("demo login unavailable (reception@example.com / INTEGRATION_LOGIN_*)");
        return;
      }
      const headers = { authorization: `Bearer ${session.token}` };
      const fixture = await findReservationWithPartes(app, headers);
      if (!fixture) {
        t.skip("no reservation with partes de viajeros reachable through the API — run a check-in (or backfill:guest-register) to exercise this case");
        return;
      }
      const establishment = await getJson<{ ok: boolean; missing: string[] }>(app, `/properties/${fixture.propertyId}/ses/establishment`, headers);
      assert.ok(establishment, `GET /properties/${fixture.propertyId}/ses/establishment failed`);
      const res = await app.inject({
        method: "POST",
        url: `/properties/${fixture.propertyId}/ses/submissions`,
        headers,
        payload: { reservationId: fixture.reservationId }
      });
      if (establishment.ok) {
        assert.equal(res.statusCode, 200, `complete establishment → ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body) as {
          status: string;
          queued: number;
          submissions: Array<{ id: string; guestRegisterRecordId: string; submissionType: string; status: string }>;
          failed: unknown[];
        };
        assert.ok(["queued", "partial"].includes(body.status), `unexpected status ${body.status}`);
        assert.equal(body.queued, body.submissions.length);
        assert.equal(body.submissions.length + body.failed.length, fixture.partes, "one outcome per parte");
        assert.ok(body.submissions.length > 0, `nothing queued: ${res.body}`);
        for (const submission of body.submissions) {
          assert.match(submission.id, CUID, `submission id is not a persisted cuid: ${submission.id}`);
          assert.match(submission.guestRegisterRecordId, CUID);
          assert.ok(typeof submission.submissionType === "string" && submission.submissionType.length > 0);
          assert.equal(submission.status, "queued");
        }
      } else {
        assert.equal(res.statusCode, 409, `incomplete establishment (${establishment.missing.join(", ")}) → ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body) as {
          error: string;
          details?: { code?: string; missing?: string[]; submissionId?: string | null; status?: string; queued?: number; failed?: Array<{ code: string; submissionId: string | null }> };
        };
        assert.equal(body.error, "Conflict");
        assert.equal(body.details?.code, "SES_ESTABLISHMENT_INCOMPLETE");
        assert.deepEqual(body.details?.missing, establishment.missing, "details.missing must be the establishment's own list");
        assert.match(body.details?.submissionId ?? "", CUID, `blocked submission id is not a persisted cuid: ${String(body.details?.submissionId)}`);
        assert.equal(body.details?.status, "failed");
        assert.equal(body.details?.queued, 0);
        assert.equal(body.details?.failed?.length, fixture.partes, "one failed[] entry per parte");
        assert.ok(body.details?.failed?.every((entry) => entry.code === "SES_ESTABLISHMENT_INCOMPLETE" && CUID.test(entry.submissionId ?? "")));
      }
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
