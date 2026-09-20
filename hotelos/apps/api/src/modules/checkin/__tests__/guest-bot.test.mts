// Unit tests · Tanda CHK · lote W4-D — bot del huésped (guest-bot.service.ts) con
// dobles: conversaciones y mensajes en memoria, runner grabado en una lista,
// sin modelo (llmConfigured false → mode "rules"), sin base de datos ni red.
// Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/guest-bot.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserContext } from "../../../lib/demo-store.js";
import { NotFoundError } from "../../../lib/http-error.js";
import { GuestPortalAuthError } from "../../guest-portal/guest-portal.service.js";
import { GUEST_AI_DISCLOSURE } from "../../messaging/messaging.service.js";
import {
  GUEST_BOT_HANDOFF_ACTION,
  GUEST_BOT_HANDOFF_EVENT,
  GUEST_BOT_MAX_UNRESOLVED_TURNS,
  answerFaqByRules,
  classifyByRules,
  detectServiceRequestType,
  extractCodeAndEmail,
  guestLanguageOf,
  handleGuestMessage,
  normalizePhone,
  parseEtaTime,
  type GuestBotConversation,
  type GuestBotDeps,
  type GuestBotMessage,
  type GuestBotReservation,
  type GuestBotSessionSummary
} from "../guest-bot.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests del bot");
}) as typeof fetch;

const PROPERTY = "prop_1";
const OTHER_PROPERTY = "prop_2";
const CONTEXT: UserContext = { organizationId: "org_1", propertyId: PROPERTY, userId: "system:checkin:guest-bot-web", fullName: "Check-in automatizado", deviceId: "checkin", permissions: ["ai.tool.execute", "pms.reservation.read"] as UserContext["permissions"] };

const RESERVATIONS: Record<string, GuestBotReservation> = {
  res_a: { id: "res_a", propertyId: PROPERTY, code: "CHK-A1", status: "confirmed", arrivalDate: "2026-09-20", departureDate: "2026-09-22", eta: null, assignedRoomId: null, adults: 2, children: 0 },
  res_b: { id: "res_b", propertyId: PROPERTY, code: "CHK-B2", status: "confirmed", arrivalDate: "2026-09-21", departureDate: "2026-09-23", eta: "18:00", assignedRoomId: "room_b", adults: 1, children: 0 },
  res_c: { id: "res_c", propertyId: OTHER_PROPERTY, code: "OTRA-9", status: "confirmed", arrivalDate: "2026-09-21", departureDate: "2026-09-23", eta: null, assignedRoomId: null, adults: 1, children: 0 }
};
const SESSIONS: Record<string, GuestBotSessionSummary> = {
  res_a: { id: "ses_a", status: "in_progress", etaDeclared: null, paymentStatus: "none", travellers: 2, missing: [{ ordinal: 1, isPrimary: false, fields: ["documentNumber", "dateOfBirth"] }] }
};

type State = {
  conversations: GuestBotConversation[];
  messages: Array<GuestBotMessage & { conversationId: string; body: string; language: string }>;
  toolCalls: Array<{ toolName: string; input: unknown; conversationId?: string }>;
  audits: Array<{ action: string; entityId?: string; afterJson?: unknown }>;
  events: Array<{ eventType: string; payload: unknown }>;
  etaUpdates: Array<{ reservationId: string; eta: string; token: string | null }>;
  classifications: number;
  deliveries: Array<{ recipient: string; body: string }>;
};

