/**
 * Tanda CHK · corrector (revisión 3) — integración sobre Postgres real con una
 * organización AISLADA (helpers/l2-tenant.mts) y STRICT_ENV. Fija, hallazgo a
 * hallazgo, lo que la revisión demostró roto en runtime:
 *
 *   · REV3-07 documentNumberLast3 real (no del envelope) en GET /guest-portal/check-in;
 *   · REV3-05 «Pegar MRZ» con nombre ajeno → needsReview identity_mismatch, sin aplicar;
 *   · REV3-08 un PATCH de consentimientos entre otp/request y otp/verify no borra el OTP;
 *   · REV3-12 segunda firma del mismo viajero → 200 idempotente, una sola fila;
 *   · REV3-01 RoomBlock: confirm {roomId bloqueada} → 409 ROOM_BLOCKED; arrive con la
 *     asignada bloqueada → reasigna a otra limpia de la misma categoría;
 *   · REV3-02 sin PSP (at_reception) el huésped no se salta el saldo: 409 BALANCE_DUE +
 *     handed_off payment_failed; con allowPayAtReception y resolve-handoff → 200;
 *   · REV3-06 escenario familiar (adulto + menor de 9 años sin documento ni móvil) cierra el
 *     pre-check-in; el parte del menor nace sin documento; país en alfa-3 (REV3-15);
 *   · REV3-04 recepción cierra una sesión que el huésped no cerró: PATCH del viajero,
 *     firma en el mostrador (crea el parte), complete dryRun sin efectos y complete;
 *   · SEC-7 kiosk/claim con el módulo apagado → 403 sin consumir el código ni emparejar;
 *   · SEC-1 ninguna fila de notification_deliveries lleva el token del enlace ni el OTP;
 *     GET /notifications/deliveries proyecta sin cuerpo para quien no gestiona;
 *   · SEC-3 la supresión RGPD anonimiza checkin_guests, borra capturas, retira trazo/PDF
 *     de signatures y cancela la sesión;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/checkin-corrector.test.mts
 */
import assert from "node:assert/strict";
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
const { createGdprRequest, executeErasure } = await import("../../apps/api/src/modules/gdpr/gdpr.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `chkc${newRunId()}`;
const TIMEZONE = "Europe/Madrid";
const ARRIVAL = todayInTimezone(TIMEZONE);
const DEPARTURE = (() => {
  const d = new Date(`${ARRIVAL}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
})();
const TOMORROW = (() => {
  const d = new Date(`${ARRIVAL}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
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
let seq = 0;

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

const guestCall = (token: string, method: Method, url: string, payload?: unknown) => call(method, url, { headers: { "x-guest-token": token }, ...(payload !== undefined ? { payload } : {}), env: GUEST_ENV });

type Scenario = { reservationId: string; guestId: string; email: string; documentNumber: string; sessionId: string; token: string; guests: Array<Record<string, any>> };

/** Reserva de hoy con titular de perfil completo (datos sintéticos) y, opcionalmente, saldo en folio; invitada al pre-check-in. */
async function scenario(input: { code: string; adults?: number; children?: number; balance?: number }): Promise<Scenario> {
  seq += 1;
  const suffix = `${RUN.slice(-5).toUpperCase()}${seq}`;
  const email = `titular.${input.code.toLowerCase()}.${RUN}@chk.test`;
  const documentNumber = `CHKC${suffix}`;
  const guest = await prisma.guest.create({
    data: {
      organizationId: A.organizationId,
      firstName: "Ana",
      surname1: "Gamma",
      sex: "M",
      nationality: "ESP",
      dateOfBirth: new Date("1990-04-12T00:00:00.000Z"),
      documentType: "DNI",
      documentNumber,
      documentSupportNumber: `AAA${suffix}`,
      email,
      mobilePhone: "+34600000101",
      residenceAddress: "Rúa da Proba 1",
      residenceLocality: "A Coruña",
      residenceCountry: "ESP"
    },
    select: { id: true }
  });
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: `${input.code}-${RUN}`,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date(`${ARRIVAL}T00:00:00.000Z`),
      departureDate: new Date(`${DEPARTURE}T00:00:00.000Z`),
      adults: input.adults ?? 1,
      children: input.children ?? 0,
      roomTypeId: A.roomTypeA,
      totalAmount: "200.00",
      currency: "EUR",
      bookerName: "Ana Gamma",
      bookerEmail: email
    },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId: reservation.id, guestId: guest.id, isPrimary: true } });
  if (input.balance) {
    const folio = await prisma.folio.create({ data: { reservationId: reservation.id, guestId: guest.id, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } });
    await prisma.folioLine.create({ data: { folioId: folio.id, type: "room", description: "Alojamiento", quantity: 1, unitPrice: input.balance.toFixed(2), taxCode: "ES_IVA_10", taxCategory: "accommodation", total: input.balance.toFixed(2), postedBy: `test-${RUN}` } });
  }
  const invited = await call("POST", `/properties/${A.propertyA}/check-in/sessions`, { headers: receptionist.headers, payload: { reservationId: reservation.id, channel: "email" } });
  assert.equal(invited.status, 200, invited.raw.slice(0, 400));
  assert.equal(typeof invited.body.token, "string", "token en claro fuera de producción sin entrega real");
  return { reservationId: reservation.id, guestId: guest.id, email, documentNumber, sessionId: invited.body.session.id, token: invited.body.token, guests: invited.body.session.guests };
}

