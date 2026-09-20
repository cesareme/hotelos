/**
 * Tanda CHK · lote W4-D — webhook de entrada de WhatsApp (diseño §2.6, §5 «Bot del
 * huésped», §7.2 última fila): GET/POST /webhooks/whatsapp sobre Postgres real con
 * una organización AISLADA (helpers/l2-tenant.mts). Sin proveedor de IA (respuestas
 * por reglas) ni proveedor de WhatsApp (entrega SIMULADA).
 *
 * Qué fija:
 *   · GET verify devuelve hub.challenge con el verify token correcto; 403 con otro; 503 sin variable;
 *   · POST sin firma válida → 401 WHATSAPP_SIGNATURE_INVALID; sin secreto en producción → 503;
 *   · un mensaje duplicado (mismo message.id) se procesa UNA vez (processed 1 · duplicates 1;
 *     2 mensajes en la conversación, no 4);
 *   · un número sin reserva recibe el aviso de IA y la petición de código + correo, sin datos de nadie,
 *     y el número nunca se persiste en claro (solo su hash);
 *   · un número con reserva activa (Guest.phone → phoneLookupHash) se resuelve y lee SU reserva;
 *   · un phone_number_id sin propiedad se ignora (200, ignored);
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/whatsapp-webhook.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { signWhatsappPayload } = await import("../../apps/api/src/routes/webhooks-whatsapp.routes.js");
const { GUEST_AI_DISCLOSURE } = await import("../../apps/api/src/modules/messaging/messaging.service.js");
const { todayInTimezone } = await import("../../apps/api/src/modules/pms/pms.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Reply = { status: number; body: any; raw: string };

const RUN = `wawh${newRunId()}`;
const SECRET = `secret-${RUN}`;
const VERIFY_TOKEN = `verify-${RUN}`;
const PHONE_NUMBER_ID = `wa_phone_${RUN}`;
const KNOWN_PHONE = "+34600000771";
const UNKNOWN_PHONE = "+34600000772";
/** Webhook: rutas públicas (sin JWT); NODE_ENV≠production para que el proveedor de WhatsApp simule la entrega. */
const WEBHOOK_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development", WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, AI_PROVIDER: undefined };

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let reservationId = "";

async function call(method: "GET" | "POST", url: string, options: { payload?: string; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}): Promise<Reply> {
  const res = await withEnv(options.env ?? WEBHOOK_ENV, () =>
    app.inject({ method, url, headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...(options.payload !== undefined ? { payload: options.payload } : {}) })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

function inbound(input: { from: string; text: string; messageId: string; phoneNumberId?: string }): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: `waba_${RUN}`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "34900000000", phone_number_id: input.phoneNumberId ?? PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Contacto" }, wa_id: input.from.replace(/\D/g, "") }],
              messages: [{ from: input.from.replace(/\D/g, ""), id: input.messageId, timestamp: "1758300000", type: "text", text: { body: input.text } }]
            }
          }
        ]
      }
    ]
  });
}

