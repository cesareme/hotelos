import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COLUMN_PREFS_STORAGE_PREFIX,
  CocoaTable,
  VIRTUALIZE_CHUNK,
  VIRTUALIZE_THRESHOLD,
  applyColumnPrefs,
  columnPrefsStorageKey,
  columnSizingStyle,
  defaultRender,
  densityRowPadding,
  deselectRows,
  headerCheckboxState,
  isColumnVisible,
  isSelectAllShortcut,
  isTableOverflowing,
  moveColumn,
  nextSort,
  normalizeColumnPrefs,
  rangeSelection,
  readColumnPrefs,
  resolveRowKey,
  selectAllRows,
  selectionStatusLabel,
  toggleColumnHidden,
  toggleSelection,
  truncatedCellTitle,
  visibleRowCount,
  wrapOverflowStyle,
  writeColumnPrefs
} from "../CocoaTable.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const cocoaCss = readFileSync(resolve(here, "../../../styles/cocoa-22.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first `selector {…}` rule inside `css` (comments already stripped). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `rule ${selector} not found in cocoa-22.css`);
  return css.slice(start, css.indexOf("}", start));
}

/** Opening tag of the first cell (`th`/`td`) inside the first `<section>…</section>` of `html`. */
function firstCellTag(html: string, section: "thead" | "tbody" | "tfoot"): string {
  const block = html.match(new RegExp(`<${section}[^>]*>[\\s\\S]*?</${section}>`));
  assert.ok(block, `no <${section}> in ${html}`);
  const cell = block[0].match(/<t[hd]\b[^>]*>/);
  assert.ok(cell, `no cell in <${section}>`);
  return cell[0];
}

describe("CocoaTable · sorting", () => {
  it("toggles asc → desc on the same key and starts asc on a new key", () => {
    assert.deepEqual(nextSort(undefined, "name"), { key: "name", direction: "asc" });
    assert.deepEqual(nextSort({ key: "name", direction: "asc" }, "name"), { key: "name", direction: "desc" });
    assert.deepEqual(nextSort({ key: "name", direction: "desc" }, "name"), { key: "name", direction: "asc" });
    assert.deepEqual(nextSort({ key: "name", direction: "desc" }, "total"), { key: "total", direction: "asc" });
  });
});

describe("CocoaTable · progressive rendering", () => {
  it("renders everything up to the threshold, then chunks of 100", () => {
    assert.equal(VIRTUALIZE_THRESHOLD, 200);
    assert.equal(VIRTUALIZE_CHUNK, 100);
    assert.equal(visibleRowCount(150, 1), 150);
    assert.equal(visibleRowCount(200, 1), 200);
    assert.equal(visibleRowCount(450, 1), 200);
    assert.equal(visibleRowCount(450, 2), 300);
    assert.equal(visibleRowCount(450, 4), 450);
    assert.equal(visibleRowCount(450, 9), 450);
    assert.equal(visibleRowCount(450, 0), 200);
  });
});

describe("CocoaTable · density (§2.3)", () => {
  it("comfortable 8 12 · compact 4 10 · inherited from the page tokens when omitted", () => {
    assert.equal(densityRowPadding("comfortable"), "var(--cocoa-space-2) var(--cocoa-space-3)");
    assert.equal(densityRowPadding("compact"), "var(--cocoa-space-1) 10px");
    assert.match(densityRowPadding(undefined), /^var\(--cocoa-density-cell-padding-y, var\(--cocoa-space-2\)\) var\(--cocoa-density-cell-padding-x, var\(--cocoa-space-3\)\)$/);
  });
});

describe("CocoaTable · rows and cells", () => {
  it("resolves the row key from a function, a field or the index", () => {
    const row = { id: 7, code: "RES-1" };
    assert.equal(resolveRowKey(row, (r) => r.code, 0), "RES-1");
    assert.equal(resolveRowKey(row, "id", 0), "7");
    assert.equal(resolveRowKey(row, "missing", 3), "3");
    assert.equal(resolveRowKey(row, undefined, 5), "5");
  });
  it("defaultRender prints scalars, «—» for nothing and Sí/No for booleans", () => {
    const row = { a: "x", b: 2, c: null, d: undefined, e: true, f: false, g: { nested: 1 } };
    assert.equal(defaultRender(row, "a"), "x");
    assert.equal(defaultRender(row, "b"), 2);
    assert.equal(defaultRender(row, "c"), "—");
    assert.equal(defaultRender(row, "d"), "—");
    assert.equal(defaultRender(row, "e"), "Sí");
    assert.equal(defaultRender(row, "f"), "No");
    assert.equal(defaultRender(row, "g"), null);
  });
});