async function signAll(s: Scenario): Promise<void> {
  const view = await guestCall(s.token, "GET", "/guest-portal/check-in");
  for (const guest of view.body.guests as Array<Record<string, any>>) {
    if (guest.isMinor) continue;
    const res = await guestCall(s.token, "POST", `/guest-portal/check-in/guests/${guest.id}/signature`, { pngBase64: PNG_B64, strokeMeta: STROKE });
    assert.equal(res.status, 201, res.raw.slice(0, 400));
  }
}

async function verifyPrimary(s: Scenario): Promise<void> {
  const primary = s.guests.find((guest) => guest.isPrimary)!;
  const res = await call("POST", `/reservations/${s.reservationId}/check-in/verify-identity`, { headers: receptionist.headers, payload: { checkInGuestId: primary.id, method: "visual_reception" } });
  assert.equal(res.status, 200, res.raw.slice(0, 400));
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  await enableModules(A.propertyA, ["pms_core", "guest_self_service", "spain_guest_register_compliance"]);
  const fomId = `usr_l2_fom_${RUN}`;
  const fomEmail = `jefatura.l2.${RUN}@faranda.test`;
  await prisma.user.create({ data: { id: fomId, organizationId: A.organizationId, email: fomEmail, fullName: "Jefatura corrector", status: "active", passwordHash: hashPassword(A.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  const fomRole = A.roles.front_office_manager;
  assert.ok(fomRole, "rol front_office_manager");
  await prisma.userRoleAssignment.create({ data: { userId: fomId, roleId: fomRole, scopeType: "property", propertyId: A.propertyA, organizationId: A.organizationId, reason: `seed chk corrector ${RUN}` } });
  resetRbacScopeCacheForTests();
  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
  generalManager = await loginOrThrow(app, A.users.generalManager.email, A.password);
  frontOfficeManager = await loginOrThrow(app, fomEmail, A.password);
  const policy = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, {
    headers: frontOfficeManager.headers,
    payload: { selfCheckInEnabled: true, allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"], depositPolicy: "balance", requireVisualCheckAtKiosk: false, welcomeChannelOrder: ["email"] }
  });
  assert.equal(policy.status, 200, policy.raw.slice(0, 400));
  assert.equal(policy.body.allowPayAtReception, false, "por defecto el pago en recepción no salta el depósito");
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  await cleanupTenant(A.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

// ── A · sesión del portal: last3, MRZ ajena, OTP + consentimiento, firma idempotente, RGPD ──
let sA: Scenario;

describe("REV3-07 · documentNumberLast3 real en todas las cargas", () => {
  it("GET /guest-portal/check-in devuelve los 3 últimos caracteres del documento en claro (no del envelope cifrado)", async () => {
    sA = await scenario({ code: "CHKC-A" });
    const view = await guestCall(sA.token, "GET", "/guest-portal/check-in");
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    const primary = (view.body.guests as Array<Record<string, any>>).find((guest) => guest.isPrimary)!;
    assert.equal(primary.documentNumberLast3, sA.documentNumber.slice(-3));
    const staff = await call("GET", `/reservations/${sA.reservationId}/check-in`, { headers: receptionist.headers });
    assert.equal(staff.body.guests[0].documentNumberLast3, sA.documentNumber.slice(-3));
    const patched = await guestCall(sA.token, "PATCH", "/guest-portal/check-in", { eta: "16:30" });
    assert.equal(patched.body.guests[0].documentNumberLast3, sA.documentNumber.slice(-3), "las respuestas de PATCH cargan los viajeros descifrados");
  });
});

describe("REV3-05 · «Pegar MRZ» aplica el cotejo de nombre de §4d", () => {
  it("una MRZ a nombre ajeno responde needsReview identity_mismatch y NO sobrescribe al viajero", async () => {
    const primary = sA.guests.find((guest) => guest.isPrimary)!;
    const before = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: primary.id }, select: { firstName: true, surname1: true, documentNumber: true, status: true, identityVerificationMethod: true } });
    const foreign = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "PAB000077", surname: "Sigma", givenNames: "Roberto", dateOfBirth: "1975-05-05", sex: "H", expiryDate: "2031-03-15", nationality: "UTO" });
    const res = await guestCall(sA.token, "POST", `/guest-portal/check-in/guests/${primary.id}/mrz`, { lines: foreign });
    assert.equal(res.status, 200, res.raw.slice(0, 500));
    assert.deepEqual(res.body.capture.needsReview, ["identity_mismatch"]);
    assert.equal(res.body.warnings.length, 1);
    assert.equal(res.body.guest.documentNumberLast3, sA.documentNumber.slice(-3), "el DTO sigue siendo el del titular");
    const after = await prisma.checkInGuest.findUniqueOrThrow({ where: { id: primary.id }, select: { firstName: true, surname1: true, documentNumber: true, status: true, identityVerificationMethod: true } });
    assert.deepEqual(after, before, "ningún campo del viajero cambia");
    const capture = await prisma.documentCapture.findUniqueOrThrow({ where: { id: res.body.capture.id } });
    assert.deepEqual(capture.needsReviewJson, ["identity_mismatch"]);
    // La propia MRZ del titular sí se aplica.
    const own = buildMrz({ format: "TD1", documentType: "DNI", issuingCountry: "ESP", documentNumber: sA.documentNumber, supportNumber: `AAA${sA.documentNumber.slice(4)}`, surname: "Gamma", givenNames: "Ana", dateOfBirth: "1990-04-12", sex: "M", expiryDate: "2032-06-30", nationality: "ESP" });
    const ok = await guestCall(sA.token, "POST", `/guest-portal/check-in/guests/${primary.id}/mrz`, { lines: own });
    assert.equal(ok.status, 200, ok.raw.slice(0, 400));
    assert.deepEqual(ok.body.capture.needsReview, []);
    assert.equal(ok.body.guest.identityVerificationMethod, "mrz_checksum");
  });
});

describe("REV3-08 · un PATCH de consentimientos no borra el OTP pendiente", () => {
  it("request → PATCH consent → verify con el código correcto → 200", async () => {
    const requested = await guestCall(sA.token, "POST", "/guest-portal/check-in/otp/request", { channel: "email" });
    assert.equal(requested.status, 200, requested.raw.slice(0, 400));
    assert.match(requested.body.debugCode, /^\d{6}$/);
    const patched = await guestCall(sA.token, "PATCH", "/guest-portal/check-in", { consent: { marketing: true, gdpr: true } });
    assert.equal(patched.status, 200, patched.raw.slice(0, 300));
    assert.equal(patched.body.consent.marketing, true);
    const row = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sA.sessionId } });
    assert.ok((row.consentJson as { otp?: unknown }).otp, "el OTP sigue en consentJson tras el PATCH");
    const verified = await guestCall(sA.token, "POST", "/guest-portal/check-in/otp/verify", { code: requested.body.debugCode });
    assert.equal(verified.status, 200, verified.raw.slice(0, 400));
    assert.equal(verified.body.guestStatus, "verified");
  });
});

