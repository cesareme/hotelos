import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Route-permission manifest contract (AUTH-03, audit 2026-09-13).
 *
 * Static, no-DB check that runs in the `contract-tests` CI job (`pnpm test`).
 * It extracts EVERY route the API registers (server.ts + routes/*.ts, all HTTP
 * methods, double/single/backtick quotes and the `*_ROUTE_TEMPLATES` loops)
 * and asserts set equality with `routePermissionManifest`:
 *   (a) every registered route has an exact method+path entry — GET included;
 *       the preHandler runs on public routes too, so they need an entry,
 *   (b) every manifest entry corresponds to a registered route (no orphans),
 *   (c) the manifest has no duplicate method+path (findRoutePermission is
 *       first-wins, so a duplicate is dead code that misleads reviewers),
 *   (d) every permission key exists in PERMISSIONS (packages/shared); a key
 *       carrying an explicit `as PermissionKey` cast is the documented
 *       exception while it is being added to the canonical union.
 * A registration the extractor cannot read (non-literal first argument
 * outside a recognised template loop) fails the suite instead of slipping by.
 */

const apiSrcDir = new URL("../apps/api/src/", import.meta.url);
const readApi = (relative) => readFileSync(new URL(relative, apiSrcDir), "utf8");

const server = readApi("server.ts");
const routeFiles = [
  ...readdirSync(new URL("routes/", apiSrcDir))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({ file: `routes/${name}`, source: readApi(`routes/${name}`) })),
  // Rate grid v2 convention: a module registers its own routes in
  // modules/<module>/*.routes.ts (registerXRoutes(app)); they are part of the
  // inventory exactly like routes/*.ts.
  ...readdirSync(new URL("modules/", apiSrcDir))
    .flatMap((mod) => {
      let names = [];
      try { names = readdirSync(new URL(`modules/${mod}/`, apiSrcDir)); } catch { return []; }
      return names.filter((name) => name.endsWith(".routes.ts")).sort().map((name) => `modules/${mod}/${name}`);
    })
    .sort()
    .map((relative) => ({ file: relative, source: readApi(relative) }))
];
// Rate grid v2 convention: modules contribute their manifest entries from
// modules/<module>/route-permissions.partial.ts (spread into the manifest), so
// the parser reads the main file plus every partial. Finanzas (2026-09-16): a
// module that hosts several lotes may carry several partials
// (modules/accounting: route-permissions.partial.ts for the ledger routes and
// fiscal-route-permissions.partial.ts for /fiscal/*), so any
// `*route-permissions.partial.ts` counts.
const manifestPartials = readdirSync(new URL("modules/", apiSrcDir))
  .flatMap((mod) => {
    try {
      return readdirSync(new URL(`modules/${mod}/`, apiSrcDir))
        .filter((name) => name.endsWith("route-permissions.partial.ts"))
        .map((name) => `modules/${mod}/${name}`);
    } catch {
      return [];
    }
  })
  .sort();
