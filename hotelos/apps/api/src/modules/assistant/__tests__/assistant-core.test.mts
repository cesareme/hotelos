// Núcleo conversacional único del asistente (Tanda L6b · L6b-05) con dependencias inyectadas:
// sin Prisma (memoria en memoria, catálogo con `run` simulado, runner simulado, telemetría
// capturada) ni red (ai-core con fetch simulado). Cubre: reglas sin clave con cita y fuente,
// tool use del modelo con lectura ejecutada y citada, escritura → awaiting_confirmation sin
// ejecutar, herramienta fuera del catálogo denegada, 403/429 → reglas con aviso, PII redactada en
// lo persistido, memoria entre turnos y 404 opaco de conversación ajena, bucle ≤ MAX_MODEL_TURNS.
// Run: cd apps/api && node --import tsx --test src/modules/assistant/__tests__/assistant-core.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAiCore, resolveAiConfig } from "@hotelos/ai-core";
import type { AiCore } from "@hotelos/ai-core";
import type { RecordToolCallInput, ToolRunResult } from "@hotelos/ai-core/runner";
import { TOOL_DEFINITIONS } from "@hotelos/ai-tools";
import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../../../lib/http-error.js";
import type { RunAiToolInput } from "../../ai-operations/tool-runner.service.js";
import { AI_WRITE_TOOL_NAMES } from "../../ai-operations/tools/index.js";
import { getAssistantTool } from "../assistant-catalog.js";
import type { AssistantTool, AssistantSurface } from "../assistant-catalog.js";
import {
  ASSISTANT_TURN_TOOL_NAME,
  HIGH_RISK_CONFIRM_PERMISSION,
  MAX_MODEL_TURNS,
  assistantPropertyGate,
  deriveAssistantMode,
  effectiveSurface,
  guestConversationIdOf,
  modelToolInput,
  questionFingerprint,
  renderToolSummary,
  resetAssistantCoreForTests,
  runAssistantTurn,
  todayLabel,
  writeToolsFor
} from "../assistant-core.service.js";
import type { AssistantPropertyGate, AssistantWriteTool } from "../assistant-core.service.js";
import { decideAssistantPropertyGate } from "../assistant-gate.js";
import { createInMemoryAssistantMemoryStore, resetAssistantMemoryForTests } from "../assistant-memory.service.js";
import { ASSISTANT_SYSTEM_PROMPTS, normalizeScreenContext, safeScreenUrl } from "../assistant-prompts.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests del núcleo del asistente");
}) as typeof fetch;

const ALL_PERMISSIONS = [...new Set(TOOL_DEFINITIONS.flatMap((definition) => definition.requiredPermissions))] as PermissionKey[];

function user(overrides: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_core", propertyId: "prop_core", userId: "usr_core", fullName: "Recepción", deviceId: "dev_1", permissions: ["pms.reservation.read", "folio.read", "ai.tool.execute"], ...overrides };
}

// --- ai-core simulado ---------------------------------------------------------

type Captured = { body: Record<string, unknown> };

function anthropicMessage(content: unknown[], stopReason = "end_turn") {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: stopReason, usage: { input_tokens: 30, output_tokens: 20 } };
}
const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });

function configuredCore(responders: unknown[], captured: Captured[]): AiCore {
  return createAiCore({
    config: resolveAiConfig({ provider: "anthropic", apiKey: "sk-test-not-a-real-key", usdEurRate: "0.9" }),
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const next = responders.shift();
      if (!next) throw new Error("sin respuesta simulada");
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    sleep: async () => undefined
  });
}

function unconfiguredCore(): AiCore {
  return createAiCore({ config: resolveAiConfig({ provider: "none" }) });
}

// --- catálogo, runner y telemetría simulados -----------------------------------

const ARRIVALS_SOURCE = "prisma:Reservation.arrivalDate=today(Property.timezone)";

function localTool(name: string, data: Record<string, unknown>, source: string, calls: string[]): AssistantTool {
  const base = getAssistantTool(name);
  assert.ok(base, `${name} existe en el catálogo`);
  return {
    ...base,
    run: async () => {
      calls.push(name);
      return { ok: true, data, source, generatedAt: "2026-09-20T10:00:00.000Z" };
    }
  };
}

function registryTool(name: string): AssistantTool {
  const base = getAssistantTool(name);
  assert.ok(base && base.kind === "registry", `${name} es del registro`);
  return base;
}

const ASSIGN_ROOM: AssistantWriteTool = {
  name: "assignRoom",
  description: "Asigna una habitación a una reserva (escritura: siempre con confirmación de una persona).",
  inputSchema: { type: "object", additionalProperties: false, required: ["reservationId", "roomId"], properties: { reservationId: { type: "string" }, roomId: { type: "string" } } },
  riskLevel: "medium"
};

type Harness = {
  captured: Captured[];
  rows: RecordToolCallInput[];
  runnerCalls: RunAiToolInput[];
  localCalls: string[];
  /** Superficies con las que el núcleo pidió el catálogo (una por turno). */
  catalogSurfaces: AssistantSurface[];
  gateCalls: number;
  memory: ReturnType<typeof createInMemoryAssistantMemoryStore>;
};

