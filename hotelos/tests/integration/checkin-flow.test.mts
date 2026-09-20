/**
 * Tanda CHK · lote W3-A — flujo completo de llegada (docs/design/CHECKIN-AUTOMATIZADO-IA.md
 * §4c tabla «Llegada», §4d, §7.1 rutas restantes, §7.2 /reservations/:id/check-in/*,
 * R3, R17) — integración sobre Postgres real con una organización AISLADA
 * (helpers/l2-tenant.mts) y STRICT_ENV (auth real, RBAC_STRICT=true, sin auth de
 * demo) para el personal. Módulos: pms_core, guest_self_service,
 * spain_guest_register_compliance, ai_concierge. SES activado con el registro de
 * sandbox (SES_HOSPEDAJES_MODE por defecto sandbox → stub://ses-hospedajes-mock).
 * Dos viajeros (titular con perfil completo + acompañante parcial), llegada HOY
 * (fecha de negocio de la propiedad) para que la ventana ±1 día admita el check-in.
 *
 * Qué fija (en orden):
 *   · invitación → pre-check-in por token: documento del acompañante por MRZ
 *     sintética (buildMrz, source mrz_reader, sin imagen), imagen sin MRZ ni visión
 *     → 400 DOCUMENT_UNREADABLE, datos → complete → ready_for_arrival con 2 partes;
 *   · sugerencia (W2-C) + confirmación por recepción → habitación asignada;
 *   · política: solo visual_reception / otp_email → arrive 409 IDENTITY_NOT_VERIFIED
 *     (mrz_checksum no basta);
 *   · OTP por correo (debugCode fuera de producción) → código erróneo 409 →
 *     correcto → titular `verified` otp_email; el parte verificado;
 *   · arrive sin firmas → 409 GUEST_REGISTER_INCOMPLETE (huésped sin firma);
 *   · firma de ambos por el portal (201, sha256, PDF) y verify-identity del
 *     acompañante por recepción (visual_reception);
 *   · payment-link sin PSP → { status: "at_reception" } y paymentStatus at_reception; arrive →
 *     409 BALANCE_DUE + handed_off payment_failed (corrector REV3-02) hasta que la política
 *     admite el pago en recepción y el mostrador resuelve la derivación;
 *   · arrive → 200 con room/key; reserva checked_in, Stay in_house, parte encolado en
 *     sandbox (ses_hospedajes_submissions queued/accepted), bienvenida simulated,
 *     sesión checked_in, auditoría GUEST_SELF_CHECKED_IN, llave mobile_key;
 *   · segundo arrive → 409; token de otra propiedad → 401; recepción sobre una
 *     reserva de otra propiedad → 404; GET /reservations/:id/check-in y scan de
 *     recepción sin PII;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/checkin-flow.test.mts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildMrz } = await import("@hotelos/compliance");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { loadUserScope, permissionsFor, resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const assignment = await import("../../apps/api/src/modules/pms/room-assignment.service.js");
const { todayInTimezone } = await import("../../apps/api/src/modules/pms/pms.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `chkf${newRunId()}`;
const TIMEZONE = "Europe/Madrid";
const ARRIVAL = todayInTimezone(TIMEZONE);
const DEPARTURE = (() => {
  const d = new Date(`${ARRIVAL}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
})();
/** Huésped: rutas públicas (sin JWT); NODE_ENV≠production para que el dispatcher simule (SIMULADO) y el OTP devuelva debugCode con demo auth. */
const GUEST_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development", HOTELOS_ALLOW_DEMO_AUTH: "true", AI_PROVIDER: undefined };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 3)]);
const PNG_B64 = PNG.toString("base64");
const STROKE = { points: 40, durationMs: 1500, bbox: { x: 10, y: 10, width: 280, height: 110 } };

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let receptionist: Session;
let generalManager: Session;
let frontOfficeManager: Session;
let receptionContext: UserContext;

let reservationId = "";
let foreignReservationId = "";
let primaryGuestId = "";
let companionGuestId = "";
let sessionId = "";
let token = "";
let primaryCheckInGuestId = "";
let companionCheckInGuestId = "";
let assignedRoomId = "";
let folioId = "";
let otpDebugCode = "";