function fakeDeps(overrides: Partial<GuestBotDeps> = {}, options: { aiEnabled?: boolean; llm?: boolean } = {}): { deps: Partial<GuestBotDeps>; state: State } {
  const state: State = { conversations: [], messages: [], toolCalls: [], audits: [], events: [], etaUpdates: [], classifications: 0, deliveries: [] };
  let seq = 0;
  const deps: Partial<GuestBotDeps> = {
    verifyToken: async (token) => (token === "tok_a" ? { reservationId: "res_a", propertyId: PROPERTY, guestId: "guest_a" } : token === "tok_b" ? { reservationId: "res_b", propertyId: PROPERTY, guestId: "guest_b" } : token === "tok_c" ? { reservationId: "res_c", propertyId: OTHER_PROPERTY, guestId: null } : null),
    resolvePhone: async (_propertyId, phone) => (phone === "+34600000001" ? { reservationId: "res_a", guestId: "guest_a" } : null),
    signInByCode: async ({ reservationCode, email }) => (reservationCode === "CHK-A1" && email === "titular@example.test" ? { reservationId: "res_a", guestId: "guest_a" } : null),
    organizationOfProperty: async () => "org_1",
    propertyAi: async () => ({ aiEnabled: options.aiEnabled ?? true, guestFacingDisclosure: null, configurationJson: { faq: { breakfastHours: "07:30 a 10:30", wifiName: "HotelCHK", wifiPassword: "bienvenido", parking: "20 € por noche, bajo reserva" } } }),
    loadReservation: async (id) => RESERVATIONS[id] ?? null,
    roomNumber: async (id) => (id === "room_b" ? "205" : null),
    guestLanguage: async (guestId) => (guestId === "guest_b" ? "en" : "es"),
    loadSession: async (id) => SESSIONS[id] ?? null,
    findConversation: async (id) => state.conversations.find((row) => row.id === id) ?? null,
    findOpenConversation: async ({ propertyId, channel, reservationId, phoneHash }) =>
      state.conversations.find((row) => row.propertyId === propertyId && row.channel === channel && row.status !== "closed" && (reservationId ? row.reservationId === reservationId : phoneHash ? state.messages.some((m) => m.conversationId === row.id && m.metadataJson?.phoneHash === phoneHash) : false)) ?? null,
    createConversation: async (input) => {
      const row: GuestBotConversation = { id: `conv_${++seq}`, ...input, status: "open", aiEnabled: true };
      state.conversations.push(row);
      return row;
    },
    updateConversation: async (id, patch) => {
      const row = state.conversations.find((c) => c.id === id)!;
      Object.assign(row, patch);
    },
    listMessages: async (conversationId) => state.messages.filter((m) => m.conversationId === conversationId),
    findByExternalId: async (externalMessageId) => {
      const found = state.messages.find((m) => m.metadataJson?.externalId === externalMessageId);
      return found ? { conversationId: found.conversationId } : null;
    },
    persistMessage: async (input) => {
      const row = { id: `msg_${++seq}`, conversationId: input.conversationId, senderType: input.senderType, body: input.body, language: input.language, metadataJson: input.metadataJson };
      state.messages.push(row);
      return { id: row.id };
    },
    updateEta: async (input) => {
      state.etaUpdates.push({ reservationId: input.reservationId, eta: input.eta, token: input.token });
    },
    hydrateModules: async () => undefined,
    serviceContext: async () => CONTEXT,
    runTool: (async (input: { toolName: string; input: unknown; conversationId?: string }) => {
      state.toolCalls.push({ toolName: input.toolName, input: input.input, conversationId: input.conversationId });
      return { status: "awaiting_confirmation" as const, toolCallId: `call_${state.toolCalls.length}` };
    }) as unknown as GuestBotDeps["runTool"],
    answerWithModel: async () => null,
    classify: async () => {
      state.classifications += 1;
      return null;
    },
    llmConfigured: () => options.llm ?? false,
    deliverWhatsapp: async (input) => {
      state.deliveries.push(input);
      return { status: "sent", simulated: true };
    },
    audit: ((input: { action: string; entityId?: string; afterJson?: unknown }) => {
      state.audits.push(input);
      return input;
    }) as unknown as GuestBotDeps["audit"],
    domainEvent: ((input: { eventType: string; payload: unknown }) => {
      state.events.push(input);
      return input;
    }) as unknown as GuestBotDeps["domainEvent"],
    now: () => new Date("2026-09-20T10:00:00.000Z"),
    ...overrides
  };
  return { deps, state };
}

const web = (text: string, token = "tok_a", extra: Record<string, unknown> = {}) => ({ channel: "web" as const, propertyId: PROPERTY, token, text, correlationId: "corr_test", ...extra });

