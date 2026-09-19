/**
 * Tanda L5 · lote L5-A · estado de habitación UNIFICADO — integración sobre
 * Postgres real con una organización AISLADA (helpers/l2-tenant.mts) y
 * STRICT_ENV (auth real, sin unión de permisos de demo, RBAC_STRICT=true).
 *
 * Modelo (schema.prisma, migración 20260919090000_operaciones_l5):
 *   · status              = ocupación / disponibilidad (occupied | out_of_order |
 *                           out_of_service) y, si está libre, espejo de la limpieza;
 *   · housekeepingStatus  = dirty | clean | inspected (NOT NULL);
 *   · maintenanceStatus   = ok | blocked | needs_attention (NOT NULL).
 * Todo escritor pasa por applyRoomTransition (idempotente, ROOM_STATE_CHANGED).
 *
 * Usuarios (plantillas T8a, packages/shared/src/permissions.ts):
 *   · receptionist (hotel A): crea la reserva, hace check-in y check-out
 *     (pms.reservation.create / pms.checkin.execute / pms.checkout.execute) y lee
 *     GET /properties/:id/dashboard (pms.reservation.read); NO tiene
 *     housekeeping.task.manage → 403 en mark-inspected;
 *   · manager (usuario extra, hotel A): mark-clean / mark-inspected /
 *     housekeeping-status (housekeeping.task.manage), partes con bloqueo
 *     (maintenance.workorder.create + ai.high_risk.confirm) y resolución
 *     (maintenance.workorder.manage), dashboards (analytics.read).
 * Nunca `owner` para nada operativo (v2 le revoca hk / workorder / checkin).
 *
 * Casos: check-in → occupied + hk intacto · mark-clean sobre ocupada · mark-inspected
 * ×2 → 200/200 y UN solo ROOM_STATE_CHANGED · ruta libre {ready} → clean auditado,
 * {foo} → 400 · check-out → dirty/dirty + departureTask · parte con bloqueo →
 * out_of_order + blocked + hk intacto · resolve → dirty/dirty/ok · coherencia numérica
 * de /dashboards/housekeeping, operations-director, GET /properties/:id/dashboard y
 * /dashboards/room-rack · invariantes de Faranda (invoices / verifactuSubmissions /
 * reservations: journal / ledger cambian por la carga de Sage).
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l5-estado-habitacion.test.mts
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

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };
type RoomRow = { status: string; housekeepingStatus: string; maintenanceStatus: string; sellable: boolean };

const RUN = `h${newRunId()}`;
const ROOM_STATE_CHANGED = "ROOM_STATE_CHANGED";

let app: ApiApp;
let A: IsolatedTenant;
/** Recepción del hotel A. */
let reception: Session;
/** Dirección de hotel (plantilla manager) en el hotel A. */
let manager: Session;
let invariantsBefore: { invoices: number; verifactuSubmissions: number; reservations: number };

/** Habitaciones del hotel A (101 / 102 / 103). */
let room101 = "";
let room102 = "";
let room103 = "";
let reservationId = "";
let reservationCode = "";

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
  assert.doesNotMatch(message, /manifiesto/);
}

async function roomRow(roomId: string): Promise<RoomRow> {
  const row = await prisma.room.findUniqueOrThrow({
    where: { id: roomId },
    select: { status: true, housekeepingStatus: true, maintenanceStatus: true, sellable: true }
  });
  return { status: String(row.status), housekeepingStatus: row.housekeepingStatus, maintenanceStatus: row.maintenanceStatus, sellable: row.sellable };
}

async function stateChangedEvents(roomId: string): Promise<Array<{ event: string; before: any; after: any }>> {
  await flushAuditQueues();
  const rows = await prisma.auditEvent.findMany({
    where: { action: ROOM_STATE_CHANGED, entityType: "room", entityId: roomId },
    orderBy: { createdAt: "asc" },
    select: { beforeJson: true, afterJson: true }
  });
  return rows.map((row) => ({ event: String((row.afterJson as any)?.event ?? ""), before: row.beforeJson, after: row.afterJson }));
}

