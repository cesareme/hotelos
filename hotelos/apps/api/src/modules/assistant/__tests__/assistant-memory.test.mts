// Memoria de conversación del asistente unificado (Tanda L6b · L6b-05) sobre el almacén en
// memoria (sin Prisma): privada por usuario y propiedad, últimos 10 mensajes como contexto,
// título recortado, list/get/delete y conversión a turnos del modelo.
// Run: cd apps/api && node --import tsx --test src/modules/assistant/__tests__/assistant-memory.test.mts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NotFoundError } from "../../../lib/http-error.js";
import { readFileSync } from "node:fs";
import {
  ASSISTANT_MEMORY_WINDOW,
  ASSISTANT_RETENTION_DAYS,
  ASSISTANT_TITLE_MAX,
  appendAssistantMessage,
  createInMemoryAssistantMemoryStore,
  deleteAssistantConversation,
  eraseAssistantConversationsOfUsers,
  getAssistantConversation,
  listAssistantConversations,
  memoryToModelMessages,
  openAssistantConversation,
  purgeAssistantConversations,
  recentAssistantMessages,
  resetAssistantMemoryForTests,
  retentionCutoff,
  titleFromQuestion
} from "../assistant-memory.service.js";

const A = { organizationId: "org_mem", propertyId: "prop_a", userId: "usr_a" };
const B_USER = { ...A, userId: "usr_b" };
const B_PROPERTY = { ...A, propertyId: "prop_b" };
const B_ORG = { ...A, organizationId: "org_otra" };

let store = createInMemoryAssistantMemoryStore();

beforeEach(() => {
  store = createInMemoryAssistantMemoryStore();
  resetAssistantMemoryForTests(store);
});
afterEach(() => resetAssistantMemoryForTests());

describe("assistant-memory · privada por usuario y propiedad", () => {
  it("otro usuario, otra propiedad u otra organización no ven, no reabren ni borran la conversación aunque conozcan el id", async () => {
    const conversation = await openAssistantConversation({ ...A, surface: "backoffice", question: "¿Cuántas llegadas tengo hoy?", screen: { screenKey: "reception.today" } });
    await appendAssistantMessage({ conversationId: conversation.id, role: "user", content: "¿Cuántas llegadas tengo hoy?" });
    await appendAssistantMessage({ conversationId: conversation.id, role: "assistant", content: "3 llegadas.", routedBy: "rules", costEur: 0 });

    for (const scope of [B_USER, B_PROPERTY, B_ORG]) {
      assert.equal(await getAssistantConversation({ ...scope, conversationId: conversation.id }), null, JSON.stringify(scope));
      assert.deepEqual(await listAssistantConversations(scope), [], JSON.stringify(scope));
      await assert.rejects(openAssistantConversation({ ...scope, surface: "backoffice", conversationId: conversation.id, question: "otra" }), NotFoundError);
      assert.equal(await deleteAssistantConversation({ ...scope, conversationId: conversation.id }), false);
    }
    assert.equal(store.conversations.length, 1, "nadie ajeno la borró");

    const own = await getAssistantConversation({ ...A, conversationId: conversation.id });
    assert.ok(own);
    assert.equal(own.id, conversation.id);
    assert.equal(own.title, "¿Cuántas llegadas tengo hoy?");
    assert.equal(own.messageCount, 2);
    assert.deepEqual(own.messages.map((m) => m.role), ["user", "assistant"]);
    assert.deepEqual(own.messages[1]!.cost, { model: null, tokensInput: null, tokensOutput: null, eur: 0 });
    assert.equal(own.messages[0]!.cost, null);
    assert.deepEqual(own.screenContext, { screenKey: "reception.today" });
    const listed = await listAssistantConversations(A);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.messageCount, 2);
    assert.deepEqual(await listAssistantConversations({ ...A, surface: "reception" }), [], "filtro por superficie");
    const reopened = await openAssistantConversation({ ...A, surface: "backoffice", conversationId: conversation.id, question: "ignorada", screen: { screenKey: "pms.reservation", entity: { type: "reservation", id: "res_1" } } });
    assert.equal(reopened.id, conversation.id);
    assert.deepEqual(reopened.screenContext, { screenKey: "pms.reservation", entity: { type: "reservation", id: "res_1" } }, "el contexto de pantalla se actualiza al reabrir");
    assert.equal(await deleteAssistantConversation({ ...A, conversationId: conversation.id }), true);
    assert.equal(store.conversations.length, 0);
    assert.equal(store.messages.length, 0, "los mensajes caen con la conversación (cascada)");
    assert.equal(await deleteAssistantConversation({ ...A, conversationId: conversation.id }), false);
  });

  it("listado ordenado por último mensaje y acotado", async () => {
    const first = await openAssistantConversation({ ...A, surface: "backoffice", question: "primera" });
    const second = await openAssistantConversation({ ...A, surface: "reception", question: "segunda" });
    await appendAssistantMessage({ conversationId: first.id, role: "user", content: "más reciente", createdAt: new Date(Date.now() + 60_000) });
    const listed = await listAssistantConversations(A);
    assert.deepEqual(listed.map((c) => c.id), [first.id, second.id]);
    assert.deepEqual((await listAssistantConversations({ ...A, limit: 1 })).map((c) => c.id), [first.id]);
  });
});