describe("utilidades puras", () => {
  it("classifyByRules reconoce las nueve intenciones (español e inglés) y devuelve null sin regla", () => {
    assert.equal(classifyByRules("¿A qué hora es el desayuno?")?.intent, "faq");
    assert.equal(classifyByRules("cual es la contraseña del wifi")?.intent, "faq");
    assert.equal(classifyByRules("¿cuál es el estado de mi reserva?")?.intent, "reservation_status");
    assert.equal(classifyByRules("which room number do I have?")?.intent, "reservation_status");
    assert.equal(classifyByRules("envíame el enlace del check-in online")?.intent, "precheckin_link");
    assert.equal(classifyByRules("llegaremos sobre las 19:30")?.intent, "eta_change");
    assert.equal(classifyByRules("quiero salir tarde mañana")?.intent, "late_checkout");
    assert.equal(classifyByRules("can we do a late check-out?")?.intent, "late_checkout");
    assert.equal(classifyByRules("¿podría tener una habitación superior?")?.intent, "upgrade");
    assert.equal(classifyByRules("necesito toallas extra por favor")?.intent, "service_request");
    assert.equal(classifyByRules("el aire acondicionado no funciona")?.intent, "service_request");
    assert.equal(classifyByRules("quiero poner una queja, es inaceptable")?.intent, "complaint");
    assert.equal(classifyByRules("quiero un reembolso ya")?.intent, "complaint");
    assert.equal(classifyByRules("quiero hablar con una persona")?.intent, "handoff");
    assert.equal(classifyByRules("hola, buenas tardes"), null);
    // La queja gana a cualquier otra regla del mismo texto.
    assert.equal(classifyByRules("queja: el desayuno era horrible")?.intent, "complaint");
  });

  it("parseEtaTime entiende horas explícitas, «a las 5 de la tarde» y «5 pm»; null sin hora", () => {
    assert.equal(parseEtaTime("llegamos a las 17:30"), "17:30");
    assert.equal(parseEtaTime("we arrive around 19.45"), "19:45");
    assert.equal(parseEtaTime("llegaré a las 5 de la tarde"), "17:00");
    assert.equal(parseEtaTime("arriving at 5 pm"), "17:00");
    assert.equal(parseEtaTime("sobre las 18h"), "18:00");
    assert.equal(parseEtaTime("llegaremos más tarde de lo previsto"), null);
  });

  it("detectServiceRequestType, extractCodeAndEmail, normalizePhone y guestLanguageOf", () => {
    assert.equal(detectServiceRequestType("¿me traen dos almohadas más?"), "towels");
    assert.equal(detectServiceRequestType("la ducha gotea"), "maintenance");
    assert.equal(detectServiceRequestType("necesito plaza de parking"), "parking");
    assert.equal(detectServiceRequestType("hola"), null);
    assert.deepEqual(extractCodeAndEmail("Mi reserva es chk-a1 y el correo Titular@Example.test"), { reservationCode: "CHK-A1", email: "titular@example.test" });
    assert.equal(extractCodeAndEmail("titular@example.test"), null);
    assert.equal(normalizePhone("34 600 000 001"), "+34600000001");
    assert.equal(normalizePhone("0034600000001"), "+34600000001");
    assert.equal(guestLanguageOf(undefined, "en-GB"), "en");
    assert.equal(guestLanguageOf("gl", null), "es");
    assert.equal(guestLanguageOf(null, null), "es");
  });

  it("answerFaqByRules solo cita lo que hay en configurationJson.faq y remite a recepción sin dato", () => {
    const faq = { breakfastHours: "07:30 a 10:30", wifi: { name: "HotelCHK", password: "bienvenido" } };
    assert.match(answerFaqByRules("¿a qué hora es el desayuno?", faq, "es"), /07:30 a 10:30/);
    assert.match(answerFaqByRules("what is the wifi password", faq, "en"), /HotelCHK.*bienvenido/);
    assert.match(answerFaqByRules("¿tenéis piscina?", faq, "es"), /recepción/i);
    assert.match(answerFaqByRules("¿a qué hora es el desayuno?", {}, "es"), /Recepción te confirmará/);
  });
});

