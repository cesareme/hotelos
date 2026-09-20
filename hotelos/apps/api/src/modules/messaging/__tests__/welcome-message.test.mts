// Tanda CHK · W2-D — bienvenida real (`sendWelcomeMessage`) con doble de
// `dispatch`: sin base de datos ni proveedor. Desde apps/api:
//   node --import tsx --test src/modules/messaging/__tests__/welcome-message.test.mts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DispatchInput, NotificationDeliveryRecord } from "../../notifications/dispatcher.service.js";
import { setAuditPersistDepsForTests } from "../../audit/audit.service.js";
import { demoStore, type UserContext } from "../../../lib/demo-store.js";
import {
  DEFAULT_WELCOME_CHANNEL_ORDER,
  WELCOME_TEMPLATE_CODE,
  extractWelcomeFaqDetails,
  formatArrivalDateEs,
  guestBotUrl,
  sendWelcomeMessage,
  type WelcomeMessageDeps
} from "../messaging.service.js";

const context: UserContext = {
  organizationId: "org_test",
  propertyId: "prop_test",
  userId: "usr_test",
  fullName: "Recepción de prueba",
  deviceId: "dev_test",
  permissions: []
};

const NOW = "2026-09-19T12:00:00.000Z";

type Outcome = "sent" | "simulated" | "failed";

/**
 * Doble del dispatcher: decide por canal el resultado (sent / simulated /
 * failed / lanzar) y reproduce la idempotencia real por
 * (organizationId, notificationId, channel, recipient).
 */
function fakeDispatcher(plan: Record<string, Outcome | "throw">) {
  const calls: DispatchInput[] = [];
  const store = new Map<string, NotificationDeliveryRecord>();
  let seq = 0;
  const dispatch = async (input: DispatchInput): Promise<NotificationDeliveryRecord> => {
    calls.push(input);
    const key = `${input.organizationId}|${input.notificationId}|${input.channel}|${input.recipient}`;
    const existing = store.get(key);
    if (existing) return existing;
    const outcome = plan[input.channel] ?? "sent";
    if (outcome === "throw") throw new Error(`template_not_found`);
    seq += 1;
    const record: NotificationDeliveryRecord = {
      id: `del_${seq}`,
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      notificationId: input.notificationId ?? null,
      templateCode: input.templateCode,
      channel: input.channel,
      recipient: input.recipient,
      status: outcome === "failed" ? "failed" : "sent",
      providerMessageId: outcome === "sent" ? `pm_${seq}` : outcome === "simulated" ? `simulated_${seq}` : null,
      subject: null,
      bodyRendered: "cuerpo renderizado",
      payloadJson: { variables: input.variables },
      attempts: 1,
      errorMessage:
        outcome === "simulated" ? "SIMULADO: proveedor no configurado; no se envió de verdad." : outcome === "failed" ? `Fallo simulado del proveedor ${input.channel}.` : null,
      scheduledFor: null,
      sentAt: outcome === "failed" ? null : NOW,
      failedAt: outcome === "failed" ? NOW : null,
      createdAt: NOW,
      updatedAt: NOW
    };
    store.set(key, record);
    return record;
  };
  return { dispatch, calls, store };
}

function deps(overrides: Partial<WelcomeMessageDeps> = {}): Partial<WelcomeMessageDeps> {
  return {
    loadGuest: async () => ({ firstName: "Prueba", email: "prueba@example.test", mobilePhone: "+34 600 000 000", phone: null, languagePreference: "es" }),
    loadReservation: async () => ({ id: "res_1", arrivalDate: new Date("2026-09-20T00:00:00.000Z"), assignedRoomId: "room_312" }),
    loadPropertyName: async () => "Hotel Ensayo",
    loadRoomNumber: async () => "312",
    loadFaq: async () => ({ wifiName: "Ensayo-Guest", wifiPassword: "abc123", breakfastHours: "7:30-10:30" }),
    ...overrides
  };
}

function welcomeAudits() {
  return demoStore.auditEvents.filter((e) => e.action === "GUEST_WELCOME_MESSAGE_SENT" && e.organizationId === "org_test");
}