describe("CocoaTable · wrapper overflow vs sticky head (§3.7, review#4)", () => {
  it("by default the wrapper is NOT a scroll container (clip), so the head sticks to the page scroller", () => {
    assert.deepEqual(wrapOverflowStyle({ overflowing: false }), { overflowX: "clip", overflowY: "visible" });
  });
  it("a table wider than its wrapper turns the wrapper into a horizontal scroller", () => {
    assert.deepEqual(wrapOverflowStyle({ overflowing: true }), { overflowX: "auto", overflowY: "hidden" });
  });
  it("maxHeight makes the wrapper the scroller (the head sticks inside it) whatever the width", () => {
    assert.deepEqual(wrapOverflowStyle({ maxHeight: 420, overflowing: true }), { overflow: "auto", maxHeight: 420 });
    assert.deepEqual(wrapOverflowStyle({ maxHeight: 0, overflowing: false }), { overflow: "auto", maxHeight: 0 });
  });
  it("overflow detection tolerates half a pixel of subpixel layout", () => {
    assert.equal(isTableOverflowing(800, 800), false);
    assert.equal(isTableOverflowing(800.4, 800), false);
    assert.equal(isTableOverflowing(801, 800), true);
  });
});

describe("CocoaTable · column visibility by tier (qa#2)", () => {
  it("shows every column everywhere by default", () => {
    for (const tier of ["phone", "tablet", "laptop", "desktop"] as const) assert.equal(isColumnVisible({}, tier), true);
  });
  it("hideOnNarrow hides only on phones (< 600, the card layout)", () => {
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "phone"), false);
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "tablet"), true);
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "laptop"), true);
    assert.equal(isColumnVisible({ hideOnNarrow: true }, "desktop"), true);
  });
  it("showFrom hides the column below that tier: «desktop» hides it on a 1024 laptop", () => {
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "laptop"), false);
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "tablet"), false);
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "phone"), false);
    assert.equal(isColumnVisible({ showFrom: "desktop" }, "desktop"), true);
    assert.equal(isColumnVisible({ showFrom: "laptop" }, "tablet"), false);
    assert.equal(isColumnVisible({ showFrom: "laptop" }, "laptop"), true);
    assert.equal(isColumnVisible({ showFrom: "tablet" }, "phone"), false);
    assert.equal(isColumnVisible({ showFrom: "tablet" }, "tablet"), true);
    assert.equal(isColumnVisible({ showFrom: "phone" }, "phone"), true);
  });
  it("hideOnNarrow and showFrom combine (the stricter one wins at each tier)", () => {
    assert.equal(isColumnVisible({ hideOnNarrow: true, showFrom: "desktop" }, "phone"), false);
    assert.equal(isColumnVisible({ hideOnNarrow: true, showFrom: "desktop" }, "laptop"), false);
    assert.equal(isColumnVisible({ hideOnNarrow: true, showFrom: "desktop" }, "desktop"), true);
  });
});

describe("CocoaTable · column sizing (qa#2)", () => {
  it("a plain text column has no sizing: it takes the free width and wraps", () => {
    assert.deepEqual(columnSizingStyle({}), {});
    assert.deepEqual(columnSizingStyle({ align: "left" }), {});
    assert.deepEqual(columnSizingStyle({ align: "center" }), {});
  });
  it("fit shrinks the column to its content on one line (1 px width = min-content in auto layout, like the actions cell)", () => {
    assert.deepEqual(columnSizingStyle({ fit: true }), { width: 1, whiteSpace: "nowrap" });
  });
  it("an explicit width wins over fit; minWidth passes through", () => {
    assert.deepEqual(columnSizingStyle({ fit: true, width: "11ch" }), { width: "11ch", whiteSpace: "nowrap" });
    assert.deepEqual(columnSizingStyle({ width: "11ch" }), { width: "11ch" });
    assert.deepEqual(columnSizingStyle({ minWidth: 200 }), { minWidth: 200 });
    assert.deepEqual(columnSizingStyle({ fit: true, minWidth: 96 }), { width: 1, minWidth: 96, whiteSpace: "nowrap" });
  });
  it("right-aligned (numeric) cells never wrap by default: «2.595,00 €» stays on one line", () => {
    assert.deepEqual(columnSizingStyle({ align: "right" }), { whiteSpace: "nowrap" });
    assert.deepEqual(columnSizingStyle({ align: "right", fit: true }), { width: 1, whiteSpace: "nowrap" });
  });
  it("nowrap is an explicit override in both directions", () => {
    assert.deepEqual(columnSizingStyle({ align: "right", nowrap: false }), {});
    assert.deepEqual(columnSizingStyle({ fit: true, nowrap: false }), { width: 1 });
    assert.deepEqual(columnSizingStyle({ nowrap: true }), { whiteSpace: "nowrap" });
  });
});

