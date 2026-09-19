import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda TL · lote TL-2: presentación pura del Live Timeline. Importa SOLO el
// módulo puro (el barrel ../cocoa arrastra CocoaRouteTabs/CocoaSidebar y el
// JSON del árbol de navegación, que no cargan bajo node --import tsx) y pina
// los .tsx y la hoja sobre el fuente, como
// screens/payroll/__tests__/payroll-cost-screen-contract.test.mts.

import {
  LEGEND_ITEMS,
  LEGEND_VARIANT,
  availabilityLevel,
  barVars,
  ghostVars,
  gridVars,
  initials,
  rowVars,
  selectionVars,
  spacerVars
} from "../timeline-presentation.ts";
import {
  BAR_KINDS,
  BAR_KIND_LABEL,
  BAR_KIND_TONE,
  LEAD_WIDTH_NARROW,
  MIN_BAR_WIDTH,
  rangeFor,
  type BarGeometry,
  type BarKind
} from "../../../screens/timeline/timeline-engine.ts";

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
/** Hoja sin comentarios, para casar reglas por selector sin que el texto de los comentarios interfiera. */
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const TSX = [
  "TimelineHeader",
  "TimelineDateSelector",
  "TimelineFilterBar",
  "TimelineLegend",
  "TimelineAvailabilityRow",
  "TimelineBar",
  "TimelineQuickCard",
  "TimelineGapAlert",
  "TimelineUndoBar"
] as const;

const tsxSources = Object.fromEntries(TSX.map((name) => [name, source(`../${name}.tsx`)])) as Record<(typeof TSX)[number], string>;
const pure = source("../timeline-presentation.ts");
const sheet = source("../../../styles/cocoa-22-timeline.css");

// Regex de colores de tests/cocoa-22-contract.test.mjs (hex y rgb/hsl).
const COLOUR_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/;

