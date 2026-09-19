import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CocoaScreenInstructionsCard,
  stripStepOrdinal
} from "../CocoaScreenInstructionsCard.tsx";
import { TAP_TARGET_PX } from "../../../lib/useCoarsePointer.ts";
import { TAXES_INSTRUCTIONS, TAX_COMPLIANCE_INSTRUCTIONS } from "../../../content/screen-instructions/taxes.ts";

// qa#10 (Cocoa 22, lote 4-A): at 390×844 with a coarse pointer the dismiss
// control measured 24×44 (`width: 24` on a raw <button>; mobile.css only
// lifts the height). It is now the canonical close "X" (CocoaButton
// plain/neutral/small, same as CocoaDrawer), which grows to ≥ 44×44 on touch.

const DISMISS_LABEL = "Cerrar instrucciones";
const BUTTON_RE = /<button[^>]*aria-label="Cerrar instrucciones"[^>]*>/;

function render(coarse: boolean): string {
  // useCoarsePointer reads `window.matchMedia` during the first render
  // (useState initialiser); react-dom/server never runs effects.
  const fakeWindow = {
    matchMedia: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      addEventListener() {},
      removeEventListener() {}
    })
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  return renderToStaticMarkup(
    createElement(CocoaScreenInstructionsCard, {
      title: "Cómo usar esta pantalla",
      description: "Tres pasos y listo.",
      steps: ["Uno", "Dos"],
      tip: "Un consejo",
      dismissible: true
    })
  );
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("CocoaScreenInstructionsCard · dismiss control (qa#10)", () => {
  it("is the canonical CocoaButton close (plain · neutral · small) with its accessible name", () => {
    const html = render(false);
    const button = html.match(BUTTON_RE)?.[0];
    assert.ok(button, "dismiss button rendered");
    assert.match(button, /data-cocoa="button"/);
    assert.match(button, /data-variant="plain"/);
    assert.match(button, /data-tone="neutral"/);
    assert.match(button, /data-size="small"/);
    assert.match(button, /class="[^"]*cocoa-focus-ring/);
    assert.doesNotMatch(button, /width:24px/);
  });

  it("keeps the dense 22 px control on a fine pointer (box raised to the 24 px floor of WCAG 2.5.8 · UX-1 U5, CocoaButton SMALL_TARGET_MIN_PX)", () => {
    const button = render(false).match(BUTTON_RE)?.[0] ?? "";
    assert.match(button, /height:22px/);
    assert.match(button, /min-height:24px/);
    assert.doesNotMatch(button, /min-width:44px/);
  });

  it(`grows to a ${TAP_TARGET_PX}×${TAP_TARGET_PX} tap target on a coarse pointer`, () => {
    const button = render(true).match(BUTTON_RE)?.[0] ?? "";
    assert.equal(TAP_TARGET_PX, 44);
    assert.match(button, /min-width:44px/);
    assert.match(button, /min-height:44px/);
  });

  it("does not render the control when not dismissible", () => {
    (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
    const html = renderToStaticMarkup(
      createElement(CocoaScreenInstructionsCard, { title: "T", description: "D" })
    );
    assert.doesNotMatch(html, new RegExp(DISMISS_LABEL));
  });
});

// qa#9 (Cocoa 22, lote 8-C): /cumplimiento/impuestos read "1  1. Comprueba…"
// because the copy hand-numbered its steps while the badge already paints
// `index + 1`. The card strips a leading ordinal and the taxes copy no longer
// carries one.

const ORDINAL_RE = /^\d+[.)]\s/;

function stepTexts(html: string): string[] {
  return Array.from(html.matchAll(/<li[^>]*>.*?<\/li>/g)).map((m) => {
    const inner = m[0].replace(/<span[^>]*aria-hidden="true"[^>]*>\d+<\/span>/, "");
    return inner.replace(/<[^>]+>/g, "").trim();
  });
}

describe("CocoaScreenInstructionsCard · step numbering (qa#9)", () => {
  it("stripStepOrdinal removes a hand-written ordinal and nothing else", () => {
    assert.equal(stripStepOrdinal("1. Comprueba la región fiscal"), "Comprueba la región fiscal");
    assert.equal(stripStepOrdinal("12) Revisa el tipo"), "Revisa el tipo");
    assert.equal(stripStepOrdinal("  3.  Con espacios"), "Con espacios");
    assert.equal(stripStepOrdinal("2.5 % de recargo"), "2.5 % de recargo");
    assert.equal(stripStepOrdinal("2026. Ejercicio"), "2026. Ejercicio");
    assert.equal(stripStepOrdinal("Sin numeral"), "Sin numeral");
  });

  it("paints the badge once and never repeats the ordinal in the text", () => {
    (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
    const html = renderToStaticMarkup(
      createElement(CocoaScreenInstructionsCard, {
        title: "T",
        description: "D",
        steps: ["1. Comprueba la región fiscal", "2. Revisa el tipo", "Sin numeral"]
      })
    );
    const badges = Array.from(html.matchAll(/aria-hidden="true"[^>]*>(\d+)<\/span>/g)).map((m) => m[1]);
    assert.deepEqual(badges, ["1", "2", "3"]);
    assert.deepEqual(stepTexts(html), ["Comprueba la región fiscal", "Revisa el tipo", "Sin numeral"]);
  });

  it("the taxes copy itself no longer hand-numbers its steps", () => {
    for (const step of [...TAXES_INSTRUCTIONS.howToUse, ...TAX_COMPLIANCE_INSTRUCTIONS.howToUse]) {
      assert.doesNotMatch(step, ORDINAL_RE, `step still carries an ordinal: ${step}`);
    }
  });
});
