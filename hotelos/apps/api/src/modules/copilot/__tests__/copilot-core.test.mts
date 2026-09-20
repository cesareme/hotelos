// Copiloto de recepción sobre el núcleo conversacional (Tanda L6b · L6b-08): answerCopilot delega en
// runAssistantTurn (superficie reception, contexto de lectura de la propiedad) y conserva EXACTAMENTE
// la forma CopilotAnswer (intent, question, answer, items, suggestions, generatedAt, source, degraded;
// sin `mode` ni `model`). Sin Prisma (resolvers simulados, memoria en memoria, telemetría capturada) ni
// red (ai-core sin proveedor). El catálogo, el router y el RBAC son los reales.
// Run: cd apps/api && node --import tsx --test src/modules/copilot/__tests__/copilot-core.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAiCore, resolveAiConfig } from "@hotelos/ai-core";
import type { RecordToolCallInput } from "@hotelos/ai-core/runner";
import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { NotFoundError } from "../../../lib/http-error.js";
import { ASSISTANT_CATALOG, catalogFor, copilotToolName, getAssistantTool } from "../../assistant/assistant-catalog.js";
import type { AssistantTool } from "../../assistant/assistant-catalog.js";
import { ASSISTANT_TURN_TOOL_NAME, resetAssistantCoreForTests } from "../../assistant/assistant-core.service.js";
import { createInMemoryAssistantMemoryStore, resetAssistantMemoryForTests } from "../../assistant/assistant-memory.service.js";
import { buildServiceContext } from "../../checkin/service-context.js";
import {
  COPILOT_ACTOR,
  COPILOT_PRESET_QUESTIONS,
  COPILOT_READ_PERMISSIONS,
  COPILOT_RESOLVERS,
  COPILOT_SURFACE,
  answerCopilot,
  resetCopilotForTests,
  type CopilotAnswer,
  type CopilotAnswerBody,
  type CopilotResolvedIntent,
  type CopilotResolver
} from "../copilot.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests del copiloto");
}) as typeof fetch;

const INTENTS = Object.keys(COPILOT_RESOLVERS) as CopilotResolvedIntent[];
const ANSWER_KEYS = ["answer", "degraded", "generatedAt", "intent", "items", "question", "source", "suggestions"];
const GENERATED_AT = "2026-09-20T10:00:00.000Z";

/** Contexto de lectura del alias tal como lo construye copilotServiceContext (sin Prisma). */
function readContext(permissions: readonly PermissionKey[] = COPILOT_READ_PERMISSIONS): UserContext {
  return buildServiceContext({ organizationId: "org_cp", propertyId: "prop_cp", actor: COPILOT_ACTOR, permissions });
}

function fakeBody(intent: CopilotResolvedIntent): CopilotAnswerBody {
  return {
    intent,
    question: "",
    answer: `Respuesta de ${intent}.`,
    items: [{ primary: `Fila ${intent}`, secondary: "detalle", badge: "1", actions: [{ label: "Ver", kind: "open_room_rack" }] }],
    suggestions: [{ label: "Abrir Room Rack", kind: "open_room_rack" }],
    generatedAt: GENERATED_AT,
    source: `fake:${intent}`
  };
}

type Harness = { rows: RecordToolCallInput[]; runs: CopilotResolvedIntent[]; memory: ReturnType<typeof createInMemoryAssistantMemoryStore> };

function setup(options: { context?: UserContext; serviceContext?: (propertyId: string) => Promise<UserContext>; resolvers?: Partial<Record<CopilotResolvedIntent, CopilotResolver>>; catalog?: AssistantTool[]; conversationIdFor?: (context: UserContext) => Promise<string | null> } = {}): Harness {
  const harness: Harness = { rows: [], runs: [], memory: createInMemoryAssistantMemoryStore() };
  resetAssistantMemoryForTests(harness.memory);
  resetAssistantCoreForTests({
    getAiCore: () => createAiCore({ config: resolveAiConfig({ provider: "none" }) }),
    ...(options.catalog ? { catalogFor: () => options.catalog! } : {}),
    runAiTool: async (input) => {
      throw new Error(`runner no esperado para ${input.toolName}`);
    },
    recordToolCall: async (input) => {
      harness.rows.push(input);
      return { id: `call_${harness.rows.length}` };
    },
    now: () => new Date(GENERATED_AT)
  });
  const resolvers = Object.fromEntries(
    INTENTS.map((intent) => [
      intent,
      (async () => {
        harness.runs.push(intent);
        return fakeBody(intent);
      }) as CopilotResolver
    ])
  ) as Record<CopilotResolvedIntent, CopilotResolver>;
  resetCopilotForTests({
    serviceContext: options.serviceContext ?? (async () => options.context ?? readContext()),
    ...(options.conversationIdFor ? { conversationIdFor: options.conversationIdFor } : {}),
    resolvers: { ...resolvers, ...options.resolvers },
    now: () => new Date(GENERATED_AT)
  });
  return harness;
}

