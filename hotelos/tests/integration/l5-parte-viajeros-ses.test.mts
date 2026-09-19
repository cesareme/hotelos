/**
 * Tanda L5 · lote L5-B · parte de viajeros coherente y pipeline SES honesto —
 * integración sobre Postgres real con una organización AISLADA
 * (helpers/l2-tenant.mts) y STRICT_ENV (auth real, RBAC_STRICT=true).
 *
 * Qué fija:
 *   · B1: el check-in crea un parte por huésped vinculado con `isPrimaryGuest`
 *     (ReservationGuest.isPrimary), `isMinor` (edad < 14 a la fecha del check-in),
 *     `providedByAdultGuestId` (el principal) y `kinshipRelationIfMinor`
 *     (ReservationGuest.relationshipType); el estado persistido es
 *     `ready_to_sign` solo cuando la firma es el ÚNICO bloqueo y `ready_to_submit`
 *     para el menor (no firma); POST …/validate devuelve el estado de la FILA.
 *   · B2: POST /properties/:id/ses/submissions no crea fila con
 *     sesHospedajesEnabled=false (409 SES_DISABLED) ni con un parte inválido
 *     (409 GUEST_REGISTER_INVALID); con establecimiento incompleto deja UNA fila
 *     failed por parte y la reutiliza en la siguiente llamada (mismo
 *     submissionId); con establecimiento completo re-encola ESA fila (mismo id,
 *     sin duplicados) y, aceptado el parte, no lo reescribe
 *     (409 GUEST_REGISTER_NOT_QUEUEABLE); discardFailedSesSubmissions marca
 *     SES_DISCARDED con auditoría por fila, el reintento responde 409 y
 *     runDueSesSubmissions no la toca.
 *   · RBAC: recepción (compliance.ses.submit · guest_register.read/sign ·
 *     pms.checkin.execute) es el actor; contabilidad (sin compliance.ses.submit)
 *     recibe 403. owner y general_manager TAMPOCO tienen la clave: no se usan.
 *   · Invariantes de Faranda (invoices / verifactuSubmissions / reservations).
 *
 * El establecimiento y el flag se fijan por Prisma desde la fixture (property.update
 * + propertyComplianceSetting.upsert) para no depender de claves de PATCH.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l5-parte-viajeros-ses.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { discardFailedSesSubmissions, runDueSesSubmissions, SES_DISCARDED_CODE, SES_SUBMISSION_DISCARDED_ACTION, SES_SUBMISSION_REFUSED_ACTION } = await import(
  "../../apps/api/src/modules/compliance/ses-submission.service.js"
);
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };
type Parte = {
  id: string;
  guestId?: string;
  status: string;
  isPrimaryGuest: boolean;
  isMinor: boolean;
  providedByAdultGuestId?: string;
  kinshipRelationIfMinor?: string;
  signedAt?: string;
  identityVerified: boolean;
};

const RUN = `p${newRunId()}`;

let app: ApiApp;
let A: IsolatedTenant;
/** Recepción del hotel A: reserva, check-in, firma, validate, SES. */
let reception: Session;
/** Contabilidad (ámbito organización): sin compliance.ses.submit → 403. */
let accountant: Session;
let invariantsBefore: { invoices: number; verifactuSubmissions: number; reservations: number };

let adultId = "";
let childId = "";
let incompleteGuestId = "";
let rooms: string[] = [];
/** Reserva 1: adulto principal completo + menor de 8 años. */
let reservation1 = "";
/** Reserva 2: huésped con datos incompletos (sin fecha de nacimiento ni dirección). */
let reservation2 = "";
/** Reserva 3: adulto completo, para el descarte. */
let reservation3 = "";
let adultParte = "";
let childParte = "";
let blockedIds: Record<string, string> = {};

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown; propertyId?: string } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), ...(options.propertyId ? { "x-property-id": options.propertyId } : {}) },
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

function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
}

