import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AUTOSCROLL_EDGE_PX, AUTOSCROLL_STEP_PX, autoscrollDelta, cellIndexAt, dropRoomFromElement } from "../useTimelineDrag.ts";

// Tanda TL · lote TL-3: las funciones puras del hook de arrastre se prueban
// en runtime (el módulo importa solo react, el motor y timeline-presentation:
// node-seguro); la parrilla, la fila y el fantasma se pinchan sobre la fuente
// (Cocoa 22 estricto, presupuesto de `style={` 3/2/1/0, sin red, sin Intl,
// virtualización propia, arrastre con pointer events y teclado del motor).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
const lines = (src: string, re: RegExp) => src.split("\n").filter((line) => re.test(line)).length;

describe("useTimelineDrag · funciones puras", () => {
  it("cellIndexAt: floor sobre la anchura de celda, mínimo 0 y 0 con anchura inválida", () => {
    assert.equal(cellIndexAt(250, 100), 2);
    assert.equal(cellIndexAt(-5, 100), 0);
    assert.equal(cellIndexAt(0, 100), 0);
    assert.equal(cellIndexAt(99.9, 100), 0);
    assert.equal(cellIndexAt(100, 100), 1);
    assert.equal(cellIndexAt(1180, 118), 10);
    assert.equal(cellIndexAt(300, 0), 0);
    assert.equal(cellIndexAt(Number.NaN, 100), 0);
  });

  it("dropRoomFromElement: null sin elemento; lee data-room-id del ancestro más cercano", () => {
    assert.equal(dropRoomFromElement(null), null);
    const attrs: Record<string, string> = { "data-room-id": "room-202" };
    const row = { closest: (sel: string) => (sel === "[data-room-id]" ? row : null), getAttribute: (name: string) => attrs[name] ?? null };
    const lane = { closest: (sel: string) => row.closest(sel), getAttribute: () => null };
    assert.equal(dropRoomFromElement(lane as unknown as Element), "room-202");
    const orphan = { closest: () => null, getAttribute: () => null };
    assert.equal(dropRoomFromElement(orphan as unknown as Element), null);
  });

  it("autoscrollDelta: ±16 px al rozar 40 px del borde, 0 en el centro o con scroller demasiado estrecho", () => {
    assert.equal(AUTOSCROLL_EDGE_PX, 40);
    assert.equal(AUTOSCROLL_STEP_PX, 16);
    assert.equal(autoscrollDelta(210, 200, 1000), -16);
    assert.equal(autoscrollDelta(239, 200, 1000), -16);
    assert.equal(autoscrollDelta(240, 200, 1000), 0);
    assert.equal(autoscrollDelta(600, 200, 1000), 0);
    assert.equal(autoscrollDelta(961, 200, 1000), 16);
    assert.equal(autoscrollDelta(990, 200, 1000), 16);
    assert.equal(autoscrollDelta(210, 200, 260), 0, "scroller de 60 px: sin autoscroll");
  });
});

// ---------------------------------------------------------------------------
// Contrato de fuente (reglas 1-5, 9-11 de tests/cocoa-22-contract.test.mjs)
// ---------------------------------------------------------------------------

const grid = source("../TimelineGrid.tsx");
const row = source("../TimelineRow.tsx");
const dragLayer = source("../TimelineDragLayer.tsx");
const hook = source("../useTimelineDrag.ts");
const files: Array<[string, string, number]> = [
  ["TimelineGrid.tsx", grid, 3],
  ["TimelineRow.tsx", row, 2],
  ["TimelineDragLayer.tsx", dragLayer, 1],
  ["useTimelineDrag.ts", hook, 0]
];

function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/, `${name}: formats only through lib/format`);
}

