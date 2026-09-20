/**
 * Tanda CHK · lote W4-C — kiosco de check-in (docs/design/CHECKIN-AUTOMATIZADO-IA.md
 * §4c columna «Kiosco / tablet», §7.1 `POST /guest-portal/check-in/kiosk/claim`,
 * §7.2 `POST /properties/:id/kiosks/:id/pair`, §8 fila «Kiosco») — integración
 * sobre Postgres real con una organización AISLADA (helpers/l2-tenant.mts) y
 * STRICT_ENV para el personal. Módulos: pms_core, guest_self_service,
 * spain_guest_register_compliance, ai_concierge. Llegada HOY (fecha de negocio)
 * para que la ventana ±1 día admita el check-in.
 *
 * Qué fija (en orden):
 *   · pair (dirección; `front_office_manager` NO tiene kiosk.configure: 403 documentado)
 *     → claim → deviceToken; el DTO nunca expone hashes;
 *   · claim caducado → 409 KIOSK_PAIRING_INVALID (pairingExpiresAt en el pasado);
 *     re-pair emite otro código y el caducado sigue sin valer;
 *   · pre-check-in del huésped por token con `x-kiosk-token`: MRZ sintética (TD3)
 *     → identityVerificationMethod mrz_checksum (sin fecha); complete → partes;
 *   · token de kiosco de OTRA propiedad: el API lo ignora (firma touch_portal y
 *     arrive como actor guest, nunca 401 — checkin.routes.ts kioskFrom → null); un
 *     token de huésped de otra propiedad sí responde 401 GUEST_SESSION_INVALID;
 *   · `x-kiosk-token` permite `arrive` con mrz_checksum SOLO si la política lo admite:
 *     política restringida → 409 IDENTITY_NOT_VERIFIED method_not_allowed (también con
 *     verification.method reader_hardware en el cuerpo: el API no lo lee);
 *     requireVisualCheckAtKiosk → 409 kiosk_visual_check; política que admite
 *     mrz_checksum → 200 actor kiosk, sesión checked_in con kioskDeviceId;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/kiosk-pairing.test.mts
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
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { todayInTimezone } = await import("../../apps/api/src/modules/pms/pms.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `chkk${newRunId()}`;
const TIMEZONE = "Europe/Madrid";
const ARRIVAL = todayInTimezone(TIMEZONE);
const DEPARTURE = (() => {
  const d = new Date(`${ARRIVAL}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
})();
/** Huésped y kiosco: rutas públicas (sin JWT); NODE_ENV≠production para que el dispatcher simule. */
const GUEST_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development", HOTELOS_ALLOW_DEMO_AUTH: "true", AI_PROVIDER: undefined };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, 7)]);
const PNG_B64 = PNG.toString("base64");
const STROKE = { points: 32, durationMs: 1200, bbox: { x: 8, y: 8, width: 260, height: 100 } };
const MRZ_LINES = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "KX1234567", surname: "Kappa", givenNames: "Lucia", dateOfBirth: "1991-06-30", sex: "M", expiryDate: "2032-01-31", nationality: "UTO" });

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let receptionist: Session;
let generalManager: Session;
let frontOfficeManager: Session;

let reservationId = "";
let primaryGuestId = "";
let sessionId = "";
let token = "";
let primaryCheckInGuestId = "";
let deviceId = "";
let deviceToken = "";
let foreignDeviceToken = "";
let roomId = "";

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

const guestCall = (method: Method, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) =>
  call(method, url, { headers: { "x-guest-token": token, ...extraHeaders }, ...(payload !== undefined ? { payload } : {}), env: GUEST_ENV });
