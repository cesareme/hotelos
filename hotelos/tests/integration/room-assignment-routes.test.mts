/**
 * Tanda CHK · lote W3-B — rutas de la asignación explicable (room-assignment.routes.ts,
 * diseño §7.2) por `app.inject` sobre Postgres real con DOS organizaciones AISLADAS
 * (helpers/l2-tenant.mts) y STRICT_ENV (auth real, RBAC_STRICT=true, sin auth de demo).
 *
 * Tenant A: hotel A del helper ampliado a 6 DBL (101..106), 4 llegadas confirmadas el
 * 2026-10-02 sin habitación (huéspedes ficticios «Prueba») y 1 reserva en el hotel B
 * (el recepcionista de A no lo tiene asignado). Tenant F (otra organización) solo
 * aporta un recepcionista para los 404 cross-tenant.
 *
 * Qué fija:
 *   · POST /reservations/:id/assignment-suggestions devuelve top-3 con motivos en
 *     español y persiste (201; la segunda ejecución expira la anterior); GET devuelve
 *     la vigente y el histórico; cuerpo desconocido 400; sessionId ajeno 404;
 *   · contable (pms.reservation.read sin modify) lee y sugiere pero NO confirma (403);
 *   · confirm cross-tenant 404 (otra organización) y 404 opaco para el recepcionista
 *     sobre una reserva del hotel B (propiedad no asignada);
 *   · recepcionista confirma: reservation.assignedRoomId = primera candidata, la
 *     sugerencia queda confirmed con decidedBy y segundo confirm 409;
 *   · un bloqueo creado por la ruta excluye la habitación de la siguiente sugerencia
 *     (rechazo «Bloqueada del …»), solape 409 ROOM_BLOCK_OVERLAP, motivo inválido 400;
 *   · el lote crea una sugerencia por llegada sin habitación, sin repetir ni usar la
 *     bloqueada, y nadie queda asignado (suggest_and_confirm); fecha inválida 400;
 *   · comunicadas: alta 201 con par ordenado, duplicada (en cualquier orden) 409
 *     ROOM_CONNECTION_EXISTS, misma habitación 400, listar, borrar y 404 cross-tenant;
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/room-assignment-routes.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { ASSIGNMENT_SUGGESTION_DECIDED } = await import("../../apps/api/src/modules/pms/room-assignment.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };
type Candidate = { roomId: string; number: string; score: number; reasons: Array<{ rule: string; weight: number; detail: string }>; warnings: string[] };

const RUN = `rar${newRunId()}`;
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let app: ApiApp;
let A: IsolatedTenant;
let F: IsolatedTenant;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let receptionist: Session;
let accountant: Session;
let foreignReceptionist: Session;

/** número → id de habitación del hotel A. */
const roomByNumber = new Map<string, string>();
const numberByRoom = new Map<string, string>();
const reservations: string[] = [];
let reservationB = "";
let suggestionId = "";
let blockId = "";
let blockedRoomId = "";
let connectionId = "";

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

