import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("Offline sync contract", () => {
  it("exposes offline sync routes", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    assert.match(server, /"\/offline\/sync"/);
    assert.match(server, /"\/properties\/:propertyId\/offline-sync-records"/);
  });

  it("rejects offline invoice issue and final check-in by default", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/offline/offline.service.ts", import.meta.url), "utf8");
    assert.match(service, /invoice\.issue/);
    assert.match(service, /reservation\.check_in\.final/);
    assert.match(service, /Offline invoice issuing is not allowed/);
    assert.match(service, /Offline final check-in is disabled/);
  });

  it("allows housekeeping and maintenance draft action types", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/offline/offline.service.ts", import.meta.url), "utf8");
    for (const actionType of [
      "housekeeping.room.clean",
      "housekeeping.task.create",
      "housekeeping.task.update",
      "maintenance.work_order.draft",
      "maintenance.photo.pending_upload"
    ]) {
      assert.match(service, new RegExp(actionType.replace(/\./g, "\\.")));
    }
  });

  it("persists offline sync records and audit events", () => {
    const service = readFileSync(new URL("../apps/api/src/modules/offline/offline.service.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../apps/api/src/lib/demo-store.ts", import.meta.url), "utf8");
    const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");

    assert.match(service, /OFFLINE_ACTION_SYNCED/);
    assert.match(service, /OFFLINE_ACTION_REJECTED/);
    assert.match(store, /offlineSyncRecords/);
    assert.match(schema, /@@map\("offline_sync_records"\)/);
  });

  it("includes offline sync in the mobile shell", () => {
    const app = readFileSync(new URL("../apps/mobile/App.tsx", import.meta.url), "utf8");
    const screen = readFileSync(new URL("../apps/mobile/src/screens/OfflineSyncScreen.tsx", import.meta.url), "utf8");

    assert.match(app, /OfflineSyncScreen/);
    assert.match(screen, /Sync now/);
    assert.match(screen, /Invoice issue and final check-in stay online-only/);
  });
});

