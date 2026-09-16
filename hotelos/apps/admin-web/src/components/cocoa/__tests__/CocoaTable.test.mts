import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VIRTUALIZE_CHUNK, VIRTUALIZE_THRESHOLD, columnSizingStyle, defaultRender, densityRowPadding, isColumnVisible, isTableOverflowing, nextSort, resolveRowKey, visibleRowCount, wrapOverflowStyle } from "../CocoaTable.tsx";

describe("CocoaTable · sorting", () => {
  it("toggles asc → desc on the same key and starts asc on a new key", () => {
    assert.deepEqual(nextSort(undefined, "name"), { key: "name", direction: "asc" });
    assert.deepEqual(nextSort({ key: "name", direction: "asc" }, "name"), { key: "name", direction: "desc" });
    assert.deepEqual(nextSort({ key: "name", direction: "desc" }, "name"), { key: "name", direction: "asc" });
    assert.deepEqual(nextSort({ key: "name", direction: "desc" }, "total"), { key: "total", direction: "asc" });
  });
});

describe("CocoaTable · progressive rendering", () => {
  it("renders everything up to the threshold, then chunks of 100", () => {
    assert.equal(VIRTUALIZE_THRESHOLD, 200);
    assert.equal(VIRTUALIZE_CHUNK, 100);
    assert.equal(visibleRowCount(150, 1), 150);
    assert.equal(visibleRowCount(200, 1), 200);
    assert.equal(visibleRowCount(450, 1), 200);
    assert.equal(visibleRowCount(450, 2), 300);
    assert.equal(visibleRowCount(450, 4), 450);
    assert.equal(visibleRowCount(450, 9), 450);
    assert.equal(visibleRowCount(450, 0), 200);
  });
});

describe("CocoaTable · density (§2.3)", () => {
  it("comfortable 8 12 · compact 4 10 · inherited from the page tokens when omitted", () => {
    assert.equal(densityRowPadding("comfortable"), "var(--cocoa-space-2) var(--cocoa-space-3)");
    assert.equal(densityRowPadding("compact"), "var(--cocoa-space-1) 10px");
    assert.match(densityRowPadding(undefined), /^var\(--cocoa-density-cell-padding-y, var\(--cocoa-space-2\)\) var\(--cocoa-density-cell-padding-x, var\(--cocoa-space-3\)\)$/);
  });
});

describe("CocoaTable · rows and cells", () => {
  it("resolves the row key from a function, a field or the index", () => {
    const row = { id: 7, code: "RES-1" };
    assert.equal(resolveRowKey(row, (r) => r.code, 0), "RES-1");
    assert.equal(resolveRowKey(row, "id", 0), "7");
    assert.equal(resolveRowKey(row, "missing", 3), "3");
    assert.equal(resolveRowKey(row, undefined, 5), "5");
  });
  it("defaultRender prints scalars, «—» for nothing and Sí/No for booleans", () => {
    const row = { a: "x", b: 2, c: null, d: undefined, e: true, f: false, g: { nested: 1 } };
    assert.equal(defaultRender(row, "a"), "x");
    assert.equal(defaultRender(row, "b"), 2);
    assert.equal(defaultRender(row, "c"), "—");
    assert.equal(defaultRender(row, "d"), "—");
    assert.equal(defaultRender(row, "e"), "Sí");
    assert.equal(defaultRender(row, "f"), "No");
    assert.equal(defaultRender(row, "g"), null);
  });
});

describe("CocoaTable · wrapper overflow vs sticky head (§3.7, review#4)", () => {
  it("by default the wrapper is NOT a scroll container (clip), so the head sticks to the page scroller", () => {
    assert.deepEqual(wrapOverflowStyle({ overflowing: false }), { overflowX: "clip", overflowY: "visible" });
  });
  it("a table wider than its wrapper turns the wrapper into a horizontal scroller", () => {
    assert.deepEqual(wrapOverflowStyle({ overflowing: true }), { overflowX: "auto", overflowY: "hidden" });
  });
  it("maxHeight makes the wrapper the scroller (the head sticks inside it) whatever the width", () => {
    assert.deepEqual(wrapOverflowStyle({ maxHeight: 420, overflowing: true }), { overflow: "auto", maxHeight: 420 });
    assert.deepEqual(wrapOverflowStyle({ maxHeight: 0, overflowing: false }), { overflow: "auto", maxHeight: 0 });
  });
  it("overflow detection tolerates half a pixel of subpixel layout", () => {
    assert.equal(isTableOverflowing(800, 800), false);
    assert.equal(isTableOverflowing(800.4, 800), false);
    assert.equal(isTableOverflowing(801, 800), true);
  });
});

