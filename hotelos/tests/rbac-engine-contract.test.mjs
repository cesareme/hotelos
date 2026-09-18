import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/**
 * RBAC engine contract (Tanda 8a · L1, docs/design/RBAC-DEPARTAMENTOS.md §6).
 *
 * Static, no-DB pins over the sources of the access engine: the scope hook of
 * server.ts sits between the password guard and the permission gate, the gate
 * keeps its Tanda 3 invariants and audits ACCESS_DENIED, the demo union has
 * ONE dedicated switch, sessions are built from the scope reader (never from
 * the first user_property_roles row), «sin asignaciones» is no longer
 * organisation-wide, the entity always wins over the header, the rbac partial
 * carries exactly the agreed routes, and the services pin the dynamic checks
 * (requester ≠ decider, second approval above T4, re-authentication and the
 * break-glass rule) that the CHECK constraint of the migration backs.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const server = read("../apps/api/src/server.ts");
const envSource = read("../apps/api/src/lib/env.ts");
const authService = read("../apps/api/src/modules/auth/auth.service.ts");
const tenancy = read("../apps/api/src/lib/tenancy.ts");
const rbacScope = read("../apps/api/src/lib/rbac-scope.ts");
const partial = read("../apps/api/src/modules/rbac/route-permissions.partial.ts");
const approvals = read("../apps/api/src/modules/rbac/approvals.service.ts");
const breakGlass = read("../apps/api/src/modules/rbac/break-glass.service.ts");
const assignments = read("../apps/api/src/modules/rbac/assignments.service.ts");
const migration = read("../packages/database/prisma/migrations/20260918100000_rbac_departamentos/migration.sql");
const docs = read("../docs/api-contracts.md");

/** Body of a top-level `export function <name>(` up to its closing `\n}`. */
function functionBody(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

const RBAC_ROUTES = [
  ["GET", "/rbac/assignments", ["users.read"], "medium"],
  ["POST", "/rbac/assignments", ["users.assign"], "high"],
  ["DELETE", "/rbac/assignments/:id", ["users.assign"], "high"],
  ["GET", "/rbac/users", ["users.read"], "medium"],
  ["GET", "/rbac/roles", ["roles.manage"], "medium"],
  ["POST", "/rbac/roles", ["roles.manage"], "high"],
  ["PATCH", "/rbac/roles/:id/permissions", ["permissions.manage"], "high"],
  ["GET", "/rbac/property-groups", ["organization.structure.manage"], "medium"],
  ["POST", "/rbac/property-groups", ["organization.structure.manage"], "high"],
  ["PATCH", "/rbac/property-groups/:id", ["organization.structure.manage"], "high"],
  ["GET", "/rbac/thresholds", ["accounting.read"], "medium"],
  ["PUT", "/rbac/thresholds", ["accounting.configure", "ai.high_risk.confirm"], "critical"],
  ["GET", "/approvals", [], "authenticated"],
  ["POST", "/approvals", [], "high"],
  ["POST", "/approvals/:id/approve", [], "critical"],
  ["POST", "/approvals/:id/reject", [], "critical"],
  ["POST", "/rbac/supervisor-authorizations", [], "high"],
  ["POST", "/rbac/pin", [], "high"],
  ["POST", "/rbac/break-glass", ["security.break_glass"], "critical"],
  ["POST", "/rbac/break-glass/:id/close", ["security.break_glass"], "critical"],
  ["POST", "/rbac/break-glass/:id/review", ["audit.read"], "high"],
  ["GET", "/rbac/break-glass", ["audit.read"], "medium"],
  ["GET", "/rbac/report", ["audit.read"], "medium"],
  ["GET", "/rbac/access-log", ["audit.read"], "medium"]
];

describe("RBAC engine (Tanda 8a · L1) · server.ts hooks", () => {
  it("resolves the request scope between the password guard and the permission gate (x-property-id after passwordChangeRequiredError, before assertRoutePermission)", () => {
    const guardAt = server.indexOf("throw passwordChangeRequiredError();");
    // La primera aparición literal de "x-property-id" en server.ts es allowedHeaders del CORS (Tanda 8a: el front la envía);
    // el orden que importa es el de la constante del hook de ámbito.
    const headerAt = server.indexOf('const PROPERTY_HEADER = "x-property-id";');
    const gateAt = server.indexOf("assertRoutePermission({");
    assert.ok(guardAt >= 0 && headerAt > guardAt && gateAt > headerAt, `order must be guard (${guardAt}) < x-property-id (${headerAt}) < gate (${gateAt})`);
    // The header constant sits right above the scope hook; the hook is the next preHandler after it.
    const scopeHookStart = server.indexOf('app.addHook("preHandler"', server.indexOf('const PROPERTY_HEADER = "x-property-id";'));
    const scopeHook = server.slice(scopeHookStart, server.indexOf('app.addHook("preHandler"', scopeHookStart + 1));
    assert.ok(scopeHookStart > guardAt && scopeHookStart < gateAt);
    assert.match(scopeHook, /if \(request\.is404\) return;/);
    assert.match(scopeHook, /if \(!request\.isAuthenticated\) return;/);
    assert.match(scopeHook, /loadUserScope\(/);
    assert.match(scopeHook, /permissionsFor\(/);
    assert.match(scopeHook, /request\.rbacScope = \{ propertyId, resolvedFrom \}/);
    assert.match(scopeHook, /context\.permissions = unionPermissions\(/);
    assert.match(scopeHook, /"PROPERTY_SWITCHED"/);
    assert.match(scopeHook, /reason: "out_of_scope"/);
    assert.match(scopeHook, /throw new NotFoundError\("Propiedad no encontrada\."\)/);
    assert.match(scopeHook, /bg_\$\{context\.breakGlassSessionId\}_/, "break-glass sessions tag every request's correlation id");
    assert.doesNotMatch(scopeHook, /assertRoutePermission\(\{/, "the scope hook never calls the gate (the contract test finds the gate by its last preHandler)");
  });

  it("the gate keeps the Tanda 3 invariants and audits every refusal as ACCESS_DENIED (deduplicated per user, route and minute)", () => {
    const gateAt = server.indexOf("assertRoutePermission({");
    const hookStart = server.lastIndexOf('app.addHook("preHandler"', gateAt);
    const hook = server.slice(hookStart, server.indexOf("\n  });", gateAt));
    assert.match(hook, /if \(request\.is404\) return;/);
    assert.match(hook, /risk === "high" \|\| risk === "critical"/);
    assert.match(hook, /userContext\?\.permissions \?\? \[\]/);
    assert.match(hook, /"ACCESS_DENIED"/);
    assert.match(hook, /PermissionDeniedError/);
    assert.match(hook, /accessDecision\(/);
    assert.match(hook, /throw error;/, "the refusal is re-thrown untouched");
    assert.match(server, /const ACCESS_DENIED_DEDUPE_MS = 60_000;/);
    assert.match(server, /registerRbacRoutes\(app\);/);
    assert.match(server, /import \{ registerRbacRoutes \} from "\.\/modules\/rbac\/rbac\.routes\.js";/);
    // pickPropertyId is declared once, above the password guard, and shared with the tenant guard.
    assert.equal((server.match(/function pickPropertyId\(/g) ?? []).length, 1);
    assert.ok(server.indexOf("function pickPropertyId(") < server.indexOf("throw passwordChangeRequiredError();"));
  });
});

describe("RBAC engine · demo union switch, sessions from the scope reader, explicit organisation scope", () => {
  it("env.ts declares HOTELOS_DEMO_PERMISSION_UNION (productionForbidden true) and docs/api-contracts.md names it", () => {
    const block = envSource.slice(envSource.indexOf("HOTELOS_DEMO_PERMISSION_UNION: {"), envSource.indexOf("TENANT_BOOTSTRAP_SKIP: {"));
    assert.match(block, /productionForbidden: "true"/);
    assert.match(block, /default: "false"/);
    assert.match(docs, /HOTELOS_DEMO_PERMISSION_UNION/);
    assert.match(docs, /DYNAMIC_KEY_ROUTES/);
    assert.match(docs, /x-property-id/);
    assert.match(docs, /riskLevel: "authenticated"/);
    assert.match(docs, /ACCESS_DENIED/);
    for (const code of ["RBAC_LEVEL_EXCEEDED", "RBAC_SOD_CONFLICT", "APPROVAL_REQUIRED", "RBAC_BREAK_GLASS_FORBIDDEN"]) assert.ok(docs.includes(code), `docs must mention ${code}`);
  });

  it("auth.service.ts: the union never reads NODE_ENV, and createSessionForUser builds the session from loadUserScope (never userPropertyRole.findFirst)", () => {
    const union = functionBody(authService, "isDemoPermissionUnionEnabled");
    assert.doesNotMatch(union, /NODE_ENV/);
    assert.doesNotMatch(union, /HOTELOS_ALLOW_DEMO_AUTH/);
    assert.match(union, /HOTELOS_DEMO_PERMISSION_UNION === "true"/);
    const session = authService.slice(authService.indexOf("export async function createSessionForUser("), authService.indexOf("export function requirePermissions("));
    assert.doesNotMatch(session, /userPropertyRole\.findFirst/);
    assert.match(session, /loadUserScope\(/);
    const context = authService.slice(authService.indexOf("export async function loadUserContext("), authService.indexOf("function toIso("));
    assert.match(context, /"emergency"/);
    assert.match(context, /breakGlassSession\.findFirst/);
    assert.match(context, /closesAt: \{ gt: new Date\(\) \}/);
    assert.match(authService, /"LOGIN_FAILED"/);
    assert.match(server, /app\.get\("\/users\/me", async \(request\) => getCurrentUserProfile\(request\.userContext\)\);/);
  });

  it("tenancy.ts: isPropertyAssigned answers false with an empty list unless orgScope, and assertEntityAccess re-scopes to the entity's property", () => {
    const predicate = functionBody(tenancy, "isPropertyAssigned");
    assert.match(predicate, /if \(assigned\.length === 0\) return context\.orgScope === true;/, "an empty list (real session) is never organisation-wide");
    assert.match(predicate, /if \(assigned === undefined\) return context\.orgScope !== false;/, "only a context without any list keeps the organisation");
    assert.match(tenancy, /resolvedFrom: "entity"/);
    assert.match(tenancy, /rescopePermissionsToEntity\(request, owner\.propertyId\)/);
    assert.match(rbacScope, /export async function loadUserScope\(/);
    assert.match(rbacScope, /export function permissionsFor\(/);
    assert.match(rbacScope, /intersectionOf\(sets\)/, "organisation routes: intersection of the property sets (transitional)");
    assert.match(rbacScope, /revokedAt: null/);
    assert.match(rbacScope, /validTo: \{ gt: now \}/);
  });
});

describe("RBAC engine · routes, approvals, supervisor, break glass, assignments and the migration CHECK", () => {
  it("the rbac partial has exactly the agreed entries", () => {
    const entries = [...partial.matchAll(/\{ method: "(GET|POST|PATCH|DELETE|PUT)", path: "([^"]+)", permissions: \[([^\]]*)\], riskLevel: "(\w+)" \}/g)].map((m) => [m[1], m[2], [...m[3].matchAll(/"([^"]+)"/g)].map((k) => k[1]), m[4]]);
    assert.deepEqual(entries, RBAC_ROUTES);
    const routes = read("../apps/api/src/modules/rbac/rbac.routes.ts");
    for (const [method, path] of RBAC_ROUTES) {
      assert.ok(routes.includes(`app.${method.toLowerCase()}("${path}"`), `${method} ${path} must be registered literally in rbac.routes.ts`);
    }
  });

  it("approvals.service.ts pins requester ≠ decider, the second approval above T4 and the APPROVAL_REQUIRED gate", () => {
    assert.match(approvals, /row\.requestedByUserId === context\.userId\) throw new ConflictError\("Nadie aprueba lo que ha solicitado\."/);
    assert.match(approvals, /"APPROVAL_SELF_DECISION"/);
    assert.match(approvals, /=== "ABOVE_T4"/);
    assert.match(approvals, /ROLE_LEVEL_RANK\.general_management/);
    assert.match(approvals, /new ApprovalRequiredError\(/);
    assert.match(approvals, /export function registerApprovalExecutor\(/);
    for (const name of ["requestApproval", "decideApproval", "assertApprovedOrAuthorized", "listApprovals", "expireApprovals"]) {
      assert.match(approvals, new RegExp(`export async function ${name}\\(`), `${name} must be exported for L2`);
    }
  });

  it("break-glass.service.ts re-authenticates with the password and refuses without it; assignments.service.ts applies the break-glass rule and rejects the emergency template", () => {
    assert.match(breakGlass, /verifyPassword\(/);
    assert.match(breakGlass, /"BREAK_GLASS_REAUTH_REQUIRED"/);
    assert.match(breakGlass, /BREAK_GLASS_MAX_SESSION_HOURS/);
    assert.match(breakGlass, /"BREAK_GLASS_OPENED"/);
    assert.match(breakGlass, /"BREAK_GLASS_CLOSED"/);
    assert.match(assignments, /"RBAC_BREAK_GLASS_FORBIDDEN"/);
    assert.match(assignments, /role\.templateKey === "break_glass"\) throw new NotFoundError/);
    assert.match(assignments, /"RBAC_SCOPE_EXCEEDED"/);
    assert.match(assignments, /"RBAC_LEVEL_EXCEEDED"/);
    assert.match(assignments, /"RBAC_SELF_ASSIGNMENT"/);
    assert.match(assignments, /"RBAC_SOD_CONFLICT"/);
    assert.match(assignments, /bumpRbacVersion\(/);
  });

  it("the migration backs the dynamic SoD with the CHECK constraints on approval_requests", () => {
    assert.match(migration, /approval_requests_no_self_decision/);
    assert.match(migration, /approval_requests_no_self_second/);
    assert.match(migration, /CHECK \("decided_by_user_id" IS NULL OR "decided_by_user_id" <> "requested_by_user_id"\)/);
  });
});
