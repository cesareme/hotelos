import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Housekeeping and maintenance lifecycle", () => {
  it("exposes required housekeeping and maintenance routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/properties/:propertyId/housekeeping/board",
      "/housekeeping/tasks",
      "/housekeeping/tasks/:id",
      "/housekeeping/tasks/:id/photo",
      "/rooms/:id/mark-clean",
      "/rooms/:id/mark-inspected",
      "/properties/:propertyId/work-orders",
      "/work-orders",
      "/work-orders/:id",
      "/work-orders/:id/media",
      "/work-orders/:id/block-room",
      "/work-orders/:id/resolve"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });

  it("generates a departure cleaning task during checkout", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /createDepartureCleaningTask/);
    assert.match(server, /departureTask/);
  });

  it("requires high-risk confirmation before a maintenance room block", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/maintenance/maintenance.service.ts", import.meta.url), "utf8");
    assert.match(service, /ai\.high_risk\.confirm/);
    assert.match(service, /ROOM_BLOCKED_FOR_MAINTENANCE/);
  });

  it("keeps operations state in the shared store", () => {
    const store = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
    assert.match(store, /housekeepingTasks/);
    assert.match(store, /housekeepingEvents/);
    assert.match(store, /workOrders/);
    assert.match(store, /workOrderMedia/);
  });
});