describe("CocoaTable · truncated cells (qa#1 8-A)", () => {
  const token = "DNI v1.c32d4f97339618f6d4878799.e60b5b44ed93407a2a.9e621206364315d7a55f0c1b2d3e4f5a6b7c8d9e";
  const columns = [
    { key: "guest", label: "Huésped", minWidth: 180 },
    { key: "document", label: "Documento", fit: true, truncate: 160 },
    { key: "status", label: "Estado", fit: true, render: (r: { status: string }) => createElement("em", null, r.status) }
  ];
  const rows = [{ id: 1, guest: "Ana Pérez", document: token, status: "accepted" }];
  const html = renderToStaticMarkup(createElement(CocoaTable, { columns, rows, rowKey: "id", "aria-label": "Partes" } as never));

  it("the tooltip carries the full text of a scalar cell and nothing for JSX", () => {
    assert.equal(truncatedCellTitle(token), token);
    assert.equal(truncatedCellTitle(1234), "1234");
    assert.equal(truncatedCellTitle(createElement("em", null, "x")), undefined);
    assert.equal(truncatedCellTitle(null), undefined);
  });

  it("only the truncated column wraps its value in the capped inline-block, with the full value as tooltip", () => {
    const cells = html.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) ?? [];
    assert.equal(cells.length, 3);
    assert.doesNotMatch(cells[0], /c22-table__truncate/, `guest cell untouched: ${cells[0]}`);
    assert.match(cells[1], /<span class="cocoa-truncate c22-table__truncate" style="display:inline-block;max-width:160px;vertical-align:bottom" title="DNI v1\.c32d4f97[^"]*">DNI v1\.c32d4f97/, `document cell capped: ${cells[1]}`);
    assert.doesNotMatch(cells[2], /c22-table__truncate/, `status cell untouched: ${cells[2]}`);
  });

  it("fit still applies to the truncated column (min-content width, one line)", () => {
    const cells = html.match(/<td\b[^>]*>/g) ?? [];
    assert.match(cells[1], /width:1px/);
    assert.match(cells[1], /white-space:nowrap/);
    assert.match(cells[1], /data-fit="true"/);
  });
});

describe("CocoaTable · sticky first column keeps the section background (qa#3)", () => {
  const columns = [
    { key: "day", label: "Día" },
    { key: "rooms", label: "Habitaciones", align: "right" as const },
    { key: "revenue", label: "Ingresos", align: "right" as const }
  ];
  const rows = [
    { id: 1, day: "01/09", rooms: 40, revenue: "3.200,00 €" },
    { id: 2, day: "02/09", rooms: 42, revenue: "3.410,00 €" }
  ];
  const html = renderToStaticMarkup(createElement(CocoaTable, { columns, rows, rowKey: "id", stickyFirstColumn: true, footer: { day: "Total", rooms: 82, revenue: "6.610,00 €" }, "aria-label": "Informe diario" } as never));

  it("the sticky cell of head, body and foot carries no inline background (the stylesheet paints it per section)", () => {
    for (const section of ["thead", "tbody", "tfoot"] as const) {
      const tag = firstCellTag(html, section);
      assert.match(tag, /position:sticky/, `${section} first cell is sticky: ${tag}`);
      assert.match(tag, /left:0/, `${section} first cell is pinned to the left: ${tag}`);
      assert.doesNotMatch(tag, /background/, `${section} first cell must not paint its background inline: ${tag}`);
    }
  });

  it("the table advertises the sticky column to the stylesheet and the foot still renders the totals", () => {
    assert.match(html, /<table[^>]*data-sticky-first-column="true"/);
    assert.match(html, /<tfoot>[\s\S]*Total[\s\S]*6\.610,00 €[\s\S]*<\/tfoot>/);
  });

  it("the stylesheet gives the sticky totals cell the same inverse surface and ink as the rest of the foot", () => {
    const foot = ruleBody(cocoaCss, ".c22-table tfoot td");
    const stickyFoot = ruleBody(cocoaCss, '.c22-table[data-sticky-first-column="true"] tfoot :is(th, td):first-child');
    const footBackground = foot.match(/background:\s*([^;]+);/)?.[1];
    const footColor = foot.match(/color:\s*([^;]+);/)?.[1];
    assert.ok(footBackground && footColor, `tfoot rule paints background and colour: ${foot}`);
    assert.match(stickyFoot, new RegExp(`background:\\s*${footBackground.replace(/[()]/g, "\\$&")};`));
    assert.match(stickyFoot, new RegExp(`color:\\s*${footColor.replace(/[()]/g, "\\$&")};`));
  });

  it("the sticky totals rule out-ranks the generic sticky rule (0,3,2 > 0,3,1) and follows it in source order", () => {
    const generic = cocoaCss.indexOf('.c22-table[data-sticky-first-column="true"] :is(th, td):first-child {');
    const stickyFoot = cocoaCss.indexOf('.c22-table[data-sticky-first-column="true"] tfoot :is(th, td):first-child {');
    assert.ok(generic >= 0 && stickyFoot > generic);
    assert.match(ruleBody(cocoaCss, '.c22-table[data-sticky-first-column="true"] :is(th, td):first-child'), /background:\s*var\(--cocoa-background-content\);/);
  });
});

