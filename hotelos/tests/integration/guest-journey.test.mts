/**
 * Tanda L7 · lote L7-07 «Recorrido del huésped en recepción con datos reales»
 * (scratchpad/L7/recon-delta.md §19.8) — integración sobre Postgres real con una
 * organización AISLADA (helpers/l2-tenant.mts, como guest-stay.test.mts) y
 * STRICT_ENV (auth real, RBAC_STRICT=true). Módulos activados en el hotel A:
 * pms_core, guest_self_service, spain_guest_register_compliance (la invitación
 * exige guest_self_service).
 *
 * Qué fija:
 *   · GET /reservations/:id/guest-journey (recepcionista, pms.reservation.read)
 *     antes de invitar → 200 honesto: checkIn null, sin avisos, sin llave, sin
 *     peticiones, encuesta vacía, 0 sesiones del portal;
 *   · invitar (POST /properties/:id/check-in/sessions) → la entrega (simulada o
 *     fallida según el proveedor, nunca fingida) y la sesión aparecen en el
 *     recorrido: checkIn.status invited, aviso checkin_invitation por correo con
 *     el destinatario ENMASCARADO, 1 sesión activa del portal; la respuesta no
 *     lleva correo completo, token, hash ni documento;
 *   · reenviar (POST …/sessions/:id/resend) → 2 avisos de invitación, la sesión
 *     anterior revocada (1 activa) y lastCreatedAt posterior;
 *   · llave móvil activa, petición y encuesta (invitación simulada + respuesta
 *     con puntuación 9) escritas por Prisma → key { issued, serial }, requests,
 *     survey { invitedAt, answeredAt, score 9 }, aviso welcome fallido con motivo;
 *   · usuario con un rol SIN pms.reservation.read → 403; reserva del hotel B para
 *     la recepcionista (solo A) y reserva inexistente → 404 opaco;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/guest-journey.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST";
type Reply = { status: number; body: any; raw: string };

const RUN = `gj${newRunId()}`;
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let reception: Session;
let limited: Session;

const reservationCode = `L7-GJ-${RUN}`;
const bookerEmail = `titular.${RUN}@l7.test`;
let reservationId = "";
let foreignReservationId = "";
let primaryGuestId = "";
let sessionId = "";
let firstPortalCreatedAt = "";

async function call(method: Method, url: string, options: { payload?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: options.headers ?? {},
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

const journeyUrl = (id: string) => `/reservations/${id}/guest-journey`;

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance"]);

  // Rol a medida SIN pms.reservation.read (todas las plantillas de organización la
  // llevan): solo guests.read, asignado en el hotel A. Misma forma que la
  // jefatura de recepción de checkin-session.test.mts.
  const permission = await prisma.permission.findUniqueOrThrow({ where: { key: "guests.read" }, select: { id: true } });
  const role = await prisma.role.create({ data: { organizationId: A.organizationId, name: `Sin reservas ${RUN}`, templateKey: null, managed: false }, select: { id: true } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  const limitedId = `usr_l2_limitado_${RUN}`;
  const limitedEmail = `limitado.l2.${RUN}@faranda.test`;
  await prisma.user.create({
    data: { id: limitedId, organizationId: A.organizationId, email: limitedEmail, fullName: "Perfil limitado L2", status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  await prisma.userRoleAssignment.create({ data: { userId: limitedId, roleId: role.id, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: `seed gj ${RUN}` } });
  resetRbacScopeCacheForTests();

  app = await buildApiServer();
  await app.ready();
  reception = await loginOrThrow(app, A.users.receptionist.email, A.password);
  limited = await loginOrThrow(app, limitedEmail, A.password);

  // Titular con correo y móvil (nombres inventados) + reserva confirmada en A; otra en B (fuera del alcance de recepción).
  const primary = await prisma.guest.create({
    data: { id: `guest_${RUN}_titular`, organizationId: A.organizationId, firstName: "Titular", surname1: "Prueba", email: bookerEmail, mobilePhone: "+34600000101", nationality: "ESP", dateOfBirth: new Date("1990-04-12T00:00:00.000Z") },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: reservationCode,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: 1,
      roomTypeId: A.roomTypeA,
      totalAmount: "200.00",
      currency: "EUR",
      bookerName: "Titular Prueba",
      bookerEmail
    },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: primaryGuestId, isPrimary: true } });
  const foreign = await prisma.reservation.create({
    data: { propertyId: A.propertyB, code: `L7-GJ-B-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`), departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`), adults: 1, roomTypeId: A.roomTypeB, totalAmount: "100.00", currency: "EUR" },
    select: { id: true }
  });
  foreignReservationId = foreign.id;
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("L7-07 · recorrido antes de invitar", () => {
  it("200 honesto: sin sesión, sin avisos, sin llave, sin peticiones, encuesta vacía, 0 sesiones del portal", async () => {
    const res = await call("GET", journeyUrl(reservationId), { headers: reception.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.equal(res.body.reservationId, reservationId);
    assert.equal(res.body.checkIn, null);
    assert.deepEqual(res.body.notifications, []);
    assert.equal(res.body.key, null);
    assert.deepEqual(res.body.requests, []);
    assert.deepEqual(res.body.survey, { invitedAt: null, answeredAt: null, score: null });
    assert.deepEqual(res.body.portalSessions, { active: 0, lastCreatedAt: null });
  });
});

describe("L7-07 · invitación → entrega y sesión en el recorrido", () => {
  it("POST /properties/:id/check-in/sessions y GET guest-journey: sesión invited, aviso checkin_invitation con destinatario enmascarado, 1 sesión activa; sin PII ni token", async () => {
    const invite = await call("POST", `/properties/${A.propertyA}/check-in/sessions`, { headers: reception.headers, payload: { reservationId, channel: "email" } });
    assert.equal(invite.status, 200, invite.raw.slice(0, 400));
    sessionId = invite.body.session.id;
    const notification = invite.body.notification;
    assert.equal(typeof notification.deliveryId, "string");
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: notification.deliveryId } });

    const res = await call("GET", journeyUrl(reservationId), { headers: reception.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    const body = res.body;
    assert.equal(body.checkIn.id, sessionId);
    assert.equal(body.checkIn.status, "invited");
    assert.equal(body.checkIn.channel, "email");
    assert.equal(typeof body.checkIn.invitedAt, "string");
    assert.ok(Array.isArray(body.checkIn.steps) && body.checkIn.steps.length === 7, "pasos del portal (toSessionView)");
    assert.ok(body.checkIn.policy && typeof body.checkIn.policy === "object", "política de la propiedad");
    assert.equal(body.checkIn.guests.length, 1);
    assert.equal(body.checkIn.guests[0].isPrimary, true);
    assert.equal(body.checkIn.guests[0].firstName, "Titular");
    assert.equal(body.checkIn.guests[0].hasEmail, true);

    assert.equal(body.notifications.length, 1, JSON.stringify(body.notifications));
    const [item] = body.notifications;
    assert.equal(item.id, notification.deliveryId);
    assert.equal(item.kind, "checkin_invitation");
    assert.equal(item.templateCode, "checkin_invitation");
    assert.equal(item.channel, "email");
    assert.equal(item.recipient, "t***@l7.test", "destinatario enmascarado");
    assert.equal(item.status, delivery.status);
    // Honestidad: sin proveedor, o bien SIMULADO (sent + errorMessage) o bien failed con motivo; nunca «enviado de verdad».
    if (delivery.status === "sent") {
      assert.equal(item.simulated, true);
      assert.equal(item.error, null);
      assert.equal(typeof item.sentAt, "string");
    } else {
      assert.equal(delivery.status, "failed");
      assert.equal(item.simulated, false);
      assert.equal(typeof item.error, "string");
      assert.equal(typeof item.failedAt, "string");
    }
    assert.equal(body.portalSessions.active, 1);
    assert.equal(typeof body.portalSessions.lastCreatedAt, "string");
    firstPortalCreatedAt = body.portalSessions.lastCreatedAt;

    assert.equal(res.raw.includes(bookerEmail), false, "el correo completo del titular nunca viaja (solo enmascarado)");
    assert.doesNotMatch(res.raw, /\+34600000101|tokenHash|bodyRendered|payloadJson|subject/, "sin móvil, hash ni cuerpo del aviso");
    if (typeof invite.body.token === "string") assert.equal(res.raw.includes(invite.body.token), false, "el token en claro nunca viaja en el recorrido");
    for (const key of ["documentNumber", "email", "phoneMobile", "dateOfBirth"]) assert.equal(res.raw.includes(`"${key}":`), false, `${key} no se expone`);
  });

  it("reenviar → 2 avisos de invitación (cronológicos), la sesión anterior del portal revocada (1 activa) y lastCreatedAt posterior", async () => {
    const resend = await call("POST", `/properties/${A.propertyA}/check-in/sessions/${sessionId}/resend`, { headers: reception.headers, payload: { channel: "email" } });
    assert.equal(resend.status, 200, resend.raw.slice(0, 300));

    const res = await call("GET", journeyUrl(reservationId), { headers: reception.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    const invitations = res.body.notifications.filter((n: any) => n.kind === "checkin_invitation");
    assert.equal(invitations.length, 2, JSON.stringify(res.body.notifications));
    assert.ok(invitations[0].createdAt <= invitations[1].createdAt, "orden cronológico");
    assert.equal(invitations[1].id, resend.body.notification.deliveryId);
    assert.equal(res.body.portalSessions.active, 1, "el reenvío revoca la sesión anterior del portal");
    assert.ok(res.body.portalSessions.lastCreatedAt >= firstPortalCreatedAt);
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId } }), 2);
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId, status: "active" } }), 1);
  });
});

describe("L7-07 · llave, peticiones, bienvenida y encuesta", () => {
  it("llave activa, petición abierta, bienvenida fallida y encuesta (invitación simulada + respuesta 9) aparecen en el recorrido", async () => {
    await prisma.reservation.update({ where: { id: reservationId }, data: { status: "checked_out" } });
    const key = await prisma.guestPortalAction.create({
      data: {
        id: `mkey_${RUN}`,
        propertyId: A.propertyA,
        reservationId,
        guestId: primaryGuestId,
        actionType: "mobile_key",
        status: "active",
        payloadJson: { serialNumber: RUN, validFrom: ARRIVAL, validUntil: DEPARTURE, issuedAt: "2026-10-02T15:00:00.000Z", signedByApple: false, secretHash: `secreto-${RUN}`, qrPayload: `hotelos://unlock?serial=${RUN}` }
      },
      select: { id: true }
    });
    const request = await prisma.serviceRequest.create({
      data: { propertyId: A.propertyA, reservationId, guestId: primaryGuestId, requestType: "late_checkout", status: "open", assignedDepartment: "front_office" },
      select: { id: true }
    });
    const welcome = await prisma.notificationDelivery.create({
      data: { organizationId: A.organizationId, propertyId: A.propertyA, notificationId: `welcome:${reservationId}:whatsapp`, templateCode: "checkin_welcome", channel: "whatsapp", recipient: "+34600000101", status: "failed", errorMessage: "WHATSAPP_PHONE_ID no configurado", failedAt: new Date("2026-10-02T15:01:00.000Z"), attempts: 1 },
      select: { id: true }
    });
    const surveyInvite = await prisma.notificationDelivery.create({
      data: { organizationId: A.organizationId, propertyId: A.propertyA, notificationId: `post_stay_survey:${reservationId}`, templateCode: "post_stay_survey", channel: "email", recipient: bookerEmail, status: "sent", errorMessage: "SIMULADO: proveedor no configurado; no se envió de verdad.", sentAt: new Date("2026-10-05T10:00:00.000Z"), attempts: 1 },
      select: { id: true }
    });
    const response = await prisma.surveyResponse.create({
      data: { surveyId: `srv_${RUN}`, reservationId, guestId: primaryGuestId, score: "9.00", responsesJson: { comment: "Todo correcto" } },
      select: { id: true, createdAt: true }
    });
    try {
      const res = await call("GET", journeyUrl(reservationId), { headers: reception.headers });
      assert.equal(res.status, 200, res.raw.slice(0, 300));
      const body = res.body;
      assert.deepEqual(body.key, { issued: true, serial: RUN, status: "active", validFrom: ARRIVAL, validUntil: DEPARTURE, issuedAt: "2026-10-02T15:00:00.000Z", signedByApple: false });
      assert.doesNotMatch(res.raw, /secreto-|hotelos:\/\/unlock/, "ni el hash del secreto ni el QR viajan");
      assert.equal(body.requests.length, 1);
      assert.equal(body.requests[0].id, request.id);
      assert.equal(body.requests[0].kind, "late_checkout");
      assert.equal(body.requests[0].status, "open");
      assert.equal(body.requests[0].department, "front_office");

      const kinds = body.notifications.map((n: any) => n.kind);
      assert.deepEqual(kinds.slice(0, 2), ["checkin_invitation", "checkin_invitation"]);
      const welcomeItem = body.notifications.find((n: any) => n.id === welcome.id);
      assert.equal(welcomeItem.kind, "welcome");
      assert.equal(welcomeItem.status, "failed");
      assert.equal(welcomeItem.simulated, false);
      assert.equal(welcomeItem.recipient, "***101");
      assert.equal(welcomeItem.error, "WHATSAPP_PHONE_ID no configurado");
      const surveyItem = body.notifications.find((n: any) => n.id === surveyInvite.id);
      assert.equal(surveyItem.kind, "post_stay_survey");
      assert.equal(surveyItem.simulated, true);
      assert.equal(surveyItem.recipient, "t***@l7.test");
      assert.equal(surveyItem.sentAt, "2026-10-05T10:00:00.000Z");

      assert.deepEqual(body.survey, { invitedAt: "2026-10-05T10:00:00.000Z", answeredAt: response.createdAt.toISOString(), score: 9 });
      assert.equal(res.raw.includes(bookerEmail), false);
      assert.doesNotMatch(res.raw, /\+34600000101/);
    } finally {
      await prisma.surveyResponse.delete({ where: { id: response.id } });
      await prisma.notificationDelivery.deleteMany({ where: { id: { in: [welcome.id, surveyInvite.id] } } });
      await prisma.serviceRequest.delete({ where: { id: request.id } });
      await prisma.guestPortalAction.delete({ where: { id: key.id } });
      await prisma.reservation.update({ where: { id: reservationId }, data: { status: "confirmed" } });
    }
  });
});

describe("L7-07 · permisos y tenencia", () => {
  it("un rol sin pms.reservation.read → 403; reserva del hotel B para recepción (solo A) → 404 opaco; id inexistente → 404", async () => {
    const forbidden = await call("GET", journeyUrl(reservationId), { headers: limited.headers });
    assert.equal(forbidden.status, 403, forbidden.raw.slice(0, 300));

    const cross = await call("GET", journeyUrl(foreignReservationId), { headers: reception.headers });
    assert.equal(cross.status, 404, cross.raw.slice(0, 300));
    assert.match(String(cross.body.message), /Reserva no encontrada/);

    const missing = await call("GET", journeyUrl(`res_no_${RUN}`), { headers: reception.headers });
    assert.equal(missing.status, 404, missing.raw.slice(0, 300));

    const anonymous = await call("GET", journeyUrl(reservationId));
    assert.equal(anonymous.status, 401, anonymous.raw.slice(0, 300));
  });
});
