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

/**
 * ses_hospedajes_submissions rows of the given partes (Tanda L5 · L5-B2: a
 * refusal never creates one, a blocked establishment leaves exactly one that
 * later calls reuse). Read straight from Prisma: the list route is paginated
 * per property and has no per-parte filter.
 */
async function countSesRows(recordIds: string[]): Promise<number> {
  if (recordIds.length === 0) return 0;
  const { prisma } = await import("@hotelos/database");
  return prisma.sesHospedajesSubmission.count({ where: { guestRegisterRecordId: { in: recordIds } } });
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
    // Tanda L2 (L2-01): /procurement/suppliers, /developer/webhooks and
    // /ai-governance/policies (memory-only or duplicated legs retired by L2-02)
    // were replaced by canonical GETs without :propertyId that stay.
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", RBAC_STRICT: "true" }, async () => {
      for (const url of [
        "/integrations/email/providers",
        "/webhooks/subscriptions",
        "/ai-operations/governance/policies",
        "/marketplace/listings",
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

  it("POST /properties/:id/ses/submissions with partes: every parte awaited — queued ids when valid, typed 409 (GUEST_REGISTER_INVALID without a row · SES_ESTABLISHMENT_INCOMPLETE with ONE reused row · SES_DISABLED) otherwise", async (t) => {
    // This case WRITES through the pipeline. Tanda L5 (L5-B2) made the queue
    // honest: an invalid parte (missing_data / ready_to_sign…) is refused with
    // 409 GUEST_REGISTER_INVALID and NO ses_hospedajes_submissions row (the
    // demo fixture prop_123 · grr_843b401b is missing_data, so this is the
    // branch the demo box exercises; before L5 every run left one more failed
    // row: 126 rows of the same parte); a valid parte with an incomplete
    // establishment leaves ONE blocked `failed` row that later calls REUSE
    // (same submissionId); a valid parte with a complete establishment is
    // queued (cuid ids). Opt out on a box whose SES history must stay
    // untouched with INTEGRATION_SKIP_SES_WRITES=true.
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
      const partes = await listPartes(app, fixture.reservationId, headers);
      const parteIds = new Set(partes.map((parte) => parte.id));
      const SENDABLE = new Set(["ready_to_submit", "signed", "corrected"]);
      const sendable = partes.filter((parte) => SENDABLE.has(parte.status)).length;
      const historical = partes.filter((parte) => ["accepted", "annulled", "expired"].includes(parte.status)).length;
      const rowsBefore = await countSesRows(partes.map((parte) => parte.id));
      const res = await app.inject({
        method: "POST",
        url: `/properties/${fixture.propertyId}/ses/submissions`,
        headers,
        payload: { reservationId: fixture.reservationId }
      });
      const rowsAfter = await countSesRows(partes.map((parte) => parte.id));
      if (res.statusCode === 200) {
        // Only reachable when at least one parte is sendable and the establishment is complete.
        assert.ok(establishment.ok, `200 with an incomplete establishment (${establishment.missing.join(", ")}): ${res.body}`);
        assert.ok(sendable > 0, `200 without a sendable parte (statuses ${partes.map((parte) => parte.status).join(", ")}): ${res.body}`);
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
          // The parte id is `grr_<16 hex>` when the API created it (lib/ids.ts createId, compliance.service)
          // and a cuid when seeded/backfilled: what matters is that it is ONE of the partes of the reservation.
          assert.ok(parteIds.has(submission.guestRegisterRecordId), `guestRegisterRecordId is not a parte of the reservation: ${submission.guestRegisterRecordId}`);
          assert.ok(typeof submission.submissionType === "string" && submission.submissionType.length > 0);
          assert.equal(submission.status, "queued");
        }
        return;
      }
      assert.equal(res.statusCode, 409, `establishment ${establishment.ok ? "complete" : `incomplete (${establishment.missing.join(", ")})`}, partes ${partes.map((parte) => parte.status).join(", ")} → ${res.statusCode}: ${res.body}`);
      const body = JSON.parse(res.body) as {
        error: string;
        details?: {
          code?: string;
          missing?: string[];
          submissionId?: string | null;
          status?: string;
          queued?: number;
          failed?: Array<{ guestRegisterRecordId: string; code: string; submissionId: string | null }>;
        };
      };
      assert.equal(body.error, "Conflict");
      assert.equal(body.details?.status, "failed");
      assert.equal(body.details?.queued, 0);
      assert.equal(body.details?.failed?.length, fixture.partes, "one failed[] entry per parte");
      const codes = new Set((body.details?.failed ?? []).map((entry) => entry.code));
      if (body.details?.code === "SES_QUEUE_FAILED") {
        assert.ok(codes.size > 1, `SES_QUEUE_FAILED only with mixed causes: ${res.body}`);
      } else {
        assert.equal(codes.size, 1, `a single-cause 409 carries that code: ${res.body}`);
        assert.ok(codes.has(body.details?.code ?? ""), `details.code must be the per-parte code: ${res.body}`);
      }
      for (const entry of body.details?.failed ?? []) {
        switch (entry.code) {
          case "GUEST_REGISTER_INVALID":
          case "GUEST_REGISTER_NOT_QUEUEABLE":
          case "SES_DISABLED":
            // Refused honestly: no row was created for this parte.
            assert.equal(entry.submissionId, null, `${entry.code} must not leave a row: ${res.body}`);
            break;
          case "SES_ESTABLISHMENT_INCOMPLETE":
          case "ISSUER_TAX_ID_MISSING":
            assert.ok(!establishment.ok, `${entry.code} with a complete establishment: ${res.body}`);
            assert.deepEqual(body.details?.missing, establishment.missing, "details.missing must be the establishment's own list");
            assert.match(entry.submissionId ?? "", CUID, `blocked submission id is not a persisted cuid: ${String(entry.submissionId)}`);
            break;
          case "SES_SUBMISSION_IN_FLIGHT":
            assert.match(entry.submissionId ?? "", CUID, `the open row id travels: ${String(entry.submissionId)}`);
            break;
          default:
            assert.fail(`unexpected per-parte code ${entry.code}: ${res.body}`);
        }
      }
      if (codes.has("GUEST_REGISTER_INVALID") || codes.has("GUEST_REGISTER_NOT_QUEUEABLE") || codes.has("SES_DISABLED")) {
        assert.ok(sendable + historical <= fixture.partes);
      }
      // No new rows for refused partes; at most ONE blocked row per parte for
      // the recoverable cause, and a second identical call reuses it.
      assert.ok(rowsAfter - rowsBefore <= fixture.partes, `rows grew by ${rowsAfter - rowsBefore} for ${fixture.partes} partes`);
      const refusedOnly = [...codes].every((code) => ["GUEST_REGISTER_INVALID", "GUEST_REGISTER_NOT_QUEUEABLE", "SES_DISABLED"].includes(code));
      if (refusedOnly) assert.equal(rowsAfter, rowsBefore, "a refusal never creates a ses_hospedajes_submissions row");
      if (codes.has("SES_ESTABLISHMENT_INCOMPLETE") || codes.has("ISSUER_TAX_ID_MISSING")) {
        const again = await app.inject({ method: "POST", url: `/properties/${fixture.propertyId}/ses/submissions`, headers, payload: { reservationId: fixture.reservationId } });
        assert.equal(again.statusCode, 409, again.body);
        const againBody = JSON.parse(again.body) as { details?: { failed?: Array<{ guestRegisterRecordId: string; code: string; submissionId: string | null }> } };
        const blockedIds = new Map((body.details?.failed ?? []).filter((entry) => entry.submissionId).map((entry) => [entry.guestRegisterRecordId, entry.submissionId]));
        for (const entry of againBody.details?.failed ?? []) {
          if (!blockedIds.has(entry.guestRegisterRecordId)) continue;
          assert.equal(entry.submissionId, blockedIds.get(entry.guestRegisterRecordId), "the blocked row is reused, never duplicated");
        }
        assert.equal(await countSesRows(partes.map((parte) => parte.id)), rowsAfter, "a repeated blocked call adds no row");
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

// ── Tanda 4 · rutas-cors ────────────────────────────────────────────────────
// AUTH-08 CORS allow-list (resolveCorsOrigins, lib/env.ts), the env contract
// on /health and POST /backoffice/properties/:propertyId/roles. Own app
// instance: the CORS policy is re-resolved per env change, the /auth/login
// budget of the main instance is left alone and the rejected-origin log set
// starts empty. The policy is evaluated per request, so withEnv on the booted
// app is enough to exercise both the dev fallback and the production rules.
describe("Tanda 4 · rutas-cors: CORS allow-list, /health env contract and role creation from a template", () => {
  let app: Awaited<ReturnType<typeof buildApiServer>>;
  const DEV_ENV = { NODE_ENV: "development", CORS_ALLOWED_ORIGINS: undefined, PILOT_PUBLIC_ORIGIN: undefined } as const;
  const PROD_ENV = {
    NODE_ENV: "production",
    HOTELOS_ALLOW_DEMO_AUTH: "false",
    CORS_ALLOWED_ORIGINS: "https://demo.ehotelos.com,https://app.cliente.com",
    PILOT_PUBLIC_ORIGIN: undefined
  } as const;

  const health = (headers: Headers = {}) => app.inject({ method: "GET", url: "/health", headers });
  const acao = (res: { headers: Record<string, unknown> }) => res.headers["access-control-allow-origin"];

  before(async () => {
    app = await buildApiServer();
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it("dev: reflects the exact allowed origin (localhost / LAN fallback) without Access-Control-Allow-Credentials", async () => {
    await withEnv({ ...DEV_ENV }, async () => {
      for (const origin of ["http://localhost:5173", "https://127.0.0.1:8443", "http://192.168.1.50:9999"]) {
        const res = await health({ origin });
        assert.equal(res.statusCode, 200);
        assert.equal(acao(res), origin, `dev fallback must allow ${origin}: ${JSON.stringify(res.headers)}`);
        assert.equal(res.headers["access-control-allow-credentials"], undefined, "credentials are never reflected (Bearer auth, no cookies)");
        assert.match(String(res.headers["vary"] ?? ""), /Origin/, "a dynamic origin answer must Vary: Origin");
      }
    });
  });

  it("dev: an origin outside the fallback and the list gets no CORS headers (the request itself still runs)", async () => {
    await withEnv({ ...DEV_ENV }, async () => {
      for (const origin of ["https://evil.example.com", "http://10.0.0.5:5173", "http://localhost.evil.com"]) {
        const res = await health({ origin });
        assert.equal(res.statusCode, 200, "CORS refusal is header-level: the handler still answers");
        assert.equal(acao(res), undefined, `${origin} must not receive Access-Control-Allow-Origin`);
      }
    });
  });

  it("dev: a preflight from an allowed origin answers 204 with the methods, headers and a 10-minute cache", async () => {
    await withEnv({ ...DEV_ENV }, async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/properties",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization" }
      });
      assert.equal(res.statusCode, 204, res.body);
      assert.equal(acao(res), "http://localhost:5173");
      assert.match(String(res.headers["access-control-allow-methods"]), /GET/);
      assert.match(String(res.headers["access-control-allow-headers"] ?? ""), /Authorization/i);
      assert.equal(res.headers["access-control-max-age"], "600");
      assert.equal(res.headers["access-control-allow-credentials"], undefined);
    });
  });

  it("production: only CORS_ALLOWED_ORIGINS (case-insensitive) is allowed; localhost and the LAN are closed", async () => {
    await withEnv({ ...PROD_ENV }, async () => {
      for (const origin of ["https://demo.ehotelos.com", "https://app.cliente.com", "https://Demo.Ehotelos.com"]) {
        const res = await health({ origin });
        assert.equal(res.statusCode, 200, `/health must stay public in production: ${res.body}`);
        // The allow-list match is case-insensitive; the header echoes the Origin exactly as sent (what browsers compare).
        assert.equal(acao(res), origin, `listed origin ${origin}: ${JSON.stringify(res.headers)}`);
        assert.equal(res.headers["access-control-allow-credentials"], undefined);
      }
      for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "http://192.168.1.50:9999", "https://evil.example.com", "https://demo.ehotelos.com.evil.com"]) {
        const res = await health({ origin });
        assert.equal(res.statusCode, 200);
        assert.equal(acao(res), undefined, `${origin} must be refused in production: ${JSON.stringify(res.headers)}`);
      }
      // No Origin header (curl, same-origin behind Caddy): nothing to reflect, request served.
      const bare = await health();
      assert.equal(bare.statusCode, 200);
      assert.equal(acao(bare), undefined);
    });
  });

  it("production: the deprecated PILOT_PUBLIC_ORIGIN alias is folded into the list by resolveCorsOrigins (contract A)", async () => {
    await withEnv({ ...PROD_ENV, CORS_ALLOWED_ORIGINS: undefined, PILOT_PUBLIC_ORIGIN: "https://legacy.example.com" }, async () => {
      const allowed = await health({ origin: "https://legacy.example.com" });
      assert.equal(acao(allowed), "https://legacy.example.com");
      const refused = await health({ origin: "https://demo.ehotelos.com" });
      assert.equal(acao(refused), undefined, "an origin only present in the previous env value must not leak through a stale policy");
    });
  });

  it("GET /health exposes env: { ok, warnings } as counts (top level and inside checks)", async () => {
    await withEnv({ ...DEV_ENV }, async () => {
      const res = await health();
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { env: { ok: boolean; warnings: number }; checks: { env: { ok: boolean; warnings: number; message?: string } } };
      assert.equal(typeof body.env.ok, "boolean");
      assert.ok(Number.isInteger(body.env.warnings) && body.env.warnings >= 0, `warnings must be a count: ${JSON.stringify(body.env)}`);
      assert.equal(body.checks.env.ok, body.env.ok);
      assert.equal(body.checks.env.warnings, body.env.warnings);
      assert.ok(!("errors" in body.env), "error texts must never be exposed on the public /health");
    });
  });

  it("POST …/roles: the token-less demo fallback is refused (401, riskLevel high) before any validation or DB access", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" }, async () => {
      const [propertyId] = await listPropertyIds(app);
      if (!propertyId) return t.skip("no property reachable through /properties");
      const res = await app.inject({
        method: "POST",
        url: `/backoffice/properties/${propertyId}/roles`,
        payload: { name: "Recepción T4", templateKey: "receptionist" }
      });
      assert.equal(res.statusCode, 401, res.body);
      assert.equal((JSON.parse(res.body) as { message: string }).message, "Authentication required.");
    });
  });

  it("POST …/roles: a real session gets 400 on a bad body (unknown template, short name) without touching the DB", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" }, async () => {
      const session = await loginDemo(app);
      if (!session) return t.skip("demo login unavailable (set INTEGRATION_LOGIN_EMAIL / INTEGRATION_LOGIN_PASSWORD)");
      const headers = { authorization: `Bearer ${session.token}` };
      const [propertyId] = await listPropertyIds(app, headers);
      if (!propertyId) return t.skip("no property reachable through /properties");
      const url = `/backoffice/properties/${propertyId}/roles`;
      const unknownTemplate = await app.inject({ method: "POST", url, headers, payload: { name: "Equipo noche", templateKey: "night-shift" } });
      assert.equal(unknownTemplate.statusCode, 400, unknownTemplate.body);
      assert.match((JSON.parse(unknownTemplate.body) as { message: string }).message, /templateKey/);
      assert.match((JSON.parse(unknownTemplate.body) as { message: string }).message, /receptionist/, "the 400 lists the valid template keys");
      const shortName = await app.inject({ method: "POST", url, headers, payload: { name: "R", templateKey: "receptionist" } });
      assert.equal(shortName.statusCode, 400, shortName.body);
      assert.match((JSON.parse(shortName.body) as { message: string }).message, /name/);
      const noBody = await app.inject({ method: "POST", url, headers, payload: {} });
      assert.equal(noBody.statusCode, 400, noBody.body);
    });
  });

  it("POST …/roles: creates the role with the template's grants (201), lists it for the invite selector, refuses the duplicate name (409) — and cleans up", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" }, async () => {
      const session = await loginDemo(app);
      if (!session) return t.skip("demo login unavailable (set INTEGRATION_LOGIN_EMAIL / INTEGRATION_LOGIN_PASSWORD)");
      const headers = { authorization: `Bearer ${session.token}` };
      const [propertyId] = await listPropertyIds(app, headers);
      if (!propertyId) return t.skip("no property reachable through /properties");
      const url = `/backoffice/properties/${propertyId}/roles`;
      // Unique per run (unique [organizationId, name]); removed at the end so
      // the demo dataset is left exactly as found.
      const name = `Rol T4 rutas-cors ${Date.now().toString(36)}`;
      const created = await app.inject({ method: "POST", url, headers, payload: { name, templateKey: "receptionist" } });
      if (created.statusCode === 403) return t.skip(`session lacks roles.manage: ${created.body}`);
      assert.equal(created.statusCode, 201, created.body);
      const role = JSON.parse(created.body) as { id: string; name: string; templateKey: string; permissionsCount: number };
      const { prisma } = await import("@hotelos/database");
      try {
        assert.equal(role.name, name);
        assert.equal(role.templateKey, "receptionist");
        assert.ok(role.permissionsCount > 0, `a template role must carry grants: ${created.body}`);
        // Persisted with the template key and the same number of grants.
        const row = await prisma.role.findUnique({ where: { id: role.id }, select: { templateKey: true, organizationId: true } });
        assert.equal(row?.templateKey, "receptionist");
        const grants = await prisma.rolePermission.count({ where: { roleId: role.id } });
        assert.equal(grants, role.permissionsCount);
        // Visible to the invite selector of the same property.
        const listed = (await getJson<Array<{ id: string; name: string; permissionsCount?: number }>>(app, url, headers)) ?? [];
        const mine = listed.find((entry) => entry.id === role.id);
        assert.ok(mine, `created role missing from GET ${url}`);
        assert.equal(mine.name, name);
        // Same name in the same organisation → 409 (contract B).
        const duplicate = await app.inject({ method: "POST", url, headers, payload: { name, templateKey: "manager" } });
        assert.equal(duplicate.statusCode, 409, duplicate.body);
        assert.equal((JSON.parse(duplicate.body) as { error: string }).error, "Conflict");
        assert.equal(await prisma.role.count({ where: { organizationId: row!.organizationId, name } }), 1, "the duplicate must not have created a second row");
      } finally {
        await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
        await prisma.role.deleteMany({ where: { id: role.id } });
      }
    });
  });
});