async function seedRoom(number: string): Promise<string> {
  const row = await prisma.room.create({
    data: { propertyId: A.propertyA, roomTypeId: A.roomTypeA, number, floor: number.slice(0, 1), sellable: true, active: true, status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok" },
    select: { id: true }
  });
  return row.id;
}

async function seedReservation(input: { propertyId: string; roomTypeId: string; code: string; suffix: string; vipFlag?: boolean }): Promise<string> {
  const guest = await prisma.guest.create({ data: { organizationId: A.organizationId, firstName: "Prueba", surname1: `Rutas ${input.suffix}`, nationality: "ESP" }, select: { id: true } });
  const row = await prisma.reservation.create({
    data: {
      propertyId: input.propertyId,
      code: input.code,
      channel: "direct",
      status: "confirmed",
      arrivalDate: day(ARRIVAL),
      departureDate: day(DEPARTURE),
      adults: 2,
      children: 0,
      roomTypeId: input.roomTypeId,
      vipFlag: input.vipFlag ?? false,
      totalAmount: "200.00",
      currency: "EUR"
    },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId: row.id, guestId: guest.id, isPrimary: true } });
  return row.id;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  F = await createIsolatedTenant(`${RUN}f`);
  await enableModules(A.propertyA, ["pms_core"]);

  const existing = await prisma.room.findMany({ where: { propertyId: A.propertyA }, select: { id: true, number: true } });
  for (const room of existing) roomByNumber.set(room.number, room.id);
  for (const number of ["104", "105", "106"]) roomByNumber.set(number, await seedRoom(number));
  for (const [number, id] of roomByNumber) numberByRoom.set(id, number);
  assert.equal(roomByNumber.size, 6);

  for (const suffix of ["A", "B", "C", "D"]) {
    reservations.push(await seedReservation({ propertyId: A.propertyA, roomTypeId: A.roomTypeA, code: `CHKW3B-${RUN}-${suffix}`, suffix, vipFlag: suffix === "A" }));
  }
  reservationB = await seedReservation({ propertyId: A.propertyB, roomTypeId: A.roomTypeB, code: `CHKW3B-${RUN}-HB`, suffix: "HB" });

  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
  accountant = await loginOrThrow(app, A.users.accountant.email, A.password);
  foreignReceptionist = await loginOrThrow(app, F.users.receptionist.email, F.password);
});