describe("handleGuestMessage · canal web", () => {
  it("primer mensaje lleva el aviso de IA y el segundo no; la conversación y ambos mensajes se persisten", async () => {
    const { deps, state } = fakeDeps();
    const first = await handleGuestMessage(web("¿a qué hora es el desayuno?"), deps);
    assert.equal(first.disclosureShown, true);
    assert.ok(first.reply.startsWith(GUEST_AI_DISCLOSURE), first.reply);
    assert.equal(first.identified, true);
    assert.equal(state.conversations.length, 1);
    assert.equal(state.conversations[0]!.reservationId, "res_a");
    assert.equal(state.conversations[0]!.channel, "webchat");
    assert.deepEqual(state.messages.map((m) => m.senderType), ["guest", "ai"]);
    assert.equal(state.messages[1]!.metadataJson?.disclosureShown, true);

    const second = await handleGuestMessage(web("¿y el wifi?"), deps);
    assert.equal(second.disclosureShown, false);
    assert.ok(!second.reply.includes(GUEST_AI_DISCLOSURE));
    assert.equal(second.conversationId, first.conversationId, "misma conversación abierta");
    assert.equal(state.messages.length, 4);
  });

  it("intención de lectura responde sin confirmación y con los datos de SU reserva", async () => {
    const { deps, state } = fakeDeps();
    const faq = await handleGuestMessage(web("¿a qué hora es el desayuno?"), deps);
    assert.equal(faq.intent, "faq");
    assert.equal(faq.action, "answered");
    assert.match(faq.reply, /07:30 a 10:30/);
    assert.equal(faq.toolCallId, null);

    const status = await handleGuestMessage(web("¿cuál es el estado de mi reserva?", "tok_b"), deps);
    assert.equal(status.intent, "reservation_status");
    assert.equal(status.language, "en", "idioma del huésped (Guest.languagePreference)");
    assert.match(status.reply, /CHK-B2/);
    assert.match(status.reply, /room 205/);
    assert.doesNotMatch(status.reply, /CHK-A1/);

    const link = await handleGuestMessage(web("envíame el enlace del pre-check-in"), deps);
    assert.equal(link.intent, "precheckin_link");
    assert.match(link.reply, /property=prop_1/);
    assert.match(link.reply, /faltan 2 datos/);
    assert.equal(state.toolCalls.length, 0, "ninguna lectura pasa por una escritura del runner");
  });

  it("escritura (late check-out) crea awaiting_confirmation por el runner y responde «lo hemos pasado a recepción»", async () => {
    const { deps, state } = fakeDeps();
    const result = await handleGuestMessage(web("quiero salir tarde mañana, sobre las 14:00"), deps);
    assert.equal(result.intent, "late_checkout");
    assert.equal(result.action, "pending_confirmation");
    assert.equal(result.toolCallId, "call_1");
    assert.match(result.reply, /pasado a recepción/);
    assert.equal(state.toolCalls.length, 1);
    assert.equal(state.toolCalls[0]!.toolName, "createServiceRequest");
    assert.deepEqual(state.toolCalls[0]!.input, { reservationId: "res_a", guestId: "guest_a", requestType: "late_checkout", assignedDepartment: "reception", note: "Late check-out solicitado por el huésped (web) hasta las 14:00." });
    assert.equal(state.toolCalls[0]!.conversationId, result.conversationId);
    assert.equal(state.messages.at(-1)!.metadataJson?.toolCallId, "call_1");

    const towels = await handleGuestMessage(web("¿me pueden traer toallas extra?"), deps);
    assert.equal(towels.intent, "service_request");
    assert.equal((state.toolCalls[1]!.input as { requestType: string }).requestType, "towels");

    const upgrade = await handleGuestMessage(web("¿podría tener una habitación superior?"), deps);
    assert.equal(upgrade.intent, "upgrade");
    assert.equal(state.toolCalls[2]!.toolName, "sendGuestMessage");
    assert.equal(upgrade.action, "pending_confirmation");
  });

  it("cambiar la ETA es dato del propio huésped: se escribe directamente (sin confirmación) y pide la hora si falta", async () => {
    const { deps, state } = fakeDeps();
    const asked = await handleGuestMessage(web("llegaremos más tarde de lo previsto"), deps);
    assert.equal(asked.intent, "eta_change");
    assert.match(asked.reply, /qué hora/i);
    assert.equal(state.etaUpdates.length, 0);
    const updated = await handleGuestMessage(web("llegamos a las 19:30"), deps);
    assert.equal(updated.action, "updated");
    assert.deepEqual(state.etaUpdates, [{ reservationId: "res_a", eta: "19:30", token: "tok_a" }]);
    assert.equal(state.toolCalls.length, 0);
  });

  it("queja → handoff: conversación marcada, IA apagada en ella, auditoría y evento; el siguiente mensaje ya no lo responde el bot", async () => {
    const { deps, state } = fakeDeps();
    const result = await handleGuestMessage(web("quiero poner una queja: la habitación estaba sucia"), deps);
    assert.equal(result.intent, "complaint");
    assert.equal(result.action, "handoff");
    assert.match(result.reply, /persona del equipo/);
    assert.equal(state.conversations[0]!.status, "handoff");
    assert.equal(state.conversations[0]!.aiEnabled, false);
    assert.equal(state.audits.filter((a) => a.action === GUEST_BOT_HANDOFF_ACTION).length, 1);
    assert.equal(state.events.filter((e) => e.eventType === GUEST_BOT_HANDOFF_EVENT).length, 1);
    assert.equal(state.toolCalls.length, 0);

    const later = await handleGuestMessage(web("¿a qué hora es el desayuno?"), deps);
    assert.equal(later.action, "handoff");
    assert.match(later.reply, /ocupando de tu conversación/);
    assert.equal(state.toolCalls.length, 0);

    const explicit = await handleGuestMessage(web("quiero hablar con una persona", "tok_b"), deps);
    assert.equal(explicit.intent, "handoff");
    assert.equal(explicit.action, "handoff");
  });

  it("sin clave: mode rules siempre, el clasificador del modelo no se llama y tras 2 turnos sin resolver deriva a una persona", async () => {
    const { deps, state } = fakeDeps();
    const one = await handleGuestMessage(web("hola, buenas tardes"), deps);
    assert.equal(one.mode, "rules");
    assert.equal(one.intent, "unknown");
    assert.equal(one.action, "answered");
    assert.match(one.reply, /No estoy seguro/);
    const two = await handleGuestMessage(web("pues eso"), deps);
    assert.equal(two.action, "answered");
    const three = await handleGuestMessage(web("???"), deps);
    assert.equal(three.action, "handoff", `tras ${GUEST_BOT_MAX_UNRESOLVED_TURNS} turnos sin resolver`);
    assert.equal(state.classifications, 0, "sin clave nunca se clasifica con el modelo");
    for (const message of state.messages.filter((m) => m.senderType === "ai")) assert.equal(message.metadataJson?.mode, "rules");
  });

  it("con clave: la clasificación del modelo con confianza < 0,85 deriva; ≥ 0,85 responde con mode llm", async () => {
    const low = fakeDeps({ classify: async () => ({ label: "faq", confidence: 0.6 }) }, { llm: true });
    const derived = await handleGuestMessage(web("hola, buenas tardes"), low.deps);
    assert.equal(derived.action, "handoff");
    assert.equal(derived.mode, "llm");
    const high = fakeDeps({ classify: async () => ({ label: "reservation_status", confidence: 0.93 }) }, { llm: true });
    const answered = await handleGuestMessage(web("hola, buenas tardes"), high.deps);
    assert.equal(answered.intent, "reservation_status");
    assert.equal(answered.mode, "llm");
    assert.match(answered.reply, /CHK-A1/);
  });

  it("IA desactivada en la propiedad: lecturas por reglas sin modelo, escrituras a recepción sin runner", async () => {
    const { deps, state } = fakeDeps({}, { aiEnabled: false, llm: true });
    const read = await handleGuestMessage(web("¿a qué hora es el desayuno?"), deps);
    assert.equal(read.action, "answered");
    assert.equal(read.mode, "rules");
    assert.match(read.reply, /07:30 a 10:30/);
    const write = await handleGuestMessage(web("quiero salir tarde mañana"), deps);
    assert.equal(write.action, "disabled");
    assert.equal(state.toolCalls.length, 0);
    assert.equal(state.classifications, 0);
  });

  it("nunca responde datos de otra reserva: token de otra propiedad → 401, conversación de otra reserva → 404, token inválido → 401", async () => {
    const { deps, state } = fakeDeps();
    await assert.rejects(handleGuestMessage(web("¿cuál es el estado de mi reserva?", "tok_c"), deps), GuestPortalAuthError);
    await assert.rejects(handleGuestMessage(web("¿cuál es el estado de mi reserva?", "tok_zzz"), deps), GuestPortalAuthError);
    const b = await handleGuestMessage(web("¿cuál es el estado de mi reserva?", "tok_b"), deps);
    await assert.rejects(handleGuestMessage(web("¿cuál es el estado de mi reserva?", "tok_a", { conversationId: b.conversationId }), deps), NotFoundError);
    const a = await handleGuestMessage(web("¿cuál es el estado de mi reserva?", "tok_a"), deps);
    assert.notEqual(a.conversationId, b.conversationId);
    assert.doesNotMatch(a.reply, /CHK-B2|205/);
    assert.equal(state.messages.filter((m) => m.conversationId === b.conversationId).length, 2);
  });
});

