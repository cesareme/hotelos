// Cocoa 22 · CocoaSelect `inline` (fix:L7 qa#6): the wrapper of a select fills
// its row by default (a form field); a picker in an actions row or a toolbar
// asks for `inline` and shrinks to its widest option instead. Measured at
// 1440 × 900 on /cumplimiento/modelos-aeat before the fix: «Trimestre»,
// «Ejercicio» and «Desglose por centro» were 1152 px each and stacked in the
// flex-wrap actions row of HostedHead, while the «Ámbito» selector (wrapped in
// an inline-flex span by FinanceScopeSelector) measured 224 px.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaSelect } from "../CocoaSelect.tsx";

const OPTIONS = [
  { value: "1", label: "1T · enero a marzo" },
  { value: "2", label: "2T · abril a junio" }
];

function wrapper(html: string): string {
  const match = html.match(/<span class="cocoa-select"[^>]*>/);
  assert.ok(match, `wrapper span not found in ${html}`);
  return match[0];
}

describe("CocoaSelect · inline", () => {
  it("fills its row by default (form field) and says nothing about inline", () => {
    const html = renderToStaticMarkup(createElement(CocoaSelect, { value: "1", onChange: () => undefined, options: OPTIONS, "aria-label": "Trimestre" }));
    const span = wrapper(html);
    assert.match(span, /width:100%/);
    assert.doesNotMatch(span, /data-inline/);
    assert.match(html, /aria-label="Trimestre"/);
  });

  it("`inline` shrinks the wrapper to its content (width auto, never wider than the row) and marks it for the probes", () => {
    const html = renderToStaticMarkup(createElement(CocoaSelect, { value: "1", onChange: () => undefined, options: OPTIONS, size: "small", inline: true }));
    const span = wrapper(html);
    assert.match(span, /width:auto/);
    assert.match(span, /max-width:100%/);
    assert.match(span, /data-inline="true"/);
    assert.match(span, /data-size="small"/);
  });

  it("the `style` escape hatch still wins over the inline width", () => {
    const html = renderToStaticMarkup(createElement(CocoaSelect, { value: "1", onChange: () => undefined, options: OPTIONS, inline: true, style: { width: 180 } }));
    assert.match(wrapper(html), /width:180px/);
  });
});