describe("assistant-memory · retención y supresión RGPD (corrector L6b · L6B-REV-07)", () => {
  const NOW = new Date("2026-09-20T10:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("purgeAssistantConversations borra (con sus mensajes) las conversaciones con last_message_at anterior a la retención, de cualquier usuario y superficie", async () => {
    const stale = await openAssistantConversation({ ...A, surface: "backoffice", question: "antigua" });
    await appendAssistantMessage({ conversationId: stale.id, role: "user", content: "antigua", createdAt: new Date(NOW.getTime() - 91 * DAY_MS) });
    const staleOther = await openAssistantConversation({ ...B_USER, surface: "guest", question: "otra antigua" });
    await appendAssistantMessage({ conversationId: staleOther.id, role: "user", content: "x", createdAt: new Date(NOW.getTime() - 400 * DAY_MS) });
    const fresh = await openAssistantConversation({ ...A, surface: "reception", question: "reciente" });
    await appendAssistantMessage({ conversationId: fresh.id, role: "user", content: "reciente", createdAt: new Date(NOW.getTime() - 89 * DAY_MS) });
    assert.equal(store.messages.length, 3);

    const result = await purgeAssistantConversations({ now: NOW });
    assert.equal(result.retentionDays, ASSISTANT_RETENTION_DAYS);
    assert.equal(result.cutoff, retentionCutoff(NOW, ASSISTANT_RETENTION_DAYS).toISOString());
    assert.equal(result.deleted, 2);
    assert.deepEqual(store.conversations.map((row) => row.id), [fresh.id]);
    assert.deepEqual(store.messages.map((row) => row.conversationId), [fresh.id], "los mensajes de las purgadas caen con ellas");
    assert.equal(await getAssistantConversation({ ...A, conversationId: stale.id }), null);

    // Retención explícita (p. ej. ASSISTANT_MEMORY_RETENTION_DAYS=30) y valores inválidos → defecto.
    assert.equal((await purgeAssistantConversations({ now: NOW, retentionDays: 30 })).deleted, 1);
    assert.equal((await purgeAssistantConversations({ now: NOW, retentionDays: 0 })).retentionDays, ASSISTANT_RETENTION_DAYS);
    assert.equal(retentionCutoff(NOW, Number.NaN).toISOString(), new Date(NOW.getTime() - ASSISTANT_RETENTION_DAYS * DAY_MS).toISOString());
  });

  it("eraseAssistantConversationsOfUsers borra las conversaciones de los actores guest:<id> de la organización (y solo esas)", async () => {
    const guestScope = { ...A, userId: "guest:conv_1" };
    const guest = await openAssistantConversation({ ...guestScope, surface: "guest", question: "hola" });
    await appendAssistantMessage({ conversationId: guest.id, role: "user", content: "hola" });
    const otherGuest = await openAssistantConversation({ ...A, userId: "guest:conv_2", surface: "guest", question: "otro" });
    const staff = await openAssistantConversation({ ...A, surface: "reception", question: "personal" });
    const sameActorOtherOrg = await openAssistantConversation({ ...B_ORG, userId: "guest:conv_1", surface: "guest", question: "otra org" });

    assert.equal(await eraseAssistantConversationsOfUsers({ organizationId: A.organizationId, userIds: ["guest:conv_1", "guest:conv_sin_hilo"] }), 1);
    assert.deepEqual(store.conversations.map((row) => row.id).sort(), [otherGuest.id, sameActorOtherOrg.id, staff.id].sort());
    assert.equal(store.messages.length, 0);
    assert.equal(await eraseAssistantConversationsOfUsers({ organizationId: A.organizationId, userIds: [] }), 0);
  });

  it("la supresión RGPD (gdpr.service.ts) y el scheduler del API (server.ts) usan estas funciones", () => {
    const gdpr = readFileSync(new URL("../../gdpr/gdpr.service.ts", import.meta.url), "utf8");
    assert.match(gdpr, /eraseAssistantConversationsOfUsers\(\{ organizationId: request\.organizationId, userIds: conversationIds\.map\(\(id\) => `guest:\$\{id\}`\) \}\)/);
    assert.match(gdpr, /name: "AssistantConversation"/);
    assert.match(gdpr, /prisma\.assistantMessage\.findMany/, "el dosier DSAR incluye el hilo del huésped");
    const server = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");
    assert.match(server, /ASSISTANT_MEMORY_PURGE_DISABLED/);
    assert.match(server, /purgeAssistantConversations\(\{ retentionDays \}\)/);
    assert.match(server, /schedulerLeader && process\.env\.ASSISTANT_MEMORY_PURGE_DISABLED !== "true"/, "bajo el líder de schedulers, como SES/VeriFactu");
    assert.match(server, /holdsSchedulerLease\(\)\)\) return;\n\s+const r = await purgeAssistantConversations/);
  });
});

