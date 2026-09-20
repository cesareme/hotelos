/**
 * Tanda CHK · lote W2-C · servicio de asignación explicable (room-assignment.service)
 * sobre Postgres real con una organización AISLADA (helpers/l2-tenant.mts).
 *
 * Tenant: hotel A del helper ampliado a 12 habitaciones (9 DBL en planta 1 + 3 SUP
 * en planta 2; vista mar/ciudad alterna; 102 inspeccionada, 104 sucia), 3 llegadas
 * DBL el 2026-10-02 (VIP con vipFlag · recurrente con Stay previa en la 105 · normal),
 * 1 bloqueo de la 101 (2026-10-01..03) creado por el propio servicio. Contextos
 * construidos desde las concesiones REALES de los usuarios del helper
 * (loadUserScope + permissionsFor): receptionist (pms.reservation.read/modify) y
 * accountant (solo read → 403 al confirmar).
 *
 * Casos: sugerencia persistida con top-3 y motivos en español · confirmar asigna la
 * habitación y deja la sugerencia confirmed · changed cuando se elige otra · lote de
 * mañana crea una sugerencia por llegada sin repetir habitación · habitación bloqueada
 * nunca aparece · recepcionista sin pms.reservation.modify no puede confirmar ·
 * rendimiento (R14): lote sobre la copia de Faranda SOLO LECTURA (la persistencia de
 * sugerencias se sustituye por un doble en memoria; las cifras se imprimen con
 * console.time y NUNCA nombres).
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/room-assignment.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, newRunId, farandaInvariants, FARANDA_ORG } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;
const { prisma } = await import("@hotelos/database");
const { loadUserScope, permissionsFor, resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const service = await import("../../apps/api/src/modules/pms/room-assignment.service.js");
type AssignmentDb = import("../../apps/api/src/modules/pms/room-assignment.service.js").AssignmentDb;

const RUN = `ra${newRunId()}`;
const ARRIVAL = "2026-10-02";
const DEPARTURE = "2026-10-04";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let A: IsolatedTenant;
let reception: UserContext;
let accountant: UserContext;
/** número → id de habitación del hotel A. */
const roomByNumber = new Map<string, string>();
let supTypeId = "";
let resVip = "";
let resReturning = "";
let resPlain = "";
let vipSuggestionId = "";
let plainSuggestionId = "";
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

async function contextFor(user: { id: string; fullName: string }, propertyId: string): Promise<UserContext> {
  resetRbacScopeCacheForTests();
  const scope = await loadUserScope(user.id, A.organizationId);
  return {
    organizationId: A.organizationId,
    propertyId,
    userId: user.id,
    fullName: user.fullName,
    deviceId: `w2c-${RUN}`,
    permissions: permissionsFor(scope, propertyId),
    assignedPropertyIds: scope.assignedPropertyIds,
    orgScope: scope.orgScope
  } as UserContext;
}

async function seedRoom(number: string, roomTypeId: string, extra: { housekeepingStatus?: "clean" | "dirty" | "inspected" } = {}): Promise<string> {
  const hk = extra.housekeepingStatus ?? "clean";
  const floor = number.slice(0, 1);
  const viewType = Number(number) % 2 === 1 ? "mar" : "ciudad";
  const existing = roomByNumber.get(number);
  if (existing) {
    await prisma.room.update({ where: { id: existing }, data: { floor, viewType, status: hk, housekeepingStatus: hk } });
    return existing;
  }
  const row = await prisma.room.create({
    data: { propertyId: A.propertyA, roomTypeId, number, floor, viewType, sellable: true, active: true, status: hk, housekeepingStatus: hk, maintenanceStatus: "ok" },
    select: { id: true }
  });
  roomByNumber.set(number, row.id);
  return row.id;
}

async function seedGuest(suffix: string, extra: { vipCode?: string } = {}): Promise<string> {
  const row = await prisma.guest.create({
    data: { organizationId: A.organizationId, firstName: "Prueba", surname1: `Asignación ${suffix}`, nationality: "ESP", vipCode: extra.vipCode ?? null },
    select: { id: true }
  });
  return row.id;
}