describe("handleGuestMessage · canal whatsapp", () => {
  const wa = (text: string, phone = "+34600000009", externalMessageId = `wamid_${text.length}_${phone.slice(-3)}`) => ({ channel: "whatsapp" as const, propertyId: PROPERTY, phone, text, externalMessageId, correlationId: "corr_wa" });

  it("número sin reserva: pide código y correo, no responde datos de nadie, y con ambos identifica por el sign-in del portal", async () => {
    const { deps, state } = fakeDeps();
    const first = await handleGuestMessage(wa("¿cuál es el estado de mi reserva?"), deps);
    assert.equal(first.identified, false);
    assert.equal(first.action, "identify");
    assert.match(first.reply, /código de reserva/);
    assert.doesNotMatch(first.reply, /CHK-A1|CHK-B2/);
    assert.ok(first.reply.startsWith(GUEST_AI_DISCLOSURE));
    assert.equal(state.conversations[0]!.reservationId, null);
    assert.equal(typeof state.messages[0]!.metadataJson?.phoneHash, "string", "solo el hash del número en los metadatos");
    assert.ok(!JSON.stringify(state.messages.map((m) => m.metadataJson)).includes("600000009"), "el número nunca se persiste en claro");
    assert.deepEqual(state.deliveries.map((d) => d.recipient), ["+34600000009"]);

    const wrong = await handleGuestMessage(wa("CHK-B2 otro@example.test", "+34600000009", "wamid_wrong"), deps);
    assert.equal(wrong.action, "identify");
    assert.match(wrong.reply, /No encuentro/);

    const ok = await handleGuestMessage(wa("mi reserva es CHK-A1 y el correo titular@example.test", "+34600000009", "wamid_ok"), deps);
    assert.equal(ok.identified, true);
    assert.equal(ok.action, "identify");
    assert.match(ok.reply, /CHK-A1/);
    assert.equal(ok.conversationId, first.conversationId, "hereda la conversación del número");
    assert.equal(state.conversations[0]!.reservationId, "res_a");
  });

  it("número con reserva activa se resuelve por el hash del teléfono y responde; un mensaje duplicado (mismo message.id) se procesa una sola vez", async () => {
    const { deps, state } = fakeDeps();
    const first = await handleGuestMessage(wa("¿cuál es el estado de mi reserva?", "+34600000001", "wamid_1"), deps);
    assert.equal(first.identified, true);
    assert.match(first.reply, /CHK-A1/);
    assert.equal(first.delivery?.status, "simulated");
    const again = await handleGuestMessage(wa("¿cuál es el estado de mi reserva?", "+34600000001", "wamid_1"), deps);
    assert.equal(again.duplicate, true);
    assert.equal(again.action, "duplicate");
    assert.equal(again.messageId, null);
    assert.equal(state.messages.length, 2, "el duplicado no persiste ni responde");
    assert.equal(state.deliveries.length, 1);
    const late = await handleGuestMessage(wa("quiero salir tarde", "+34600000001", "wamid_2"), deps);
    assert.equal(late.action, "pending_confirmation");
    assert.equal((state.toolCalls[0]!.input as { note: string }).note, "Late check-out solicitado por el huésped (whatsapp).");
  });

  it("cambiar la ETA por WhatsApp escribe sin token (escritura directa auditada)", async () => {
    const { deps, state } = fakeDeps();
    const result = await handleGuestMessage(wa("llegamos sobre las 21:15", "+34600000001", "wamid_eta"), deps);
    assert.equal(result.action, "updated");
    assert.deepEqual(state.etaUpdates, [{ reservationId: "res_a", eta: "21:15", token: null }]);
  });
});