describe("REV3-12 · la firma del portal es idempotente", () => {
  it("complete → firma 201 → segunda firma del mismo viajero 200 idempotent con la misma fila (count 1)", async () => {
    const done = await guestCall(sA.token, "POST", "/guest-portal/check-in/complete");
    assert.equal(done.status, 200, done.raw.slice(0, 400));
    const primary = sA.guests.find((guest) => guest.isPrimary)!;
    const first = await guestCall(sA.token, "POST", `/guest-portal/check-in/guests/${primary.id}/signature`, { pngBase64: PNG_B64, strokeMeta: STROKE });
    assert.equal(first.status, 201, first.raw.slice(0, 400));
    assert.equal(first.body.idempotent, false);
    const second = await guestCall(sA.token, "POST", `/guest-portal/check-in/guests/${primary.id}/signature`, { pngBase64: PNG_B64, strokeMeta: STROKE });
    assert.equal(second.status, 200, second.raw.slice(0, 400));
    assert.equal(second.body.idempotent, true);
    assert.equal(second.body.signatureId, first.body.signatureId);
    assert.equal(await prisma.signature.count({ where: { checkInGuestId: primary.id } }), 1);
    // SEC-2: en la fila el trazo y el PDF van cifrados (envelope), y Prisma los devuelve en claro.
    const raw = await prisma.$queryRaw<Array<{ object_key: string; pdf_object_key: string | null }>>`SELECT object_key, pdf_object_key FROM signatures WHERE id = ${first.body.signatureId}`;
    assert.match(raw[0]!.object_key, /^v1\./, "objectKey cifrado en reposo");
    assert.match(raw[0]!.pdf_object_key ?? "", /^v1\./, "pdfObjectKey cifrado en reposo");
    const viaPrisma = await prisma.signature.findUniqueOrThrow({ where: { id: first.body.signatureId }, select: { objectKey: true, pdfObjectKey: true } });
    assert.match(viaPrisma.objectKey, /^data:image\/png;base64,/);
    assert.match(viaPrisma.pdfObjectKey ?? "", /^data:application\/pdf;base64,/);
  });
});

