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
import { CocoaPage, resolvePageDensity } from "../CocoaPage.tsx";
import { CocoaScrollArea } from "../CocoaScrollArea.tsx";
import { CocoaPageSkeleton, SKELETON_DELAY_MS, fadeInClass, shouldShowSkeleton } from "../CocoaState.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const layoutCss = readFileSync(resolve(here, "../../../styles/cocoa-22-layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const motionCss = readFileSync(resolve(here, "../../../styles/cocoa-motion.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const appSource = readFileSync(resolve(here, "../../../App.tsx"), "utf8");
const drawerSource = readFileSync(resolve(here, "../CocoaDrawer.tsx"), "utf8");

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

// fix:primitives qa#10 — probe §5.4 on /cumplimiento/envios (and eight more
// screens with inner views) returned `aria-controls=null` on the active tab
// and no [role=tabpanel] in main: the plumbing existed end to end
// (CocoaPage → head → CocoaSegmentedControl) but every screen had to mint a
// panelId and paint the panel itself. Now the page body IS the panel unless
// the screen passes its own `panelId`.
describe("CocoaPage · the body is the tabpanel of the inner views (qa#10)", () => {
  const tabs = [
    { value: "hoy", label: "Hoy" },
    { value: "semana", label: "Semana" }
  ];
  const activeTab = (html: string) => html.match(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>/)?.[0] ?? "";

  it("with tabs and no panelId the active tab controls the body, labelled with the active view", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", tabs, activeTab: "semana", children: "cuerpo" } as never));
    const controls = activeTab(html).match(/aria-controls="([^"]+)"/);
    assert.ok(controls, `active tab without aria-controls in ${html}`);
    const panelId = controls[1];
    assert.ok(!/\s/.test(panelId), `panel id must be a single IDREF token: ${panelId}`);
    assert.ok(html.includes(`<div class="c22-page__body cocoa-page-body" id="${panelId}" role="tabpanel" aria-label="Semana">cuerpo</div>`), html);
    // Only the active tab points at the panel (WAI-ARIA tabs pattern).
    assert.equal((html.match(/aria-controls=/g) ?? []).length, 1);
  });

  it("falls back to the first view as the panel label when activeTab is not given", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", tabs, children: "cuerpo" } as never));
    assert.match(html, /role="tabpanel" aria-label="Hoy"/);
  });

  it("an explicit panelId is forwarded to the tab strip and the body stays a plain div (the screen paints its panel)", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", tabs, activeTab: "hoy", panelId: "mi-dia-panel", children: "cuerpo" } as never));
    assert.match(activeTab(html), /aria-controls="mi-dia-panel"/);
    assert.ok(html.includes('<div class="c22-page__body cocoa-page-body">cuerpo</div>'), html);
    assert.doesNotMatch(html, /role="tabpanel"/);
  });

  it("without inner views the body carries neither role nor id", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", children: "cuerpo" } as never));
    assert.ok(html.includes('<div class="c22-page__body cocoa-page-body">cuerpo</div>'), html);
    assert.doesNotMatch(html, /tabpanel|aria-controls/);
  });
});

