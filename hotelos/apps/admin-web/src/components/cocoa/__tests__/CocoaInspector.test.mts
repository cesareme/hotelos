// Tanda UX-1 · U4 · CocoaInspector (docs/design/UX-RECEPCION-FEEL.md §4
// «Inspector lateral», F26, §7.1 2.4.3 / 2.4.11): panel derecho NO modal,
// Esc cierra y el foco vuelve a la fila, 360–420 px, apila bajo la tabla < 900.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaInspector, CocoaInspectorLayout, INSPECTOR_STACK_BREAKPOINT, INSPECTOR_WIDTH, inspectorEscapeCloses, inspectorReturnFocusTarget, targetInsideModal } from "../CocoaInspector.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../CocoaInspector.tsx"), "utf8");
const cocoaCss = readFileSync(resolve(here, "../../../styles/cocoa-22.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const barrel = readFileSync(resolve(here, "../index.ts"), "utf8");

describe("CocoaInspector · no modal", () => {
  const html = renderToStaticMarkup(
    createElement(CocoaInspector, {
      open: true,
      title: "RES-00042",
      commands: createElement("button", { type: "button" }, "Check-in"),
      onClose: () => undefined,
      children: createElement("p", null, "Resumen")
    })
  );

  it("es un <aside role=complementary> con nombre, sin aria-modal, sin portal ni focus trap ni bloqueo de scroll", () => {
    assert.match(html, /^<aside[^>]*role="complementary"[^>]*aria-label="RES-00042"/);
    assert.doesNotMatch(html, /aria-modal/);
    assert.doesNotMatch(html, /role="dialog"/);
    assert.doesNotMatch(source, /useFocusTrap|useScrollLock|createPortal/);
    assert.doesNotMatch(source, /aria-modal=(?:\{|"[^"]*"(?!\]))/, "nunca se declara modal (la cadena solo aparece en el selector CSS de targetInsideModal)");
    assert.match(html, /data-cocoa="inspector"/);
    assert.match(html, /data-open="true"/);
    assert.match(html, /data-width="md"/);
  });
  it("cabecera con título, barra de comandos como toolbar y «Cerrar»; el cuerpo lleva el contenido", () => {
    assert.match(html, /<h2[^>]*class="c22-inspector__title"[^>]*>RES-00042<\/h2>/);
    assert.match(html, /<div class="c22-inspector__commands" role="toolbar" aria-label="Acciones"><button type="button">Check-in<\/button><\/div>/);
    assert.match(html, /aria-label="Cerrar"/);
    assert.match(html, /<div class="c22-inspector__body"><p>Resumen<\/p><\/div>/);
  });
  it("aria-label explícito gana al título; cerrado no pinta nada; sin estilos inline", () => {
    const named = renderToStaticMarkup(createElement(CocoaInspector, { open: true, title: "RES-1", "aria-label": "Detalle de la reserva", onClose: () => undefined, children: "x" }));
    assert.match(named, /aria-label="Detalle de la reserva"/);
    assert.equal(renderToStaticMarkup(createElement(CocoaInspector, { open: false, title: "RES-1", onClose: () => undefined, children: "x" })), "");
    assert.doesNotMatch(source, /style=\{/);
  });
});

describe("CocoaInspector · Esc y retorno del foco (puro)", () => {
  it("Esc cierra salvo dentro de un diálogo/drawer modal o si alguien ya lo consumió", () => {
    assert.equal(inspectorEscapeCloses({ key: "Escape", insideModal: false }), true);
    assert.equal(inspectorEscapeCloses({ key: "Escape", insideModal: true }), false);
    assert.equal(inspectorEscapeCloses({ key: "Escape", defaultPrevented: true, insideModal: false }), false);
    assert.equal(inspectorEscapeCloses({ key: "Enter", insideModal: false }), false);
  });
  it("targetInsideModal mira role=dialog / alertdialog / aria-modal a través de closest()", () => {
    const inside = { closest: (selector: string) => (selector.includes('[role="dialog"]') ? {} : null) };
    assert.equal(targetInsideModal(inside), true);
    assert.equal(targetInsideModal({ closest: () => null }), false);
    assert.equal(targetInsideModal(null), false);
    assert.equal(targetInsideModal({}), false);
  });
  it("el foco vuelve a la fila indicada, si no al elemento que lo abrió, nunca a un nodo fuera del documento", () => {
    const row = { isConnected: true };
    const opener = { isConnected: true };
    assert.equal(inspectorReturnFocusTarget({ preferred: row, opener }), row);
    assert.equal(inspectorReturnFocusTarget({ preferred: null, opener }), opener);
    assert.equal(inspectorReturnFocusTarget({ preferred: { isConnected: false }, opener }), opener);
    assert.equal(inspectorReturnFocusTarget({ preferred: undefined, opener: { isConnected: false } }), null);
  });
  it("el componente escucha Esc en el documento y devuelve el foco al cerrar", () => {
    assert.match(source, /document\.addEventListener\("keydown", handler\)/);
    assert.match(source, /inspectorEscapeCloses\(\{ key: event\.key, defaultPrevented: event\.defaultPrevented, insideModal: targetInsideModal\(event\.target\) \}\)/);
    assert.match(source, /inspectorReturnFocusTarget\(\{ preferred: returnFocusRef\.current\?\.\(\), opener: opener\.current \}\)/);
    assert.match(source, /focus\?\.\(\{ preventScroll: true \}\)/);
  });
});

describe("CocoaInspector · geometría (360–420 px, apila < 900)", () => {
  it("anchos y punto de apilado", () => {
    assert.deepEqual(INSPECTOR_WIDTH, { sm: 360, md: 420 });
    assert.equal(INSPECTOR_STACK_BREAKPOINT, 900);
  });
  it("la hoja fija 420 / 360 por data-width y apila en columna bajo 900 px", () => {
    assert.match(cocoaCss, /\.c22-inspector\[data-width="sm"\] \{ --c22-inspector-width: 360px; \}/);
    assert.match(cocoaCss, /\.c22-inspector\[data-width="md"\] \{ --c22-inspector-width: 420px; \}/);
    assert.match(cocoaCss, /@media \(max-width: 899px\) \{\s*\.c22-inspector-layout \{ flex-direction: column;[^}]*\}\s*\.c22-inspector \{ width: auto; position: static;/);
  });
  it("CocoaInspectorLayout envuelve [lista][inspector] y refleja open", () => {
    const html = renderToStaticMarkup(createElement(CocoaInspectorLayout, { open: true, children: [createElement("div", { key: "a" }, "tabla"), createElement("div", { key: "b" }, "panel")] }));
    assert.match(html, /^<div class="c22-inspector-layout" data-cocoa="inspector-layout" data-open="true"><div>tabla<\/div><div>panel<\/div><\/div>$/);
  });
  it("el barrel exporta el inspector", () => {
    assert.match(barrel, /export \* from "\.\/CocoaInspector";/);
  });
});