const kioskCall = (method: Method, url: string, payload?: unknown) => guestCall(method, url, payload, { "x-kiosk-token": deviceToken });

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance", "ai_concierge"]);
  await enableModules(A.propertyB, ["pms_core", "guest_self_service"]);

  // Jefatura de recepción (front_office_manager): el helper no la crea (misma forma que checkin-flow.test.mts).
  const fomId = `usr_l2_fom_${RUN}`;
  const fomEmail = `jefatura.l2.${RUN}@faranda.test`;
  await prisma.user.create({ data: { id: fomId, organizationId: A.organizationId, email: fomEmail, fullName: "Jefatura W4C", status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  const fomRole = A.roles.front_office_manager;
  assert.ok(fomRole, "rol de plantilla front_office_manager en la organización aislada");
  await prisma.userRoleAssignment.create({ data: { userId: fomId, roleId: fomRole, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: `seed chk w4c ${RUN}` } });
  resetRbacScopeCacheForTests();

  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
  generalManager = await loginOrThrow(app, A.users.generalManager.email, A.password);
  frontOfficeManager = await loginOrThrow(app, fomEmail, A.password);

  // Titular con perfil completo salvo el documento (lo aporta la MRZ del kiosco).
  const primary = await prisma.guest.create({
    data: {
      id: `guest_${RUN}_titular`,
      organizationId: A.organizationId,
      firstName: "Lucia",
      surname1: "Kappa",
      sex: "M",
      nationality: "UTO",
      dateOfBirth: new Date("1991-06-30T00:00:00.000Z"),
      email: `titular.${RUN}@chk.test`,
      mobilePhone: "+34600000301",
      residenceAddress: "Rúa da Proba 3",
      residenceLocality: "A Coruña",
      residenceCountry: "ESP"
    },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: `CHK-W4C-${RUN}`,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: 1,
      children: 0,
      roomTypeId: A.roomTypeA,
      totalAmount: "180.00",
      currency: "EUR",
      bookerName: "Lucia Kappa",
      bookerEmail: `titular.${RUN}@chk.test`
    },
    select: { id: true }
  });
  reservationId = reservation.id;
  await prisma.reservationGuest.create({ data: { reservationId, guestId: primaryGuestId, isPrimary: true } });
  // Habitación lista (limpia, libre) asignada a mano para que el check-in no dependa del motor de asignación.
  roomId = A.roomsA[0]!;
  await prisma.room.update({ where: { id: roomId }, data: { status: "clean", housekeepingStatus: "clean" } });
  await prisma.reservation.update({ where: { id: reservationId }, data: { assignedRoomId: roomId } });
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("W4-C · emparejamiento del kiosco", () => {
  it("pair (dirección) → claim → deviceToken; jefatura de recepción sin kiosk.configure → 403; el DTO no expone hashes", async () => {
    const created = await call("POST", `/properties/${A.propertyA}/kiosks`, { headers: generalManager.headers, payload: { name: "Tablet W4C", capabilities: { mrzReader: true } } });
    assert.equal(created.status, 201, created.raw.slice(0, 300));
    deviceId = created.body.id;
    assert.equal(created.body.paired, false);

    const fomPair = await call("POST", `/properties/${A.propertyA}/kiosks/${deviceId}/pair`, { headers: frontOfficeManager.headers });
    assert.equal(fomPair.status, 403, "front_office_manager no tiene kiosk.configure (permissions.ts): el brief dice «jefe de recepción», hoy empareja dirección");
    const recPair = await call("POST", `/properties/${A.propertyA}/kiosks/${deviceId}/pair`, { headers: receptionist.headers });
    assert.equal(recPair.status, 403);

    const paired = await call("POST", `/properties/${A.propertyA}/kiosks/${deviceId}/pair`, { headers: generalManager.headers });
    assert.equal(paired.status, 200, paired.raw.slice(0, 300));
    assert.match(paired.body.code, /^\d{8}$/);
    assert.ok(new Date(paired.body.expiresAt).getTime() > Date.now());
    assert.ok(!("pairingCodeHash" in paired.body.device) && !("deviceTokenHash" in paired.body.device));

    const claim = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: paired.body.code }, env: GUEST_ENV });
    assert.equal(claim.status, 200, claim.raw.slice(0, 300));
    assert.match(claim.body.deviceToken, /^[0-9a-f]{64}$/);
    assert.equal(claim.body.device.status, "online");
    assert.equal(claim.body.capabilities.mrzReader, true);
    deviceToken = claim.body.deviceToken;
    const row = await prisma.kioskDevice.findUniqueOrThrow({ where: { id: deviceId } });
    assert.equal(row.deviceTokenHash, createHash("sha256").update(deviceToken).digest("hex"), "solo el hash del token");
    assert.equal(row.pairingCodeHash, null, "el código se consume");
  });

  it("claim caducado → 409 KIOSK_PAIRING_INVALID; re-pair emite otro código y el caducado sigue sin valer", async () => {
    const created = await call("POST", `/properties/${A.propertyA}/kiosks`, { headers: generalManager.headers, payload: { name: "Tablet caducada" } });
    assert.equal(created.status, 201);
    const expiredDeviceId = created.body.id as string;
    const paired = await call("POST", `/properties/${A.propertyA}/kiosks/${expiredDeviceId}/pair`, { headers: generalManager.headers });
    assert.equal(paired.status, 200);
    const expiredCode = paired.body.code as string;
    await prisma.kioskDevice.update({ where: { id: expiredDeviceId }, data: { pairingExpiresAt: new Date(Date.now() - 60_000) } });

    const late = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: expiredCode }, env: GUEST_ENV });
    assert.equal(late.status, 409, late.raw.slice(0, 300));
    assert.equal(late.body.details?.code, "KIOSK_PAIRING_INVALID");
    const still = await prisma.kioskDevice.findUniqueOrThrow({ where: { id: expiredDeviceId } });
    assert.equal(still.deviceTokenHash, null, "un claim caducado no empareja");
    assert.equal(still.status, "unpaired");

    const again = await call("POST", `/properties/${A.propertyA}/kiosks/${expiredDeviceId}/pair`, { headers: generalManager.headers });
    assert.equal(again.status, 200);
    assert.notEqual(again.body.code, expiredCode);
    const oldCode = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: expiredCode }, env: GUEST_ENV });
    assert.equal(oldCode.status, 409, "el código caducado no vale aunque haya uno nuevo");
    const fresh = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: again.body.code }, env: GUEST_ENV });
    assert.equal(fresh.status, 200, fresh.raw.slice(0, 300));
    const malformed = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: "12-34" }, env: GUEST_ENV });
    assert.equal(malformed.status, 400, "código que no tiene 8 dígitos: validación");
  });

  it("un kiosco de OTRA propiedad se empareja con su propio código (para la prueba de tenencia)", async () => {
    const created = await call("POST", `/properties/${A.propertyB}/kiosks`, { headers: generalManager.headers, payload: { name: "Tablet B" } });
    assert.equal(created.status, 201, created.raw.slice(0, 300));
    const paired = await call("POST", `/properties/${A.propertyB}/kiosks/${created.body.id}/pair`, { headers: generalManager.headers });
    assert.equal(paired.status, 200);
    const claim = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: paired.body.code }, env: GUEST_ENV });
    assert.equal(claim.status, 200, claim.raw.slice(0, 300));
    foreignDeviceToken = claim.body.deviceToken;
    assert.equal(claim.body.device.propertyId, A.propertyB);
  });
});