async function seedReservation(input: { code: string; guestId: string; roomTypeId: string; arrival: string; departure: string; status?: "confirmed" | "checked_out"; assignedRoomId?: string | null; vipFlag?: boolean; eta?: string | null }): Promise<string> {
  const row = await prisma.reservation.create({
    data: {
      propertyId: A.propertyA,
      code: input.code,
      channel: "direct",
      status: input.status ?? "confirmed",
      arrivalDate: day(input.arrival),
      departureDate: day(input.departure),
      adults: 2,
      children: 0,
      roomTypeId: input.roomTypeId,
      assignedRoomId: input.assignedRoomId ?? null,
      vipFlag: input.vipFlag ?? false,
      eta: input.eta ?? null,
      totalAmount: "200.00",
      currency: "EUR"
    },
    select: { id: true }
  });
  await prisma.reservationGuest.create({ data: { reservationId: row.id, guestId: input.guestId, isPrimary: true } });
  return row.id;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  const existing = await prisma.room.findMany({ where: { propertyId: A.propertyA }, select: { id: true, number: true } });
  for (const room of existing) roomByNumber.set(room.number, room.id);
  const sup = await prisma.roomType.create({ data: { propertyId: A.propertyA, name: "Superior", code: "SUP", maxOccupancy: 3, baseCapacity: 2, displayOrder: 2, active: true }, select: { id: true } });
  supTypeId = sup.id;
  await prisma.roomType.update({ where: { id: A.roomTypeA }, data: { displayOrder: 1 } });
  for (const number of ["101", "102", "103", "104", "105", "106", "107", "108", "109"]) {
    await seedRoom(number, A.roomTypeA, { housekeepingStatus: number === "102" ? "inspected" : number === "104" ? "dirty" : "clean" });
  }
  for (const number of ["201", "202", "203"]) await seedRoom(number, supTypeId);
  assert.equal(roomByNumber.size, 12);

  const gVip = await seedGuest("VIP", { vipCode: "VIP" });
  const gReturning = await seedGuest("Recurrente");
  const gPlain = await seedGuest("Normal");
  // Estancia previa del recurrente en la 105 (reserva checked_out + Stay).
  const previous = await seedReservation({ code: `CHKW2C-${RUN}-PREV`, guestId: gReturning, roomTypeId: A.roomTypeA, arrival: "2026-09-01", departure: "2026-09-03", status: "checked_out", assignedRoomId: roomByNumber.get("105") });
  await prisma.stay.create({ data: { reservationId: previous, roomId: roomByNumber.get("105")!, checkinAt: new Date("2026-09-01T14:00:00.000Z"), checkoutAt: new Date("2026-09-03T10:00:00.000Z"), status: "checked_out" } });

  resVip = await seedReservation({ code: `CHKW2C-${RUN}-A`, guestId: gVip, roomTypeId: A.roomTypeA, arrival: ARRIVAL, departure: DEPARTURE, vipFlag: true, eta: "15:00" });
  resReturning = await seedReservation({ code: `CHKW2C-${RUN}-B`, guestId: gReturning, roomTypeId: A.roomTypeA, arrival: ARRIVAL, departure: DEPARTURE });
  resPlain = await seedReservation({ code: `CHKW2C-${RUN}-C`, guestId: gPlain, roomTypeId: A.roomTypeA, arrival: ARRIVAL, departure: DEPARTURE });

  reception = await contextFor(A.users.receptionist, A.propertyA);
  accountant = await contextFor(A.users.accountant, A.propertyA);
  assert.ok(reception.permissions.includes("pms.reservation.modify"), "receptionist con pms.reservation.modify (plantilla T8a)");
  assert.ok(accountant.permissions.includes("pms.reservation.read") && !accountant.permissions.includes("pms.reservation.modify"), "accountant solo lectura de reservas");

  const block = await service.createRoomBlock({ context: reception, propertyId: A.propertyA, roomId: roomByNumber.get("101")!, fromDate: "2026-10-01", toDate: "2026-10-03", reason: "maintenance", note: "cambio de caldera" });
  assert.equal(block.roomId, roomByNumber.get("101"));
});

