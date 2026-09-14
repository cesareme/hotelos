// Unit tests for the daily-snapshot writer's protections (revenue-protecciones):
// a property with no operation in Anfitorio never gets a 0-room close, and a
// close with a foreign provenance (PMS import, migration, demo seed) is never
// overwritten without an explicit force. Pure decision only — no database. Run
// from apps/api with
//   node --import tsx --test src/modules/revenue/__tests__/snapshot-protection.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideSnapshotWrite, NIGHT_AUDIT_DATA_SOURCE } from "../hf-board.service.js";

describe("decideSnapshotWrite — night audit vs imported history", () => {
  it("skips a property without any reservation, whatever the day's row says", () => {
    assert.deepEqual(decideSnapshotWrite({ existing: null, hasReservations: false }), { action: "skipped", reason: "no_reservations" });
    assert.deepEqual(decideSnapshotWrite({ existing: { dataSource: "pms_import:opera-hf" }, hasReservations: false }), {
      action: "skipped",
      reason: "no_reservations"
    });
    // Even force does not fabricate a close for a hotel that never operated here.
    assert.deepEqual(decideSnapshotWrite({ existing: { dataSource: NIGHT_AUDIT_DATA_SOURCE }, hasReservations: false, force: true }), {
      action: "skipped",
      reason: "no_reservations"
    });
  });

  it("writes when there is no row yet or the row is its own night_audit close", () => {
    assert.deepEqual(decideSnapshotWrite({ existing: null, hasReservations: true }), { action: "write" });
    assert.deepEqual(decideSnapshotWrite({ existing: { dataSource: NIGHT_AUDIT_DATA_SOURCE }, hasReservations: true }), { action: "write" });
  });

  it("protects rows with a foreign dataSource unless force is explicit (same rule as backfill --force)", () => {
    for (const dataSource of ["pms_import:opera-hf-2026-09-14", "demo", "migration_import", "system"]) {
      assert.deepEqual(decideSnapshotWrite({ existing: { dataSource }, hasReservations: true }), { action: "skipped", reason: "protected", dataSource });
      assert.deepEqual(decideSnapshotWrite({ existing: { dataSource }, hasReservations: true, force: false }), { action: "skipped", reason: "protected", dataSource });
      assert.deepEqual(decideSnapshotWrite({ existing: { dataSource }, hasReservations: true, force: true }), { action: "write" });
    }
  });
});
