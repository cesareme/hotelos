import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECEPTION_TASKS, RECEPTION_TASKS_STEP_TITLE, getTourById, receptionTaskLine, receptionTasksBody, tours } from "../guideContent.ts";
import { SHORTCUTS, shortcutById } from "../../../content/shortcuts-registry.ts";

// Tanda UX-1 · lote U5 (docs/design/UX-RECEPCION-FEEL.md §4 «Onboarding y
// descubribilidad», §8.2): la guía de recepción enumera las seis tareas del
// estudio con su atajo, y cada atajo citado existe en el registro único
// (content/shortcuts-registry.ts). Un atajo anunciado que no está cableado es
// regresión (plan §2.3).

const KEYS = new Set(SHORTCUTS.map((entry) => entry.keys));
// Cualquier «⌥X» / «⌘X» / «⌘⇧X» mencionado en un texto debe ser una tecla del registro.
const SHORTCUT_TOKEN = /[⌘⌥][^\s,.;:()]+/g;

function citedShortcuts(text: string): string[] {
  return Array.from(text.matchAll(SHORTCUT_TOKEN), (match) => match[0]);
}

describe("guide-content-contract · las seis tareas de recepción (§8.2) con su atajo", () => {
  it("son exactamente t1…t6 y cada id de atajo existe en el registro", () => {
    assert.deepEqual(RECEPTION_TASKS.map((task) => task.id), ["t1", "t2", "t3", "t4", "t5", "t6"]);
    for (const task of RECEPTION_TASKS) {
      assert.ok(task.shortcutIds.length >= 1, `${task.id}: sin atajo`);
      for (const id of task.shortcutIds) assert.ok(shortcutById(id), `${task.id}: atajo «${id}» no existe en shortcuts-registry.ts`);
      assert.ok(task.title.length >= 10 && task.title.length <= 60, `${task.id}: título de ${task.title.length} caracteres`);
    }
  });

  it("las líneas citan solo teclas del registro y cubren ⌥H, ⌥W, ⌥N, ⌘K e Intro", () => {
    const cited = new Set<string>();
    for (const task of RECEPTION_TASKS) {
      const line = receptionTaskLine(task);
      assert.ok(line.startsWith(`${task.title}: `), line);
      for (const token of citedShortcuts(line)) {
        assert.ok(KEYS.has(token), `${task.id} cita «${token}», que no está en el registro`);
        cited.add(token);
      }
    }
    for (const expected of ["⌥H", "⌥W", "⌥N", "⌘K"]) assert.ok(cited.has(expected), `falta ${expected}`);
    assert.ok(RECEPTION_TASKS.some((task) => task.shortcutIds.includes("global.enter")), "alguna tarea termina con Intro (F6)");
  });

  it("el paso «Seis tareas de mostrador» va segundo en el recorrido de Recepción y cabe en 400 caracteres", () => {
    const body = receptionTasksBody();
    assert.ok(body.length <= 400, `cuerpo de ${body.length} caracteres`);
    for (const task of RECEPTION_TASKS) assert.ok(body.includes(task.title), task.id);
    for (const token of citedShortcuts(body)) assert.ok(KEYS.has(token) || token === "⌥", `«${token}» no está en el registro`);
    const recepcion = getTourById("recepcion");
    assert.equal(recepcion.id, "recepcion");
    assert.equal(recepcion.steps[1]?.title, RECEPTION_TASKS_STEP_TITLE);
    assert.equal(recepcion.steps[1]?.center, true);
    assert.equal(recepcion.steps[1]?.body, body);
    assert.ok(recepcion.steps[0].body.includes("⌥H"), "la introducción de Recepción cita la navegación con ⌥");
  });

  it("ningún recorrido cita un atajo que no exista en el registro", () => {
    for (const tour of tours) {
      for (const step of tour.steps) {
        for (const token of citedShortcuts(step.body)) {
          assert.ok(KEYS.has(token) || token === "⌥", `${tour.id}/${step.title} cita «${token}»`);
        }
      }
    }
  });
});