/** Reglas 1-5, 9-11 de tests/cocoa-22-contract.test.mjs sobre un fichero. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, COLOUR_LITERAL, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /\bIntl\./, `${name}: no Intl (lib/format formats)`);
  assert.doesNotMatch(src, /toLocale/, `${name}: no toLocale* (lib/format formats)`);
}

const geometry: BarGeometry = { left: 152, width: 196, top: 6, height: 40 };

describe("timeline-presentation · variables CSS de bloques", () => {
  it("barVars traduce la geometría a --tl-left/--tl-width/--tl-top en px", () => {
    assert.deepEqual(barVars(geometry), { "--tl-left": "152px", "--tl-width": "196px", "--tl-top": "6px" });
  });

  it("ghostVars · move desplaza con --tl-dx y conserva left/width de la base", () => {
    const vars = ghostVars(geometry, "move", 2, 100);
    assert.equal(vars["--tl-dx"], "200px");
    assert.equal(vars["--tl-dy"], "0px");
    assert.equal(vars["--tl-left"], "152px");
    assert.equal(vars["--tl-width"], "196px");
    assert.equal(ghostVars(geometry, "move", -3, 64)["--tl-dx"], "-192px");
  });

  it("ghostVars · resize-end cambia la anchura, resize-start el borde izquierdo y la anchura", () => {
    const end = ghostVars(geometry, "resize-end", -1, 100);
    assert.equal(end["--tl-width"], "96px");
    assert.equal(end["--tl-left"], "152px");
    assert.equal(end["--tl-dx"], "0px");
    const start = ghostVars(geometry, "resize-start", 1, 100);
    assert.equal(start["--tl-left"], "252px");
    assert.equal(start["--tl-width"], "96px");
    assert.equal(start["--tl-dx"], "0px");
  });

  it("ghostVars nunca baja de MIN_BAR_WIDTH", () => {
    assert.equal(ghostVars(geometry, "resize-end", -5, 100)["--tl-width"], `${MIN_BAR_WIDTH}px`);
    assert.equal(ghostVars(geometry, "resize-start", 5, 100)["--tl-width"], `${MIN_BAR_WIDTH}px`);
  });

  it("rowVars, spacerVars y selectionVars", () => {
    assert.deepEqual(rowVars(72), { "--tl-row-h": "72px" });
    assert.deepEqual(spacerVars(1240), { "--tl-h": "1240px" });
    assert.deepEqual(spacerVars(-4), { "--tl-h": "0px" });
    assert.deepEqual(selectionVars({ roomId: "r1", startIndex: 3, endIndex: 1 }, 100), { "--tl-left": "102px", "--tl-width": "296px" });
    assert.deepEqual(selectionVars({ roomId: "r1", startIndex: 0, endIndex: 0 }, 118), { "--tl-left": "2px", "--tl-width": "114px" });
  });

  it("gridVars · columna, días, hoy (−1 fuera del rango) y medidas fijas", () => {
    const range = rangeFor(new Date(Date.UTC(2026, 8, 14)), "week");
    const vars = gridVars(range, 3);
    assert.equal(vars["--tl-col"], "118px");
    assert.equal(vars["--tl-days"], "14");
    assert.equal(vars["--tl-today"], "3");
    assert.equal(vars["--tl-lead"], "200px");
    assert.equal(vars["--tl-head-h"], "48px");
    assert.equal(vars["--tl-bar-h"], "40px");
    assert.equal(vars["--tl-lane-gap"], "6px");
    // U9b: con puntero grueso la barra mide 44 px (rangeFor coarse → range.barHeight → --tl-bar-h).
    assert.equal(gridVars(rangeFor(new Date(Date.UTC(2026, 8, 14)), "week", { coarse: true }), 3)["--tl-bar-h"], "44px");
    assert.equal(gridVars(rangeFor(new Date(Date.UTC(2026, 8, 14)), "week", { coarse: false }), 3)["--tl-bar-h"], "40px");
    assert.equal(gridVars(range, -1)["--tl-today"], "-1");
    assert.equal(gridVars(range, 14)["--tl-today"], "-1");
    assert.equal(gridVars(rangeFor(new Date(Date.UTC(2026, 8, 14)), "month"), 0)["--tl-days"], "30");
    assert.equal(gridVars(rangeFor(new Date(Date.UTC(2026, 8, 14)), "day"), 0)["--tl-col"], "150px");
    // Teléfono: columna de recursos estrecha y celdas cortas (rangeFor narrow), mismos días.
    assert.equal(gridVars(range, 3, LEAD_WIDTH_NARROW)["--tl-lead"], "104px");
    const narrow = rangeFor(new Date(Date.UTC(2026, 8, 14)), "week", { narrow: true });
    assert.equal(gridVars(narrow, 3, LEAD_WIDTH_NARROW)["--tl-col"], "88px");
    assert.equal(gridVars(narrow, 3, LEAD_WIDTH_NARROW)["--tl-days"], "14");
  });

  it("todas las variables llevan el prefijo --tl-", () => {
    const all = { ...barVars(geometry), ...ghostVars(geometry, "move", 1, 10), ...rowVars(1), ...spacerVars(1), ...gridVars(rangeFor(new Date(Date.UTC(2026, 0, 1)), "day"), 0) };
    for (const key of Object.keys(all)) assert.match(key, /^--tl-/);
  });
});

describe("timeline-presentation · disponibilidad, iniciales y leyenda", () => {
  it("availabilityLevel · none ≤ 0, low ≤ 20 % (mínimo 1), ok el resto", () => {
    assert.equal(availabilityLevel(0, 10), "none");
    assert.equal(availabilityLevel(-2, 10), "none");
    assert.equal(availabilityLevel(2, 10), "low");
    assert.equal(availabilityLevel(1, 3), "low");
    assert.equal(availabilityLevel(5, 10), "ok");
    assert.equal(availabilityLevel(2, 3), "ok");
  });

  it("initials · 1-2 iniciales en mayúsculas, «?» si vacío", () => {
    assert.equal(initials("Ana García"), "AG");
    assert.equal(initials("  marta  "), "M");
    assert.equal(initials("Sin huésped"), "SH");
    assert.equal(initials(""), "?");
    assert.equal(initials("   "), "?");
  });

  it("LEGEND_ITEMS cubre los 8 BarKind (en orden) con los tonos de BAR_KIND_TONE y la variante por estado + la bloqueada", () => {
    assert.equal(LEGEND_ITEMS.length, BAR_KINDS.length + 1);
    BAR_KINDS.forEach((kind: BarKind, index) => {
      const item = LEGEND_ITEMS[index];
      assert.equal(item.kind, kind);
      assert.equal(item.label, BAR_KIND_LABEL[kind]);
      assert.equal(item.tone, BAR_KIND_TONE[kind]);
      assert.equal(item.variant, LEGEND_VARIANT[kind]);
    });
    // Borrador, salida y no-show ya no son tres badges neutros iguales: contorno, punto y ámbar con contorno.
    assert.deepEqual(LEGEND_VARIANT, {
      arrival_today: "tinted",
      in_house: "tinted",
      departure_today: "tinted",
      confirmed: "tinted",
      draft: "outline",
      checked_out: "dot",
      no_show: "outline",
      cancelled: "outline"
    });
    const signature = (kind: BarKind) => `${BAR_KIND_TONE[kind]}/${LEGEND_VARIANT[kind]}`;
    assert.equal(new Set(BAR_KINDS.map(signature)).size, BAR_KINDS.length, "cada estado tiene una pareja tono/variante distinta en la leyenda");
    const blocked = LEGEND_ITEMS[LEGEND_ITEMS.length - 1];
    assert.deepEqual(blocked, { kind: "blocked", label: "Bloqueada · mantenimiento", tone: "neutral", variant: "outline" });
  });
});

describe("components/timeline · contrato Cocoa 22 sobre el fuente", () => {
  it("los 9 .tsx y el módulo puro cumplen las reglas (sin .bo-*, crudos, colores, emoji, fetch, Intl)", () => {
    for (const name of TSX) assertCocoaRules(`${name}.tsx`, tsxSources[name]);
    assertCocoaRules("timeline-presentation.ts", pure);
  });

  it("presupuesto de style={: exactamente 1 en TimelineBar (barVars) y 0 en el resto; nunca style={{", () => {
    let total = 0;
    for (const name of TSX) {
      const n = count(tsxSources[name], /\bstyle=\{/g);
      total += n;
      assert.equal(count(tsxSources[name], /\bstyle=\{\{/g), 0, `${name}.tsx: style={{ prohibido`);
      if (name === "TimelineBar") assert.equal(n, 1, "TimelineBar.tsx: 1 style={");
      else assert.equal(n, 0, `${name}.tsx: 0 style={ (tiene ${n})`);
    }
    assert.equal(total, 1);
    assert.match(tsxSources.TimelineBar, /style=\{barVars\(geometry\) as CSSProperties\}/);
  });

  it("cada .tsx importa del barrel ../cocoa y/o del motor; el módulo puro no toca React ni ../cocoa", () => {
    for (const name of TSX) {
      const src = tsxSources[name];
      const usesCocoa = /from "\.\.\/cocoa"/.test(src);
      const usesEngine = /from "\.\.\/\.\.\/screens\/timeline\/timeline-engine"/.test(src);
      assert.ok(usesCocoa || usesEngine, `${name}.tsx: importa de ../cocoa y/o del motor`);
      assert.doesNotMatch(src, /from "\.\.\/cocoa\//, `${name}.tsx: primitivas solo desde el barrel`);
      assert.doesNotMatch(src, /packages\/ui|@hotelos\/ui/, `${name}.tsx: packages/ui está retirado`);
    }
    assert.doesNotMatch(pure, /from "react"/);
    assert.doesNotMatch(pure, /\.\.\/cocoa/);
    assert.doesNotMatch(pure, /\bdocument\b|\bwindow\b/);
    assert.match(pure, /from "\.\.\/\.\.\/screens\/timeline\/timeline-engine"/);
  });

  it("props y ganchos que consumen TL-3/TL-5", () => {
    assert.match(tsxSources.TimelineHeader, /data-sticky-head="true"/);
    assert.match(tsxSources.TimelineHeader, /data-sticky-column="true"/);
    assert.match(tsxSources.TimelineHeader, /aria-current=\{col\.isToday \? "date" : undefined\}/);
    assert.match(tsxSources.TimelineDateSelector, /aria-label="Periodo y escala del Live Timeline"/);
    assert.match(tsxSources.TimelineDateSelector, /CocoaSegmentedControl/);
    assert.match(tsxSources.TimelineDateSelector, /CocoaDatePicker value=\{anchorIso\}/);
    // Copy (corrección 1): aria-labels en orden natural, sin ids técnicos en tooltips.
    assert.match(tsxSources.TimelineDateSelector, /PREVIOUS_PERIOD_LABEL = "Periodo anterior"/);
    assert.match(tsxSources.TimelineDateSelector, /NEXT_PERIOD_LABEL = "Periodo siguiente"/);
    assert.doesNotMatch(tsxSources.TimelineDateSelector, /\$\{ACTIONS\.(previous|next)\} periodo/);
    assert.match(tsxSources.TimelineFilterBar, /aria-label="Filtros del Live Timeline"/);
    assert.match(tsxSources.TimelineFilterBar, /debounceMs=\{250\}/);
    assert.match(tsxSources.TimelineFilterBar, /ACTIONS\.clearFilters/);
    assert.doesNotMatch(tsxSources.TimelineFilterBar, /title=\{/, "los chips no exponen el id técnico como tooltip");
    assert.doesNotMatch(tsxSources.TimelineQuickCard, /title=\{res\.channel\}/, "la tarjeta rápida no expone el id del canal");
    assert.match(tsxSources.TimelineLegend, /LEGEND_ITEMS/);
    assert.match(tsxSources.TimelineAvailabilityRow, /availabilityLevel\(n, sellable\)/);
    assert.match(tsxSources.TimelineAvailabilityRow, /A11Y_LABELS\.expand/);
    assert.match(tsxSources.TimelineAvailabilityRow, /aria-rowindex=\{rowIndex\}/);
    assert.doesNotMatch(tsxSources.TimelineAvailabilityRow, /aria-controls=/, "el botón Desplegar/Plegar no apunta a su propia fila");
    assert.match(tsxSources.TimelineAvailabilityRow, /toggleGroupLabel\(collapsible\.collapsed, label\)/, "el aria-label nombra el tipo");
    assert.match(tsxSources.TimelineHeader, /aria-rowindex=\{1\}/);
    assert.match(tsxSources.TimelineBar, /export const TimelineBar = memo\(/);
    assert.match(tsxSources.TimelineBar, /role="button"/);
    assert.match(tsxSources.TimelineBar, /className="tl-bar cocoa-focus-ring"/);
    assert.match(tsxSources.TimelineBar, /data-reservation-id=\{bar\.id\}/);
    assert.match(tsxSources.TimelineBar, /"resize-start"/);
    assert.match(tsxSources.TimelineBar, /"resize-end"/);
    assert.match(tsxSources.TimelineBar, /aria-label=\{barAriaLabel\(bar, label, roomLabel, note\)\}/, "el aria-label lleva habitación, fechas y el motivo cuando no se puede redimensionar (U9b)");
    // U9b: una reserva en el hotel no ofrece asideros (409 REC-03) y lo explica: data-resize + motivo del motor en aria-label y tarjeta rápida.
    assert.match(tsxSources.TimelineBar, /data-resize=\{String\(allowed\.resize\)\}/);
    assert.match(tsxSources.TimelineBar, /export function resizeNote\(/);
    assert.match(tsxSources.TimelineBar, /allowed: \{ move: boolean; resize: boolean; room: boolean; reason\?: string \};/);
    assert.match(tsxSources.TimelineQuickCard, /allowed\?: Pick<DragPermission, "move" \| "resize" \| "room" \| "reason">;/);
    assert.match(tsxSources.TimelineQuickCard, /const restriction = allowed && \(!allowed\.resize \|\| !allowed\.move\) \? allowed\.reason : undefined;/);
    assert.match(tsxSources.TimelineQuickCard, /export const QUICK_CARD_HINT_TOUCH = "Toca para abrir el detalle · mantén pulsado y arrastra para mover";/);
    assert.match(tsxSources.TimelineQuickCard, /\{quickCardHint\(coarse\)\}/, "con el dedo la pista habla de mantener pulsado");
    assert.match(tsxSources.TimelineQuickCard, /useCoarsePointer\(\)/);
    assert.match(tsxSources.TimelineBar, /dateRange\(bar\.res\.arrivalDate, bar\.res\.departureDate, DAY_MONTH\)/);
    assert.match(tsxSources.TimelineBar, /onKeyDown=\{onKeyDown\}/, "el teclado lo resuelve la parrilla en un único sitio");
    assert.doesNotMatch(tsxSources.TimelineBar, /onSelect/, "la barra no abre nada por su cuenta");
    assert.match(tsxSources.TimelineQuickCard, /className="tl-quick__facts"/);
    assert.match(tsxSources.TimelineQuickCard, /marketSegmentLabel/);
    assert.match(tsxSources.TimelineGapAlert, /role="alert"/);
    assert.match(tsxSources.TimelineGapAlert, /overbookingSummary/);
    // TimelineUndoBar = reexport de CocoaUndoBar (Tanda UX-1 · U4); sus asserts (role=status, clearInterval,
    // seconds = DEFAULT_UNDO_SECONDS, entry.note) viven en components/cocoa/__tests__/CocoaUndoBar.test.mts.
    assert.match(tsxSources.TimelineUndoBar, /export \{ CocoaUndoBar as TimelineUndoBar[^}]*\} from "\.\.\/cocoa";/);
  });

  it("textos en español (sin cadenas de UI en inglés)", () => {
    for (const name of TSX) {
      assert.doesNotMatch(tsxSources[name], />\s*(?:Undo|Close|Today|Previous|Next|Loading|Clear filters|Room)\s*</, `${name}.tsx: textos en español`);
    }
  });
});

describe("styles/cocoa-22-timeline.css", () => {
  it("solo tokens: sin hex/rgb/hsl y sin rejillas 1fr que mobile.css aplana", () => {
    assert.doesNotMatch(sheet, COLOUR_LITERAL);
    assert.doesNotMatch(sheet, /repeat\(2, 1fr\)|repeat\(3, 1fr\)|1fr 1fr/);
    assert.doesNotMatch(sheet, /transition:\s*all/);
    assert.doesNotMatch(sheet, /position:\s*fixed/);
    assert.doesNotMatch(sheet, /\p{Extended_Pictographic}/u);
  });

  it("define las clases y ganchos que consumen los componentes y TL-3/TL-4", () => {
    for (const needle of ["--tl-col", "--tl-days", "--tl-today", "--tl-lead", "--tl-row-h", "--tl-h", ".tl-grid", ".tl-grid__head", ".tl-head-cell", ".tl-row", ".tl-row--group", ".tl-row--blocked", ".tl-lead", ".tl-lead__meta", ".tl-lane", ".tl-lane__today", ".tl-bar", ".tl-bar__title", ".tl-bar__meta", ".tl-bar__handle", ".tl-ghost", ".tl-cell-select", ".tl-avail__cell", ".tl-avail--sticky", ".tl-spacer", ".tl-legend", ".tl-quick", ".tl-quick__facts", ".tl-facts", ".tl-workspace", ".tl-workspace__main", ".tl-panel", ".tl-panel__head", ".tl-panel__title", ".tl-panel__foot"]) {
      assert.ok(sheet.includes(needle), `la hoja define ${needle}`);
    }
    for (const needle of ["data-tone", "data-sticky", "data-kind", "data-dragging", "data-valid", "data-level", "data-edge", "data-today", "data-weekend", "data-panel", "prefers-reduced-motion", "pointer: coarse", "--c22-tone-bg", "--c22-tone-border", "--c22-tone-text", "var(--cocoa-z-sticky)"]) {
      assert.ok(sheet.includes(needle), `la hoja contiene ${needle}`);
    }
    assert.match(sheet, /grid-template-columns: var\(--tl-lead, 200px\) repeat\(var\(--tl-days, 14\), var\(--tl-col, 118px\)\)/);
    assert.match(sheet, /^\/\* =+\n\s+Cocoa 22 · Live Timeline · se importa desde styles\.css/);
  });

  it("corrección 1: alturas fijas (virtualización medida = asumida), trazos por estado, dedo sobre las barras y panel sin scrim", () => {
    const rules = stripCss(sheet);
    assert.match(rules, /\.tl-row \{[^}]*height: var\(--tl-row-h, 56px\)/, ".tl-row con altura fija (no min-height)");
    assert.doesNotMatch(rules, /\.tl-row \{[^}]*min-height/, ".tl-row sin min-height");
    assert.match(rules, /\.tl-row--group \{[^}]*height: var\(--tl-group-h\)/);
    assert.match(rules, /\.tl-lead \{[^}]*overflow: hidden/, "la celda de recursos recorta en vez de crecer");
    assert.match(rules, /\.tl-bar\[data-kind="checked_out"\] \{[^}]*opacity/);
    assert.match(rules, /\.tl-bar\[data-kind="no_show"\] \{[^}]*border-style: dotted/);
    assert.match(rules, /\.tl-bar\[data-kind="no_show"\] \.tl-bar__title \{[^}]*line-through/);
    // U9b (§5.11 (3), §7.2): pan-y sobre barras y asideros (el arrastre exige pulsación larga), barra 44 y asideros 24 con el dedo.
    assert.match(rules, /@media \(pointer: coarse\) \{[^@]*\.tl-bar \{[^}]*touch-action: pan-y;/, "con el dedo la parrilla se desplaza en vertical sobre las barras");
    assert.doesNotMatch(rules, /@media \(pointer: coarse\) \{[^@]*touch-action: pan-x pan-y/, "sin pan-x: el movimiento horizontal queda para el arrastre armado");
    assert.match(rules, /@media \(pointer: coarse\) \{[^@]*\.tl-bar__handle \{[^}]*width: 24px;[^}]*touch-action: pan-y;/, "asideros de 24 px (WCAG 2.5.8) que también dejan desplazar");
    assert.match(rules, /@media \(pointer: coarse\) \{[^@]*\.tl-grid \{[^}]*--tl-bar-h: 44px;/, "barra de 44 px de respaldo en la hoja");
    assert.match(rules, /\.tl-bar__handle \{[^}]*width: 10px;/, "con ratón los asideros siguen en 10 px");
    assert.match(rules, /\.tl-bar\[data-armed="true"\] \{[^}]*box-shadow/, "la pulsación larga armada se ve");
    assert.match(rules, /\.tl-bar \{[^}]*-webkit-touch-callout: none;/, "sin globo de iOS al mantener pulsado");
    assert.match(rules, /\.tl-workspace\[data-panel="open"\] \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(300px, 380px\)/);
    assert.match(rules, /\.tl-panel \{[^}]*position: sticky/);
    assert.doesNotMatch(rules, /\.tl-panel \{[^}]*position: fixed/);
    assert.match(rules, /\.tl-quick \{[^}]*width: min\(280px, 80vw\)/);
  });
});
