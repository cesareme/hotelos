/**
 * Tanda L7 · lote L7-04 «Encuesta post-estancia: política, plantilla, paso del
 * tick y rutas» (scratchpad/L7/recon-delta.md §19.7) — integración sobre Postgres
 * real con una organización AISLADA (helpers/l2-tenant.mts, como
 * guest-stay.test.mts) y STRICT_ENV (auth real, RBAC_STRICT=true). Las llamadas
 * que despachan correo van con NODE_ENV=development (DISPATCH_ENV, precedente
 * checkin-flow.test.mts GUEST_ENV) para que el proveedor simule (SIMULADO) en vez
 * de fallar: sin proveedor no hay envío real.
 *
 * Qué fija:
 *   · PUT/GET /properties/:id/check-in/policy con postStaySurveyEnabled /
 *     postStaySurveyDelayHours (columnas de la migración 20260920190000_portal_huesped_l7);
 *     400 fuera de rango;
 *   · POST /reservations/:id/post-stay/survey-invite (pms.reservation.modify):
 *     409 RESERVATION_NOT_CHECKED_OUT, 404 desconocida, 200 invited SIMULADO con
 *     surveyUrl (solo porque fue simulado), fila notification_deliveries con el
 *     token REDACTADO, visible en GET /notifications/deliveries; segunda
 *     invitación → skipped already_invited;
 *   · corrector L7-REV-01: la sesión del enlace es `purpose=survey` y SOLO abre
 *     GET|POST /guest-portal/survey (el resto del portal → 401); GET
 *     /guest-portal/survey → cuestionario por defecto; POST → 201 (Survey creada,
 *     SurveyResponse con score) → 409 SURVEY_ALREADY_ANSWERED; 400 de validación;
 *     token en la query de un POST → 401; reserva no salida → 409 SURVEY_NOT_AVAILABLE;
 *   · GET /dashboards/surveys refleja el NPS de la respuesta;
 *   · el paso del tick (runPostStaySurveyStep con Prisma real, acotado a las
 *     propiedades del tenant) invita a la salida de ayer y es idempotente;
 *   · token caducado → 401 GUEST_SESSION_INVALID; invariantes de Faranda intactas.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/guest-survey.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { localDateIn } = await import("../../apps/api/src/modules/guest-portal/guest-stay.service.js");
const { defaultPostStaySurveyDeps, runPostStaySurveyStep, shiftDay } = await import("../../apps/api/src/modules/guest-portal/post-stay-survey.service.js");
type PostStaySurveyDb = import("../../apps/api/src/modules/guest-portal/post-stay-survey.service.js").PostStaySurveyDb;

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PUT";
type Reply = { status: number; body: any; raw: string };

/** Mismo modo estricto, pero NODE_ENV≠production para que el dispatcher simule (nunca un envío real sin proveedor). */
const DISPATCH_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development" };

const RUN = `sv${newRunId()}`;
const TODAY = localDateIn(new Date(), "Europe/Madrid");
const DEPARTED_YESTERDAY = shiftDay(TODAY, -1);
const ARRIVED = shiftDay(TODAY, -3);

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let owner: Session;
let reception: Session;
/** Jefatura de recepción (plantilla front_office_manager: guest_self_service.manage para la política), como checkin-corrector.test.mts. */
let frontOfficeManager: Session;

const primaryEmail = `titular.${RUN}@l7.test`;
let checkedOutId = "";
let primaryGuestId = "";
let confirmedId = "";
const confirmedCode = `L7-SV-C-${RUN}`;
let inviteToken = "";
let deliveryId = "";
let tickReservationId = "";

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