// ── B · RoomBlock como filtro duro ──
describe("REV3-01 · un RoomBlock que solapa la estancia impide asignar y alojar", () => {
  let sB: Scenario;
  let blockedRoomId = "";
  let assignedRoomId = "";
  const blockIds: string[] = [];

  it("confirm {roomId bloqueada} → 409 ROOM_BLOCKED; otra candidata → asignada", async () => {
    sB = await scenario({ code: "CHKC-B" });
    const done = await guestCall(sB.token, "POST", "/guest-portal/check-in/complete");
    assert.equal(done.status, 200, done.raw.slice(0, 400));
    await signAll(sB);
    await verifyPrimary(sB);
    const suggested = await call("POST", `/reservations/${sB.reservationId}/assignment-suggestions`, { headers: receptionist.headers, payload: {} });
    assert.equal(suggested.status, 201, suggested.raw.slice(0, 400));
    const candidates = suggested.body.candidates as Array<{ roomId: string }>;
    assert.ok(candidates.length >= 2, "al menos dos candidatas limpias");
    blockedRoomId = candidates[0]!.roomId;
    const block = await call("POST", `/properties/${A.propertyA}/room-blocks`, { headers: receptionist.headers, payload: { roomId: blockedRoomId, fromDate: ARRIVAL, toDate: TOMORROW, reason: "maintenance" } });
    assert.equal(block.status, 201, block.raw.slice(0, 400));
    blockIds.push(block.body.id);
    const refused = await call("POST", `/assignment-suggestions/${suggested.body.id}/confirm`, { headers: receptionist.headers, payload: { roomId: blockedRoomId } });
    assert.equal(refused.status, 409, refused.raw.slice(0, 400));
    assert.equal(refused.body.details?.code, "ROOM_BLOCKED");
    assert.deepEqual({ fromDate: refused.body.details.fromDate, toDate: refused.body.details.toDate, reason: refused.body.details.reason }, { fromDate: ARRIVAL, toDate: TOMORROW, reason: "maintenance" });
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: sB.reservationId } })).assignedRoomId, null, "nada asignado");
    // El check-in clásico y assign-room comparten validateRoomUnderLock.
    const legacy = await call("POST", `/reservations/${sB.reservationId}/assign-room`, { headers: receptionist.headers, payload: { roomId: blockedRoomId } });
    assert.equal(legacy.status, 409, legacy.raw.slice(0, 300));
    assert.equal(legacy.body.details?.code, "ROOM_BLOCKED");
    assignedRoomId = candidates.find((candidate) => candidate.roomId !== blockedRoomId)!.roomId;
    const confirmed = await call("POST", `/assignment-suggestions/${suggested.body.id}/confirm`, { headers: receptionist.headers, payload: { roomId: assignedRoomId } });
    assert.equal(confirmed.status, 200, confirmed.raw.slice(0, 400));
    assert.equal(confirmed.body.reservation.assignedRoomId, assignedRoomId);
  });

  it("arrive con la asignada bloqueada después → reasigna a otra limpia de la misma categoría y aloja", async () => {
    const block = await call("POST", `/properties/${A.propertyA}/room-blocks`, { headers: receptionist.headers, payload: { roomId: assignedRoomId, fromDate: ARRIVAL, toDate: TOMORROW, reason: "deep_clean" } });
    assert.equal(block.status, 201, block.raw.slice(0, 400));
    blockIds.push(block.body.id);
    const res = await guestCall(sB.token, "POST", "/guest-portal/check-in/arrive", {});
    assert.equal(res.status, 200, res.raw.slice(0, 800));
    assert.equal(res.body.reassigned, true);
    assert.notEqual(res.body.room.id, assignedRoomId);
    assert.notEqual(res.body.room.id, blockedRoomId);
    assert.ok((res.body.warnings as string[]).some((line) => line.includes("bloqueada") && line.includes("deep_clean")), res.body.warnings.join(" | "));
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: sB.reservationId } });
    assert.equal(reservation.status, "checked_in");
    assert.equal(reservation.assignedRoomId, res.body.room.id);
    assert.equal(await prisma.roomBlock.count({ where: { roomId: res.body.room.id } }), 0, "la habitación final no tiene bloqueo");
    // Los bloqueos se retiran para los escenarios siguientes.
    for (const id of blockIds) {
      const deleted = await call("DELETE", `/room-blocks/${id}`, { headers: receptionist.headers });
      assert.equal(deleted.status, 200, deleted.raw.slice(0, 300));
    }
  });
});