function setup(options: { ai: AiCore; catalog?: (calls: string[]) => AssistantTool[]; writes?: AssistantWriteTool[]; runner?: (input: RunAiToolInput) => Promise<ToolRunResult>; gate?: AssistantPropertyGate }): Harness {
  const harness: Harness = { captured: [], rows: [], runnerCalls: [], localCalls: [], catalogSurfaces: [], gateCalls: 0, memory: createInMemoryAssistantMemoryStore() };
  const catalog = options.catalog ?? ((calls) => [localTool("get_arrivals_today", { count: 3, items: [] }, ARRIVALS_SOURCE, calls), localTool("get_occupancy_today", { occupancyPct: 80, occupiedRooms: 40, totalRooms: 50 }, "prisma:Room+Reservation", calls)]);
  resetAssistantMemoryForTests(harness.memory);
  resetAssistantCoreForTests({
    getAiCore: () => options.ai,
    catalogFor: ({ surface }) => {
      harness.catalogSurfaces.push(surface);
      return catalog(harness.localCalls);
    },
    writeToolsFor: () => options.writes ?? [],
    runAiTool: async (input) => {
      harness.runnerCalls.push(input);
      if (!options.runner) throw new Error(`runner no esperado para ${input.toolName}`);
      return options.runner(input);
    },
    recordToolCall: async (input) => {
      harness.rows.push(input);
      return { id: `call_${harness.rows.length}` };
    },
    // Puerta de propiedad simulada (la real lee Prisma): abierta salvo que el test la cierre.
    propertyGate: async () => {
      harness.gateCalls += 1;
      return options.gate ?? { allowed: true };
    },
    now: () => new Date("2026-09-20T10:00:00.000Z")
  });
  return harness;
}

afterEach(() => {
  resetAssistantCoreForTests();
  resetAssistantMemoryForTests();
});

const ask = (question: string, extra: { conversationId?: string | null; surface?: "backoffice" | "reception" | "guest"; context?: UserContext; screen?: unknown } = {}) =>
  runAssistantTurn({ context: extra.context ?? user(), surface: extra.surface ?? "backoffice", question, conversationId: extra.conversationId ?? null, screen: extra.screen, correlationId: "corr_test" });