describe("assistant-memory · últimos 10 y contexto del modelo", () => {
  it(`recentAssistantMessages devuelve los ${ASSISTANT_MEMORY_WINDOW} más recientes en orden cronológico`, async () => {
    const conversation = await openAssistantConversation({ ...A, surface: "backoffice", question: "p1" });
    for (let i = 1; i <= 13; i += 1) {
      await appendAssistantMessage({ conversationId: conversation.id, role: i % 2 === 1 ? "user" : "assistant", content: `m${i}`, createdAt: new Date(1_700_000_000_000 + i * 1000) });
    }
    const recent = await recentAssistantMessages(conversation.id);
    assert.equal(recent.length, ASSISTANT_MEMORY_WINDOW);
    assert.deepEqual(recent.map((m) => m.content), ["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13"]);
    assert.equal((await recentAssistantMessages(conversation.id, 3)).map((m) => m.content).join(","), "m11,m12,m13");
    const view = await getAssistantConversation({ ...A, conversationId: conversation.id });
    assert.equal(view?.messages.length, 13);
    assert.equal(view?.messageCount, 13);
    assert.equal(store.conversations[0]!.lastMessageAt.getTime(), 1_700_000_000_000 + 13_000, "last_message_at sigue al último mensaje");
  });

  it("memoryToModelMessages: solo user/assistant, contiguos del mismo rol fusionados, nunca arranca por assistant, vacíos fuera", () => {
    const base = { id: "", conversationId: "c", toolCalls: [], routedBy: null, model: null, tokensInput: null, tokensOutput: null, costEur: null, createdAt: new Date() };
    const turns = memoryToModelMessages([
      { ...base, role: "assistant", content: "huérfano" },
      { ...base, role: "user", content: "hola" },
      { ...base, role: "tool", content: "traza" },
      { ...base, role: "user", content: "¿y hoy?" },
      { ...base, role: "assistant", content: "  " },
      { ...base, role: "assistant", content: "3 llegadas." }
    ]);
    assert.deepEqual(turns, [
      { role: "user", content: "hola\n\n¿y hoy?" },
      { role: "assistant", content: "3 llegadas." }
    ]);
    assert.deepEqual(memoryToModelMessages([]), []);
  });

  it("titleFromQuestion: primera pregunta recortada", () => {
    assert.equal(titleFromQuestion("  ¿Cuántas   llegadas\n tengo hoy? "), "¿Cuántas llegadas tengo hoy?");
    const long = "x".repeat(ASSISTANT_TITLE_MAX + 20);
    const title = titleFromQuestion(long);
    assert.equal(title.length, ASSISTANT_TITLE_MAX);
    assert.ok(title.endsWith("…"));
    assert.equal(titleFromQuestion("   "), "Conversación");
  });
});