after(async () => {
  await flushAuditQueues();
  await app?.close();
  if (A) await cleanupTenant(A.organizationId);
  if (F) await cleanupTenant(F.organizationId);
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("W3-B · sugerencias por reserva", () => {
  it("POST devuelve top-3 con motivos y persiste; la segunda ejecución expira la anterior y GET devuelve vigente + histórico", async () => {
    const first = await call("POST", `/reservations/${reservations[0]}/assignment-suggestions`, { headers: receptionist.headers, payload: {} });
    assert.equal(first.status, 201, first.raw.slice(0, 400));
    assert.equal(first.body.status, "suggested");
    assert.equal(first.body.persisted, true);
    assert.equal(first.body.reservationId, reservations[0]);
    assert.equal(first.body.propertyId, A.propertyA);
    assert.equal(first.body.automationLevel, "suggest_and_confirm");
    assert.equal(first.body.source, "rules");
    const candidates = first.body.candidates as Candidate[];
    assert.equal(candidates.length, 3, "top-3");
    for (const candidate of candidates) {
      assert.ok(roomByNumber.has(candidate.number), `candidata ${candidate.number} del hotel A`);
      assert.ok(candidate.reasons.length > 0, `motivos de ${candidate.number}`);
      assert.ok(candidate.reasons.every((reason) => typeof reason.detail === "string" && reason.detail.length > 0));
      assert.ok(candidate.reasons.some((reason) => reason.detail === "Limpia"), `motivo de pisos en español en ${candidate.number}`);
      assert.equal(candidate.score, candidate.reasons.reduce((sum, reason) => sum + reason.weight, 0));
    }
    assert.ok(candidates[0]!.reasons.some((reason) => reason.rule === "vip"), "la A es VIP");
    assert.ok(Array.isArray(first.body.rejected) && Array.isArray(first.body.dataNotes) && Array.isArray(first.body.housekeepingAlerts));
    const row = await prisma.assignmentSuggestion.findUnique({ where: { id: first.body.id } });
    assert.ok(row, "fila assignment_suggestions");
    assert.equal(row!.status, "suggested");
    assert.equal((row!.candidatesJson as unknown[]).length, 3);

    const second = await call("POST", `/reservations/${reservations[0]}/assignment-suggestions`, { headers: receptionist.headers, payload: { sessionId: null } });
    assert.equal(second.status, 201, second.raw.slice(0, 400));
    assert.notEqual(second.body.id, first.body.id);
    suggestionId = second.body.id;

    const listed = await call("GET", `/reservations/${reservations[0]}/assignment-suggestions`, { headers: receptionist.headers });
    assert.equal(listed.status, 200, listed.raw.slice(0, 400));
    assert.equal(listed.body.current.id, suggestionId, "la vigente es la última suggested");
    assert.equal(listed.body.history.length, 2);
    assert.equal(listed.body.history[0].id, suggestionId, "la más reciente primero");
    assert.equal(listed.body.history[1].id, first.body.id);
    assert.equal(listed.body.history[1].status, "expired", "la anterior expira");
  });

  it("cuerpo desconocido 400 VALIDATION_ERROR; sessionId inexistente 404; reserva del hotel B 404 opaco para recepción", async () => {
    const unknown = await call("POST", `/reservations/${reservations[0]}/assignment-suggestions`, { headers: receptionist.headers, payload: { foo: 1 } });
    assert.equal(unknown.status, 400, unknown.raw.slice(0, 300));
    assert.equal(unknown.body.details?.code, "VALIDATION_ERROR");
    const session = await call("POST", `/reservations/${reservations[0]}/assignment-suggestions`, { headers: receptionist.headers, payload: { sessionId: `no_existe_${RUN}` } });
    assert.equal(session.status, 404, session.raw.slice(0, 300));
    const otherHotel = await call("POST", `/reservations/${reservationB}/assignment-suggestions`, { headers: receptionist.headers, payload: {} });
    assert.equal(otherHotel.status, 404, "el recepcionista no tiene asignado el hotel B");
    assert.equal(await prisma.assignmentSuggestion.count({ where: { reservationId: reservationB } }), 0);
  });

  it("contable (pms.reservation.read sin modify) lee y sugiere pero no confirma: 403 y nada cambia", async () => {
    const listed = await call("GET", `/reservations/${reservations[0]}/assignment-suggestions`, { headers: accountant.headers });
    assert.equal(listed.status, 200, listed.raw.slice(0, 300));
    assert.equal(listed.body.current.id, suggestionId);
    const forbidden = await call("POST", `/assignment-suggestions/${suggestionId}/confirm`, { headers: accountant.headers, payload: {} });
    assert.equal(forbidden.status, 403, forbidden.raw.slice(0, 300));
    const row = await prisma.assignmentSuggestion.findUnique({ where: { id: suggestionId } });
    assert.equal(row!.status, "suggested");
    const reservation = await prisma.reservation.findUnique({ where: { id: reservations[0]! }, select: { assignedRoomId: true } });
    assert.equal(reservation!.assignedRoomId, null);
  });

  it("confirm cross-tenant (otra organización) responde 404 opaco y no toca la sugerencia", async () => {
    const res = await call("POST", `/assignment-suggestions/${suggestionId}/confirm`, { headers: foreignReceptionist.headers, payload: {} });
    assert.equal(res.status, 404, res.raw.slice(0, 300));
    assert.doesNotMatch(res.raw, new RegExp(suggestionId), "el 404 no repite el id");
    const row = await prisma.assignmentSuggestion.findUnique({ where: { id: suggestionId } });
    assert.equal(row!.status, "suggested");
    const anonymous = await call("POST", `/assignment-suggestions/${suggestionId}/confirm`, { payload: {} });
    assert.equal(anonymous.status, 401, "ruta high: sin token no hay contexto");
  });

  it("recepcionista confirma: reservation.assignedRoomId = primera candidata, sugerencia confirmed con decidedBy, auditoría; segundo confirm 409", async () => {
    const before = await prisma.assignmentSuggestion.findUniqueOrThrow({ where: { id: suggestionId } });
    const first = (before.candidatesJson as Candidate[])[0]!;
    const res = await call("POST", `/assignment-suggestions/${suggestionId}/confirm`, { headers: receptionist.headers, payload: {} });
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.suggestion.status, "confirmed");
    assert.equal(res.body.suggestion.chosenRoomId, first.roomId);
    assert.equal(res.body.suggestion.decidedBy, receptionist.userId);
    assert.equal(typeof res.body.suggestion.decidedAt, "string");
    assert.equal(res.body.reservation.assignedRoomId, first.roomId);
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservations[0]! }, select: { assignedRoomId: true, status: true } });
    assert.equal(reservation.assignedRoomId, first.roomId);
    assert.equal(reservation.status, "confirmed", "pre-asignación: la reserva no entra en casa");
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: ASSIGNMENT_SUGGESTION_DECIDED, entityId: suggestionId } });
    assert.ok(audit, "ASSIGNMENT_SUGGESTION_DECIDED persistido");
    assert.equal(audit!.actorUserId, receptionist.userId);

    const again = await call("POST", `/assignment-suggestions/${suggestionId}/confirm`, { headers: receptionist.headers, payload: {} });
    assert.equal(again.status, 409, again.raw.slice(0, 300));
    assert.equal(again.body.details?.code, "ASSIGNMENT_SUGGESTION_DECIDED");
    const invalid = await call("POST", `/assignment-suggestions/${suggestionId}/confirm`, { headers: receptionist.headers, payload: { roomId: 5 } });
    assert.equal(invalid.status, 400);
  });
});

