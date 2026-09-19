// Tanda UX-1 · U4 · foco en main tras navegar + una sola región viva
// (docs/design/UX-RECEPCION-FEEL.md §4 «Foco y anuncio», §7.1 2.4.3 / 4.1.3,
// R5). La lógica pura vive en components/cocoa/CocoaLiveRegion.tsx
// (BackOfficeLayout.tsx no se importa bajo node: `import.meta.env`), y el
// cableado del shell se comprueba sobre el fuente.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaShellLiveRegion, SHELL_MAIN_ID, SKIP_LINK_LABEL, createAnnouncer, focusTargetAfterNavigate } from "../../components/cocoa/CocoaLiveRegion.tsx";
import { CocoaToast } from "../../components/cocoa/CocoaToast.tsx";
import { CocoaUndoBar } from "../../components/cocoa/CocoaUndoBar.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const layout = readFileSync(resolve(here, "../BackOfficeLayout.tsx"), "utf8");
const provider = readFileSync(resolve(here, "../../providers/CocoaGlobalProvider.tsx"), "utf8");
const cocoaCss = readFileSync(resolve(here, "../../styles/cocoa-22.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("focusTargetAfterNavigate · qué elemento recibe el foco (puro)", () => {
  it("main cuando cambia la pantalla activa", () => {
    assert.equal(focusTargetAfterNavigate({ previousScreen: "FrontDeskDashboard", nextScreen: "ReservationsListScreen" }), "main");
  });
  it("nada en el primer pintado (deep link: el documento conserva su foco) ni cuando la pantalla no cambia", () => {
    assert.equal(focusTargetAfterNavigate({ previousScreen: null, nextScreen: "FrontDeskDashboard" }), null);
    assert.equal(focusTargetAfterNavigate({ previousScreen: undefined, nextScreen: "FrontDeskDashboard" }), null);
    assert.equal(focusTargetAfterNavigate({ previousScreen: "FrontDeskDashboard", nextScreen: "FrontDeskDashboard" }), null);
    assert.equal(focusTargetAfterNavigate({ previousScreen: "FrontDeskDashboard", nextScreen: "" }), null);
  });
});

describe("BackOfficeLayout · skip link, main enfocable y una región viva (fuente)", () => {
  it("«Saltar al contenido» es el primer hijo del shell y apunta al main", () => {
    assert.equal(SHELL_MAIN_ID, "cocoa-main");
    assert.equal(SKIP_LINK_LABEL, "Saltar al contenido");
    const shellStart = layout.indexOf('<div className="cocoa-shell" data-route-base="/backoffice">');
    const skip = layout.indexOf('className="c22-skip-link"', shellStart);
    const toolbar = layout.indexOf("<CompactToolbar", shellStart);
    assert.ok(shellStart >= 0 && skip > shellStart && skip < toolbar, "el skip link va antes de la toolbar");
    assert.match(layout, /href=\{`#\$\{SHELL_MAIN_ID\}`\}/);
    assert.match(layout, /\{SKIP_LINK_LABEL\}/);
    assert.match(layout, /<main id=\{SHELL_MAIN_ID\} ref=\{mainRef\} className="cocoa-content" tabIndex=\{-1\}>/);
  });
  it("el foco cae en main tras cada cambio de pantalla (hotelos-nav, popstate, ⌘K, sidebar)", () => {
    assert.match(layout, /const target = focusTargetAfterNavigate\(\{ previousScreen: previousScreen\.current, nextScreen: props\.activeScreen \}\);/);
    assert.match(layout, /if \(target === "main"\) mainRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
    assert.match(layout, /\}, \[props\.activeScreen\]\);/);
  });
  it("monta UNA CocoaShellLiveRegion y el proveedor expone announce()", () => {
    assert.equal((layout.match(/<CocoaShellLiveRegion \/>/g) ?? []).length, 1);
    assert.match(provider, /export function useCocoaAnnounce\(\)/);
    assert.match(provider, /announce: announceToShell/);
  });
  it("mutate({ announce, undo }) llega a la región viva y a un toast con «Deshacer» anunciado una vez", () => {
    assert.match(layout, /setMutationFeedback\(\{\s*announce: \(text\) => announce\(text\),\s*undo: \(entry\) => \{\s*showToast\(entry\.label, \{/);
    assert.match(layout, /action: entry\.onUndo \? \{ label: UNDO_LABEL, onAction: entry\.onUndo \} : undefined,\s*announce: true/);
    assert.match(layout, /return \(\) => setMutationFeedback\(\{\}\);/);
  });
  it("la hoja muestra el skip link solo con foco y no pinta anillo en main tras un clic", () => {
    assert.match(cocoaCss, /\.c22-skip-link \{[^}]*transform: translateY\(-200%\);[^}]*opacity: 0;/);
    assert.match(cocoaCss, /\.c22-skip-link:focus,\s*\.c22-skip-link:focus-visible \{[^}]*opacity: 1;/);
    assert.match(cocoaCss, /\.cocoa-content:focus \{ outline: none; \}/);
    assert.match(cocoaCss, /\.cocoa-content:focus-visible \{ outline: 2px solid var\(--cocoa-focus-ring\)/);
  });
});

describe("CocoaShellLiveRegion · una sola región, anuncios por el store", () => {
  it("el shell pinta exactamente un role=status polite, oculto visualmente, con id estable", () => {
    const html = renderToStaticMarkup(createElement(CocoaShellLiveRegion, {}));
    assert.equal((html.match(/role="status"/g) ?? []).length, 1, html);
    assert.match(html, /id="cocoa-live-region"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /aria-atomic="true"/);
    assert.match(html, /class="c22-live-region cocoa-sr-only"/);
  });
  it("announce() avisa a los suscriptores con clave creciente, ignora el texto vacío y recuerda el último", () => {
    const announcer = createAnnouncer();
    const received: Array<{ text: string; politeness: string; key: number }> = [];
    const off = announcer.subscribe((a) => received.push(a));
    assert.equal(announcer.announce("   "), null);
    const first = announcer.announce("Check-in hecho: habitación 204");
    const second = announcer.announce("Check-in hecho: habitación 204");
    const error = announcer.announce("No se pudo cobrar", "assertive");
    assert.ok(first && second && error);
    assert.ok(second.key > first.key, "el mismo texto dos veces se vuelve a anunciar");
    assert.equal(error.politeness, "assertive");
    assert.equal(received.length, 3);
    assert.equal(announcer.last()?.text, "No se pudo cobrar");
    off();
    announcer.announce("después de darse de baja");
    assert.equal(received.length, 3);
    assert.equal(announcer.listenerCount(), 0);
  });
  it("solo hay un role=status vivo: el toast anunciado calla y la barra de deshacer es el único anuncio de su cambio", () => {
    const shellPlusToast = renderToStaticMarkup(createElement("div", null, createElement(CocoaShellLiveRegion, {}), createElement(CocoaToast, { id: 1, message: "Reserva movida", announced: true, onDismiss: () => undefined })));
    assert.equal((shellPlusToast.match(/role="(status|alert)"/g) ?? []).length, 1, shellPlusToast);
    const undoBar = renderToStaticMarkup(createElement(CocoaUndoBar, { entry: { label: "Reserva movida", code: "ABC" }, onUndo: () => undefined, onDismiss: () => undefined }));
    assert.equal((undoBar.match(/role="status"/g) ?? []).length, 1);
    assert.doesNotMatch(readFileSync(resolve(here, "../../components/cocoa/CocoaUndoBar.tsx"), "utf8"), /\bannounce\(/);
  });
});
