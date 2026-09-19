import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { COCOA_BREAKPOINTS, isTouchLaptop, viewportTier } from "../cocoa-viewport.ts";
import { COCOA_SCRIM, FOCUSABLE_SELECTOR, initialFocusTarget, isFocusDisabled, isTopmostTrap, trapTabTarget } from "../cocoa-overlay.ts";

const here = dirname(fileURLToPath(import.meta.url));

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
  it("initial focus: a disabled preferred target (CTA born disabled, L-01) falls back to the first focusable, then the root", () => {
    const disabledCta = { disabled: true, getAttribute: () => null };
    const ariaDisabled = { getAttribute: (name: string) => (name === "aria-disabled" ? "true" : null) };
    const enabledCta = { disabled: false, getAttribute: () => null };
    const first = { getAttribute: () => null };
    const root = { getAttribute: () => null };
    assert.equal(isFocusDisabled(disabledCta), true);
    assert.equal(isFocusDisabled(ariaDisabled), true);
    assert.equal(isFocusDisabled(enabledCta), false);
    assert.equal(isFocusDisabled(null), true);
    assert.equal(initialFocusTarget(enabledCta, [first], root), enabledCta);
    assert.equal(initialFocusTarget(disabledCta, [first], root), first);
    assert.equal(initialFocusTarget(ariaDisabled, [first], root), first);
    assert.equal(initialFocusTarget(disabledCta, [], root), root);
    assert.equal(initialFocusTarget(null, [], null), null);
  });
  it("only the topmost trap captures a Tab pressed outside the panel (a dialog over a drawer)", () => {
    const drawer = {} as HTMLElement;
    const dialog = {} as HTMLElement;
    assert.equal(isTopmostTrap([drawer, dialog], dialog), true);
    assert.equal(isTopmostTrap([drawer, dialog], drawer), false);
    assert.equal(isTopmostTrap([], drawer), false);
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

// Tanda UX-1 · U10 (§7.2 «Tier de iPad apaisado», D4): 1024 px es `laptop`,
// pero con el dedo la página se comporta como tablet (inspector apilado).
describe("cocoa-viewport · isTouchLaptop (portátil táctil, U10)", () => {
  it("solo el tier laptop con puntero grueso es un portátil táctil", () => {
    assert.equal(isTouchLaptop("laptop", true), true);
    assert.equal(isTouchLaptop(viewportTier(1024), true), true, "iPad apaisado 1024 × 768 con el dedo");
    assert.equal(isTouchLaptop(viewportTier(1024), false), false, "1024 con ratón sigue siendo laptop normal");
    assert.equal(isTouchLaptop(viewportTier(820), true), false, "iPad vertical 820 es tablet, no portátil táctil");
    assert.equal(isTouchLaptop("desktop", true), false);
    assert.equal(isTouchLaptop("phone", true), false);
  });
  it("la banda tablet de cocoa-22-layout.css usa la misma condición y apila el inspector con selectores (0,2,0)", () => {
    const css = readFileSync(resolve(here, "../../../styles/cocoa-22-layout.css"), "utf8");
    const band = css.match(/@media \(pointer: coarse\) and \(min-width: 900px\) and \(max-width: 1199px\) \{([\s\S]*?)\n\}/);
    assert.ok(band, "falta la banda @media (pointer: coarse) and (min-width: 900px) and (max-width: 1199px)");
    assert.match(band[1], /\.c22-inspector-layout\[data-cocoa="inspector-layout"\] \{\s*flex-direction: column;/);
    assert.match(band[1], /\.c22-inspector\[data-cocoa="inspector"\] \{\s*width: auto;\s*position: static;\s*max-height: none;/);
  });
});