// ── C · saldo sin PSP ──
describe("REV3-02 · sin PSP el huésped no se salta el depósito", () => {
  let sC: Scenario;

  it("payment-link → at_reception; arrive → 409 BALANCE_DUE y sesión handed_off payment_failed (en la cola de recepción)", async () => {
    sC = await scenario({ code: "CHKC-C", balance: 200 });
    const done = await guestCall(sC.token, "POST", "/guest-portal/check-in/complete");
    assert.equal(done.status, 200, done.raw.slice(0, 400));
    await signAll(sC);
    await verifyPrimary(sC);
    const link = await guestCall(sC.token, "POST", "/guest-portal/check-in/payment-link", {});
    assert.equal(link.status, 200, link.raw.slice(0, 400));
    assert.equal(link.body.status, "at_reception");
    const res = await guestCall(sC.token, "POST", "/guest-portal/check-in/arrive", {});
    assert.equal(res.status, 409, res.raw.slice(0, 500));
    assert.equal(res.body.details?.code, "BALANCE_DUE");
    assert.equal(res.body.details?.paymentStatus, "at_reception");
    assert.equal(res.body.details?.handoffKind, "payment_failed");
    assert.equal(res.body.details?.balanceDue, 200);
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { id: sC.sessionId } });
    assert.equal(session.status, "handed_off");
    assert.equal(session.handoffKind, "payment_failed");
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: sC.reservationId } })).status, "confirmed");
    const queue = await call("GET", `/dashboards/front-desk-queue?propertyId=${A.propertyA}`, { headers: receptionist.headers });
    assert.equal(queue.status, 200, queue.raw.slice(0, 300));
    const items = (Array.isArray(queue.body) ? queue.body : (queue.body.items ?? [])) as Array<Record<string, any>>;
    assert.ok(items.some((item) => item.kind === "payment_failed" && item.reservationId === sC.reservationId), `payment_failed en la cola: ${JSON.stringify(items.map((item) => item.kind))}`);
  });

  it("con allowPayAtReception y la derivación resuelta por recepción, arrive → 200; el KPI no cuenta la sesión derivada como pre-check-in hecho", async () => {
    const kpiBefore = await call("GET", `/dashboards/front-desk?propertyId=${A.propertyA}`, { headers: receptionist.headers });
    assert.equal(kpiBefore.status, 200, kpiBefore.raw.slice(0, 300));
    const arrivalsBefore = await call("GET", `/properties/${A.propertyA}/check-in/arrivals?date=${ARRIVAL}`, { headers: receptionist.headers });
    const handed = (arrivalsBefore.body.items as Array<Record<string, any>>).find((item) => item.reservationId === sC.reservationId);
    assert.equal(handed?.preCheckIn?.status, "handed_off");
    const notHanded = await call("POST", `/reservations/${sA.reservationId}/check-in/resolve-handoff`, { headers: receptionist.headers, payload: {} });
    assert.equal(notHanded.status, 409, notHanded.raw.slice(0, 300));
    assert.equal(notHanded.body.details?.code, "CHECKIN_NOT_HANDED_OFF");
    const policy = await call("PUT", `/properties/${A.propertyA}/check-in/policy`, { headers: frontOfficeManager.headers, payload: { allowPayAtReception: true } });
    assert.equal(policy.status, 200, policy.raw.slice(0, 300));
    assert.equal(policy.body.allowPayAtReception, true);
    const resolved = await call("POST", `/reservations/${sC.reservationId}/check-in/resolve-handoff`, { headers: receptionist.headers, payload: { note: "cobra en el mostrador" } });
    assert.equal(resolved.status, 200, resolved.raw.slice(0, 400));
    assert.equal(resolved.body.resolvedTo, "ready_for_arrival");
    assert.equal(resolved.body.handoffKind, null);
    const res = await guestCall(sC.token, "POST", "/guest-portal/check-in/arrive", {});
    assert.equal(res.status, 200, res.raw.slice(0, 800));
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sC.sessionId } })).status, "checked_in");
  });
});