/** Fecha local (Europe/Madrid) de hoy + offset en YYYY-MM-DD (ventana de check-in ±1 día). */
function madridDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Fecha de nacimiento de alguien que tiene exactamente `years` años (y medio) hoy. */
function bornYearsAgo(years: number): Date {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCMonth(date.getUTCMonth() - 6);
  return date;
}

async function createGuest(input: { id: string; firstName: string; dateOfBirth: Date | null; complete: boolean }): Promise<string> {
  const guest = await prisma.guest.create({
    data: {
      id: input.id,
      organizationId: A.organizationId,
      firstName: input.firstName,
      surname1: "Prueba",
      surname2: `L5 ${RUN}`,
      sex: input.complete ? "F" : null,
      nationality: input.complete ? "ESP" : null,
      dateOfBirth: input.dateOfBirth,
      documentType: "PASSPORT",
      documentNumber: `${input.id.toUpperCase().slice(-8)}`,
      residenceAddress: input.complete ? "Calle Real 1" : null,
      residenceLocality: input.complete ? "A Coruña" : null,
      residenceCountry: input.complete ? "ESP" : null,
      mobilePhone: input.complete ? "+34600000000" : null,
      email: `${input.id}@faranda.test`
    },
    select: { id: true }
  });
  return guest.id;
}

async function createReservation(label: string, links: Array<{ guestId: string; isPrimary: boolean; relationshipType?: string }>): Promise<string> {
  const created = await call("POST", `/properties/${A.propertyA}/reservations`, reception, {
    propertyId: A.propertyA,
    payload: { arrivalDate: madridDay(0), departureDate: madridDay(1), adults: 1, children: links.length - 1, roomTypeId: A.roomTypeA, bookerName: `L5-B ${label} ${RUN}` }
  });
  assert.ok(created.status === 200 || created.status === 201, created.raw.slice(0, 400));
  assert.equal(created.body.status, "confirmed");
  await prisma.reservationGuest.deleteMany({ where: { reservationId: created.body.id } });
  for (const link of links) {
    await prisma.reservationGuest.create({ data: { reservationId: created.body.id, guestId: link.guestId, isPrimary: link.isPrimary, relationshipType: link.relationshipType ?? null } });
  }
  return created.body.id;
}

async function checkIn(reservationId: string, roomId: string): Promise<Reply> {
  const reply = await call("POST", `/reservations/${reservationId}/check-in`, reception, { propertyId: A.propertyA, payload: { roomId, signatureObjectKey: "sig_l5_test" } });
  assert.equal(reply.status, 200, reply.raw.slice(0, 400));
  return reply;
}

async function listPartes(reservationId: string): Promise<Parte[]> {
  const reply = await call("GET", `/compliance/spain/reservations/${reservationId}/guest-register`, reception, { propertyId: A.propertyA });
  assert.equal(reply.status, 200, reply.raw.slice(0, 300));
  return reply.body as Parte[];
}

async function sesRows(recordIds: string[]) {
  return prisma.sesHospedajesSubmission.findMany({ where: { guestRegisterRecordId: { in: recordIds } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

async function setEstablishment(complete: boolean): Promise<void> {
  await prisma.property.update({
    where: { id: A.propertyA },
    data: complete
      ? { address: "Paseo Marítimo 1", municipality: "A Coruña", province: "A Coruña", postalCode: "15001", ineMunicipalityCode: "15030" }
      : { address: null, municipality: null, province: null, postalCode: null, ineMunicipalityCode: null }
  });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: A.propertyA },
    create: { propertyId: A.propertyA, country: "ES", sesHospedajesEnabled: true, sesRegistryNumber: complete ? `L5-${RUN}` : null },
    update: { sesRegistryNumber: complete ? `L5-${RUN}` : null }
  });
}

/** Corrector L5 (CS-01): el interruptor es el OR de properties.ses_hospedajes_enabled y property_compliance_settings.ses_hospedajes_enabled → se fijan los dos. */
async function setSesFlag(enabled: boolean): Promise<void> {
  await prisma.property.update({ where: { id: A.propertyA }, data: { sesHospedajesEnabled: enabled } });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: A.propertyA },
    create: { propertyId: A.propertyA, country: "ES", sesHospedajesEnabled: enabled },
    update: { sesHospedajesEnabled: enabled }
  });
}