// ---------------------------------------------------------------- Tanda UX-1 · U4

const U4_COLUMNS = [
  { key: "code", label: "Código", fit: true },
  { key: "guest", label: "Huésped" },
  { key: "room", label: "Habitación", align: "right" as const }
];
const U4_ROWS = [
  { id: "r1", code: "UXDAY-T1", guest: "Huésped Alfa", room: "—" },
  { id: "r2", code: "UXDAY-A2", guest: "Huésped Beta", room: "204" },
  { id: "r3", code: "UXDAY-A3", guest: "Huésped Gamma", room: "310" }
];

describe("CocoaTable · keepDataWhileLoading: la tabla no se vacía (UX-1 F11, §6.1)", () => {
  it("con filas y keepDataWhileLoading, loading pinta las filas actuales bajo aria-busy + velo, no esqueleto", () => {
    const html = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id", loading: true, keepDataWhileLoading: true, "aria-label": "Llegadas" } as never));
    assert.match(html, /<div[^>]*class="c22-table-wrap cocoa-table-wrap"[^>]*aria-busy="true"/);
    assert.match(html, /<table/);
    assert.match(html, /UXDAY-A2/);
    assert.match(html, /<div class="c22-table__busy" aria-hidden="true" data-cocoa="table-busy"><\/div>/);
    assert.doesNotMatch(html, /data-cocoa="table-loading"/);
  });
  it("sin keepDataWhileLoading (comportamiento de siempre) o sin filas que conservar, loading pinta las filas esqueleto", () => {
    const legacy = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id", loading: true } as never));
    assert.match(legacy, /data-cocoa="table-loading"/);
    assert.doesNotMatch(legacy, /<table/);
    const empty = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: [], rowKey: "id", loading: true, keepDataWhileLoading: true } as never));
    assert.match(empty, /data-cocoa="table-loading"/);
  });
  it("sin loading no hay velo ni aria-busy", () => {
    const html = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id", keepDataWhileLoading: true } as never));
    assert.doesNotMatch(html, /aria-busy|table-busy/);
  });
  it("la hoja atenúa las filas y pinta la línea de actividad (estática con movimiento reducido)", () => {
    assert.match(cocoaCss, /\.c22-table-wrap\[aria-busy="true"\] > \.c22-table,\s*\.c22-table-cards\[aria-busy="true"\] > :not\(\.c22-table__busy\) \{ opacity: 0\.6;/);
    assert.match(cocoaCss, /\.c22-table__busy::before \{[^}]*animation: cocoa-shimmer/);
    assert.match(cocoaCss, /\.c22-table__busy::before \{ animation: none !important;/);
  });
});

