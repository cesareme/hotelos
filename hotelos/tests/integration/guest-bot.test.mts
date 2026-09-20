/**
 * Tanda CHK · lote W4-D — bot del huésped por el portal (diseño §5, §7.1 última fila,
 * R10): POST /guest-portal/chat con el token opaco de la invitación al check-in en
 * línea, sobre Postgres real con una organización AISLADA (helpers/l2-tenant.mts) y
 * STRICT_ENV para el personal. Sin proveedor de IA (respuestas por reglas, `mode: "rules"`).
 *
 * Qué fija:
 *   · sin token → 401 GUEST_SESSION_INVALID; token de otra propiedad → 401;
 *   · «¿a qué hora es el desayuno?» → 200 por reglas con el aviso de IA en el primer mensaje,
 *     intent faq, conversación webchat persistida con 2 mensajes (guest + ai);
 *   · «quiero salir tarde mañana» → AiToolCall createServiceRequest awaiting_confirmation
 *     (propertyId de la propiedad, conversationId) visible en GET /ai/tool-calls (audit.read);
 *     recepción la confirma en POST /ai/tool-calls/:id/confirm { decision: approve } →
 *     succeeded (ConfirmToolResult) y fila service_requests late_checkout; un rechazo posterior → 404 (ya decidida);
 *   · queja → handoff: la conversación queda `handoff` con aiEnabled false y el bot deja de responder;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/guest-bot.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { GUEST_AI_DISCLOSURE } = await import("../../apps/api/src/modules/messaging/messaging.service.js");
const { todayInTimezone } = await import("../../apps/api/src/modules/pms/pms.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST";
type Reply = { status: number; body: any; raw: string };

const RUN = `gbot${newRunId()}`;
/** Huésped: rutas públicas (sin JWT); NODE_ENV≠production para que la invitación devuelva el token (sin proveedor de correo). */
const GUEST_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development", AI_PROVIDER: undefined };

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let receptionist: Session;
let owner: Session;
let reservationId = "";
let token = "";
let foreignToken = "";
let conversationId = "";
let toolCallId = "";