async function createCheckedOut(code: string, email: string, guestId: string): Promise<string> {
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code,
      channel: "direct",
      status: "checked_out",
      arrivalDate: new Date(`${ARRIVED}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTED_YESTERDAY}T00:00:00.000Z`),
      adults: 1,
      roomTypeId: A.roomTypeA,
      assignedRoomId: A.roomsA[0]!,
      totalAmount: "100.00",
      currency: "EUR",
      bookerName: "Titular Prueba",
      bookerEmail: email
    },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId: reservation.id, guestId, isPrimary: true } });
  return reservation.id;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  const fomId = `usr_l7_fom_${RUN}`;
  const fomEmail = `jefatura.${RUN}@l7.test`;
  await prisma.user.create({ data: { id: fomId, organizationId: A.organizationId, email: fomEmail, fullName: "Jefatura L7", status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  const fomRole = A.roles.front_office_manager;
  assert.ok(fomRole, "rol front_office_manager");
  await prisma.userRoleAssignment.create({ data: { userId: fomId, roleId: fomRole, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: `l7-04 ${RUN}` } });
  resetRbacScopeCacheForTests();
  app = await buildApiServer();
  await app.ready();
  owner = await loginOrThrow(app, A.users.owner.email, A.password);
  reception = await loginOrThrow(app, A.users.receptionist.email, A.password);
  frontOfficeManager = await loginOrThrow(app, fomEmail, A.password);

  const primary = await prisma.guest.create({
    data: { id: `guest_${RUN}_titular`, organizationId: A.organizationId, firstName: "Ana", surname1: "Gamma", email: primaryEmail, nationality: "ES", languagePreference: "es" },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  checkedOutId = await createCheckedOut(`L7-SV-${RUN}`, primaryEmail, primaryGuestId);
  // Consentimiento RGPD firmado en el check-in (base del consentimiento de la invitación).
  await prisma.checkInSession.create({
    data: { organizationId: A.organizationId, propertyId: A.propertyA, reservationId: checkedOutId, status: "checked_in", channel: "email", consentJson: { gdprAt: new Date().toISOString() } }
  });
  // Reserva confirmada (no salida): 409 en la invitación y en la respuesta.
  const confirmed = await prisma.reservation.create({
    data: { propertyId: A.propertyA, code: confirmedCode, channel: "direct", status: "confirmed", arrivalDate: new Date("2026-10-02T00:00:00.000Z"), departureDate: new Date("2026-10-04T00:00:00.000Z"), adults: 1, roomTypeId: A.roomTypeA, totalAmount: "100.00", currency: "EUR", bookerName: "Titular Prueba", bookerEmail: primaryEmail },
    select: { id: true }
  });
  confirmedId = confirmed.id;
  await prisma.reservationGuest.create({ data: { reservationId: confirmedId, guestId: primaryGuestId, isPrimary: true } });
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("L7-04 · política", () => {
  it("PUT /properties/:id/check-in/policy acepta postStaySurveyEnabled/postStaySurveyDelayHours (defecto false/24); GET los devuelve; 400 fuera de rango o clave ajena", async () => {
    const before = await call("GET", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers });
    assert.equal(before.status, 200, before.raw.slice(0, 300));
    assert.equal(before.body.postStaySurveyEnabled, false, "por defecto la encuesta está desactivada");
    assert.equal(before.body.postStaySurveyDelayHours, 24);
    const written = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { postStaySurveyEnabled: true, postStaySurveyDelayHours: 24 } });
    assert.equal(written.status, 200, written.raw.slice(0, 300));
    assert.equal(written.body.postStaySurveyEnabled, true);
    assert.equal(written.body.postStaySurveyDelayHours, 24);
    const row = await prisma.propertyCheckInPolicy.findUniqueOrThrow({ where: { propertyId: A.propertyA } });
    assert.equal(row.postStaySurveyEnabled, true);
    assert.equal(row.postStaySurveyDelayHours, 24);
    for (const payload of [{ postStaySurveyDelayHours: 100 }, { postStaySurveyDelayHours: -1 }, { postStaySurveyDelayHours: 1.5 }, { postStaySurveyEnabled: "sí" }]) {
      const bad = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload });
      assert.equal(bad.status, 400, `${JSON.stringify(payload)}: ${bad.raw.slice(0, 200)}`);
    }
  });
});

