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
const routeFiles = readdirSync(new URL("routes/", apiSrcDir))
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => ({ file: `routes/${name}`, source: readApi(`routes/${name}`) }));
const manifestSource = readApi("security/route-permissions.ts");
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

function parseManifest(source) {
  const start = source.indexOf("export const routePermissionManifest");
  const end = source.indexOf("\n];", start);
  assert.ok(start >= 0 && end > start, "routePermissionManifest array not found in route-permissions.ts");
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
const manifest = parseManifest(manifestSource);
const catalog = permissionCatalog(permissionsSource);

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
    assert.ok(
      has("POST", "/channel-manager/channels/:channelId/sync/full"),
      "template-loop routes (CHANNEL_SYNC_ROUTE_TEMPLATES) not extracted"
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