// ── D · familia con menor ──
describe("REV3-06 / REV3-15 · adulto + menor de 9 años sin documento ni móvil propios", () => {
  it("el menor declarado por el titular no necesita documento ni teléfono; complete → ready_for_arrival; parte del menor sin documento; país en alfa-3", async () => {
    const sD = await scenario({ code: "CHKC-D", adults: 1, children: 1 });
    assert.equal(sD.guests.length, 2);
    const minor = await guestCall(sD.token, "POST", "/guest-portal/check-in/guests", { firstName: "Leo", surname1: "Gamma", sex: "H", nationality: "es", dateOfBirth: "2017-06-15", kinship: "hijo", residenceFullAddress: "Rúa da Proba 1", residenceLocality: "A Coruña", residenceCountry: "es" });
    assert.equal(minor.status, 201, minor.raw.slice(0, 400));
    assert.equal(minor.body.guest.isMinor, true);
    assert.deepEqual(minor.body.missing, [], "sin documento ni móvil propios el menor está completo");
    const primaryPatch = await guestCall(sD.token, "PATCH", `/guest-portal/check-in/guests/${sD.guests[0]!.id}`, { residenceCountry: "ES" });
    assert.equal(primaryPatch.status, 200, primaryPatch.raw.slice(0, 300));
    const done = await guestCall(sD.token, "POST", "/guest-portal/check-in/complete");
    assert.equal(done.status, 200, done.raw.slice(0, 600));
    assert.equal(done.body.status, "ready_for_arrival");
    const records = await prisma.guestRegisterRecord.findMany({ where: { reservationId: sD.reservationId }, select: { isMinor: true, documentNumber: true, documentType: true, nationality: true, residenceCountry: true, status: true, kinshipRelationIfMinor: true, providedByAdultGuestId: true } });
    assert.equal(records.length, 2);
    const minorRecord = records.find((row) => row.isMinor)!;
    assert.equal(minorRecord.documentNumber, null);
    assert.equal(minorRecord.documentType, null);
    assert.equal(minorRecord.nationality, "ESP", "alfa-2 → alfa-3");
    assert.equal(minorRecord.residenceCountry, "ESP");
    assert.equal(minorRecord.kinshipRelationIfMinor, "hijo");
    assert.equal(minorRecord.providedByAdultGuestId, sD.guestId);
    assert.ok(["ready_to_submit", "ready_to_sign", "signed"].includes(minorRecord.status), minorRecord.status);
    const adultRecord = records.find((row) => !row.isMinor)!;
    assert.equal(adultRecord.residenceCountry, "ESP");
  });
});

// ── E · recepción cierra una sesión que el huésped no cerró ──
describe("REV3-04 / REV3-03 · recepción completa una sesión invited desde el mostrador", () => {
  it("PATCH del viajero, firma en el mostrador (crea el parte), complete dryRun sin efectos y complete real", async () => {
    const sE = await scenario({ code: "CHKC-E" });
    const primary = sE.guests.find((guest) => guest.isPrimary)!;
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sE.sessionId } })).status, "invited");
    // Antes del corrector: 409 GUEST_REGISTER_INCOMPLETE «no tiene parte». Ahora la firma crea el parte.
    const patched = await call("PATCH", `/reservations/${sE.reservationId}/check-in/guests/${primary.id}`, { headers: receptionist.headers, payload: { residenceLocality: "Oleiros" } });
    assert.equal(patched.status, 200, patched.raw.slice(0, 400));
    assert.deepEqual(patched.body.missing, []);
    const signed = await call("POST", `/reservations/${sE.reservationId}/check-in/signature`, { headers: receptionist.headers, payload: { checkInGuestId: primary.id, pngBase64: PNG_B64, strokeMeta: STROKE } });
    assert.equal(signed.status, 201, signed.raw.slice(0, 500));
    assert.equal(signed.body.method, "touch_reception");
    const record = await prisma.guestRegisterRecord.findFirst({ where: { reservationId: sE.reservationId }, select: { id: true, residenceLocality: true, signedAt: true } });
    assert.ok(record?.signedAt, "parte creado y firmado desde el mostrador");
    assert.equal(record?.residenceLocality, "Oleiros", "el parte nace con la corrección de recepción");
    const cross = await call("PATCH", `/reservations/${sA.reservationId}/check-in/guests/${primary.id}`, { headers: receptionist.headers, payload: { residenceLocality: "x" } });
    assert.equal(cross.status, 404, "viajero de otra reserva: 404 opaco");
    await verifyPrimary(sE);
    // El PATCH de recepción, como el del portal, pasó la sesión de invited a in_progress; el dryRun no la toca.
    const statusBeforeDryRun = (await prisma.checkInSession.findUniqueOrThrow({ where: { id: sE.sessionId } })).status;
    assert.equal(statusBeforeDryRun, "in_progress");
    const dry = await call("POST", `/reservations/${sE.reservationId}/check-in/complete`, { headers: receptionist.headers, payload: { dryRun: true } });
    assert.equal(dry.status, 200, dry.raw.slice(0, 500));
    assert.deepEqual({ ok: dry.body.ok, dryRun: dry.body.dryRun, actor: dry.body.actor, recordsCreated: dry.body.recordsCreated }, { ok: true, dryRun: true, actor: "user", recordsCreated: 0 });
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: sE.reservationId } })).status, "confirmed", "dryRun no aloja");
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sE.sessionId } })).status, statusBeforeDryRun, "dryRun no cambia la sesión");
    const folioIds = (await prisma.folio.findMany({ where: { reservationId: sE.reservationId }, select: { id: true } })).map((row) => row.id);
    assert.equal(folioIds.length === 0 ? 0 : await prisma.payment.count({ where: { folioId: { in: folioIds } } }), 0, "dryRun no cobra");
    const res = await call("POST", `/reservations/${sE.reservationId}/check-in/complete`, { headers: receptionist.headers, payload: {} });
    assert.equal(res.status, 200, res.raw.slice(0, 800));
    assert.equal(res.body.actor, "user");
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: sE.reservationId } })).status, "checked_in");
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sE.sessionId } })).status, "checked_in");
  });
});