describe("L7-04 · POST /reservations/:id/post-stay/survey-invite", () => {
  it("reserva confirmada → 409 RESERVATION_NOT_CHECKED_OUT; desconocida → 404; nada escrito", async () => {
    const notOut = await call("POST", `/reservations/${confirmedId}/post-stay/survey-invite`, { headers: reception.headers, env: DISPATCH_ENV });
    assert.equal(notOut.status, 409, notOut.raw.slice(0, 300));
    assert.equal(notOut.body.details?.code, "RESERVATION_NOT_CHECKED_OUT");
    const unknown = await call("POST", `/reservations/res_${RUN}_nope/post-stay/survey-invite`, { headers: reception.headers, env: DISPATCH_ENV });
    assert.equal(unknown.status, 404, unknown.raw.slice(0, 300));
    assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: { startsWith: "post_stay_survey:" }, propertyId: A.propertyA } }), 0);
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId: { in: [confirmedId, checkedOutId] } } }), 0);
  });

  it("reserva checked_out → 200 invited SIMULADO con surveyUrl; entrega con el token redactado y visible en GET /notifications/deliveries; auditoría PostStaySurveyInvited", async () => {
    const res = await call("POST", `/reservations/${checkedOutId}/post-stay/survey-invite`, { headers: reception.headers, env: DISPATCH_ENV });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.equal(res.body.status, "invited");
    assert.equal(res.body.dispatched, true);
    assert.equal(res.body.simulated, true, "sin EMAIL_PROVIDER el envío es SIMULADO");
    assert.equal(res.body.channel, "email");
    assert.equal(res.body.recipient, "t***@l7.test", "destinatario enmascarado");
    assert.equal(typeof res.body.deliveryId, "string");
    assert.match(String(res.body.surveyUrl), /^http:\/\/.+\/\?survey=1&token=[0-9a-f]{64}&property=/, "el enlace se devuelve SOLO porque el envío fue simulado");
    deliveryId = res.body.deliveryId;
    inviteToken = new URL(res.body.surveyUrl).searchParams.get("token") ?? "";
    assert.equal(inviteToken.length, 64);
    assert.equal(new URL(res.body.surveyUrl).searchParams.get("property"), A.propertyA);

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    assert.equal(delivery.notificationId, `post_stay_survey:${checkedOutId}`);
    assert.equal(delivery.templateCode, "post_stay_survey");
    assert.equal(delivery.channel, "email");
    assert.equal(delivery.recipient, primaryEmail);
    assert.equal(delivery.status, "sent");
    assert.match(String(delivery.errorMessage), /^SIMULADO/);
    assert.equal(String(delivery.bodyRendered).includes(inviteToken), false, "el token nunca se persiste");
    assert.match(String(delivery.bodyRendered), /\[redacted\]/);
    const payload = delivery.payloadJson as { variables: Record<string, unknown>; redacted?: boolean };
    assert.equal(payload.variables.surveyUrl, "[redacted]");
    assert.equal(payload.redacted, true);
    assert.equal(JSON.stringify(delivery).includes(inviteToken), false);

    // Sesión del portal de 30 días emitida para la reserva (solo el hash en la fila).
    const session = await prisma.guestPortalSession.findFirstOrThrow({ where: { reservationId: checkedOutId, status: "active" } });
    assert.equal(session.guestId, primaryGuestId);
    assert.ok(session.expiresAt.getTime() - Date.now() > 29 * 24 * 60 * 60 * 1000, "vigencia ≈ 30 días");
    assert.notEqual(session.tokenHash, inviteToken);

    // Recepción la ve en el listado de entregas.
    const list = await call("GET", `/notifications/deliveries?propertyId=${A.propertyA}&channel=email`, { headers: owner.headers });
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    const item = (list.body as Array<{ id: string; templateCode: string; status: string; errorMessage: string | null }>).find((entry) => entry.id === deliveryId);
    assert.ok(item, "la entrega aparece en GET /notifications/deliveries");
    assert.equal(item!.templateCode, "post_stay_survey");
    assert.match(String(item!.errorMessage), /^SIMULADO/);
    assert.equal(list.raw.includes(inviteToken), false);

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: A.organizationId, action: "PostStaySurveyInvited", entityId: checkedOutId }, orderBy: { createdAt: "desc" } });
    assert.ok(audit, "auditoría PostStaySurveyInvited");
    assert.equal(audit!.actorUserId, reception.userId);
    assert.equal(JSON.stringify(audit!.afterJson).includes(inviteToken), false);
  });

  it("segunda invitación → 200 skipped already_invited con el mismo deliveryId y sin surveyUrl; una sola entrega y una sola sesión", async () => {
    const again = await call("POST", `/reservations/${checkedOutId}/post-stay/survey-invite`, { headers: reception.headers, env: DISPATCH_ENV });
    assert.equal(again.status, 200, again.raw.slice(0, 300));
    assert.equal(again.body.status, "skipped");
    assert.equal(again.body.reason, "already_invited");
    assert.equal(again.body.deliveryId, deliveryId);
    assert.equal("surveyUrl" in again.body, false);
    assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: `post_stay_survey:${checkedOutId}` } }), 1);
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId: checkedOutId } }), 1);
  });
});

