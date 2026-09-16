// Cocoa 22 · CocoaStepper touch geometry (qa#6, fix:primitives).
//
// At 390×844 with a coarse pointer the ± buttons of every stepper measured
// 15 × 14 / 15 × 13 (/recepcion/reservas/nueva: 8 controls under the 44 px
// of §4.3 V6; the only ones on the screen). The shell now grows to 44 px like
// CocoaInput / CocoaSelect / CocoaDatePicker and the pair becomes a row of two
// 44 × 44 buttons «− +»; the 1 px border is painted by the parts, not by the
// shell, so the buttons' own boxes — what the §5.4 probe measures — reach 44.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaStepper, stepperGeometry, stepperPartStyles } from "../CocoaStepper.tsx";
import { CONTROL_BORDER_PX, CONTROL_HEIGHT_BY_SIZE } from "../CocoaInput.tsx";
import { TAP_TARGET_PX } from "../../../lib/useCoarsePointer.ts";

const INCREMENT_RE = /<button[^>]*aria-label="Aumentar"[^>]*>/;
const DECREMENT_RE = /<button[^>]*aria-label="Reducir"[^>]*>/;
const SHELL_RE = /<span[^>]*data-cocoa="stepper"[^>]*>/;
const INPUT_RE = /<input[^>]*type="number"[^>]*>/;

function render(coarse: boolean, props: Record<string, unknown> = {}): string {
  // useCoarsePointer reads `window.matchMedia` during the first render
  // (useState initialiser); react-dom/server never runs effects.
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      addEventListener() {},
      removeEventListener() {}
    })
  };
  return renderToStaticMarkup(createElement(CocoaStepper, { value: 2, onChange: () => undefined, min: 1, ...props } as never));
}

