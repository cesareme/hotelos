import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canRedo,
  canUndo,
  describeSavedAt,
  deserializeDraft,
  draftChangeCount,
  draftReducer,
  draftStorageKey,
  emptyDraft,
  initialDraftStore,
  serializeDraft
} from "../draft-store.ts";
import type { CellBeforeSnapshot } from "../types.ts";

const before: CellBeforeSnapshot = { basePrice: 120, effectivePrice: 120, restrictions: {}, source: "manual" };
const NOW = "2026-03-09T10:00:00.000Z";

function edit(store: ReturnType<typeof initialDraftStore>, date: string, price: number) {
  return draftReducer(store, { type: "cell", patch: { ratePlanId: "bar", roomTypeId: "dbl", date, price }, before, now: NOW });
}

describe("draft-store · reducer", () => {
  it("records cell edits, merges later patches and keeps the first before", () => {
    let s = initialDraftStore();
    s = edit(s, "2026-03-10", 130);
    s = draftReducer(s, { type: "cell", patch: { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-10", restrictions: { minLos: 2 } }, before: { ...before, basePrice: 130 }, now: NOW });
    const entry = s.present.patches.get("bar|dbl|2026-03-10");
    assert.ok(entry);
    assert.equal(entry?.patch.price, 130);
    assert.deepEqual(entry?.patch.restrictions, { minLos: 2 });
    assert.equal(entry?.before.basePrice, 120);
    assert.equal(draftChangeCount(s.present), 1);
  });

  it("prunes entries that return to the persisted value", () => {
    let s = initialDraftStore();
    s = edit(s, "2026-03-10", 130);
    s = edit(s, "2026-03-10", 120);
    assert.equal(s.present.patches.size, 0);
    assert.equal(canUndo(s), true);
  });

  it("undo / redo walk the history and a new edit clears the future", () => {
    let s = initialDraftStore();
    s = edit(s, "2026-03-10", 130);
    s = edit(s, "2026-03-11", 140);
    assert.equal(s.present.patches.size, 2);
    s = draftReducer(s, { type: "undo" });
    assert.equal(s.present.patches.size, 1);
    assert.equal(canRedo(s), true);
    s = draftReducer(s, { type: "redo" });
    assert.equal(s.present.patches.size, 2);
    s = draftReducer(s, { type: "undo" });
    s = edit(s, "2026-03-12", 150);
    assert.equal(canRedo(s), false);
    assert.deepEqual([...s.present.patches.keys()], ["bar|dbl|2026-03-10", "bar|dbl|2026-03-12"]);
    // Undo past the beginning is a no-op.
    s = draftReducer(s, { type: "undo" });
    s = draftReducer(s, { type: "undo" });
    const same = draftReducer(s, { type: "undo" });
    assert.equal(same, s);
  });

  it("bulk ops are one undo step and are listed in ops", () => {
    let s = initialDraftStore();
    s = draftReducer(s, {
      type: "bulk",
      id: "bulk_1",
      op: { scope: { from: "2026-03-10", to: "2026-03-11" }, price: { mode: "percent", value: 10 } },
      reason: "Evento",
      patches: [
        { patch: { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-10", price: 132 }, before },
        { patch: { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-11", price: 132 }, before }
      ],
      now: NOW
    });
    assert.equal(s.present.patches.size, 2);
    assert.equal(s.present.ops.length, 1);
    assert.equal(s.present.ops[0].reason, "Evento");
    assert.deepEqual(s.present.ops[0].previewKeys, ["bar|dbl|2026-03-10", "bar|dbl|2026-03-11"]);
    assert.equal(s.present.patches.get("bar|dbl|2026-03-10")?.reason, "Evento");
    s = draftReducer(s, { type: "undo" });
    assert.equal(s.present.patches.size, 0);
    assert.equal(s.present.ops.length, 0);
  });

  it("recommendation accept / reject / adjust", () => {
    let s = initialDraftStore();
    s = draftReducer(s, { type: "recommendation", key: "bar|dbl|2026-03-10", action: "accept", patch: { patch: { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-10", price: 132 }, before }, now: NOW });
    assert.equal(s.present.patches.get("bar|dbl|2026-03-10")?.origin, "recommendation");
    s = draftReducer(s, { type: "recommendation", key: "bar|dbl|2026-03-10", action: "reject", reason: "Evento local", now: NOW });
    assert.equal(s.present.patches.size, 0);
    assert.equal(s.present.rejectedRecommendations.get("bar|dbl|2026-03-10"), "Evento local");
    s = draftReducer(s, { type: "recommendation", key: "bar|dbl|2026-03-10", action: "adjust", patch: { patch: { ratePlanId: "bar", roomTypeId: "dbl", date: "2026-03-10", price: 128 }, before }, now: NOW });
    assert.equal(s.present.rejectedRecommendations.size, 0);
    assert.equal(s.present.patches.get("bar|dbl|2026-03-10")?.patch.price, 128);
  });

  it("discardCells and clear", () => {
    let s = initialDraftStore();
    s = edit(s, "2026-03-10", 130);
    s = edit(s, "2026-03-11", 130);
    s = draftReducer(s, { type: "discardCells", keys: ["bar|dbl|2026-03-10"], now: NOW });
    assert.deepEqual([...s.present.patches.keys()], ["bar|dbl|2026-03-11"]);
    s = draftReducer(s, { type: "clear" });
    assert.equal(s.present.patches.size, 0);
    s = draftReducer(s, { type: "undo" });
    assert.equal(s.present.patches.size, 1);
  });

  it("convertToManual then revertToDerived cancel each other's flags", () => {
    let s = initialDraftStore();
    const b: CellBeforeSnapshot = { basePrice: 108, effectivePrice: 108, restrictions: {}, source: "derived" };
    s = draftReducer(s, { type: "cell", patch: { ratePlanId: "nr", roomTypeId: "dbl", date: "2026-03-10", price: 115, convertToManual: true }, before: b, now: NOW });
    s = draftReducer(s, { type: "cell", patch: { ratePlanId: "nr", roomTypeId: "dbl", date: "2026-03-10", revertToDerived: true }, before: b, now: NOW });
    const e = s.present.patches.get("nr|dbl|2026-03-10");
    assert.equal(e?.patch.revertToDerived, true);
    assert.equal(e?.patch.convertToManual, undefined);
    assert.equal(e?.patch.price, undefined);
  });
});

describe("draft-store · serialization", () => {
  it("round-trips through JSON and rejects foreign / corrupt payloads", () => {
    let s = initialDraftStore();
    s = edit(s, "2026-03-10", 130);
    s = draftReducer(s, { type: "recommendation", key: "bar|dbl|2026-03-11", action: "reject", reason: "x", now: NOW });
    const json = serializeDraft(s.present, "prop_123", "usr_1", NOW);
    const restored = deserializeDraft(json, "prop_123", "usr_1");
    assert.ok(restored);
    assert.equal(restored?.savedAt, NOW);
    assert.equal(restored?.draft.patches.get("bar|dbl|2026-03-10")?.patch.price, 130);
    assert.equal(restored?.draft.rejectedRecommendations.get("bar|dbl|2026-03-11"), "x");
    assert.equal(deserializeDraft(json, "prop_999", "usr_1"), null);
    assert.equal(deserializeDraft("{not json", "prop_123", "usr_1"), null);
    assert.equal(deserializeDraft(JSON.stringify({ v: 1 }), "prop_123", "usr_1"), null);
    assert.equal(deserializeDraft(null), null);
    assert.equal(draftStorageKey("prop_123", "usr_1"), "anfitorio.rate-grid.draft.prop_123.usr_1");
  });

  it("describes when the draft was saved", () => {
    const now = new Date(2026, 2, 12, 9, 0, 0);
    assert.equal(describeSavedAt(new Date(2026, 2, 12, 8, 0, 0).toISOString(), now), "de hoy");
    assert.equal(describeSavedAt(new Date(2026, 2, 11, 23, 0, 0).toISOString(), now), "de ayer");
    assert.equal(describeSavedAt(new Date(2026, 2, 3, 23, 0, 0).toISOString(), now), "del 3 mar");
    assert.equal(emptyDraft().updatedAt, null);
  });
});