describe("L7-04 · portal: GET/POST /guest-portal/survey", () => {
  it("corrector L7-REV-01: la sesión del enlace tiene ámbito `survey` (fila purpose=survey) y SOLO abre la encuesta: /stay, /reservation, /stay/requests, /stay/payment-link, /check-in y /chat → 401 GUEST_SESSION_INVALID", async () => {
    const row = await prisma.guestPortalSession.findFirstOrThrow({ where: { reservationId: checkedOutId, status: "active" }, select: { purpose: true } });
    assert.equal(row.purpose, "survey");
    for (const [method, url, payload] of [
      ["GET", "/guest-portal/stay", undefined],
      ["GET", "/guest-portal/reservation", undefined],
      ["POST", "/guest-portal/stay/requests", { kind: "invoice_email" }],
      ["POST", "/guest-portal/stay/payment-link", {}],
      ["GET", "/guest-portal/check-in", undefined],
      ["POST", "/guest-portal/chat", { text: "hola" }],
      ["POST", "/guest-portal/service-request", { category: "housekeeping", description: "x" }]
    ] as const) {
      const res = await call(method, url, { headers: { "x-guest-token": inviteToken }, ...(payload !== undefined ? { payload } : {}) });
      assert.equal(res.status, 401, `${method} ${url} → ${res.status} ${res.raw.slice(0, 200)}`);
      assert.equal(res.body?.details?.code, "GUEST_SESSION_INVALID", `${method} ${url}`);
    }
    assert.equal(await prisma.serviceRequest.count({ where: { reservationId: checkedOutId } }), 0, "nada escrito con el token de la encuesta");
  });

  it("con el token del enlace: GET /guest-portal/survey → cuestionario por defecto (id null), available, cabecera de la reserva sin PII y sessionPurpose survey; el sign-in normal ve survey.invited en /stay", async () => {
    const view = await call("GET", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken } });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.survey.id, null, "la propiedad todavía no tiene Survey post_stay");
    assert.equal(view.body.survey.name, "Encuesta post-estancia");
    assert.deepEqual(view.body.survey.questions.map((q: { key: string; type: string; required: boolean }) => [q.key, q.type, q.required]), [["nps", "nps", true], ["comment", "text", false]]);
    assert.equal(view.body.answered, false);
    assert.equal(view.body.answeredAt, null);
    assert.equal(view.body.available, true);
    assert.equal(view.body.stage, "post_stay");
    assert.equal(view.body.reservationStatus, "checked_out");
    assert.equal(view.body.sessionPurpose, "survey");
    assert.deepEqual(view.body.reservation, { reservationId: checkedOutId, reservationCode: `L7-SV-${RUN}`, propertyId: A.propertyA, propertyName: view.body.reservation.propertyName });
    assert.equal(typeof view.body.reservation.propertyName, "string");
    for (const key of ["bookerEmail", "email", "surname1", "documentNumber", "guestId"]) assert.equal(view.raw.includes(`"${key}"`), false, `${key} no viaja`);
    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode: `L7-SV-${RUN}`, email: primaryEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    const stay = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": signIn.body.token as string } });
    assert.equal(stay.status, 200, stay.raw.slice(0, 300));
    assert.equal(stay.body.stage, "post_stay");
    assert.deepEqual(stay.body.survey, { invited: true, answered: false });
    assert.equal((await call("GET", "/guest-portal/survey", { headers: { "x-guest-token": signIn.body.token as string } })).body.sessionPurpose, "sign_in");
    const noToken = await call("GET", "/guest-portal/survey");
    assert.equal(noToken.status, 401, noToken.raw.slice(0, 300));
    assert.equal(noToken.body.details?.code, "GUEST_SESSION_INVALID");
  });

  it("400 de validación (score 11, decimal, clave ajena, > 20 respuestas) y token en la query de un POST → 401; nada escrito", async () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, "x"]));
    for (const payload of [{ score: 11 }, { score: 7.5 }, { score: 8, extra: 1 }, { score: 8, answers: many }, {}, { score: 8, answers: { comment: "x".repeat(2001) } }]) {
      const bad = await call("POST", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken }, payload });
      assert.equal(bad.status, 400, `${JSON.stringify(payload).slice(0, 60)}: ${bad.raw.slice(0, 200)}`);
      assert.equal(bad.body.details?.code, "VALIDATION_ERROR");
    }
    const byQuery = await call("POST", `/guest-portal/survey?token=${encodeURIComponent(inviteToken)}`, { payload: { score: 8 } });
    assert.equal(byQuery.status, 401, "las escrituras no admiten el token en la query");
    assert.equal(await prisma.surveyResponse.count({ where: { reservationId: checkedOutId } }), 0);
    assert.equal(await prisma.survey.count({ where: { propertyId: A.propertyA } }), 0, "sin respuesta no se crea la Survey");
  });

  it("POST → 201 { responseId, surveyId, score }: crea la Survey post_stay por defecto y la SurveyResponse (score en columna, comment y source en JSON); GET → answered; segundo POST → 409 SURVEY_ALREADY_ANSWERED", async () => {
    const res = await call("POST", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken }, payload: { score: 9, answers: { comment: "Todo perfecto" } } });
    assert.equal(res.status, 201, res.raw.slice(0, 300));
    assert.equal(res.body.score, 9);
    assert.equal(typeof res.body.responseId, "string");
    assert.match(String(res.body.answeredAt), /^\d{4}-\d{2}-\d{2}T/);
    const survey = await prisma.survey.findUniqueOrThrow({ where: { id: res.body.surveyId } });
    assert.equal(survey.propertyId, A.propertyA);
    assert.equal(survey.surveyType, "post_stay");
    assert.equal(survey.active, true);
    assert.equal(survey.name, "Encuesta post-estancia");
    const response = await prisma.surveyResponse.findUniqueOrThrow({ where: { id: res.body.responseId } });
    assert.equal(response.surveyId, survey.id);
    assert.equal(response.reservationId, checkedOutId);
    assert.equal(response.guestId, primaryGuestId);
    assert.equal(Number(response.score), 9);
    assert.deepEqual(response.responsesJson, { comment: "Todo perfecto", score: 9, source: "guest_portal" });

    const view = await call("GET", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken } });
    assert.equal(view.body.survey.id, survey.id);
    assert.equal(view.body.answered, true);
    assert.equal(view.body.available, false);
    // La estancia (sign-in normal) refleja la respuesta; el token de la encuesta sigue sin abrirla.
    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode: `L7-SV-${RUN}`, email: primaryEmail, propertyId: A.propertyA } });
    const stay = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": signIn.body.token as string } });
    assert.deepEqual(stay.body.survey, { invited: true, answered: true });
    assert.equal((await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": inviteToken } })).status, 401);

    const again = await call("POST", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken }, payload: { score: 3 } });
    assert.equal(again.status, 409, again.raw.slice(0, 300));
    assert.equal(again.body.details?.code, "SURVEY_ALREADY_ANSWERED");
    assert.equal(again.body.details?.responseId, res.body.responseId);
    assert.equal(await prisma.surveyResponse.count({ where: { reservationId: checkedOutId } }), 1);

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: A.organizationId, action: "SurveyResponseReceived", entityId: res.body.responseId } });
    assert.ok(audit, "auditoría SurveyResponseReceived");
    assert.equal(JSON.stringify(audit!.afterJson).includes("Todo perfecto"), false, "la auditoría no lleva el texto libre");
  });

  it("corrector REV-L7-02: confirmada con la salida pasada (nunca se alojó) → GET available false (stage post_stay, reservationStatus confirmed) y POST 409 SURVEY_NOT_AVAILABLE; nada entra en el NPS", async () => {
    const code = `L7-SV-NS-${RUN}`;
    const missed = await prisma.reservation.create({
      data: { propertyId: A.propertyA, code, channel: "direct", status: "confirmed", arrivalDate: new Date(`${ARRIVED}T00:00:00.000Z`), departureDate: new Date(`${DEPARTED_YESTERDAY}T00:00:00.000Z`), adults: 1, roomTypeId: A.roomTypeA, totalAmount: "100.00", currency: "EUR", bookerName: "Titular Prueba", bookerEmail: primaryEmail },
      select: { id: true }
    });
    await prisma.reservationGuest.create({ data: { reservationId: missed.id, guestId: primaryGuestId, isPrimary: true } });
    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode: code, email: primaryEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    const token = signIn.body.token as string;
    const stay = await call("GET", "/guest-portal/stay", { headers: { "x-guest-token": token } });
    assert.equal(stay.body.stage, "post_stay");
    assert.equal(stay.body.reservation.status, "confirmed");
    const view = await call("GET", "/guest-portal/survey", { headers: { "x-guest-token": token } });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.stage, "post_stay");
    assert.equal(view.body.reservationStatus, "confirmed");
    assert.equal(view.body.available, false);
    const res = await call("POST", "/guest-portal/survey", { headers: { "x-guest-token": token }, payload: { score: 2, answers: { comment: "nunca fui" } } });
    assert.equal(res.status, 409, res.raw.slice(0, 300));
    assert.equal(res.body.details?.code, "SURVEY_NOT_AVAILABLE");
    assert.equal(res.body.details?.status, "confirmed");
    assert.equal(await prisma.surveyResponse.count({ where: { reservationId: missed.id } }), 0);
  });

  it("reserva sin salida (sign-in normal) → POST 409 SURVEY_NOT_AVAILABLE y GET available false", async () => {
    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode: confirmedCode, email: primaryEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    const token = signIn.body.token as string;
    const view = await call("GET", "/guest-portal/survey", { headers: { "x-guest-token": token } });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.available, false);
    assert.equal(view.body.stage, "pre_arrival");
    const res = await call("POST", "/guest-portal/survey", { headers: { "x-guest-token": token }, payload: { score: 10 } });
    assert.equal(res.status, 409, res.raw.slice(0, 300));
    assert.equal(res.body.details?.code, "SURVEY_NOT_AVAILABLE");
    assert.equal(await prisma.surveyResponse.count({ where: { reservationId: confirmedId } }), 0);
  });
});

