// Tanda UX-1 · lote U1 · lib/ux-trace.ts (docs/design/UX-RECEPCION-FEEL.md §6.4 y §8.4 modo C):
// sin PII (ni valores de campos, ni caracteres tecleados, ni query strings),
// exportación JSON con sessionId/taskId y avance de tarea (⌘⇧T → nextTask).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createIndexedDbStore,
  createMemoryStore,
  createUxTrace,
  breadcrumbData,
  describeElement,
  scrubLabel,
  describeKey,
  newSessionId,
  nextTaskId,
  sanitizePath,
  type UxTraceEvent
} from "../ux-trace.ts";

type FakeElement = {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  parent?: FakeElement;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeElement | null;
};

function fakeElement(tagName: string, attributes: Record<string, string> = {}, textContent = "", parent?: FakeElement): FakeElement {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    attributes,
    textContent,
    parent,
    getAttribute: (name) => attributes[name] ?? null,
    closest(selector) {
      const wanted = new Set(
        selector
          .split(",")
          .map((s) => s.trim())
          .map((s) => (s.startsWith("[role=") ? `role:${s.slice(7, -2)}` : `tag:${s.toUpperCase()}`))
      );
      let current: FakeElement | undefined = el;
      while (current) {
        if (wanted.has(`tag:${current.tagName}`) || (current.attributes.role && wanted.has(`role:${current.attributes.role}`))) return current;
        current = current.parent;
      }
      return null;
    }
  };
  return el;
}

describe("ux-trace · identificadores y normalización", () => {
  it("genera sessionId estable por reloj y avanza la tarea T1 → T2", () => {
    assert.match(newSessionId(1_700_000_000_000), /^ux-[a-z0-9]+-[a-z0-9]{4}$/);
    assert.equal(nextTaskId("T1"), "T2");
    assert.equal(nextTaskId("t5"), "T6");
    assert.equal(nextTaskId(""), "T1");
    assert.equal(nextTaskId("baseline"), "T1");
  });

  it("quita origen y query de las rutas (la query puede llevar lo buscado)", () => {
    assert.deepEqual(sanitizePath("http://127.0.0.1:3913/search?q=Zeta&limit=8"), { path: "/search", hasQuery: true });
    assert.deepEqual(sanitizePath("/reservations/res_uxday_t6/folio"), { path: "/reservations/res_uxday_t6/folio", hasQuery: false });
    assert.deepEqual(sanitizePath("https://demo.ehotelos.com/api/hoy#x"), { path: "/api/hoy", hasQuery: false });
  });

  it("nunca guarda el carácter tecleado: cualquier imprimible es «char»", () => {
    assert.equal(describeKey({ key: "Z" }), "char");
    assert.equal(describeKey({ key: "7" }), "char");
    assert.equal(describeKey({ key: "Enter" }), "Enter");
    assert.equal(describeKey({ key: "k", metaKey: true }), "Meta+k");
    assert.equal(describeKey({ key: "T", metaKey: true, shiftKey: true }), "Meta+Shift+t");
    assert.equal(describeKey({ key: " " }), "Space");
    assert.equal(describeKey({ key: "Escape", ctrlKey: true }), "Ctrl+Escape");
  });

  it("describe el control pulsado por su etiqueta, nunca por el valor del campo ni el texto de la fila", () => {
    const button = fakeElement("button", { id: "btn-checkin" }, "  Hacer\n check-in ");
    const icon = fakeElement("svg", {}, "", button);
    assert.deepEqual(describeElement(icon), { tag: "button", id: "btn-checkin", name: "Hacer check-in" });

    const input = fakeElement("input", { "aria-label": "Número de documento", type: "text", value: "12345678Z" }, "12345678Z");
    const described = describeElement(input);
    assert.equal(described.name, "Número de documento");
    assert.equal(described.role, "text");
    assert.ok(!JSON.stringify(described).includes("12345678Z"), "el valor del campo no se guarda");

    const cell = fakeElement("td", {}, "Ana Alfa · 204 · 120,00 €");
    assert.deepEqual(describeElement(cell), { tag: "td" });

    const longLabel = fakeElement("a", { "aria-label": "x".repeat(80) }, "");
    assert.equal(describeElement(longLabel).name?.length, 48);
    assert.deepEqual(describeElement(null), { tag: "unknown" });
  });

  it("R1 / UX1-REV-07: ni una opción de ⌘K, ni una barra del cronograma, ni una fila-tarjeta guardan su texto; los botones se recortan antes del nombre", () => {
    const option = fakeElement("div", { role: "option", id: "cmdk-hit_reservation_res_uxday_t6" }, "UXDAY-T6 checked_in Clara Zeta · 2026-09-18 → 2026-09-20 · direct");
    const optionText = fakeElement("span", {}, "Clara Zeta", option);
    assert.deepEqual(describeElement(optionText), { tag: "div", role: "option", id: "cmdk-hit_reservation_res_uxday_t6" });
    const bar = fakeElement("div", { role: "button", "aria-label": "Reserva RES-00046 de Contacto Corporativo, Confirmada", "data-testid": "tl-bar" }, "RES-00046");
    assert.deepEqual(describeElement(bar), { tag: "div", role: "button", testId: "tl-bar" });
    const link = fakeElement("div", { role: "link", "aria-label": "Ficha de Ana Alfa" }, "");
    assert.deepEqual(describeElement(link), { tag: "div", role: "link" });
    const more = fakeElement("button", { "aria-label": "Más acciones de Ana Alfa" }, "⋯");
    assert.equal(describeElement(more).name, "Más acciones");
    const inspectorClose = fakeElement("button", { title: "Cerrar: detalle de Ana Alfa" }, "");
    assert.equal(describeElement(inspectorClose).name, "Cerrar");
    assert.equal(describeElement(fakeElement("button", {}, "Cobrar 120,00 € y cerrar")).name, "Cobrar 120,00 € y cerrar");
    assert.equal(describeElement(fakeElement("button", {}, "Check-out de 2 con saldo 0")).name, "Check-out");
    assert.equal(scrubLabel("Reserva RES-1 de Ana Alfa"), "Reserva RES-1");
    assert.equal(scrubLabel("  "), undefined);
    for (const element of [option, optionText, bar, link, more]) {
      assert.ok(!JSON.stringify(describeElement(element)).includes("Alfa") && !JSON.stringify(describeElement(element)).includes("Zeta"), "ningún nombre en la descripción");
    }
    assert.deepEqual(breadcrumbData({ screen: "/hoy", target: { tag: "button", id: "b1", name: "Hacer check-in" } }), { screen: "/hoy", target: { tag: "button", id: "b1" } }, "el breadcrumb de Sentry nunca lleva la etiqueta");
    assert.deepEqual(breadcrumbData({ key: "char" }), { key: "char" });
  });
});

