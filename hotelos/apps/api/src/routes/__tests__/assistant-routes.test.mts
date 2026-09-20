// Rutas del asistente unificado (Tanda L6b · L6b-06) con Fastify + inject y el núcleo SIMULADO:
// sin Prisma (memoria en memoria, catálogo con `run` simulado, telemetría capturada, guard de
// tenencia y pendientes inyectados) ni red (ai-core sin proveedor). Cubre: 400 con pregunta vacía /
// superficie desconocida / conversationId mal formado, forma v2 del turno, superficie por defecto y
// explícita, catálogo filtrado por RBAC y superficie con sugeridas cubiertas, memoria privada por
// usuario (lista, detalle, 404 opaco, borrado 204) y pendientes redactados.
// Run: cd apps/api && node --import tsx --test src/routes/__tests__/assistant-routes.test.mts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { createAiCore, resolveAiConfig } from "@hotelos/ai-core";
import type { RecordToolCallInput } from "@hotelos/ai-core/runner";
import type { UserContext } from "../../lib/demo-store.js";
import { NotFoundError } from "../../lib/http-error.js";
import { getAssistantTool } from "../../modules/assistant/assistant-catalog.js";
import type { AssistantTool } from "../../modules/assistant/assistant-catalog.js";
import { ASSISTANT_TURN_TOOL_NAME, resetAssistantCoreForTests } from "../../modules/assistant/assistant-core.service.js";
import { appendAssistantMessage, createInMemoryAssistantMemoryStore, openAssistantConversation, resetAssistantMemoryForTests } from "../../modules/assistant/assistant-memory.service.js";
import {
  ASSISTANT_PENDING_MAX,
  assistantRoutes,
  parseAssistantChatBody,
  parseAssistantSurface,
  pendingToolCallsWhere,
  resetAssistantRoutesForTests,
  toPendingToolCall,
  toToolListItem
} from "../assistant.routes.js";
import type { AssistantPendingItem } from "../assistant.routes.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de las rutas del asistente");
}) as typeof fetch;

const ARRIVALS_SOURCE = "prisma:Reservation.arrivalDate=today(Property.timezone)";

/** Recepción: reservas, folios y pisos (sin revenue.read ni compliance.read). */
function reception(overrides: Partial<UserContext> = {}): UserContext {
  return {
    organizationId: "org_routes",
    propertyId: "prop_routes",
    userId: "usr_reception",
    fullName: "Recepción",
    deviceId: "dev_routes",
    permissions: ["pms.reservation.read", "folio.read", "housekeeping.read", "ai.tool.execute"],
    ...overrides
  };
}

function localTool(name: string, data: Record<string, unknown>, source: string, calls: string[]): AssistantTool {
  const base = getAssistantTool(name);
  assert.ok(base, `${name} existe en el catálogo`);
  return { ...base, run: async () => { calls.push(name); return { ok: true, data, source, generatedAt: "2026-09-20T10:00:00.000Z" }; } };
}

type Harness = {
  app: FastifyInstance;
  memory: ReturnType<typeof createInMemoryAssistantMemoryStore>;
  rows: RecordToolCallInput[];
  localCalls: string[];
  pending: AssistantPendingItem[];
  pendingScopes: Array<{ organizationId: string; propertyId: string; userId: string }>;
  context: UserContext;
};

async function harness(context: UserContext = reception()): Promise<Harness> {
  const h: Harness = { app: Fastify(), memory: createInMemoryAssistantMemoryStore(), rows: [], localCalls: [], pending: [], pendingScopes: [], context };
  h.app.decorateRequest("userContext", null);
  h.app.addHook("onRequest", async (request) => {
    (request as unknown as { userContext: UserContext }).userContext = { ...h.context, permissions: [...h.context.permissions] };
  });
  await h.app.register(assistantRoutes);
  resetAssistantMemoryForTests(h.memory);
  resetAssistantCoreForTests({
    getAiCore: () => createAiCore({ config: resolveAiConfig({ provider: "none" }) }),
    catalogFor: () => [
      localTool("get_arrivals_today", { count: 3, items: [] }, ARRIVALS_SOURCE, h.localCalls),
      localTool("get_occupancy_today", { occupancyPct: 80, occupiedRooms: 40, totalRooms: 50 }, "prisma:Room+Reservation", h.localCalls)
    ],
    writeToolsFor: () => [],
    runAiTool: async (input) => {
      throw new Error(`runner no esperado para ${input.toolName}`);
    },
    recordToolCall: async (input) => {
      h.rows.push(input);
      return { id: `call_${h.rows.length}` };
    },
    now: () => new Date("2026-09-20T10:00:00.000Z")
  });
  // Guard de tenencia simulado con la MISMA regla que el resolver assistantConversation: solo filas del propio usuario.
  resetAssistantRoutesForTests({
    assertConversationAccess: async (request, id) => {
      const row = await h.memory.findConversation(id);
      if (!row || row.userId !== request.userContext.userId) throw new NotFoundError("Conversación no encontrada.");
      return { organizationId: row.organizationId, propertyId: row.propertyId };
    },
    listPendingToolCalls: async (scope) => {
      h.pendingScopes.push(scope);
      return h.pending;
    }
  });
  await h.app.ready();
  return h;
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  resetAssistantRoutesForTests();
  resetAssistantCoreForTests();
  resetAssistantMemoryForTests();
  await h.app.close();
});