describe("W4-C · pre-check-in en el kiosco (x-kiosk-token) y tenencia", () => {
  it("invita, lee la MRZ con la cabecera del kiosco (mrz_checksum) y cierra el pre-check-in", async () => {
    const invited = await call("POST", `/properties/${A.propertyA}/check-in/sessions`, { headers: receptionist.headers, payload: { reservationId, channel: "email" } });
    assert.equal(invited.status, 200, invited.raw.slice(0, 400));
    sessionId = invited.body.session.id;
    token = invited.body.token;
    assert.equal(typeof token, "string");
    const guests = invited.body.session.guests as Array<Record<string, any>>;
    assert.equal(guests.length, 1);
    primaryCheckInGuestId = guests[0]!.id;

    const captured = await kioskCall("POST", `/guest-portal/check-in/guests/${primaryCheckInGuestId}/document`, { mrzLines: MRZ_LINES, documentType: "PASSPORT" });
    assert.equal(captured.status, 200, captured.raw.slice(0, 500));
    assert.equal(captured.body.capture.source, "mrz_reader");
    assert.equal(captured.body.guest.identityVerificationMethod, "mrz_checksum");
    assert.equal(captured.body.guest.identityVerifiedAt, null, "mrz_checksum no fecha la verificación de la persona");
    assert.equal(captured.body.guest.documentNumberLast3, "567");

    const done = await kioskCall("POST", "/guest-portal/check-in/complete");
    assert.equal(done.status, 200, done.raw.slice(0, 400));
    assert.equal(done.body.status, "ready_for_arrival");
    assert.ok(done.body.guests.every((guest: Record<string, any>) => typeof guest.guestRegisterRecordId === "string"));
  });

  it("corrector L7-REV-05: «Firmar en recepción» desde el kiosco → POST /guest-portal/check-in/handoff deriva la sesión en el servidor (handed_off · signature_pending · ticket K-nnnn · kioskDeviceId · auditoría · cola de Mi día); segunda llamada idempotente; recepción la resuelve", async () => {
    const before = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(before.status, "ready_for_arrival");
    const res = await kioskCall("POST", "/guest-portal/check-in/handoff", { kind: "signature" });
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.sessionId, sessionId);
    assert.equal(res.body.status, "handed_off");
    assert.equal(res.body.handoffKind, "signature_pending");
    assert.match(String(res.body.ticket), /^K-\d{4}$/);
    assert.equal(res.body.kioskDeviceId, deviceId);
    assert.equal(res.body.idempotent, false);
    const ticket = res.body.ticket as string;

    const row = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(row.status, "handed_off");
    assert.equal(row.handoffKind, "signature_pending");
    assert.equal(row.handoffReason, `Firma en recepción · ticket ${ticket}`);
    assert.equal(row.kioskDeviceId, deviceId);
    assert.ok(row.arrivedAt, "en el kiosco el huésped ya está en el hotel");

    // Recepción lo ve: vista de la reserva y cola de Mi día con el ticket en el contexto.
    const staff = await call("GET", `/reservations/${reservationId}/check-in`, { headers: receptionist.headers });
    assert.equal(staff.status, 200, staff.raw.slice(0, 300));
    assert.equal(staff.body.status, "handed_off");
    assert.equal(staff.body.handoffKind, "signature_pending");
    assert.equal(staff.body.handoffReason, `Firma en recepción · ticket ${ticket}`);
    const queue = await call("GET", `/dashboards/front-desk-queue?propertyId=${A.propertyA}`, { headers: receptionist.headers });
    assert.equal(queue.status, 200, queue.raw.slice(0, 300));
    const item = (queue.body.items as Array<{ id: string; kind: string; context: string; priority: string }>).find((entry) => entry.id === `signature_pending_${reservationId}`);
    assert.ok(item, `ítem signature_pending en la cola (hay: ${(queue.body.items as Array<{ id: string }>).map((entry) => entry.id).join(", ")})`);
    assert.equal(item!.kind, "signature_pending");
    assert.equal(item!.priority, "today");
    assert.match(item!.context, new RegExp(`Derivado desde el kiosco.*ticket ${ticket}`));

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "CheckInHandedOff", entityType: "checkin_session", entityId: sessionId } });
    assert.ok(audit, "auditoría CheckInHandedOff");
    assert.equal(audit!.actorUserId, `kiosk:${deviceId}`);
    assert.equal((audit!.afterJson as { ticket: string }).ticket, ticket);

    // Segunda pulsación: mismo ticket, sin escribir.
    const again = await kioskCall("POST", "/guest-portal/check-in/handoff", { kind: "signature" });
    assert.equal(again.status, 200, again.raw.slice(0, 300));
    assert.equal(again.body.ticket, ticket);
    assert.equal(again.body.idempotent, true);
    const badKind = await kioskCall("POST", "/guest-portal/check-in/handoff", { kind: "otra" });
    assert.equal(badKind.status, 400);
    const anonymous = await call("POST", "/guest-portal/check-in/handoff", { payload: { kind: "signature" }, env: GUEST_ENV });
    assert.equal(anonymous.status, 401);

    // Recepción resuelve la derivación: los viajeros están completos → ready_for_arrival (la prueba de llegada sigue).
    const resolved = await call("POST", `/reservations/${reservationId}/check-in/resolve-handoff`, { headers: receptionist.headers, payload: { note: "firma recogida en el mostrador" } });
    assert.equal(resolved.status, 200, resolved.raw.slice(0, 400));
    assert.equal(resolved.body.resolvedTo, "ready_for_arrival");
    assert.equal(resolved.body.handoffKind, null);
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } })).status, "ready_for_arrival");
  });

  it("token de kiosco de otra propiedad: el API lo ignora (firma touch_portal, actor guest); token de huésped de otra propiedad → 401", async () => {
    // Firma con el kiosco de B sobre la sesión de A: el actor sigue siendo el huésped (touch_portal), nunca touch_kiosk.
    const signed = await guestCall("POST", `/guest-portal/check-in/guests/${primaryCheckInGuestId}/signature`, { pngBase64: PNG_B64, strokeMeta: STROKE }, { "x-kiosk-token": foreignDeviceToken });
    assert.equal(signed.status, 201, signed.raw.slice(0, 400));
    assert.equal(signed.body.method, "touch_portal", "el kiosco de otra propiedad no cuenta como kiosco (checkin.routes.ts kioskFrom → null)");
    assert.equal(signed.body.guestRegisterStatus, "signed");

    // Con la política restringida, arrive + kiosco ajeno responde como huésped (method_not_allowed), no 401 ni kiosk_visual_check.
    const policy = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception", "otp_email"], requireVisualCheckAtKiosk: true, depositPolicy: "none" } });
    assert.equal(policy.status, 200, policy.raw.slice(0, 400));
    const foreignArrive = await guestCall("POST", "/guest-portal/check-in/arrive", { verification: { method: "mrz_checksum" } }, { "x-kiosk-token": foreignDeviceToken });
    assert.equal(foreignArrive.status, 409, foreignArrive.raw.slice(0, 400));
    assert.equal(foreignArrive.body.details?.code, "IDENTITY_NOT_VERIFIED");
    assert.equal(foreignArrive.body.details?.reason, "method_not_allowed");

    // Un token de HUÉSPED de otra propiedad sí es 401 GUEST_SESSION_INVALID (con o sin kiosco).
    const foreignGuestToken = `foreign_${RUN}`;
    await prisma.guestPortalSession.create({ data: { propertyId: A.propertyB, reservationId, guestId: primaryGuestId, tokenHash: createHash("sha256").update(foreignGuestToken).digest("hex"), status: "active", expiresAt: new Date(Date.now() + 3600_000) } });
    const cross = await call("POST", "/guest-portal/check-in/arrive", { headers: { "x-guest-token": foreignGuestToken, "x-kiosk-token": deviceToken }, payload: {}, env: GUEST_ENV });
    assert.equal(cross.status, 401, cross.raw.slice(0, 300));
    assert.equal(cross.body.details?.code, "GUEST_SESSION_INVALID");
    const crossRead = await call("GET", "/guest-portal/check-in", { headers: { "x-guest-token": foreignGuestToken }, env: GUEST_ENV });
    assert.equal(crossRead.status, 401);
  });

  it("x-kiosk-token permite arrive con mrz_checksum SOLO si la política lo admite (reader_hardware en el cuerpo no cambia el veredicto)", async () => {
    // 1. Política restringida (visual_reception / otp_email): 409 method_not_allowed, con mrz_checksum o reader_hardware.
    for (const method of ["mrz_checksum", "reader_hardware"]) {
      const res = await kioskCall("POST", "/guest-portal/check-in/arrive", { verification: { method } });
      assert.equal(res.status, 409, `${method}: ${res.raw.slice(0, 400)}`);
      assert.equal(res.body.details?.code, "IDENTITY_NOT_VERIFIED");
      assert.equal(res.body.details?.reason, "method_not_allowed");
      assert.equal(res.body.details?.method, "mrz_checksum", "el método que cuenta es el de la fila del viajero, no el del cuerpo");
    }
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status, "confirmed");

    // 2. La política admite mrz_checksum pero exige cotejo visual en el kiosco: 409 kiosk_visual_check.
    const visual = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"], requireVisualCheckAtKiosk: true } });
    assert.equal(visual.status, 200, visual.raw.slice(0, 400));
    const blocked = await kioskCall("POST", "/guest-portal/check-in/arrive", { verification: { method: "mrz_checksum" } });
    assert.equal(blocked.status, 409, blocked.raw.slice(0, 400));
    assert.equal(blocked.body.details?.code, "IDENTITY_NOT_VERIFIED");
    assert.equal(blocked.body.details?.reason, "kiosk_visual_check");

    // 3. Sin cotejo visual obligatorio: el kiosco completa el check-in.
    const relaxed = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { requireVisualCheckAtKiosk: false } });
    assert.equal(relaxed.status, 200);
    const ok = await kioskCall("POST", "/guest-portal/check-in/arrive", { verification: { method: "mrz_checksum" } });
    assert.equal(ok.status, 200, ok.raw.slice(0, 800));
    assert.equal(ok.body.actor, "kiosk");
    assert.equal(ok.body.room.id, roomId);
    assert.equal(typeof ok.body.room.number, "string");
    assert.match(ok.body.key.qr, /^hotelos:\/\/unlock\?serial=/);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    assert.equal(reservation.status, "checked_in");
    assert.equal(reservation.assignedRoomId, roomId);
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, "checked_in");
    assert.equal(session.kioskDeviceId, deviceId, "la sesión recuerda el kiosco que hizo el check-in");
    assert.ok(session.checkedInAt && session.arrivedAt);
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: "GUEST_SELF_CHECKED_IN", entityType: "checkin_session", entityId: sessionId } });
    assert.ok(audit, "auditoría GUEST_SELF_CHECKED_IN");
    assert.equal(audit!.actorUserId, `kiosk:${deviceId}`);

    // 4. Segundo arrive desde el kiosco → 409 CHECKIN_ALREADY_DONE.
    const again = await kioskCall("POST", "/guest-portal/check-in/arrive", {});
    assert.equal(again.status, 409);
    assert.equal(again.body.details?.code, "CHECKIN_ALREADY_DONE");
  });

  it("un kiosco desactivado deja de autenticar: su cabecera se ignora (actor guest) sin romper la sesión del huésped", async () => {
    const disabled = await call("PATCH", `/properties/${A.propertyA}/kiosks/${deviceId}`, { headers: generalManager.headers, payload: { status: "disabled" } });
    assert.equal(disabled.status, 200, disabled.raw.slice(0, 300));
    assert.equal(disabled.body.status, "disabled");
    const read = await kioskCall("GET", "/guest-portal/check-in");
    assert.equal(read.status, 200, "la sesión del huésped sigue leyéndose con el kiosco apagado");
    assert.equal(read.body.status, "checked_in");
    const list = await call("GET", `/properties/${A.propertyA}/kiosks`, { headers: generalManager.headers });
    assert.equal(list.status, 200);
    assert.ok(list.body.every((row: Record<string, unknown>) => !("deviceTokenHash" in row) && !("pairingCodeHash" in row)));
  });
});