describe("Tanda 4 · cierre: reservation codes survive gaps and check-out tolerates a folio-less stay", () => {
  let app: ApiApp;
  before(async () => {
    app = await buildApiServer();
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  const isoDay = (offsetDays: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  /** A sellable, unblocked, unoccupied room whose type the reservation can book; null when the box has none. */
  async function findFreeRoom(): Promise<{ id: string; propertyId: string; roomTypeId: string; status: string; housekeepingStatus: string } | null> {
    const { prisma } = await import("@hotelos/database");
    const busy = await prisma.reservation.findMany({
      where: { assignedRoomId: { not: null }, status: { in: ["confirmed", "checked_in"] } },
      select: { assignedRoomId: true }
    });
    const busyIds = busy.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id));
    return prisma.room.findFirst({
      where: { active: true, sellable: true, status: { not: "occupied" }, maintenanceStatus: { not: "blocked" }, id: { notIn: busyIds } },
      select: { id: true, propertyId: true, roomTypeId: true, status: true, housekeepingStatus: true },
      orderBy: { number: "asc" }
    });
  }

  /** Hard-deletes a reservation created by these tests (no fiscal document ever attached). */
  async function deleteTestReservation(reservationId: string, guestId: string | null): Promise<void> {
    const { prisma } = await import("@hotelos/database");
    await prisma.guestRegisterRecord.deleteMany({ where: { reservationId } });
    await prisma.reservationGuest.deleteMany({ where: { reservationId } });
    await prisma.stay.deleteMany({ where: { reservationId } });
    await prisma.folio.deleteMany({ where: { reservationId } });
    await prisma.reservation.deleteMany({ where: { id: reservationId } });
    if (guestId) {
      const stillLinked = await prisma.reservationGuest.count({ where: { guestId } });
      if (stillLinked === 0) await prisma.guest.deleteMany({ where: { id: guestId } });
    }
  }

  it("POST /properties/:id/reservations allocates consecutive codes from MAX(code)+1, never count+1 (regresión T4)", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" }, async () => {
      const session = await loginDemo(app);
      if (!session) return t.skip("demo login unavailable (set INTEGRATION_LOGIN_EMAIL / INTEGRATION_LOGIN_PASSWORD)");
      const headers = { authorization: `Bearer ${session.token}` };
      const room = await findFreeRoom();
      if (!room) return t.skip("no sellable room on this box");
      const url = `/properties/${room.propertyId}/reservations`;
      const payload = (n: number) => ({
        arrivalDate: isoDay(30),
        departureDate: isoDay(32),
        roomTypeId: room.roomTypeId,
        bookerName: `AUDIT-IT cierre codes ${n}`,
        primaryGuest: { firstName: "Audit", lastName: `CierreCodes${n}` }
      });
      const created: Array<{ id: string; code: string; primaryGuestId: string | null }> = [];
      try {
        for (const n of [1, 2]) {
          const res = await app.inject({ method: "POST", url, headers, payload: payload(n) });
          assert.ok(res.statusCode === 200 || res.statusCode === 201, `${res.statusCode} ${res.body}`);
          created.push(JSON.parse(res.body) as { id: string; code: string; primaryGuestId: string | null });
        }
        const [first, second] = created;
        assert.match(first.code, /^RES-\d{5,}$/);
        assert.match(second.code, /^RES-\d{5,}$/);
        assert.notEqual(first.code, second.code);
        // Consecutive: the allocator takes MAX(suffix)+1 under an advisory lock,
        // so the second code is exactly the first plus one even when the
        // property's history has gaps (count+1 used to collide on RES-00036).
        assert.equal(Number(second.code.slice(4)), Number(first.code.slice(4)) + 1);
      } finally {
        for (const r of created) await deleteTestReservation(r.id, r.primaryGuestId);
      }
    });
  });

  it("POST /reservations/:id/check-out is 200 (folio: null) for an in-house reservation without folio; check-in opens the primary folio", async (t) => {
    await withEnv({ HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" }, async () => {
      const session = await loginDemo(app);
      if (!session) return t.skip("demo login unavailable (set INTEGRATION_LOGIN_EMAIL / INTEGRATION_LOGIN_PASSWORD)");
      const headers = { authorization: `Bearer ${session.token}` };
      const room = await findFreeRoom();
      if (!room) return t.skip("no sellable room on this box");
      const { prisma } = await import("@hotelos/database");
      const startedAt = new Date();
      const createRes = await app.inject({
        method: "POST",
        url: `/properties/${room.propertyId}/reservations`,
        headers,
        payload: {
          arrivalDate: isoDay(0),
          departureDate: isoDay(1),
          roomTypeId: room.roomTypeId,
          bookerName: "AUDIT-IT cierre check-out sin folio",
          primaryGuest: { firstName: "Audit", lastName: "CierreSinFolio" }
        }
      });
      assert.ok(createRes.statusCode === 200 || createRes.statusCode === 201, `${createRes.statusCode} ${createRes.body}`);
      const reservation = JSON.parse(createRes.body) as { id: string; primaryGuestId: string | null };
      try {
        const checkIn = await app.inject({
          method: "POST",
          url: `/reservations/${reservation.id}/check-in`,
          headers,
          payload: { roomId: room.id, allowEarlyCheckIn: true, overrideReason: "integration test (Tanda 4 cierre)" }
        });
        if (checkIn.statusCode === 403) return t.skip(`session cannot check in: ${checkIn.body}`);
        assert.equal(checkIn.statusCode, 200, checkIn.body);
        const checkInBody = JSON.parse(checkIn.body) as { status: string; folio?: { id: string; created: boolean } | null };
        assert.equal(checkInBody.status, "checked_in");
        assert.ok(checkInBody.folio && typeof checkInBody.folio.id === "string", `check-in must report the primary folio: ${checkIn.body}`);
        // Legacy shape: a stay that reached checked_in before Tanda 4 with no
        // folio at all (rooming-list imports). Reproduce it by removing the
        // folio underneath the in-house reservation.
        await prisma.folio.deleteMany({ where: { reservationId: reservation.id } });
        const checkOut = await app.inject({ method: "POST", url: `/reservations/${reservation.id}/check-out`, headers, payload: {} });
        assert.equal(checkOut.statusCode, 200, checkOut.body);
        const out = JSON.parse(checkOut.body) as { reservation: { status: string }; folio: unknown; folios: unknown[]; warnings: string[] };
        assert.equal(out.reservation.status, "checked_out");
        assert.equal(out.folio, null);
        assert.deepEqual(out.folios, []);
        assert.ok(!out.warnings.includes("folio_close_failed"), `unexpected warning: ${checkOut.body}`);
        const row = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { status: true } });
        assert.equal(row?.status, "checked_out");
      } finally {
        // Leave the room and the housekeeping board as found: the departure
        // task created by the check-out and the room status flip are undone.
        const tasks = await prisma.housekeepingTask.findMany({ where: { roomId: room.id, createdAt: { gte: startedAt } }, select: { id: true } });
        await prisma.housekeepingEvent.deleteMany({ where: { taskId: { in: tasks.map((task) => task.id) } } });
        await prisma.housekeepingTask.deleteMany({ where: { id: { in: tasks.map((task) => task.id) } } });
        await prisma.room.update({ where: { id: room.id }, data: { status: room.status as never, housekeepingStatus: room.housekeepingStatus as never } });
        await deleteTestReservation(reservation.id, reservation.primaryGuestId);
      }
    });
  });
});