after(async () => {
  await flushAuditQueues();
  if (A) await cleanupTenant(A.organizationId);
  const invariantsAfter = await farandaInvariants();
  assert.deepEqual(invariantsAfter, invariantsBefore, "cifras de Faranda idénticas antes y después");
  await prisma.$disconnect();
});

describe("CHK W2-C · asignación explicable (integración)", () => {
  it("sugerencia persistida con top-3 y motivos en español (VIP → mejor vista/planta; 101 bloqueada rechazada)", async () => {
    const out = await service.suggestForReservation({ context: reception, reservationId: resVip });
    assert.equal(out.persisted, true);
    assert.equal(out.status, "suggested");
    assert.equal(out.automationLevel, "suggest_and_confirm");
    assert.equal(out.source, "rules");
    assert.equal(out.candidates.length, 3);
    assert.ok(out.confidence >= 0 && out.confidence <= 1);
    const row = await prisma.assignmentSuggestion.findUnique({ where: { id: out.id } });
    assert.ok(row, "fila assignment_suggestions");
    assert.equal(row!.reservationId, resVip);
    assert.equal(row!.propertyId, A.propertyA);
    assert.equal((row!.candidatesJson as unknown[]).length, 3);
    // Motivos en español: estado de pisos + VIP en la mejor vista/planta (impares = mar).
    for (const candidate of out.candidates) {
      assert.ok(candidate.reasons.some((reason) => reason.detail === "Limpia" || reason.detail === "Inspeccionada"), `motivo de pisos en ${candidate.number}`);
      assert.equal(candidate.score, candidate.reasons.reduce((sum, reason) => sum + reason.weight, 0));
    }
    assert.ok(out.candidates[0]!.reasons.some((reason) => reason.rule === "vip" && reason.detail === "Cliente VIP: mejor vista/planta disponible"), "VIP puntuado");
    assert.ok(out.rejected.some((rejection) => rejection.number === "101" && rejection.reason === "Bloqueada del 2026-10-01 al 2026-10-03"), "101 rechazada por bloqueo");
    assert.ok(!out.candidates.some((candidate) => candidate.number === "101"));
    // Sucia con llegada a las 15:00 y hoy < 2026-10-02: se mantiene con aviso, no se descarta.
    const dirty = out.rejected.find((rejection) => rejection.number === "104");
    assert.equal(dirty, undefined, "la 104 (sucia, ETA lejana) no se descarta");
    vipSuggestionId = out.id;
  });

  it("recepcionista sin pms.reservation.modify (accountant) no puede confirmar: 403 y nada cambia", async () => {
    await assert.rejects(service.confirmSuggestion({ context: accountant, suggestionId: vipSuggestionId }), (error: Error) => error.name === "PermissionDeniedError");
    const row = await prisma.assignmentSuggestion.findUnique({ where: { id: vipSuggestionId } });
    assert.equal(row!.status, "suggested");
    const reservation = await prisma.reservation.findUnique({ where: { id: resVip }, select: { assignedRoomId: true } });
    assert.equal(reservation!.assignedRoomId, null);
    // Sugerir sí puede (pms.reservation.read), sin persistir.
    const preview = await service.suggestForReservation({ context: accountant, reservationId: resPlain, persist: false });
    assert.equal(preview.persisted, false);
    assert.equal(preview.candidates.length, 3);
  });

  it("lote de mañana crea una sugerencia por llegada sin repetir habitación (VIP primero, recurrente en la 105)", async () => {
    console.time(`[W2-C] lote tenant aislado (${RUN})`);
    const out = await service.runBatchForDate({ context: reception, propertyId: A.propertyA, date: ARRIVAL });
    console.timeEnd(`[W2-C] lote tenant aislado (${RUN})`);
    assert.deepEqual(out.failed, []);
    assert.equal(out.suggested, 3);
    assert.equal(out.skipped, 0);
    assert.equal(out.items.length, 3);
    assert.equal(out.items[0]!.reservationId, resVip, "la VIP va primero");
    const proposed = out.items.map((item) => item.proposedRoomNumber);
    assert.equal(new Set(proposed).size, 3, `habitaciones repetidas: ${proposed.join(", ")}`);
    assert.ok(!proposed.includes("101"));
    const returning = out.items.find((item) => item.reservationId === resReturning)!;
    assert.equal(returning.proposedRoomNumber, "105", "recurrente → su última habitación");
    const rows = await prisma.assignmentSuggestion.findMany({ where: { propertyId: A.propertyA }, orderBy: { createdAt: "asc" } });
    assert.equal(rows.filter((row) => row.status === "suggested").length, 3);
    assert.equal(rows.find((row) => row.id === vipSuggestionId)!.status, "expired", "la sugerencia anterior de la VIP expira");
    const returningRow = rows.find((row) => row.reservationId === resReturning && row.status === "suggested")!;
    const candidates = returningRow.candidatesJson as Array<{ number: string; reasons: Array<{ rule: string; detail: string }> }>;
    assert.equal(candidates[0]!.number, "105");
    assert.ok(candidates[0]!.reasons.some((reason) => reason.rule === "returning" && reason.detail === "Se alojó aquí en su última visita"));
    // El lote solo sugiere: nadie queda asignado.
    const unassigned = await prisma.reservation.count({ where: { id: { in: [resVip, resReturning, resPlain] }, assignedRoomId: null } });
    assert.equal(unassigned, 3);
    assert.ok(out.durationMs < 3000, `lote en ${out.durationMs} ms`);
    vipSuggestionId = out.items[0]!.suggestionId!;
    plainSuggestionId = out.items.find((item) => item.reservationId === resPlain)!.suggestionId!;
  });

  it("confirmar asigna la habitación y deja la sugerencia confirmed (auditoría persistida)", async () => {
    const before = await prisma.assignmentSuggestion.findUnique({ where: { id: vipSuggestionId } });
    const first = (before!.candidatesJson as Array<{ roomId: string; number: string }>)[0]!;
    const out = await service.confirmSuggestion({ context: reception, suggestionId: vipSuggestionId });
    assert.equal(out.suggestion.status, "confirmed");
    assert.equal(out.suggestion.chosenRoomId, first.roomId);
    assert.equal(out.suggestion.decidedBy, A.users.receptionist.id);
    assert.ok(out.suggestion.decidedAt);
    assert.equal(out.reservation.assignedRoomId, first.roomId);
    const reservation = await prisma.reservation.findUnique({ where: { id: resVip }, select: { assignedRoomId: true, status: true } });
    assert.equal(reservation!.assignedRoomId, first.roomId);
    assert.equal(reservation!.status, "confirmed", "pre-asignación: la reserva no entra en casa");
    const room = await prisma.room.findUnique({ where: { id: first.roomId }, select: { status: true } });
    assert.notEqual(room!.status, "occupied", "pre-asignación: la habitación no se ocupa");
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { action: service.ASSIGNMENT_SUGGESTION_DECIDED, entityId: vipSuggestionId } });
    assert.ok(audit, "ASSIGNMENT_SUGGESTION_DECIDED persistido");
    assert.equal(audit!.actorUserId, A.users.receptionist.id);
    assert.equal((audit!.afterJson as { status: string }).status, "confirmed");
    await assert.rejects(service.confirmSuggestion({ context: reception, suggestionId: vipSuggestionId }), (error: { statusCode?: number }) => error.statusCode === 409);
  });

  it("changed cuando se elige otra habitación fuera de las candidatas", async () => {
    const row = await prisma.assignmentSuggestion.findUnique({ where: { id: plainSuggestionId } });
    const candidates = row!.candidatesJson as Array<{ roomId: string; number: string }>;
    const taken = new Set((await prisma.reservation.findMany({ where: { propertyId: A.propertyA, assignedRoomId: { not: null } }, select: { assignedRoomId: true } })).map((r) => r.assignedRoomId));
    const other = ["103", "105", "106", "107", "108", "109"].map((number) => roomByNumber.get(number)!).find((id) => !candidates.some((candidate) => candidate.roomId === id) && !taken.has(id));
    assert.ok(other, "hay una DBL libre fuera del top-3");
    const out = await service.confirmSuggestion({ context: reception, suggestionId: plainSuggestionId, roomId: other });
    assert.equal(out.suggestion.status, "changed");
    assert.equal(out.suggestion.chosenRoomId, other);
    const reservation = await prisma.reservation.findUnique({ where: { id: resPlain }, select: { assignedRoomId: true } });
    assert.equal(reservation!.assignedRoomId, other);
  });

  it("habitación bloqueada nunca aparece en ninguna sugerencia persistida; listar/borrar bloqueos", async () => {
    const rows = await prisma.assignmentSuggestion.findMany({ where: { propertyId: A.propertyA } });
    assert.ok(rows.length >= 4);
    const blocked = roomByNumber.get("101")!;
    for (const row of rows) {
      const candidates = row.candidatesJson as Array<{ roomId: string }>;
      assert.ok(!candidates.some((candidate) => candidate.roomId === blocked), `101 en la sugerencia ${row.id}`);
    }
    const blocks = await service.listRoomBlocks({ context: reception, propertyId: A.propertyA, from: ARRIVAL, to: DEPARTURE });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.reason, "maintenance");
    await assert.rejects(
      service.createRoomBlock({ context: reception, propertyId: A.propertyA, roomId: blocked, fromDate: "2026-10-03", toDate: "2026-10-04", reason: "deep_clean" }),
      (error: { statusCode?: number }) => error.statusCode === 409
    );
    // Fuera de las fechas del bloqueo la 101 vuelve a ser candidata.
    const later = await seedReservation({ code: `CHKW2C-${RUN}-D`, guestId: (await seedGuest("Tardía")), roomTypeId: A.roomTypeA, arrival: "2026-10-05", departure: "2026-10-06" });
    const out = await service.suggestForReservation({ context: reception, reservationId: later, persist: false });
    assert.ok(!out.rejected.some((rejection) => rejection.roomId === blocked && /Bloqueada del/.test(rejection.reason)));
    await service.deleteRoomBlock({ context: reception, blockId: blocks[0]!.id });
    assert.equal((await service.listRoomBlocks({ context: reception, propertyId: A.propertyA })).length, 0);
  });

  it("comunicadas: alta, par ordenado y preferencia connecting", async () => {
    const created = await service.createRoomConnection({ context: reception, propertyId: A.propertyA, roomAId: roomByNumber.get("107")!, roomBId: roomByNumber.get("106")!, kind: "connecting" });
    assert.deepEqual([created.roomAId, created.roomBId], [roomByNumber.get("106"), roomByNumber.get("107")].sort());
    await assert.rejects(
      service.createRoomConnection({ context: reception, propertyId: A.propertyA, roomAId: roomByNumber.get("106")!, roomBId: roomByNumber.get("107")!, kind: "adjacent" }),
      (error: { statusCode?: number }) => error.statusCode === 409
    );
    const list = await service.listRoomConnections({ context: reception, propertyId: A.propertyA, roomId: roomByNumber.get("107") });
    assert.equal(list.length, 1);
    await service.deleteRoomConnection({ context: reception, connectionId: created.id });
    assert.equal((await service.listRoomConnections({ context: reception, propertyId: A.propertyA })).length, 0);
  });
});

