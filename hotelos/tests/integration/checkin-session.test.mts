/**
 * Tanda CHK · lote W2-A — sesión de pre-llegada, contexto de servicio, política y
 * kiosco (docs/design/CHECKIN-AUTOMATIZADO-IA.md §4a pasos 1-2, 6, 9; §7.1/§7.2;
 * R17/R18) — integración sobre Postgres real con una organización AISLADA
 * (helpers/l2-tenant.mts) y STRICT_ENV (auth real, RBAC_STRICT=true, sin auth de
 * demo). Módulos activados: pms_core, guest_self_service,
 * spain_guest_register_compliance.
 *
 * Qué fija:
 *   · invitar (POST /properties/:id/check-in/sessions) crea la CheckInSession
 *     `invited`, un CheckInGuest por viajero (titular + acompañante + hueco
 *     pending hasta adults+children), una GuestPortalSession con hash sha256 del
 *     token (nunca en claro) y un aviso honesto (`notification.simulated` sin
 *     proveedor); una plantilla inexistente no rompe la invitación
 *     ({ dispatched:false, reason: template_not_found });
 *   · GET /guest-portal/check-in solo con token (R18): sin token 401 tipado,
 *     token de otra propiedad 401;
 *   · PATCH escribe Reservation.eta, las preferencias del vocabulario (sesión +
 *     Guest.preferencesJson del titular) y el texto libre en specialRequests;
 *   · alta de acompañante hasta el límite → 409 CHECKIN_GUEST_LIMIT;
 *   · MRZ válida rellena campos (source mrz_reader, sin imagen, fieldsJson sin
 *     PII, identityVerifiedAt sigue null), inválida 400 MRZ_CHECKSUM_FAILED;
 *   · complete con datos incompletos 409 CHECKIN_INCOMPLETE { missing }; completo
 *     → ready_for_arrival, partes creados con el contexto de servicio (menor < 14
 *     declarado por el titular, sin firma) y segundo complete idempotente;
 *   · política: GET con recepcionista 200 (valores por defecto), PUT recepcionista
 *     403, PUT jefatura de recepción 200;
 *   · kiosco: alta → pair (código de 8 dígitos una vez) → claim → segundo claim 409
 *     KIOSK_PAIRING_INVALID; solo hashes en la fila;
 *   · llegadas del día con preCheckIn;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/checkin-session.test.mts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildMrz } = await import("@hotelos/compliance");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { inviteReservation } = await import("../../apps/api/src/modules/checkin/checkin-session.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `chk${newRunId()}`;
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let receptionist: Session;
let frontOfficeManager: Session;
let generalManager: Session;

let reservationId = "";
let primaryGuestId = "";
let companionGuestId = "";
let sessionId = "";
let token = "";
let primaryCheckInGuestId = "";
let companionCheckInGuestId = "";
let thirdCheckInGuestId = "";

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

const guestHeaders = () => ({ "x-guest-token": token });

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance"]);

  // Jefatura de recepción (front_office_manager: guest_self_service.manage) — el
  // helper no la crea; misma forma que sus usuarios.
  const fomId = `usr_l2_fom_${RUN}`;
  const fomEmail = `jefatura.l2.${RUN}@faranda.test`;
  await prisma.user.create({
    data: { id: fomId, organizationId: A.organizationId, email: fomEmail, fullName: "Jefatura L2", status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const fomRole = A.roles.front_office_manager;
  assert.ok(fomRole, "rol de plantilla front_office_manager en la organización aislada");
  await prisma.userRoleAssignment.create({ data: { userId: fomId, roleId: fomRole, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: `seed chk ${RUN}` } });
  resetRbacScopeCacheForTests();

  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
  generalManager = await loginOrThrow(app, A.users.generalManager.email, A.password);
  frontOfficeManager = await loginOrThrow(app, fomEmail, A.password);

  // Titular con todos los datos del parte; acompañante con perfil parcial (sin
  // documento ni dirección); tercer hueco (menor) sin perfil. adults 2 + children 1.
  const primary = await prisma.guest.create({
    data: {
      id: `guest_${RUN}_titular`,
      organizationId: A.organizationId,
      firstName: "Ana",
      surname1: "Gamma",
      sex: "M",
      nationality: "ESP",
      dateOfBirth: new Date("1990-04-12T00:00:00.000Z"),
      documentType: "DNI",
      documentNumber: `CHK${RUN.slice(-6).toUpperCase()}1`,
      documentSupportNumber: "AAA000001",
      email: `titular.${RUN}@chk.test`,
      mobilePhone: "+34600000101",
      residenceAddress: "Rúa da Proba 1",
      residenceLocality: "A Coruña",
      residenceCountry: "ESP",
      preferencesJson: ["view_sea"]
    },
    select: { id: true }
  });
  const companion = await prisma.guest.create({
    data: { id: `guest_${RUN}_acomp`, organizationId: A.organizationId, firstName: "Luis", surname1: "Delta", nationality: "ESP", dateOfBirth: new Date("1988-01-20T00:00:00.000Z") },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  companionGuestId = companion.id;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: `CHK-INV-${RUN}`,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: 2,
      children: 1,
      roomTypeId: A.roomTypeA,
      bookerName: "Ana Gamma",
      bookerEmail: `titular.${RUN}@chk.test`
    },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: primaryGuestId, isPrimary: true } });
  await prisma.reservationGuest.create({ data: { reservationId, guestId: companionGuestId, isPrimary: false } });
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("W2-A · invitar", () => {
  it("crea sesión invited, viajeros hasta adults+children, token con hash y aviso honesto", async () => {
    const res = await call("POST", `/properties/${A.propertyA}/check-in/sessions`, { headers: receptionist.headers, payload: { reservationId, channel: "email" } });
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.session.status, "invited");
    assert.equal(res.body.session.channel, "email");
    assert.equal(res.body.session.reservationId, reservationId);
    assert.deepEqual(res.body.session.preferences, ["view_sea"], "preferencias del titular filtradas al vocabulario");
    const guests = res.body.session.guests as Array<Record<string, any>>;
    assert.equal(guests.length, 3, "titular + acompañante + hueco pending");
    assert.equal(guests[0]!.isPrimary, true);
    assert.equal(guests[0]!.guestId, primaryGuestId);
    assert.equal(guests[0]!.status, "data_complete", "el titular llega completo desde su perfil");
    assert.equal(guests[0]!.documentNumberLast3.length, 3);
    assert.ok(!("documentNumber" in guests[0]!) && !("email" in guests[0]!), "el DTO no lleva PII");
    assert.equal(guests[1]!.guestId, companionGuestId);
    assert.equal(guests[1]!.status, "pending");
    assert.equal(guests[2]!.guestId, null);
    assert.equal(guests[2]!.status, "pending");
    sessionId = res.body.session.id;
    primaryCheckInGuestId = guests[0]!.id;
    companionCheckInGuestId = guests[1]!.id;
    thirdCheckInGuestId = guests[2]!.id;

    assert.equal(typeof res.body.token, "string", "fuera de producción el token viaja en la respuesta");
    token = res.body.token;
    assert.match(res.body.checkInUrl, /\/checkin\?token=.+&property=/);
    const portal = await prisma.guestPortalSession.findMany({ where: { reservationId, status: "active" } });
    assert.equal(portal.length, 1);
    assert.equal(portal[0]!.tokenHash, createHash("sha256").update(token).digest("hex"), "solo el hash del token en BD");
    assert.equal(portal[0]!.propertyId, A.propertyA);
    assert.ok(portal[0]!.expiresAt.getTime() >= new Date(`${DEPARTURE}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000, "TTL hasta la salida + 1 día");

    const notification = res.body.notification;
    assert.equal(notification.channel, "email");
    assert.equal(notification.recipient, `t***@chk.test`, "destinatario enmascarado");
    // Honestidad sin proveedor de email: en desarrollo el dispatcher marca el envío
    // SIMULADO (status sent + errorMessage); bajo STRICT_ENV (NODE_ENV=production)
    // el proveedor ausente responde failed y la invitación lo dice { dispatched:false, reason }.
    // En ningún caso se finge una entrega real ni se pierde la fila de entrega.
    assert.equal(typeof notification.deliveryId, "string", "la entrega queda registrada con la plantilla de sistema");
    const delivery = await prisma.notificationDelivery.findUnique({ where: { id: notification.deliveryId } });
    assert.equal(delivery?.templateCode, "checkin_invitation");
    if (notification.dispatched) {
      assert.equal(notification.simulated, true, "sin proveedor de email el envío es SIMULADO, nunca fingido");
      assert.match(delivery?.errorMessage ?? "", /^SIMULADO/);
    } else {
      assert.equal(notification.simulated, false);
      assert.equal(typeof notification.reason, "string");
      assert.equal(delivery?.status, "failed");
    }
    assert.match(delivery?.recipient ?? "", /@chk\.test$/, "el destinatario real (descifrado) es el correo del titular, nunca un envelope");
    assert.equal(await prisma.checkInSession.count({ where: { reservationId } }), 1);
  });

  it("una plantilla inexistente no rompe la invitación: { dispatched:false, reason: template_not_found } y el token existe", async () => {
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { reservationId } });
    const previousPortal = session.guestPortalSessionId;
    const result = await inviteReservation({
      reservationId,
      channel: "email",
      context: { organizationId: A.organizationId, propertyId: A.propertyA, userId: receptionist.userId, fullName: "Recepción", deviceId: "test", permissions: ["pms.reservation.modify"] },
      correlationId: `corr_${RUN}`,
      templateCode: `checkin_invitation_inexistente_${RUN}`
    });
    assert.equal(result.notification.dispatched, false);
    assert.equal(result.notification.reason, "template_not_found");
    assert.equal(typeof result.token, "string");
    assert.equal(result.session.status, "invited");
    // El reenvío revoca el enlace anterior y deja uno activo.
    const previous = await prisma.guestPortalSession.findUnique({ where: { id: previousPortal! } });
    assert.equal(previous?.status, "revoked");
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId, status: "active" } }), 1);
    token = result.token!;
  });

  it("reenviar desde la ruta de personal devuelve un token nuevo y la sesión sigue siendo una", async () => {
    const res = await call("POST", `/properties/${A.propertyA}/check-in/sessions/${sessionId}/resend`, { headers: receptionist.headers, payload: { channel: "email" } });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.notEqual(res.body.token, token);
    token = res.body.token;
    assert.equal(await prisma.checkInSession.count({ where: { reservationId } }), 1);
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId, status: "active" } }), 1);
  });

  it("la sesión de personal se lee por id y otra propiedad responde 404 opaco", async () => {
    const ok = await call("GET", `/properties/${A.propertyA}/check-in/sessions/${sessionId}`, { headers: receptionist.headers });
    assert.equal(ok.status, 200, ok.raw.slice(0, 300));
    assert.equal(ok.body.guests.length, 3);
    assert.equal(ok.body.policy.propertyId, A.propertyA);
    const cross = await call("GET", `/properties/${A.propertyB}/check-in/sessions/${sessionId}`, { headers: generalManager.headers });
    assert.equal(cross.status, 404, cross.raw.slice(0, 300));
  });
});

describe("W2-A · GET /guest-portal/check-in solo con token (R18)", () => {
  it("sin token 401 tipado; con token 200 con viajeros, política y pasos", async () => {
    const anonymous = await call("GET", "/guest-portal/check-in");
    assert.equal(anonymous.status, 401, anonymous.raw.slice(0, 300));
    assert.equal(anonymous.body.details?.code, "GUEST_SESSION_INVALID");
    const bogus = await call("GET", "/guest-portal/check-in", { headers: { "x-guest-token": "no-es-un-token" } });
    assert.equal(bogus.status, 401);

    const ok = await call("GET", "/guest-portal/check-in", { headers: guestHeaders() });
    assert.equal(ok.status, 200, ok.raw.slice(0, 300));
    assert.equal(ok.body.id, sessionId);
    assert.equal(ok.body.guests.length, 3);
    assert.equal(ok.body.policy.selfCheckInEnabled, false, "política por defecto sin fila");
    assert.ok(Array.isArray(ok.body.steps) && ok.body.steps.some((step: any) => step.key === "complete" && step.status === "pending"));
    const byQuery = await call("GET", `/guest-portal/check-in?token=${encodeURIComponent(token)}`);
    assert.equal(byQuery.status, 200, "el token también se admite en ?token=");
  });

  it("un token de otra propiedad no abre la sesión (401)", async () => {
    const foreign = `foreign_${RUN}_${Date.now()}`;
    await prisma.guestPortalSession.create({
      data: { propertyId: A.propertyB, reservationId, guestId: primaryGuestId, tokenHash: createHash("sha256").update(foreign).digest("hex"), status: "active", expiresAt: new Date(Date.now() + 3600_000) }
    });
    const res = await call("GET", "/guest-portal/check-in", { headers: { "x-guest-token": foreign } });
    assert.equal(res.status, 401, res.raw.slice(0, 300));
    assert.equal(res.body.details?.code, "GUEST_SESSION_INVALID");
  });
});

describe("W2-A · PATCH ETA, preferencias y consentimientos", () => {
  it("escribe Reservation.eta, las preferencias del vocabulario y el texto libre en specialRequests", async () => {
    const res = await call("PATCH", "/guest-portal/check-in", {
      headers: guestHeaders(),
      payload: { eta: "16:30", preferences: { codes: ["quiet", "vista_mar", "floor_high"], freeText: "cuna para el bebé" }, consent: { gdpr: true, aiDisclosure: true } }
    });
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.status, "in_progress");
    assert.equal(res.body.etaDeclared, "16:30");
    assert.deepEqual(res.body.preferences, ["quiet", "floor_high"]);
    assert.equal(typeof res.body.consent.gdprAt, "string");
    assert.equal(typeof res.body.consent.aiDisclosureAt, "string");
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { eta: true, specialRequests: true } });
    assert.equal(reservation.eta, "16:30");
    assert.equal(reservation.specialRequests, "cuna para el bebé");
    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: primaryGuestId }, select: { preferencesJson: true } });
    assert.deepEqual(guest.preferencesJson, ["view_sea", "quiet", "floor_high"], "Guest.preferencesJson normalizado a string[] y fusionado");
  });

  it("una ETA inválida responde 400 y no toca la reserva; un cuerpo desconocido 400 VALIDATION_ERROR", async () => {
    const bad = await call("PATCH", "/guest-portal/check-in", { headers: guestHeaders(), payload: { eta: "a las cinco" } });
    assert.equal(bad.status, 400, bad.raw.slice(0, 300));
    const unknown = await call("PATCH", "/guest-portal/check-in", { headers: guestHeaders(), payload: { foo: 1 } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.details?.code, "VALIDATION_ERROR");
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { eta: true } });
    assert.equal(reservation.eta, "16:30");
  });
});

describe("W2-A · acompañantes hasta el límite", () => {
  it("el alta rellena el hueco pending (menor declarado por el titular) y la siguiente responde 409 CHECKIN_GUEST_LIMIT", async () => {
    const minor = await call("POST", "/guest-portal/check-in/guests", {
      headers: guestHeaders(),
      payload: { firstName: "Leo", surname1: "Gamma", dateOfBirth: "2018-06-15", kinship: "hijo" }
    });
    assert.equal(minor.status, 201, minor.raw.slice(0, 400));
    assert.equal(minor.body.guest.id, thirdCheckInGuestId, "reutiliza el hueco pending en vez de crear un cuarto");
    assert.equal(minor.body.guest.isMinor, true);
    assert.equal(minor.body.guest.ageAtArrival, 8);
    assert.equal(minor.body.guest.providedByCheckInGuestId, primaryCheckInGuestId, "por defecto el titular adulto aporta los datos");
    // Corrector REV3-06: un menor de 14 no necesita documento ni teléfono propios (los aporta el adulto); sí el resto del parte.
    assert.ok(!minor.body.missing.includes("documentNumber") && !minor.body.missing.includes("documentType") && !minor.body.missing.includes("phoneMobile"), minor.body.missing.join(","));
    assert.ok(minor.body.missing.includes("residenceFullAddress"));
    assert.ok(!minor.body.missing.includes("signedAt"));

    const fourth = await call("POST", "/guest-portal/check-in/guests", { headers: guestHeaders(), payload: { firstName: "Cuarto", surname1: "Sigma" } });
    assert.equal(fourth.status, 409, fourth.raw.slice(0, 300));
    assert.equal(fourth.body.details?.code, "CHECKIN_GUEST_LIMIT");
    assert.equal(fourth.body.details?.limit, 3);
    assert.equal(await prisma.checkInGuest.count({ where: { sessionId } }), 3);
  });

  it("el titular no se puede eliminar (409) y un viajero inexistente es 404", async () => {
    const primary = await call("DELETE", `/guest-portal/check-in/guests/${primaryCheckInGuestId}`, { headers: guestHeaders() });
    assert.equal(primary.status, 409, primary.raw.slice(0, 300));
    const missing = await call("PATCH", `/guest-portal/check-in/guests/no_existe`, { headers: guestHeaders(), payload: { firstName: "X" } });
    assert.equal(missing.status, 404);
  });
});

describe("W2-A · MRZ", () => {
  it("una MRZ válida rellena los campos del acompañante sin guardar imagen ni PII en la captura; inválida 400", async () => {
    const lines = buildMrz({
      format: "TD3",
      documentType: "PASSPORT",
      issuingCountry: "UTO",
      documentNumber: "XA1234567",
      surname: "Delta",
      givenNames: "Luis",
      dateOfBirth: "1988-01-20",
      sex: "H",
      expiryDate: "2030-11-05",
      nationality: "UTO"
    });
    const ok = await call("POST", `/guest-portal/check-in/guests/${companionCheckInGuestId}/mrz`, { headers: guestHeaders(), payload: { lines } });
    assert.equal(ok.status, 200, ok.raw.slice(0, 400));
    assert.equal(ok.body.guest.documentType, "PASSPORT");
    assert.equal(ok.body.guest.documentNumberLast3, "567");
    assert.equal(ok.body.guest.status, "document_captured", "faltan dirección y teléfono");
    assert.equal(ok.body.guest.identityVerificationMethod, "mrz_checksum");
    assert.equal(ok.body.guest.identityVerifiedAt, null, "el checksum NO verifica a la persona");
    assert.equal(ok.body.capture.source, "mrz_reader");
    assert.equal(ok.body.capture.format, "TD3");
    assert.deepEqual(ok.body.capture.checks, { document: true, birth: true, expiry: true, composite: true });
    assert.ok(!("documentNumber" in ok.body.capture.fields) && !("firstName" in ok.body.capture.fields), "fieldsJson sin PII");
    const capture = await prisma.documentCapture.findUniqueOrThrow({ where: { id: ok.body.capture.id } });
    assert.equal(capture.imageStored, false);
    assert.equal(capture.checkInGuestId, companionCheckInGuestId);
    assert.ok(capture.purgeAt.getTime() > Date.now() + 29 * 24 * 3600 * 1000);
    const row = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: companionCheckInGuestId } });
    assert.equal(row.documentNumber, "XA1234567", "descifrado por la extensión");
    assert.equal(row.firstName, "LUIS");

    const tampered = [lines[0]!, lines[1]!.slice(0, 9) + (lines[1]![9] === "9" ? "0" : "9") + lines[1]!.slice(10)];
    const bad = await call("POST", `/guest-portal/check-in/guests/${companionCheckInGuestId}/mrz`, { headers: guestHeaders(), payload: { lines: tampered } });
    assert.equal(bad.status, 400, bad.raw.slice(0, 300));
    assert.equal(bad.body.details?.code, "MRZ_CHECKSUM_FAILED");
    assert.equal(await prisma.documentCapture.count({ where: { checkInGuestId: companionCheckInGuestId } }), 1, "la lectura inválida no deja captura");
  });
});

describe("W2-A · cierre del pre-check-in", () => {
  it("con datos incompletos responde 409 CHECKIN_INCOMPLETE con missing por viajero", async () => {
    const res = await call("POST", "/guest-portal/check-in/complete", { headers: guestHeaders() });
    assert.equal(res.status, 409, res.raw.slice(0, 400));
    assert.equal(res.body.details?.code, "CHECKIN_INCOMPLETE");
    const missing = res.body.details.missing as Array<{ checkInGuestId: string; fields: string[] }>;
    assert.deepEqual(missing.map((m) => m.checkInGuestId).sort(), [companionCheckInGuestId, thirdCheckInGuestId].sort(), "el titular está completo");
    const companion = missing.find((m) => m.checkInGuestId === companionCheckInGuestId)!;
    assert.ok(companion.fields.includes("residenceFullAddress") && companion.fields.includes("phoneMobile"));
    assert.equal(await prisma.guestRegisterRecord.count({ where: { reservationId } }), 0, "sin partes hasta completar");
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, "in_progress");
  });

  it("completo → ready_for_arrival, un parte por viajero con el contexto de servicio y segundo complete idempotente", async () => {
    const companion = await call("PATCH", `/guest-portal/check-in/guests/${companionCheckInGuestId}`, {
      headers: guestHeaders(),
      payload: { residenceFullAddress: "Rúa da Proba 2", residenceLocality: "A Coruña", residenceCountry: "ESP", phoneMobile: "+34600000102" }
    });
    assert.equal(companion.status, 200, companion.raw.slice(0, 400));
    assert.deepEqual(companion.body.missing, []);
    assert.equal(companion.body.guest.status, "data_complete");
    const minor = await call("PATCH", `/guest-portal/check-in/guests/${thirdCheckInGuestId}`, {
      headers: guestHeaders(),
      payload: { sex: "H", nationality: "ESP", documentType: "PASSPORT", documentNumber: "PAB123456", residenceFullAddress: "Rúa da Proba 1", residenceLocality: "A Coruña", residenceCountry: "ESP", phoneMobile: "+34600000101" }
    });
    assert.equal(minor.status, 200, minor.raw.slice(0, 400));
    assert.deepEqual(minor.body.missing, []);

    const done = await call("POST", "/guest-portal/check-in/complete", { headers: guestHeaders() });
    assert.equal(done.status, 200, done.raw.slice(0, 400));
    assert.equal(done.body.status, "ready_for_arrival");
    assert.equal(typeof done.body.completedAt, "string");
    const guests = done.body.guests as Array<Record<string, any>>;
    assert.equal(guests.length, 3);
    assert.ok(guests.every((guest) => typeof guest.guestRegisterRecordId === "string"), "cada viajero enlaza su parte");
    assert.ok(guests.every((guest) => guest.guestId), "el menor sin perfil recibe Guest + vínculo");

    const records = await prisma.guestRegisterRecord.findMany({ where: { reservationId }, orderBy: { createdAt: "asc" } });
    assert.equal(records.length, 3);
    assert.ok(records.every((record) => record.createdBy === `guest:${sessionId}`), "creados por el contexto de servicio guest:<sessionId>");
    assert.ok(records.every((record) => record.idImageDiscarded === true));
    const primaryRecord = records.find((record) => record.guestId === primaryGuestId)!;
    assert.equal(primaryRecord.isPrimaryGuest, true);
    assert.equal(primaryRecord.status, "ready_to_sign", "adulto completo: solo falta la firma (paso 5)");
    const minorRow = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: thirdCheckInGuestId } });
    const minorRecord = records.find((record) => record.guestId === minorRow.guestId)!;
    assert.equal(minorRecord.isMinor, true);
    assert.equal(minorRecord.providedByAdultGuestId, primaryGuestId);
    assert.equal(minorRecord.kinshipRelationIfMinor, "hijo");
    assert.equal(minorRecord.status, "ready_to_submit", "menor < 14: sin firma, datos completos");
    assert.equal(await prisma.reservationGuest.count({ where: { reservationId } }), 3, "vínculo nuevo para el menor");

    const again = await call("POST", "/guest-portal/check-in/complete", { headers: guestHeaders() });
    assert.equal(again.status, 200, again.raw.slice(0, 300));
    assert.equal(await prisma.guestRegisterRecord.count({ where: { reservationId } }), 3, "idempotente: refresca, no duplica");
    assert.equal(again.body.completedAt, done.body.completedAt);
  });

  it("las llegadas del día muestran el pre-check-in completo", async () => {
    const res = await call("GET", `/properties/${A.propertyA}/check-in/arrivals?date=${ARRIVAL}`, { headers: receptionist.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    const item = (res.body.items as Array<Record<string, any>>).find((entry) => entry.reservationId === reservationId);
    assert.ok(item, "la reserva aparece en las llegadas");
    assert.equal(item!.eta, "16:30");
    assert.deepEqual(item!.preCheckIn, { sessionId, status: "ready_for_arrival", completedGuests: 3, totalGuests: 3, etaDeclared: "16:30" });
    assert.equal(item!.suggestion, null);
    assert.equal(item!.key, null);
    assert.deepEqual(item!.primaryGuest, { firstName: "Ana", surname1: "Gamma" });
  });
});

describe("W2-A · política por propiedad", () => {
  it("GET con recepcionista 200 (defectos), PUT recepcionista 403, PUT jefatura de recepción 200", async () => {
    const read = await call("GET", `/properties/${A.propertyA}/check-in/policy`, { headers: receptionist.headers });
    assert.equal(read.status, 200, read.raw.slice(0, 300));
    assert.equal(read.body.selfCheckInEnabled, false);
    assert.equal(read.body.inviteDaysBefore, 3);
    assert.deepEqual(read.body.allowedVerificationMethods, ["visual_reception", "mrz_checksum", "otp_email"]);
    assert.equal(read.body.updatedAt, "", "sin fila: valores del modelo");

    const forbidden = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: receptionist.headers, payload: { selfCheckInEnabled: true } });
    assert.equal(forbidden.status, 403, forbidden.raw.slice(0, 300));

    const written = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, {
      headers: frontOfficeManager.headers,
      payload: { selfCheckInEnabled: true, inviteDaysBefore: 2, depositPolicy: "fixed", depositAmount: "50.00", allowedVerificationMethods: ["mrz_checksum", "otp_phone"] }
    });
    assert.equal(written.status, 200, written.raw.slice(0, 400));
    assert.equal(written.body.selfCheckInEnabled, true);
    assert.equal(written.body.inviteDaysBefore, 2);
    assert.equal(written.body.depositAmount, "50.00");
    assert.deepEqual(written.body.allowedVerificationMethods, ["mrz_checksum", "otp_phone"]);
    const reread = await call("GET", `/properties/${A.propertyA}/check-in/policy`, { headers: receptionist.headers });
    assert.equal(reread.body.selfCheckInEnabled, true);
    assert.notEqual(reread.body.updatedAt, "");
    const invalid = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { depositPolicy: "todo" } });
    assert.equal(invalid.status, 400);
  });
});

describe("W2-A · kiosco", () => {
  it("alta → pair (código de 8 dígitos una vez) → claim → segundo claim 409; solo hashes en la fila", async () => {
    const created = await call("POST", `/properties/${A.propertyA}/kiosks`, { headers: generalManager.headers, payload: { name: "Tablet recepción", capabilities: { mrzReader: true } } });
    assert.equal(created.status, 201, created.raw.slice(0, 300));
    assert.equal(created.body.status, "unpaired");
    assert.equal(created.body.paired, false);
    assert.deepEqual(created.body.capabilities, { mrzReader: true, cardEncoder: false, paymentTerminal: false, printer: false });
    const deviceId = created.body.id as string;

    const forbidden = await call("POST", `/properties/${A.propertyA}/kiosks`, { headers: receptionist.headers, payload: { name: "No" } });
    assert.equal(forbidden.status, 403, "kiosk.configure no está en recepción");

    const paired = await call("POST", `/properties/${A.propertyA}/kiosks/${deviceId}/pair`, { headers: generalManager.headers });
    assert.equal(paired.status, 200, paired.raw.slice(0, 300));
    assert.match(paired.body.code, /^\d{8}$/);
    const code = paired.body.code as string;
    const pending = await prisma.kioskDevice.findUniqueOrThrow({ where: { id: deviceId } });
    assert.equal(pending.pairingCodeHash, createHash("sha256").update(code).digest("hex"), "solo el hash del código");
    assert.ok(pending.pairingExpiresAt && pending.pairingExpiresAt.getTime() > Date.now());

    const claim = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code } });
    assert.equal(claim.status, 200, claim.raw.slice(0, 300));
    assert.match(claim.body.deviceToken, /^[0-9a-f]{64}$/);
    assert.equal(claim.body.device.status, "online");
    assert.equal(claim.body.device.paired, true);
    assert.equal(claim.body.capabilities.mrzReader, true);
    const online = await prisma.kioskDevice.findUniqueOrThrow({ where: { id: deviceId } });
    assert.equal(online.deviceTokenHash, createHash("sha256").update(claim.body.deviceToken).digest("hex"));
    assert.equal(online.pairingCodeHash, null, "el código se consume");

    const second = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code } });
    assert.equal(second.status, 409, second.raw.slice(0, 300));
    assert.equal(second.body.details?.code, "KIOSK_PAIRING_INVALID");
    const wrong = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: "00000000" } });
    assert.equal(wrong.status, 409);

    const list = await call("GET", `/properties/${A.propertyA}/kiosks`, { headers: generalManager.headers });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.ok(!("deviceTokenHash" in list.body[0]) && !("pairingCodeHash" in list.body[0]), "el DTO no expone secretos");
    const cross = await call("PATCH", `/properties/${A.propertyB}/kiosks/${deviceId}`, { headers: generalManager.headers, payload: { name: "Otra" } });
    assert.equal(cross.status, 404, "confused deputy: el kiosco cuelga de A");
  });
});