/** Espera a que la cadena SES en proceso resuelva las filas (queued / sent → estado final). */
async function waitForSes(ids: string[], timeoutMs = 10_000): Promise<Array<{ id: string; status: string; errorCode: string | null }>> {
  const started = Date.now();
  for (;;) {
    const rows = await prisma.sesHospedajesSubmission.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, errorCode: true } });
    if (rows.length === ids.length && rows.every((row) => row.status !== "queued" && row.status !== "sent")) return rows;
    if (Date.now() - started > timeoutMs) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function auditCount(action: string, entityId: string): Promise<number> {
  await flushAuditQueues();
  return prisma.auditEvent.count({ where: { organizationId: A.organizationId, action, entityId } });
}

before(async () => {
  const all = await farandaInvariants();
  invariantsBefore = { invoices: all.invoices, verifactuSubmissions: all.verifactuSubmissions, reservations: all.reservations };
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  await prisma.room.updateMany({ where: { propertyId: A.propertyA }, data: { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true } });
  rooms = (await prisma.room.findMany({ where: { propertyId: A.propertyA }, select: { id: true }, orderBy: { number: "asc" } })).map((row) => row.id);
  assert.equal(rooms.length, 3, "las tres habitaciones sembradas del hotel A");
  await withEnv(STRICT_ENV, async () => {
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l5-b-reception");
    accountant = await loginOrThrow(app, A.users.accountant.email, A.password, "l5-b-accountant");
  });
  adultId = await createGuest({ id: `guest_l5_adult_${RUN}`, firstName: "Ana", dateOfBirth: new Date("1990-01-01T00:00:00.000Z"), complete: true });
  childId = await createGuest({ id: `guest_l5_child_${RUN}`, firstName: "Lucía", dateOfBirth: bornYearsAgo(8), complete: true });
  incompleteGuestId = await createGuest({ id: `guest_l5_incomp_${RUN}`, firstName: "Sin", dateOfBirth: null, complete: false });
  reservation1 = await createReservation("familia", [
    { guestId: adultId, isPrimary: true },
    { guestId: childId, isPrimary: false, relationshipType: "hija" }
  ]);
  reservation2 = await createReservation("incompleto", [{ guestId: incompleteGuestId, isPrimary: true }]);
  reservation3 = await createReservation("descarte", [{ guestId: adultId, isPrimary: true }]);
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
  } finally {
    await app?.close();
  }
  const all = await farandaInvariants();
  assert.deepEqual({ invoices: all.invoices, verifactuSubmissions: all.verifactuSubmissions, reservations: all.reservations }, invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: A.organizationId } }), 0, "sin organización residual de esta suite");
});

// ---------------------------------------------------------------------------
// B1 · parte coherente
// ---------------------------------------------------------------------------