async function call(method: Method, url: string, options: { payload?: unknown; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}): Promise<Reply> {
  const res = await withEnv(options.env ?? STRICT_ENV, () =>
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
const guestCall = (method: Method, url: string, payload?: unknown) => call(method, url, { headers: guestHeaders(), ...(payload !== undefined ? { payload } : {}), env: GUEST_ENV });

async function contextFor(user: { id: string; fullName: string }, propertyId: string): Promise<UserContext> {
  resetRbacScopeCacheForTests();
  const scope = await loadUserScope(user.id, A.organizationId);
  return { organizationId: A.organizationId, propertyId, userId: user.id, fullName: user.fullName, deviceId: `w3a-${RUN}`, permissions: permissionsFor(scope, propertyId), assignedPropertyIds: scope.assignedPropertyIds, orgScope: scope.orgScope } as UserContext;
}

/** Espera a que la cadena SES en proceso resuelva las filas encoladas (sandbox → accepted). */
async function waitForSes(recordIds: string[], timeoutMs = 15_000): Promise<Array<{ guestRegisterRecordId: string; status: string; errorCode: string | null }>> {
  const started = Date.now();
  for (;;) {
    const rows = await prisma.sesHospedajesSubmission.findMany({ where: { guestRegisterRecordId: { in: recordIds } }, select: { guestRegisterRecordId: true, status: true, errorCode: true } });
    if (rows.length >= recordIds.length && rows.every((row) => !["queued", "sent", "retrying"].includes(row.status))) return rows;
    if (Date.now() - started > timeoutMs) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance", "ai_concierge"]);

  // Establecimiento SES completo + interruptor en las dos tablas (CS-01) con registro de sandbox.
  await prisma.property.update({
    where: { id: A.propertyA },
    data: { address: "Paseo Marítimo 1", municipality: "A Coruña", province: "A Coruña", postalCode: "15001", ineMunicipalityCode: "15030", sesHospedajesEnabled: true }
  });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: A.propertyA },
    create: { propertyId: A.propertyA, country: "ES", sesHospedajesEnabled: true, sesRegistryNumber: `CHKW3A-${RUN}` },
    update: { sesHospedajesEnabled: true, sesRegistryNumber: `CHKW3A-${RUN}` }
  });

  // Jefatura de recepción (front_office_manager: guest_self_service.manage) — el helper no la crea (misma forma que checkin-session.test.mts).
  const fomId = `usr_l2_fom_${RUN}`;
  const fomEmail = `jefatura.l2.${RUN}@faranda.test`;
  await prisma.user.create({ data: { id: fomId, organizationId: A.organizationId, email: fomEmail, fullName: "Jefatura W3A", status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  const fomRole = A.roles.front_office_manager;
  assert.ok(fomRole, "rol de plantilla front_office_manager en la organización aislada");
  await prisma.userRoleAssignment.create({ data: { userId: fomId, roleId: fomRole, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: `seed chk w3a ${RUN}` } });
  resetRbacScopeCacheForTests();

  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
  generalManager = await loginOrThrow(app, A.users.generalManager.email, A.password);
  frontOfficeManager = await loginOrThrow(app, fomEmail, A.password);
  receptionContext = await contextFor(A.users.receptionist, A.propertyA);

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
      residenceCountry: "ESP"
    },
    select: { id: true }
  });
  const companion = await prisma.guest.create({
    data: { id: `guest_${RUN}_acomp`, organizationId: A.organizationId, firstName: "Luis", surname1: "Delta", nationality: "ESP", dateOfBirth: new Date("1988-01-20T00:00:00.000Z"), email: `acomp.${RUN}@chk.test` },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  companionGuestId = companion.id;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: `CHK-W3A-${RUN}`,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: 2,
      children: 0,
      roomTypeId: A.roomTypeA,
      totalAmount: "200.00",
      currency: "EUR",
      bookerName: "Ana Gamma",
      bookerEmail: `titular.${RUN}@chk.test`
    },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: primaryGuestId, isPrimary: true } });
  await prisma.reservationGuest.create({ data: { reservationId, guestId: companionGuestId, isPrimary: false } });
  // Folio con saldo (200,00) para probar el enlace de pago sin PSP → pago en recepción.
  const folio = await prisma.folio.create({ data: { reservationId, guestId: primaryGuestId, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
  folioId = folio.id;
  await prisma.folioLine.create({ data: { folioId, type: "room", description: "Alojamiento DBL · 2 noches", quantity: 2, unitPrice: "100.00", taxCode: "ES_IVA_10", taxCategory: "accommodation", total: "200.00", postedBy: `test-${RUN}` } });

  // Reserva de la propiedad B (misma organización, fuera del alcance de recepción) para el 404 opaco.
  const foreign = await prisma.reservation.create({
    data: { propertyId: A.propertyB, code: `CHK-W3A-B-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`), departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`), adults: 1, children: 0, roomTypeId: A.roomTypeB, totalAmount: "100.00", currency: "EUR" },
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

describe("W3-A · pre-check-in por token (MRZ sintética, imagen ilegible, cierre)", () => {
  it("invita, lee la sesión y captura el documento del acompañante por MRZ (mrz_reader, sin imagen ni PII en la captura)", async () => {
    const invited = await call("POST", `/properties/${A.propertyA}/check-in/sessions`, { headers: receptionist.headers, payload: { reservationId, channel: "email" } });
    assert.equal(invited.status, 200, invited.raw.slice(0, 400));
    sessionId = invited.body.session.id;
    token = invited.body.token;
    assert.equal(typeof token, "string");
    const guests = invited.body.session.guests as Array<Record<string, any>>;
    assert.equal(guests.length, 2);
    primaryCheckInGuestId = guests[0]!.id;
    companionCheckInGuestId = guests[1]!.id;
    assert.equal(guests[0]!.status, "data_complete");
    assert.equal(guests[1]!.status, "pending");

    const lines = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XB7654321", surname: "Delta", givenNames: "Luis", dateOfBirth: "1988-01-20", sex: "H", expiryDate: "2031-03-15", nationality: "UTO" });
    const captured = await guestCall("POST", `/guest-portal/check-in/guests/${companionCheckInGuestId}/document`, { mrzLines: lines });
    assert.equal(captured.status, 200, captured.raw.slice(0, 500));
    assert.equal(captured.body.capture.source, "mrz_reader");
    assert.equal(captured.body.capture.persisted, true);
    assert.deepEqual(captured.body.capture.checks, { document: true, birth: true, expiry: true, composite: true });
    assert.equal(captured.body.guest.documentNumberLast3, "321");
    assert.equal(captured.body.guest.identityVerificationMethod, "mrz_checksum");
    assert.equal(captured.body.guest.identityVerifiedAt, null);
    const capture = await prisma.documentCapture.findUniqueOrThrow({ where: { id: captured.body.capture.captureId } });
    assert.equal(capture.imageStored, false);
    assert.ok(!("documentNumber" in (capture.fieldsJson as object)) && !("firstName" in (capture.fieldsJson as object)), "fieldsJson sin PII");
  });

  it("una imagen sin MRZ ni proveedor de visión responde 400 DOCUMENT_UNREADABLE y no vincula datos", async () => {
    const before = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: primaryCheckInGuestId }, select: { documentNumber: true, status: true } });
    const res = await guestCall("POST", `/guest-portal/check-in/guests/${primaryCheckInGuestId}/document`, { imageDataUrl: `data:image/png;base64,${PNG_B64}` });
    assert.equal(res.status, 400, res.raw.slice(0, 400));
    assert.equal(res.body.details?.code, "DOCUMENT_UNREADABLE");
    const after = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: primaryCheckInGuestId }, select: { documentNumber: true, status: true } });
    assert.deepEqual(after, before, "el viajero no cambia");
    const events = await prisma.identityDocumentProcessingEvent.count({ where: { propertyId: A.propertyA, reservationId } });
    assert.ok(events >= 1, "la imagen descartada deja su evento (image_discarded)");
    const bad = await guestCall("POST", `/guest-portal/check-in/guests/${primaryCheckInGuestId}/document`, {});
    assert.equal(bad.status, 400, "sin imagen ni MRZ: validación");
  });

  it("el titular lee su MRZ (DNI TD1), el acompañante completa dirección y móvil y el cierre deja ready_for_arrival con 2 partes", async () => {
    const primaryRow = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: primaryCheckInGuestId }, select: { documentNumber: true, documentSupportNumber: true } });
    const lines = buildMrz({ format: "TD1", documentType: "DNI", issuingCountry: "ESP", documentNumber: primaryRow.documentNumber!, supportNumber: primaryRow.documentSupportNumber!, surname: "Gamma", givenNames: "Ana", dateOfBirth: "1990-04-12", sex: "M", expiryDate: "2032-06-30", nationality: "ESP" });
    const captured = await guestCall("POST", `/guest-portal/check-in/guests/${primaryCheckInGuestId}/document`, { mrzLines: lines, documentType: "DNI" });
    assert.equal(captured.status, 200, captured.raw.slice(0, 500));
    assert.equal(captured.body.capture.mrzFormat, "TD1");
    assert.equal(captured.body.guest.identityVerificationMethod, "mrz_checksum");

    const patched = await guestCall("PATCH", `/guest-portal/check-in/guests/${companionCheckInGuestId}`, { residenceFullAddress: "Rúa da Proba 2", residenceLocality: "A Coruña", residenceCountry: "ESP", phoneMobile: "+34600000102" });
    assert.equal(patched.status, 200, patched.raw.slice(0, 400));
    assert.deepEqual(patched.body.missing, []);

    const done = await guestCall("POST", "/guest-portal/check-in/complete");
    assert.equal(done.status, 200, done.raw.slice(0, 400));
    assert.equal(done.body.status, "ready_for_arrival");
    assert.equal(await prisma.guestRegisterRecord.count({ where: { reservationId } }), 2);
    assert.ok((done.body.guests as Array<Record<string, any>>).every((guest) => typeof guest.guestRegisterRecordId === "string"));
  });
});

describe("W3-A · sugerencia y confirmación por recepción", () => {
  it("suggestForReservation (W2-C) + confirmSuggestion asignan una habitación limpia de la categoría reservada", async () => {
    const suggestion = await assignment.suggestForReservation({ context: receptionContext, reservationId, sessionId, persist: true });
    assert.ok(suggestion.persisted && suggestion.candidates.length > 0, `sin candidatas: ${suggestion.dataNotes.join(" · ")}`);
    const confirmed = await assignment.confirmSuggestion({ context: receptionContext, suggestionId: suggestion.id, correlationId: `corr_${RUN}_confirm` });
    assert.equal(confirmed.suggestion.status, "confirmed");
    assignedRoomId = confirmed.reservation.assignedRoomId!;
    assert.ok(assignedRoomId, "habitación asignada");
    const room = await prisma.room.findUniqueOrThrow({ where: { id: assignedRoomId }, select: { roomTypeId: true, housekeepingStatus: true, status: true } });
    assert.equal(room.roomTypeId, A.roomTypeA);
    assert.equal(room.housekeepingStatus, "clean");
  });
});

describe("W3-A · llegada: identidad, OTP, firma, pago y check-in", () => {
  it("con la política restringida a visual_reception/otp_email la llegada responde 409 IDENTITY_NOT_VERIFIED (mrz_checksum no basta)", async () => {
    const written = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception", "otp_email"], depositPolicy: "balance", welcomeChannelOrder: ["email"] } });
    assert.equal(written.status, 200, written.raw.slice(0, 400));
    const res = await guestCall("POST", "/guest-portal/check-in/arrive", {});
    assert.equal(res.status, 409, res.raw.slice(0, 400));
    assert.equal(res.body.details?.code, "IDENTITY_NOT_VERIFIED");
    assert.equal(res.body.details?.reason, "method_not_allowed");
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status, "confirmed");
  });

  it("OTP por correo: request guarda solo el hash y devuelve debugCode; código erróneo 409; correcto → titular verified otp_email y parte verificado", async () => {
    const requested = await guestCall("POST", "/guest-portal/check-in/otp/request", { channel: "email" });
    assert.equal(requested.status, 200, requested.raw.slice(0, 400));
    assert.equal(requested.body.method, "otp_email");
    assert.equal(requested.body.recipient, "t***@chk.test");
    assert.equal(requested.body.simulated, true, "sin proveedor de email el envío es SIMULADO");
    assert.match(requested.body.debugCode, /^\d{6}$/);
    otpDebugCode = requested.body.debugCode;
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    const otp = (session.consentJson as { otp: { hash: string; attempts: number } }).otp;
    assert.equal(otp.hash, createHash("sha256").update(`${sessionId}:${otpDebugCode}`).digest("hex"), "solo el hash ligado a la sesión");
    assert.equal(JSON.stringify(session.consentJson).includes(otpDebugCode), false);
    const delivery = await prisma.notificationDelivery.findFirst({ where: { templateCode: "checkin_otp", recipient: `titular.${RUN}@chk.test` } });
    assert.ok(delivery, "entrega checkin_otp registrada");

    const again = await guestCall("POST", "/guest-portal/check-in/otp/request", { channel: "email" });
    assert.equal(again.status, 429, "segundo código antes del cooldown");
    const wrong = await guestCall("POST", "/guest-portal/check-in/otp/verify", { code: otpDebugCode === "000000" ? "111111" : "000000" });
    assert.equal(wrong.status, 409, wrong.raw.slice(0, 300));
    assert.equal(wrong.body.details?.code, "OTP_INVALID");
    const ok = await guestCall("POST", "/guest-portal/check-in/otp/verify", { code: otpDebugCode });
    assert.equal(ok.status, 200, ok.raw.slice(0, 400));
    assert.equal(ok.body.guestStatus, "verified");
    assert.equal(ok.body.policyAllowed, true);
    const primaryRow = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: primaryCheckInGuestId } });
    assert.equal(primaryRow.identityVerificationMethod, "otp_email");
    assert.ok(primaryRow.identityVerifiedAt);
    assert.equal(primaryRow.identityVerifiedBy, `guest:${sessionId}`);
    const record = await prisma.guestRegisterRecord.findUniqueOrThrow({ where: { id: primaryRow.guestRegisterRecordId! } });
    assert.equal(record.identityVerified, true);
    assert.equal(record.identityVerificationMethod, "otp_email");
    const consumed = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal((consumed.consentJson as { otp?: unknown }).otp, undefined, "el OTP se consume");
  });

  it("sin firmas la llegada responde 409 GUEST_REGISTER_INCOMPLETE (huésped sin firma)", async () => {
    const res = await guestCall("POST", "/guest-portal/check-in/arrive", {});
    assert.equal(res.status, 409, res.raw.slice(0, 400));
    assert.equal(res.body.details?.code, "GUEST_REGISTER_INCOMPLETE");
    const missing = res.body.details.missing as Array<{ checkInGuestId: string; reason: string }>;
    assert.deepEqual(missing.map((m) => m.checkInGuestId).sort(), [primaryCheckInGuestId, companionCheckInGuestId].sort());
    assert.ok(missing.every((m) => m.reason === "signature"));
  });

  it("firma de ambos por el portal (touch_portal, 201, sha256 + PDF) y verify-identity del acompañante por recepción", async () => {
    for (const id of [primaryCheckInGuestId, companionCheckInGuestId]) {
      const res = await guestCall("POST", `/guest-portal/check-in/guests/${id}/signature`, { pngBase64: PNG_B64, strokeMeta: STROKE });
      assert.equal(res.status, 201, res.raw.slice(0, 500));
      assert.equal(res.body.method, "touch_portal");
      assert.equal(res.body.sha256, createHash("sha256").update(PNG).digest("hex"));
      assert.match(res.body.signatureId, /^sgn_/);
      assert.equal(res.body.guestRegisterStatus, "signed");
    }
    const signatures = await prisma.signature.findMany({ where: { propertyId: A.propertyA, sessionId }, select: { id: true, sha256: true, pdfSha256: true, method: true, ip: true } });
    assert.equal(signatures.length, 2);
    assert.ok(signatures.every((row) => row.sha256.length === 64 && row.pdfSha256 && row.method === "touch_portal" && row.ip));
    const records = await prisma.guestRegisterRecord.findMany({ where: { reservationId }, select: { signedAt: true, signatureObjectKey: true } });
    assert.ok(records.every((row) => row.signedAt && row.signatureObjectKey?.startsWith("sgn_")), "R3: el parte enlaza el id de la firma, nunca sig_*");

    const verified = await call("POST", `/reservations/${reservationId}/check-in/verify-identity`, { headers: receptionist.headers, payload: { checkInGuestId: companionCheckInGuestId, method: "visual_reception" } });
    assert.equal(verified.status, 200, verified.raw.slice(0, 400));
    assert.equal(verified.body.guest.identityVerificationMethod, "visual_reception");
    assert.equal(verified.body.guest.status, "verified");
    assert.equal(verified.body.guestRegisterRecord?.identityVerified, true);
  });

  it("payment-link sin PSP → { status: at_reception } y paymentStatus at_reception", async () => {
    const res = await guestCall("POST", "/guest-portal/check-in/payment-link", {});
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.status, "at_reception");
    assert.equal(res.body.reason, "PSP_NOT_CONFIGURED");
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.paymentStatus, "at_reception");
    assert.equal(await prisma.paymentIntent.count({ where: { folioId } }), 0, "sin PSP no nace ningún intento de pago");
  });

  it("corrector REV3-02: at_reception NO salta el depósito → 409 BALANCE_DUE y sesión handed_off payment_failed; con allowPayAtReception y la derivación resuelta, la llegada sigue", async () => {
    const refused = await guestCall("POST", "/guest-portal/check-in/arrive", { verification: { method: "otp_email" } });
    assert.equal(refused.status, 409, refused.raw.slice(0, 500));
    assert.equal(refused.body.details?.code, "BALANCE_DUE");
    assert.equal(refused.body.details?.handoffKind, "payment_failed");
    const handed = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(handed.status, "handed_off");
    assert.equal(handed.handoffKind, "payment_failed");
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status, "confirmed", "sin check-in");
    const policy = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { allowPayAtReception: true } });
    assert.equal(policy.status, 200, policy.raw.slice(0, 300));
    const resolved = await call("POST", `/reservations/${reservationId}/check-in/resolve-handoff`, { headers: receptionist.headers, payload: { note: "cobra en recepción" } });
    assert.equal(resolved.status, 200, resolved.raw.slice(0, 400));
    assert.equal(resolved.body.resolvedTo, "ready_for_arrival");
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } })).status, "ready_for_arrival");
  });

  it("arrive → 200 con habitación y llave; reserva checked_in, Stay in_house, SES encolado en sandbox, bienvenida simulada, sesión checked_in y auditoría", async () => {
    const res = await guestCall("POST", "/guest-portal/check-in/arrive", { verification: { method: "otp_email" } });
    assert.equal(res.status, 200, res.raw.slice(0, 800));
    assert.equal(res.body.actor, "guest");
    assert.equal(res.body.room.id, assignedRoomId);
    assert.equal(typeof res.body.room.number, "string");
    assert.equal(res.body.reassigned, false);
    assert.match(res.body.key.serialNumber, /^[0-9a-f]{24}$/);
    assert.match(res.body.key.qr, /^hotelos:\/\/unlock\?serial=/);
    assert.equal(res.body.key.wallet.apple.signedByApple, false, "sin certificado Apple sigue sin firmar y se dice");
    assert.ok((res.body.warnings as string[]).some((line) => line.includes("sin firmar por Apple")));
    assert.equal(res.body.ses.status, "queued", JSON.stringify(res.body.ses));
    assert.equal(res.body.ses.submissions.length, 2);
    assert.equal(res.body.welcome.status, "simulated");
    assert.equal(res.body.welcome.channel, "email");

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    assert.equal(reservation.status, "checked_in");
    assert.equal(reservation.assignedRoomId, assignedRoomId);
    assert.equal(await prisma.stay.count({ where: { reservationId, status: "in_house" } }), 1);
    const room = await prisma.room.findUniqueOrThrow({ where: { id: assignedRoomId }, select: { status: true } });
    assert.equal(room.status, "occupied");
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, "checked_in");
    assert.ok(session.checkedInAt && session.arrivedAt);
    assert.equal(session.handoffKind, null);
    assert.equal(await prisma.guestPortalAction.count({ where: { propertyId: A.propertyA, reservationId, actionType: "mobile_key", status: "active" } }), 1);

    // El perfil parcial del acompañante se completa SOLO en los campos vacíos con lo capturado (la comunicación SES lee los perfiles).
    const companionProfile = await prisma.guest.findUniqueOrThrow({ where: { id: companionGuestId } });
    assert.equal(companionProfile.documentNumber, "XB7654321");
    assert.equal(companionProfile.documentType, "PASSPORT");
    assert.equal(companionProfile.email, `acomp.${RUN}@chk.test`, "el correo existente no se pisa");
    assert.equal(companionProfile.surname1, "Delta");

    const records = await prisma.guestRegisterRecord.findMany({ where: { reservationId }, select: { id: true } });
    const ses = await waitForSes(records.map((row) => row.id));
    assert.equal(ses.length, 2, "un envío SES por parte");
    assert.ok(ses.every((row) => ["accepted", "queued", "sent"].includes(row.status)), JSON.stringify(ses));
    assert.ok(ses.some((row) => row.status === "accepted"), `sandbox acepta la comunicación: ${JSON.stringify(ses)}`);

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "GUEST_SELF_CHECKED_IN", entityType: "checkin_session", entityId: sessionId } });
    assert.ok(audit, "auditoría GUEST_SELF_CHECKED_IN con CheckInSession.id");
    assert.equal(audit!.actorUserId, `guest:${sessionId}`);
    const welcome = await prisma.notificationDelivery.findFirst({ where: { templateCode: "checkin_welcome", notificationId: `welcome:${reservationId}:email` } });
    assert.ok(welcome, "bienvenida registrada");
    assert.match(welcome!.errorMessage ?? "", /^SIMULADO/);
  });

  it("segundo arrive → 409; token de otra propiedad → 401; recepción sobre una reserva de otra propiedad → 404", async () => {
    const again = await guestCall("POST", "/guest-portal/check-in/arrive", {});
    assert.equal(again.status, 409, again.raw.slice(0, 300));
    assert.equal(again.body.details?.code, "CHECKIN_ALREADY_DONE");
    assert.equal(await prisma.stay.count({ where: { reservationId } }), 1, "sin segunda estancia");

    const foreign = `foreign_${RUN}_${Date.now()}`;
    await prisma.guestPortalSession.create({ data: { propertyId: A.propertyB, reservationId, guestId: primaryGuestId, tokenHash: createHash("sha256").update(foreign).digest("hex"), status: "active", expiresAt: new Date(Date.now() + 3600_000) } });
    const cross = await call("POST", "/guest-portal/check-in/arrive", { headers: { "x-guest-token": foreign }, payload: {}, env: GUEST_ENV });
    assert.equal(cross.status, 401, cross.raw.slice(0, 300));
    assert.equal(cross.body.details?.code, "GUEST_SESSION_INVALID");

    const staff = await call("GET", `/reservations/${foreignReservationId}/check-in`, { headers: receptionist.headers });
    assert.equal(staff.status, 404, staff.raw.slice(0, 300));
    const complete = await call("POST", `/reservations/${foreignReservationId}/check-in/complete`, { headers: receptionist.headers, payload: {} });
    assert.equal(complete.status, 404, complete.raw.slice(0, 300));
  });

  it("GET /reservations/:id/check-in devuelve sesión, viajeros, capturas y firmas sin PII; scan de recepción por MRZ", async () => {
    const view = await call("GET", `/reservations/${reservationId}/check-in`, { headers: receptionist.headers });
    assert.equal(view.status, 200, view.raw.slice(0, 400));
    assert.equal(view.body.status, "checked_in");
    const guests = view.body.guests as Array<Record<string, any>>;
    assert.equal(guests.length, 2);
    assert.ok(guests.every((guest) => !("documentNumber" in guest) && !("email" in guest) && !("phoneMobile" in guest)), "sin PII");
    assert.ok(guests.every((guest) => Array.isArray(guest.captures) && Array.isArray(guest.signatures)));
    assert.equal(guests[0]!.signatures.length, 1);
    assert.ok(guests[0]!.signatures[0].sha256 && !("objectKey" in guests[0]!.signatures[0]), "la firma expone hash, no el trazo");
    assert.ok(guests[1]!.captures.some((capture: Record<string, unknown>) => capture.source === "mrz_reader" && !("fieldsJson" in capture)));

    const lines = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XB7654321", surname: "Delta", givenNames: "Luis", dateOfBirth: "1988-01-20", sex: "H", expiryDate: "2031-03-15", nationality: "UTO" });
    const scan = await call("POST", `/reservations/${reservationId}/check-in/scan`, { headers: receptionist.headers, payload: { mrzLines: lines, checkInGuestId: companionCheckInGuestId } });
    assert.equal(scan.status, 200, scan.raw.slice(0, 400));
    assert.equal(scan.body.source, "mrz_reader");
    assert.equal(scan.body.persisted, true);
    const wrongGuest = await call("POST", `/reservations/${foreignReservationId}/check-in/scan`, { headers: receptionist.headers, payload: { mrzLines: lines, checkInGuestId: companionCheckInGuestId } });
    assert.equal(wrongGuest.status, 404, "viajero de otra reserva: 404 opaco");
  });
});