function json(res: { body: string }): any {
  return res.body ? JSON.parse(res.body) : null;
}

describe("assistant.routes · POST /assistant/chat", () => {
  it("400 con pregunta vacía, ausente o solo espacios (mensaje en español, sin turno ni fila)", async () => {
    for (const payload of [{}, { question: "" }, { question: "   " }, { question: 42 }]) {
      const res = await h.app.inject({ method: "POST", url: "/assistant/chat", payload });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).message, "La pregunta no puede estar vacía.");
    }
    assert.equal(h.rows.length, 0, "sin fila answerAnalyticsQuestion");
    assert.equal(h.memory.conversations.length, 0, "sin conversación");
  });

  it("400 con superficie desconocida y con conversationId que no es texto", async () => {
    const surface = await h.app.inject({ method: "POST", url: "/assistant/chat", payload: { question: "hola", surface: "cocina" } });
    assert.equal(surface.statusCode, 400, surface.body);
    assert.match(json(surface).message, /^Superficie desconocida: cocina\./);
    const conversation = await h.app.inject({ method: "POST", url: "/assistant/chat", payload: { question: "hola", conversationId: 7 } });
    assert.equal(conversation.statusCode, 400, conversation.body);
    assert.match(json(conversation).message, /conversationId/);
    assert.equal(h.rows.length, 0);
  });

  it("forma v2 del turno por reglas: surface backoffice por defecto, conversationId, routedBy rules, citas con fuente, coste 0, pendientes vacíos y fila answerAnalyticsQuestion", async () => {
    const res = await h.app.inject({ method: "POST", url: "/assistant/chat", payload: { question: "¿Cuántas llegadas tengo hoy?" }, headers: { "x-correlation-id": "corr_routes_1" } });
    assert.equal(res.statusCode, 200, res.body);
    const turn = json(res);
    assert.equal(turn.question, "¿Cuántas llegadas tengo hoy?");
    assert.equal(typeof turn.answer, "string");
    assert.equal(turn.mode, "deterministic");
    assert.equal(turn.routedBy, "rules");
    assert.equal(turn.surface, "backoffice", "superficie por defecto");
    assert.equal(typeof turn.conversationId, "string");
    assert.equal(turn.correlationId, "corr_routes_1", "la correlación de la cabecera viaja al turno");
    assert.equal(turn.generatedAt, "2026-09-20T10:00:00.000Z");
    assert.deepEqual(h.localCalls, ["get_arrivals_today"]);
    assert.equal(turn.citations.length, 1);
    assert.equal(turn.citations[0].tool, "get_arrivals_today");
    assert.equal(turn.citations[0].source, ARRIVALS_SOURCE);
    assert.equal(turn.citations[0].ok, true);
    assert.equal(turn.citations[0].costEur, 0);
    assert.deepEqual(turn.toolCalls.map((call: { name: string }) => call.name), ["get_arrivals_today"]);
    assert.deepEqual(turn.cost, { model: null, tokensInput: 0, tokensOutput: 0, eur: 0 });
    assert.deepEqual(turn.pendingToolCalls, []);
    assert.deepEqual(turn.notices, []);
    assert.ok(!JSON.stringify(turn).includes('"llm"'));
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0]!.toolName, ASSISTANT_TURN_TOOL_NAME);
    assert.equal(h.rows[0]!.status, "succeeded");
    assert.equal(h.rows[0]!.conversationId, turn.conversationId);
    assert.equal(h.rows[0]!.model, undefined, "sin modelo por reglas");
    assert.equal(h.rows[0]!.costEur, 0);
    assert.equal(h.memory.conversations[0]!.surface, "backoffice");
    assert.equal(h.memory.messages.length, 2);
  });

  it("surface explícita (reception) y conversationId propio: el segundo turno reutiliza la conversación y el contexto de pantalla se guarda", async () => {
    const first = json(await h.app.inject({ method: "POST", url: "/assistant/chat", payload: { question: "¿Cuál es la ocupación ahora mismo?", surface: "reception", screen: { screenKey: "FrontDesk", url: "/recepcion/mi-dia" } } }));
    assert.equal(first.surface, "reception");
    assert.equal(h.memory.conversations[0]!.surface, "reception");
    assert.deepEqual(h.memory.conversations[0]!.screenContext, { screenKey: "FrontDesk", url: "/recepcion/mi-dia" });
    const second = json(await h.app.inject({ method: "POST", url: "/assistant/chat", payload: { question: "¿Cuántas llegadas tengo hoy?", surface: "reception", conversationId: first.conversationId } }));
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(h.memory.conversations.length, 1, "no se abre otra conversación");
    assert.equal(h.memory.messages.length, 4);
    assert.deepEqual(h.localCalls, ["get_occupancy_today", "get_arrivals_today"]);
  });

  it("404 opaco con conversationId de otro usuario o inexistente (nunca se abre ni se responde)", async () => {
    const foreign = await openAssistantConversation({ organizationId: "org_routes", propertyId: "prop_routes", userId: "usr_otra", surface: "backoffice", question: "ajena" });
    for (const conversationId of [foreign.id, "conv_no_existe"]) {
      const res = await h.app.inject({ method: "POST", url: "/assistant/chat", payload: { question: "¿Cuántas llegadas tengo hoy?", conversationId } });
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(json(res).message, "Conversación no encontrada.");
    }
    assert.equal(h.rows.length, 0, "sin fila cuando la conversación es ajena");
    assert.equal(h.memory.messages.length, 0);
  });
});