describe("L5-B1 · check-in con principal + menor: partes con isPrimaryGuest / isMinor y estados coherentes", () => {
  it("el check-in crea 2 partes: principal (isPrimaryGuest, ready_to_sign) y menor (isMinor, providedByAdultGuestId, parentesco, ready_to_submit)", async () => {
    const reply = await checkIn(reservation1, rooms[0]);
    assert.equal(reply.body.guestRegister?.created, 2, JSON.stringify(reply.body.guestRegister));
    const partes = await listPartes(reservation1);
    assert.equal(partes.length, 2);
    const adult = partes.find((parte) => parte.guestId === adultId);
    const child = partes.find((parte) => parte.guestId === childId);
    assert.ok(adult && child, JSON.stringify(partes));
    adultParte = adult.id;
    childParte = child.id;
    assert.equal(adult.isPrimaryGuest, true, "ReservationGuest.isPrimary → isPrimaryGuest");
    assert.equal(adult.isMinor, false);
    assert.equal(adult.providedByAdultGuestId, undefined);
    assert.equal(adult.status, "ready_to_sign", "datos completos: la firma es el único bloqueo");
    assert.equal(child.isPrimaryGuest, false);
    assert.equal(child.isMinor, true, "8 años a la fecha del check-in");
    assert.equal(child.providedByAdultGuestId, adultId, "el menor se declara a través del principal");
    assert.equal(child.kinshipRelationIfMinor, "hija", "ReservationGuest.relationshipType");
    assert.equal(child.status, "ready_to_submit", "el menor no firma: válido");
    const rows = await prisma.guestRegisterRecord.findMany({ where: { id: { in: [adult.id, child.id] } }, select: { id: true, isPrimaryGuest: true, isMinor: true } });
    assert.deepEqual(
      rows.map((row) => [row.id === adult.id ? "adult" : "child", row.isPrimaryGuest, row.isMinor]).sort(),
      [
        ["adult", true, false],
        ["child", false, true]
      ]
    );
  });

  it("un segundo check-in no duplica partes (409 de la reserva ya alojada) y la lista sigue en 2", async () => {
    const again = await call("POST", `/reservations/${reservation1}/check-in`, reception, { propertyId: A.propertyA, payload: { roomId: rooms[0] } });
    assert.equal(again.status, 409, again.raw.slice(0, 300));
    assert.equal((await listPartes(reservation1)).length, 2);
  });

  it("POST …/validate devuelve el estado PERSISTIDO de la fila con el veredicto: adulto ready_to_sign (firma pendiente), menor ready_to_submit (válido)", async () => {
    const adult = await call("POST", `/compliance/spain/guest-register/${adultParte}/validate`, reception, { propertyId: A.propertyA, payload: {} });
    assert.equal(adult.status, 200, adult.raw.slice(0, 300));
    assert.equal(adult.body.valid, false);
    assert.equal(adult.body.status, "ready_to_sign");
    assert.deepEqual(
      adult.body.issues.filter((issue: { severity: string }) => issue.severity === "blocking").map((issue: { code: string }) => issue.code),
      ["signature_required"]
    );
    const child = await call("POST", `/compliance/spain/guest-register/${childParte}/validate`, reception, { propertyId: A.propertyA, payload: {} });
    assert.equal(child.status, 200, child.raw.slice(0, 300));
    assert.equal(child.body.valid, true);
    assert.equal(child.body.status, "ready_to_submit");
    const row = await prisma.guestRegisterRecord.findUniqueOrThrow({ where: { id: adultParte }, select: { status: true } });
    assert.equal(adult.body.status, row.status, "status = fila");
  });

  it("la firma del principal lo deja `signed` y validate lo confirma (estado de fila, no del validador)", async () => {
    const signed = await call("POST", `/compliance/spain/guest-register/${adultParte}/sign`, reception, { propertyId: A.propertyA, payload: { signatureObjectKey: `sig_l5_${RUN}` } });
    assert.equal(signed.status, 200, signed.raw.slice(0, 300));
    assert.equal(signed.body.status, "signed");
    const validated = await call("POST", `/compliance/spain/guest-register/${adultParte}/validate`, reception, { propertyId: A.propertyA, payload: {} });
    assert.equal(validated.status, 200);
    assert.equal(validated.body.valid, true);
    assert.equal(validated.body.status, "signed");
  });
});

// ---------------------------------------------------------------------------
// B2 · SES honesto
// ---------------------------------------------------------------------------