describe("TL-3 · contrato de fuente", () => {
  it("los cuatro ficheros cumplen Cocoa 22: presupuesto style={ 3/2/1/0 (lote ≤ 6), cero style={{, sin red, sin Intl, sin librerías", () => {
    let total = 0;
    for (const [name, src, budget] of files) {
      assertCocoaRules(name, src);
      const n = count(src, /\bstyle=\{/g);
      assert.ok(n <= budget, `${name}: ${n} style={ (presupuesto ${budget})`);
      assert.equal(lines(src, /\bstyle=\{/), n, `${name}: cada style={ en su propia línea (grep -c)`);
      assert.equal(count(src, /\bstyle=\{\{/g), 0, `${name}: 0 style={{`);
      for (const line of src.split("\n").filter((entry) => /\bstyle=\{/.test(entry))) {
        assert.match(line, /style=\{[a-zA-Z]+\([^)]*\) as CSSProperties\}/, `${name}: style={fnConNombre(...) as CSSProperties}: ${line.trim()}`);
      }
      total += n;
      assert.doesNotMatch(src, /import\.meta/, `${name}: sin import.meta`);
      assert.doesNotMatch(src, /\.bo-|\bv2\//, `${name}: sin marcas antiguas`);
      assert.doesNotMatch(src, /from "(?:react-dnd|@dnd-kit|react-window|react-virtual|@tanstack\/react-virtual|react-virtualized)/, `${name}: sin librerías de drag & drop ni de virtualización`);
      for (const line of src.split("\n").filter((entry) => /from "\.\.\/\.\.\/services\//.test(entry))) {
        assert.match(line, /^import type\b/, `${name}: los servicios solo se importan como tipo: ${line}`);
      }
      assert.doesNotMatch(src, /from "\.\.\/\.\.\/services\/(?!pmsCommerceApi")/, `${name}: solo tipos de pmsCommerceApi`);
    }
    assert.ok(total <= 6, `lote: ${total} style={ (presupuesto 6)`);
  });

  it("TimelineGrid: CocoaScrollArea + role=grid, ventana de filas propia, hover local en CocoaPopover, teclado y arrastre del motor", () => {
    assert.match(grid, /from "\.\.\/cocoa";/, "primitivas del índice Cocoa");
    assert.match(grid, /<CocoaScrollArea/);
    assert.match(grid, /axis="both"/);
    assert.doesNotMatch(grid, /stickyFirstColumn/, "la columna fija la dan los data-sticky-column de cada fila");
    assert.match(grid, /role="grid"/);
    assert.match(grid, /aria-rowcount=\{rows\.length \+ 2\}/);
    assert.match(grid, /aria-colcount=\{columns\.length \+ 1\}/);
    assert.match(grid, /rowWindow\(/);
    assert.match(grid, /rowOffsets\(/);
    assert.match(grid, /ResizeObserver/);
    assert.match(grid, /requestAnimationFrame/);
    assert.match(grid, /addEventListener\("scroll", schedule, \{ passive: true \}\)/);
    assert.match(grid, /data-cocoa="scroll-area"/);
    assert.match(grid, /<CocoaPopover/);
    assert.match(grid, /role="tooltip"/);
    assert.match(grid, /placement="top"/);
    assert.match(grid, /<TimelineQuickCard/);
    assert.match(grid, /useState<\{ bar: BarModel; el: HTMLElement \} \| null>/, "hover local, no elevado a la pantalla");
    assert.match(grid, /neighborBar\(/);
    assert.match(grid, /resolveDrop\(\{ res: bar\.res, mode, dxDays, targetRoomId, roomById, roomTypeById, reservations \}\)/, "el arrastre se valida con las reservas cargadas");
    assert.match(grid, /onDropRejected/);
    assert.match(grid, /useTimelineDrag\(/);
    assert.match(grid, /<TimelineDragLayer/);
    assert.match(grid, /dragChild=/);
    assert.match(grid, /<TimelineHeader columns=\{columns\} \/>/);
    assert.match(grid, /<TimelineAvailabilityRow label=\{TOTAL_AVAILABILITY_LABEL\} counts=\{totalAvailability\} sellable=\{totalSellable\} sticky rowIndex=\{2\} \/>/);
    assert.match(grid, /id=\{`tl-group-\$\{row\.roomTypeId\}`\}/);
    assert.match(grid, /className="tl-spacer"/);
    assert.equal(count(grid, /spacerVars\(/g), 2, "dos espaciadores (superior e inferior)");
    assert.match(grid, /gridVars\(range, todayIndex, leadWidth\)/);
    assert.match(grid, /const leadWidth = narrow \? LEAD_WIDTH_NARROW : LEAD_WIDTH;/, "columna de recursos estrecha en teléfonos");
    assert.match(grid, /const narrow = useIsNarrow\(\);/);
    assert.match(grid, /open=\{hover !== null && dragging === null && !narrow\}/, "sin tarjeta rápida en teléfonos (no hay ratón)");
    assert.match(grid, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
    assert.match(grid, /data-reservation-id=/);
    assert.match(grid, /onCreateFromCells\(/);
    assert.match(grid, /row\.kind !== "room" \|\| row\.blocked/, "la selección de celdas solo en habitaciones no bloqueadas");
    assert.match(grid, /"Escape"/);
    assert.match(grid, /onSelect\(null\)/, "Escape deselecciona");
    assert.match(grid, /HEAD_HEIGHT \+ GROUP_ROW_HEIGHT/, "scrollTop relativo al inicio de las filas");
    assert.equal(count(grid, /useCallback\(/g) >= 9, true, "handlers estables para las filas memoizadas");
    assert.match(grid, /pinRow\(baseWin, offsets, draggingRowIndex\)/, "la fila origen del arrastre no sale de la ventana virtual");
    assert.match(grid, /rowIndex = win\.start \+ offset \+ FIRST_DATA_ROW_INDEX/, "aria-rowindex absoluto");
    assert.match(grid, /useImperativeHandle\(handleRef, \(\) => \(\{ focusBar/, "la pantalla devuelve el foco a la barra al cerrar el detalle");
    for (const label of ["Live Timeline de reservas por habitación", "Ficha rápida de la reserva", "Libres"]) {
      assert.ok(grid.includes(label), `grid: «${label}»`);
    }
  });

  it("corrección 1 · selección ≠ detalle: las flechas solo seleccionan, Intro/Espacio y el clic abren, Escape lo decide la pantalla", () => {
    const arrows = grid.slice(grid.indexOf("const dir = ARROWS[e.key];"), grid.indexOf('if (e.key === "Enter" || e.key === " ")'));
    assert.match(arrows, /onSelect\(next\)/);
    assert.doesNotMatch(arrows, /onOpen\(/, "una flecha nunca abre el inspector");
    const enter = grid.slice(grid.indexOf('if (e.key === "Enter" || e.key === " ")'), grid.indexOf('if (e.key === "Escape")'));
    assert.match(enter, /onSelect\(id\)/);
    assert.match(enter, /onOpen\(id, "keyboard"\)/);
    const click = grid.slice(grid.indexOf("const handleBarClick = useCallback("), grid.indexOf("const handleDrop = useCallback("));
    assert.match(click, /onSelect\(id\)/);
    assert.match(click, /onOpen\(id, "pointer"\)/);
    const escape = grid.slice(grid.indexOf('if (e.key === "Escape")'), grid.indexOf("// ---- selección de celdas"));
    assert.match(escape, /e\.stopPropagation\(\);\s*onEscape\(\);/, "con manejador de la pantalla, Escape no llega dos veces");
    assert.match(escape, /else \{\s*onSelect\(null\);/);
    assert.match(grid, /onOpen\(id: string, via: TimelineOpenVia\): void;/);
    assert.match(grid, /onEscape\?\(\): void;/);
  });

  it("corrección 1 · un clic o un toque en un hueco no crea nada: la selección de celdas exige arrastrar (dragPhase)", () => {
    const cells = grid.slice(grid.indexOf("const onCellPointerDown = useCallback("), grid.indexOf("useEffect(() => () => cellUnsubscribeRef.current?.(), []);"));
    assert.match(cells, /phase: "click"/);
    assert.match(cells, /dragPhase\(ev\.clientX - current\.startX, ev\.clientY - current\.startY\) === "click"\) return;/);
    assert.match(cells, /if \(phase === "drag"\) onCreateFromCells\(sel\);/);
    assert.doesNotMatch(cells.slice(0, cells.indexOf("const onMove")), /setCellSelection\(current\.sel\)/, "nada se pinta en el pointerdown");
  });

  it("TimelineRow: memo + data-room-id, celda de recursos fija, carril con aria-colspan, badge de estado y «Sin asignar»", () => {
    assert.match(row, /export const TimelineRow = memo\(/);
    assert.match(row, /data-room-id=\{row\.id\}/);
    assert.match(row, /role="row"/);
    assert.match(row, /aria-rowindex=\{rowIndex\}/);
    assert.match(row, /className="tl-lead__meta"/, "tipo · pax · planta y el badge Bloqueada en UNA línea (altura fija)");
    assert.match(row, /roomLabel=\{roomLabel\}/, "la barra recibe la habitación para su aria-label");
    assert.doesNotMatch(row, /onBarSelect/, "la fila no tiene un canal de apertura propio");
    assert.match(row, /role="rowheader" data-sticky-column="true"/);
    assert.match(row, /className="tl-lane"/);
    assert.match(row, /aria-colspan=\{range\.dayCount\}/);
    assert.match(row, /e\.target === e\.currentTarget/, "solo el carril vacío inicia la selección de celdas");
    assert.match(row, /cellIndexAt\(e\.nativeEvent\.offsetX, range\.cellWidth\)/);
    assert.match(row, /tl-row--blocked/);
    assert.match(row, /className="tl-lane__today"/);
    assert.match(row, /className="tl-cell-select"/);
    assert.match(row, /ROOM_STATUS_TONE\[row\.statusKey\]/);
    assert.match(row, /ROOM_STATUS_LABEL\[row\.statusKey\]/);
    assert.match(row, /variant="dot"/);
    assert.match(row, /Planta \$\{row\.room\.floor\}/);
    assert.match(row, /<TimelineBar/);
    assert.match(row, /allowed=\{dragAllowed\(bar\.res\)\}/);
    assert.match(row, /geometry=\{barGeometry\(bar, range\)\}|const geometry = barGeometry\(bar, range\)/);
    assert.match(row, /\{dragChild\}/);
    for (const label of ["Sin asignar", "Reservas sin habitación", "Bloqueada", "pax"]) {
      assert.ok(row.includes(label), `row: «${label}»`);
    }
  });

  it("TimelineDragLayer: fantasma tl-ghost aria-hidden con la geometría base (barVars) y el título/meta de la barra", () => {
    assert.match(dragLayer, /className="tl-bar tl-ghost"/);
    assert.match(dragLayer, /aria-hidden="true"/);
    assert.match(dragLayer, /ref=\{ghostRef\}/);
    assert.match(dragLayer, /data-tone=\{bar\.tone\}/);
    assert.match(dragLayer, /data-kind=\{kind\}/);
    assert.match(dragLayer, /style=\{barVars\(geometry\) as CSSProperties\}/);
    assert.match(dragLayer, /className="tl-bar__title"/);
    assert.match(dragLayer, /className="tl-bar__meta"/);
    assert.match(dragLayer, /money\(res\.totalAmount, res\.currency\)/);
    const reactImports = dragLayer.split("\n").filter((line) => /from "react";$/.test(line));
    assert.deepEqual(reactImports, ['import type { CSSProperties, RefObject } from "react";'], "solo tipos de React (sin hooks ni estado)");
  });

  it("useTimelineDrag: node-seguro (solo react, motor y presentación pura), un único useState, Escape/pointercancel, setProperty y elementFromPoint", () => {
    assert.equal(count(hook, /useState</g), 1, "el único estado React es dragging");
    assert.match(hook, /"Escape"/);
    assert.match(hook, /pointercancel/);
    assert.match(hook, /setProperty\(/);
    assert.match(hook, /elementFromPoint/);
    assert.match(hook, /window\.addEventListener\("pointermove"/);
    assert.match(hook, /window\.addEventListener\("pointerup"/);
    assert.match(hook, /window\.addEventListener\("keydown"/);
    assert.doesNotMatch(hook, /\.setPointerCapture\(/, "listeners de window, sin captura del puntero");
    assert.match(hook, /dragPhase\(/);
    assert.match(hook, /snapDays\(/);
    assert.match(hook, /ghostVars\(/);
    assert.match(hook, /"--tl-dy"/);
    assert.match(hook, /data-valid/);
    assert.match(hook, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
    assert.match(hook, /scrollLeft \+= delta/, "autoscroll horizontal");
    assert.match(hook, /scrollTop \+= deltaY/, "autoscroll vertical (corrección 1)");
    assert.match(hook, /const scrollTopStartRef = useRef\(0\);/, "el desplazamiento vertical cuenta en el fantasma");
    assert.match(hook, /if \(d\.mode === "move" && targetRoomId === null\) \{\s*onCancel\(\);\s*return;\s*\}/, "soltar fuera de toda fila cancela (no propone fechas)");
    const imports = hook.split("\n").filter((line) => /^import /.test(line));
    assert.equal(imports.length, 3);
    assert.ok(imports.some((line) => /from "react";$/.test(line)));
    assert.ok(imports.some((line) => /from "\.\.\/\.\.\/screens\/timeline\/timeline-engine";$/.test(line)));
    assert.ok(imports.some((line) => /from "\.\/timeline-presentation";$/.test(line)));
    assert.doesNotMatch(hook, /from "\.\.\/cocoa"|from "\.\/Timeline/, "sin barrel Cocoa ni componentes React");
  });
});