describe("assistant.routes · GET /assistant/tools", () => {
  it("catálogo real filtrado por las claves del usuario, superficie backoffice por defecto y sugeridas solo de herramientas visibles", async () => {
    const res = await h.app.inject({ method: "GET", url: "/assistant/tools" });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.surface, "backoffice");
    const names = body.items.map((item: { name: string }) => item.name);
    for (const expected of ["get_arrivals_today", "get_open_balance", "get_housekeeping_status", "get_rooms_ready_for_delivery"]) assert.ok(names.includes(expected), `${expected} visible para recepción`);
    for (const hidden of ["get_recent_revenue_snapshot", "get_compliance_summary"]) assert.ok(!names.includes(hidden), `${hidden} exige una clave que recepción no tiene`);
    assert.ok(body.items.every((item: Record<string, unknown>) => typeof item.name === "string" && typeof item.description === "string" && Array.isArray(item.keywords) && ["local", "registry"].includes(String(item.kind)) && typeof item.riskLevel === "string"));
    assert.ok(!body.items.some((item: Record<string, unknown>) => "run" in item || "requiredPermissions" in item), "sin ejecución ni permisos en el wire");
    assert.ok(Array.isArray(body.suggestedQuestions) && body.suggestedQuestions.length > 0);
    const visible = new Set(names);
    assert.ok(body.suggestedQuestions.every((suggestion: { tool: string; question: string }) => visible.has(suggestion.tool) && typeof suggestion.question === "string"), "nunca se sugiere lo que no puede responder");
    assert.ok(!body.suggestedQuestions.some((suggestion: { tool: string }) => suggestion.tool === "get_compliance_summary"));
  });

  it("?surface=reception ordena las sugeridas del copiloto primero, ?surface=guest no lista lecturas de personal y una superficie desconocida es 400", async () => {
    const receptionRes = json(await h.app.inject({ method: "GET", url: "/assistant/tools?surface=reception" }));
    assert.equal(receptionRes.surface, "reception");
    assert.ok(receptionRes.suggestedQuestions[0].id.startsWith("copilot_"), JSON.stringify(receptionRes.suggestedQuestions[0]));
    const guest = json(await h.app.inject({ method: "GET", url: "/assistant/tools?surface=guest" }));
    assert.equal(guest.surface, "guest");
    assert.ok(!guest.items.some((item: { name: string }) => item.name.startsWith("get_") || item.name.startsWith("copilot_")), "las locales son de personal");
    assert.deepEqual(guest.suggestedQuestions, []);
    const bad = await h.app.inject({ method: "GET", url: "/assistant/tools?surface=cocina" });
    assert.equal(bad.statusCode, 400, bad.body);
  });

  it("un usuario sin claves de lectura ve un catálogo vacío (nunca 403: la ruta es authenticated)", async () => {
    h.context = reception({ userId: "usr_sin_claves", permissions: [] });
    const res = await h.app.inject({ method: "GET", url: "/assistant/tools" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).items, []);
    assert.deepEqual(json(res).suggestedQuestions, []);
  });
});

