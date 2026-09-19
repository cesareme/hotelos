// Tanda UX-1 · U4 · toast con acción, pausa y foco no tapado
// (docs/design/UX-RECEPCION-FEEL.md §4 «Toast con acción / deshacer», F17, F29,
// §7.1 2.4.11). El store vive en components/Toast.tsx; el ítem y la pila en
// components/cocoa/CocoaToast.tsx.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CocoaToast, CocoaToastViewport, rectsIntersect, remainingAfterPause, toastStackObscures, toastTone, toastViewportStyle } from "../CocoaToast.tsx";
import { ACTION_DURATION, DEFAULT_DURATION, MAX_VISIBLE, createToastStore, toastAnnouncement, toastDuration, undoableToast } from "../../Toast.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const cocoaCss = readFileSync(resolve(here, "../../../styles/cocoa-22.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("CocoaToast · temporizador con pausa (F29)", () => {
  it("lo que queda tras una pausa = lo que quedaba − lo transcurrido, nunca < 0", () => {
    assert.equal(remainingAfterPause(4000, 1000, 2500), 2500);
    assert.equal(remainingAfterPause(4000, 1000, 1000), 4000);
    assert.equal(remainingAfterPause(4000, 1000, 9000), 0);
    assert.equal(remainingAfterPause(4000, 5000, 1000), 4000, "un reloj que retrocede no alarga el toast");
  });
  it("duración por defecto 4 s; con acción 8 s (P4); la explícita gana", () => {
    assert.equal(DEFAULT_DURATION, 4000);
    assert.equal(ACTION_DURATION, 8000);
    assert.equal(toastDuration(), 4000);
    assert.equal(toastDuration({ action: { label: "Deshacer", onAction: () => undefined } }), 8000);
    assert.equal(toastDuration({ duration: 1500, action: { label: "Deshacer", onAction: () => undefined } }), 1500);
    assert.equal(toastDuration({ duration: 0 }), 0);
  });
  it("máximo 3 visibles se mantiene", () => {
    assert.equal(MAX_VISIBLE, 3);
  });
});

describe("Toast · store: id, dismissToast, acción y anuncio", () => {
  it("showToast devuelve un id creciente y dismiss lo retira (idempotente)", () => {
    const store = createToastStore(() => undefined);
    const a = store.push("Habitación asignada");
    const b = store.push("Cargo añadido", { variant: "success" });
    assert.equal(typeof a, "number");
    assert.equal(b, a + 1);
    assert.deepEqual(
      store.getToasts().map((t) => t.id),
      [a, b]
    );
    store.dismiss(a);
    store.dismiss(a);
    assert.deepEqual(
      store.getToasts().map((t) => t.id),
      [b]
    );
  });
  it("la API antigua sigue igual: sin opciones → info, 4 s, pausa al pasar el ratón, sin acción ni anuncio", () => {
    const announced: string[] = [];
    const store = createToastStore((text) => announced.push(text));
    store.push("Guardado");
    const [record] = store.getToasts();
    assert.equal(record.variant, "info");
    assert.equal(record.duration, 4000);
    assert.equal(record.pauseOnHover, true);
    assert.equal(record.action, undefined);
    assert.equal(record.announced, false);
    assert.deepEqual(announced, []);
  });
  it("announce: true lee el mensaje; una cadena lee ese texto; error → assertive; el ítem queda marcado como anunciado", () => {
    const announced: Array<[string, string]> = [];
    const store = createToastStore((text, politeness) => announced.push([text, politeness]));
    store.push("Reserva movida a la 204", { announce: true, action: { label: "Deshacer", onAction: () => undefined } });
    store.push("No se pudo cobrar", { variant: "error", announce: "Error al cobrar: TPV sin conexión" });
    assert.deepEqual(announced, [
      ["Reserva movida a la 204", "polite"],
      ["Error al cobrar: TPV sin conexión", "assertive"]
    ]);
    assert.deepEqual(
      store.getToasts().map((t) => [t.announced, t.duration]),
      [
        [true, 8000],
        [true, 4000]
      ]
    );
    assert.equal(toastAnnouncement("x"), null);
    assert.equal(toastAnnouncement("x", { announce: true }), "x");
    assert.equal(toastAnnouncement("x", { announce: "y" }), "y");
  });
  it("con la región del shell montada TODO toast se anuncia una vez por ella y el ítem queda mudo (L-04, R5); announce: false lo silencia", () => {
    const announced: string[] = [];
    const store = createToastStore((text) => announced.push(text), () => true);
    store.push("Check-in de la 101 hecho", { variant: "success" });
    store.push("Solo visual", { announce: false });
    assert.deepEqual(announced, ["Check-in de la 101 hecho"]);
    assert.deepEqual(
      store.getToasts().map((t) => t.announced),
      [true, false]
    );
    assert.equal(toastAnnouncement("x", undefined, true), "x");
    assert.equal(toastAnnouncement("x", { announce: false }, true), null);
  });
  it("⌘Z global: el último toast visible con «Deshacer» (L-11 (a)); sin acción de deshacer, nada", () => {
    const store = createToastStore(() => undefined, () => false);
    store.push("Cargo añadido", { action: { label: "Deshacer", onAction: () => undefined } });
    const folio = store.push("Check-in hecho", { action: { label: "Ver ficha", onAction: () => undefined } });
    assert.equal(undoableToast(store.getToasts())?.message, "Cargo añadido");
    store.dismiss(folio);
    const later = store.push("Cambio de la 310 a la 311", { action: { label: "Deshacer", onAction: () => undefined } });
    assert.equal(undoableToast(store.getToasts())?.id, later, "el último gana");
    assert.equal(undoableToast([]), null);
  });
});

