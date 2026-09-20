// Router determinista del Asistente ehotelOS (FIX-1 · F8): las preguntas
// sugeridas de AssistantChatScreen enrutan a su herramienta aunque la keyword
// no aparezca como subcadena literal («¿Cuántas llegadas tengo hoy?» →
// tokens {llegadas, hoy}). Sin BD: solo se ejercita findToolsByKeyword.
// Run: cd apps/api && node --import tsx --test src/modules/assistant/__tests__/assistant-router.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASSISTANT_TOOLS, findToolsByKeyword, keywordMatchesQuestion, mentionsAnotherDate } from "../assistant.tools.js";

function route(question: string): string[] {
  return findToolsByKeyword(question).map((t) => t.name);
}

// Las 6 sugerencias de apps/admin-web/src/screens/assistant/AssistantChatScreen.tsx
// (SUGGESTED_QUESTIONS) y la herramienta que debe responder a cada una.
const SUGGESTED: Array<[string, string]> = [
  ["¿Cuántas llegadas tengo hoy?", "get_arrivals_today"],
  ["¿Cuál es la ocupación ahora mismo?", "get_occupancy_today"],
  ["Dame el pickup de los últimos 7 días", "get_pickup_7d"],
  ["¿Qué saldo pendiente hay por cobrar?", "get_open_balance"],
  ["Estado de pisos hoy", "get_housekeeping_status"],
  ["Resumen de cumplimiento normativo", "get_compliance_summary"]
];

describe("assistant · findToolsByKeyword", () => {
  for (const [question, expected] of SUGGESTED) {
    it(`sugerencia «${question}» → ${expected} (y solo esa)`, () => {
      assert.deepEqual(route(question), [expected]);
    });
  }

  it("«¿cuántas salidas tengo hoy?» → get_departures_today", () => {
    assert.deepEqual(route("¿cuántas salidas tengo hoy?"), ["get_departures_today"]);
  });

  it("variantes de llegadas: orden distinto, sin signos, mayúsculas", () => {
    assert.deepEqual(route("HOY, ¿QUÉ LLEGADAS HAY?"), ["get_arrivals_today"]);
    assert.deepEqual(route("llegan hoy muchos clientes"), ["get_arrivals_today"]);
    assert.deepEqual(route("hay check-in hoy"), ["get_arrivals_today"]);
  });

  it("«hola» → [] (ninguna herramienta)", () => {
    assert.deepEqual(route("hola"), []);
  });

  it("corrector FIX-1 (F8): una pregunta con otra fecha no enruta a las herramientas «de hoy»; sin fecha, «cuántas llegadas» sí", () => {
    assert.deepEqual(route("¿Qué llegadas hay mañana?"), [], "mañana no es hoy");
    assert.deepEqual(route("llegadas de la semana que viene"), []);
    assert.deepEqual(route("¿cuántas salidas tengo el lunes?"), []);
    assert.deepEqual(route("salidas del 24/12"), []);
    assert.deepEqual(route("llegadas de hoy y de mañana"), [], "mezcla de fechas: tampoco");
    assert.deepEqual(route("¿Cuántas llegadas tengo?"), ["get_arrivals_today"], "sin fecha, hoy por defecto");
    assert.deepEqual(route("¿Cuántas salidas hay?"), ["get_departures_today"]);
    assert.deepEqual(route("llegadas"), [], "la palabra sola ya no enruta");
    assert.equal(mentionsAnotherDate("¿Cuántas llegadas tengo hoy?"), false);
    assert.equal(mentionsAnotherDate("Estado de pisos hoy"), false);
    assert.equal(mentionsAnotherDate("ocupación del próximo fin de semana"), true);
  });

  it("una palabra genérica sola («hoy», «ahora») no enruta a nada", () => {
    assert.deepEqual(route("¿Qué tengo hoy?"), []);
    assert.deepEqual(route("ahora mismo"), []);
  });

  it("ninguna pregunta enruta a más de 2 herramientas", () => {
    const questions = [
      ...SUGGESTED.map(([q]) => q),
      "¿cuántas salidas tengo hoy?",
      "hola",
      "llegadas y salidas de hoy"
    ];
    for (const q of questions) {
      assert.ok(route(q).length <= 2, `«${q}» enruta a ${route(q).length} herramientas: ${route(q).join(", ")}`);
    }
  });

  it("el catálogo no contiene keywords de un solo token genérico", () => {
    const generic = new Set(["hoy", "ahora", "hotel", "hay", "tengo", "cuantas", "cuantos", "que", "el", "la", "de", "en"]);
    for (const tool of ASSISTANT_TOOLS) {
      for (const kw of tool.keywords) {
        const tokens = kw
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .split(/\s+/)
          .filter(Boolean);
        assert.ok(tokens.length >= 1, `${tool.name}: keyword vacía`);
        if (tokens.length === 1) {
          assert.ok(!generic.has(tokens[0]), `${tool.name}: keyword genérica «${kw}» enrutaría cualquier pregunta`);
        }
      }
    }
  });
});

describe("assistant · keywordMatchesQuestion", () => {
  it("keyword de un token: subcadena del texto normalizado (plurales, acentos)", () => {
    assert.equal(keywordMatchesQuestion("ocupación", "¿Cuál es la ocupacion ahora mismo?"), true);
    assert.equal(keywordMatchesQuestion("pisos", "Estado de pisos hoy"), true);
    assert.equal(keywordMatchesQuestion("in-house", "¿cuántos in-house tengo?"), true);
    assert.equal(keywordMatchesQuestion("pisos", "los pisotones de ayer"), false);
  });

  it("keyword de varios tokens: todas las palabras completas, en cualquier orden", () => {
    assert.equal(keywordMatchesQuestion("llegadas hoy", "¿Cuántas llegadas tengo hoy?"), true);
    assert.equal(keywordMatchesQuestion("llegadas hoy", "hoy: llegadas"), true);
    assert.equal(keywordMatchesQuestion("check-in hoy", "¿hay check-in hoy?"), true);
    // Palabras completas, no subcadenas: «llegada» ≠ «llegadas», «checkin» ≠ «check-in».
    assert.equal(keywordMatchesQuestion("llegadas hoy", "la llegada de hoy"), false);
    assert.equal(keywordMatchesQuestion("check-in hoy", "checkin hoy"), false);
    assert.equal(keywordMatchesQuestion("llegadas hoy", "llegadas de mañana"), false);
  });

  it("keyword vacía o solo signos no coincide nunca", () => {
    assert.equal(keywordMatchesQuestion("", "hoy"), false);
    assert.equal(keywordMatchesQuestion("¿?", "hoy"), false);
  });
});