describe("assistant.routes · memoria privada (/assistant/conversations)", () => {
  async function seedConversation(userId: string, surface: "backoffice" | "reception", question: string, propertyId = "prop_routes"): Promise<string> {
    const conversation = await openAssistantConversation({ organizationId: "org_routes", propertyId, userId, surface, question });
    await appendAssistantMessage({ conversationId: conversation.id, role: "user", content: question });
    await appendAssistantMessage({ conversationId: conversation.id, role: "assistant", content: "Respuesta.", routedBy: "rules", costEur: 0, toolCalls: [{ tool: "get_arrivals_today", source: ARRIVALS_SOURCE, ok: true }] });
    return conversation.id;
  }

  it("la lista solo devuelve las del usuario en la propiedad activa, con filtro ?surface= y envelope { items }", async () => {
    const mine = await seedConversation("usr_reception", "backoffice", "mía");
    const mineReception = await seedConversation("usr_reception", "reception", "mía en recepción");
    await seedConversation("usr_otra", "backoffice", "ajena");
    await seedConversation("usr_reception", "backoffice", "mía en otra propiedad", "prop_otra");
    const all = json(await h.app.inject({ method: "GET", url: "/assistant/conversations" }));
    assert.deepEqual(all.items.map((item: { id: string }) => item.id).sort(), [mine, mineReception].sort());
    assert.ok(all.items.every((item: Record<string, unknown>) => typeof item.title === "string" && typeof item.lastMessageAt === "string" && item.messageCount === 2));
    const onlyReception = json(await h.app.inject({ method: "GET", url: "/assistant/conversations?surface=reception" }));
    assert.deepEqual(onlyReception.items.map((item: { id: string }) => item.id), [mineReception]);
    const bad = await h.app.inject({ method: "GET", url: "/assistant/conversations?surface=cocina" });
    assert.equal(bad.statusCode, 400, bad.body);
  });

  it("detalle con mensajes, 404 opaco para la de otro usuario y para un id inexistente, y borrado 204 que la hace desaparecer", async () => {
    const mine = await seedConversation("usr_reception", "backoffice", "mía");
    const foreign = await seedConversation("usr_otra", "backoffice", "ajena");
    const detail = await h.app.inject({ method: "GET", url: `/assistant/conversations/${mine}` });
    assert.equal(detail.statusCode, 200, detail.body);
    const body = json(detail);
    assert.equal(body.id, mine);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ["user", "assistant"]);
    assert.equal(body.messages[1].routedBy, "rules");
    assert.equal(body.messages[1].toolCalls[0].tool, "get_arrivals_today");
    assert.deepEqual(body.messages[1].cost, { model: null, tokensInput: null, tokensOutput: null, eur: 0 });
    assert.equal(body.messages[0].cost, null);
    for (const id of [foreign, "conv_no_existe"]) {
      const res = await h.app.inject({ method: "GET", url: `/assistant/conversations/${id}` });
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(json(res).message, "Conversación no encontrada.");
      const del = await h.app.inject({ method: "DELETE", url: `/assistant/conversations/${id}` });
      assert.equal(del.statusCode, 404, del.body);
    }
    assert.equal(h.memory.conversations.length, 2, "el 404 no borra nada");
    const deleted = await h.app.inject({ method: "DELETE", url: `/assistant/conversations/${mine}` });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(deleted.body, "");
    assert.equal((await h.app.inject({ method: "GET", url: `/assistant/conversations/${mine}` })).statusCode, 404);
    assert.deepEqual(h.memory.conversations.map((row) => row.id), [foreign]);
    assert.ok(h.memory.messages.every((message) => message.conversationId === foreign), "los mensajes de la borrada caen con ella");
  });
});