describe("sendWelcomeMessage — bienvenida real (W2-D)", () => {
  let envBackup: string | undefined;
  beforeEach(() => {
    // Sin base de datos: la auditoría se sella en demoStore y no se persiste.
    setAuditPersistDepsForTests({ auditCreate: async () => undefined, eventCreate: async () => undefined });
    demoStore.auditEvents.length = 0;
    demoStore.events.length = 0;
    envBackup = process.env.GUEST_WEB_BASE_URL;
    delete process.env.GUEST_WEB_BASE_URL;
  });
  afterEach(() => {
    setAuditPersistDepsForTests(null);
    if (envBackup === undefined) delete process.env.GUEST_WEB_BASE_URL;
    else process.env.GUEST_WEB_BASE_URL = envBackup;
  });

  it("recorre el orden de canales y se detiene en el primer sent", async () => {
    const fake = fakeDispatcher({ whatsapp: "failed", email: "sent", sms: "sent" });
    const result = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", roomNumber: "312", correlationId: "corr_1" },
      deps({ dispatch: fake.dispatch })
    );
    assert.deepEqual(result, { status: "sent", channel: "email", deliveryId: "del_2" });
    assert.deepEqual(fake.calls.map((c) => c.channel), ["whatsapp", "email"], "sms nunca se intenta tras un sent");
    assert.deepEqual([...DEFAULT_WELCOME_CHANNEL_ORDER], ["whatsapp", "email", "sms"]);

    const wa = fake.calls[0]!;
    assert.equal(wa.templateCode, WELCOME_TEMPLATE_CODE);
    assert.equal(wa.recipient, "+34600000000", "teléfono normalizado a E.164 sin espacios");
    assert.equal(wa.notificationId, "welcome:res_1:whatsapp");
    assert.equal(wa.organizationId, "org_test");
    assert.equal(wa.propertyId, "prop_test");
    assert.equal(wa.language, "es");
    assert.deepEqual(wa.variables, {
      guestFirstName: "Prueba",
      propertyName: "Hotel Ensayo",
      arrivalDate: "20 de septiembre de 2026",
      roomNumber: "312",
      wifiName: "Ensayo-Guest",
      wifiPassword: "abc123",
      breakfastHours: "7:30-10:30",
      botUrl: "http://localhost:5174/?property=prop_test"
    });
    const email = fake.calls[1]!;
    assert.equal(email.recipient, "prueba@example.test");
    assert.equal(email.notificationId, "welcome:res_1:email");

    const audits = welcomeAudits();
    assert.equal(audits.length, 1);
    const after = audits[0]!.afterJson as Record<string, unknown>;
    assert.equal(after.status, "sent");
    assert.equal(after.simulated, false);
    assert.equal(after.channel, "email");
    assert.equal(after.deliveryId, "del_2");
    assert.deepEqual(after.attempts, [
      { channel: "whatsapp", status: "failed", deliveryId: "del_1", error: "Fallo simulado del proveedor whatsapp." },
      { channel: "email", status: "sent", deliveryId: "del_2" }
    ]);
    assert.equal(JSON.stringify(after).includes("prueba@example.test"), false, "la auditoría no lleva el destinatario");
    assert.equal(audits[0]!.actorType, "system");
    assert.equal(audits[0]!.entityId, "res_1");
    assert.equal(demoStore.events.filter((e) => e.eventType === "GuestMessageSent").length, 1);
  });

  it("respeta un channelOrder propio, cae en la habitación de la reserva y en «es» sin idioma", async () => {
    const fake = fakeDispatcher({ email: "sent" });
    const result = await sendWelcomeMessage(
      { context, reservationId: "res_1", guestId: "gst_1", channelOrder: ["email", "app", "whatsapp"], correlationId: "corr_2" },
      deps({
        dispatch: fake.dispatch,
        loadGuest: async () => ({ firstName: "Prueba", email: "prueba@example.test", mobilePhone: null, phone: "0034 600-000-001", languagePreference: null })
      })
    );
    assert.equal(result.status, "sent");
    assert.equal(result.channel, "email");
    assert.deepEqual(fake.calls.map((c) => c.channel), ["email"]);
    assert.equal(fake.calls[0]!.propertyId, "prop_test", "sin propertyId explícito usa el del contexto");
    assert.equal(fake.calls[0]!.language, "es");
    assert.equal(fake.calls[0]!.variables.roomNumber, "312", "habitación desde reservation.assignedRoomId");
    assert.deepEqual((welcomeAudits()[0]!.afterJson as { channelOrder: string[] }).channelOrder, ["email", "whatsapp"], "canales desconocidos fuera");

    // Cuando el email falla, el fijo con «00» se normaliza a E.164 para whatsapp.
    const fake2 = fakeDispatcher({ email: "failed", whatsapp: "sent" });
    const second = await sendWelcomeMessage(
      { context, reservationId: "res_2", guestId: "gst_1", channelOrder: ["email", "whatsapp"], correlationId: "corr_2b" },
      deps({
        dispatch: fake2.dispatch,
        loadGuest: async () => ({ firstName: "Prueba", email: "prueba@example.test", mobilePhone: null, phone: "0034 600-000-001", languagePreference: null })
      })
    );
    assert.equal(second.channel, "whatsapp");
    assert.equal(fake2.calls[1]!.recipient, "+34600000001");
  });

  it("sin destinatarios → skipped, sin llamar a dispatch, y queda auditado", async () => {
    const fake = fakeDispatcher({});
    const result = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", correlationId: "corr_3" },
      deps({ dispatch: fake.dispatch, loadGuest: async () => ({ firstName: "Prueba", email: "  ", mobilePhone: null, phone: null, languagePreference: "es" }) })
    );
    assert.equal(result.status, "skipped");
    assert.equal(result.channel, "whatsapp");
    assert.match(result.error ?? "", /no tiene email ni teléfono/);
    assert.equal(fake.calls.length, 0);
    const after = welcomeAudits()[0]!.afterJson as Record<string, unknown>;
    assert.equal(after.status, "skipped");
    assert.deepEqual(after.attempts, []);
    assert.equal(demoStore.events.filter((e) => e.eventType === "GuestMessageSent").length, 0, "sin evento de dominio si no se envió");

    // Huésped inexistente en la organización: failed con motivo, sin lanzar.
    const missing = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_otra_org", correlationId: "corr_3b" },
      deps({ dispatch: fake.dispatch, loadGuest: async () => null })
    );
    assert.equal(missing.status, "failed");
    assert.match(missing.error ?? "", /Huésped no encontrado/);
    assert.equal(fake.calls.length, 0);
  });

  it("simulated se refleja en el resultado y en la auditoría (nunca como sent)", async () => {
    const fake = fakeDispatcher({ whatsapp: "simulated" });
    const result = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", correlationId: "corr_4" },
      deps({ dispatch: fake.dispatch })
    );
    assert.deepEqual(result, { status: "simulated", channel: "whatsapp", deliveryId: "del_1" });
    assert.equal(fake.calls.length, 1, "un envío simulado también corta la cadena de canales");
    const after = welcomeAudits()[0]!.afterJson as Record<string, unknown>;
    assert.equal(after.status, "simulated");
    assert.equal(after.simulated, true);
    assert.deepEqual(after.attempts, [{ channel: "whatsapp", status: "simulated", deliveryId: "del_1" }]);
    const event = demoStore.events.find((e) => e.eventType === "GuestMessageSent");
    assert.equal((event?.payload as { simulated?: boolean }).simulated, true);
  });

  it("idempotente por notificationId: repetir la llamada no vuelve a enviar", async () => {
    const fake = fakeDispatcher({ whatsapp: "sent" });
    const input = { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", correlationId: "corr_5" };
    const first = await sendWelcomeMessage(input, deps({ dispatch: fake.dispatch }));
    const second = await sendWelcomeMessage({ ...input, correlationId: "corr_5b" }, deps({ dispatch: fake.dispatch }));
    assert.deepEqual(first, { status: "sent", channel: "whatsapp", deliveryId: "del_1" });
    assert.deepEqual(second, first, "la segunda llamada devuelve la misma entrega");
    assert.equal(fake.store.size, 1, "una sola fila de entrega");
    assert.deepEqual(fake.calls.map((c) => c.notificationId), ["welcome:res_1:whatsapp", "welcome:res_1:whatsapp"]);
    // Otra reserva del mismo huésped sí genera su propia entrega.
    await sendWelcomeMessage({ ...input, reservationId: "res_9", correlationId: "corr_5c" }, deps({ dispatch: fake.dispatch }));
    assert.equal(fake.store.size, 2);
  });

  it("todos los canales fallan → failed con el último motivo; una excepción del dispatcher no se propaga (QC-06)", async () => {
    const fake = fakeDispatcher({ whatsapp: "failed", email: "failed", sms: "failed" });
    const result = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", correlationId: "corr_6" },
      deps({ dispatch: fake.dispatch })
    );
    assert.equal(result.status, "failed");
    assert.equal(result.channel, "sms");
    assert.equal(result.deliveryId, "del_3");
    assert.match(result.error ?? "", /Fallo simulado del proveedor sms/);
    assert.deepEqual(fake.calls.map((c) => c.channel), ["whatsapp", "email", "sms"]);

    const throwing = fakeDispatcher({ whatsapp: "throw" });
    const thrown = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", correlationId: "corr_6b" },
      deps({ dispatch: throwing.dispatch })
    );
    assert.deepEqual(thrown, { status: "failed", channel: "whatsapp", error: "template_not_found" });
    const after = welcomeAudits().at(-1)!.afterJson as Record<string, unknown>;
    assert.equal(after.status, "failed");
    assert.equal(after.error, "template_not_found");

    // Un fallo al leer la FAQ o la habitación tampoco impide la bienvenida.
    const resilient = fakeDispatcher({ whatsapp: "sent" });
    const ok = await sendWelcomeMessage(
      { context, propertyId: "prop_test", reservationId: "res_1", guestId: "gst_1", correlationId: "corr_6c" },
      deps({
        dispatch: resilient.dispatch,
        loadFaq: async () => {
          throw new Error("ai settings caídos");
        },
        loadRoomNumber: async () => {
          throw new Error("room caída");
        }
      })
    );
    assert.equal(ok.status, "sent");
    assert.equal(resilient.calls[0]!.variables.wifiName, "");
    assert.equal(resilient.calls[0]!.variables.roomNumber, "");
  });

  it("extractWelcomeFaqDetails tolera objeto plano, anidado, lista y ausencia", () => {
    assert.deepEqual(extractWelcomeFaqDetails(undefined), { wifiName: "", wifiPassword: "", breakfastHours: "" });
    assert.deepEqual(extractWelcomeFaqDetails("texto"), { wifiName: "", wifiPassword: "", breakfastHours: "" });
    assert.deepEqual(extractWelcomeFaqDetails({ wifi_name: "Red", wifi_password: "clave", breakfast: "8-11" }), { wifiName: "Red", wifiPassword: "clave", breakfastHours: "8-11" });
    assert.deepEqual(extractWelcomeFaqDetails({ wifi: { name: "Red", password: "clave" }, breakfast: { hours: "8-11" } }), { wifiName: "Red", wifiPassword: "clave", breakfastHours: "8-11" });
    assert.deepEqual(
      extractWelcomeFaqDetails([
        { question: "¿Cuál es la contraseña del wifi?", answer: "clave" },
        { question: "¿Nombre de la red wifi?", answer: "Red" },
        { question: "¿Horario del desayuno?", answer: "8-11" },
        { question: "¿Piscina?", answer: "sí" }
      ]),
      { wifiName: "Red", wifiPassword: "clave", breakfastHours: "8-11" }
    );
    assert.equal(formatArrivalDateEs(new Date("2026-12-31T23:30:00.000Z")), "31 de diciembre de 2026", "sin deslizamiento de zona horaria");
    process.env.GUEST_WEB_BASE_URL = "https://stay.example.com/";
    assert.equal(guestBotUrl("prop_test"), "https://stay.example.com/?property=prop_test");
  });
});
