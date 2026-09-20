/**
 * Tanda CHK · lote W1-D · L0 «deuda del portal del huésped»
 * (docs/design/CHECKIN-AUTOMATIZADO-IA.md §3 fila «Portal del huésped» y §9 L0) —
 * integración sobre Postgres real con una organización AISLADA
 * (helpers/l2-tenant.mts) y STRICT_ENV (auth real, RBAC_STRICT=true).
 *
 * Qué fija:
 *   · sign-in real: POST /guest-portal/sign-in con (código, email, propertyId)
 *     devuelve ok:true + token; sin propertyId responde ok:false (anti-enumeración:
 *     misma forma que un código desconocido) y no crea sesión;
 *   · proyección: GET /guest-portal/reservation con x-guest-token devuelve
 *     propertyId, primaryGuest { firstName, surname1Initial } (solo el titular:
 *     nunca datos del acompañante), assignedRoomNumber (Room.number) y eta;
 *   · pre-check-in: POST /guest-portal/pre-check-in escribe la ETA en
 *     Reservation.eta («HH:MM», también desde un datetime-local) y crea el parte
 *     draft (guest_register_records recordType checkin); una ETA que no valida
 *     no toca `eta` y se conserva en `notes`;
 *   · token inválido → 401 tipado.
 *   · Invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/guest-portal.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { normalizeArrivalEta } = await import("../../apps/api/src/modules/guest-portal/guest-portal.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST";
type Reply = { status: number; body: any; raw: string };

const RUN = `gp${newRunId()}`;

let app: ApiApp;
let A: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

const reservationCode = `CHK-GP-${RUN}`;
const bookerEmail = `titular.${RUN}@chk.test`;
let reservationId = "";
let primaryGuestId = "";
let companionGuestId = "";
let assignedRoomId = "";
let assignedRoomNumber = "";
let token = "";

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

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  app = await buildApiServer();
  await app.ready();

  // Titular (con apellido) + acompañante (cuyos datos NUNCA deben salir por el portal).
  const primary = await prisma.guest.create({
    data: { id: `guest_${RUN}_titular`, organizationId: A.organizationId, firstName: "Ana", surname1: "Gamma", email: bookerEmail, nationality: "ES" },
    select: { id: true }
  });
  const companion = await prisma.guest.create({
    data: { id: `guest_${RUN}_acomp`, organizationId: A.organizationId, firstName: "Luis", surname1: "Delta", email: `acomp.${RUN}@chk.test`, nationality: "ES" },
    select: { id: true }
  });
  primaryGuestId = primary.id;
  companionGuestId = companion.id;
  const room = await prisma.room.findUniqueOrThrow({ where: { id: A.roomsA[0]! }, select: { id: true, number: true } });
  assignedRoomId = room.id;
  assignedRoomNumber = room.number;
  const reservation = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: reservationCode,
      channel: "direct",
      status: "confirmed",
      arrivalDate: new Date("2026-10-02T00:00:00.000Z"),
      departureDate: new Date("2026-10-04T00:00:00.000Z"),
      adults: 2,
      roomTypeId: A.roomTypeA,
      assignedRoomId,
      bookerName: "Ana Gamma",
      bookerEmail
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

describe("L0 · sign-in del portal con ámbito de propiedad", () => {
  it("con propertyId devuelve ok:true y token; sin propertyId responde ok:false y no crea sesión", async () => {
    const noProperty = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode, email: bookerEmail } });
    assert.equal(noProperty.status, 200, noProperty.raw.slice(0, 300));
    assert.deepEqual(noProperty.body, { ok: false }, "sin hotel: misma respuesta que un código desconocido");
    assert.equal(await prisma.guestPortalSession.count({ where: { reservationId } }), 0);

    const signIn = await call("POST", "/guest-portal/sign-in", { payload: { reservationCode, email: bookerEmail, propertyId: A.propertyA } });
    assert.equal(signIn.status, 200, signIn.raw.slice(0, 300));
    assert.equal(signIn.body.ok, true);
    assert.equal(signIn.body.reservationId, reservationId);
    assert.equal(typeof signIn.body.token, "string", "sin proveedor de email el token viaja en la respuesta");
    token = signIn.body.token;
    const sessions = await prisma.guestPortalSession.findMany({ where: { reservationId } });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.propertyId, A.propertyA);
    assert.equal(sessions[0]!.guestId, primaryGuestId, "la sesión enlaza al titular");
  });
});

describe("L0 · proyección de la reserva", () => {
  it("GET /guest-portal/reservation con x-guest-token devuelve propertyId, primaryGuest (solo titular) y assignedRoomNumber", async () => {
    const view = await call("GET", "/guest-portal/reservation", { headers: { "x-guest-token": token } });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.reservationId, reservationId);
    assert.equal(view.body.reservationCode, reservationCode);
    assert.equal(view.body.propertyId, A.propertyA);
    assert.deepEqual(view.body.primaryGuest, { firstName: "Ana", surname1Initial: "G." });
    assert.equal(view.body.assignedRoomNumber, assignedRoomNumber);
    assert.equal(view.body.eta, null, "sin ETA todavía");
    assert.equal(view.body.guestCount, 2);
    assert.equal(view.body.status, "confirmed");
    assert.equal(view.body.balanceDue, 0);
    // Ni el nombre completo del titular ni ningún dato del acompañante.
    assert.doesNotMatch(view.raw, /Gamma|Luis|Delta|acomp\./, "sin PII del acompañante ni apellido completo del titular");
    for (const key of ["assignedRoomId", "roomTypeId", "guestId", "bookerEmail", "notes"]) assert.equal(key in view.body, false, `${key} no se expone`);
  });

  it("sin habitación asignada assignedRoomNumber es null (misma sesión, la asignación se retira y se repone)", async () => {
    await prisma.reservation.update({ where: { id: reservationId }, data: { assignedRoomId: null } });
    try {
      const view = await call("GET", "/guest-portal/reservation", { headers: { "x-guest-token": token } });
      assert.equal(view.status, 200, view.raw.slice(0, 300));
      assert.equal(view.body.assignedRoomNumber, null);
    } finally {
      await prisma.reservation.update({ where: { id: reservationId }, data: { assignedRoomId } });
    }
  });
});

describe("L0 · pre-check-in escribe Reservation.eta y crea el parte draft", () => {
  it("normalizeArrivalEta: HH:MM, H:MM y datetime-local → «HH:MM»; texto libre → null", () => {
    assert.equal(normalizeArrivalEta("16:30"), "16:30");
    assert.equal(normalizeArrivalEta("9:05"), "09:05");
    assert.equal(normalizeArrivalEta("2026-10-02T15:45"), "15:45");
    assert.equal(normalizeArrivalEta("2026-10-02T15:45:00.000Z"), "15:45");
    assert.equal(normalizeArrivalEta("24:00"), null);
    assert.equal(normalizeArrivalEta("sobre las cuatro"), null);
    assert.equal(normalizeArrivalEta(""), null);
    assert.equal(normalizeArrivalEta(undefined), null);
  });

  it("POST /guest-portal/pre-check-in con arrivalEta datetime-local → Reservation.eta «HH:MM» + guest_register_records draft (recordType checkin, titular)", async () => {
    const reply = await call("POST", "/guest-portal/pre-check-in", {
      headers: { "x-guest-token": token },
      payload: { documentType: "dni", documentNumber: `GP${RUN}`.toUpperCase().slice(0, 12), residenceAddress: "Rúa da Proba 1", country: "Spain", arrivalEta: "2026-10-02T15:45", specialRequests: "Cuna" }
    });
    assert.equal(reply.status, 200, reply.raw.slice(0, 300));
    assert.match(String(reply.body.confirmationNumber), /^PCI-/);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { eta: true, notes: true } });
    assert.equal(reservation.eta, "15:45", "la ETA va a Reservation.eta, no a notes");
    assert.equal(reservation.notes, null, "notes intacto cuando la ETA valida");

    const partes = await prisma.guestRegisterRecord.findMany({ where: { reservationId, recordType: "checkin" } });
    assert.equal(partes.length, 1, "un único parte draft");
    assert.equal(partes[0]!.status, "draft");
    assert.equal(partes[0]!.propertyId, A.propertyA);
    assert.equal(partes[0]!.guestId, primaryGuestId, "el parte es del titular");
    assert.equal(partes[0]!.isPrimaryGuest, true);
    assert.equal((partes[0]!.requiredPayloadJson as { source?: string }).source, "guest_portal_pre_check_in");

    const view = await call("GET", "/guest-portal/reservation", { headers: { "x-guest-token": token } });
    assert.equal(view.body.eta, "15:45", "la proyección devuelve la ETA");
  });

  it("segundo envío con HH:MM reutiliza el mismo parte draft y actualiza la ETA; una ETA que no valida no toca eta y se conserva en notes", async () => {
    const second = await call("POST", "/guest-portal/pre-check-in", { headers: { "x-guest-token": token }, payload: { arrivalEta: "16:30" } });
    assert.equal(second.status, 200, second.raw.slice(0, 300));
    assert.equal(await prisma.guestRegisterRecord.count({ where: { reservationId, recordType: "checkin" } }), 1, "sin duplicados");
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { eta: true } })).eta, "16:30");

    const invalid = await call("POST", "/guest-portal/pre-check-in", { headers: { "x-guest-token": token }, payload: { arrivalEta: "sobre las cuatro" } });
    assert.equal(invalid.status, 200, invalid.raw.slice(0, 300));
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { eta: true, notes: true } });
    assert.equal(after.eta, "16:30", "eta no cambia con un texto que no valida");
    assert.match(String(after.notes), /\[Pre-check-in\] Estimated arrival: sobre las cuatro/, "el texto se conserva en notes");
  });
});

describe("L0 · token inválido", () => {
  it("GET /guest-portal/reservation y POST /guest-portal/pre-check-in con token inválido → 401 tipado; sin token → 401", async () => {
    const view = await call("GET", "/guest-portal/reservation", { headers: { "x-guest-token": `tok_${RUN}_invalido` } });
    assert.equal(view.status, 401, view.raw.slice(0, 300));
    assert.ok(typeof view.body.message === "string" && view.body.message.length > 0);
    const pre = await call("POST", "/guest-portal/pre-check-in", { headers: { "x-guest-token": `tok_${RUN}_invalido` }, payload: { arrivalEta: "10:00" } });
    assert.equal(pre.status, 401, pre.raw.slice(0, 300));
    const noToken = await call("GET", "/guest-portal/reservation");
    assert.equal(noToken.status, 401, noToken.raw.slice(0, 300));
    assert.equal(await prisma.guestRegisterRecord.count({ where: { reservationId, recordType: "checkin" } }), 1, "nada nuevo escrito");
  });
});