// ── F · kiosco con el módulo apagado ──
describe("SEC-7 · kiosk/claim comprueba el módulo ANTES de consumir el código", () => {
  it("propiedad sin guest_self_service: claim → 403, el kiosco sigue sin emparejar y el código no se quema", async () => {
    const created = await call("POST", `/properties/${A.propertyB}/kiosks`, { headers: generalManager.headers, payload: { name: "Tablet B corrector" } });
    assert.equal(created.status, 201, created.raw.slice(0, 300));
    const paired = await call("POST", `/properties/${A.propertyB}/kiosks/${created.body.id}/pair`, { headers: generalManager.headers });
    assert.equal(paired.status, 200, paired.raw.slice(0, 300));
    assert.match(paired.body.code, /^\d{8}$/);
    const claim = await call("POST", "/guest-portal/check-in/kiosk/claim", { payload: { code: paired.body.code }, env: GUEST_ENV });
    assert.equal(claim.status, 403, claim.raw.slice(0, 300));
    const device = await prisma.kioskDevice.findUniqueOrThrow({ where: { id: created.body.id } });
    assert.equal(device.deviceTokenHash, null, "sin token emitido");
    assert.notEqual(device.status, "online");
    assert.ok(device.pairingCodeHash, "el código sigue pendiente (no se ha consumido)");
  });
});

// ── F2 · phone_number_id de WhatsApp único entre propiedades ──
describe("SEC-4 · un phone_number_id de Meta solo enruta a una propiedad", () => {
  it("declararlo en una segunda propiedad → 409 WHATSAPP_PHONE_ID_CLAIMED; la primera lo conserva", async () => {
    const phoneId = `1234500${RUN.slice(-6)}`;
    const first = await call("PATCH", `/backoffice/properties/${A.propertyA}/ai-settings`, { headers: generalManager.headers, payload: { configurationJson: { whatsappPhoneId: phoneId } } });
    assert.equal(first.status, 200, first.raw.slice(0, 400));
    assert.equal(first.body.configurationJson?.whatsappPhoneId, phoneId);
    const again = await call("PATCH", `/backoffice/properties/${A.propertyA}/ai-settings`, { headers: generalManager.headers, payload: { configurationJson: { whatsappPhoneId: phoneId } } });
    assert.equal(again.status, 200, "la misma propiedad puede reescribirlo");
    const second = await call("PATCH", `/backoffice/properties/${A.propertyB}/ai-settings`, { headers: generalManager.headers, payload: { configurationJson: { whatsappPhoneId: phoneId } } });
    assert.equal(second.status, 409, second.raw.slice(0, 400));
    assert.equal(second.body.details?.code, "WHATSAPP_PHONE_ID_CLAIMED");
    const rows = await prisma.propertyAiSetting.findMany({ where: { configurationJson: { path: ["whatsappPhoneId"], equals: phoneId } }, select: { propertyId: true } });
    assert.deepEqual(rows.map((row) => row.propertyId), [A.propertyA]);
  });
});