describe("W3-B · bloqueos de habitación", () => {
  it("un bloqueo creado por la ruta excluye la habitación de la siguiente sugerencia; solape 409; motivo inválido 400; contable 403", async () => {
    const preview = await call("POST", `/reservations/${reservations[1]}/assignment-suggestions`, { headers: receptionist.headers, payload: {} });
    assert.equal(preview.status, 201, preview.raw.slice(0, 400));
    const target = (preview.body.candidates as Candidate[])[0]!;
    blockedRoomId = target.roomId;

    const forbidden = await call("POST", `/properties/${A.propertyA}/room-blocks`, { headers: accountant.headers, payload: { roomId: blockedRoomId, fromDate: "2026-10-01", toDate: "2026-10-03", reason: "maintenance" } });
    assert.equal(forbidden.status, 403, forbidden.raw.slice(0, 300));
    const invalid = await call("POST", `/properties/${A.propertyA}/room-blocks`, { headers: receptionist.headers, payload: { roomId: blockedRoomId, fromDate: "2026-10-01", toDate: "2026-10-03", reason: "vacaciones" } });
    assert.equal(invalid.status, 400, invalid.raw.slice(0, 300));
    assert.equal(invalid.body.details?.code, "VALIDATION_ERROR");

    const created = await call("POST", `/properties/${A.propertyA}/room-blocks`, {
      headers: receptionist.headers,
      payload: { roomId: blockedRoomId, fromDate: "2026-10-01", toDate: "2026-10-03", reason: "maintenance", note: "cambio de caldera" }
    });
    assert.equal(created.status, 201, created.raw.slice(0, 400));
    assert.equal(created.body.roomId, blockedRoomId);
    assert.equal(created.body.fromDate, "2026-10-01");
    assert.equal(created.body.toDate, "2026-10-03");
    assert.equal(created.body.reason, "maintenance");
    assert.equal(created.body.createdBy, receptionist.userId);
    blockId = created.body.id;

    const overlap = await call("POST", `/properties/${A.propertyA}/room-blocks`, { headers: receptionist.headers, payload: { roomId: blockedRoomId, fromDate: "2026-10-03", toDate: "2026-10-05", reason: "deep_clean" } });
    assert.equal(overlap.status, 409, overlap.raw.slice(0, 300));
    assert.equal(overlap.body.details?.code, "ROOM_BLOCK_OVERLAP");

    const next = await call("POST", `/reservations/${reservations[1]}/assignment-suggestions`, { headers: receptionist.headers, payload: {} });
    assert.equal(next.status, 201, next.raw.slice(0, 400));
    const candidates = next.body.candidates as Candidate[];
    assert.equal(candidates.length, 3);
    assert.ok(!candidates.some((candidate) => candidate.roomId === blockedRoomId), `la ${target.number} bloqueada sigue entre las candidatas`);
    const rejection = (next.body.rejected as Array<{ roomId: string; reason: string }>).find((item) => item.roomId === blockedRoomId);
    assert.ok(rejection, "la bloqueada figura en los rechazos");
    assert.equal(rejection!.reason, "Bloqueada del 2026-10-01 al 2026-10-03");

    const listed = await call("GET", `/properties/${A.propertyA}/room-blocks?from=${ARRIVAL}&to=${DEPARTURE}`, { headers: receptionist.headers });
    assert.equal(listed.status, 200, listed.raw.slice(0, 300));
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, blockId);
    const outside = await call("GET", `/properties/${A.propertyA}/room-blocks?from=2026-10-10&to=2026-10-12`, { headers: receptionist.headers });
    assert.equal(outside.body.items.length, 0, "fuera de la ventana no hay bloqueos");
    const badQuery = await call("GET", `/properties/${A.propertyA}/room-blocks?from=ayer`, { headers: receptionist.headers });
    assert.equal(badQuery.status, 400);
  });
});