describe("CocoaTable · column visibility by tier (qa#2)", () => {
  it("shows every column everywhere by default", () => {
    for (const tier of ["phone", "tablet", "laptop", "desktop"] as const) assert.equal(isColumnVisible({}, tier), true);
  });
  it("hideOnNarrow hides only on phones (< 600, the card layout)", () => {
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "phone"), false);
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "tablet"), true);
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "laptop"), true);
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "desktop"), true);
  });
  it("showFrom hides the column below that tier: «desktop» hides it on a 1024 laptop", () => {
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "laptop"), false);
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "tablet"), false);
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "phone"), false);
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "desktop"), true);
    assert.equal(isColumnVisible({ showFrom: "laptop" }, "tablet"), false);
    assert.equal(isColumnVisible({ showFrom: "laptop" }, "laptop"), true);
    assert.equal(isColumnVisible({ showFrom: "tablet" }, "phone"), false);
    assert.equal(isColumnVisible({ showFrom: "tablet" }, "tablet"), true);
    assert.equal(isColumnVisible({ showFrom: "phone" }, "phone"), true);
  });
  it("hideOnNarrow and showFrom combine (the stricter one wins at each tier)", () => {
    assert.equal(isColumnVisible({ hideOnNarrow: true, showFrom: "desktop" }, "phone"), false);
    assert.equal(isColumnVisible({ hideOnNarrow: true, showFrom: "desktop" }, "laptop"), false);
    assert.equal(isColumnVisible({ hideOnNarrow: true, showFrom: "desktop" }, "desktop"), true);
  });
});

describe("CocoaTable · column sizing (qa#2)", () => {
  it("a plain text column has no sizing: it takes the free width and wraps", () => {
    assert.deepEqual(columnSizingStyle({}), {});
    assert.deepEqual(columnSizingStyle({ align: "left" }), {});
    assert.deepEqual(columnSizingStyle({ align: "center" }), {});
  });
  it("fit shrinks the column to its content on one line (1 px width = min-content in auto layout, like the actions cell)", () => {
    assert.deepEqual(columnSizingStyle({ fit: true }), { width: 1, whiteSpace: "nowrap" });
  });
  it("an explicit width wins over fit; minWidth passes through", () => {
    assert.deepEqual(columnSizingStyle({ fit: true, width: "11ch" }), { width: "11ch", whiteSpace: "nowrap" });
    assert.deepEqual(columnSizingStyle({ width: "11ch" }), { width: "11ch" });
    assert.deepEqual(columnSizingStyle({ minWidth: 200 }), { minWidth: 200 });
    assert.deepEqual(columnSizingStyle({ fit: true, minWidth: 96 }), { width: 1, minWidth: 96, whiteSpace: "nowrap" });
  });
  it("right-aligned (numeric) cells never wrap by default: «2.595,00 €» stays on one line", () => {
    assert.deepEqual(columnSizingStyle({ align: "right" }), { whiteSpace: "nowrap" });
    assert.deepEqual(columnSizingStyle({ align: "right", fit: true }), { width: 1, whiteSpace: "nowrap" });
  });
  it("nowrap is an explicit override in both directions", () => {
    assert.deepEqual(columnSizingStyle({ align: "right", nowrap: false }), {});
    assert.deepEqual(columnSizingStyle({ fit: true, nowrap: false }), { width: 1 });
    assert.deepEqual(columnSizingStyle({ nowrap: true }), { whiteSpace: "nowrap" });
  });
});