// ── G · secretos fuera de notification_deliveries ──
describe("SEC-1 · el token del enlace y el OTP no se persisten", () => {
  it("ninguna fila lleva token=<64 hex> ni el otpCode; GET /notifications/deliveries sin notifications.manage llega sin cuerpo", async () => {
    const rows = await prisma.notificationDelivery.findMany({ where: { organizationId: A.organizationId, templateCode: { in: ["checkin_invitation", "checkin_otp"] } } });
    assert.ok(rows.length >= 2, "hay invitaciones y OTP registrados");
    for (const row of rows) {
      assert.doesNotMatch(row.bodyRendered ?? "", /token=[0-9a-f]{64}/, `bodyRendered con token (${row.templateCode})`);
      assert.doesNotMatch(JSON.stringify(row.payloadJson), /[0-9a-f]{64}/, `payloadJson con token (${row.templateCode})`);
      const variables = (row.payloadJson as { variables?: Record<string, unknown>; redacted?: boolean }).variables ?? {};
      if (row.templateCode === "checkin_otp") {
        assert.equal(variables.otpCode, "[redacted]");
        assert.doesNotMatch(row.bodyRendered ?? "", /\b\d{6}\b/, "el cuerpo guardado no lleva el código");
      } else {
        assert.equal(variables.checkInUrl, "[redacted]");
        assert.match(row.bodyRendered ?? "", /token=\[redacted\]/);
      }
      assert.equal((row.payloadJson as { redacted?: boolean }).redacted, true);
    }
    const asReceptionist = await call("GET", "/notifications/deliveries", { headers: receptionist.headers });
    assert.equal(asReceptionist.status, 200, asReceptionist.raw.slice(0, 300));
    const list = asReceptionist.body as Array<Record<string, unknown>>;
    assert.ok(list.length >= 1);
    assert.ok(list.every((row) => row.bodyRendered === null && row.payloadJson === null), "sin notifications.manage: sin cuerpo ni variables");
    const asManager = await call("GET", "/notifications/deliveries", { headers: generalManager.headers });
    assert.equal(asManager.status, 200, asManager.raw.slice(0, 300));
    const managerRows = (asManager.body as Array<Record<string, unknown>>).filter((row) => row.templateCode === "checkin_invitation");
    assert.ok(managerRows.length >= 1);
    assert.doesNotMatch(JSON.stringify(managerRows), /[0-9a-f]{64}/);
  });
});

// ── H · supresión RGPD ──
describe("SEC-3 · executeErasure cubre la capa de check-in", () => {
  it("anonimiza checkin_guests, borra capturas, retira trazo y PDF de signatures y cancela la sesión", async () => {
    const request = await createGdprRequest({ organizationId: A.organizationId, propertyId: A.propertyA, subjectEmail: sA.email, requestType: "erasure", requestorEmail: `dpo.${RUN}@chk.test` });
    const guestIdsA = (await prisma.checkInGuest.findMany({ where: { sessionId: sA.sessionId }, select: { id: true } })).map((row) => row.id);
    const capturesBefore = await prisma.documentCapture.count({ where: { checkInGuestId: { in: guestIdsA } } });
    assert.ok(capturesBefore >= 1, "hay capturas del escenario A");
    const result = await executeErasure(request.id, A.users.generalManager.id, { confirmRetentionOverride: false });
    const tables = ((result as { request: { fulfillmentMetadataJson: { tables?: Array<{ name: string; rowsAffected: number }> } | null } }).request.fulfillmentMetadataJson?.tables ?? []) as Array<{ name: string; rowsAffected: number }>;
    const names = new Set(tables.map((table) => table.name));
    assert.ok(names.has("CheckInGuest") && names.has("DocumentCapture") && names.has("Signature") && names.has("CheckInSession"), JSON.stringify(tables));
    const guests = await prisma.checkInGuest.findMany({ where: { sessionId: sA.sessionId } });
    assert.ok(guests.length >= 1);
    for (const guest of guests) {
      assert.equal(guest.firstName, "Erased");
      assert.equal(guest.documentNumber, null);
      assert.equal(guest.email, null);
      assert.equal(guest.documentNumberLookupHash, null);
    }
    assert.equal(await prisma.documentCapture.count({ where: { checkInGuestId: { in: guestIdsA } } }), 0);
    const signatures = await prisma.signature.findMany({ where: { sessionId: sA.sessionId } });
    assert.ok(signatures.length >= 1);
    for (const signature of signatures) {
      assert.match(signature.objectKey, /^erased:[0-9a-f]{64}$/);
      assert.equal(signature.pdfObjectKey, null);
      assert.equal(signature.sha256.length, 64, "la evidencia (hash) se conserva");
    }
    assert.equal((await prisma.checkInSession.findUniqueOrThrow({ where: { id: sA.sessionId } })).status, "cancelled");
  });
});
