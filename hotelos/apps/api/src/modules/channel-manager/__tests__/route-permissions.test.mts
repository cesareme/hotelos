// The manifest partial must cover EVERY route registered in
// channel-manager.routes.ts — public ones included: `assertRoutePermission`
// answers 403 to any non-GET without an entry, in every environment, and the
// repo contract test parses the partial with a regex that also reads a
// commented-out entry (that is how the `_sandbox` loopback answered 403 for a
// day while the gate stayed green). This test reads the live array instead.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CHANNEL_MANAGER_ROUTE_PERMISSIONS } from "../route-permissions.partial.js";

const source = readFileSync(new URL("../channel-manager.routes.ts", import.meta.url), "utf8");
const registered = [...source.matchAll(/\bapp\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)].map((m) => `${(m[1] as string).toUpperCase()} ${m[2]}`);
const manifest = CHANNEL_MANAGER_ROUTE_PERMISSIONS.map((e) => `${e.method} ${e.path}`);

/** Prefixes lib/auth-context.ts treats as public (token-less): their entries must be riskLevel "public". */
const PUBLIC_PREFIXES = ["/channel-manager/_sandbox", "/channel-manager/webhooks"];

describe("channel-manager — route permission partial", () => {
  it("registers a credible number of routes and every one has exactly one manifest entry", () => {
    assert.ok(registered.length >= 20, `only ${registered.length} routes extracted`);
    const missing = registered.filter((r) => !manifest.includes(r));
    assert.deepEqual(missing, [], `routes without a manifest entry: ${missing.join(", ")}`);
    const orphans = manifest.filter((m) => !registered.includes(m));
    assert.deepEqual(orphans, [], `manifest entries without a route: ${orphans.join(", ")}`);
    assert.equal(new Set(manifest).size, manifest.length, "duplicate manifest entries");
  });

  it("the token-less routes (webhook, simulator loopback) are public entries with no permissions", () => {
    for (const prefix of PUBLIC_PREFIXES) {
      const entries = CHANNEL_MANAGER_ROUTE_PERMISSIONS.filter((e) => e.path.startsWith(prefix));
      assert.ok(entries.length >= 1, `no manifest entry under ${prefix}`);
      for (const e of entries) {
        assert.equal(e.riskLevel, "public", `${e.method} ${e.path}`);
        assert.deepEqual(e.permissions, [], `${e.method} ${e.path}`);
      }
    }
    assert.ok(manifest.includes("POST /channel-manager/_sandbox/:provider"));
    assert.ok(manifest.includes("POST /channel-manager/webhooks/:provider/:channelId"));
  });

  it("writes that reach a provider or a channel's secrets are high/critical; reads are medium", () => {
    const byKey = new Map(CHANNEL_MANAGER_ROUTE_PERMISSIONS.map((e) => [`${e.method} ${e.path}`, e] as const));
    assert.equal(byKey.get("POST /channel-manager/deliveries/enqueue")?.riskLevel, "critical");
    assert.equal(byKey.get("POST /channel-manager/deliveries/drain")?.riskLevel, "critical");
    assert.equal(byKey.get("PATCH /channel-manager/channels/:channelId/credentials")?.riskLevel, "critical");
    assert.equal(byKey.get("DELETE /channel-manager/channels/:channelId")?.riskLevel, "high");
    assert.deepEqual(byKey.get("DELETE /channel-manager/channels/:channelId")?.permissions, ["channel_manager.manage"]);
    for (const e of CHANNEL_MANAGER_ROUTE_PERMISSIONS) if (e.method === "GET") assert.equal(e.riskLevel, "medium", `${e.path}`);
  });
});