async function call(method: Method, url: string, options: { payload?: unknown; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}): Promise<Reply> {
  const res = await withEnv(options.env ?? STRICT_ENV, () =>
    app.inject({ method, url, headers: options.headers ?? {}, ...(options.payload !== undefined ? { payload: options.payload } : {}) })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

const chat = (text: string, guestToken = token, extra: Record<string, unknown> = {}) => call("POST", "/guest-portal/chat", { headers: { "x-guest-token": guestToken }, payload: { text, ...extra }, env: GUEST_ENV });

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance", "ai_concierge"]);
  await enableModules(A.propertyB, ["pms_core", "guest_self_service"]);
  await prisma.propertyAiSetting.upsert({
    where: { propertyId: A.propertyA },
    create: { propertyId: A.propertyA, aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", voiceLocales: ["es-ES"], configurationJson: { faq: { breakfastHours: "07:30 a 10:30", wifiName: `CHK-${RUN}`, wifiPassword: "bienvenido" } } },
    update: { aiEnabled: true, configurationJson: { faq: { breakfastHours: "07:30 a 10:30", wifiName: `CHK-${RUN}`, wifiPassword: "bienvenido" } } }
  });
  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
  owner = await loginOrThrow(app, A.users.owner.email, A.password);

  const arrival = todayInTimezone("Europe/Madrid");
  const departure = new Date(`${arrival}T00:00:00.000Z`);
  departure.setUTCDate(departure.getUTCDate() + 2);
  const guest = await prisma.guest.create({ data: { id: `guest_${RUN}_titular`, organizationId: A.organizationId, firstName: "Prueba", surname1: "Bot", languagePreference: "es", email: `titular.${RUN}@chk.test`, mobilePhone: "+34600000781" }, select: { id: true } });
  const reservation = await prisma.reservation.create({
    data: { propertyId: A.propertyA, code: `CHK-BOT-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date(`${arrival}T00:00:00.000Z`), departureDate: departure, adults: 1, children: 0, roomTypeId: A.roomTypeA, totalAmount: "150.00", currency: "EUR", bookerEmail: `titular.${RUN}@chk.test` },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: guest.id, isPrimary: true } });

  // Invitación al check-in en línea (W2-A): el token opaco del portal viaja en la respuesta fuera de producción.
  const invited = await call("POST", `/properties/${A.propertyA}/check-in/sessions`, { headers: receptionist.headers, payload: { reservationId, channel: "email" }, env: GUEST_ENV });
  assert.equal(invited.status, 200, invited.raw.slice(0, 400));
  token = invited.body.token;
  assert.equal(typeof token, "string", "token del portal en la respuesta");

  // Reserva de la propiedad B con su propio token (sign-in del portal): nunca debe leer datos de A.
  const foreign = await prisma.reservation.create({
    data: { propertyId: A.propertyB, code: `CHK-BOT-B-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date(`${arrival}T00:00:00.000Z`), departureDate: departure, adults: 1, children: 0, roomTypeId: A.roomTypeB, totalAmount: "100.00", currency: "EUR", bookerEmail: `b.${RUN}@chk.test` },
    select: { id: true }
  });
  const signedIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode: `CHK-BOT-B-${RUN}`, email: `b.${RUN}@chk.test`, propertyId: A.propertyB }, env: GUEST_ENV });
  assert.equal(signedIn.status, 200, signedIn.raw.slice(0, 300));
  assert.equal(signedIn.body.reservationId, foreign.id);
  foreignToken = signedIn.body.token;
  assert.equal(typeof foreignToken, "string");
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("POST /guest-portal/chat · lecturas por reglas", () => {
  it("sin token → 401 GUEST_SESSION_INVALID; texto vacío → 400", async () => {
    const anonymous = await call("POST", "/guest-portal/chat", { payload: { text: "hola" }, env: GUEST_ENV });
    assert.equal(anonymous.status, 401, anonymous.raw.slice(0, 300));
    assert.equal(anonymous.body?.details?.code, "GUEST_SESSION_INVALID");
    const empty = await chat("   ");
    assert.equal(empty.status, 400, empty.raw.slice(0, 300));
  });

  it("«¿a qué hora es el desayuno?» responde por reglas con el aviso de IA y persiste la conversación (2 mensajes)", async () => {
    const res = await chat("¿A qué hora es el desayuno?");
    assert.equal(res.status, 200, res.raw.slice(0, 500));
    assert.equal(res.body.intent, "faq");
    assert.equal(res.body.mode, "rules");
    assert.equal(res.body.action, "answered");
    assert.equal(res.body.disclosureShown, true);
    assert.equal(res.body.identified, true);
    assert.equal(res.body.language, "es");
    assert.ok(res.body.reply.startsWith(GUEST_AI_DISCLOSURE), res.body.reply);
    assert.match(res.body.reply, /07:30 a 10:30/);
    conversationId = res.body.conversationId;
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.propertyId, A.propertyA);
    assert.equal(conversation.reservationId, reservationId);
    assert.equal(conversation.channel, "webchat");
    assert.equal(conversation.aiEnabled, true);
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { sentAt: "asc" } });
    assert.deepEqual(messages.map((m) => m.senderType), ["guest", "ai"]);
    assert.equal(messages[0]!.body, "¿A qué hora es el desayuno?");
    assert.equal((messages[1]!.metadataJson as { disclosureShown?: boolean }).disclosureShown, true);

    const second = await chat("¿y la contraseña del wifi?", token, { conversationId });
    assert.equal(second.status, 200, second.raw.slice(0, 300));
    assert.equal(second.body.disclosureShown, false, "el aviso solo va en el primer mensaje");
    assert.equal(second.body.conversationId, conversationId);
    assert.match(second.body.reply, new RegExp(`CHK-${RUN}`));
    assert.match(second.body.reply, /bienvenido/);
  });

  it("estado de la reserva: solo datos de SU reserva; el token de otra propiedad nunca lee A", async () => {
    const mine = await chat("¿cuál es el estado de mi reserva?");
    assert.equal(mine.status, 200, mine.raw.slice(0, 300));
    assert.equal(mine.body.intent, "reservation_status");
    assert.match(mine.body.reply, new RegExp(`CHK-BOT-${RUN}`));
    assert.doesNotMatch(mine.body.reply, new RegExp(`CHK-BOT-B-${RUN}`));
    // El token de B con la conversación de A → 404 opaco (la conversación es de otra reserva/propiedad).
    const crossed = await chat("¿cuál es el estado de mi reserva?", foreignToken, { conversationId });
    assert.equal(crossed.status, 404, crossed.raw.slice(0, 300));
    // El token de B en su propia propiedad (guest_self_service activado en B) lee solo B.
    const theirs = await chat("¿cuál es el estado de mi reserva?", foreignToken);
    assert.equal(theirs.status, 200, theirs.raw.slice(0, 300));
    assert.match(theirs.body.reply, new RegExp(`CHK-BOT-B-${RUN}`));
    assert.doesNotMatch(theirs.body.reply, new RegExp(`CHK-BOT-${RUN}:`));
  });
});

