// Contrato de tamaño de objetivos (Tanda UX-1 · lote U10 ·
// docs/design/UX-RECEPCION-FEEL.md §7.1 2.5.8 «Target Size (Minimum)», §7.2
// «Tablet en el mostrador», §1.1 P5, D10, R7). Estático, sin navegador: fija
// las constantes y las reglas CSS de las que depende la medida en tablet
// (apps/admin-web/e2e/target-size.spec.ts, proyecto Playwright `touch`).
//
//   · ratón: CocoaButton `small` conserva 22 px de métrica pero su caja crece a
//     min-height 24 px (decisión de U5, SMALL_TARGET_MIN_PX) → las acciones de
//     fila de Mi día / ficha cumplen 2.5.8 sin recurrir a la excepción de
//     espaciado; una fila `compact` mide 28 px;
//   · dedo: TAP_TARGET_PX 44 = `--cocoa-touch-target: 44px` (tokens) en
//     CocoaButton / CocoaSelect / CocoaDatePicker / CocoaStepper y en la capa
//     táctil (mobile.css: tabs, menús, navegación, casillas; cocoa-22.css:
//     `.c22-table__check` 24 → 44); barra del cronograma 40 → 44 y asas 10 → 24;
//   · densidad por dispositivo: `CocoaPage density="operational"` resuelve
//     compact / comfortable con `useCoarsePointer` y las cuatro pantallas de
//     recepción lo declaran; `isTouchLaptop` (1024 px con el dedo) apila el
//     inspector (banda tablet de cocoa-22-layout.css);
//   · tablero: tiles minmax 150 → 160 px con el dedo y chips de leyenda como
//     CocoaButton (≥ 24 / 44) con un CocoaStatusBadge `dot` dentro;
//   · foco visible (2.4.7): anillo de 3 px en controles y casillas.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const exists = (path) => existsSync(new URL(path, import.meta.url));
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Cuerpo de un bloque `@media (<query>) { … }` (el primero cuya cabecera contiene `query`). */
function mediaBlock(css, query) {
  const source = stripComments(css);
  const start = source.indexOf(query);
  assert.ok(start >= 0, `falta @media …${query}…`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`bloque @media sin cerrar: ${query}`);
}

/** Todos los bloques `@media` cuya cabecera contiene `query`, concatenados. */
function mediaBlocks(css, query) {
  const source = stripComments(css);
  const out = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(query, from);
    if (at < 0) break;
    out.push(mediaBlock(source.slice(at), query));
    from = at + query.length;
  }
  assert.ok(out.length > 0, `falta @media …${query}…`);
  return out.join("\n");
}

const coarsePointer = read("../apps/admin-web/src/lib/useCoarsePointer.ts");
const tokens = read("../apps/admin-web/src/styles/cocoa-tokens.css");
const button = read("../apps/admin-web/src/components/cocoa/CocoaButton.tsx");
const engine = read("../apps/admin-web/src/screens/timeline/timeline-engine.ts");
const timelineCss = read("../apps/admin-web/src/styles/cocoa-22-timeline.css");
const cocoaCss = read("../apps/admin-web/src/styles/cocoa-22.css");
const mobileCss = read("../apps/admin-web/src/styles/mobile.css");
const layoutCss = read("../apps/admin-web/src/styles/cocoa-22-layout.css");
const page = read("../apps/admin-web/src/components/cocoa/CocoaPage.tsx");
const viewport = read("../apps/admin-web/src/components/cocoa/cocoa-viewport.ts");
const rack = read("../apps/admin-web/src/screens/operations/RoomRackScreen.tsx");
const inspector = read("../apps/admin-web/src/components/cocoa/CocoaInspector.tsx");
const playwrightConfig = read("../apps/admin-web/playwright.config.ts");