// Tanda UX-1 · U4 · esqueleto con retardo + fundido (§4 «Esqueleto con
// retardo», §6.1, F28): nada antes de 300 ms, esqueleto después, y
// `.cocoa-fade-in` en el cuerpo al resolver.
describe("CocoaPage · skeletonDelayMs (retardo del esqueleto)", () => {
  it("shouldShowSkeleton (puro): nunca antes del retardo; 0 = al instante; sin carga, nunca", () => {
    assert.equal(SKELETON_DELAY_MS, 300);
    assert.equal(shouldShowSkeleton({ loading: true, delayMs: 300, elapsedMs: 0 }), false);
    assert.equal(shouldShowSkeleton({ loading: true, delayMs: 300, elapsedMs: 299 }), false);
    assert.equal(shouldShowSkeleton({ loading: true, delayMs: 300, elapsedMs: 300 }), true);
    assert.equal(shouldShowSkeleton({ loading: true, delayMs: 0, elapsedMs: 0 }), true);
    assert.equal(shouldShowSkeleton({ loading: false, delayMs: 0, elapsedMs: 900 }), false);
    assert.equal(fadeInClass(true), "cocoa-fade-in");
    assert.equal(fadeInClass(false), undefined);
  });
  it("con el retardo por defecto el cuerpo en carga está vacío y ocupado (aria-busy, data-skeleton=pending), sin esqueleto", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", state: "loading", skeleton: createElement("div", { className: "mirror" }), children: "cuerpo" } as never));
    assert.match(html, /<div class="c22-page__body cocoa-page-body" aria-busy="true" data-skeleton="pending"><\/div>/);
    assert.doesNotMatch(html, /mirror|cocoa-skeleton|cuerpo/);
  });
  it("skeletonDelayMs=0 pinta el esqueleto espejo al instante (o CocoaState loading si no hay espejo)", () => {
    const mirror = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", state: "loading", skeletonDelayMs: 0, skeleton: createElement("div", { className: "mirror" }), children: "cuerpo" } as never));
    assert.match(mirror, /<div class="c22-page__body cocoa-page-body" aria-busy="true" data-skeleton="visible"><div class="mirror"><\/div><\/div>/);
    const generic = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", state: "loading", skeletonDelayMs: 0, children: "cuerpo" } as never));
    assert.match(generic, /data-skeleton="visible"/);
    assert.match(generic, /data-cocoa="skeleton"/);
  });
  it("listo: sin data-skeleton y la clase del cuerpo intacta (el fundido solo se añade al resolver una carga)", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Mi día", children: "cuerpo" } as never));
    assert.ok(html.includes('<div class="c22-page__body cocoa-page-body">cuerpo</div>'), html);
    assert.match(motionCss, /\.cocoa-fade-in \{\s*animation: cocoa-fade-in/);
  });
  it("CocoaDrawer acepta loading / skeleton / skeletonDelayMs y funde el cuerpo; el Suspense de App pinta el esqueleto genérico de página", () => {
    assert.match(drawerSource, /skeletonDelayMs = SKELETON_DELAY_MS/);
    assert.match(drawerSource, /\{loading \? \(showSkeleton \? \(skeleton \?\? <CocoaState kind="loading" \/>\) : null\) : children\}/);
    assert.match(drawerSource, /fadeInClass\(fade\)/);
    assert.match(appSource, /<Suspense fallback=\{<CocoaPageSkeleton \/>\}>\{body\}<\/Suspense>/);
    assert.doesNotMatch(appSource, /fallback=\{<CocoaState kind="loading" title="Cargando pantalla…"/);
  });
  it("CocoaPageSkeleton: pendiente por defecto (solo el texto para AT), título + filas con delayMs=0", () => {
    const pending = renderToStaticMarkup(createElement(CocoaPageSkeleton, {}));
    assert.match(pending, /^<div role="status" aria-busy="true" class="c22-page-skeleton" data-cocoa="page-skeleton" data-pending="true"><span class="cocoa-sr-only">Cargando pantalla…<\/span><\/div>$/);
    const shown = renderToStaticMarkup(createElement(CocoaPageSkeleton, { delayMs: 0, rows: 3 }));
    assert.doesNotMatch(shown, /data-pending/);
    assert.match(shown, /data-variant="title"/);
    assert.equal((shown.match(/data-variant="row"/g) ?? []).length, 3);
    assert.doesNotMatch(readFileSync(resolve(here, "../CocoaState.tsx"), "utf8").split("// ----------------------------------------------------------------- skeleton delay + fade (U4)")[1] ?? "", /style=\{/);
  });
});

// Tanda UX-1 · U10 · densidad operativa por dispositivo (§1.1 P5, §7.2, D10,
// R7): la pantalla declara `density="operational"` y la página resuelve
// `compact` (28 px) con ratón y `comfortable` + 44 px con puntero grueso.
describe("CocoaPage · density=\"operational\" (densidad por dispositivo, U10)", () => {
  it("resolvePageDensity (puro): operational → compact con ratón, comfortable con el dedo; fija se respeta; sin declarar, nada", () => {
    assert.equal(resolvePageDensity("operational", false), "compact");
    assert.equal(resolvePageDensity("operational", true), "comfortable");
    assert.equal(resolvePageDensity("compact", true), "compact", "una densidad fija no cambia con el dispositivo");
    assert.equal(resolvePageDensity("comfortable", false), "comfortable");
    assert.equal(resolvePageDensity(undefined, true), undefined);
  });
  it("SSR (sin matchMedia = puntero fino): data-cocoa-density=compact y data-density-mode=operational en la raíz", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Reservas", density: "operational", children: "cuerpo" } as never));
    assert.match(html, /<div[^>]*data-cocoa="page"[^>]*data-cocoa-density="compact"[^>]*data-density-mode="operational"/);
    assert.doesNotMatch(html, /data-touch-laptop/, "sin matchMedia el tier es desktop y el puntero fino: no es portátil táctil");
  });
  it("una densidad fija sigue emitiendo solo data-cocoa-density (sin modo)", () => {
    const html = renderToStaticMarkup(createElement(CocoaPage, { title: "Reservas", density: "comfortable", children: "cuerpo" } as never));
    assert.match(html, /data-cocoa-density="comfortable"/);
    assert.doesNotMatch(html, /data-density-mode/);
    const none = renderToStaticMarkup(createElement(CocoaPage, { title: "Reservas", children: "cuerpo" } as never));
    assert.doesNotMatch(none, /data-cocoa-density|data-density-mode/);
  });
  it("las cuatro pantallas de recepción (Mi día, lista, huéspedes, ficha) declaran density=\"operational\" en su CocoaPage", () => {
    const screens = [
      "../../../screens/operations/FrontDeskDashboard.tsx",
      "../../../screens/reservations/ReservationsListScreen.tsx",
      "../../../screens/guests/GuestsListScreen.tsx",
      "../../../screens/reservations/ReservationWorkspaceScreen.tsx"
    ];
    for (const file of screens) {
      const source = readFileSync(resolve(here, file), "utf8");
      const page = source.match(/<CocoaPage\n([\s\S]*?)>\n/);
      assert.ok(page, `${file}: <CocoaPage no encontrado`);
      assert.match(page[1], /^\s*density="operational"$/m, `${file}: la CocoaPage de recepción declara density="operational"`);
    }
  });
  it("cocoa-tokens.css sigue resolviendo compact = fila 28 px y comfortable = 36 px, y el objetivo táctil es 44 px", () => {
    const tokens = readFileSync(resolve(here, "../../../styles/cocoa-tokens.css"), "utf8");
    assert.match(tokens, /\[data-cocoa-density="compact"\] \{[\s\S]*?--cocoa-density-row-height:\s*28px;/);
    assert.match(tokens, /\[data-cocoa-density="comfortable"\] \{[\s\S]*?--cocoa-density-row-height:\s*36px;/);
    assert.match(tokens, /--cocoa-touch-target:\s*44px;/);
  });
});
