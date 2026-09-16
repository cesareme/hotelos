import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { GRID_DESKTOP_WIDTH, SPAN_MIN_BUCKETS, effectiveSpan, minBucket, spanClassNames, spanWidth, tabletSpan } from "../CocoaGrid.tsx";

const LAYOUT_SHEET = readFileSync(new URL("../../../styles/cocoa-22-layout.css", import.meta.url), "utf8");
/** Strip block comments so the assertions only read rules, never prose. */
const RULES = LAYOUT_SHEET.replace(/\/\*[\s\S]*?\*\//g, "");

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

describe("CocoaGrid · row packing of the Workspace pair (qa#10, fix:3-C)", () => {
  // Recorrido del huésped at 1024 × 768: the grid measures 736 px beside the 240 px sidebar.
  const LAPTOP_GRID = { columns: 12, width: 736, gap: 12 };

  it("cannot keep 4 (min 320) and 8 (min 480) on one row below the desktop grid width", () => {
    const list = effectiveSpan({ ...LAPTOP_GRID, cols: 4, min: 320 });
    const detail = effectiveSpan({ ...LAPTOP_GRID, cols: 8, min: 480 });
    assert.equal(list, 6, "the list is promoted to half (362 px ≥ 320)");
    assert.equal(detail, 8, "the detail keeps 8 columns (487 px ≥ 480)");
    assert.ok(list + detail > 12, "6 + 8 no longer fit one row: the stylesheet must pack them");
    // 5/7 does not rescue the pair either: below 900 px of grid a 5 is promoted to half as well.
    assert.equal(effectiveSpan({ ...LAPTOP_GRID, cols: 5, min: 320 }), 6);
    // At the canon width the pair is untouched.
    assert.equal(effectiveSpan({ cols: 4, columns: 12, width: 1120, gap: 12, min: 320 }), 4);
    assert.equal(effectiveSpan({ cols: 8, columns: 12, width: 1120, gap: 12, min: 480 }), 8);
  });

  it("the stylesheet widens the 7…11 beside a measured promoted half (existing rule)", () => {
    assert.match(RULES, /\.c22-grid:has\(> \[data-cocoa="span"\]\[data-span="6"\]:is\(\[data-cols="1"\], \[data-cols="2"\], \[data-cols="3"\], \[data-cols="4"\], \[data-cols="5"\]\)[^{]*> :is\(\.c22-span-7, \.c22-span-8, \.c22-span-9, \.c22-span-10, \.c22-span-11\) \{\s*grid-column: 1 \/ -1;/);
  });

  it("a promoted half with only full-row neighbours takes the full row too (no hole beside the list)", () => {
    const FULL = String.raw`:is\(\.c22-span-7, \.c22-span-8, \.c22-span-9, \.c22-span-10, \.c22-span-11, \.c22-span-12\)`;
    // Measured flavour (data-span 6 with an authored cols < 6), any width, outside every @media block.
    const measured = new RegExp(
      String.raw`\n\.c22-grid > \[data-cocoa="span"\]\[data-span="6"\]:is\(\[data-cols="1"\], \[data-cols="2"\], \[data-cols="3"\], \[data-cols="4"\], \[data-cols="5"\]\):is\(:first-child, ${FULL} \+ \*\):is\(:last-child, :has\(\+ ${FULL}\)\) \{\s*grid-column: 1 \/ -1;\s*\}`
    );
    assert.match(RULES, measured);
    // Never an authored 6: the selector demands data-cols 1…5 (6/6 keeps pairing).
    assert.doesNotMatch(RULES, /\[data-span="6"\]:is\([^)]*\[data-cols="6"\]/);
    // Laptop class flavour (900–1199): the min pairs the sheet promotes to half, with `.c22-min-480` counted as a full row.
    const FULL_LAPTOP = String.raw`:is\(\.c22-span-7, \.c22-span-8, \.c22-span-9, \.c22-span-10, \.c22-span-11, \.c22-span-12, \.c22-min-480\)`;
    const laptop = new RegExp(
      String.raw`@media \(min-width: 900px\) and \(max-width: 1199px\) \{\s*\.c22-grid > :is\(:is\(\.c22-min-200, \.c22-min-240\):is\(\.c22-span-1, \.c22-span-2, \.c22-span-3\), \.c22-min-320:is\(\.c22-span-1, \.c22-span-2, \.c22-span-3, \.c22-span-4\)\):is\(:first-child, ${FULL_LAPTOP} \+ \*\):is\(:last-child, :has\(\+ ${FULL_LAPTOP}\)\) \{\s*grid-column: 1 \/ -1;`
    );
    assert.match(RULES, laptop);
    for (const [range, pair] of [
      ["900px\\) and \\(max-width: 911px", "\\.c22-min-200\\.c22-span-4"],
      ["900px\\) and \\(max-width: 1031px", "\\.c22-min-240\\.c22-span-4"],
      ["940px\\) and \\(max-width: 1072px", "\\.c22-min-320\\.c22-span-5"]
    ] as const) {
      assert.match(RULES, new RegExp(String.raw`@media \(min-width: ${range}\) \{[^@]*\.c22-grid > ${pair}:is\(:first-child, ${FULL_LAPTOP} \+ \*\):is\(:last-child, :has\(\+ ${FULL_LAPTOP}\)\) \{ grid-column: 1 \/ -1; \}`), `${pair} lone-half rule in ${range}`);
    }
  });
});