describe("L5-B2 · POST /properties/:id/ses/submissions honesto", () => {
  it("SES desactivado (flag false) → 409 SES_DISABLED, submissionId null y CERO filas; la negativa queda auditada", async () => {
    await setSesFlag(false);
    await setEstablishment(false);
    const reply = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation1 } });
    assert.equal(reply.status, 409, reply.raw.slice(0, 400));
    assert.equal(reply.body.details.code, "SES_DISABLED");
    assert.equal(reply.body.details.submissionId, null);
    assert.equal(reply.body.details.queued, 0);
    assert.equal(reply.body.details.failed.length, 2);
    assert.ok(reply.body.details.failed.every((entry: { code: string; submissionId: string | null }) => entry.code === "SES_DISABLED" && entry.submissionId === null));
    assert.match(String(reply.body.message), /desactivado/);
    assert.equal((await sesRows([adultParte, childParte])).length, 0, "sin fila");
    assert.equal(await auditCount(SES_SUBMISSION_REFUSED_ACTION, adultParte), 1);
  });

  it("flag true + establecimiento incompleto ×2 → 409 SES_ESTABLISHMENT_INCOMPLETE con el MISMO submissionId y 1 fila por parte", async () => {
    await setSesFlag(true);
    const first = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation1 } });
    assert.equal(first.status, 409, first.raw.slice(0, 400));
    assert.equal(first.body.details.code, "SES_ESTABLISHMENT_INCOMPLETE");
    assert.ok(Array.isArray(first.body.details.missing) && first.body.details.missing.includes("registryNumber"), first.raw.slice(0, 400));
    assert.equal(first.body.details.failed.length, 2);
    for (const entry of first.body.details.failed as Array<{ guestRegisterRecordId: string; code: string; submissionId: string | null }>) {
      assert.equal(entry.code, "SES_ESTABLISHMENT_INCOMPLETE");
      assert.ok(entry.submissionId, "la fila bloqueada existe");
      blockedIds[entry.guestRegisterRecordId] = entry.submissionId!;
    }
    assert.equal(first.body.details.submissionId, blockedIds[first.body.details.failed[0].guestRegisterRecordId]);

    const second = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation1 } });
    assert.equal(second.status, 409, second.raw.slice(0, 400));
    assert.equal(second.body.details.code, "SES_ESTABLISHMENT_INCOMPLETE");
    for (const entry of second.body.details.failed as Array<{ guestRegisterRecordId: string; submissionId: string | null }>) {
      assert.equal(entry.submissionId, blockedIds[entry.guestRegisterRecordId], "la fila failed se reutiliza, no se duplica");
    }
    const rows = await sesRows([adultParte, childParte]);
    assert.equal(rows.length, 2, "count(filas de los 2 partes) = 2 → 1 por parte");
    for (const row of rows) {
      assert.equal(row.status, "failed");
      assert.equal(row.errorCode, "SES_ESTABLISHMENT_INCOMPLETE");
      const response = row.responsePayloadJson as { blockedAttempts?: number; missing?: string[] };
      assert.equal(response.blockedAttempts, 2, "la reutilización cuenta los intentos bloqueados");
      assert.ok(Array.isArray(response.missing) && response.missing.length > 0);
    }
  });

  it("parte inválido (datos incompletos) → 409 GUEST_REGISTER_INVALID con submissionId null y CERO filas, aunque el establecimiento esté completo", async () => {
    await setEstablishment(true);
    await checkIn(reservation2, rooms[1]);
    const partes = await listPartes(reservation2);
    assert.equal(partes.length, 1);
    assert.equal(partes[0].status, "missing_data");
    const reply = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation2 } });
    assert.equal(reply.status, 409, reply.raw.slice(0, 400));
    assert.equal(reply.body.details.code, "GUEST_REGISTER_INVALID");
    assert.equal(reply.body.details.submissionId, null);
    assert.match(String(reply.body.message), /no se puede enviar: .*missing_dateOfBirth/);
    assert.equal((await sesRows([partes[0].id])).length, 0, "sin fila");
    assert.equal(await auditCount(SES_SUBMISSION_REFUSED_ACTION, partes[0].id), 1);
  });

  it("flag true + establecimiento completo → 200 queued reutilizando las filas bloqueadas (mismos ids, sin duplicados); aceptado, el parte no se reescribe (409 GUEST_REGISTER_NOT_QUEUEABLE)", async () => {
    const reply = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation1 } });
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.status, "queued");
    assert.equal(reply.body.queued, 2);
    assert.equal(reply.body.failed.length, 0);
    for (const submission of reply.body.submissions as Array<{ id: string; guestRegisterRecordId: string; status: string; submissionType: string }>) {
      assert.equal(submission.status, "queued");
      assert.equal(submission.submissionType, "alta");
      assert.equal(submission.id, blockedIds[submission.guestRegisterRecordId], "la fila failed recuperable se re-encola en vez de crear otra");
    }
    assert.equal((await sesRows([adultParte, childParte])).length, 2, "sigue habiendo 1 fila por parte");

    const settled = await waitForSes(Object.values(blockedIds));
    for (const row of settled) {
      assert.notEqual(row.status, "queued", `la cadena SES procesó ${row.id}`);
      assert.ok(["accepted", "rejected", "retrying", "failed"].includes(row.status), row.status);
      // Sin marcadores 1900-01-01 / ESP / DNI: con los perfiles completos la
      // comunicación se construye; el sandbox la acepta.
      assert.notEqual(row.errorCode, "GUEST_REGISTER_INVALID");
    }
    const accepted = settled.filter((row) => row.status === "accepted").map((row) => row.id);
    if (accepted.length === settled.length) {
      const partes = await listPartes(reservation1);
      assert.ok(partes.every((parte) => parte.status === "accepted"), JSON.stringify(partes.map((parte) => parte.status)));
      const again = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation1 } });
      assert.equal(again.status, 409, again.raw.slice(0, 400));
      assert.equal(again.body.details.code, "GUEST_REGISTER_NOT_QUEUEABLE");
      assert.equal(again.body.details.submissionId, null);
      assert.equal((await sesRows([adultParte, childParte])).length, 2, "los históricos aceptados no generan filas nuevas");
    }
  });

  it("403 para contabilidad (sin compliance.ses.submit); nada se escribe", async () => {
    const before = (await sesRows([adultParte, childParte])).length;
    expect403(await call("POST", `/properties/${A.propertyA}/ses/submissions`, accountant, { propertyId: A.propertyA, payload: { reservationId: reservation1 } }), "compliance.ses.submit");
    assert.equal((await sesRows([adultParte, childParte])).length, before);
  });
});

