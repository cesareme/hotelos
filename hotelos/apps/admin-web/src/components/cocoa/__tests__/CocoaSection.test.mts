// Cocoa 22 · CocoaSection header reflow (qa#19 → qa#1 / qa#2) and the
// CocoaField hint colour (qa#13).
//
// At 390 the section header already wrapped (`flex-wrap: wrap` < 600), but
// the meta + action row measured 453 px (/operaciones/tpv «Arqueo de caja»:
// a 62-character meta + 2 buttons) and 461 px (/revenue/exportaciones: badge
// + 3 buttons) inside a 358 px card, pushing `main` sideways. The cause was
// the primitive's inline `white-space: nowrap` / `flex-shrink: 0`, which no
// media query can beat: the head cluster now carries no inline style and the
// phone block of cocoa-22-layout.css caps the row at the card width.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaSection } from "../CocoaSection.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = resolve(here, "../../../styles");
const layoutCss = readFileSync(join(stylesDir, "cocoa-22-layout.css"), "utf8");
const cocoaCss = readFileSync(join(stylesDir, "cocoa-22.css"), "utf8");

const LONG_META = "Comandas cerradas en el rango, por punto de venta y medio de cobro";

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(CocoaSection, { title: "Arqueo de caja", ...props } as never, "cuerpo"));
}

/** Opening tag of the first element carrying `className` (the whole `<tag …>`). */
function openingTag(html: string, className: string): string {
  const match = html.match(new RegExp(`<[a-z0-9]+[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`));
  assert.ok(match, `no element with class ${className} in ${html}`);
  return match[0];
}

/** Body of the first `selector {…}` rule inside `css` (comments stripped). */
function ruleBody(css: string, selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = clean.indexOf(`${selector} {`);
  assert.ok(start >= 0, `rule ${selector} not found`);
  return clean.slice(start, clean.indexOf("}", start));
}

/** The `@media (max-width: 599px)` block that starts with `.c22-section__head`. */
function sectionPhoneBlock(): string {
  const clean = layoutCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /@media \(max-width: 599px\) \{\s*\.c22-section__head,[\s\S]*?\n\}/;
  const match = clean.match(re);
  assert.ok(match, "phone block for .c22-section__head not found in cocoa-22-layout.css");
  return match[0];
}

describe("CocoaSection · the head cluster carries no inline style (qa#19)", () => {
  it("head, heading, title, meta and action are pure hooks for the stylesheet", () => {
    const html = render({ meta: LONG_META, action: createElement("button", { type: "button" }, "Hoy") });
    for (const part of ["c22-section__head", "c22-section__heading", "c22-section__title", "c22-section__action", "c22-section__meta"]) {
      const tag = openingTag(html, part);
      assert.doesNotMatch(tag, /\sstyle=/, `${part} paints an inline style: ${tag}`);
    }
    assert.match(html, /<header class="c22-section__head cocoa-section-head">/);
    assert.match(html, /<span class="c22-section__meta">Comandas cerradas/);
  });

  it("keeps the header out of the DOM when there is nothing to show, and the body/footer hooks", () => {
    const html = render({ title: undefined, "aria-label": "Sin cabecera" });
    assert.doesNotMatch(html, /c22-section__head/);
    assert.match(html, /class="c22-section__body cocoa-section-body"/);
    const withFooter = render({ footer: "pie", padding: "none" });
    assert.match(openingTag(withFooter, "c22-section__footer"), /\sstyle=/, "the footer inset is prop-driven and stays inline");
  });

  it("padding=\"none\" delegates the 16 px head inset to [data-padding] in the stylesheet", () => {
    const html = render({ padding: "none", meta: "3 líneas" });
    assert.match(openingTag(html, "c22-section"), /data-padding="none"/);
    assert.doesNotMatch(openingTag(html, "c22-section__head"), /\sstyle=/);
    assert.ok(layoutCss.includes('.c22-section[data-padding="none"]:not([data-variant="plain"]) > .c22-section__head {'), "stylesheet inset rule missing");
  });
});

describe("cocoa-22-layout.css · phone block reflows meta + action inside the card (qa#19)", () => {
  it("below 600 the action row wraps, shrinks and never measures wider than the head", () => {
    const block = sectionPhoneBlock();
    assert.match(block, /\.c22-section__head,\s*\.cocoa-section-head \{ flex-wrap: wrap; \}/);
    const action = ruleBody(block, ".c22-section__action");
    assert.match(action, /flex-wrap: wrap;/);
    assert.match(action, /min-width: 0;/);
    assert.match(action, /max-width: 100%;/);
    const meta = ruleBody(block, ".c22-section__meta");
    assert.match(meta, /white-space: normal;/);
    assert.match(meta, /min-width: 0;/);
  });

  it("above 600 the canon stays: title nowrap + ellipsis, meta nowrap, action row shrink-0", () => {
    assert.match(ruleBody(layoutCss, ".c22-section__title"), /white-space: nowrap;[\s\S]*$/);
    assert.match(ruleBody(layoutCss, ".c22-section__title"), /min-width: 0;/);
    assert.match(ruleBody(layoutCss, ".c22-section__meta"), /white-space: nowrap;/);
    assert.doesNotMatch(ruleBody(layoutCss, ".c22-section__meta"), /flex-shrink: 0/, "a shrink-0 meta could never wrap its text on phones");
    assert.match(ruleBody(layoutCss, ".c22-section__action"), /flex-shrink: 0;/);
  });
});

describe("cocoa-22.css · CocoaField hint is informative text (qa#13)", () => {
  it(".c22-field__hint reads in label-secondary, never tertiary (spec §2.1: 1,88:1 is decoration only)", () => {
    const hint = ruleBody(cocoaCss, ".c22-field__hint");
    assert.match(hint, /color: var\(--cocoa-label-secondary\);/);
    assert.doesNotMatch(hint, /label-tertiary/);
  });
});
