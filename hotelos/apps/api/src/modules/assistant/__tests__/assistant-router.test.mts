// Router determinista del Asistente ehotelOS (FIX-1 · F8): las preguntas
// sugeridas de AssistantChatScreen enrutan a su herramienta aunque la keyword
// no aparezca como subcadena literal («¿Cuántas llegadas tengo hoy?» →
// tokens {llegadas, hoy}). Sin BD: solo se ejercita findToolsByKeyword.
// Tanda L6b (L6b-02): además routeByRules (assistant-router.ts) sobre el catálogo unificado
// (assistant-catalog.ts): las 19 preguntas sugeridas (6 del chat + 3 CHK + 10 presets del copiloto)
// enrutan a exactamente una herramienta, cada preset del copiloto → su intent, y el enrutado respeta
// el catálogo filtrado por RBAC.
// Run: cd apps/api && node --import tsx --test src/modules/assistant/__tests__/assistant-router.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_PERMISSION_MAP } from "@hotelos/shared";
import { COPILOT_PRESET_QUESTIONS, detectIntent } from "../../copilot/copilot.service.js";
import { ASSISTANT_CATALOG, catalogFor } from "../assistant-catalog.js";
import { ALL_SUGGESTED_QUESTIONS, ASSISTANT_SUGGESTED_QUESTIONS, CHECKIN_SUGGESTED_QUESTIONS, COPILOT_SUGGESTED_QUESTIONS, SUGGESTED_QUESTIONS, routeByRules, suggestedQuestionsFor } from "../assistant-router.js";
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

  it("corrector L6b (REV-06): «día de mes», ISO, dd-mm-aaaa, un mes del año y «pasado mañana» tampoco son hoy; las sugeridas siguen sin fecha", () => {
    assert.deepEqual(route("¿cuántas llegadas hubo el 15 de septiembre?"), [], "el 15 de septiembre no es hoy");
    assert.deepEqual(route("llegadas del 2026-09-15"), []);
    assert.deepEqual(route("salidas del 15-09-2026"), []);
    assert.deepEqual(route("¿Cuántas llegadas tengo en octubre?"), []);
    assert.deepEqual(route("¿Cuántas llegadas tengo pasado mañana?"), []);
    assert.deepEqual(route("¿Cuántas llegadas tengo el 1 de Enero de 2027?"), []);
    for (const question of ["¿cuántas llegadas hubo el 15 de septiembre?", "2026-09-15", "15-09-2026", "en octubre", "pasado mañana", "1 de Enero", "El 3 de Mayo"]) {
      assert.equal(mentionsAnotherDate(question), true, question);
    }
    for (const question of ["¿Cuántas llegadas tengo hoy?", "¿Cuál es la ocupación ahora mismo?", "Dame el pickup de los últimos 7 días", "¿Qué habitaciones están listas para entregar?", "habitación 15"]) {
      assert.equal(mentionsAnotherDate(question), false, question);
    }
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

// ---------------------------------------------------------------------------
// Tanda L6b (L6b-02): router por reglas sobre el catálogo unificado
// ---------------------------------------------------------------------------

function routeAll(question: string): string[] {
  return routeByRules(question, ASSISTANT_CATALOG).tools.map((tool) => tool.name);
}

describe("assistant-router · routeByRules", () => {
  it("las 19 sugeridas enrutan a exactamente una herramienta (la suya) y por reglas", () => {
    assert.equal(ALL_SUGGESTED_QUESTIONS.length, 19);
    assert.equal(new Set(ALL_SUGGESTED_QUESTIONS.map((suggestion) => suggestion.question)).size, 19, "sin preguntas repetidas");
    assert.equal(ASSISTANT_SUGGESTED_QUESTIONS.length, 6);
    assert.equal(CHECKIN_SUGGESTED_QUESTIONS.length, 3);
    assert.equal(COPILOT_SUGGESTED_QUESTIONS.length, 10);
    for (const suggestion of ALL_SUGGESTED_QUESTIONS) {
      const result = routeByRules(suggestion.question, ASSISTANT_CATALOG);
      assert.equal(result.routedBy, "rules");
      assert.deepEqual(result.tools.map((tool) => tool.name), [suggestion.tool], `«${suggestion.question}» → ${result.tools.map((tool) => tool.name).join(", ") || "∅"} (candidatas: ${result.candidates.map((candidate) => `${candidate.tool.name}:${candidate.score}`).join(" ")})`);
      assert.ok(ASSISTANT_CATALOG.some((tool) => tool.name === suggestion.tool), `${suggestion.tool} no está en el catálogo`);
    }
  });

  it("las 6 sugeridas del chat son las de AssistantChatScreen y siguen enrutando igual con el router histórico", () => {
    assert.deepEqual(ASSISTANT_SUGGESTED_QUESTIONS.map((suggestion) => [suggestion.question, suggestion.tool]), SUGGESTED);
    for (const [question, expected] of SUGGESTED) assert.deepEqual(route(question), [expected]);
  });

  it("cada preset del copiloto → su intent", () => {
    assert.equal(COPILOT_PRESET_QUESTIONS.length, 10);
    for (const preset of COPILOT_PRESET_QUESTIONS) {
      assert.equal(detectIntent(preset.question), preset.id, `«${preset.question}»`);
      assert.deepEqual(routeAll(preset.question), [`copilot_${preset.id}`]);
    }
    const copilotSuggested = new Map(COPILOT_SUGGESTED_QUESTIONS.map((suggestion) => [suggestion.question, suggestion.tool]));
    for (const preset of COPILOT_PRESET_QUESTIONS) assert.equal(copilotSuggested.get(preset.question), `copilot_${preset.id}`);
  });

  it("SUGGESTED_QUESTIONS por superficie: back office y recepción con las 19, huésped sin sugerencias de personal", () => {
    assert.equal(SUGGESTED_QUESTIONS.backoffice.length, 19);
    assert.equal(SUGGESTED_QUESTIONS.reception.length, 19);
    assert.deepEqual(SUGGESTED_QUESTIONS.guest, []);
    assert.equal(SUGGESTED_QUESTIONS.reception[0]!.tool, "copilot_shift_summary", "recepción empieza por los presets del copiloto");
    assert.equal(SUGGESTED_QUESTIONS.backoffice[0]!.tool, "get_arrivals_today", "back office empieza por las del chat");
  });

  it("suggestedQuestionsFor y routeByRules respetan el catálogo filtrado: contable sin pisos", () => {
    const accountant = catalogFor({ permissions: ROLE_PERMISSION_MAP.accountant, surface: "backoffice" });
    const suggested = suggestedQuestionsFor("backoffice", accountant);
    assert.ok(!suggested.some((suggestion) => suggestion.question === "Estado de pisos hoy"), "no se sugiere lo que no puede responder");
    assert.ok(suggested.some((suggestion) => suggestion.tool === "get_open_balance"));
    assert.deepEqual(routeByRules("Estado de pisos hoy", accountant).tools, []);
    assert.deepEqual(routeByRules("¿Qué tareas de housekeeping están retrasadas?", accountant).tools, []);
    const reception = catalogFor({ permissions: ROLE_PERMISSION_MAP.receptionist, surface: "reception" });
    assert.equal(suggestedQuestionsFor("reception", reception).length, 19, "recepción responde las 19 por reglas");
    for (const suggestion of suggestedQuestionsFor("reception", reception)) assert.deepEqual(routeByRules(suggestion.question, reception).tools.map((tool) => tool.name), [suggestion.tool]);
  });

  it("otra fecha descarta las lecturas de hoy, también las del copiloto acotadas a hoy; las no acotadas siguen", () => {
    assert.deepEqual(routeAll("¿Qué llegadas hay mañana?"), []);
    assert.deepEqual(routeAll("¿Qué VIPs llegan mañana?"), []);
    assert.deepEqual(routeAll("resume el turno de ayer"), []);
    assert.deepEqual(routeAll("¿Qué habitaciones están bloqueadas desde la semana pasada?"), ["copilot_rooms_blocked"]);
    const result = routeByRules("¿Qué VIPs llegan mañana?", ASSISTANT_CATALOG);
    assert.equal(result.anotherDate, true);
    assert.equal(result.intent, "vips_arriving", "detectIntent reconoce la intención pero la fecha la descarta");
  });

  it("sujetos distintos componen; el mismo sujeto se resuelve por especificidad (una sola del copiloto por pregunta)", () => {
    assert.deepEqual(routeAll("llegadas y salidas de hoy"), ["get_arrivals_today", "get_departures_today"]);
    const balance = routeByRules("¿Qué saldo pendiente hay por cobrar?", ASSISTANT_CATALOG);
    assert.deepEqual(balance.tools.map((tool) => tool.name), ["get_open_balance"]);
    assert.ok(balance.candidates.some((candidate) => candidate.tool.name === "copilot_arrivals_pending_balance"), "la llegada con saldo del copiloto compitió y perdió por especificidad");
    assert.deepEqual(routeAll("¿Qué huéspedes llegan hoy con saldo pendiente?"), ["copilot_arrivals_pending_balance"]);
    assert.deepEqual(routeAll("¿Qué habitaciones puedo dar ahora?"), ["copilot_rooms_ready_for_delivery"]);
    assert.deepEqual(routeAll("¿cuántas habitaciones OOO tenemos?"), ["copilot_rooms_blocked"]);
    for (const suggestion of ALL_SUGGESTED_QUESTIONS) {
      const copilotTools = routeByRules(suggestion.question, ASSISTANT_CATALOG).tools.filter((tool) => tool.origin === "copilot");
      assert.ok(copilotTools.length <= 1, `«${suggestion.question}» enruta a ${copilotTools.length} herramientas del copiloto`);
    }
  });

  it("«hola» y palabras genéricas no enrutan a nada", () => {
    for (const question of ["hola", "¿Qué tengo hoy?", "ahora mismo", ""]) {
      const result = routeByRules(question, ASSISTANT_CATALOG);
      assert.deepEqual(result.tools, [], `«${question}»`);
      assert.equal(result.intent, "unknown");
    }
  });
});