// ---------------------------------------------------------------------------
// B2 · descarte auditado
// ---------------------------------------------------------------------------

describe("L5-B2 · discardFailedSesSubmissions", () => {
  let parte3 = "";
  let blocked3 = "";

  it("una fila failed recuperable (establecimiento incompleto de nuevo) se descarta con dryRun (solo cuenta) y luego de verdad: SES_DISCARDED + auditoría por fila", async () => {
    await setEstablishment(false);
    await checkIn(reservation3, rooms[2]);
    const partes = await listPartes(reservation3);
    assert.equal(partes.length, 1);
    parte3 = partes[0].id;
    // El adulto ya firmó su parte de la reserva 1; este parte nuevo necesita su propia firma.
    const signed = await call("POST", `/compliance/spain/guest-register/${parte3}/sign`, reception, { propertyId: A.propertyA, payload: { signatureObjectKey: `sig_l5_3_${RUN}` } });
    assert.equal(signed.status, 200, signed.raw.slice(0, 300));
    const blocked = await call("POST", `/properties/${A.propertyA}/ses/submissions`, reception, { propertyId: A.propertyA, payload: { reservationId: reservation3 } });
    assert.equal(blocked.status, 409, blocked.raw.slice(0, 400));
    assert.equal(blocked.body.details.code, "SES_ESTABLISHMENT_INCOMPLETE");
    blocked3 = blocked.body.details.submissionId;
    assert.ok(blocked3);

    const context = {
      organizationId: A.organizationId,
      propertyId: A.propertyA,
      userId: reception.userId,
      fullName: A.users.receptionist.fullName,
      deviceId: "l5-b-test",
      permissions: ["compliance.ses.configure" as const]
    };
    const dry = await discardFailedSesSubmissions({ context, propertyId: A.propertyA, reason: `prueba L5 ${RUN}`, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.ids, [blocked3]);
    assert.equal(dry.discarded, 1);
    assert.equal(dry.recoverableLeft, 1, "dryRun no escribe");
    assert.equal((await prisma.sesHospedajesSubmission.findUniqueOrThrow({ where: { id: blocked3 } })).errorCode, "SES_ESTABLISHMENT_INCOMPLETE");

    const real = await discardFailedSesSubmissions({ context, propertyId: A.propertyA, reason: `prueba L5 ${RUN}`, correlationId: `corr_l5_${RUN}` });
    assert.equal(real.discarded, 1);
    assert.deepEqual(real.ids, [blocked3]);
    assert.equal(real.recoverableLeft, 0);
    const row = await prisma.sesHospedajesSubmission.findUniqueOrThrow({ where: { id: blocked3 } });
    assert.equal(row.status, "failed", "el enum no tiene otro valor honesto");
    assert.equal(row.errorCode, SES_DISCARDED_CODE);
    assert.equal(row.errorMessage, `Descartado por el operador: prueba L5 ${RUN}`);
    assert.equal(row.nextRetryAt, null);
    const discarded = (row.responsePayloadJson as { discarded?: { by: string; at: string; reason: string; previousErrorCode: string } }).discarded;
    assert.ok(discarded);
    assert.equal(discarded.by, reception.userId);
    assert.equal(discarded.reason, `prueba L5 ${RUN}`);
    assert.equal(discarded.previousErrorCode, "SES_ESTABLISHMENT_INCOMPLETE");
    assert.equal(await auditCount(SES_SUBMISSION_DISCARDED_ACTION, blocked3), 1, "un evento por fila");

    const twice = await discardFailedSesSubmissions({ context, propertyId: A.propertyA, reason: `otra vez ${RUN}` });
    assert.equal(twice.discarded, 0, "idempotente: ya no hay recuperables");
  });

  it("el reintento de una fila descartada responde 409 SES_DISCARDED; un motivo corto es 400; sin la clave es 403; otra organización 404", async () => {
    const retry = await call("POST", `/ses/submissions/${blocked3}/retry`, reception, { propertyId: A.propertyA, payload: {} });
    assert.equal(retry.status, 409, retry.raw.slice(0, 300));
    assert.equal(retry.body.details?.code, SES_DISCARDED_CODE);

    const context = { organizationId: A.organizationId, propertyId: A.propertyA, userId: reception.userId, fullName: "x", deviceId: "d", permissions: ["compliance.ses.configure" as const] };
    await assert.rejects(discardFailedSesSubmissions({ context, propertyId: A.propertyA, reason: "abc" }), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
    // requirePermissions lanza el PermissionDeniedError de @hotelos/shared (el
    // servidor lo traduce a 403); el mensaje nombra la clave que falta.
    await assert.rejects(
      discardFailedSesSubmissions({ context: { ...context, permissions: [] }, propertyId: A.propertyA, reason: "sin clave de envío" }),
      (error: unknown) => error instanceof Error && /No tienes permiso/.test(error.message) && error.message.includes("compliance.ses.configure")
    );
    await assert.rejects(
      discardFailedSesSubmissions({ context: { ...context, organizationId: "org_123" }, propertyId: A.propertyA, reason: "otra organización" }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404
    );
  });

  it("runDueSesSubmissions ignora la fila descartada aunque el establecimiento vuelva a estar completo", async () => {
    await setEstablishment(true);
    const result = await runDueSesSubmissions();
    assert.ok(!result.failed.some((entry) => entry.id === blocked3), JSON.stringify(result.failed));
    const row = await prisma.sesHospedajesSubmission.findUniqueOrThrow({ where: { id: blocked3 } });
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, SES_DISCARDED_CODE);
    assert.equal((await sesRows([parte3])).length, 1, "ni se re-encola ni se duplica");
  });
});
