// Tanda 8a (RBAC · L1): the pure access decision (findRoutePermission +
// missingPermissions + strict mode, never throws) the gate audits with and
// GET /rbac/access-log recomputes. Runs on the runtime manifest. From apps/api:
//   node --import tsx --test src/security/__tests__/access-decision.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accessDecision } from "../access-decision.js";
import { findRoutePermission } from "../route-permissions.js";

describe("accessDecision · one decision per (route, permissions, scope)", () => {
  it("allows when every key of the route is held and reports the scope it was resolved for", () => {
    const refund = findRoutePermission("POST", "/payments/:id/refund");
    assert.ok(refund);
    const decision = accessDecision({ method: "post", path: "/payments/:id/refund", permissions: refund.permissions, authenticated: true, propertyId: "prop_a", scopeType: "property" });
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.missing, []);
    assert.deepEqual(decision.required, ["payment.refund"]);
    assert.equal(decision.riskLevel, "critical");
    assert.equal(decision.propertyId, "prop_a");
    assert.equal(decision.scopeType, "property");
    assert.equal(decision.reason, undefined);
  });

  it("refuses with the missing keys (never throws) and keeps the required list", () => {
    const decision = accessDecision({ method: "POST", path: "/payments/:id/refund", permissions: ["pms.reservation.read"], authenticated: true, propertyId: null, scopeType: "organization" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "missing_permission");
    assert.deepEqual(decision.missing, ["payment.refund"]);
    assert.deepEqual(decision.required, ["payment.refund"]);
  });

  it("public routes always pass; authenticated routes pass with an empty key set", () => {
    assert.equal(accessDecision({ method: "GET", path: "/health", permissions: [], authenticated: false, propertyId: null, scopeType: null }).allowed, true);
    const me = accessDecision({ method: "GET", path: "/users/me", permissions: [], authenticated: true, propertyId: null, scopeType: null });
    assert.equal(me.allowed, true);
    assert.equal(me.riskLevel, "authenticated");
  });

  it("the token-less fallback is refused on high / critical routes (not_authenticated) but evaluated on low ones", () => {
    const refused = accessDecision({ method: "POST", path: "/rbac/break-glass", permissions: ["security.break_glass"], authenticated: false, propertyId: null, scopeType: null });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, "not_authenticated");
    assert.deepEqual(refused.missing, ["security.break_glass"]);
    const low = accessDecision({ method: "GET", path: "/properties/:propertyId/housekeeping/board", permissions: ["housekeeping.read"], authenticated: false, propertyId: "prop_a", scopeType: "property" });
    assert.equal(low.allowed, true);
  });

  it("unmapped routes: a GET passes only outside strict mode, a mutation never", () => {
    const openGet = accessDecision({ method: "GET", path: "/no/such/route", permissions: [], strict: false, authenticated: true, propertyId: null, scopeType: null });
    assert.equal(openGet.allowed, true);
    assert.equal(openGet.reason, "unmapped");
    assert.equal(openGet.riskLevel, null);
    const strictGet = accessDecision({ method: "GET", path: "/no/such/route", permissions: [], strict: true, authenticated: true, propertyId: null, scopeType: null });
    assert.equal(strictGet.allowed, false);
    const post = accessDecision({ method: "POST", path: "/no/such/route", permissions: [], strict: false, authenticated: true, propertyId: null, scopeType: null });
    assert.equal(post.allowed, false);
    assert.equal(post.reason, "unmapped");
  });

  it("the new rbac routes are mapped with their keys (partial spread into the runtime manifest)", () => {
    const assign = accessDecision({ method: "POST", path: "/rbac/assignments", permissions: ["users.read"], authenticated: true, propertyId: null, scopeType: "organization" });
    assert.equal(assign.allowed, false);
    assert.deepEqual(assign.missing, ["users.assign"]);
    assert.equal(assign.riskLevel, "high");
    const thresholds = accessDecision({ method: "PUT", path: "/rbac/thresholds", permissions: ["accounting.configure"], authenticated: true, propertyId: null, scopeType: "organization" });
    assert.deepEqual(thresholds.missing, ["ai.high_risk.confirm"]);
    assert.equal(thresholds.riskLevel, "critical");
  });
});