describe("W3-B · lote manual", () => {
  it("run crea una sugerencia por llegada sin habitación, sin repetir ni usar la bloqueada; nadie queda asignado; contable 403; fecha inválida 400", async () => {
    const forbidden = await call("POST", `/properties/${A.propertyA}/check-in/assignments/run`, { headers: accountant.headers, payload: { date: ARRIVAL } });
    assert.equal(forbidden.status, 403, forbidden.raw.slice(0, 300));
    const invalid = await call("POST", `/properties/${A.propertyA}/check-in/assignments/run`, { headers: receptionist.headers, payload: { date: "mañana" } });
    assert.equal(invalid.status, 400, invalid.raw.slice(0, 300));
    const otherHotel = await call("POST", `/properties/${A.propertyB}/check-in/assignments/run`, { headers: receptionist.headers, payload: { date: ARRIVAL } });
    assert.equal(otherHotel.status, 404, "el recepcionista no tiene asignado el hotel B");

    const res = await call("POST", `/properties/${A.propertyA}/check-in/assignments/run`, { headers: receptionist.headers, payload: { date: ARRIVAL } });
    assert.equal(res.status, 200, res.raw.slice(0, 400));
    assert.equal(res.body.propertyId, A.propertyA);
    assert.equal(res.body.date, ARRIVAL);
    assert.equal(res.body.automationLevel, "suggest_and_confirm");
    assert.deepEqual(res.body.failed, []);
    assert.equal(res.body.suggested, 3, "B, C y D: la A ya tiene habitación");
    assert.equal(res.body.skipped, 0);
    const items = res.body.items as Array<{ reservationId: string; suggestionId: string | null; proposedRoomNumber: string | null }>;
    assert.deepEqual(items.map((item) => item.reservationId).sort(), reservations.slice(1).sort());
    const proposed = items.map((item) => item.proposedRoomNumber);
    assert.equal(new Set(proposed).size, 3, `habitaciones repetidas: ${proposed.join(", ")}`);
    assert.ok(!proposed.includes(numberByRoom.get(blockedRoomId)!), "la bloqueada no se propone");
    assert.ok(!proposed.includes(numberByRoom.get((await prisma.reservation.findUniqueOrThrow({ where: { id: reservations[0]! } })).assignedRoomId!)!), "la asignada a la A no se propone");
    for (const item of items) {
      const row = await prisma.assignmentSuggestion.findUniqueOrThrow({ where: { id: item.suggestionId! } });
      assert.equal(row.status, "suggested");
      assert.equal(row.reservationId, item.reservationId);
    }
    const unassigned = await prisma.reservation.count({ where: { id: { in: reservations.slice(1) }, assignedRoomId: null } });
    assert.equal(unassigned, 3, "el lote solo sugiere");
    const suggestedRows = await prisma.assignmentSuggestion.count({ where: { propertyId: A.propertyA, status: "suggested" } });
    assert.equal(suggestedRows, 3, "una vigente por llegada (las anteriores de la B expiraron)");
  });
});