describe("assistant.routes · GET /assistant/pending y toPendingToolCall", () => {
  it("REV-07: pendingToolCallsWhere incluye las propuestas del propio usuario aunque su conversación ya no exista (huérfanas decidibles), nunca las de otros usuarios", () => {
    const scope = { organizationId: "org_routes", propertyId: "prop_routes", userId: "usr_routes" };
    const where = pendingToolCallsWhere(scope, ["conv_1", "conv_2"]);
    assert.deepEqual(where, {
      organizationId: "org_routes",
      propertyId: "prop_routes",
      status: "awaiting_confirmation",
      confirmedBy: null,
      OR: [{ conversationId: { in: ["conv_1", "conv_2"] } }, { userId: "usr_routes" }]
    });
    // Sin conversaciones (todas borradas) siguen saliendo las propuestas del usuario: nada de `[]` prematuro.
    assert.deepEqual(pendingToolCallsWhere(scope, []).OR, [{ userId: "usr_routes" }]);
  });

  it("consulta los pendientes con el ámbito del usuario en la propiedad activa y responde { items }", async () => {
    h.pending.push({ id: "call_1", toolName: "createWorkOrder", summary: "Abre un parte", riskLevel: "low", createdAt: "2026-09-20T10:00:00.000Z", conversationId: "conv_1", correlationId: null, input: { title: "Grifo" } });
    const res = await h.app.inject({ method: "GET", url: "/assistant/pending" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res), { items: h.pending });
    assert.deepEqual(h.pendingScopes, [{ organizationId: "org_routes", propertyId: "prop_routes", userId: "usr_reception" }]);
    assert.equal(ASSISTANT_PENDING_MAX, 100);
  });

  it("toPendingToolCall: descripción en español y riesgo del registro, entrada REDACTADA (la fila pendiente guarda la ejecutable), correlationId null", () => {
    const item = toPendingToolCall({
      id: "call_wo",
      toolName: "createWorkOrder",
      inputJson: { title: "Grifo que gotea", description: "Avisar al 612 345 678 o a persona@example.com", priority: "normal", blocksRoom: false },
      conversationId: "conv_wo",
      createdAt: new Date("2026-09-20T10:05:00.000Z")
    });
    assert.equal(item.id, "call_wo");
    assert.equal(item.toolName, "createWorkOrder");
    assert.equal(item.riskLevel, "low");
    assert.match(String(item.summary), /parte de mantenimiento/i);
    assert.equal(item.createdAt, "2026-09-20T10:05:00.000Z");
    assert.equal(item.conversationId, "conv_wo");
    assert.equal(item.correlationId, null);
    assert.equal(item.input?.title, "Grifo que gotea");
    assert.equal(item.input?.priority, "normal");
    const description = String(item.input?.description);
    assert.ok(!description.includes("612 345 678") && !description.includes("persona@example.com"), description);
    assert.match(description, /\[TEL_\d+\]/);
    assert.match(description, /\[EMAIL_\d+\]/);
    const unknown = toPendingToolCall({ id: "call_x", toolName: "herramienta_desconocida", inputJson: {}, conversationId: null, createdAt: new Date("2026-09-20T10:06:00.000Z") });
    assert.equal(unknown.summary, null);
    assert.equal(unknown.riskLevel, null);
    assert.equal(unknown.input, null);
  });
});

describe("assistant.routes · funciones puras", () => {
  it("parseAssistantSurface y parseAssistantChatBody", () => {
    assert.equal(parseAssistantSurface(undefined), "backoffice");
    assert.equal(parseAssistantSurface(""), "backoffice");
    assert.equal(parseAssistantSurface("reception"), "reception");
    assert.equal(parseAssistantSurface(undefined, "reception"), "reception");
    assert.throws(() => parseAssistantSurface("cocina"), /Superficie desconocida/);
    assert.deepEqual(parseAssistantChatBody({ question: "  hola   mundo " }), { question: "hola mundo", conversationId: null, surface: "backoffice", screen: undefined });
    assert.deepEqual(parseAssistantChatBody({ question: "x", conversationId: " conv_1 ", surface: "reception", screen: { screenKey: "A" } }), { question: "x", conversationId: "conv_1", surface: "reception", screen: { screenKey: "A" } });
    assert.equal(parseAssistantChatBody({ question: "x", conversationId: "" }).conversationId, null);
    assert.throws(() => parseAssistantChatBody(null), /vacía/);
    assert.throws(() => parseAssistantChatBody({ question: "x", conversationId: {} }), /conversationId/);
  });

  it("toToolListItem expone nombre, descripción, keywords, kind, origin y riskLevel (registro) sin run ni permisos", () => {
    const local = toToolListItem(getAssistantTool("get_arrivals_today")!);
    assert.deepEqual(Object.keys(local).sort(), ["description", "keywords", "kind", "name", "origin", "riskLevel"]);
    assert.equal(local.kind, "local");
    assert.equal(local.riskLevel, "low");
    const registry = toToolListItem(getAssistantTool("findReservation")!);
    assert.equal(registry.kind, "registry");
    assert.equal(registry.origin, "registry");
    assert.equal(typeof registry.riskLevel, "string");
  });
});
