// Rate grid v2 · publish scope derived from the patches of a bulk-update
// (pure): room types, plans (+ derived children), kinds per field. Run from
// apps/api with node --import tsx --test src/modules/rate-manager/__tests__/publish-scope.test.mts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derivePushScope, touchesRates, type PublishScopePatch } from "../publish-scope.js";

const BAR = "plan_bar";
const NR = "plan_nr";
const FLEX = "plan_flex";
const DBL = "rt_dbl";
const SUP = "rt_sup";
const D1 = "2027-03-01";

const childrenOf = new Map<string, Array<{ id: string }>>([[BAR, [{ id: NR }]]]);
const patch = (over: Partial<PublishScopePatch> = {}): PublishScopePatch => ({ ratePlanId: BAR, roomTypeId: DBL, ...over });

describe("derivePushScope", () => {
  it("one price cell → its room type, its plan + derived children, kinds [rates] (browser-ux#8: no fan-out)", () => {
    const scope = derivePushScope([patch({ price: 120 })], childrenOf);
    assert.deepEqual(scope, { roomTypeIds: [DBL], ratePlanIds: [BAR, NR], kinds: ["rates"] });
  });
  it("collects the distinct room types and plans of every patch, sorted and de-duplicated", () => {
    const scope = derivePushScope(
      [patch({ price: 120 }), patch({ roomTypeId: SUP, price: 130 }), patch({ ratePlanId: FLEX, roomTypeId: SUP, minPrice: 90 }), patch({ price: 121 })],
      childrenOf
    );
    assert.deepEqual(scope.roomTypeIds, [DBL, SUP]);
    assert.deepEqual(scope.ratePlanIds, [BAR, FLEX, NR]);
    assert.deepEqual(scope.kinds, ["rates"]);
  });
  it("available → availability; restrictions → restrictions; stopSell → restrictions + availability", () => {
    assert.deepEqual(derivePushScope([patch({ available: 3 })], childrenOf).kinds, ["availability"]);
    assert.deepEqual(derivePushScope([patch({ restrictions: { minLos: 2 } })], childrenOf).kinds, ["restrictions"]);
    assert.deepEqual(derivePushScope([patch({ restrictions: { stopSell: true } })], childrenOf).kinds, ["availability", "restrictions"]);
  });
  it("kinds keep the contract order rates, availability, restrictions whatever the patch order", () => {
    const scope = derivePushScope([patch({ restrictions: { cta: true } }), patch({ available: 2 }), patch({ price: 100 })], childrenOf);
    assert.deepEqual(scope.kinds, ["rates", "availability", "restrictions"]);
  });
  it('a room-level ("*") restriction applies to every plan: the plan filter is lifted and "*" is never a plan id', () => {
    const scope = derivePushScope([patch({ ratePlanId: "*", restrictions: { closed: true } })], childrenOf);
    assert.deepEqual(scope, { roomTypeIds: [DBL], ratePlanIds: undefined, kinds: ["restrictions"] });
  });
  it('a room-level ("*") availability patch keeps the plan filter (availability is per room type) and adds no rates', () => {
    const scope = derivePushScope([patch({ ratePlanId: "*", available: 4 }), patch({ ratePlanId: FLEX, price: 80 })], childrenOf);
    assert.deepEqual(scope, { roomTypeIds: [DBL], ratePlanIds: [FLEX], kinds: ["rates", "availability"] });
  });
  it("derivation triggers and revert hints count as rates (children are re-materialised)", () => {
    for (const over of [{ convertToManual: true }, { revertToDerived: true }, { rematerializeOnly: true }, { restoreSource: "import" }, { occupancyPrices: { "2": 90 } }, { maxPrice: 200 }, { price: null }] as Partial<PublishScopePatch>[]) {
      assert.equal(touchesRates(patch(over)), true, JSON.stringify(over));
      assert.deepEqual(derivePushScope([patch(over)], childrenOf).kinds, ["rates"], JSON.stringify(over));
    }
  });
  it("a patch with no publishable field (only flags) → kinds [] so the service can skip the publish", () => {
    const scope = derivePushScope([patch({ respectManualOverrides: false } as PublishScopePatch)], childrenOf);
    assert.deepEqual(scope, { roomTypeIds: [DBL], ratePlanIds: [BAR, NR], kinds: [] });
  });
  it("does not mutate the childrenOf map nor the patches", () => {
    const patches = [patch({ price: 1 })];
    derivePushScope(patches, childrenOf);
    assert.deepEqual(patches, [{ ratePlanId: BAR, roomTypeId: DBL, price: 1 }]);
    assert.deepEqual([...childrenOf.keys()], [BAR]);
  });
});