describe("target-size · constantes del objetivo táctil (44) y del mínimo con ratón (24)", () => {
  it("TAP_TARGET_PX es 44 y coincide con --cocoa-touch-target", () => {
    assert.match(coarsePointer, /export const TAP_TARGET_PX = 44;/);
    assert.match(coarsePointer, /"\(pointer: coarse\)"/);
    assert.match(tokens, /--cocoa-touch-target:\s*44px;/);
  });

  it("CocoaButton: small 22 / regular 28 / large 32 con ratón, caja mínima 24 px (U5) y 44 con el dedo", () => {
    assert.match(button, /const HEIGHT_BY_SIZE: Record<CocoaButtonSize, number> = \{ small: 22, regular: 28, large: 32 \};/);
    assert.match(button, /export const SMALL_TARGET_MIN_PX = 24;/);
    const fn = button.match(/export function buttonMinHeight\(size: CocoaButtonSize, coarse: boolean\): number \{([\s\S]*?)\n\}/);
    assert.ok(fn, "buttonMinHeight(size, coarse)");
    assert.match(fn[1], /if \(coarse\) return TAP_TARGET_PX;/);
    assert.match(fn[1], /return Math\.max\(HEIGHT_BY_SIZE\[size\], SMALL_TARGET_MIN_PX\);/);
    assert.match(button, /minHeight: buttonMinHeight\(size, coarse\)/);
    assert.match(button, /minWidth: coarse \? TAP_TARGET_PX : undefined/);
  });

  it("las cuatro primitivas con useCoarsePointer crecen a TAP_TARGET_PX", () => {
    for (const file of ["CocoaButton", "CocoaSelect", "CocoaDatePicker", "CocoaStepper"]) {
      const source = read(`../apps/admin-web/src/components/cocoa/${file}.tsx`);
      assert.match(source, /useCoarsePointer/, `${file} usa useCoarsePointer`);
      assert.match(source, /TAP_TARGET_PX/, `${file} usa TAP_TARGET_PX`);
    }
  });

  it("densidad compact = fila 28 px (≥ 24), comfortable = 36 px; los controles compact miden 22 (solo dentro de CocoaButton, que los sube a 24)", () => {
    assert.match(tokens, /\[data-cocoa-density="compact"\] \{[\s\S]*?--cocoa-density-row-height:\s*28px;[\s\S]*?--cocoa-density-control-height:\s*22px;/);
    assert.match(tokens, /\[data-cocoa-density="comfortable"\] \{[\s\S]*?--cocoa-density-row-height:\s*36px;/);
  });
});

describe("target-size · cronograma con el dedo (§5.11, §7.2)", () => {
  it("timeline-engine: barra 40 → 44 y asas 10 → 24 con puntero grueso", () => {
    assert.match(engine, /export const BAR_HEIGHT = 40;/);
    assert.match(engine, /export const BAR_HEIGHT_COARSE = 44;/);
    assert.match(engine, /export const HANDLE_WIDTH = 10;/);
    assert.match(engine, /export const HANDLE_WIDTH_COARSE = 24;/);
    assert.match(engine, /export function barHeightFor\(coarse: boolean\): number \{\s*return coarse \? BAR_HEIGHT_COARSE : BAR_HEIGHT;/);
  });
  it("cocoa-22-timeline.css: bajo pointer: coarse la parrilla pone --tl-bar-h 44px, las asas 24 px y pan-y", () => {
    const block = mediaBlocks(timelineCss, "(pointer: coarse)");
    assert.match(block, /\.tl-grid \{\s*--tl-bar-h: 44px;/);
    assert.match(block, /\.tl-bar__handle \{\s*width: 24px;\s*touch-action: pan-y;/);
    assert.match(block, /\.tl-bar \{\s*touch-action: pan-y;/);
  });
});

describe("target-size · capa táctil (mobile.css / cocoa-22.css bajo pointer: coarse)", () => {
  const mobile = mediaBlocks(mobileCss, "(pointer: coarse)");
  const cocoa = mediaBlocks(cocoaCss, "(pointer: coarse)");

  it("mobile.css eleva a --cocoa-touch-target la navegación, pestañas, menús, KPI interactivos y filas interactivas", () => {
    const rule = mobile.match(/([^{}]*\.c22-nav-item[^{}]*)\{([^}]*)\}/);
    assert.ok(rule, "regla de 44 px con .c22-nav-item");
    for (const selector of ['.cocoa-content [role="tab"]', '.cocoa-content [role="menuitem"]', '.c22-kpi[role="button"]', '.c22-table tbody tr[data-interactive="true"] > td']) {
      assert.ok(rule[1].includes(selector), `${selector} en la regla de 44 px`);
    }
    assert.match(rule[2], /min-height: var\(--cocoa-touch-target\);/);
    assert.match(mobile, /:root \.c22-sidebar :is\(\.c22-nav-item, \.c22-nav-group-head, \.c22-brand-home, \.c22-sidebar-close\) \{\s*min-height: var\(--cocoa-touch-target\);/);
  });
  it("mobile.css: inputs de 16 px (sin zoom en iOS) y controles de formulario a 44 px", () => {
    assert.match(mobile, /font-size: 16px !important;/);
    assert.match(mobile, /\.c22-field :is\(input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), select\),[\s\S]*?min-height: var\(--cocoa-touch-target\);/);
  });
  it("mobile.css (U10): la casilla de fila y su input crecen con el dedo (etiqueta 44 px, caja ≥ 24 px)", () => {
    assert.match(mobile, /\.c22-table__check-input \{\s*width: 24px;\s*height: 24px;/);
    assert.match(mobile, /\.c22-table__check \{\s*min-width: var\(--cocoa-touch-target\);\s*min-height: var\(--cocoa-touch-target\);/);
  });
  it("cocoa-22.css: la casilla de selección de CocoaTable mide ≥ 24 px con ratón y 44 px con el dedo (2.5.8)", () => {
    assert.match(stripComments(cocoaCss), /\.c22-table__check \{[^}]*min-width: 24px;\s*min-height: 24px;/);
    assert.match(cocoa, /\.c22-table__check \{ min-width: var\(--cocoa-touch-target\); min-height: var\(--cocoa-touch-target\); \}/);
  });
  it("foco visible (2.4.7): anillo de 3 px en controles, casillas y campos", () => {
    const source = stripComments(cocoaCss);
    assert.match(source, /:where\(\[data-cocoa\]\) :is\(a, button, summary, \[role="button"\], \[role="tab"\], \[role="tabpanel"\], \[tabindex\]\):focus-visible[\s\S]*?box-shadow: 0 0 0 3px var\(--cocoa-focus-ring\)/);
    assert.match(source, /\.c22-table__check-input:focus-visible \{ outline: none; box-shadow: 0 0 0 3px var\(--cocoa-focus-ring\);/);
    assert.match(source, /:where\(\[data-cocoa\]\) :is\(input, select, textarea\):focus-visible \{[\s\S]*?box-shadow: 0 0 0 3px var\(--cocoa-focus-ring\);/);
  });
});

describe("target-size · densidad por dispositivo (D10) y portátil táctil (§7.2)", () => {
  it("CocoaPage resuelve density=\"operational\" con useCoarsePointer y emite data-cocoa-density / data-density-mode / data-touch-laptop", () => {
    assert.match(page, /export type CocoaPageDensityMode = CocoaPageDensity \| "operational";/);
    assert.match(page, /if \(density === "operational"\) return coarse \? "comfortable" : "compact";/);
    assert.match(page, /const coarse = useCoarsePointer\(\);/);
    assert.match(page, /const touchLaptop = useIsTouchLaptop\(\);/);
    assert.match(page, /data-cocoa-density=\{resolvedDensity\}/);
    assert.match(page, /data-density-mode=\{density === "operational" \? "operational" : undefined\}/);
    assert.match(page, /data-touch-laptop=\{touchLaptop \? "true" : undefined\}/);
  });
  it("las cuatro CocoaPage de recepción declaran density=\"operational\" (Mi día, lista de reservas, huéspedes, ficha)", () => {
    for (const file of ["operations/FrontDeskDashboard", "reservations/ReservationsListScreen", "guests/GuestsListScreen", "reservations/ReservationWorkspaceScreen"]) {
      const source = read(`../apps/admin-web/src/screens/${file}.tsx`);
      const open = source.match(/<CocoaPage\n([\s\S]*?)>\n/);
      assert.ok(open, `${file}: <CocoaPage`);
      assert.match(open[1], /^\s*density="operational"$/m, `${file}: density="operational"`);
    }
  });
  it("isTouchLaptop = tier laptop && puntero grueso; la banda tablet de cocoa-22-layout.css apila el inspector (900–1199 con el dedo)", () => {
    assert.match(viewport, /export function isTouchLaptop\(tier: CocoaViewportTier, coarse: boolean\): boolean \{\s*return tier === "laptop" && coarse;/);
    assert.match(viewport, /export function useIsTouchLaptop\(\): boolean/);
    const band = mediaBlock(layoutCss, "(pointer: coarse) and (min-width: 900px) and (max-width: 1199px)");
    assert.match(band, /\.c22-inspector-layout\[data-cocoa="inspector-layout"\] \{\s*flex-direction: column;\s*align-items: stretch;/);
    assert.match(band, /\.c22-inspector\[data-cocoa="inspector"\] \{\s*width: auto;\s*position: static;\s*max-height: none;/);
    // < 900 (tablet vertical) ya apilaba en cocoa-22.css.
    assert.match(mediaBlocks(cocoaCss, "(max-width: 899px)"), /\.c22-inspector-layout \{ flex-direction: column; align-items: stretch; \}/);
    assert.match(inspector, /export const INSPECTOR_STACK_BREAKPOINT = 900;/);
  });
});

describe("target-size · tablero de habitaciones (§7.2 «Tablero»)", () => {
  it("los tiles van en .c22-tile-grid: minmax 150 px con ratón, 160 px con el dedo; sin rejilla inline", () => {
    assert.match(rack, /<div className="c22-tile-grid">/);
    assert.doesNotMatch(rack, /minmax\(150px/);
    const source = stripComments(layoutCss);
    assert.match(source, /\.c22-tile-grid \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fill, minmax\(150px, 1fr\)\);/);
    assert.match(mediaBlocks(layoutCss, "(pointer: coarse)"), /\.c22-tile-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(160px, 1fr\)\); \}/);
  });
  it("los chips de leyenda son CocoaButton (≥ 24 / 44 px) con un CocoaStatusBadge dot del diccionario, sin cuadrado de 10 px a mano", () => {
    const chips = rack.match(/aria-label="Filtrar por estado"[\s\S]*?<\/div>/);
    assert.ok(chips, "grupo «Filtrar por estado»");
    assert.match(chips[0], /<CocoaButton[\s\S]*?aria-pressed=\{active\}[\s\S]*?<CocoaStatusBadge entry=\{meta\} variant="dot" \/>[\s\S]*?<\/CocoaButton>/);
    assert.doesNotMatch(chips[0], /width: 10, height: 10/);
    assert.doesNotMatch(chips[0], /icon=\{<span/);
  });
});

describe("target-size · proyecto Playwright `touch` y spec de medida en tablet", () => {
  it("playwright.config.ts declara el proyecto touch (hasTouch, 1024 × 768 por defecto) y chromium lo excluye", () => {
    assert.match(playwrightConfig, /name: "touch",\s*testMatch: \/target-size\\\.spec\\\.ts\$\/,\s*use: \{ browserName: "chromium", viewport: \{ width: 1024, height: 768 \}, hasTouch: true/);
    assert.match(playwrightConfig, /name: "chromium",\s*testIgnore: \/measure\/,\s*(\/\/[^\n]*\n\s*)?testMatch: \/\^\(\?!\.\*target-size\)/);
  });
  it("e2e/target-size.spec.ts recorre las cinco pantallas a 1024 × 768 y 820 × 1180, claro y oscuro, sin skip, y afirma 0 < 24 px y contraste 4,5 / 3", () => {
    assert.ok(exists("../apps/admin-web/e2e/target-size.spec.ts"));
    const spec = read("../apps/admin-web/e2e/target-size.spec.ts");
    assert.doesNotMatch(spec, /test\.skip\(|testInfo\.skip\(|test\.fixme\(/);
    assert.match(spec, /apaisado: \{ width: 1024, height: 768 \}/);
    assert.match(spec, /vertical: \{ width: 820, height: 1180 \}/);
    assert.match(spec, /const SCHEMES = \["light", "dark"\] as const;/);
    assert.match(spec, /test\.use\(\{ viewport, colorScheme: scheme \}\);/);
    for (const path of ["/hoy", "/recepcion/reservas/lista", "/recepcion/reservas/res_uxday_t4", "/recepcion/reservas/tablero", "/hoy/live-timeline"]) {
      assert.ok(spec.includes(`path: "${path}"`), `ruta ${path}`);
    }
    assert.match(spec, /samples\.filter\(\(s\) => s\.min < 24\)/);
    assert.match(spec, /expect\(offenders, `objetivos < 24 × 24 px \(2\.5\.8\)[\s\S]*?\)\.toEqual\(\[\]\);/);
    assert.match(spec, /b\.textRatio < 4\.5/);
    assert.match(spec, /b\.borderRatio < 3\) \|\| \(b\.dotRatio !== null && b\.dotRatio < 3\)/);
    assert.match(spec, /matchMedia\("\(pointer: coarse\)"\)\.matches/);
    assert.match(spec, /"No-show"/);
    // Sin nombres: el texto de los controles de fila no se guarda.
    assert.match(spec, /return "\(fila\/tarjeta\)";/);
  });
});