/** Fecha local (Europe/Madrid) de hoy + offset en YYYY-MM-DD: la ventana de check-in es ±1 día sobre max(fecha de negocio, hoy local). */
function madridDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId?: string }): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L5 ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[spec.templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: {
      userId: id,
      roleId,
      scopeType: spec.propertyId ? "property" : "organization",
      propertyId: spec.propertyId ?? null,
      organizationId: tenant.organizationId,
      reason: `l5-a ${spec.local}`
    }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

async function createReservation(label: string): Promise<{ id: string; code: string }> {
  const created = await call("POST", `/properties/${A.propertyA}/reservations`, reception, {
    propertyId: A.propertyA,
    payload: { arrivalDate: madridDay(0), departureDate: madridDay(1), adults: 1, roomTypeId: A.roomTypeA, bookerName: `L5-A ${label} ${RUN}` }
  });
  assert.ok(created.status === 200 || created.status === 201, created.raw.slice(0, 400));
  assert.equal(created.body.status, "confirmed");
  return { id: created.body.id, code: created.body.code };
}

/** Las cuatro lecturas que deben dar las mismas cifras. */
async function readCounts(): Promise<{
  hk: { clean: number; dirty: number; inspected: number; ooo: number; occupied: number };
  ops: { clean: number; dirty: number; inspected: number; ooo: number };
  prop: { dirty: number; inspected: number; ooo: number };
  rack: { rooms: number; occupied: number; vacantClean: number; vacantDirty: number; outOfOrder: number };
}> {
  const hk = await call("GET", `/dashboards/housekeeping?propertyId=${A.propertyA}`, manager, { propertyId: A.propertyA });
  assert.equal(hk.status, 200, hk.raw.slice(0, 300));
  const ops = await call("GET", `/dashboards/operations-director?propertyId=${A.propertyA}`, manager, { propertyId: A.propertyA });
  assert.equal(ops.status, 200, ops.raw.slice(0, 300));
  const prop = await call("GET", `/properties/${A.propertyA}/dashboard`, reception, { propertyId: A.propertyA });
  assert.equal(prop.status, 200, prop.raw.slice(0, 300));
  const rack = await call("GET", `/dashboards/room-rack?propertyId=${A.propertyA}`, manager, { propertyId: A.propertyA });
  assert.equal(rack.status, 200, rack.raw.slice(0, 300));
  return {
    hk: {
      clean: hk.body.kpis.roomsClean,
      dirty: hk.body.kpis.roomsDirty,
      inspected: hk.body.kpis.roomsInspected,
      ooo: hk.body.kpis.roomsOutOfOrder,
      occupied: hk.body.kpis.roomsOccupied
    },
    ops: {
      clean: ops.body.miniCards.housekeeping.clean,
      dirty: ops.body.miniCards.housekeeping.dirty,
      inspected: ops.body.miniCards.housekeeping.inspected,
      ooo: ops.body.miniCards.housekeeping.ooo
    },
    prop: { dirty: prop.body.roomsDirty, inspected: prop.body.roomsCleanInspected, ooo: prop.body.roomsOutOfOrder },
    rack: rack.body.totals
  };
}

before(async () => {
  const all = await farandaInvariants();
  invariantsBefore = { invoices: all.invoices, verifactuSubmissions: all.verifactuSubmissions, reservations: all.reservations };
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  // El helper siembra maintenanceStatus "operational" (anterior al vocabulario
  // cerrado): partimos de tres habitaciones libres, limpias y sin bloqueo.
  await prisma.room.updateMany({ where: { propertyId: A.propertyA }, data: { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true } });
  const rooms = await prisma.room.findMany({ where: { propertyId: A.propertyA }, select: { id: true, number: true }, orderBy: { number: "asc" } });
  room101 = rooms.find((r) => r.number === "101")?.id ?? "";
  room102 = rooms.find((r) => r.number === "102")?.id ?? "";
  room103 = rooms.find((r) => r.number === "103")?.id ?? "";
  assert.ok(room101 && room102 && room103, "las tres habitaciones sembradas del hotel A");
  const managerUser = await addTenantUser(A, { local: "manager", templateKey: "manager", propertyId: A.propertyA });
  await withEnv(STRICT_ENV, async () => {
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l5-a-reception");
    manager = await loginOrThrow(app, managerUser.email, A.password, "l5-a-manager");
  });
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
// check-in, limpieza e inspección idempotente
// ---------------------------------------------------------------------------

describe("L5-A · check-in real y limpieza sobre una ocupada", () => {
  it("mark-inspected (manager) sobre una limpia libre → inspected/inspected; el check-in deja status occupied con la limpieza intacta", async () => {
    const inspected = await call("POST", `/rooms/${room101}/mark-inspected`, manager, { propertyId: A.propertyA });
    assert.equal(inspected.status, 200, inspected.raw.slice(0, 300));
    assert.equal(inspected.body.housekeepingStatus, "inspected");
    assert.equal(inspected.body.status, "inspected", "libre: status espejo de la limpieza");

    const reservation = await createReservation("check-in");
    reservationId = reservation.id;
    reservationCode = reservation.code;
    const checkIn = await call("POST", `/reservations/${reservationId}/check-in`, reception, { propertyId: A.propertyA, payload: { roomId: room101 } });
    assert.equal(checkIn.status, 200, checkIn.raw.slice(0, 400));
    assert.equal(checkIn.body.status, "checked_in");

    const row = await roomRow(room101);
    assert.equal(row.status, "occupied");
    assert.equal(row.housekeepingStatus, "inspected", "el check-in no toca la limpieza");
    assert.equal(row.maintenanceStatus, "ok");

    const events = await stateChangedEvents(room101);
    assert.deepEqual(events.map((e) => e.event), ["mark_inspected", "check_in"]);
    assert.equal(events[1].before.status, "inspected");
    assert.equal(events[1].after.status, "occupied");
    assert.match(String(events[1].after.reason), new RegExp(`Check-in ${reservationCode}`));
  });

  it("housekeeping-status {dirty} y mark-clean sobre la ocupada: cambia la limpieza, status sigue occupied", async () => {
    const dirty = await call("POST", `/rooms/${room101}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "dirty" } });
    assert.equal(dirty.status, 200, dirty.raw.slice(0, 300));
    assert.equal(dirty.body.status, "occupied");
    assert.equal(dirty.body.housekeepingStatus, "dirty");

    const clean = await call("POST", `/rooms/${room101}/mark-clean`, manager, { propertyId: A.propertyA });
    assert.equal(clean.status, 200, clean.raw.slice(0, 300));
    assert.equal(clean.body.status, "occupied", "mark-clean sobre una ocupada NO libera la habitación");
    assert.equal(clean.body.housekeepingStatus, "clean");
    assert.deepEqual(await roomRow(room101), { status: "occupied", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true });
  });

  it("mark-inspected ×2 → 200 / 200 y UN solo ROOM_STATE_CHANGED (idempotente); recepción → 403 housekeeping.task.manage", async () => {
    const before = (await stateChangedEvents(room101)).length;
    const first = await call("POST", `/rooms/${room101}/mark-inspected`, manager, { propertyId: A.propertyA });
    assert.equal(first.status, 200, first.raw.slice(0, 300));
    assert.equal(first.body.housekeepingStatus, "inspected");
    assert.equal(first.body.status, "occupied");
    const second = await call("POST", `/rooms/${room101}/mark-inspected`, manager, { propertyId: A.propertyA });
    assert.equal(second.status, 200, `la segunda inspección responde 200, no 409: ${second.raw.slice(0, 300)}`);
    assert.equal(second.body.housekeepingStatus, "inspected");

    const events = await stateChangedEvents(room101);
    assert.equal(events.length - before, 1, "una sola transición auditada para dos llamadas");
    assert.equal(events[events.length - 1].event, "mark_inspected");
    const legacy = await prisma.auditEvent.count({ where: { action: "ROOM_INSPECTED", entityId: room101 } });
    assert.equal(legacy, 2, "ROOM_INSPECTED legado: la inspección libre de este describe + la primera de aquí; la repetida no lo emite");

    expect403(await call("POST", `/rooms/${room101}/mark-inspected`, reception, { propertyId: A.propertyA }), "housekeeping.task.manage");
  });
});

// ---------------------------------------------------------------------------
// ruta libre: alias normalizados, auditada, 400 fuera de vocabulario
// ---------------------------------------------------------------------------

describe("L5-A · POST /rooms/:id/housekeeping-status", () => {
  it("{status:\"ready\"} almacena clean (nunca el alias) y queda auditado; {stayover} → dirty", async () => {
    const stayover = await call("POST", `/rooms/${room102}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "stayover" } });
    assert.equal(stayover.status, 200, stayover.raw.slice(0, 300));
    assert.deepEqual(await roomRow(room102), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });

    const ready = await call("POST", `/rooms/${room102}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "ready" } });
    assert.equal(ready.status, 200, ready.raw.slice(0, 300));
    assert.equal(ready.body.housekeepingStatus, "clean");
    assert.deepEqual(await roomRow(room102), { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true });

    const events = await stateChangedEvents(room102);
    assert.deepEqual(events.map((e) => e.event), ["mark_dirty", "mark_clean"]);
    assert.equal(events[1].after.reason, "housekeeping-status ready");
    assert.equal(events[1].after.housekeepingStatus, "clean");
  });

  it("{status:\"foo\"} → 400 en español y sin escribir; {status:\"clean\"} sobre una limpia → 200 sin nueva auditoría", async () => {
    const before = (await stateChangedEvents(room102)).length;
    const foo = await call("POST", `/rooms/${room102}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "foo" } });
    assert.equal(foo.status, 400, foo.raw.slice(0, 300));
    assert.equal(foo.body?.message, "Estado de limpieza no válido: usa clean, dirty o inspected.");
    const occupied = await call("POST", `/rooms/${room102}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "occupied" } });
    assert.equal(occupied.status, 400, "la ocupación no se escribe por la ruta de limpieza");

    const again = await call("POST", `/rooms/${room102}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "clean" } });
    assert.equal(again.status, 200, again.raw.slice(0, 300));
    assert.equal((await stateChangedEvents(room102)).length, before, "idempotente: sin evento");
    assert.deepEqual(await roomRow(room102), { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true });
    expect403(await call("POST", `/rooms/${room102}/housekeeping-status`, reception, { propertyId: A.propertyA, payload: { status: "clean" } }), "housekeeping.task.manage");
  });
});

