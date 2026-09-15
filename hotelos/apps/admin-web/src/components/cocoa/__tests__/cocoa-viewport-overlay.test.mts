import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COCOA_BREAKPOINTS, viewportTier } from "../cocoa-viewport.ts";
import { COCOA_SCRIM, FOCUSABLE_SELECTOR, trapTabTarget } from "../cocoa-overlay.ts";

describe("cocoa-viewport · tiers (§5.1)", () => {
  it("uses the 600 / 900 / 1200 breakpoints", () => {
    assert.deepEqual(COCOA_BREAKPOINTS, { phone: 600, tablet: 900, desktop: 1200 });
  });
  it("classifies widths at the boundaries", () => {
    assert.equal(viewportTier(0), "phone");
    assert.equal(viewportTier(390), "phone");
    assert.equal(viewportTier(599), "phone");
    assert.equal(viewportTier(600), "tablet");
    assert.equal(viewportTier(899), "tablet");
    assert.equal(viewportTier(900), "laptop");
    assert.equal(viewportTier(1199), "laptop");
    assert.equal(viewportTier(1200), "desktop");
    assert.equal(viewportTier(1440), "desktop");
  });
});

describe("cocoa-overlay · focus trap (pure)", () => {
  it("focuses the root when nothing is focusable", () => {
    assert.equal(trapTabTarget({ count: 0, activeIndex: -1, shiftKey: false }), "root");
    assert.equal(trapTabTarget({ count: 0, activeIndex: -1, shiftKey: true }), "root");
  });
  it("wraps Tab from the last element to the first and Shift+Tab from the first to the last", () => {
    assert.equal(trapTabTarget({ count: 3, activeIndex: 2, shiftKey: false }), 0);
    assert.equal(trapTabTarget({ count: 3, activeIndex: 0, shiftKey: true }), 2);
  });
  it("pulls focus in when it is outside the trap", () => {
    assert.equal(trapTabTarget({ count: 3, activeIndex: -1, shiftKey: false }), 0);
    assert.equal(trapTabTarget({ count: 3, activeIndex: -1, shiftKey: true }), 2);
  });
  it("lets the browser handle the middle", () => {
    assert.equal(trapTabTarget({ count: 3, activeIndex: 1, shiftKey: false }), null);
    assert.equal(trapTabTarget({ count: 3, activeIndex: 1, shiftKey: true }), null);
    assert.equal(trapTabTarget({ count: 3, activeIndex: 0, shiftKey: false }), null);
    assert.equal(trapTabTarget({ count: 3, activeIndex: 2, shiftKey: true }), null);
  });
  it("targets every focusable kind and excludes tabindex -1", () => {
    assert.match(FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/);
    assert.match(FOCUSABLE_SELECTOR, /\[tabindex\]:not\(\[tabindex='-1'\]\)/);
    assert.match(FOCUSABLE_SELECTOR, /input:not\(\[disabled\]\):not\(\[type='hidden'\]\)/);
  });
  it("scrim is the token, not a literal", () => {
    assert.equal(COCOA_SCRIM, "var(--cocoa-scrim)");
  });
});
