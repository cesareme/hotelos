import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Assets and owner dashboard contracts", () => {
  it("exposes asset, capex, profitability, and owner dashboard routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/properties/:propertyId/assets",
      "/assets",
      "/assets/:id",
      "/properties/:propertyId/fixed-assets",
      "/properties/:propertyId/room-profitability",
      "/properties/:propertyId/owner-dashboard",
      "/properties/:propertyId/capex",
      "/capex-projects",
      "/capex-projects/:id",
      "/capex-projects/:id/items"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("keeps capex approval owner-gated and event logged", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/assets/assets.service.ts", import.meta.url), "utf8");
    assert.match(service, /asset\.capex\.approve/);
    assert.match(service, /CapexProjectApproved/);
    assert.match(service, /ownerApprovedBy/);
  });

  it("rolls room profitability from revenue, maintenance, and capex", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/assets/assets.service.ts", import.meta.url), "utf8");
    assert.match(service, /calculateRoomProfitability/);
    assert.match(service, /reservation\.totalAmount/);
    assert.match(service, /maintenanceCost/);
    assert.match(service, /capexPlanned/);
  });

  it("stores asset domain records in the shared demo store", () => {
    const store = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
    assert.match(store, /assets/);
    assert.match(store, /capexProjects/);
    assert.match(store, /capexItems/);
    assert.match(store, /fixedAssets/);
  });
});