const signed = (payload: string) => ({ "x-hub-signature-256": signWhatsappPayload(payload, SECRET) });

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "ai_concierge"]);
  await prisma.propertyAiSetting.upsert({
    where: { propertyId: A.propertyA },
    create: { propertyId: A.propertyA, aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", voiceLocales: ["es-ES"], configurationJson: { whatsappPhoneId: PHONE_NUMBER_ID, faq: { breakfastHours: "07:30 a 10:30" } } },
    update: { aiEnabled: true, configurationJson: { whatsappPhoneId: PHONE_NUMBER_ID, faq: { breakfastHours: "07:30 a 10:30" } } }
  });
  // Huésped con teléfono (Guest.phone → phoneLookupHash) y reserva activa: llegada hoy, salida en 2 días.
  const arrival = todayInTimezone("Europe/Madrid");
  const departure = new Date(`${arrival}T00:00:00.000Z`);
  departure.setUTCDate(departure.getUTCDate() + 2);
  const guest = await prisma.guest.create({ data: { id: `guest_${RUN}_wa`, organizationId: A.organizationId, firstName: "Prueba", surname1: "WhatsApp", languagePreference: "es", phone: KNOWN_PHONE, email: `wa.${RUN}@chk.test` }, select: { id: true } });
  const reservation = await prisma.reservation.create({
    data: { propertyId: A.propertyA, code: `CHK-WA-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date(`${arrival}T00:00:00.000Z`), departureDate: departure, adults: 1, children: 0, roomTypeId: A.roomTypeA, totalAmount: "100.00", currency: "EUR" },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: guest.id, isPrimary: true } });
  app = await buildApiServer();
  await app.ready();
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("GET /webhooks/whatsapp · verificación de Meta", () => {
  it("devuelve hub.challenge en texto plano con el verify token correcto; 403 con otro; 503 sin variable", async () => {
    const ok = await call("GET", `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1234567890`);
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.raw, "1234567890");
    const wrong = await call("GET", `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`);
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body?.details?.code, "WHATSAPP_VERIFY_TOKEN_INVALID");
    const unset = await call("GET", `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1`, { env: { ...WEBHOOK_ENV, WHATSAPP_VERIFY_TOKEN: undefined } });
    assert.equal(unset.status, 503);
    assert.equal(unset.body?.details?.code, "WHATSAPP_WEBHOOK_NOT_CONFIGURED");
  });
});

describe("POST /webhooks/whatsapp · firma, deduplicación e identificación", () => {
  it("firma inválida → 401; sin secreto → 503 en cualquier entorno salvo WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1 fuera de producción → simulated (corrector SEC-5)", async () => {
    const payload = inbound({ from: UNKNOWN_PHONE, text: "hola", messageId: `wamid.${RUN}.sig` });
    const bad = await call("POST", "/webhooks/whatsapp", { payload, headers: { "x-hub-signature-256": "sha256=deadbeef" } });
    assert.equal(bad.status, 401, bad.raw);
    assert.equal(bad.body?.details?.code, "WHATSAPP_SIGNATURE_INVALID");
    const none = await call("POST", "/webhooks/whatsapp", { payload });
    assert.equal(none.status, 401, "sin cabecera tampoco se acepta");
    const production = await call("POST", "/webhooks/whatsapp", { payload, env: { ...WEBHOOK_ENV, NODE_ENV: "production", WHATSAPP_APP_SECRET: undefined } });
    assert.equal(production.status, 503, production.raw);
    assert.equal(production.body?.details?.code, "WHATSAPP_WEBHOOK_NOT_CONFIGURED");
    assert.equal(await prisma.message.count({ where: { metadataJson: { path: ["externalId"], equals: `wamid.${RUN}.sig` } } }), 0, "nada persistido sin firma válida");
    // Corrector SEC-5: sin secreto y sin la variable explícita, TAMBIÉN fuera de producción → 503 (como el webhook de pagos).
    const devRefused = await call("POST", "/webhooks/whatsapp", { payload, env: { ...WEBHOOK_ENV, WHATSAPP_APP_SECRET: undefined, WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: undefined } });
    assert.equal(devRefused.status, 503, devRefused.raw);
    assert.equal(devRefused.body?.details?.code, "WHATSAPP_WEBHOOK_NOT_CONFIGURED");
    // La variable no vale en producción.
    const prodFlag = await call("POST", "/webhooks/whatsapp", { payload, env: { ...WEBHOOK_ENV, NODE_ENV: "production", WHATSAPP_APP_SECRET: undefined, WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "1" } });
    assert.equal(prodFlag.status, 503, prodFlag.raw);
    // Fuera de producción, sin secreto y con WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1: SIMULADO (número sin propiedad conocida → ignorado).
    const simulated = await call("POST", "/webhooks/whatsapp", { payload: inbound({ from: UNKNOWN_PHONE, text: "hola", messageId: `wamid.${RUN}.sim`, phoneNumberId: "sin_propiedad" }), env: { ...WEBHOOK_ENV, WHATSAPP_APP_SECRET: undefined, WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: "1" } });
    assert.equal(simulated.status, 200, simulated.raw);
    assert.equal(simulated.body.simulated, true);
    assert.equal(simulated.body.ignored, 1);
  });

  it("número sin reserva: aviso de IA + petición de código y correo, sin datos de nadie; el número solo como hash", async () => {
    const payload = inbound({ from: UNKNOWN_PHONE, text: "¿cuál es el estado de mi reserva?", messageId: `wamid.${RUN}.unknown1` });
    const res = await call("POST", "/webhooks/whatsapp", { payload, headers: signed(payload) });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual({ received: res.body.received, processed: res.body.processed, duplicates: res.body.duplicates, ignored: res.body.ignored, failed: res.body.failed, simulated: res.body.simulated }, { received: 1, processed: 1, duplicates: 0, ignored: 0, failed: 0, simulated: false });
    const message = await prisma.message.findFirst({ where: { metadataJson: { path: ["externalId"], equals: `wamid.${RUN}.unknown1` } } });
    assert.ok(message, "mensaje del huésped persistido");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: message!.conversationId } });
    assert.equal(conversation.propertyId, A.propertyA);
    assert.equal(conversation.channel, "whatsapp");
    assert.equal(conversation.reservationId, null);
    assert.equal(conversation.guestId, null);
    const replies = await prisma.message.findMany({ where: { conversationId: conversation.id, senderType: "ai" }, orderBy: { sentAt: "asc" } });
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.body.startsWith(GUEST_AI_DISCLOSURE), replies[0]!.body);
    assert.match(replies[0]!.body, /código de reserva/);
    assert.doesNotMatch(replies[0]!.body, new RegExp(`CHK-WA-${RUN}`));
    const metadata = JSON.stringify([message!.metadataJson, replies[0]!.metadataJson]);
    assert.ok(!metadata.includes(UNKNOWN_PHONE.slice(1)), "el número no se persiste en claro");
    assert.match(metadata, /phoneHash/);
    assert.equal((replies[0]!.metadataJson as { delivery?: { status?: string } }).delivery?.status, "simulated", "entrega por WhatsApp simulada (sin proveedor)");
  });

  it("mensaje duplicado (mismo message.id) se procesa una sola vez", async () => {
    const payload = inbound({ from: UNKNOWN_PHONE, text: "hola de nuevo", messageId: `wamid.${RUN}.dup` });
    const first = await call("POST", "/webhooks/whatsapp", { payload, headers: signed(payload) });
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.body.processed, 1);
    assert.equal(first.body.duplicates, 0);
    const second = await call("POST", "/webhooks/whatsapp", { payload, headers: signed(payload) });
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.body.processed, 0);
    assert.equal(second.body.duplicates, 1);
    assert.equal(await prisma.message.count({ where: { metadataJson: { path: ["externalId"], equals: `wamid.${RUN}.dup` } } }), 1, "un solo mensaje del huésped");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { propertyId: A.propertyA, channel: "whatsapp", reservationId: null } });
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 4, "2 turnos (huésped + IA) × 2 mensajes distintos; el duplicado no añade nada");
  });

  it("número con reserva activa se resuelve por Guest.phoneLookupHash y lee SU reserva", async () => {
    const payload = inbound({ from: KNOWN_PHONE, text: "¿cuál es el estado de mi reserva?", messageId: `wamid.${RUN}.known1` });
    const res = await call("POST", "/webhooks/whatsapp", { payload, headers: signed(payload) });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.processed, 1);
    const message = await prisma.message.findFirstOrThrow({ where: { metadataJson: { path: ["externalId"], equals: `wamid.${RUN}.known1` } } });
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: message.conversationId } });
    assert.equal(conversation.reservationId, reservationId);
    assert.equal(conversation.guestId, `guest_${RUN}_wa`);
    const reply = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, senderType: "ai" }, orderBy: { sentAt: "desc" } });
    assert.match(reply.body, new RegExp(`CHK-WA-${RUN}`));
    assert.match(reply.body, /confirmada/);
    assert.equal((reply.metadataJson as { intent?: string }).intent, "reservation_status");
    assert.equal((reply.metadataJson as { mode?: string }).mode, "rules");
  });
});