describe("CHK W2-C · rendimiento R14 sobre la copia de Faranda (solo lectura)", () => {
  it("el lote de un hotel real tarda < 3 s sin escribir nada (persistencia sustituida por un doble en memoria)", async () => {
    const properties = await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true, code: true } });
    if (properties.length === 0) {
      console.log("[W2-C] sin Faranda en esta BD: medición omitida");
      return;
    }
    const arrivals = await prisma.reservation.groupBy({
      by: ["propertyId", "arrivalDate"],
      where: { propertyId: { in: properties.map((p) => p.id) }, status: "confirmed", assignedRoomId: null, deletedAt: null, arrivalDate: { gte: day(new Date().toISOString().slice(0, 10)) } },
      _count: { _all: true }
    });
    const busiest = arrivals.sort((a, b) => b._count._all - a._count._all)[0];
    if (!busiest) {
      console.log("[W2-C] Faranda sin llegadas confirmadas sin habitación: medición omitida");
      return;
    }
    const propertyCode = properties.find((p) => p.id === busiest.propertyId)?.code ?? "?";
    const date = busiest.arrivalDate.toISOString().slice(0, 10);
    const rooms = await prisma.room.count({ where: { propertyId: busiest.propertyId, active: true } });
    const memory: Array<Record<string, unknown>> = [];
    const readOnlyDb = {
      property: prisma.property,
      reservation: prisma.reservation,
      room: prisma.room,
      roomType: prisma.roomType,
      workOrder: prisma.workOrder,
      roomBlock: prisma.roomBlock,
      roomConnection: prisma.roomConnection,
      propertyCheckInPolicy: prisma.propertyCheckInPolicy,
      reservationGuest: prisma.reservationGuest,
      guest: prisma.guest,
      stay: prisma.stay,
      checkInSession: prisma.checkInSession,
      assignmentSuggestion: {
        updateMany: async () => ({ count: 0 }),
        create: async (args: { data: Record<string, unknown> }) => {
          const row = { id: `mem_${memory.length + 1}`, createdAt: new Date(), ...args.data };
          memory.push(row);
          return row;
        }
      }
    } as unknown as AssignmentDb;
    const context = { organizationId: FARANDA_ORG, propertyId: busiest.propertyId, userId: "usr_w2c_medicion", fullName: "Medición W2-C", deviceId: "w2c", permissions: ["pms.reservation.modify"] } as UserContext;
    const suggestionsBefore = await prisma.assignmentSuggestion.count({ where: { propertyId: { in: properties.map((p) => p.id) } } });
    const assignedFilter = { propertyId: busiest.propertyId, arrivalDate: busiest.arrivalDate, status: "confirmed" as const, assignedRoomId: { not: null } };
    const assignedBefore = await prisma.reservation.count({ where: assignedFilter });
    const label = `[W2-C] lote Faranda ${propertyCode} ${date} (${rooms} habitaciones · ${busiest._count._all} llegadas sin habitación)`;
    console.time(label);
    const out = await service.runBatchForDate({ context, propertyId: busiest.propertyId, date }, { db: readOnlyDb });
    console.timeEnd(label);
    console.log(`[W2-C] resultado: suggested ${out.suggested} · skipped ${out.skipped} · failed ${out.failed.length} · ${out.durationMs} ms`);
    assert.deepEqual(out.failed, []);
    assert.equal(out.suggested + out.skipped, busiest._count._all);
    assert.equal(memory.length, out.suggested);
    assert.equal(new Set(out.items.filter((item) => item.proposedRoomNumber).map((item) => item.proposedRoomNumber)).size, out.suggested, "sin repetir habitación en el lote");
    assert.ok(out.durationMs < 3000, `lote en ${out.durationMs} ms (límite 3.000)`);
    const suggestionsAfter = await prisma.assignmentSuggestion.count({ where: { propertyId: { in: properties.map((p) => p.id) } } });
    assert.equal(suggestionsAfter, suggestionsBefore, "ninguna sugerencia escrita sobre Faranda");
    assert.equal(await prisma.reservation.count({ where: assignedFilter }), assignedBefore, "ninguna reserva de Faranda asignada");
  });
});
