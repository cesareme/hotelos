// Coverage contract of the Cocoa 22 style guide (screens/dev/StyleGuideScreen.tsx).
//
// The guide is the living reference the migration waves copy from, so every
// state / prop the waves will need must be rendered live in it — not only
// quoted in a code sample (review#27). This test reads the source, strips the
// template literals (the copyable samples) and checks the real JSX for each
// required usage, plus the hygiene rules the guide must keep as a dev-only
// screen outside the §9 allowlist: no raw controls, no colour literals, a
// bounded number of inline `style={` props, and one block per index entry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "StyleGuideScreen.tsx"), "utf8");

/** Source without its template literals (code samples), so checks hit real JSX only. */
const jsx = source.replace(/`(?:\\.|[^`\\])*`/g, "``");

/** Opening tag of the guide's own <CocoaPage …> (props up to the line that closes the tag). */
function pageOpeningTag(): string {
  const start = jsx.lastIndexOf("<CocoaPage\n");
  assert.ok(start >= 0, "the guide must render a <CocoaPage> with its props on separate lines");
  const end = jsx.indexOf("\n    >", start);
  assert.ok(end > start, "the <CocoaPage> opening tag must close on its own line");
  return jsx.slice(start, end);
}

/** Inline `style={` budget of the guide: the presentational helpers (named objects with system values) plus layout-only props of the demos and the colour swatch (ola 11: 37 real + 2). */
const INLINE_STYLE_BUDGET = 39;

/**
 * `<Name …prop…>` somewhere in the JSX: the prop must appear within the 600
 * characters that follow the tag name (props of these tags hold arrow
 * functions and comparisons, so `[^>]*` cannot delimit the opening tag).
 */
function usage(name: string, prop: string): RegExp {
  return new RegExp(`<${name.replace(".", "\\.")}(?:<\\w+>)?[\\s/>][\\s\\S]{0,600}?${prop}`);
}

const REQUIRED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "CocoaGrid columns={6}", pattern: usage("CocoaGrid", "\\bcolumns=\\{6\\}") },
  { label: "CocoaGrid columns={4}", pattern: usage("CocoaGrid", "\\bcolumns=\\{4\\}") },
  { label: "CocoaGrid align={…}", pattern: usage("CocoaGrid", "\\balign=\\{") },
  { label: "CocoaSpan rowSpan={2}", pattern: usage("CocoaSpan", "\\browSpan=\\{2\\}") },
  { label: "CocoaActionBar mobileOnly", pattern: usage("CocoaActionBar", "\\bmobileOnly\\b") },
  { label: "CocoaTable virtualize", pattern: usage("CocoaTable", "\\bvirtualize\\b") },
  { label: "CocoaTable maxHeight", pattern: usage("CocoaTable", "\\bmaxHeight=\\{") },
  { label: "CocoaChart.Gauge invert", pattern: usage("CocoaChart.Gauge", "\\binvert\\b") },
  { label: "CocoaChart.Line legend={false}", pattern: usage("CocoaChart.Line", "\\blegend=\\{false\\}") },
  { label: "CocoaChart.Line tooltipTitle", pattern: usage("CocoaChart.Line", "\\btooltipTitle=\\{") },
  { label: "CocoaLiveRegion politeness", pattern: usage("CocoaLiveRegion", "\\bpoliteness=\\{") },
  { label: "CocoaScrollArea axis=\"y\"", pattern: usage("CocoaScrollArea", '\\baxis="y"') },
  { label: "CocoaScrollArea axis=\"x\" stickyFirstColumn", pattern: usage("CocoaScrollArea", '\\baxis="x"[^>]*\\bstickyFirstColumn\\b') },
  { label: "CocoaDrawer dismissible={…}", pattern: usage("CocoaDrawer", "\\bdismissible=\\{") },
  { label: "CocoaDrawer initialFocus={…}", pattern: usage("CocoaDrawer", "\\binitialFocus=\\{") },
  { label: "DegradedCard", pattern: usage("DegradedCard", "\\btitle=") },
  { label: "DegradedValue / DegradedNote / DegradedBanner", pattern: /<DegradedValue\b[\s\S]*<DegradedNote\b[\s\S]*<DegradedBanner\b|<DegradedBanner\b[\s\S]*<DegradedNote\b/ },
  { label: "CocoaCallout role=\"note\"", pattern: usage("CocoaCallout", '\\brole="note"') },
  { label: "CocoaCallout variant=\"banner\"", pattern: usage("CocoaCallout", '\\bvariant="banner"') },
  { label: "CocoaState dashed", pattern: usage("CocoaState", "\\bdashed\\b") },
  { label: "CocoaState inline", pattern: usage("CocoaState", "\\binline\\b") },
  { label: "CocoaSkeleton.Grid + Strip", pattern: /<CocoaSkeleton\.Grid\b[\s\S]*<CocoaSkeleton\.Strip\b/ },
  { label: "CocoaKpi degraded", pattern: usage("CocoaKpi", "\\bdegraded\\b") },
  { label: "CocoaKpi size=\"compact\"", pattern: usage("CocoaKpi", '\\bsize="compact"') },
  { label: "CocoaDialog tone destructive", pattern: usage("CocoaDialog", '\\btone=\\{[^}]*"destructive"') },
  { label: "CocoaSheet", pattern: /<CocoaSheet\b/ },
  { label: "CocoaPopover", pattern: /<CocoaPopover\b/ },
  { label: "CocoaToolbar variant=\"content\"", pattern: usage("CocoaToolbar", '\\bvariant="content"') },
  { label: "CocoaFormSection + CocoaFormRow", pattern: /<CocoaFormSection\b[\s\S]*<CocoaFormRow\b|<CocoaFormRow\b[\s\S]*<CocoaFormSection\b/ },
  { label: "CocoaInput multiline", pattern: usage("CocoaInput", "\\bmultiline\\b") },
  { label: "CocoaKbd announce", pattern: usage("CocoaKbd", "\\bannounce\\b") },
  // Cocoa 22 · integración olas 1-2-4-9 (handoffs de primitivas)
  { label: "CocoaButton wrap", pattern: usage("CocoaButton", "\\bwrap\\b") },
  { label: "CocoaInput suggestions={…}", pattern: usage("CocoaInput", "\\bsuggestions=\\{") },
  { label: "CocoaDatePicker withTime", pattern: usage("CocoaDatePicker", "\\bwithTime\\b") },
  { label: "CocoaTable rowTone={…}", pattern: usage("CocoaTable", "\\browTone=\\{") },
  { label: "CocoaDialog initialFocus={…}", pattern: usage("CocoaDialog", "\\binitialFocus=\\{") },
  { label: "CocoaDrawer focusKey={…}", pattern: usage("CocoaDrawer", "\\bfocusKey=\\{") },
  { label: "CocoaChart.Progress max={…}", pattern: usage("CocoaChart.Progress", "\\bmax=\\{") },
  { label: "CocoaSection variant=\"plain\" padding=\"none\"", pattern: usage("CocoaSection", 'variant="plain" padding="none"') },
  { label: ".cocoa-caption + .cocoa-link utilities", pattern: /className="cocoa-caption"[\s\S]*className="cocoa-link"/ },
  // Cocoa 22 · Tanda 6 · integración de finanzas (handoffs de primitivas)
  { label: "CocoaFileInput onReject={…}", pattern: usage("CocoaFileInput", "\\bonReject=\\{") },
  { label: "CocoaKpi caption=", pattern: usage("CocoaKpi", "\\bcaption=") },
  { label: "CocoaDialog confirmDisabled={…}", pattern: usage("CocoaDialog", "\\bconfirmDisabled=\\{") }
];

describe("style guide · coverage of the primitives (review#27)", () => {
  it("renders every required state / prop live (not only in a code sample)", () => {
    const missing = REQUIRED.filter((entry) => !entry.pattern.test(jsx)).map((entry) => entry.label);
    assert.deepEqual(missing, [], `Faltan en la guía (JSX real, no muestras):\n  ${missing.join("\n  ")}`);
  });

  it("drives its own CocoaPage through state, skeleton, empty, error and fullBleed", () => {
    const tag = pageOpeningTag();
    for (const prop of ["state={", "skeleton={", "empty={{", "error={{", "fullBleed={", "density={", "commands={"]) {
      assert.ok(tag.includes(prop), `<CocoaPage> de la guía sin ${prop}`);
    }
    assert.match(jsx, /setPageState\("empty"\)/, "the guide must switch itself to «empty»");
    assert.match(jsx, /setPageState\("error"\)/, "the guide must switch itself to «error»");
    assert.match(jsx, /setPageState\("loading"\)/, "the guide must switch itself to «loading»");
  });

  it("has one block per index entry (SECTIONS ids exist as section ids)", () => {
    const block = source.match(/const SECTIONS = \[([\s\S]*?)\] as const;/);
    assert.ok(block, "SECTIONS not found");
    const ids = Array.from(block[1].matchAll(/id: "([^"]+)"/g), (m) => m[1]);
    assert.ok(ids.length >= 19, `expected ≥ 19 index entries, found ${ids.length}`);
    const missing = ids.filter((id) => !jsx.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `Entradas del índice sin bloque:\n  ${missing.join("\n  ")}`);
  });
});

describe("style guide · hygiene (dev-only screen, outside the §9 allowlist)", () => {
  it("has no raw button / table / input / select / textarea / h1", () => {
    const raw = jsx.match(/<(button|table|input|select|textarea|h1)\b/g) ?? [];
    assert.deepEqual(raw, []);
  });

  it("has no colour literals (hex, rgb(), hsl(), color-mix with a literal)", () => {
    const hits = source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    assert.deepEqual(hits, []);
  });

  it(`keeps inline style props under the budget (≤ ${INLINE_STYLE_BUDGET})`, () => {
    const count = (source.match(/\bstyle=\{/g) ?? []).length;
    assert.ok(count <= INLINE_STYLE_BUDGET, `style={ ×${count} > ${INLINE_STYLE_BUDGET}: usa Note / Caption / Mono / DemoBox o las utilidades cocoa-stack / cocoa-row`);
  });

  it("uses the shared presentational helpers instead of repeating the text styles", () => {
    for (const helper of ["function Caption(", "function Note(", "function Mono(", "function DemoBox("]) {
      assert.ok(source.includes(helper), `${helper} missing`);
    }
    const repeated = jsx.match(/style=\{(?:secondaryTextStyle|captionStyle|monoStyle)\}/g) ?? [];
    assert.ok(repeated.length <= 3, `text styles applied inline outside their helper: ${repeated.length}`);
  });

  it("writes Spanish copy without emoji and keeps the code comments in English", () => {
    assert.doesNotMatch(jsx, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "emoji in JSX");
    assert.match(source, /^\/\/ StyleGuideScreen — Cocoa 22 style guide/m);
  });
});