afterEach(() => {
  resetCopilotForTests();
  resetAssistantCoreForTests();
  resetAssistantMemoryForTests();
});

function assertCopilotShape(answer: CopilotAnswer): void {
  assert.deepEqual(Object.keys(answer).sort(), ANSWER_KEYS, "forma exacta de CopilotAnswer");
  assert.ok(!("mode" in answer) && !("model" in answer), "el copiloto no anuncia ningún modelo");
  assert.ok(!/llm|modelo de lenguaje|claude/i.test(JSON.stringify(answer)), "sin marcas de modelo en la respuesta");
  assert.ok(Array.isArray(answer.items) && Array.isArray(answer.suggestions) && Array.isArray(answer.degraded));
  assert.equal(typeof answer.answer, "string");
  assert.equal(typeof answer.source, "string");
}

describe("copilot-core · presets sobre el núcleo", () => {
  it("cada preset → su intent y forma sin marca de modelo; una fila answerAnalyticsQuestion por turno que cita copilot_<intent> por reglas; una sola conversación del actor por propiedad", async () => {
    const h = setup();
    assert.equal(COPILOT_PRESET_QUESTIONS.length, 10);
    for (const preset of COPILOT_PRESET_QUESTIONS) {
      const answer = await answerCopilot({ propertyId: "prop_cp", question: preset.question, correlationId: `corr_${preset.id}` });
      assertCopilotShape(answer);
      assert.equal(answer.intent, preset.id, `«${preset.question}»`);
      assert.equal(answer.question, preset.question);
      assert.equal(answer.answer, `Respuesta de ${preset.id}.`);
      assert.deepEqual(answer.items, fakeBody(preset.id as CopilotResolvedIntent).items);
      assert.deepEqual(answer.suggestions, fakeBody(preset.id as CopilotResolvedIntent).suggestions);
      assert.equal(answer.source, `fake:${preset.id}`);
      assert.equal(answer.generatedAt, GENERATED_AT);
      assert.deepEqual(answer.degraded, []);
    }
    assert.deepEqual(h.runs, COPILOT_PRESET_QUESTIONS.map((preset) => preset.id), "cada preset ejecuta exactamente su resolver, una vez");

    // Trazabilidad: una fila por turno, del actor de lectura, por reglas, con la cita copilot_<intent> y coste 0.
    assert.equal(h.rows.length, 10);
    for (const [index, row] of h.rows.entries()) {
      const preset = COPILOT_PRESET_QUESTIONS[index]!;
      assert.equal(row.toolName, ASSISTANT_TURN_TOOL_NAME);
      assert.equal(row.status, "succeeded");
      assert.equal(row.organizationId, "org_cp");
      assert.equal(row.propertyId, "prop_cp");
      assert.equal(row.userId, "system:checkin:copilot");
      assert.equal(row.costEur, 0);
      assert.equal(row.model, undefined);
      const output = row.outputJson as { routedBy: string; mode: string; citations: Array<{ tool: string; source: string; ok: boolean }> };
      assert.equal(output.routedBy, "rules");
      assert.equal(output.mode, "deterministic");
      assert.deepEqual(output.citations.map((citation) => citation.tool), [copilotToolName(preset.id as CopilotResolvedIntent)]);
      assert.equal(output.citations[0]!.source, `copilot:fake:${preset.id}`);
      assert.equal(output.citations[0]!.ok, true);
    }

    // Memoria: la conversación del actor en la propiedad se reutiliza (10 turnos → 1 conversación, 20 mensajes).
    assert.equal(h.memory.conversations.length, 1);
    assert.equal(h.memory.conversations[0]!.userId, "system:checkin:copilot");
    assert.equal(h.memory.conversations[0]!.surface, COPILOT_SURFACE);
    assert.equal(h.memory.messages.length, 20);
    assert.ok(h.rows.every((row) => row.conversationId === h.memory.conversations[0]!.id));
  });

  it("fuera de catálogo → unknown / source router (texto histórico, sin ejecutar ningún resolver); pregunta vacía → unknown sin turno", async () => {
    const h = setup();
    for (const question of ["¿me escribes un poema?", "¿qué tiempo hará mañana?"]) {
      const answer = await answerCopilot({ propertyId: "prop_cp", question });
      assertCopilotShape(answer);
      assert.equal(answer.intent, "unknown");
      assert.equal(answer.source, "router");
      assert.match(answer.answer, /^No reconozco esa pregunta\. Prueba con:/);
      assert.deepEqual(answer.items, []);
      assert.deepEqual(answer.suggestions, []);
      assert.deepEqual(answer.degraded, []);
      assert.equal(answer.question, question);
    }
    assert.deepEqual(h.runs, []);
    assert.equal(h.rows.length, 2, "el turno sin herramienta también deja su fila");
    assert.deepEqual((h.rows[0]!.outputJson as { citations: unknown[] }).citations, []);

    const empty = await answerCopilot({ propertyId: "prop_cp", question: "   " });
    assert.equal(empty.intent, "unknown");
    assert.equal(empty.source, "router");
    assert.equal(h.rows.length, 2, "sin pregunta no hay turno del núcleo");
  });

  it("degraded[] conserva las consultas secundarias caídas del resolver (misma semántica que el DegradedCollector del catálogo)", async () => {
    const h = setup({
      resolvers: {
        open_incidents: async (ctx) => {
          const workOrders = await ctx.safe("work_orders", Promise.reject(new Error("tabla rota")), [] as string[]);
          assert.deepEqual(workOrders, [], "el respaldo llega al resolver");
          const rooms = await ctx.safe("rooms", Promise.resolve(["101"]), [] as string[]);
          assert.deepEqual(rooms, ["101"]);
          return fakeBody("open_incidents");
        }
      }
    });
    const originalWarn = console.warn;
    console.warn = () => undefined;
    let answer: CopilotAnswer;
    try {
      answer = await answerCopilot({ propertyId: "prop_cp", question: "¿Qué incidencias siguen abiertas?" });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(answer.intent, "open_incidents");
    assert.deepEqual(answer.degraded, ["work_orders"]);
    assert.equal(answer.source, "fake:open_incidents");
    assert.equal(h.rows.length, 1);
  });

  it("permisos: el contexto de lectura ve exactamente las 10 copilot_<intent> (sin registro ni escrituras) y sin folio.read el resumen del turno no existe → unknown", async () => {
    const visible = catalogFor({ permissions: COPILOT_READ_PERMISSIONS, surface: COPILOT_SURFACE });
    const copilotTools = visible.filter((tool) => tool.origin === "copilot").map((tool) => tool.name);
    assert.deepEqual(copilotTools.sort(), INTENTS.map(copilotToolName).sort(), "COPILOT_READ_PERMISSIONS cubre las 10 herramientas del copiloto");
    assert.ok(visible.every((tool) => tool.kind === "local"), "sin ai.tool.execute no hay herramientas del registro (runner)");
    assert.equal(readContext().userId, "system:checkin:copilot");
    assert.equal(readContext().orgScope, false);

    const withoutFolio = readContext(COPILOT_READ_PERMISSIONS.filter((permission) => permission !== "folio.read"));
    const h = setup({ context: withoutFolio });
    const summary = await answerCopilot({ propertyId: "prop_cp", question: "Resume el turno actual" });
    assert.equal(summary.intent, "unknown", "copilot_shift_summary exige folio.read: el router no la ve");
    assert.equal(summary.source, "router");
    assert.deepEqual(h.runs, []);
    const vips = await answerCopilot({ propertyId: "prop_cp", question: "¿Qué huésped VIP llega hoy?" });
    assert.equal(vips.intent, "vips_arriving", "las lecturas que sí permite siguen respondiendo");
  });

  it("L6B-REV-04: con `context` (el usuario real de POST /copilot/ask) mandan SUS claves y SU memoria; el actor sintético solo cuando la propiedad pedida no es la activa", async () => {
    const h = setup({
      serviceContext: async () => {
        throw new Error("el contexto de servicio no debe usarse cuando viaja el del usuario");
      }
    });
    const staff = buildServiceContext({ organizationId: "org_cp", propertyId: "prop_cp", actor: COPILOT_ACTOR, permissions: COPILOT_READ_PERMISSIONS.filter((permission) => permission !== "folio.read") });
    const withoutFolio = { ...staff, userId: "usr_recepcion", fullName: "Recepción" };
    const summary = await answerCopilot({ propertyId: "prop_cp", question: "Resume el turno actual", context: withoutFolio });
    assert.equal(summary.intent, "unknown", "sin folio.read el catálogo no ve copilot_shift_summary (ni copilot_arrivals_pending_balance)");
    assert.equal(summary.source, "router");
    assert.deepEqual(h.runs, []);
    const vips = await answerCopilot({ propertyId: "prop_cp", question: "¿Qué huésped VIP llega hoy?", context: withoutFolio });
    assert.equal(vips.intent, "vips_arriving");
    assert.deepEqual(h.memory.conversations.map((row) => row.userId), ["usr_recepcion"], "la memoria es la del usuario, no la del actor sintético");
    assert.equal(h.rows[0]!.userId, "usr_recepcion");

    // Propiedad pedida distinta de la activa del contexto: se vuelve al contexto de servicio (404 opaco de existencia).
    await assert.rejects(answerCopilot({ propertyId: "prop_otra", question: "¿Qué huésped VIP llega hoy?", context: withoutFolio }), /contexto de servicio no debe usarse/);
  });

  it("pregunta que enruta a una lectura ajena al copiloto → unknown con la respuesta y la fuente del núcleo (items vacíos)", async () => {
    const arrivals: AssistantTool = { ...getAssistantTool("get_arrivals_today")!, run: async () => ({ ok: true, data: { count: 3, items: [] }, source: "prisma:Reservation.arrivalDate=today", generatedAt: GENERATED_AT }) };
    const copilotTools = ASSISTANT_CATALOG.filter((tool) => tool.origin === "copilot");
    const h = setup({ catalog: [arrivals, ...copilotTools] });
    const answer = await answerCopilot({ propertyId: "prop_cp", question: "¿Cuántas llegadas tengo hoy?" });
    assertCopilotShape(answer);
    assert.equal(answer.intent, "unknown");
    assert.equal(answer.source, "prisma:Reservation.arrivalDate=today");
    assert.match(answer.answer, /3 reservas con llegada hoy/);
    assert.deepEqual(answer.items, []);
    assert.deepEqual(h.runs, []);
    assert.deepEqual((h.rows[0]!.outputJson as { citations: Array<{ tool: string }> }).citations.map((citation) => citation.tool), ["get_arrivals_today"]);
  });

  it("conversación recordada que ya no existe → el turno se repite sin memoria en vez de responder 404", async () => {
    let lookups = 0;
    const h = setup({
      conversationIdFor: async () => {
        lookups += 1;
        return "conv_borrada";
      }
    });
    const answer = await answerCopilot({ propertyId: "prop_cp", question: "Resume el turno actual" });
    assert.equal(answer.intent, "shift_summary");
    assert.equal(lookups, 1);
    assert.equal(h.memory.conversations.length, 1, "abre una conversación nueva");
    assert.equal(h.rows.length, 1);
    // Un 404 que no viene de la memoria (p. ej. propiedad inexistente en el contexto) sí se propaga.
    resetCopilotForTests({ serviceContext: async () => { throw new NotFoundError("Propiedad no encontrada."); } });
    await assert.rejects(answerCopilot({ propertyId: "prop_zz", question: "Resume el turno actual" }), NotFoundError);
  });

  it("COPILOT_RESOLVERS fuera de answerCopilot (panel del asistente) ejecuta el resolver tal cual, sin captura", async () => {
    const h = setup();
    const degraded: string[] = [];
    const body = await COPILOT_RESOLVERS.late_checkouts({
      propertyId: "prop_cp",
      safe: async (label, promise, fallback) => {
        try {
          return await promise;
        } catch {
          degraded.push(label);
          return fallback;
        }
      }
    });
    assert.equal(body.intent, "late_checkouts");
    assert.deepEqual(h.runs, ["late_checkouts"]);
    assert.deepEqual(degraded, []);
    assert.equal(h.rows.length, 0, "sin turno del núcleo no hay fila");
  });
});