describe("POST /guest-portal/chat · escrituras por el runner y confirmación de recepción", () => {
  it("«quiero salir tarde mañana» crea AiToolCall createServiceRequest awaiting_confirmation visible en GET /ai/tool-calls", async () => {
    const res = await chat("quiero salir tarde mañana, sobre las 14:00", token, { conversationId });
    assert.equal(res.status, 200, res.raw.slice(0, 500));
    assert.equal(res.body.intent, "late_checkout");
    assert.equal(res.body.action, "pending_confirmation");
    assert.match(res.body.reply, /pasado a recepción/);
    toolCallId = res.body.toolCallId;
    assert.equal(typeof toolCallId, "string");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: toolCallId } });
    assert.equal(row.status, "awaiting_confirmation");
    assert.equal(row.toolName, "createServiceRequest");
    assert.equal(row.organizationId, A.organizationId);
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.conversationId, conversationId);
    assert.equal(row.requiredConfirmation, true);
    assert.deepEqual(row.inputJson, { reservationId, guestId: `guest_${RUN}_titular`, requestType: "late_checkout", assignedDepartment: "reception", note: "Late check-out solicitado por el huésped (web) hasta las 14:00." });
    const output = row.outputJson as { proposal?: { action?: string; requestType?: string }; effect?: string };
    assert.equal(output.effect, "write");
    assert.equal(output.proposal?.action, "createServiceRequest");
    assert.equal(output.proposal?.requestType, "late_checkout");

    const page = await call("GET", "/ai/tool-calls?envelope=1&limit=50", { headers: { ...owner.headers, "x-property-id": A.propertyA } });
    assert.equal(page.status, 200, page.raw.slice(0, 300));
    const listed = (page.body.items as Array<{ id: string; status: string; toolName: string }>).find((item) => item.id === toolCallId);
    assert.ok(listed, "la llamada pendiente aparece en la cola de la propiedad");
    assert.equal(listed!.status, "awaiting_confirmation");
    assert.equal(listed!.toolName, "createServiceRequest");
    assert.equal(await prisma.serviceRequest.count({ where: { reservationId } }), 0, "nada escrito antes de confirmar");
  });

  it("recepción confirma (POST /ai/tool-calls/:id/confirm approve) → succeeded y fila service_requests late_checkout; una segunda decisión → 404", async () => {
    const confirmed = await call("POST", `/ai/tool-calls/${toolCallId}/confirm`, { headers: { ...receptionist.headers, "x-property-id": A.propertyA }, payload: { decision: "approve" } });
    assert.equal(confirmed.status, 200, confirmed.raw.slice(0, 500));
    assert.equal(confirmed.body.status, "succeeded", "ConfirmToolResult del runner (succeeded | failed | rejected)");
    assert.equal(confirmed.body.toolCallId, toolCallId);
    assert.equal(confirmed.body.output?.requestType, "late_checkout");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: toolCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.confirmedBy, receptionist.userId);
    const requests = await prisma.serviceRequest.findMany({ where: { reservationId } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.requestType, "late_checkout");
    assert.equal(requests[0]!.assignedDepartment, "reception");
    assert.equal(requests[0]!.status, "open");
    assert.equal(requests[0]!.propertyId, A.propertyA);
    const again = await call("POST", `/ai/tool-calls/${toolCallId}/confirm`, { headers: { ...receptionist.headers, "x-property-id": A.propertyA }, payload: { decision: "reject" } });
    assert.equal(again.status, 404, again.raw.slice(0, 300));
  });

  it("queja → handoff: la conversación queda `handoff` con aiEnabled false y el bot deja de responder", async () => {
    const res = await chat("quiero poner una queja, es inaceptable", token, { conversationId });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.equal(res.body.intent, "complaint");
    assert.equal(res.body.action, "handoff");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.status, "handoff");
    assert.equal(conversation.aiEnabled, false);
    await flushAuditQueues(); // la auditoría se persiste en cola (audit.service): se vacía antes de leerla
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: A.organizationId, action: "GUEST_CONVERSATION_HANDED_OFF", entityId: conversationId } });
    assert.ok(audit, "auditoría del handoff");
    const later = await chat("¿a qué hora es el desayuno?", token, { conversationId });
    assert.equal(later.status, 200, later.raw.slice(0, 300));
    assert.equal(later.body.action, "handoff");
    assert.match(later.body.reply, /ocupando de tu conversación/);
    assert.equal(await prisma.aiToolCall.count({ where: { conversationId } }), 1, "ninguna llamada nueva tras el handoff");
  });
});
