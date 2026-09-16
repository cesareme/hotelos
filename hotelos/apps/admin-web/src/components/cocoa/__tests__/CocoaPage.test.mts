// Cocoa 22 · CocoaPage fullBleed (fix:3-A qa#19, plan R29): the page keeps
// the content gutter and only the wide scroller bleeds into it.
//
// Measured at 390 × 844 on /recepcion/reservas/cronograma before the fix:
// `.c22-page[data-full-bleed]` carried the negative margin, so the whole body
// lost the 16 px gutter — the chip row «Estado · Confirmada» started at x = 0
// while §5.1 asks for padding 16 below 600 on everything but the
// CocoaScrollArea. cocoa-22-layout.css now bleeds only a
// `[data-cocoa="scroll-area"]` (or the rate grid `.crg`) that is a direct
// child of `.c22-page__body`; header, toolbar, chips, callouts and states keep
// the gutter, so the header no longer needs its own padding rule.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaPage } from "../CocoaPage.tsx";
import { CocoaScrollArea } from "../CocoaScrollArea.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const layoutCss = readFileSync(resolve(here, "../../../styles/cocoa-22-layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string };

/** Every `selector { declarations }` pair of the sheet (inside @media too; the @media header itself has no declarations and is skipped). */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: match[2].trim() });
  }
  return out;
}

const fullBleedRules = rules(layoutCss).filter((rule) => /full-bleed/.test(rule.selector));
const BLEED_SELECTOR = '> .c22-page__body > :is([data-cocoa="scroll-area"], .crg)';

/** Top-level comma split of a selector list (commas inside `:is(…)` stay put). */
function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** Expected `getBoundingClientRect()` probe values (§5.4) for the two bleed subjects at a viewport where `main` starts at `mainLeft`. */
function bleedGeometry(input: { mainLeft: number; mainWidth: number; gutter: number }) {
  const contentLeft = input.mainLeft + input.gutter;
  const contentWidth = input.mainWidth - 2 * input.gutter;
  return {
    /** Toolbar, chip row, callouts, states: the content gutter. */
    gutterChild: { left: contentLeft, right: contentLeft + contentWidth },
    /** CocoaScrollArea / .crg as a direct child of the body: both gutters cancelled. */
    scrollArea: { left: input.mainLeft, width: input.mainWidth }
  };
}

describe("cocoa-22-layout.css · fullBleed bleeds only the wide scroller (qa#19, R29)", () => {
  it("the page root and its header carry no full-bleed geometry any more", () => {
    for (const rule of fullBleedRules) {
      const targetsRoot = !rule.selector.includes(">");
      assert.ok(!targetsRoot, `page root still carries a full-bleed rule: ${rule.selector} { ${rule.body} }`);
      assert.ok(!/c22-page__header/.test(rule.selector), `header still re-indents itself: ${rule.selector}`);
    }
  });

  it("a CocoaScrollArea or .crg that is a direct child of the body cancels both gutters", () => {
    const bleed = fullBleedRules.filter((rule) => selectorParts(rule.selector).every((part) => part.endsWith(BLEED_SELECTOR)));
    assert.equal(bleed.length, 1, `expected one bleed rule ending in ${BLEED_SELECTOR}, found ${fullBleedRules.map((r) => r.selector).join(" | ")}`);
    const [rule] = bleed;
    // Both hooks of the §8 contract: the class alias and the data attribute.
    assert.match(rule.selector, /\.c22-page--full-bleed > \.c22-page__body/);
    assert.match(rule.selector, /\.c22-page\[data-full-bleed="true"\] > \.c22-page__body/);
    assert.match(rule.body, /margin-inline: calc\(var\(--cocoa-content-padding\) \* -1\);/);
    // `.c22-scroll-area` caps itself at `max-width: 100%`; stretched by the flex column the cap must grow by the same two gutters.
    assert.match(rule.body, /max-width: calc\(100% \+ 2 \* var\(--cocoa-content-padding\)\);/);
    assert.doesNotMatch(rule.body, /width: auto/);
  });

  it("only those two subjects bleed: no other full-bleed rule remains", () => {
    assert.equal(fullBleedRules.length, 1, fullBleedRules.map((r) => r.selector).join(" | "));
  });

  it("probe values §5.4 — phone 390 (gutter 16) and canon 1440 (gutter 24)", () => {
    // 390 × 844: `main` is the viewport (drawer navigation), content padding 16.
    const phone = bleedGeometry({ mainLeft: 0, mainWidth: 390, gutter: 16 });
    assert.deepEqual(phone.gutterChild, { left: 16, right: 374 }); // chips row [aria-label="Filtros del cronograma"]
    assert.deepEqual(phone.scrollArea, { left: 0, width: 390 }); // [aria-label="Cronograma de reservas por habitación"]
    // 1440: sidebar 240, `main` 1200 wide, content padding 24 → 1152 useful (canon 1120 measured with the split view; the bleed adds both gutters).
    const desktop = bleedGeometry({ mainLeft: 240, mainWidth: 1200, gutter: 24 });
    assert.deepEqual(desktop.gutterChild, { left: 264, right: 1416 });
    assert.deepEqual(desktop.scrollArea, { left: 240, width: 1200 });
  });
});

describe("CocoaPage · the markup the bleed rule relies on", () => {
  const chips = createElement("div", { className: "cocoa-row", "data-gap": "2", role: "group", "aria-label": "Filtros del cronograma" }, "Estado");
  const grid = createElement(CocoaScrollArea, { axis: "both", stickyFirstColumn: true, "aria-label": "Cronograma" }, createElement("table", { "data-cocoa-grid-table": true }));

  it("fullBleed emits data-full-bleed on the root and keeps the scroller a direct child of .c22-page__body", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Cronograma", fullBleed: true, children: [chips, grid] } as never));
    assert.match(html, /<div[^>]*class="c22-page cocoa-page"[^>]*data-full-bleed="true"/);
    const body = html.match(/<div class="c22-page__body cocoa-page-body">([\s\S]*)<\/div><\/div>$/);
    assert.ok(body, `body wrapper not found in ${html}`);
    // First child: the chip row (keeps the gutter); second child: the scroll area (bleeds).
    assert.match(body[1], /^<div class="cocoa-row" data-gap="2" role="group" aria-label="Filtros del cronograma">Estado<\/div><div [^>]*class="c22-scroll-area cocoa-scroll-area"[^>]*data-cocoa="scroll-area"/);
  });

  it("without fullBleed the attribute is absent, so the bleed rule never matches", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Cronograma", children: [chips, grid] } as never));
    assert.doesNotMatch(html, /data-full-bleed/);
  });
});