describe("CocoaToast · ítem con acción alcanzable por Tab", () => {
  const html = renderToStaticMarkup(createElement(CocoaToast, { id: 1, message: "Reserva movida a la 204", variant: "success", action: { label: "Deshacer", onAction: () => undefined }, onDismiss: () => undefined }));

  it("pinta un botón plain con la etiqueta, dentro del toast, sin tabindex negativo", () => {
    const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    assert.ok(button, `sin botón de acción en ${html}`);
    assert.match(button, /c22-toast__action/);
    assert.match(button, /Deshacer/);
    assert.doesNotMatch(button, /tabindex="-1"/);
    assert.match(html, /data-action="true"/);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /display:flex/);
    assert.match(html, /<div[^>]*tabindex="-1"/, "el contenedor no entra en el orden de Tab: solo el botón (L-21)");
  });
  it("sin acción sigue siendo un bloque simple (misma API que antes)", () => {
    const plain = renderToStaticMarkup(createElement(CocoaToast, { id: 2, message: "Guardado", onDismiss: () => undefined }));
    assert.doesNotMatch(plain, /<button/);
    assert.doesNotMatch(plain, /data-action/);
    assert.match(plain, /display:block/);
  });
  it("error → alert/assertive; anunciado por la región del shell → sin rol vivo (un solo anuncio, R5)", () => {
    const error = renderToStaticMarkup(createElement(CocoaToast, { id: 3, message: "Fallo", variant: "error", onDismiss: () => undefined }));
    assert.match(error, /role="alert"/);
    assert.match(error, /aria-live="assertive"/);
    const announced = renderToStaticMarkup(createElement(CocoaToast, { id: 4, message: "Fallo", variant: "error", announced: true, onDismiss: () => undefined }));
    assert.doesNotMatch(announced, /role="(alert|status)"/);
    assert.match(announced, /role="group"/, "anunciado: grupo con nombre accesible (4.1.2, UX1-REV-16)");
    assert.match(announced, /aria-label="Fallo"/);
    assert.match(announced, /aria-live="off"/);
    assert.match(announced, /data-announced="true"/);
  });
  it("el ítem cede Enter/Espacio al botón (solo cierra cuando la tecla llega al propio toast)", () => {
    const source = readFileSync(resolve(here, "../CocoaToast.tsx"), "utf8");
    assert.match(source, /if \(event\.target !== event\.currentTarget\) return;/);
    assert.match(source, /onMouseEnter=/);
    assert.match(source, /onFocus=/);
    assert.match(source, /remainingAfterPause\(remaining\.current/);
  });
});