function tag(html: string, re: RegExp): string {
  const match = html.match(re);
  assert.ok(match, `no match for ${re} in ${html}`);
  return match[0];
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("CocoaStepper · geometry (pure)", () => {
  it("fine pointer: stacked column at the shared control heights, buttons 18 / 16 px wide with their borders", () => {
    assert.deepEqual(stepperGeometry("regular", false), { direction: "column", height: CONTROL_HEIGHT_BY_SIZE.regular, buttonWidth: 16 + 2 * CONTROL_BORDER_PX, chevronSize: 8 });
    assert.deepEqual(stepperGeometry("small", false), { direction: "column", height: CONTROL_HEIGHT_BY_SIZE.small, buttonWidth: 14 + 2 * CONTROL_BORDER_PX, chevronSize: 7 });
  });
  it(`coarse pointer: a ${TAP_TARGET_PX} px row whose buttons are ${TAP_TARGET_PX} px wide, whatever the size`, () => {
    assert.equal(TAP_TARGET_PX, 44);
    for (const size of ["small", "regular"] as const) {
      const geometry = stepperGeometry(size, true);
      assert.equal(geometry.direction, "row", size);
      assert.equal(geometry.height, TAP_TARGET_PX, size);
      assert.equal(geometry.buttonWidth, TAP_TARGET_PX, size);
      assert.ok(geometry.chevronSize >= 10, `${size}: legible glyph in a 44 px cell`);
    }
  });
});

describe("CocoaStepper · part borders (pure)", () => {
  const chrome = "var(--cocoa-accent)";
  const outer = `1px solid ${chrome}`;
  const divider = "1px solid var(--cocoa-separator)";
  it("the input always paints the left, top and bottom edges and no right edge", () => {
    for (const direction of ["column", "row"] as const) {
      const { input } = stepperPartStyles(direction, chrome);
      assert.equal(input.borderLeft, outer);
      assert.equal(input.borderTop, outer);
      assert.equal(input.borderBottom, outer);
      assert.equal(input.borderRight, "none");
      assert.equal(input.borderRadius, "var(--cocoa-radius-md) 0 0 var(--cocoa-radius-md)");
    }
  });
  it("column: the outer edge is chrome on top / right / bottom and the dividers are separator", () => {
    const { increment, decrement } = stepperPartStyles("column", chrome);
    assert.equal(increment.borderTop, outer);
    assert.equal(increment.borderRight, outer);
    assert.equal(increment.borderBottom, divider);
    assert.equal(increment.borderLeft, divider);
    assert.equal(decrement.borderTop, "none");
    assert.equal(decrement.borderRight, outer);
    assert.equal(decrement.borderBottom, outer);
    assert.equal(decrement.borderLeft, divider);
    assert.equal(increment.borderRadius, "0 var(--cocoa-radius-md) 0 0");
    assert.equal(decrement.borderRadius, "0 0 var(--cocoa-radius-md) 0");
  });
  it("row: «−» carries a left divider only, «+» closes the shell on the right", () => {
    const { increment, decrement } = stepperPartStyles("row", chrome);
    for (const part of [increment, decrement]) {
      assert.equal(part.borderTop, outer);
      assert.equal(part.borderBottom, outer);
      assert.equal(part.borderLeft, divider);
    }
    assert.equal(decrement.borderRight, "none");
    assert.equal(decrement.borderRadius, 0);
    assert.equal(increment.borderRight, outer);
    assert.equal(increment.borderRadius, "0 var(--cocoa-radius-md) var(--cocoa-radius-md) 0");
  });
});

describe("CocoaStepper · rendered control", () => {
  it("fine pointer: 28 px shell, «+» above «−», 18 px buttons sharing the height; the shell itself has no border", () => {
    const html = render(false);
    const shell = tag(html, SHELL_RE);
    assert.match(shell, /height:28px/);
    assert.match(shell, /data-direction="column"/);
    assert.doesNotMatch(shell, /border:|border-top|border-left/);
    assert.match(tag(html, INCREMENT_RE), /width:18px/);
    assert.match(tag(html, INCREMENT_RE), /flex:1 1 0/);
    assert.ok(html.indexOf('aria-label="Aumentar"') < html.indexOf('aria-label="Reducir"'), "+ first when stacked");
    assert.match(tag(html, INPUT_RE), /border-right:none/);
  });

  it(`coarse pointer: ${TAP_TARGET_PX} px shell and two ${TAP_TARGET_PX} × ${TAP_TARGET_PX} buttons «− +» (qa#6)`, () => {
    const html = render(true);
    const shell = tag(html, SHELL_RE);
    assert.match(shell, /height:44px/);
    assert.match(shell, /data-direction="row"/);
    const increment = tag(html, INCREMENT_RE);
    const decrement = tag(html, DECREMENT_RE);
    for (const button of [increment, decrement]) {
      assert.match(button, /width:44px/);
      assert.match(button, /box-sizing:border-box/);
      // The row stretches each cell to the 44 px shell (align-items: stretch) — no half-height flex share.
      assert.match(button, /flex:0 0 auto/);
    }
    assert.ok(html.indexOf('aria-label="Reducir"') < html.indexOf('aria-label="Aumentar"'), "− before + on touch");
    assert.match(html, /flex-direction:row/);
  });

  it("small size also reaches 44 px on touch (CashClosureScreen denominations)", () => {
    const html = render(true, { size: "small" });
    assert.match(tag(html, SHELL_RE), /height:44px/);
    assert.match(tag(html, DECREMENT_RE), /width:44px/);
  });

  it("keyboard path is untouched: the buttons stay out of the tab order and the field keeps min/max", () => {
    const html = render(true, { max: 8 });
    assert.match(tag(html, INCREMENT_RE), /tabindex="-1"/);
    assert.match(tag(html, DECREMENT_RE), /tabindex="-1"/);
    const input = tag(html, INPUT_RE);
    assert.match(input, /min="1"/);
    assert.match(input, /max="8"/);
    assert.match(input, /inputmode="decimal"/i);
  });
});