describe("L7-04 · NPS en /dashboards/surveys", () => {
  it("la respuesta del portal cuenta como promotora: nps90d 100, 1 respuesta, comentario en recentResponses", async () => {
    const res = await call("GET", `/dashboards/surveys?propertyId=${A.propertyA}`, { headers: owner.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.equal(res.body.kpis.totalResponses90d, 1);
    assert.equal(res.body.kpis.promoters, 1);
    assert.equal(res.body.kpis.detractors, 0);
    assert.equal(res.body.kpis.nps90d, 100);
    assert.equal(res.body.recentResponses[0]?.score, 9);
    assert.equal(res.body.recentResponses[0]?.comment, "Todo perfecto");
    assert.equal(res.body.recentResponses[0]?.surveyName, "Encuesta post-estancia");
  });
});

describe("L7-04 · paso del tick sobre Postgres (acotado a las propiedades del tenant)", () => {
  it("invita a la salida de ayer de la propiedad con la encuesta activa (SIMULADO, token redactado), omite la ya invitada y la segunda vuelta es idempotente", async () => {
    const guest = await prisma.guest.create({ data: { id: `guest_${RUN}_tick`, organizationId: A.organizationId, firstName: "Bruno", surname1: "Delta", email: `tick.${RUN}@l7.test`, nationality: "ES" }, select: { id: true } });
    tickReservationId = await createCheckedOut(`L7-SV-T-${RUN}`, `tick.${RUN}@l7.test`, guest.id);
    const deps = defaultPostStaySurveyDeps();
    // El tick real recorre todas las propiedades con la encuesta activa; aquí solo las del tenant aislado.
    const scoped = { ...deps.db, propertyCheckInPolicy: { findMany: (args: any) => prisma.propertyCheckInPolicy.findMany({ ...args, where: { ...(args?.where ?? {}), propertyId: { in: [A.propertyA, A.propertyB] } } }) } } as unknown as PostStaySurveyDb;
    const clock = { day: TODAY, time: "10:00" };
    const first = await withEnv(DISPATCH_ENV, () => runPostStaySurveyStep({ ...deps, db: scoped, guestWebBaseUrl: () => "http://127.0.0.1:5237" }, clock));
    assert.equal(first.properties, 1, "solo la propiedad A tiene la encuesta activa");
    assert.equal(first.invited, 1, JSON.stringify(first.outcomes));
    assert.equal(first.skipped, 1, "la reserva invitada a mano se omite (already_invited)");
    assert.equal(first.failed, 0);
    const invited = first.outcomes.find((o) => o.reservationId === tickReservationId)!;
    assert.equal(invited.status, "invited");
    assert.equal(invited.simulated, true);
    assert.equal(invited.recipient, "t***@l7.test");
    assert.equal("surveyUrl" in invited, false, "el tick nunca devuelve el enlace");
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: `post_stay_survey:${tickReservationId}` } });
    assert.match(String(delivery.errorMessage), /^SIMULADO/);
    assert.equal((delivery.payloadJson as { variables: Record<string, unknown> }).variables.surveyUrl, "[redacted]");
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId: tickReservationId, status: "active" } }), 1);

    const second = await withEnv(DISPATCH_ENV, () => runPostStaySurveyStep({ ...deps, db: scoped, guestWebBaseUrl: () => "http://127.0.0.1:5237" }, clock));
    assert.equal(second.invited, 0);
    assert.equal(second.skipped, 2);
    assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: { startsWith: "post_stay_survey:" }, propertyId: A.propertyA } }), 2);
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId: tickReservationId } }), 1);
  });
});

describe("L7-04 · token caducado", () => {
  it("la sesión del enlace caducada → 401 GUEST_SESSION_INVALID y la fila pasa a expired", async () => {
    // La sesión del ENLACE (purpose survey), no las del sign-in por código que abren las pruebas anteriores.
    const session = await prisma.guestPortalSession.findFirstOrThrow({ where: { reservationId: checkedOutId, status: "active", purpose: "survey" } });
    await prisma.guestPortalSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const res = await call("GET", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken } });
    assert.equal(res.status, 401, res.raw.slice(0, 300));
    assert.equal(res.body.details?.code, "GUEST_SESSION_INVALID");
    assert.equal((await prisma.guestPortalSession.findUniqueOrThrow({ where: { id: session.id } })).status, "expired");
    const post = await call("POST", "/guest-portal/survey", { headers: { "x-guest-token": inviteToken }, payload: { score: 5 } });
    assert.equal(post.status, 401);
  });
});