describe("CocoaToastViewport · el foco nunca queda tapado (WCAG 2.4.11)", () => {
  it("rectsIntersect: solapamiento real, los bordes que se tocan no cuentan", () => {
    assert.equal(rectsIntersect({ top: 0, left: 0, right: 10, bottom: 10 }, { top: 5, left: 5, right: 15, bottom: 15 }), true);
    assert.equal(rectsIntersect({ top: 0, left: 0, right: 10, bottom: 10 }, { top: 10, left: 0, right: 10, bottom: 20 }), false);
    assert.equal(rectsIntersect({ top: 0, left: 0, right: 10, bottom: 10 }, { top: 20, left: 20, right: 30, bottom: 30 }), false);
  });
  it("toastStackObscures: solo una pila pintada sobre un elemento ajeno a ella", () => {
    const stack = { top: 700, left: 900, right: 1260, bottom: 780 };
    assert.equal(toastStackObscures({ stack, focused: { top: 720, left: 1000, right: 1100, bottom: 750 }, focusedInsideStack: false }), true);
    assert.equal(toastStackObscures({ stack, focused: { top: 720, left: 1000, right: 1100, bottom: 750 }, focusedInsideStack: true }), false, "el botón del propio toast no la desplaza");
    assert.equal(toastStackObscures({ stack, focused: { top: 100, left: 100, right: 200, bottom: 130 }, focusedInsideStack: false }), false);
    assert.equal(toastStackObscures({ stack: { top: 0, left: 0, right: 0, bottom: 0 }, focused: { top: 0, left: 0, right: 10, bottom: 10 }, focusedInsideStack: false }), false, "pila vacía");
    assert.equal(toastStackObscures({ stack: null, focused: null, focusedInsideStack: false }), false);
  });
  it("con avoidFocus la pila salta al borde opuesto: arriba a la derecha en escritorio, abajo en teléfono", () => {
    const desktop = toastViewportStyle(false, true);
    assert.equal(desktop.bottom, "auto");
    assert.match(String(desktop.top), /toolbar-height, 48px/);
    assert.equal(desktop.right, "var(--cocoa-space-5)");
    const phone = toastViewportStyle(true, true);
    assert.equal(phone.top, "auto");
    assert.match(String(phone.bottom), /safe-area-inset-bottom/);
    // Sin el flag, la posición de siempre (contrato del offset absoluto).
    assert.equal(toastViewportStyle(false).bottom, "var(--hotelos-toast-offset, 120px)");
    assert.equal(toastViewportStyle(true).bottom, "auto");
  });
  it("la pila anuncia el modo con data-avoid-focus y no lo lleva en reposo", () => {
    const html = renderToStaticMarkup(createElement(CocoaToastViewport, { children: createElement("span", null, "x") }));
    assert.match(html, /data-cocoa="toast-stack"/);
    assert.doesNotMatch(html, /data-avoid-focus/);
    const source = readFileSync(resolve(here, "../CocoaToast.tsx"), "utf8");
    assert.match(source, /document\.addEventListener\("focusin", check\)/);
  });
  it("tonos como siempre (error → danger)", () => {
    assert.equal(toastTone("error"), "danger");
    assert.equal(toastTone("success"), "success");
  });
  it("la hoja pinta la acción y la pausa", () => {
    assert.match(cocoaCss, /\.c22-toast__action \{/);
    assert.match(cocoaCss, /\.c22-toast\[data-paused="true"\]/);
  });
});