describe("assistant-core · sin clave (reglas)", () => {
  it("sin clave → reglas, mode deterministic, cita con fuente; fila answerAnalyticsQuestion con coste 0 y memoria con 2 mensajes", async () => {
    const h = setup({ ai: unconfiguredCore() });
    const turn = await ask("¿Cuántas llegadas tengo hoy?");
    assert.equal(turn.mode, "deterministic");
    assert.equal(turn.routedBy, "rules");
    assert.deepEqual(h.localCalls, ["get_arrivals_today"]);
    assert.equal(turn.citations.length, 1);
    assert.equal(turn.citations[0]!.tool, "get_arrivals_today");
    assert.equal(turn.citations[0]!.source, ARRIVALS_SOURCE);
    assert.equal(turn.citations[0]!.ok, true);
    assert.equal(turn.citations[0]!.costEur, 0);
    assert.deepEqual(turn.toolCalls.map((call) => call.name), ["get_arrivals_today"]);
    assert.match(turn.answer, /3 reservas con llegada hoy/);
    assert.match(turn.answer, /por reglas, sin modelo/);
    assert.deepEqual(turn.cost, { model: null, tokensInput: 0, tokensOutput: 0, eur: 0 });
    assert.deepEqual(turn.pendingToolCalls, []);
    assert.deepEqual(turn.notices, []);
    assert.equal(turn.surface, "backoffice");
    assert.ok(turn.conversationId, "abre conversación");
    assert.equal(h.captured.length, 0, "sin clave no hay llamada al proveedor");
    assert.equal(h.runnerCalls.length, 0);

    // Una fila answerAnalyticsQuestion por turno: succeeded, tokens 0 y cost_eur 0 (AI-CORE §6), sin modelo.
    assert.equal(h.rows.length, 1);
    const row = h.rows[0]!;
    assert.equal(row.toolName, ASSISTANT_TURN_TOOL_NAME);
    assert.equal(row.status, "succeeded");
    assert.equal(row.organizationId, "org_core");
    assert.equal(row.propertyId, "prop_core");
    assert.equal(row.userId, "usr_core");
    assert.equal(row.conversationId, turn.conversationId);
    assert.equal(row.costEur, 0);
    assert.equal(row.tokensInput, 0);
    assert.equal(row.tokensOutput, 0);
    assert.equal(row.model, undefined);
    assert.equal(row.automationLevel, "suggest");
    assert.equal((row.outputJson as { routedBy: string }).routedBy, "rules");
    assert.ok(typeof row.latencyMs === "number");

    // Memoria: pregunta + respuesta, título = pregunta, coste en el mensaje del asistente.
    assert.equal(h.memory.conversations.length, 1);
    assert.equal(h.memory.conversations[0]!.title, "¿Cuántas llegadas tengo hoy?");
    assert.equal(h.memory.conversations[0]!.surface, "backoffice");
    assert.deepEqual(h.memory.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(h.memory.messages[0]!.content, "¿Cuántas llegadas tengo hoy?");
    assert.equal(h.memory.messages[1]!.routedBy, "rules");
    assert.equal(h.memory.messages[1]!.costEur, 0);
    assert.deepEqual(h.memory.messages[1]!.toolCalls.map((c) => c.tool), ["get_arrivals_today"]);
  });

  it("pregunta sin herramienta → sugerencias de la superficie (sin citas) y pregunta vacía → 400", async () => {
    setup({ ai: unconfiguredCore() });
    const turn = await ask("hola");
    assert.equal(turn.citations.length, 0);
    assert.match(turn.answer, /No he sabido enrutar/);
    assert.match(turn.answer, /«¿Cuántas llegadas tengo hoy\?»/);
    await assert.rejects(ask("   "), BadRequestError);
  });

  it("PII redactada en lo persistido: memoria, título y telemetría llevan marcadores, nunca el nombre, el teléfono ni el correo", async () => {
    const h = setup({
      ai: unconfiguredCore(),
      catalog: (calls) => [localTool("get_arrivals_today", { count: 1, items: [] }, ARRIVALS_SOURCE, calls), registryTool("findReservation")],
      runner: async () => ({ status: "executed", toolCallId: "call_r1", output: { found: false }, configured: false })
    });
    const question = "Busca la reserva de la Sra. Casilda Ventureira, teléfono 612 345 678 y correo casilda@example.com";
    const turn = await ask(question);
    assert.equal(turn.routedBy, "rules");
    assert.deepEqual(h.runnerCalls.map((call) => call.toolName), ["findReservation"]);
    assert.equal(turn.citations[0]!.aiToolCallId, "call_r1");
    const persisted = [h.memory.messages[0]!.content, h.memory.messages[1]!.content, h.memory.conversations[0]!.title, JSON.stringify(h.rows[0]!.inputJson), JSON.stringify(h.rows[0]!.outputJson)];
    for (const value of persisted) {
      assert.ok(!value.includes("Casilda"), value);
      assert.ok(!value.includes("Ventureira"), value);
      assert.ok(!value.includes("612 345 678"), value);
      assert.ok(!value.includes("casilda@example.com"), value);
    }
    assert.ok(h.memory.messages[0]!.content.includes("[NOMBRE_1]"), h.memory.messages[0]!.content);
    assert.ok(h.memory.messages[0]!.content.includes("[TEL_1]"), h.memory.messages[0]!.content);
    assert.ok(h.memory.messages[0]!.content.includes("[EMAIL_1]"), h.memory.messages[0]!.content);
    assert.ok(h.memory.conversations[0]!.title.includes("[NOMBRE_1]"));
    // La respuesta al usuario (no persistida) conserva la pregunta tal cual.
    assert.equal(turn.question, question);
  });

  it("REV-02: la telemetría del turno guarda solo la huella de la pregunta (longitud + sha256 truncado), nunca el texto, aunque el nombre vaya sin tratamiento", async () => {
    const h = setup({ ai: unconfiguredCore() });
    const question = "¿Tiene reserva Nombre Ficticio para hoy? Dime las llegadas";
    const turn = await ask(question);
    assert.equal(turn.routedBy, "rules");
    const input = h.rows[0]!.inputJson as Record<string, unknown>;
    assert.equal("question" in input, false, "input_json no lleva la pregunta");
    assert.deepEqual({ questionChars: input.questionChars, questionSha256: input.questionSha256 }, questionFingerprint(question));
    assert.equal(typeof input.questionSha256, "string");
    assert.equal((input.questionSha256 as string).length, 16);
    assert.ok(!JSON.stringify(h.rows[0]!.inputJson).includes("Ficticio"));
    assert.ok(!JSON.stringify(h.rows[0]!.outputJson).includes("Ficticio"));
    // El título (primera pregunta) sigue siendo legible en la memoria: va cifrado en reposo (PII_FIELDS.AssistantConversation).
    assert.equal(h.memory.conversations[0]!.title, question);
  });

  it("REV-03: un `screen` hostil (nombre en la entidad y en la ruta, query string, comandos largos) se sanea en el núcleo: solo ids seguros, ruta sin `?`", async () => {
    const h = setup({ ai: unconfiguredCore() });
    const screen = { screenKey: "GuestDetail", url: "/recepcion/huespedes/Nombre%20Ficticio?q=Apellido#x", entity: { type: "guest", id: "Nombre Ficticio" }, commands: ["x".repeat(500), "ok", "ok", "con espacio"] };
    const turn = await ask("¿Cuántas llegadas tengo hoy?", { screen });
    assert.ok(turn.conversationId);
    const stored = h.memory.conversations[0]!.screenContext;
    assert.deepEqual(stored, { screenKey: "GuestDetail", url: "/recepcion/huespedes/_", commands: ["ok"] });
    const telemetry = (h.rows[0]!.inputJson as { screen: unknown }).screen;
    assert.deepEqual(telemetry, stored);
    for (const value of [JSON.stringify(stored), JSON.stringify(h.rows[0]!.inputJson)]) {
      assert.ok(!value.includes("Ficticio") && !value.includes("Apellido") && !value.includes("?q="), value);
    }
    // Sin screenKey segura no hay contexto; la entidad se descarta entera si el tipo o el id no son seguros.
    assert.equal(normalizeScreenContext({ screenKey: "Pantalla con espacios", url: "/hoy" }), null);
    assert.deepEqual(normalizeScreenContext({ screenKey: "FrontDesk", entity: { type: "reservation", id: "res_1" } }), { screenKey: "FrontDesk", entity: { type: "reservation", id: "res_1" } });
    assert.deepEqual(normalizeScreenContext({ screenKey: "FrontDesk", entity: { type: "guest name", id: "res_1" } }), { screenKey: "FrontDesk" });
    assert.equal(safeScreenUrl("https://app.example/recepcion/reservas/lista?x=1"), "/recepcion/reservas/lista");
    assert.equal(safeScreenUrl("/recepcion/reservas/nueva"), "/recepcion/reservas/nueva");
    assert.equal(safeScreenUrl("   "), null);
  });

  it("REV-06: el resumen de las lecturas «de hoy» nombra la fecha cuando la lectura la devuelve (auto-explicativo) y sigue igual sin ella", () => {
    const base = { ok: true, source: ARRIVALS_SOURCE, generatedAt: "2026-09-20T10:00:00.000Z" };
    assert.equal(renderToolSummary("get_arrivals_today", { ...base, data: { count: 6, items: [], date: "2026-09-20" } }), "6 reservas con llegada hoy (20/09/2026).");
    assert.equal(renderToolSummary("get_departures_today", { ...base, data: { count: 2, items: [], date: "2026-09-20" } }), "2 reservas con salida hoy (20/09/2026).");
    assert.match(renderToolSummary("get_occupancy_today", { ...base, data: { occupancyPct: 80, occupiedRooms: 40, totalRooms: 50, date: "2026-09-20" } }), /^Ocupación hoy \(20\/09\/2026\): /);
    assert.equal(renderToolSummary("get_arrivals_today", { ...base, data: { count: 3, items: [] } }), "3 reservas con llegada hoy.");
    assert.equal(todayLabel({ date: "no-es-fecha" }), "hoy");
  });
});

describe("assistant-core · con clave (tool use)", () => {
  it("fetch simulado con tool_use → lectura ejecutada y citada; mode llm, routedBy model, coste real en turno, fila y memoria", async () => {
    const captured: Captured[] = [];
    const ai = configuredCore([anthropicMessage([text("Consulto la ocupación."), toolUse("toolu_1", "get_occupancy_today")], "tool_use"), anthropicMessage([text("La ocupación es del 80 %.")])], captured);
    const h = setup({ ai, writes: [ASSIGN_ROOM] });
    h.captured = captured;
    const turn = await ask("¿Cuál es la ocupación ahora mismo?", { screen: { screenKey: "reception.today", url: "/hoy", entity: { type: "reservation", id: "res_1" }, commands: ["checkin"] } });

    assert.equal(turn.mode, "llm");
    assert.equal(turn.routedBy, "model");
    assert.equal(turn.answer, "La ocupación es del 80 %.");
    assert.deepEqual(h.localCalls, ["get_occupancy_today"]);
    assert.equal(turn.citations.length, 1);
    assert.equal(turn.citations[0]!.tool, "get_occupancy_today");
    assert.equal(turn.citations[0]!.source, "prisma:Room+Reservation");
    assert.match(turn.citations[0]!.summary, /Ocupación hoy: 80 %/);
    assert.deepEqual(turn.pendingToolCalls, []);
    assert.equal(turn.cost.model, "claude-sonnet-5");
    assert.equal(turn.cost.tokensInput, 60);
    assert.equal(turn.cost.tokensOutput, 40);
    // 2 llamadas × (30 × 2 $/M + 20 × 10 $/M) = 0,00052 $ × 0,9 = 0,000468 €
    assert.ok(Math.abs((turn.cost.eur ?? 0) - 0.000468) < 1e-9, String(turn.cost.eur));

    // Cuerpo enviado: system del respaldo, tools del catálogo + escritura, tool_choice auto, contexto de pantalla y tool_result en el 2.º turno.
    assert.equal(captured.length, 2);
    const first = captured[0]!.body;
    assert.equal(first.system, ASSISTANT_SYSTEM_PROMPTS.backoffice);
    assert.deepEqual(first.tool_choice, { type: "auto" });
    assert.deepEqual((first.tools as Array<{ name: string }>).map((tool) => tool.name), ["get_arrivals_today", "get_occupancy_today", "assignRoom"]);
    const firstMessages = first.messages as Array<{ role: string; content: unknown }>;
    assert.equal(firstMessages.length, 1);
    assert.match(String(firstMessages[0]!.content), /Pantalla actual: reception\.today/);
    assert.match(String(firstMessages[0]!.content), /Entidad en pantalla: reservation res_1/);
    assert.match(String(firstMessages[0]!.content), /Pregunta: ¿Cuál es la ocupación ahora mismo\?/);
    const second = captured[1]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(second.length, 3);
    assert.equal(second[1]!.role, "assistant");
    assert.equal(second[1]!.content[1]!.type, "tool_use");
    assert.equal(second[2]!.role, "user");
    assert.equal(second[2]!.content[0]!.type, "tool_result");
    assert.equal(second[2]!.content[0]!.tool_use_id, "toolu_1");
    assert.equal(second[2]!.content[0]!.is_error, undefined);
    assert.match(String(second[2]!.content[0]!.content), /"occupancyPct":80/);

    // Telemetría y memoria con modelo, tokens y coste reales.
    const row = h.rows[0]!;
    assert.equal(row.model, "claude-sonnet-5");
    assert.equal(row.tokensInput, 60);
    assert.equal(row.tokensOutput, 40);
    assert.ok(Math.abs((row.costEur ?? 0) - 0.000468) < 1e-9);
    assert.equal((row.outputJson as { routedBy: string }).routedBy, "model");
    assert.equal(h.memory.messages[1]!.model, "claude-sonnet-5");
    assert.equal(h.memory.messages[1]!.routedBy, "model");
    assert.equal(h.memory.messages[1]!.tokensInput, 60);
    assert.deepEqual(h.memory.conversations[0]!.screenContext, { screenKey: "reception.today", url: "/hoy", entity: { type: "reservation", id: "res_1" }, commands: ["checkin"] });
  });

  it("escritura → awaiting_confirmation por runAiTool, nunca se ejecuta: pendingToolCalls con id, riesgo y entrada; sin cita de lectura", async () => {
    const captured: Captured[] = [];
    const ai = configuredCore(
      [anthropicMessage([text("Propongo asignar la 101."), toolUse("toolu_w", "assignRoom", { reservationId: "res_1", roomId: "room_101" })], "tool_use"), anthropicMessage([text("He dejado la asignación pendiente de confirmación por recepción.")])],
      captured
    );
    const h = setup({ ai, writes: [ASSIGN_ROOM], runner: async () => ({ status: "awaiting_confirmation", toolCallId: "call_w1", preview: { action: "assignRoom" } }) });
    const turn = await ask("Asigna la habitación 101 a la reserva res_1");

    assert.equal(h.runnerCalls.length, 1);
    const call = h.runnerCalls[0]!;
    assert.equal(call.toolName, "assignRoom");
    assert.deepEqual(call.input, { reservationId: "res_1", roomId: "room_101" });
    assert.equal(call.source, "chat");
    assert.equal(call.conversationId, turn.conversationId);
    assert.equal(call.execute, undefined, "sin execute inyectado: manda la implementación del registro bajo WRITE_ALWAYS_CONFIRMS");
    assert.deepEqual(h.localCalls, []);
    assert.equal(turn.pendingToolCalls.length, 1);
    const pending = turn.pendingToolCalls[0]!;
    assert.equal(pending.id, "call_w1");
    assert.equal(pending.toolName, "assignRoom");
    assert.equal(pending.riskLevel, "medium");
    assert.equal(pending.conversationId, turn.conversationId);
    assert.equal(pending.correlationId, "corr_test");
    assert.deepEqual(pending.input, { reservationId: "res_1", roomId: "room_101" });
    assert.equal(turn.citations.length, 0, "una propuesta pendiente no es una cita de lectura");
    assert.equal(turn.mode, "llm");
    assert.equal(turn.answer, "He dejado la asignación pendiente de confirmación por recepción.");
    const result = (captured[1]!.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[2]!.content[0]!;
    assert.equal(result.is_error, undefined);
    assert.match(String(result.content), /pendiente de que una persona la confirme\. No se ha ejecutado/);
  });

  it("herramienta fuera del catálogo del usuario → denegada sin ejecutar (tool_result is_error, aviso) y el turno sigue", async () => {
    const captured: Captured[] = [];
    const ai = configuredCore([anthropicMessage([toolUse("toolu_x", "get_open_balance")], "tool_use"), anthropicMessage([text("No puedo consultar el saldo desde aquí.")])], captured);
    const h = setup({ ai, catalog: (calls) => [localTool("get_arrivals_today", { count: 3, items: [] }, ARRIVALS_SOURCE, calls)] });
    const turn = await ask("¿Qué saldo pendiente hay por cobrar?");
    assert.deepEqual(h.localCalls, []);
    assert.equal(h.runnerCalls.length, 0, "ni el runner ve una herramienta que no está en el catálogo");
    const result = (captured[1]!.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[2]!.content[0]!;
    assert.equal(result.is_error, true);
    assert.match(String(result.content), /no está disponible para este usuario/);
    assert.equal(turn.notices.length, 1);
    assert.match(turn.notices[0]!, /«get_open_balance» no está disponible/);
    assert.match(turn.answer, /^No puedo consultar el saldo desde aquí\.\n\nAviso: /);
    assert.equal(turn.citations.length, 0);
    assert.equal(turn.mode, "llm");
  });

  for (const [label, error] of [
    ["403 presupuesto", new ForbiddenError("Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED" })],
    ["429 rate limit", new TooManyRequestsError("Límite de peticiones de IA alcanzado.", { retryAfterSeconds: 5 })]
  ] as const) {
    it(`${label} del runner → reglas con aviso: routedBy rules, mode deterministic, coste de la llamada facturada conservado`, async () => {
      const captured: Captured[] = [];
      const ai = configuredCore([anthropicMessage([toolUse("toolu_r", "findReservation", { code: "RES-1" })], "tool_use"), anthropicMessage([text("nunca")])], captured);
      const h = setup({
        ai,
        catalog: (calls) => [localTool("get_arrivals_today", { count: 3, items: [] }, ARRIVALS_SOURCE, calls), registryTool("findReservation")],
        runner: async () => {
          throw error;
        }
      });
      const turn = await ask("¿Cuántas llegadas tengo hoy?");
      assert.equal(captured.length, 1, "tras el 403/429 no se vuelve a llamar al modelo");
      assert.equal(turn.routedBy, "rules");
      assert.equal(turn.mode, "deterministic");
      assert.deepEqual(h.localCalls, ["get_arrivals_today"]);
      assert.deepEqual(turn.citations.map((c) => c.tool), ["get_arrivals_today"]);
      assert.equal(turn.notices.length, 1);
      assert.match(turn.notices[0]!, /He respondido por reglas/);
      assert.match(turn.answer, /3 reservas con llegada hoy/);
      assert.match(turn.answer, label.startsWith("403") ? /Aviso: Presupuesto mensual de IA agotado/ : /Aviso: Límite de peticiones de IA alcanzado/);
      // La llamada al modelo se facturó: el coste no se oculta aunque la respuesta sea por reglas.
      assert.equal(turn.cost.model, "claude-sonnet-5");
      assert.equal(turn.cost.tokensInput, 30);
      assert.equal(h.rows[0]!.model, "claude-sonnet-5");
      assert.equal(h.rows[0]!.tokensInput, 30);
      assert.equal((h.rows[0]!.outputJson as { routedBy: string }).routedBy, "rules");
    });
  }

  it("rechazo del modelo (stop_reason refusal) → reglas con aviso", async () => {
    const captured: Captured[] = [];
    const ai = configuredCore([anthropicMessage([], "refusal")], captured);
    setup({ ai });
    const turn = await ask("¿Cuántas llegadas tengo hoy?");
    assert.equal(turn.routedBy, "rules");
    assert.equal(turn.mode, "deterministic");
    assert.equal(turn.notices.length, 1);
    assert.match(turn.answer, /3 reservas con llegada hoy/);
    assert.equal(turn.cost.tokensInput, 30, "coste del rechazo facturado");
  });

  it(`bucle acotado a ${MAX_MODEL_TURNS} turnos: si el modelo sigue pidiendo herramientas, se responde con lo obtenido`, async () => {
    const captured: Captured[] = [];
    const responders = Array.from({ length: MAX_MODEL_TURNS + 2 }, (_, i) => anthropicMessage([text(`Sigo consultando (${i + 1}).`), toolUse(`toolu_${i}`, "get_arrivals_today")], "tool_use"));
    const ai = configuredCore(responders, captured);
    const h = setup({ ai });
    const turn = await ask("¿Cuántas llegadas tengo hoy?");
    assert.equal(captured.length, MAX_MODEL_TURNS);
    assert.equal(h.localCalls.length, MAX_MODEL_TURNS);
    assert.equal(turn.mode, "llm");
    assert.match(turn.answer, /Sigo consultando \(3\)\./);
    assert.match(turn.answer, /Esto es lo obtenido de las herramientas:/);
    assert.equal(turn.cost.tokensInput, 30 * MAX_MODEL_TURNS);
  });

  it("memoria: el segundo turno con conversationId lleva los mensajes anteriores al modelo; un conversationId ajeno → 404 opaco", async () => {
    const captured: Captured[] = [];
    const ai = configuredCore([anthropicMessage([text("Hay 3 llegadas.")]), anthropicMessage([text("Las mismas 3.")])], captured);
    const h = setup({ ai });
    const first = await ask("¿Cuántas llegadas tengo hoy?");
    const second = await ask("¿Y ahora?", { conversationId: first.conversationId });
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(h.memory.conversations.length, 1);
    assert.equal(h.memory.messages.length, 4);
    const sent = captured[1]!.body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(sent[0]!.content, "¿Cuántas llegadas tengo hoy?");
    assert.equal(sent[1]!.content, "Hay 3 llegadas.");
    assert.equal(sent[2]!.content, "¿Y ahora?");
    await assert.rejects(ask("¿Y ahora?", { conversationId: first.conversationId, context: user({ userId: "usr_otro" }) }), NotFoundError);
    await assert.rejects(ask("¿Y ahora?", { conversationId: first.conversationId, context: user({ propertyId: "prop_otra" }) }), NotFoundError);
    await assert.rejects(ask("¿Y ahora?", { conversationId: "conv_inexistente" }), NotFoundError);
  });

  for (const [label, gate] of [
    ["IA desactivada en la propiedad", { allowed: false, reason: "ai_disabled_for_property", notice: "La IA está desactivada en esta propiedad; he respondido por reglas." }],
    ["presupuesto mensual agotado", { allowed: false, reason: "budget_exceeded", notice: "Presupuesto mensual de IA agotado (12.00 € de 10.00 €); he respondido por reglas." }],
    ["automatización en nivel off", { allowed: false, reason: "tool_disabled", notice: "La automatización de answerAnalyticsQuestion está apagada en esta propiedad (nivel off); he respondido por reglas." }]
  ] as const) {
    it(`L6B-REV-01: con clave pero ${label} → 0 llamadas al proveedor, routedBy rules con aviso y coste 0`, async () => {
      const captured: Captured[] = [];
      const ai = configuredCore([anthropicMessage([text("nunca")])], captured);
      const h = setup({ ai, gate });
      const turn = await ask("¿Cuántas llegadas tengo hoy?");
      assert.equal(h.gateCalls, 1, "la puerta se evalúa una vez por turno");
      assert.equal(captured.length, 0, "ninguna llamada facturable");
      assert.equal(turn.routedBy, "rules");
      assert.equal(turn.mode, "deterministic");
      assert.deepEqual(turn.notices, [gate.notice]);
      assert.match(turn.answer, /3 reservas con llegada hoy/);
      assert.match(turn.answer, new RegExp(`Aviso: ${gate.notice.slice(0, 20)}`));
      assert.deepEqual(turn.cost, { model: null, tokensInput: 0, tokensOutput: 0, eur: 0 });
      assert.equal(h.rows[0]!.costEur, 0);
      assert.equal((h.rows[0]!.outputJson as { routedBy: string }).routedBy, "rules");
    });
  }

  it("L6B-REV-01: sin clave la puerta ni se consulta; assistantPropertyGate expone la puerta vigente (la usa el clasificador del bot)", async () => {
    const h = setup({ ai: unconfiguredCore(), gate: { allowed: false, reason: "budget_exceeded", notice: "x" } });
    const turn = await ask("¿Cuántas llegadas tengo hoy?");
    assert.equal(h.gateCalls, 0);
    assert.deepEqual(turn.notices, []);
    const gate = await assistantPropertyGate({ organizationId: "org_core", propertyId: "prop_core", toolName: "guestBotClassify" });
    assert.equal(gate.allowed, false);
    assert.equal(h.gateCalls, 1);
  });

  it("L6B-REV-01: decideAssistantPropertyGate (pura) reproduce las puertas 3/4/7 del runner en ese orden", () => {
    const open = { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", toolSetting: null, spentEur: 1, budgetEur: 10 };
    assert.deepEqual(decideAssistantPropertyGate(open, ASSISTANT_TURN_TOOL_NAME), { allowed: true });
    assert.equal((decideAssistantPropertyGate({ ...open, aiEnabled: false }, ASSISTANT_TURN_TOOL_NAME) as { reason: string }).reason, "ai_disabled_for_property");
    assert.equal((decideAssistantPropertyGate({ ...open, toolSetting: { enabled: false, automationLevel: null } }, ASSISTANT_TURN_TOOL_NAME) as { reason: string }).reason, "tool_disabled");
    assert.equal((decideAssistantPropertyGate({ ...open, defaultAutomationLevel: "off" }, ASSISTANT_TURN_TOOL_NAME) as { reason: string }).reason, "tool_disabled");
    assert.equal((decideAssistantPropertyGate({ ...open, toolSetting: { enabled: true, automationLevel: "off" } }, ASSISTANT_TURN_TOOL_NAME) as { reason: string }).reason, "tool_disabled");
    assert.deepEqual(decideAssistantPropertyGate({ ...open, toolSetting: { enabled: true, automationLevel: "suggest" } }, ASSISTANT_TURN_TOOL_NAME), { allowed: true });
    const budget = decideAssistantPropertyGate({ ...open, spentEur: 12, budgetEur: 10 }, ASSISTANT_TURN_TOOL_NAME);
    assert.equal((budget as { reason: string }).reason, "budget_exceeded");
    assert.match((budget as { notice: string }).notice, /12\.00 € de 10\.00 €/);
    assert.deepEqual(decideAssistantPropertyGate({ ...open, spentEur: 999, budgetEur: null }, ASSISTANT_TURN_TOOL_NAME), { allowed: true }, "sin presupuesto no hay límite");
  });

  it("REV-05: con conversationId manda la superficie de la conversación guardada (catálogo y turno), no la del cuerpo", async () => {
    const h = setup({ ai: unconfiguredCore() });
    const first = await ask("¿Cuántas llegadas tengo hoy?", { surface: "reception" });
    assert.equal(first.surface, "reception");
    const second = await ask("¿Cuál es la ocupación ahora mismo?", { surface: "backoffice", conversationId: first.conversationId });
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.surface, "reception", "la superficie efectiva es la de la conversación");
    assert.deepEqual(h.catalogSurfaces, ["reception", "reception"]);
    assert.equal(h.memory.conversations.length, 1);
    assert.equal(h.memory.conversations[0]!.surface, "reception");
    assert.equal((h.rows[1]!.inputJson as { surface: string }).surface, "reception");
    assert.equal(effectiveSurface({ surface: "desconocida" }, "backoffice"), "backoffice");
    assert.equal(effectiveSurface(null, "guest"), "guest");
  });

  it("L6B-REV-12: en la superficie guest el conversationId de una herramienta lo fija el actor (guest:<id>), nunca el modelo", async () => {
    const captured: Captured[] = [];
    const ai = configuredCore([anthropicMessage([toolUse("toolu_g", "answerGuestQuestion", { guestQuestion: "¿wifi?", conversationId: "conv_de_otro_huesped" })], "tool_use"), anthropicMessage([text("La clave del wifi está en recepción.")])], captured);
    const h = setup({ ai, catalog: () => [registryTool("answerGuestQuestion")], runner: async () => ({ status: "executed", toolCallId: "call_g1", output: { text: "ok" }, configured: true }) });
    const guest = user({ userId: "guest:conv_9", permissions: ["ai.tool.execute"] });
    const turn = await ask("¿wifi?", { surface: "guest", context: guest });
    assert.equal(turn.mode, "llm");
    assert.equal(h.runnerCalls.length, 1);
    assert.deepEqual(h.runnerCalls[0]!.input, { guestQuestion: "¿wifi?", conversationId: "conv_9" });
    assert.equal(guestConversationIdOf("guest:conv_9"), "conv_9");
    assert.equal(guestConversationIdOf("usr_1"), null);
    assert.equal(guestConversationIdOf("guest:"), null);
    // Actor que no es huésped en la superficie guest (no debería ocurrir): el conversationId del modelo se descarta.
    assert.deepEqual(modelToolInput({ surface: "guest", context: user({ userId: "usr_1" }) }, { conversationId: "x", a: 1 }), { a: 1 });
    // En las superficies de personal la entrada del modelo se respeta.
    assert.deepEqual(modelToolInput({ surface: "reception", context: guest }, { conversationId: "x" }), { conversationId: "x" });
  });
});

describe("assistant-core · escrituras expuestas al modelo y modo", () => {
  it("writeToolsFor: ninguna en guest; en personal solo escrituras con implementación cuyos permisos tiene el usuario", () => {
    assert.deepEqual(writeToolsFor({ context: user({ permissions: ALL_PERMISSIONS }), surface: "guest" }), []);
    assert.deepEqual(writeToolsFor({ context: user({ permissions: [] }), surface: "reception" }), []);
    const tools = writeToolsFor({ context: user({ permissions: ALL_PERMISSIONS }), surface: "reception" });
    assert.ok(tools.length >= 1);
    for (const tool of tools) {
      assert.ok(AI_WRITE_TOOL_NAMES.includes(tool.name), tool.name);
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.ok(tool.description.length > 10, tool.name);
    }
    const onlyPms = writeToolsFor({ context: user({ permissions: ["pms.reservation.modify", "ai.tool.execute"] }), surface: "backoffice" });
    assert.ok(onlyPms.some((tool) => tool.name === "assignRoom"));
    assert.ok(!onlyPms.some((tool) => tool.name === "createWorkOrder"), "sin maintenance.workorder.create no se propone");
  });

  it("REV-04: writeToolsFor solo ofrece lo que el usuario podría confirmar: sin la clave de la matriz (createWorkOrder exige maintenance.workorder.manage) o sin ai.high_risk.confirm (high | critical) no se propone", () => {
    const all = [...new Set([...ALL_PERMISSIONS, HIGH_RISK_CONFIRM_PERMISSION])] as PermissionKey[];
    const everything = writeToolsFor({ context: user({ permissions: all }), surface: "reception" });
    assert.ok(everything.length >= 1);
    // Recepción con maintenance.workorder.create pero sin .manage (matriz create_maintenance_task): el runner la denegaría siempre.
    const withoutManage = writeToolsFor({ context: user({ permissions: all.filter((permission) => permission !== "maintenance.workorder.manage") }), surface: "reception" });
    assert.ok(everything.some((tool) => tool.name === "createWorkOrder"), "con .manage sí se ofrece createWorkOrder");
    assert.ok(!withoutManage.some((tool) => tool.name === "createWorkOrder"), "createWorkOrder no se ofrece sin maintenance.workorder.manage (el registro pide .create, la matriz .manage)");
    // Lo demás que cae sin .manage son las escrituras cuyo propio registro exige esa clave (resolveWorkOrder…), nada más.
    const dropped = everything.filter((tool) => !withoutManage.some((kept) => kept.name === tool.name)).map((tool) => tool.name);
    assert.ok(dropped.every((name) => name === "createWorkOrder" || TOOL_DEFINITIONS.find((definition) => definition.name === name)!.requiredPermissions.includes("maintenance.workorder.manage")), dropped.join(","));
    // Sin ai.high_risk.confirm nadie podría confirmar una escritura high | critical: no se ofrece ninguna.
    const withoutHigh = writeToolsFor({ context: user({ permissions: all.filter((permission) => permission !== HIGH_RISK_CONFIRM_PERMISSION) }), surface: "reception" });
    assert.ok(withoutHigh.every((tool) => tool.riskLevel === "low" || tool.riskLevel === "medium"), withoutHigh.map((tool) => `${tool.name}:${tool.riskLevel}`).join(","));
    assert.ok(withoutHigh.some((tool) => tool.name === "assignRoom"), "las de riesgo medio confirmables siguen");
    const highOnes = everything.filter((tool) => tool.riskLevel === "high" || tool.riskLevel === "critical");
    assert.ok(highOnes.length >= 1, "con la clave sí se ofrecen las high (p. ej. prepareGuestRegisterRecord)");
    assert.equal(withoutHigh.length, everything.length - highOnes.length);
  });

  it("deriveAssistantMode se conserva: llm solo con modelAnswered", () => {
    assert.equal(deriveAssistantMode([{ result: { ok: true } }]), "deterministic");
    assert.equal(deriveAssistantMode([{ result: { ok: true, modelAnswered: true } }]), "llm");
  });
});