describe("W3-B · habitaciones comunicadas", () => {
  it("alta 201 con par ordenado, duplicada 409 en cualquier orden, misma habitación 400, listar, cross-tenant 404 y borrar", async () => {
    const roomA = roomByNumber.get("105")!;
    const roomB = roomByNumber.get("104")!;
    const created = await call("POST", `/properties/${A.propertyA}/room-connections`, { headers: receptionist.headers, payload: { roomAId: roomA, roomBId: roomB, kind: "connecting" } });
    assert.equal(created.status, 201, created.raw.slice(0, 400));
    assert.deepEqual([created.body.roomAId, created.body.roomBId], [roomA, roomB].sort());
    assert.equal(created.body.kind, "connecting");
    connectionId = created.body.id;

    const duplicate = await call("POST", `/properties/${A.propertyA}/room-connections`, { headers: receptionist.headers, payload: { roomAId: roomB, roomBId: roomA, kind: "adjacent" } });
    assert.equal(duplicate.status, 409, duplicate.raw.slice(0, 300));
    assert.equal(duplicate.body.details?.code, "ROOM_CONNECTION_EXISTS");
    const same = await call("POST", `/properties/${A.propertyA}/room-connections`, { headers: receptionist.headers, payload: { roomAId: roomA, roomBId: roomA, kind: "connecting" } });
    assert.equal(same.status, 400, same.raw.slice(0, 300));
    const badKind = await call("POST", `/properties/${A.propertyA}/room-connections`, { headers: receptionist.headers, payload: { roomAId: roomA, roomBId: roomByNumber.get("106"), kind: "puerta" } });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.details?.code, "VALIDATION_ERROR");
    const forbidden = await call("POST", `/properties/${A.propertyA}/room-connections`, { headers: accountant.headers, payload: { roomAId: roomA, roomBId: roomByNumber.get("106"), kind: "adjacent" } });
    assert.equal(forbidden.status, 403);

    const listed = await call("GET", `/properties/${A.propertyA}/room-connections?roomId=${roomB}`, { headers: receptionist.headers });
    assert.equal(listed.status, 200, listed.raw.slice(0, 300));
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, connectionId);
    const none = await call("GET", `/properties/${A.propertyA}/room-connections?roomId=${roomByNumber.get("106")}`, { headers: receptionist.headers });
    assert.equal(none.body.items.length, 0);

    const cross = await call("DELETE", `/room-connections/${connectionId}`, { headers: foreignReceptionist.headers });
    assert.equal(cross.status, 404, cross.raw.slice(0, 300));
    assert.equal(await prisma.roomConnection.count({ where: { id: connectionId } }), 1);
    const deleted = await call("DELETE", `/room-connections/${connectionId}`, { headers: receptionist.headers });
    assert.equal(deleted.status, 200, deleted.raw.slice(0, 300));
    assert.equal(deleted.body.id, connectionId);
    assert.equal((await call("GET", `/properties/${A.propertyA}/room-connections`, { headers: receptionist.headers })).body.items.length, 0);
    const missing = await call("DELETE", `/room-connections/${connectionId}`, { headers: receptionist.headers });
    assert.equal(missing.status, 404);
  });
});

describe("W3-B · borrar bloqueo", () => {
  it("cross-tenant 404, recepción 200 y la lista queda vacía", async () => {
    const cross = await call("DELETE", `/room-blocks/${blockId}`, { headers: foreignReceptionist.headers });
    assert.equal(cross.status, 404, cross.raw.slice(0, 300));
    assert.equal(await prisma.roomBlock.count({ where: { id: blockId } }), 1);
    const forbidden = await call("DELETE", `/room-blocks/${blockId}`, { headers: accountant.headers });
    assert.equal(forbidden.status, 403);
    const deleted = await call("DELETE", `/room-blocks/${blockId}`, { headers: receptionist.headers });
    assert.equal(deleted.status, 200, deleted.raw.slice(0, 300));
    assert.equal(deleted.body.id, blockId);
    const listed = await call("GET", `/properties/${A.propertyA}/room-blocks`, { headers: receptionist.headers });
    assert.equal(listed.body.items.length, 0);
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { entityType: "room_block", entityId: blockId } }), 2, "ROOM_BLOCK_CREATED + ROOM_BLOCK_DELETED");
  });
});
