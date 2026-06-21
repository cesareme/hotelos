import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const manifest = readFileSync(new URL("../apps/api/src/security/route-permissions.ts", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/api-contracts.md", import.meta.url), "utf8");

function mutatingRoutesFromServer() {
  const routes = [];
  const pattern = /app\.(post|patch|delete)\("([^"]+)"/g;
  let match;
  while ((match = pattern.exec(server)) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return routes;
}

describe("API route permission manifest", () => {
  it("is enforced by the API pre-handler with default-deny permissions", () => {
    assert.match(server, /assertRoutePermission/);
    assert.match(server, /app\.addHook\("preHandler"/);
    // Audit 2026-06 · NUEVO-2: no userContext => empty permission set (deny),
    // never the demoStore super-user.
    assert.match(server, /userContext\?\.permissions \?\? \[\]/);
  });

  it("lists every mutating API route", () => {
    for (const route of mutatingRoutesFromServer()) {
      assert.match(manifest, new RegExp(`method: "${route.method}"[\\s\\S]*path: "${route.path.replaceAll("/", "\\/")}"`));
    }
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
      assert.match(manifest, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("fails closed for unlisted mutating routes and supports RBAC_STRICT for GET", () => {
    assert.match(manifest, /No route permission manifest entry/);
    assert.match(manifest, /input\.method\.toUpperCase\(\) === "GET"/);
    // Audit 2026-06 · #3: unmapped GETs are logged, and RBAC_STRICT=true makes
    // them fail closed (403) instead of falling through as public.
    assert.match(manifest, /RBAC_STRICT/);
    assert.match(manifest, /ForbiddenError/);
  });

  it("documents the route permission policy", () => {
    assert.match(docs, /Route Permissions/);
    assert.match(docs, /Every mutating `POST` and `PATCH` route/);
    assert.match(docs, /service-level validation/);
  });
});
