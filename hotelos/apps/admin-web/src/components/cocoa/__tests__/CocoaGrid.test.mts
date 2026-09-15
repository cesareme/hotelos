import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRID_DESKTOP_WIDTH, SPAN_MIN_BUCKETS, effectiveSpan, minBucket, spanClassNames, spanWidth, tabletSpan } from "../CocoaGrid.tsx";

// Canon: 1120 px content → 12 × 82.3 px, gap 12.
const CANON = { columns: 12, width: 1120, gap: 12 };

describe("CocoaGrid · spanWidth", () => {
  it("reproduces the canon column width (82.3 px) and the 8-col pace card", () => {
    const column = spanWidth(1, CANON.columns, CANON.width, CANON.gap);
    assert.ok(Math.abs(column - 82.33) < 0.01);
    const eight = spanWidth(8, CANON.columns, CANON.width, CANON.gap);
    assert.ok(Math.abs(eight - (8 * column + 7 * 12)) < 1e-9);
    assert.equal(spanWidth(12, 12, 1120, 12), 1120);
  });
});

describe("CocoaGrid · effectiveSpan (§3.4 / §5.1)", () => {
  it("keeps the requested span before the first measurement", () => {
    assert.equal(effectiveSpan({ cols: 8, columns: 12, width: null, gap: 12 }), 8);
    assert.equal(effectiveSpan({ cols: 14, columns: 12, width: null, gap: 12 }), 12);
    assert.equal(effectiveSpan({ cols: 0, columns: 12, width: null, gap: 12 }), 1);
  });
  it("stacks to one column below 600 px", () => {
    assert.equal(effectiveSpan({ cols: 2, columns: 12, width: 358, gap: 12 }), 12);
    assert.equal(effectiveSpan({ cols: 8, columns: 12, width: 599, gap: 12 }), 12);
    assert.equal(effectiveSpan({ cols: 1, columns: 4, width: 300, gap: 12 }), 4);
  });
  it("promotes spans smaller than half to half between 600 and 899 px", () => {
    assert.equal(effectiveSpan({ cols: 2, columns: 12, width: 700, gap: 12 }), 6);
    assert.equal(effectiveSpan({ cols: 5, columns: 12, width: 700, gap: 12 }), 6);
    assert.equal(effectiveSpan({ cols: 8, columns: 12, width: 700, gap: 12 }), 8);
    assert.equal(effectiveSpan({ cols: 1, columns: 6, width: 700, gap: 12 }), 3);
  });
  it("honours the real spans at the canon width (2-col tiles stay 176 px with min 200, like the stylesheet)", () => {
    for (const cols of [2, 3, 4, 5, 8, 12]) {
      assert.equal(effectiveSpan({ cols, columns: 12, width: 1120, gap: 12, min: cols === 8 ? 480 : cols >= 4 ? 320 : cols === 3 ? 240 : 200 }), cols);
    }
    // Desktop tier by grid width (≥ 912): never promoted by `min`.
    assert.equal(effectiveSpan({ cols: 2, columns: 12, width: 1000, gap: 12, min: 200 }), 2);
    assert.equal(effectiveSpan({ cols: 2, columns: 12, width: 912, gap: 12, min: 200 }), 2);
    assert.equal(GRID_DESKTOP_WIDTH, 912);
  });
  it("promotes a span whose `min` does not fit to half, then to full (below the desktop grid width)", () => {
    // 905 px (laptop tier): 2 columns = 2 × 64.4 + 12 ≈ 141 px < 200 → half.
    assert.equal(effectiveSpan({ cols: 2, columns: 12, width: 905, gap: 12, min: 200 }), 6);
    assert.equal(effectiveSpan({ cols: 8, columns: 12, width: 905, gap: 12, min: 480 }), 8);
    // 900 px content: 2 columns = 2 × 64 + 12 = 140 px < 200 → half (6 × 64 + 60 = 444 ≥ 200).
    assert.equal(effectiveSpan({ cols: 2, columns: 12, width: 900, gap: 12, min: 200 }), 6);
    // 900 px: 8 columns = 8 × 64 + 84 = 596 ≥ 480 → stays.
    assert.equal(effectiveSpan({ cols: 8, columns: 12, width: 900, gap: 12, min: 480 }), 8);
    // 900 px: 6 columns = 444 < 480 → full.
    assert.equal(effectiveSpan({ cols: 6, columns: 12, width: 900, gap: 12, min: 480 }), 12);
    // Half does not fit either → full.
    assert.equal(effectiveSpan({ cols: 3, columns: 12, width: 900, gap: 12, min: 600 }), 12);
  });
});

describe("CocoaGrid · classes for the stylesheet", () => {
  it("tabletSpan is at least half the grid", () => {
    assert.equal(tabletSpan(2, 12), 6);
    assert.equal(tabletSpan(8, 12), 8);
    assert.equal(tabletSpan(1, 4), 2);
    assert.equal(tabletSpan(20, 12), 12);
  });
  it("minBucket picks the smallest stylesheet bucket that honours the minimum", () => {
    assert.deepEqual([...SPAN_MIN_BUCKETS], [200, 240, 320, 480]);
    assert.equal(minBucket(undefined), null);
    assert.equal(minBucket(0), null);
    assert.equal(minBucket(150), 200);
    assert.equal(minBucket(200), 200);
    assert.equal(minBucket(201), 240);
    assert.equal(minBucket(320), 320);
    assert.equal(minBucket(400), 480);
    assert.equal(minBucket(999), 480);
  });
  it("spanClassNames emits c22-span-N, c22-min-B and c22-rowspan-R (capped at 3)", () => {
    assert.deepEqual(spanClassNames({ span: 8, min: 480 }), ["c22-span-8", "c22-min-480"]);
    assert.deepEqual(spanClassNames({ span: 2 }), ["c22-span-2"]);
    assert.deepEqual(spanClassNames({ span: 4, min: 320, rowSpan: 2 }), ["c22-span-4", "c22-min-320", "c22-rowspan-2"]);
    assert.deepEqual(spanClassNames({ span: 4, rowSpan: 5 }), ["c22-span-4", "c22-rowspan-3"]);
    assert.deepEqual(spanClassNames({ span: 4, rowSpan: 1 }), ["c22-span-4"]);
  });
});