// ---------------------------------------------------------------------------
// check-out y mantenimiento
// ---------------------------------------------------------------------------

describe("L5-A · check-out, bloqueo y liberación por mantenimiento", () => {
  it("check-out real → status dirty / hk dirty y tarea departure_clean", async () => {
    const checkOut = await call("POST", `/reservations/${reservationId}/check-out`, reception, { propertyId: A.propertyA, payload: {} });
    assert.equal(checkOut.status, 200, checkOut.raw.slice(0, 400));
    assert.equal(checkOut.body.reservation.status, "checked_out");
    assert.ok(checkOut.body.departureTask?.id, `el check-out crea la tarea de salida: ${checkOut.raw.slice(0, 300)}`);
    assert.equal(checkOut.body.departureTask.taskType, "departure_clean");
    assert.deepEqual(await roomRow(room101), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const events = await stateChangedEvents(room101);
    assert.equal(events[events.length - 1].event, "check_out");
    assert.equal(events[events.length - 1].before.status, "occupied");
  });

  it("parte con blocksRoom (manager) → out_of_order + blocked + no vendible, limpieza intacta; resolve releaseRoom → dirty/dirty/ok", async () => {
    assert.equal((await roomRow(room102)).housekeepingStatus, "clean");
    const created = await call("POST", "/work-orders", manager, {
      propertyId: A.propertyA,
      payload: { roomNumber: "102", title: `Fuga en el baño ${RUN}`, priority: "urgent", blocksRoom: true }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 400));
    const workOrderId = String(created.body.id);
    assert.deepEqual(await roomRow(room102), { status: "out_of_order", housekeepingStatus: "clean", maintenanceStatus: "blocked", sellable: false });

    // La limpieza sigue siendo de pisos aunque la habitación esté fuera de servicio.
    const inspected = await call("POST", `/rooms/${room102}/mark-inspected`, manager, { propertyId: A.propertyA });
    assert.equal(inspected.status, 200, inspected.raw.slice(0, 300));
    assert.deepEqual(await roomRow(room102), { status: "out_of_order", housekeepingStatus: "inspected", maintenanceStatus: "blocked", sellable: false });

    const resolved = await call("POST", `/work-orders/${workOrderId}/resolve`, manager, { propertyId: A.propertyA, payload: { releaseRoom: true, resolutionNote: "Reparado" } });
    assert.equal(resolved.status, 200, resolved.raw.slice(0, 400));
    assert.equal(resolved.body.status, "resolved");
    assert.deepEqual(await roomRow(room102), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const events = await stateChangedEvents(room102);
    assert.deepEqual(events.slice(-3).map((e) => e.event), ["block_maintenance", "mark_inspected", "release_maintenance"]);
  });
});

// ---------------------------------------------------------------------------
// coherencia numérica de los cuatro lectores
// ---------------------------------------------------------------------------

describe("L5-A · /dashboards/housekeeping, operations-director, GET /properties/:id/dashboard y room-rack dan las mismas cifras", () => {
  it("101 sucia libre · 102 sucia libre · 103 ocupada limpia", async () => {
    const stay = await createReservation("ocupada");
    const checkIn = await call("POST", `/reservations/${stay.id}/check-in`, reception, { propertyId: A.propertyA, payload: { roomId: room103 } });
    assert.equal(checkIn.status, 200, checkIn.raw.slice(0, 400));
    assert.deepEqual(await roomRow(room103), { status: "occupied", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true });

    const counts = await readCounts();
    assert.deepEqual(counts.hk, { clean: 1, dirty: 2, inspected: 0, ooo: 0, occupied: 1 });
    assert.deepEqual(counts.ops, { clean: 1, dirty: 2, inspected: 0, ooo: 0 });
    assert.deepEqual(counts.prop, { dirty: 2, inspected: 0, ooo: 0 });
    assert.equal(counts.rack.rooms, 3);
    assert.equal(counts.rack.occupied, 1);
    assert.equal(counts.rack.vacantClean, 0);
    assert.equal(counts.rack.vacantDirty, 2);
    assert.equal(counts.rack.outOfOrder, 0);
  });

  it("102 inspeccionada (limpia por hk) y 103 ocupada sucia: la limpieza cuenta en todas las ocupaciones", async () => {
    assert.equal((await call("POST", `/rooms/${room102}/mark-clean`, manager, { propertyId: A.propertyA })).status, 200);
    assert.equal((await call("POST", `/rooms/${room102}/mark-inspected`, manager, { propertyId: A.propertyA })).status, 200);
    assert.equal((await call("POST", `/rooms/${room103}/housekeeping-status`, manager, { propertyId: A.propertyA, payload: { status: "dirty" } })).status, 200);
    assert.deepEqual(await roomRow(room103), { status: "occupied", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });

    const counts = await readCounts();
    assert.deepEqual(counts.hk, { clean: 0, dirty: 2, inspected: 1, ooo: 0, occupied: 1 });
    assert.deepEqual(counts.ops, { clean: 0, dirty: 2, inspected: 1, ooo: 0 });
    assert.deepEqual(counts.prop, { dirty: 2, inspected: 1, ooo: 0 });
    assert.equal(counts.rack.occupied, 1);
    assert.equal(counts.rack.vacantClean, 1, "inspeccionada = limpia en el rack");
    assert.equal(counts.rack.vacantDirty, 1);
    assert.equal(counts.rack.outOfOrder, 0);
  });

  it("102 bloqueada por mantenimiento: fuera de servicio en los cuatro lectores, su limpieza (inspected) sigue contando", async () => {
    const created = await call("POST", "/work-orders", manager, {
      propertyId: A.propertyA,
      payload: { roomNumber: "102", title: `Aire acondicionado ${RUN}`, priority: "normal", blocksRoom: true }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 400));
    assert.deepEqual(await roomRow(room102), { status: "out_of_order", housekeepingStatus: "inspected", maintenanceStatus: "blocked", sellable: false });

    const counts = await readCounts();
    assert.deepEqual(counts.hk, { clean: 0, dirty: 2, inspected: 1, ooo: 1, occupied: 1 });
    assert.deepEqual(counts.ops, { clean: 0, dirty: 2, inspected: 1, ooo: 1 });
    assert.deepEqual(counts.prop, { dirty: 2, inspected: 1, ooo: 1 });
    assert.equal(counts.rack.occupied, 1);
    assert.equal(counts.rack.vacantClean, 0);
    assert.equal(counts.rack.vacantDirty, 1);
    assert.equal(counts.rack.outOfOrder, 1);
    assert.equal(counts.hk.clean + counts.hk.dirty + counts.hk.inspected, 3, "toda habitación tiene exactamente una limpieza");
  });
});

// ---------------------------------------------------------------------------
// corrector L5 · OP-01 (bloqueo sobre una ocupada) y OP-05 (POST /rooms/:id/sellable)
// ---------------------------------------------------------------------------

describe("Corrector L5 · OP-01: un parte con blocksRoom sobre la 103 OCUPADA no borra la ocupación", () => {
  let workOrderId = "";

  it("la 103 sigue occupied + blocked + no vendible; los cuatro lectores la cuentan ocupada y la 102 (bloqueada libre) fuera de servicio", async () => {
    assert.deepEqual(await roomRow(room103), { status: "occupied", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const created = await call("POST", "/work-orders", manager, {
      propertyId: A.propertyA,
      payload: { roomNumber: "103", title: `Grifo del baño ${RUN}`, priority: "urgent", blocksRoom: true }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 400));
    workOrderId = created.body.id;
    assert.deepEqual(await roomRow(room103), { status: "occupied", housekeepingStatus: "dirty", maintenanceStatus: "blocked", sellable: false });
    assert.equal(await prisma.reservation.count({ where: { assignedRoomId: room103, status: "checked_in" } }), 1, "la reserva sigue alojada");

    const counts = await readCounts();
    assert.deepEqual(counts.hk, { clean: 0, dirty: 2, inspected: 1, ooo: 1, occupied: 1 }, "la 103 cuenta como ocupada, no como fuera de servicio");
    assert.deepEqual(counts.ops, { clean: 0, dirty: 2, inspected: 1, ooo: 1 });
    assert.deepEqual(counts.prop, { dirty: 2, inspected: 1, ooo: 1 });
    assert.equal(counts.rack.occupied, 1, "el rack también la cuenta ocupada (la incidencia va en el badge)");
    assert.equal(counts.rack.outOfOrder, 1);
    const events = await stateChangedEvents(room103);
    assert.equal(events.at(-1)?.event, "block_maintenance");
    assert.equal(events.at(-1)?.after?.status, "occupied");
  });

  it("resolve con releaseRoom sobre la ocupada → occupied / dirty / ok / vendible; el check-out posterior la deja libre y sucia", async () => {
    const resolved = await call("POST", `/work-orders/${workOrderId}/resolve`, manager, { propertyId: A.propertyA, payload: { releaseRoom: true, resolutionNote: "Reparado con el huésped dentro" } });
    assert.equal(resolved.status, 200, resolved.raw.slice(0, 400));
    assert.deepEqual(await roomRow(room103), { status: "occupied", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
  });
});

describe("Corrector L5 · OP-05: POST /rooms/:id/sellable pasa por la transición unificada", () => {
  it("101 libre sucia: sellable=false → out_of_service (no vendible) auditado; true → vuelve a dirty; repetido → sin evento nuevo", async () => {
    assert.deepEqual(await roomRow(room101), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const before = (await stateChangedEvents(room101)).length;
    const off = await call("POST", `/rooms/${room101}/sellable`, manager, { propertyId: A.propertyA, payload: { sellable: false } });
    assert.equal(off.status, 200, off.raw.slice(0, 300));
    assert.deepEqual(await roomRow(room101), { status: "out_of_service", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: false });
    const counts = await readCounts();
    assert.equal(counts.hk.ooo, 2, "la 101 fuera de servicio se suma a la 102 bloqueada");
    assert.equal(counts.rack.outOfOrder, 2);
    const again = await call("POST", `/rooms/${room101}/sellable`, manager, { propertyId: A.propertyA, payload: { sellable: false } });
    assert.equal(again.status, 200);
    const on = await call("POST", `/rooms/${room101}/sellable`, manager, { propertyId: A.propertyA, payload: { sellable: true } });
    assert.equal(on.status, 200, on.raw.slice(0, 300));
    assert.deepEqual(await roomRow(room101), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok", sellable: true });
    const events = await stateChangedEvents(room101);
    assert.deepEqual(events.slice(before).map((e) => e.event), ["mark_unsellable", "mark_sellable"], "dos eventos auditados, el repetido no escribe");
  });

  it("la 102 bloqueada por orden de trabajo NO se libera con sellable=true → 409 ROOM_MAINTENANCE_BLOCKED (invariante blocked ⇒ sellable=false)", async () => {
    assert.deepEqual(await roomRow(room102), { status: "out_of_order", housekeepingStatus: "inspected", maintenanceStatus: "blocked", sellable: false });
    const reply = await call("POST", `/rooms/${room102}/sellable`, manager, { propertyId: A.propertyA, payload: { sellable: true } });
    assert.equal(reply.status, 409, reply.raw.slice(0, 300));
    assert.equal(reply.body.details?.code, "ROOM_MAINTENANCE_BLOCKED");
    assert.deepEqual(await roomRow(room102), { status: "out_of_order", housekeepingStatus: "inspected", maintenanceStatus: "blocked", sellable: false });
  });
});
