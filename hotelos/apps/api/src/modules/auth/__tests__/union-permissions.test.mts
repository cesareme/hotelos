// Tanda 5 (L1c · api): the dev/demo permission union never adds a PLATFORM
// key (admin.tenants.manage) to a real session — the platform scope comes
// only from a real grant (isPlatformAdmin already did; the route gate now
// agrees). Pure, no database. Run from apps/api with
//   node --import tsx --test src/modules/auth/__tests__/union-permissions.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLATFORM_PERMISSION_KEYS, ROLE_PERMISSION_MAP, type PermissionKey } from "@hotelos/shared";
import { isDemoPermissionUnionEnabled, unionPermissions } from "../auth.service.js";
import { demoStore } from "../../../lib/demo-store.js";

const OWNER = ROLE_PERMISSION_MAP.owner;
const RECEPTION = ROLE_PERMISSION_MAP.receptionist;

describe("unionPermissions · demo union without platform keys", () => {
  it("outside demo mode returns exactly the real grants", () => {
    assert.deepEqual(unionPermissions(RECEPTION, { demoMode: false }), RECEPTION);
    assert.deepEqual(unionPermissions([], { demoMode: false }), []);
  });

  it("in demo mode unions the baseline but never a platform key", () => {
    const baseline = demoStore.userContext.permissions;
    assert.ok(baseline.includes("admin.tenants.manage" as PermissionKey), "the demo baseline carries the platform key (token-less fallback)");
    const effective = unionPermissions(RECEPTION, { demoMode: true, baseline });
    for (const key of PLATFORM_PERMISSION_KEYS) assert.equal(effective.includes(key), false, `${key} leaked through the union`);
    assert.equal(effective.includes("admin.tenants.manage" as PermissionKey), false);
    for (const key of RECEPTION) assert.ok(effective.includes(key), `real grant ${key} kept`);
    assert.ok(effective.includes("modules.configure"), "baseline org keys still unioned in demo mode");
    assert.equal(new Set(effective).size, effective.length, "no duplicates");
  });

  it("a real platform grant survives the union (the key comes from the grant, not the baseline)", () => {
    const real = [...OWNER, "admin.tenants.manage" as PermissionKey];
    const effective = unionPermissions(real, { demoMode: true });
    assert.ok(effective.includes("admin.tenants.manage" as PermissionKey));
  });

  it("the demo mode switch is the explicit opt-in (NODE_ENV=development|dev or HOTELOS_ALLOW_DEMO_AUTH=true)", () => {
    assert.equal(isDemoPermissionUnionEnabled({ NODE_ENV: "development" }), true);
    assert.equal(isDemoPermissionUnionEnabled({ NODE_ENV: "dev" }), true);
    assert.equal(isDemoPermissionUnionEnabled({ NODE_ENV: "production", HOTELOS_ALLOW_DEMO_AUTH: "true" }), true);
    assert.equal(isDemoPermissionUnionEnabled({ NODE_ENV: "production" }), false);
    assert.equal(isDemoPermissionUnionEnabled({}), false);
    assert.equal(isDemoPermissionUnionEnabled({ HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "test" }), false);
  });
});