describe("CocoaTable · selección múltiple (UX-1 F25, §4 «Selección múltiple»)", () => {
  it("toggle, rango con Shift (con y sin ancla, en ambos sentidos), todas y ninguna (puro)", () => {
    const keys = ["a", "b", "c", "d", "e"];
    assert.deepEqual(toggleSelection([], "b"), ["b"]);
    assert.deepEqual(toggleSelection(["b"], "b"), []);
    assert.deepEqual(rangeSelection({ selected: [], keys, anchorIndex: null, targetIndex: 2 }), ["c"], "sin ancla, Shift+clic solo alterna");
    assert.deepEqual(rangeSelection({ selected: ["a"], keys, anchorIndex: 1, targetIndex: 3 }), ["a", "b", "c", "d"]);
    assert.deepEqual(rangeSelection({ selected: [], keys, anchorIndex: 4, targetIndex: 2 }), ["c", "d", "e"], "rango hacia arriba");
    assert.deepEqual(rangeSelection({ selected: ["z"], keys, anchorIndex: 0, targetIndex: 9 }), ["z"], "índice fuera de rango: sin cambio");
    assert.deepEqual(selectAllRows(["x"], keys), ["x", "a", "b", "c", "d", "e"]);
    assert.deepEqual(deselectRows(["x", "a", "b"], keys), ["x"]);
  });
  it("Ctrl/⌘A, estado de la casilla de cabecera y recuento", () => {
    assert.equal(isSelectAllShortcut({ key: "a", metaKey: true, ctrlKey: false }), true);
    assert.equal(isSelectAllShortcut({ key: "A", metaKey: false, ctrlKey: true }), true);
    assert.equal(isSelectAllShortcut({ key: "a", metaKey: true, ctrlKey: false, shiftKey: true }), false);
    assert.equal(isSelectAllShortcut({ key: "a", metaKey: false, ctrlKey: false }), false);
    assert.equal(headerCheckboxState(0, 3), "none");
    assert.equal(headerCheckboxState(2, 3), "some");
    assert.equal(headerCheckboxState(3, 3), "all");
    assert.equal(headerCheckboxState(0, 0), "none");
    assert.equal(selectionStatusLabel(1), "1 fila seleccionada");
    assert.equal(selectionStatusLabel(4), "4 filas seleccionadas");
  });
  it("selectable=multiple: aria-multiselectable, casilla por fila con nombre, aria-selected por selección, barra de lote con recuento y «Quitar selección»", () => {
    const html = renderToStaticMarkup(
      createElement(CocoaTable, {
        columns: U4_COLUMNS,
        rows: U4_ROWS,
        rowKey: "id",
        selectable: "multiple",
        selectedKeys: ["r1", "r3"],
        onSelectionChange: () => undefined,
        batchBar: (selection: { count: number }) => createElement("button", { type: "button" }, `Check-out de ${selection.count} con saldo 0`),
        "aria-label": "Salidas"
      } as never)
    );
    assert.match(html, /<table[^>]*aria-multiselectable="true"/);
    assert.equal((html.match(/class="c22-table__check-input"/g) ?? []).length, 4, "cabecera + 3 filas");
    assert.match(html, /aria-label="Seleccionar todas las filas visibles"/);
    assert.match(html, /aria-label="Seleccionar fila 2"/);
    const rows = html.match(/<tr\b[^>]*aria-selected="[^"]*"[^>]*>/g) ?? [];
    assert.deepEqual(
      rows.map((tag) => /aria-selected="true"/.test(tag)),
      [true, false, true]
    );
    assert.match(html, /role="toolbar" aria-label="Acciones sobre la selección"/);
    assert.match(html, /2 filas seleccionadas/);
    assert.match(html, /Check-out de 2 con saldo 0/);
    assert.match(html, /Quitar selección/);
    const headCells = (html.match(/<thead[\s\S]*?<\/thead>/)?.[0].match(/<th\b/g) ?? []).length;
    assert.equal(headCells, 4, "una columna más para la casilla");
  });
  it("sin selección no hay barra de lote; sin selectable no hay casillas ni aria-multiselectable", () => {
    const none = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id", selectable: "multiple", selectedKeys: [], onSelectionChange: () => undefined } as never));
    assert.doesNotMatch(none, /Acciones sobre la selección/);
    assert.match(none, /aria-multiselectable="true"/);
    const single = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id", selectedKey: "r2", onSelect: () => undefined } as never));
    assert.doesNotMatch(single, /aria-multiselectable|c22-table__check/);
    assert.match(single, /aria-selected="true"/);
  });
  it("objetivos: ≥ 24 px con ratón y 44 px con puntero grueso (WCAG 2.5.8)", () => {
    assert.match(ruleBody(cocoaCss, ".c22-table__check"), /min-width: 24px;\s*min-height: 24px;/);
    assert.match(cocoaCss, /@media \(pointer: coarse\) \{\s*\.c22-table__check \{ min-width: var\(--cocoa-touch-target\); min-height: var\(--cocoa-touch-target\); \}/);
  });
});

describe("CocoaTable · columnas configurables (UX-1 D11, §4 «Columnas configurables»)", () => {
  const keys = ["code", "guest", "room"];

  it("normaliza: claves desconocidas fuera, nuevas al final, sin duplicados, nunca todas ocultas", () => {
    assert.deepEqual(normalizeColumnPrefs(null, keys), { order: keys, hidden: [] });
    assert.deepEqual(normalizeColumnPrefs({ order: ["room", "zzz", "room"], hidden: ["zzz", "guest", "guest"] }, keys), { order: ["room", "code", "guest"], hidden: ["guest"] });
    assert.deepEqual(normalizeColumnPrefs({ order: [], hidden: ["code", "guest", "room"] }, keys).hidden, ["guest", "room"], "la primera en orden vuelve a verse");
  });
  it("aplica orden y ocultación a las columnas reales; sin prefs, las declaradas", () => {
    assert.deepEqual(
      applyColumnPrefs(U4_COLUMNS, { order: ["room", "code"], hidden: ["guest"] }).map((c) => c.key),
      ["room", "code"]
    );
    assert.equal(applyColumnPrefs(U4_COLUMNS, null), U4_COLUMNS);
  });
  it("mover ↑↓ y mostrar/ocultar (la última visible no se puede ocultar)", () => {
    assert.deepEqual(moveColumn(keys, "guest", -1), ["guest", "code", "room"]);
    assert.deepEqual(moveColumn(keys, "guest", 1), ["code", "room", "guest"]);
    assert.deepEqual(moveColumn(keys, "code", -1), keys);
    assert.deepEqual(moveColumn(keys, "nope", 1), keys);
    const hidden = toggleColumnHidden({ order: keys, hidden: [] }, "guest", keys);
    assert.deepEqual(hidden.hidden, ["guest"]);
    assert.deepEqual(toggleColumnHidden(hidden, "guest", keys).hidden, []);
    const almostAll = toggleColumnHidden({ order: keys, hidden: ["code", "guest"] }, "room", keys);
    assert.deepEqual(almostAll.hidden, ["guest", "room"], "code vuelve a verse");
  });
  it("lee y escribe en localStorage bajo hotelos-table-columns:<clave>; JSON corrupto → null; cuota agotada → sin excepción", () => {
    assert.equal(COLUMN_PREFS_STORAGE_PREFIX, "hotelos-table-columns:");
    assert.equal(columnPrefsStorageKey("reservas.lista"), "hotelos-table-columns:reservas.lista");
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    };
    writeColumnPrefs(storage, "reservas.lista", { order: ["room", "code", "guest"], hidden: ["guest"] });
    assert.deepEqual(JSON.parse(store.get("hotelos-table-columns:reservas.lista") ?? "{}"), { order: ["room", "code", "guest"], hidden: ["guest"] });
    assert.deepEqual(readColumnPrefs(storage, "reservas.lista", keys), { order: ["room", "code", "guest"], hidden: ["guest"] });
    writeColumnPrefs(storage, "reservas.lista", null);
    assert.equal(readColumnPrefs(storage, "reservas.lista", keys), null);
    store.set("hotelos-table-columns:rota", "{no es json");
    assert.equal(readColumnPrefs(storage, "rota", keys), null);
    store.set("hotelos-table-columns:tipos", JSON.stringify({ order: [1, "guest"], hidden: "guest" }));
    assert.deepEqual(readColumnPrefs(storage, "tipos", keys), { order: ["guest", "code", "room"], hidden: [] });
    assert.equal(readColumnPrefs(null, "x", keys), null);
    assert.doesNotThrow(() =>
      writeColumnPrefs(
        {
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
          removeItem: () => undefined
        },
        "x",
        { order: keys, hidden: [] }
      )
    );
  });
  it("columnsPrefsKey pinta el botón «Columnas» (haspopup dialog) sobre la tabla", () => {
    const html = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id", columnsPrefsKey: "reservas.lista" } as never));
    const tools = html.match(/<div class="c22-table__tools" data-cocoa="table-tools">(<button\b[^>]*>)[\s\S]*?<\/button>/);
    assert.ok(tools, `sin fila de herramientas en ${html.slice(0, 300)}`);
    assert.match(tools[1], /aria-haspopup="dialog"/);
    assert.match(tools[1], /aria-expanded="false"/);
    assert.match(tools[0], /Columnas/);
    const without = renderToStaticMarkup(createElement(CocoaTable, { columns: U4_COLUMNS, rows: U4_ROWS, rowKey: "id" } as never));
    assert.doesNotMatch(without, /table-tools|Columnas/);
  });
});