describe("ux-trace · trazador", () => {
  function collect() {
    const crumbs: Array<{ message: string; category: string; data?: Record<string, unknown> }> = [];
    let clock = 10_000;
    const trace = createUxTrace({
      sessionId: "ux-test",
      store: createMemoryStore(),
      breadcrumb: (message, category, data) => crumbs.push({ message, category, data }),
      now: () => (clock += 100),
      perf: { mark: () => undefined }
    });
    return { trace, crumbs };
  }

  it("registra eventos con sessionId/taskId, los pasa por el breadcrumb y exporta JSON", async () => {
    const { trace, crumbs } = collect();
    trace.record("click", { screen: "/hoy", target: { tag: "button", name: "Hacer check-in" } });
    trace.record("fetch:start", { reqId: 1, method: "POST", path: "/reservations/res_uxday_t1/check-in", hasQuery: false });
    const exported = JSON.parse(await trace.exportJson()) as { version: number; sessionId: string; taskId: string; events: UxTraceEvent[] };
    assert.equal(exported.version, 1);
    assert.equal(exported.sessionId, "ux-test");
    assert.equal(exported.taskId, "T1");
    assert.deepEqual(
      exported.events.map((e) => e.kind),
      ["session", "click", "fetch:start"]
    );
    assert.ok(exported.events.every((e) => e.sessionId === "ux-test" && e.taskId === "T1" && typeof e.t === "number"));
    assert.deepEqual(
      crumbs.map((c) => [c.message, c.category]),
      [
        ["ux.session", "ui"],
        ["ux.click", "ui"],
        ["ux.fetch:start", "api"]
      ]
    );
    assert.equal(crumbs[1]?.data?.taskId, "T1");
  });

  it("nextTask avanza T1 → T2 y los eventos posteriores llevan la nueva tarea", async () => {
    const { trace } = collect();
    assert.equal(trace.nextTask(), "T2");
    trace.mark("hoy", "row-open");
    const events = await trace.events();
    const last = events[events.length - 1]!;
    assert.equal(last.kind, "mark");
    assert.equal(last.taskId, "T2");
    assert.equal(last.data.name, "ui:hoy:row-open");
    assert.equal(events.find((e) => e.kind === "task")?.data.taskId, "T2");
    trace.setTask("T5");
    assert.equal(trace.taskId, "T5");
    assert.equal(trace.nextTask(), "T6");
  });

  it("la exportación no contiene PII aunque el registro reciba un texto tecleado por error", async () => {
    const { trace } = collect();
    trace.record("keydown", { key: describeKey({ key: "Z" }), inField: true });
    trace.record("route", { from: "/hoy", to: sanitizePath("/recepcion/reservas/res_uxday_t6?q=Zeta").path });
    const json = await trace.exportJson();
    assert.ok(!json.includes("Zeta"), "ni el apellido buscado ni la query se exportan");
    assert.ok(json.includes('"key": "char"'));
  });

  it("sin IndexedDB cae a memoria y sigue exportando", async () => {
    const store = createIndexedDbStore("hotelos-ux-trace-test", "events", undefined);
    const trace = createUxTrace({ sessionId: "ux-mem", store, perf: { mark: () => undefined } });
    trace.record("click", { screen: "/hoy" });
    const events = await trace.events();
    assert.equal(events.length, 2);
    await trace.clear();
    assert.equal((await trace.events()).length, 0);
  });
});