const manifestSource = readApi("security/route-permissions.ts");
const manifestSources = [
  { file: "security/route-permissions.ts", source: manifestSource },
  ...manifestPartials.map((relative) => ({ file: relative, source: readApi(relative) }))
];
const authContextSource = readApi("lib/auth-context.ts");
const permissionsSource = readFileSync(new URL("../packages/shared/src/permissions.ts", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/api-contracts.md", import.meta.url), "utf8");

const lineOf = (source, index) => source.slice(0, index).split("\n").length;
const routeKey = (route) => `${route.method} ${route.path}`;

// Blank out whole-line `//` comments (line count preserved) so a commented-out
// registration is not counted as a live route.
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

function extractRoutes(rawSource, file) {
  const source = stripLineComments(rawSource);
  const routes = [];
  const templateLoopVars = new Set();

  // Loop registrations:
  //   const X_ROUTE_TEMPLATES = ["...", ...] as const;
  //   for (const t of X_ROUTE_TEMPLATES) { app.<method>(t, ...
  const loopPattern =
    /const\s+(\w+_ROUTE_TEMPLATES)\s*=\s*\[([^\]]*)\]\s*as const;\s*for\s*\(\s*const\s+(\w+)\s+of\s+\1\s*\)\s*\{\s*app\.(get|post|patch|delete|put)\(\s*\3\b/g;
  for (const match of source.matchAll(loopPattern)) {
    templateLoopVars.add(match[3]);
    const line = lineOf(source, match.index);
    for (const template of match[2].matchAll(/["'`]([^"'`]+)["'`]/g)) {
      routes.push({ method: match[4].toUpperCase(), path: template[1], file, line });
    }
  }

  // Literal registrations: app.<method>("...") | ('...') | (`...`).
  const literalPattern = /\bapp\.(get|post|patch|delete|put)\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(literalPattern)) {
    routes.push({ method: match[1].toUpperCase(), path: match[3], file, line: lineOf(source, match.index) });
  }

  // Anything else — a first argument that is neither a string literal nor a
  // recognised template-loop variable — is reported so the suite fails loudly.
  const dynamicPattern = /\bapp\.(get|post|patch|delete|put)\(\s*([A-Za-z_$][\w$.]*)/g;
  const unsupported = [];
  for (const match of source.matchAll(dynamicPattern)) {
    if (!templateLoopVars.has(match[2])) {
      unsupported.push(`${file}:${lineOf(source, match.index)} app.${match[1]}(${match[2]}…)`);
    }
  }

  return { routes, unsupported };
}

function parseManifest(rawSource, file = "security/route-permissions.ts") {
  // Same treatment as extractRoutes: a commented-out entry (`// NOTE: { method:
  // "POST", path: … }`) is NOT part of the manifest. Without this, a comment
  // quoting an entry satisfied check (a) while the live route stayed unmapped
  // (DR-01: POST /channel-manager/_sandbox/:provider answered 403 with the
  // suite green). Line count is preserved by stripLineComments, so `line`
  // below still points at the real source line.
  const source = stripLineComments(rawSource);
  // The main file declares `routePermissionManifest`; a module partial declares
  // `export const <name>: ApiRoutePermission[] = [ … ]` (same entry shape).
  const declMatch = /export const \w+(?:: ApiRoutePermission\[\])? = \[/.exec(source);
  const start = file === "security/route-permissions.ts" ? source.indexOf("export const routePermissionManifest") : (declMatch ? declMatch.index : -1);
  const end = source.indexOf("\n];", start);
  assert.ok(start >= 0 && end > start, `permission manifest array not found in ${file}`);
  const body = source.slice(start, end);
  const entries = [];
  const entryPattern =
    /\{\s*method:\s*"(GET|POST|PATCH|DELETE|PUT)"\s*,\s*path:\s*"([^"]+)"\s*,\s*permissions:\s*\[([^\]]*)\]\s*,\s*riskLevel:\s*"(\w+)"\s*\}/g;
  for (const match of body.matchAll(entryPattern)) {
    const permissions = [...match[3].matchAll(/"([^"]+)"(\s+as\s+PermissionKey)?/g)].map((p) => ({
      key: p[1],
      cast: Boolean(p[2])
    }));
    entries.push({
      method: match[1],
      path: match[2],
      permissions,
      riskLevel: match[4],
      line: lineOf(source, start + match.index)
    });
  }
  const declared = (body.match(/\bmethod:\s*"/g) ?? []).length;
  assert.equal(
    entries.length,
    declared,
    `manifest parser matched ${entries.length} of ${declared} entries — an entry deviates from the ` +
      `{ method, path, permissions, riskLevel } shape`
  );
  return entries;
}

function permissionCatalog(source) {
  const start = source.indexOf("export const PERMISSIONS");
  const end = source.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, "PERMISSIONS map not found in packages/shared/src/permissions.ts");
  return new Set([...source.slice(start, end).matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
}

const extracted = [{ file: "server.ts", source: server }, ...routeFiles].map(({ file, source }) => ({
  file,
  ...extractRoutes(source, file)
}));
const registered = extracted.flatMap((x) => x.routes);
const unsupported = extracted.flatMap((x) => x.unsupported);
const manifest = manifestSources.flatMap(({ file, source }) => parseManifest(source, file).map((entry) => ({ ...entry, file })));
const catalog = permissionCatalog(permissionsSource);

// PUBLIC_PREFIXES of lib/auth-context.ts (the routes the staff auth hook lets
// through without a bearer). Matched exactly like isPublicRoute: the prefix
// itself or a sub-path of it.
const publicPrefixes = [
  ...authContextSource
    .slice(authContextSource.indexOf("const PUBLIC_PREFIXES"), authContextSource.indexOf("];", authContextSource.indexOf("const PUBLIC_PREFIXES")))
    .matchAll(/"([^"]+)"/g)
].map((m) => m[1]);
const isPublicPath = (path) => publicPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

describe("API route permission manifest (AUTH-03)", () => {
  it("extracts a credible route inventory from server.ts and routes/*.ts", () => {
    assert.deepEqual(
      unsupported,
      [],
      `route registrations the extractor cannot read (use a string literal or a *_ROUTE_TEMPLATES loop):\n${unsupported.join("\n")}`
    );
    assert.ok(registered.length > 700, `only ${registered.length} routes extracted — the extractor regressed`);
    for (const { file, routes } of extracted) {
      assert.ok(routes.length > 0, `no routes extracted from ${file}`);
    }
    const has = (method, path) => registered.some((r) => r.method === method && r.path === path);
    // Rate grid v2: the template-loop channel routes were retired; the module
    // route files (modules/<module>/*.routes.ts) must be part of the inventory.
    assert.ok(
      has("GET", "/properties/:propertyId/channels") && has("POST", "/properties/:propertyId/rate-grid/bulk-update"),
      "module *.routes.ts registrations (channel-manager, rate-manager) not extracted"
    );
    assert.ok(has("GET", "/admin/tenants"), "single-quoted registrations not extracted");
    assert.ok(has("GET", "/webhooks/subscriptions"), "routes/*.ts plugin registrations not extracted");
  });

  it("(a) every registered route has an exact method+path manifest entry — GET included", () => {
    const keys = new Set(manifest.map(routeKey));
    const missing = registered
      .filter((route) => !keys.has(routeKey(route)))
      .map((route) => `${routeKey(route)}  (${route.file}:${route.line})`);
    assert.deepEqual(
      missing,
      [],
      `registered routes without a manifest entry — add them to routePermissionManifest:\n${missing.join("\n")}`
    );
  });

  it("(a′) every registered route under PUBLIC_PREFIXES has a riskLevel \"public\" manifest entry (a token-less route can never be gated by the manifest)", () => {
    // The auth hook lets these requests through WITHOUT a session, so the
    // permission preHandler evaluates them against an EMPTY permission set:
    // anything but an explicit `public` entry (none in strict mode, or a
    // permission-carrying entry) turns the route into a 403 for everyone.
    // DR-01: POST /channel-manager/_sandbox/:provider was registered and
    // listed in PUBLIC_PREFIXES while its manifest entry was only a comment.
    assert.ok(publicPrefixes.length >= 10, "PUBLIC_PREFIXES not parsed");
    const byKey = new Map(manifest.map((entry) => [routeKey(entry), entry]));
    const problems = registered
      .filter((route) => isPublicPath(route.path))
      .map((route) => {
        const entry = byKey.get(routeKey(route));
        if (!entry) return `${routeKey(route)}  has no manifest entry (${route.file}:${route.line})`;
        if (entry.riskLevel !== "public") return `${routeKey(route)}  mapped ${entry.riskLevel} with ${JSON.stringify(entry.permissions.map((p) => p.key))} (${entry.file}:${entry.line})`;
        return null;
      })
      .filter(Boolean);
    assert.deepEqual(problems, [], `public-prefix routes that the manifest would gate:\n${problems.join("\n")}`);
  });

  it("(b) every manifest entry corresponds to a registered route — no orphans", () => {
    const keys = new Set(registered.map(routeKey));
    const orphans = manifest
      .filter((entry) => !keys.has(routeKey(entry)))
      .map((entry) => `${routeKey(entry)}  (route-permissions.ts:${entry.line})`);
    assert.deepEqual(orphans, [], `manifest entries with no registered route:\n${orphans.join("\n")}`);
  });

  it("(c) the manifest has no duplicate method+path entries (lookup is first-wins)", () => {
    const seen = new Map();
    const duplicates = [];
    for (const entry of manifest) {
      const key = routeKey(entry);
      if (seen.has(key)) duplicates.push(`${key}  line ${entry.line} duplicates line ${seen.get(key)}`);
      else seen.set(key, entry.line);
    }
    assert.deepEqual(duplicates, [], `duplicate manifest entries (only the first applies):\n${duplicates.join("\n")}`);
  });

  it("(d) every manifest permission key exists in PERMISSIONS (packages/shared)", () => {
    const unknown = [];
    const pendingCasts = new Set();
    for (const entry of manifest) {
      for (const permission of entry.permissions) {
        if (catalog.has(permission.key)) continue;
        if (permission.cast) pendingCasts.add(permission.key);
        else unknown.push(`${permission.key}  (${routeKey(entry)}, route-permissions.ts:${entry.line})`);
      }
    }
    assert.deepEqual(unknown, [], `permission keys missing from PERMISSIONS:\n${unknown.join("\n")}`);
    for (const key of pendingCasts) {
      console.warn(`[manifest] "${key}" is cast to PermissionKey but missing from PERMISSIONS — add it to packages/shared and drop the cast`);
    }
    assert.ok(manifest.every((entry) => entry.riskLevel !== "public" || entry.permissions.length === 0),
      "a riskLevel \"public\" entry must not require permissions");
  });

  it("is enforced by the API pre-handler with default-deny permissions", () => {
    assert.match(server, /assertRoutePermission/);
    assert.match(server, /app\.addHook\("preHandler"/);
    // Audit 2026-06 · NUEVO-2: no userContext => empty permission set (deny),
    // never the demoStore super-user.
    assert.match(server, /userContext\?\.permissions \?\? \[\]/);
  });

  it("skips the permission gate for unknown routes so they stay 404 in strict mode (is404 guard)", () => {
    // Root-level preHandler hooks also run for the not-found handler. Without
    // this guard an unknown URL has no routeOptions.url, is looked up in the
    // manifest as-is, and RBAC_STRICT=true turns every 404 into a manifest 403
    // (leaking which paths exist and confusing clients). The guard must sit
    // BEFORE assertRoutePermission inside the permission preHandler.
    const gateCall = server.indexOf("assertRoutePermission({");
    assert.ok(gateCall >= 0, "assertRoutePermission({ call not found in server.ts");
    const hookStart = server.lastIndexOf('app.addHook("preHandler"', gateCall);
    assert.ok(hookStart >= 0, "permission preHandler hook not found before assertRoutePermission");
    const hookHead = server.slice(hookStart, gateCall);
    assert.match(
      hookHead,
      /if \(request\.is404\) return;/,
      `permission preHandler must start with \`if (request.is404) return;\` (server.ts:${lineOf(server, hookStart)})`
    );
  });

  it("fails closed: unmapped mutations always 403, unmapped GET 403 in strict mode (default in production)", () => {
    assert.match(manifestSource, /export function isRbacStrictMode/);
    assert.match(manifestSource, /process\.env\.RBAC_STRICT/);
    assert.match(manifestSource, /process\.env\.NODE_ENV === "production"/);
    assert.match(manifestSource, /if \(isRbacStrictMode\(\)\) \{\s*throw unmappedRouteError\(method, input\.path\)/);
    assert.match(manifestSource, /new ForbiddenError\(/);
  });

  it("keeps the email OAuth callback public in both the manifest and the staff auth hook", () => {
    const entry = manifest.find((e) => routeKey(e) === "GET /integrations/email/oauth/callback");
    assert.ok(entry, "GET /integrations/email/oauth/callback missing from the manifest");
    assert.equal(entry.riskLevel, "public");
    assert.deepEqual(entry.permissions, []);
    assert.match(authContextSource, /"\/integrations\/email\/oauth\/callback"/);
  });

  it("refuses to boot with the demo auth fallback in production (AUTH-04)", () => {
    assert.match(authContextSource, /export function assertDemoAuthPolicy/);
    assert.match(authContextSource, /HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción/);
    assert.match(authContextSource, /HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE === "true"/);
    // Wired inside registerAuthContext so buildApiServer / app.inject enforce it.
    const registerBody = authContextSource.slice(authContextSource.indexOf("export function registerAuthContext"));
    assert.match(registerBody, /assertDemoAuthPolicy\(\)/);
  });

  it("protects critical money, compliance, and inventory routes", () => {
    for (const expected of [
      'path: "/payments/:id/refund"',
      '"payment.refund", "ai.high_risk.confirm"',
      'path: "/invoices/:id/issue"',
      'permissions: ["invoice.issue"]',
      'path: "/journal-entries/:id/post"',
      '"accounting.journal.post", "ai.high_risk.confirm"',
      'path: "/work-orders/:id/block-room"',
      '"maintenance.workorder.manage", "ai.high_risk.confirm"',
      'path: "/ai/confirmations/:confirmationId/execute"',
      '"ai.tool.execute", "pms.checkin.execute"',
      'path: "/guest-register-records/:id/queue-ses"',
      'permissions: ["compliance.ses.submit"]'
    ]) {
      assert.match(manifestSource, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("documents the route permission policy", () => {
    assert.match(docs, /Route Permissions/);
    assert.match(docs, /Every registered route/);
    assert.match(docs, /RBAC_STRICT/);
    assert.match(docs, /service-level validation/);
  });
});

// ── Tanda 3 · server-rutas (cumplimiento sin atrezzo) ───────────────────────
// The routes added for the indirect-tax profile, SES establishment/history,
// the staff upsell catalogue and persisted staff invitations must be mapped
// with the permissions agreed in the batch brief; the generic (a)/(b) checks
// above already guarantee they are registered and not orphaned.
const TANDA3_ROUTES = [
  ["GET", "/backoffice/properties/:propertyId/taxes", ["compliance.configure"], "medium"],
  ["PUT", "/backoffice/properties/:propertyId/taxes/rates", ["compliance.configure"], "high"],
  ["POST", "/backoffice/properties/:propertyId/taxes/provision", ["compliance.configure"], "high"],
  ["GET", "/properties/:propertyId/ses/submissions", ["guest_register.read"], "medium"],
  ["GET", "/properties/:propertyId/ses/establishment", ["guest_register.read"], "medium"],
  ["GET", "/properties/:propertyId/upsell-offers", ["guest_self_service.read"], "low"],
  ["POST", "/properties/:propertyId/upsell-offers", ["guest_self_service.manage"], "medium"],
  ["PATCH", "/upsell-offers/:id", ["guest_self_service.manage"], "medium"],
  ["POST", "/backoffice/properties/:propertyId/users/invite", ["users.invite"], "high"],
  ["GET", "/backoffice/properties/:propertyId/roles", ["users.invite"], "medium"],
  ["POST", "/backoffice/properties/:propertyId/users/:userId/reissue-invite", ["users.invite"], "high"],
  ["POST", "/admin/tenants/:orgId/users/:userId/reissue-invite", ["admin.tenants.manage"], "critical"],
  ["GET", "/notifications/email-status", ["users.invite"], "low"],
  ["GET", "/auth/invitations/:token", [], "public"],
  ["POST", "/auth/accept-invite", [], "public"]
];

describe("Tanda 3 · server-rutas: manifest entries, public invitation leg and guards", () => {
  it("maps every Tanda 3 route with the agreed permissions and risk level", () => {
    const mismatches = [];
    for (const [method, path, permissions, riskLevel] of TANDA3_ROUTES) {
      const entry = manifest.find((e) => e.method === method && e.path === path);
      if (!entry) {
        mismatches.push(`${method} ${path}: missing from routePermissionManifest`);
        continue;
      }
      const actual = entry.permissions.map((p) => p.key);
      if (JSON.stringify(actual) !== JSON.stringify(permissions) || entry.riskLevel !== riskLevel) {
        mismatches.push(
          `${method} ${path}: expected ${JSON.stringify(permissions)}/${riskLevel}, got ${JSON.stringify(actual)}/${entry.riskLevel}`
        );
      }
    }
    assert.deepEqual(mismatches, [], `Tanda 3 manifest drift:\n${mismatches.join("\n")}`);
  });

  it("accepts PUT registrations (manifest type + extractor)", () => {
    assert.match(manifestSource, /method:\s*"GET"\s*\|\s*"POST"\s*\|\s*"PATCH"\s*\|\s*"DELETE"\s*\|\s*"PUT"/);
    assert.ok(
      registered.some((r) => r.method === "PUT" && r.path === "/backoffice/properties/:propertyId/taxes/rates"),
      "PUT /backoffice/properties/:propertyId/taxes/rates not extracted from server.ts"
    );
  });

  it("keeps the invitation leg public in both the manifest and the staff auth hook", () => {
    // Manifest 'public' is not enough: without PUBLIC_PREFIXES the auth hook
    // answers 401 as soon as HOTELOS_ALLOW_DEMO_AUTH is off (recon
    // invitaciones-usuarios · "Rutas públicas de auth no están en PUBLIC_PREFIXES").
    for (const prefix of ["/auth/invitations", "/auth/accept-invite"]) {
      assert.match(
        authContextSource,
        new RegExp(`"${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
        `${prefix} missing from PUBLIC_PREFIXES in lib/auth-context.ts`
      );
    }
    assert.match(
      server,
      /app\.post\("\/auth\/accept-invite",\s*\{\s*config:\s*\{\s*rateLimit:\s*\{\s*max:\s*5/,
      "POST /auth/accept-invite must carry the 5/min hard limit like /auth/reset-password"
    );
  });

  it("gates temp-password sessions with PASSWORD_CHANGE_REQUIRED after the auth context, honouring is404 and the allowlist", () => {
    const authAt = server.indexOf("registerAuthContext(app);");
    const guardAt = server.indexOf("throw passwordChangeRequiredError();");
    const permissionGateAt = server.indexOf("assertRoutePermission({");
    assert.ok(authAt >= 0 && guardAt > authAt, "PASSWORD_CHANGE_REQUIRED guard must sit after registerAuthContext(app)");
    assert.ok(guardAt < permissionGateAt, "PASSWORD_CHANGE_REQUIRED guard must run before the permission gate");
    const hookStart = server.lastIndexOf('app.addHook("preHandler"', guardAt);
    const hookBody = server.slice(hookStart, guardAt);
    assert.match(hookBody, /if \(request\.is404\) return;/, "guard must short-circuit unknown routes (404)");
    assert.match(hookBody, /request\.isAuthenticated/, "guard must only apply to real sessions");
    assert.match(hookBody, /mustChangePassword/, "guard must read userContext.mustChangePassword");
    assert.match(hookBody, /request\.routeOptions\.url/, "guard must match the route template, not the raw URL");
    assert.match(hookBody, /isPasswordChangeAllowedRoute\(/, "guard must honour PASSWORD_CHANGE_ALLOWLIST through isPasswordChangeAllowedRoute");
    assert.match(
      server,
      /isPasswordChangeAllowedRoute,[^;]*passwordChangeRequiredError,[^;]*from "\.\/lib\/auth-context\.js"/,
      "allowlist helper and error builder must come from lib/auth-context.ts"
    );
    // The allowlist, the code and the 403 live next to each other in the auth
    // module (lote invitaciones); the guard only decides WHEN to throw.
    assert.match(authContextSource, /export const PASSWORD_CHANGE_ALLOWLIST/, "lib/auth-context.ts must export PASSWORD_CHANGE_ALLOWLIST");
    assert.match(authContextSource, /export function isPasswordChangeAllowedRoute/);
    assert.match(authContextSource, /export function passwordChangeRequiredError/);
    assert.match(authContextSource, /"PASSWORD_CHANGE_REQUIRED"/);
  });

  it("refuses to boot outside sandbox with an invalid VeriFactu SistemaInformatico block and exposes it on /health", () => {
    const startAt = server.indexOf("const app = await buildApiServer();");
    const listenAt = server.indexOf("await app.listen({ port, host });");
    assert.ok(startAt >= 0 && listenAt > startAt, "start() block not found");
    const boot = server.slice(startAt, listenAt);
    assert.match(boot, /resolveVerifactuSoftware\(\)/, "boot must validate the software block");
    assert.match(boot, /verifactuMode !== "sandbox"/, "fail-fast only outside sandbox");
    assert.match(boot, /process\.exit\(1\)/, "invalid block outside sandbox must abort the boot");
    assert.match(boot, /app\.log\.warn\(/, "sandbox must only warn");
    const healthAt = server.indexOf('app.get("/health"');
    const healthBody = server.slice(healthAt, server.indexOf('app.get("/metrics"', healthAt));
    assert.match(healthBody, /software:\s*\{\s*ok:\s*verifactuSoftware\.ok,\s*errors:\s*verifactuSoftware\.errors\s*\}/);
  });

  it("documents the Tanda 3 routes", () => {
    for (const expected of [
      "/backoffice/properties/:propertyId/taxes",
      "/properties/:propertyId/ses/establishment",
      "/properties/:propertyId/upsell-offers",
      "/auth/accept-invite",
      "PASSWORD_CHANGE_REQUIRED",
      "SES_ESTABLISHMENT_INCOMPLETE"
    ]) {
      assert.ok(docs.includes(expected), `docs/api-contracts.md must mention ${expected}`);
    }
  });
});

// ── Tanda 3 · cierre (server-rutas) ─────────────────────────────────────────
// Static pins for the closing fixes; the behaviour itself is exercised by
// tests/integration/api-integration.test.mts (app.inject against Postgres).

/** Source of one inline route handler: from its registration to the first `\n  });` (2-space close). */
function handlerSource(registration) {
  const start = server.indexOf(registration);
  assert.ok(start >= 0, `${registration} not found in server.ts`);
  const end = server.indexOf("\n  });", start);
  assert.ok(end > start, `end of ${registration} not found`);
  return server.slice(start, end);
}

describe("Tanda 3 · cierre (server-rutas): dangling promises, process guards, demo gate, pagination", () => {
  it("awaits every SES parte under its own try/catch in POST /properties/:propertyId/ses/submissions", () => {
    // The unawaited `records.map(queueSesHospedajesSubmission(...))` returned
    // empty promises and turned every 409 into an unhandledRejection that took
    // the :3000 process down (verificación adversarial T3).
    const handler = handlerSource('app.post("/properties/:propertyId/ses/submissions"');
    assert.doesNotMatch(handler, /records\.map\(/, "partes must be iterated sequentially, not mapped to promises");
    assert.match(handler, /for \(const record of records\) \{[\s\S]*try \{[\s\S]*await queueSesHospedajesSubmission\(\{[\s\S]*\} catch \(error\) \{/);
    assert.match(handler, /if \(!\(error instanceof HttpError\)\) throw error;/, "only typed HTTP errors are per-parte outcomes (honest catch)");
    assert.match(handler, /request\.log\.warn\(/, "a failed parte must be logged with correlation");
    for (const expected of ["SES_NO_GUEST_REGISTER_RECORDS", "SES_QUEUE_FAILED", "submissions.length === 0", 'status: "failed"', "failed"]) {
      assert.ok(handler.includes(expected), `SES handler must carry ${expected}`);
    }
    assert.doesNotMatch(handler, /"no_records"/, "a reservation without partes is a typed 409, not a 200");
  });

  it("installs unhandledRejection / uncaughtException guards on the listen path only (never inside buildApiServer)", () => {
    const startAt = server.indexOf("const app = await buildApiServer();");
    const listenAt = server.indexOf("await app.listen({ port, host });");
    assert.ok(startAt >= 0 && listenAt > startAt, "start() block not found");
    const boot = server.slice(startAt, listenAt);
    const rejectionAt = boot.indexOf('process.on("unhandledRejection"');
    const exceptionAt = boot.indexOf('process.on("uncaughtException"');
    assert.ok(rejectionAt >= 0, "unhandledRejection guard missing");
    assert.ok(exceptionAt > rejectionAt, "uncaughtException guard missing (or ordered before the rejection one)");
    const rejectionHandler = boot.slice(rejectionAt, exceptionAt);
    assert.match(rejectionHandler, /app\.log\.error\(\{ err: reason \}/, "the rejection must be logged with its trace");
    assert.doesNotMatch(rejectionHandler, /process\.exit/, "an unhandled rejection must NOT exit the process");
    const exceptionHandler = boot.slice(exceptionAt, boot.indexOf("// Tanda 3 (verifactu)", exceptionAt));
    assert.match(exceptionHandler, /app\.log\.fatal\(\{ err: error \}/);
    assert.match(exceptionHandler, /setTimeout\(exit, /, "uncaughtException must exit(1) deferred, after the trace is flushed");
    assert.match(exceptionHandler, /process\.exit\(1\)/);
    assert.match(boot, /reportProcessErrorToSentry/, "both guards report to Sentry when configured");
    // buildApiServer is what tests boot: it must not touch process handlers.
    const build = server.slice(server.indexOf("export async function buildApiServer"), startAt);
    assert.doesNotMatch(build, /process\.on\("unhandledRejection"|process\.on\("uncaughtException"/);
  });

  it("refuses the token-less demo fallback on high/critical routes inside the permission preHandler (H1)", () => {
    const gateCall = server.indexOf("assertRoutePermission({");
    const hookStart = server.lastIndexOf('app.addHook("preHandler"', gateCall);
    const hookHead = server.slice(hookStart, gateCall);
    assert.match(hookHead, /if \(request\.is404\) return;/, "is404 short-circuit must stay first");
    assert.match(hookHead, /if \(!request\.isAuthenticated\) \{/, "gate must key on the fallback flag, not on the token header");
    assert.match(hookHead, /routeRiskLevel\(request\.method, routePath\)/);
    assert.match(hookHead, /risk === "high" \|\| risk === "critical"/);
    assert.match(hookHead, /throw new UnauthorizedError\("Authentication required\."\)/);
    assert.match(server, /import \{ assertRoutePermission, routeRiskLevel \} from "\.\/security\/route-permissions\.js"/);
    assert.match(manifestSource, /export type RiskLevel = ApiRoutePermission\["riskLevel"\];/);
    assert.match(manifestSource, /export function routeRiskLevel\(method: string, path: string\): RiskLevel \| null \{/);
    // Every PUBLIC_PREFIXES route is riskLevel "public": the gate can never
    // reach a token-less public route (guest portal, login, oauth callback…).
    // (a′) above already requires the exact `public` entry; this keeps the
    // narrower H1 invariant explicit next to the gate it protects.
    assert.ok(publicPrefixes.length >= 10, "PUBLIC_PREFIXES not parsed");
    const gatedPublic = manifest.filter((entry) => isPublicPath(entry.path) && (entry.riskLevel === "high" || entry.riskLevel === "critical"));
    assert.deepEqual(gatedPublic.map(routeKey), [], "a public-prefix route mapped high/critical would be refused without a token");
  });

  it("documents H4 (anonymous unknown path → 401 in production, anti-enumeration) next to the auth gate", () => {
    const registerBody = authContextSource.slice(authContextSource.indexOf("export function registerAuthContext"));
    assert.match(registerBody, /H4 \(Tanda 3 · cierre/);
    assert.match(registerBody, /anti-enumeration/);
    assert.match(registerBody, /if \(!allowDemoFallback && !isPublicRoute\(request\.url\)\) \{\s*throw Object\.assign\(new Error\("Authentication required\."\), \{ statusCode: 401 \}\);/);
  });

  it("forwards taxCategory from CreateFolioLineSchema to postFolioLine (H2)", () => {
    const handler = handlerSource('app.post("/folios/:id/lines"');
    assert.match(handler, /taxCategory: body\.taxCategory/);
  });

  it("paginates GET /properties/:propertyId/verifactu/submissions with the shared contract (cursor, filters, envelope)", () => {
    // listVerifactuSubmissions returns a real `Page` (createdAt desc, id desc,
    // `total` over the filtered set) and decodes the opaque cursor itself, so
    // the handler only parses the query, forwards limit/cursor/filters and
    // shapes the answer — no hand-rolled single page, no second count query.
    const handler = handlerSource('app.get("/properties/:propertyId/verifactu/submissions"');
    assert.match(handler, /parsePageQuery\(request\.query as Record<string, unknown>, \{ limit: 100, max: 500 \}\)/);
    assert.match(handler, /parse\(VerifactuSubmissionListQuerySchema, request\.query \?\? \{\}, "query"\)/);
    assert.match(
      handler,
      /listVerifactuSubmissions\(params\.propertyId, \{\s*limit: page\.limit,\s*cursor: page\.cursor,\s*registroType: filters\.registroType,\s*status: filters\.status\s*\}\)/,
      "limit, cursor and both filters must reach the service"
    );
    assert.doesNotMatch(handler, /prisma\.verifactuSubmission\.count\(/, "total comes from the service page, not a second count");
    assert.doesNotMatch(handler, /nextCursor: null/, "the cursor comes from the service page, never forced to null");
    assert.match(handler, /reply\.headers\(pageHeaders\(result\)\);\s*return pageBody\(result, page\);/);
    const service = readApi("modules/invoicing/verifactu-submission.service.ts");
    assert.match(service, /export async function listVerifactuSubmissions\(propertyId: string, options: ListVerifactuSubmissionsOptions = \{\}\): Promise<VerifactuSubmissionPage> \{/);
    assert.match(service, /export type VerifactuSubmissionPage = Page<VerifactuSubmissionListItem>;/);
    assert.match(server, /const VerifactuSubmissionListQuerySchema = z\.object\(\{\s*status: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(40\)\.optional\(\),\s*registroType: z\.enum\(\["alta", "anulacion"\]\)\.optional\(\)\s*\}\);/);
  });

  it("answers 201 on POST /properties/:propertyId/upsell-offers", () => {
    const handler = handlerSource('app.post("/properties/:propertyId/upsell-offers"');
    assert.match(handler, /async \(request, reply\) =>/);
    assert.match(handler, /reply\.code\(201\);\s*return view;/);
  });
});

// ── Tanda 4 · rutas-cors ────────────────────────────────────────────────────
// POST /backoffice/properties/:propertyId/roles creates an organisation role
// from a shared template (createRoleFromTemplate, lib/rbac-catalog — lote
// rbac-templates). It hands permissions to whoever is later invited with the
// role, so it is roles.manage / high: the token-less demo fallback (H1) can
// never reach it. The generic (a)/(b)/(d) checks above already prove it is
// registered, not orphaned and keyed on a catalogue permission.
describe("Tanda 4 · rutas-cors: POST /backoffice/properties/:propertyId/roles", () => {
  const ROUTE = "/backoffice/properties/:propertyId/roles";

  it("is mapped with roles.manage / high (refused to the demo fallback) next to the GET used by the invite selector", () => {
    const post = manifest.find((e) => e.method === "POST" && e.path === ROUTE);
    assert.ok(post, `POST ${ROUTE} missing from routePermissionManifest`);
    assert.deepEqual(post.permissions.map((p) => p.key), ["roles.manage"]);
    assert.equal(post.riskLevel, "high");
    const get = manifest.find((e) => e.method === "GET" && e.path === ROUTE);
    assert.ok(get, `GET ${ROUTE} missing from routePermissionManifest`);
    assert.deepEqual(get.permissions.map((p) => p.key), ["users.invite"], "the GET keeps the invite-selector permission");
    assert.ok(registered.some((r) => r.method === "POST" && r.path === ROUTE), `POST ${ROUTE} not extracted from server.ts`);
  });

  it("validates the body at the edge (name 2..60, templateKey ∈ ROLE_TEMPLATE_KEYS) and resolves the org through the tenant guard", () => {
    assert.match(
      server,
      /const CreateRoleFromTemplateSchema = z\.object\(\{\s*name: z\.string\(\)\.trim\(\)\.min\(2\)\.max\(60\),\s*templateKey: z\s*\.string\(\)\s*\.trim\(\)\s*\.refine\(\(value\): value is RoleKey => \(ROLE_TEMPLATE_KEYS as readonly string\[\]\)\.includes\(value\)/,
      "body schema must pin name 2..60 and templateKey to the shared template keys"
    );
    assert.match(server, /import \{ ROLE_TEMPLATE_KEYS, type RoleKey \} from "@hotelos\/shared";/);
    assert.match(server, /import \{ createRoleFromTemplate \} from "\.\/lib\/rbac-catalog\.js";/);
    const handler = handlerSource(`app.post("${ROUTE}"`);
    assert.match(handler, /async \(request, reply\) =>/);
    assert.match(handler, /const body = parse\(CreateRoleFromTemplateSchema, request\.body\);/, "400 on a bad body before any DB access");
    assert.match(
      handler,
      /const organizationId = await grantPropertyAccess\(request, params\.propertyId\);/,
      "the organisation must be the property's (opaque 404 for foreign properties; platform admins re-pointed), never the caller's by default"
    );
    assert.match(
      handler,
      /createRoleFromTemplate\(\{\s*organizationId,\s*name: body\.name,\s*templateKey: body\.templateKey,\s*actorUserId: request\.userContext\.userId \?\? null\s*\}\)/,
      "contract (B): createRoleFromTemplate({ organizationId, name, templateKey, actorUserId })"
    );
    assert.match(handler, /reply\.code\(201\);\s*return role;/, "a created role answers 201");
    assert.doesNotMatch(handler, /prisma\./, "no inline Prisma: creation + template grants live in lib/rbac-catalog (one transaction, 409/400 typed there)");
  });
});
