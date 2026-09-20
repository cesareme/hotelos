// Tanda UX-1 · U4 · CocoaUndoBar (docs/design/UX-RECEPCION-FEEL.md §4
// «CocoaUndoBar», P4, R15): generalización de TimelineUndoBar (Tanda TL ·
// TL-2). Los asserts sobre el fuente que vivían en
// components/timeline/__tests__/timeline-presentation.test.mts se mueven aquí.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaUndoBar, DEFAULT_UNDO_SECONDS, UNDO_LABEL, isApplePlatform, isEditableTarget, isUndoShortcut, undoHint, undoShortcutLabel } from "../CocoaUndoBar.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../CocoaUndoBar.tsx"), "utf8");
const shim = readFileSync(resolve(here, "../../timeline/TimelineUndoBar.tsx"), "utf8");
const screen = readFileSync(resolve(here, "../../../screens/timeline/LiveTimeline.tsx"), "utf8");
const barrel = readFileSync(resolve(here, "../index.ts"), "utf8");

describe("CocoaUndoBar · copy y atajo (puro)", () => {
  it("undoHint nombra la reserva y nunca baja de 0 s; sin código, frase genérica", () => {
    assert.equal(undoHint("ABC123", 8), "Se puede deshacer el cambio en la reserva ABC123 durante 8 s");
    assert.equal(undoHint("ABC123", -3), "Se puede deshacer el cambio en la reserva ABC123 durante 0 s");
    assert.equal(undoHint(undefined, 5), "Se puede deshacer durante 5 s");
  });
  it("⌘Z / Ctrl+Z, nunca con Shift (rehacer) ni Alt", () => {
    assert.equal(isUndoShortcut({ key: "z", metaKey: true, ctrlKey: false }), true);
    assert.equal(isUndoShortcut({ key: "Z", metaKey: false, ctrlKey: true }), true);
    assert.equal(isUndoShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: true }), false);
    assert.equal(isUndoShortcut({ key: "z", metaKey: false, ctrlKey: false }), false);
    assert.equal(isUndoShortcut({ key: "a", metaKey: true, ctrlKey: false }), false);
  });
  it("un campo de texto conserva su propio ⌘Z", () => {
    assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
    assert.equal(isEditableTarget({ tagName: "textarea" }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isEditableTarget({ tagName: "BUTTON" }), false);
    assert.equal(isEditableTarget(null), false);
  });
  it("el chip dice ⌘Z en Apple y Ctrl+Z en el resto", () => {
    assert.equal(undoShortcutLabel(true), "⌘Z");
    assert.equal(undoShortcutLabel(false), "Ctrl+Z");
    assert.equal(isApplePlatform({ platform: "MacIntel" }), true);
    assert.equal(isApplePlatform({ platform: "", userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" }), true);
    assert.equal(isApplePlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" }), false);
    assert.equal(isApplePlatform(null), false);
  });
  it("8 s por defecto y «Deshacer»", () => {
    assert.equal(DEFAULT_UNDO_SECONDS, 8);
    assert.equal(UNDO_LABEL, "Deshacer");
  });
});

describe("CocoaUndoBar · markup", () => {
  const entry = { label: "Reserva ABC123 movida a la 204", code: "ABC123", note: "No revierte el traslado en casa" };
  const html = renderToStaticMarkup(createElement(CocoaUndoBar, { entry, onUndo: () => undefined, onDismiss: () => undefined }));

  it("un solo role=status (la barra ES el anuncio), título, cuenta atrás y nota honesta", () => {
    assert.equal((html.match(/role="status"/g) ?? []).length, 1, html);
    assert.match(html, /Reserva ABC123 movida a la 204/);
    assert.match(html, /Se puede deshacer el cambio en la reserva ABC123 durante 8 s · No revierte el traslado en casa/);
    assert.match(html, /<span aria-hidden="true">Se puede deshacer/, "la cuenta atrás no se re-anuncia cada segundo (UX1-REV-09)");
    assert.match(source, /if \(!entry \|\| paused\) return undefined;/, "el temporizador se pausa con hover / foco");
    assert.match(html, /c22-undo-bar/);
    assert.match(html, /data-tone="success"/);
  });
  it("«Deshacer» con el CocoaKbd del atajo visible y «Cerrar»", () => {
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 2, html);
    assert.match(buttons[0], /Deshacer/);
    assert.match(buttons[0], /<kbd[^>]*class="c22-kbd cocoa-kbd"[^>]*>(⌘Z|Ctrl\+Z)<\/kbd>/);
    assert.match(buttons[0], /c22-undo-bar__undo/);
    assert.match(buttons[1], /aria-label="Cerrar"/);
  });
  it("hint propio sustituye a la cuenta atrás; sin entrada no pinta nada", () => {
    const custom = renderToStaticMarkup(createElement(CocoaUndoBar, { entry: { label: "Cargo añadido", hint: "Se puede deshacer hasta el cierre" }, onUndo: () => undefined, onDismiss: () => undefined }));
    assert.match(custom, /Se puede deshacer hasta el cierre/);
    assert.doesNotMatch(custom, /durante/);
    assert.equal(renderToStaticMarkup(createElement(CocoaUndoBar, { entry: null, onUndo: () => undefined, onDismiss: () => undefined })), "");
  });
});

describe("CocoaUndoBar · fuente (asserts heredados de TimelineUndoBar) y cableado", () => {
  it("role=status, clearInterval, seconds = DEFAULT_UNDO_SECONDS, entry.note, ⌘Z global sin estilos inline ni anuncio duplicado", () => {
    assert.match(source, /role="status"/);
    assert.match(source, /clearInterval/);
    assert.match(source, /seconds = DEFAULT_UNDO_SECONDS/);
    assert.match(source, /entry\.note/, "la barra muestra la nota honesta del traslado en casa");
    assert.match(source, /window\.addEventListener\("keydown", handler\)/);
    assert.match(source, /isUndoShortcut\(event\)/);
    assert.doesNotMatch(source, /style=\{/);
    assert.doesNotMatch(source, /\bannounce\(/, "la barra no repite el mensaje en la región viva (un solo status)");
    assert.doesNotMatch(source, />\s*(?:Undo|Close|Today|Previous|Next|Loading|Clear filters|Room)\s*</, "textos en español");
  });
  it("una sola entrada viva: la nueva sustituye a la anterior, reinicia la cuenta atrás y levanta la pausa (R15, UX2-REV-04)", () => {
    // La pausa por hover no puede sobrevivir a la entrada: al pulsar «Deshacer» la barra se desmonta bajo el puntero sin mouseleave.
    assert.match(source, /if \(entry !== tracked\) \{\s*setTracked\(entry\);\s*setLeft\(seconds\);\s*if \(paused\) setPaused\(false\);\s*\}/);
    assert.ok(source.indexOf("const [paused, setPaused] = useState(false);") < source.indexOf("if (entry !== tracked) {"), "la pausa se declara antes del reinicio");
  });
  it("TimelineUndoBar es un reexport de una línea desde el barrel; el Live Timeline monta CocoaUndoBar; el barrel la exporta", () => {
    const lines = shim.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
    assert.equal(lines.length, 1, shim);
    assert.match(lines[0], /export \{ CocoaUndoBar as TimelineUndoBar[^}]*\} from "\.\.\/cocoa";/);
    assert.match(screen, /<CocoaUndoBar entry=\{undo\} onUndo=\{onUndo\} onDismiss=\{dismissUndo\} \/>/);
    assert.doesNotMatch(screen, /<TimelineUndoBar/);
    assert.match(barrel, /export \* from "\.\/CocoaUndoBar";/);
  });
});
