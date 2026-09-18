/**
 * Tanda L2 · L2-08 · tests de integración mínimos por módulo — OPERACIONES
 * (housekeeping, maintenance, assets, allotment, fnb-inventory,
 * cancellation-policy, mapper). app.inject sobre Postgres real con dos
 * organizaciones AISLADAS (helpers/l2-tenant.mts): A escribe y lee; B (otra
 * organización) nunca ve nada. STRICT_ENV: auth real, sin unión de permisos de
 * demo, RBAC_STRICT=true.
 *
 * Tres casos por módulo (criterio §4 del plan · fila L2 «tests por módulo»):
 *   (1) crear o leer con ámbito: la fila aparece en Prisma con el
 *       organizationId / propertyId de la organización A;
 *   (2) 403 sin clave: un usuario sin la clave de dirección / finanzas /
 *       configuración recibe el 403 en español del gate (o de
 *       requirePermissions en el servicio) — nunca el 403 «ruta no registrada en
 *       el manifiesto»;
 *   (3) 404 opaco en propiedad ajena: la recepcionista de A sobre el hotel B y
 *       el propietario de la organización B sobre el hotel A reciben
 *       «Propiedad no encontrada.» (hook de ámbito, ANTES del gate de claves).
 *
 * Usuarios (plantillas T8a, ver packages/shared/src/permissions.ts
 * ROLE_PERMISSION_MAP): el `owner` de T8a es de lectura (sin
 * housekeeping.read ni claves de escritura); las escrituras de dirección las
 * hace un usuario extra con la plantilla `manager` (Dirección de hotel) asignado
 * al hotel A, como en l2-rutas-api.test.mts. El módulo dashboards (33 GET) lo
 * cubre l2-robustez.test.mts (L2-06, describe «(2) dashboards»).
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-modulos-operaciones.test.mts
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

const RUN = `o${newRunId()}`;
const OPAQUE_404 = "Propiedad no encontrada.";

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
/** Propiedad (organización A): lectura de organización, T8a. */
let owner: Session;
/** Dirección de hotel (plantilla manager) en el hotel A: escrituras de dirección. */
let manager: Session;
/** Recepción: solo el hotel A. */
let reception: Session;
/** Contabilidad (organización A): inventory.manage, sin claves de recepción. */
let accountant: Session;
/** Propietario de la organización B. */
let ownerB: Session;
/** Recepción de la organización B: tiene las claves de recepción pero no el ámbito de A → 404 opaco (no 403). */
let receptionB: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

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

function expect404(reply: Reply, message = OPAQUE_404): void {
  assert.equal(reply.status, 404, reply.raw.slice(0, 300));
  assert.equal(reply.body?.message, message);
}

/** 403 en español del gate o de requirePermissions, con la clave que falta; nunca el de «ruta sin manifiesto». */
function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
  assert.doesNotMatch(message, /manifiesto/, "no es el 403 de ruta sin entrada en el manifiesto");
}

/** Usuario extra con una plantilla de T8a, asignado a un hotel o a la organización; cuelga de la org → cleanupTenant lo barre. */
async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId?: string }): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2 ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
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
      reason: `l2-08 ${spec.local}`
    }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  const managerUser = await addTenantUser(A, { local: "manager", templateKey: "manager", propertyId: A.propertyA });
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l2-08-ops-owner");
    manager = await loginOrThrow(app, managerUser.email, A.password, "l2-08-ops-manager");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l2-08-ops-reception");
    accountant = await loginOrThrow(app, A.users.accountant.email, A.password, "l2-08-ops-accountant");
    ownerB = await loginOrThrow(app, B.users.owner.email, B.password, "l2-08-ops-owner-b");
    receptionB = await loginOrThrow(app, B.users.receptionist.email, B.password, "l2-08-ops-reception-b");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
    if (B) await cleanupTenant(B.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
});

// ---------------------------------------------------------------------------
// housekeeping
// ---------------------------------------------------------------------------

describe("L2-08 · housekeeping: cuadro de pisos y tareas con ámbito", () => {
  it("(1) GET /properties/:id/housekeeping/board lista las habitaciones de A y POST /housekeeping/tasks (manager) persiste la tarea en A", async () => {
    const board = await call("GET", `/properties/${A.propertyA}/housekeeping/board`, reception);
    assert.equal(board.status, 200, board.raw.slice(0, 300));
    assert.ok(Array.isArray(board.body), "el cuadro es un array de { room, tasks }");
    assert.equal(board.body.length, 3, "las 3 habitaciones sembradas del hotel A");
    assert.ok(board.body.every((item: { room: { propertyId: string } }) => item.room.propertyId === A.propertyA));

    const created = await call("POST", "/housekeeping/tasks", manager, {
      propertyId: A.propertyA,
      payload: { propertyId: A.propertyA, roomId: A.roomsA[0], taskType: "departure_clean", priority: "high" }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    const row = await prisma.housekeepingTask.findUnique({ where: { id: created.body.id } });
    assert.ok(row, "la tarea existe en Prisma");
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.roomId, A.roomsA[0]);
    assert.equal(row.taskType, "departure_clean");

    const again = await call("GET", `/properties/${A.propertyA}/housekeeping/board`, reception);
    const withTask = again.body.find((item: { room: { id: string } }) => item.room.id === A.roomsA[0]);
    assert.ok(withTask.tasks.some((task: { id: string }) => task.id === created.body.id), "el cuadro refleja la tarea persistida");
  });

  it("(2) 403 sin clave: recepción no crea tareas (housekeeping.task.manage) y el owner de T8a no abre el cuadro (housekeeping.read)", async () => {
    const denied = await call("POST", "/housekeeping/tasks", reception, {
      propertyId: A.propertyA,
      payload: { propertyId: A.propertyA, roomId: A.roomsA[1], taskType: "inspection" }
    });
    expect403(denied, "housekeeping.task.manage");
    expect403(await call("GET", `/properties/${A.propertyA}/housekeeping/board`, owner), "housekeeping.read");
  });

  it("(3) 404 opaco: recepción de A sobre el hotel B, organización B sobre el hotel A y propertyId ajeno en el body", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/housekeeping/board`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/housekeeping/board`, ownerB));
    const foreignBody = await call("POST", "/housekeeping/tasks", manager, {
      propertyId: A.propertyA,
      payload: { propertyId: A.propertyB, roomId: A.roomsB[0], taskType: "stayover" }
    });
    expect404(foreignBody);
    assert.equal(await prisma.housekeepingTask.count({ where: { propertyId: A.propertyB } }), 0, "nada escrito en B");
  });
});

// ---------------------------------------------------------------------------
// maintenance
// ---------------------------------------------------------------------------

describe("L2-08 · maintenance: partes de trabajo con ámbito", () => {
  let workOrderId = "";

  it("(1) POST /work-orders (recepción, x-property-id A) persiste el parte en A y GET /properties/:id/work-orders lo lista", async () => {
    const created = await call("POST", "/work-orders", reception, {
      propertyId: A.propertyA,
      payload: { roomNumber: "101", title: `Grifo que gotea ${RUN}`, priority: "normal", blocksRoom: false }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    workOrderId = created.body.id;
    const row = await prisma.workOrder.findUnique({ where: { id: workOrderId } });
    assert.ok(row, "el parte existe en Prisma");
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.title, `Grifo que gotea ${RUN}`);

    const list = await call("GET", `/properties/${A.propertyA}/work-orders`, reception);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.some((item: { id: string }) => item.id === workOrderId));
  });

  it("(2) 403 sin clave: recepción no modifica ni resuelve partes (maintenance.workorder.manage)", async () => {
    expect403(await call("PATCH", `/work-orders/${workOrderId}`, reception, { propertyId: A.propertyA, payload: { priority: "urgent" } }), "maintenance.workorder.manage");
    expect403(await call("POST", `/work-orders/${workOrderId}/resolve`, reception, { propertyId: A.propertyA, payload: {} }), "maintenance.workorder.manage");
    const untouched = await prisma.workOrder.findUnique({ where: { id: workOrderId }, select: { priority: true, status: true } });
    assert.equal(untouched?.priority, "normal");
  });

  it("(3) 404 opaco: recepción de A sobre B, organización B sobre A (lista y parte por id)", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/work-orders`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/work-orders`, ownerB));
    const foreignCreate = await call("POST", "/work-orders", ownerB, { propertyId: A.propertyA, payload: { title: "Intruso", priority: "normal", blocksRoom: false } });
    expect404(foreignCreate);
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), 1, "solo el parte de A");
  });
});

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

describe("L2-08 · assets: activos de la propiedad con ámbito", () => {
  let assetId = "";

  it("(1) POST /assets (manager) persiste el activo en A y GET /properties/:id/assets (owner) lo lista", async () => {
    const created = await call("POST", "/assets", manager, {
      propertyId: A.propertyA,
      payload: { propertyId: A.propertyA, roomId: A.roomsA[0], assetType: "tv", name: `Televisor 101 ${RUN}` }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    assetId = created.body.id;
    const row = await prisma.asset.findUnique({ where: { id: assetId } });
    assert.ok(row, "el activo existe en Prisma");
    assert.equal(row.propertyId, A.propertyA);

    const list = await call("GET", `/properties/${A.propertyA}/assets`, owner);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.some((item: { id: string }) => item.id === assetId));
  });

  it("(2) 403 sin clave: recepción no lee activos (assets.read) ni los crea (maintenance.workorder.manage)", async () => {
    expect403(await call("GET", `/properties/${A.propertyA}/assets`, reception), "assets.read");
    expect403(await call("POST", "/assets", reception, { propertyId: A.propertyA, payload: { propertyId: A.propertyA, assetType: "hvac", name: "Aire" } }), "maintenance.workorder.manage");
  });

  it("(3) 404 opaco: recepción de A sobre B (antes que el 403) y organización B sobre A", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/assets`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/assets`, ownerB));
    expect404(await call("POST", "/assets", ownerB, { payload: { propertyId: A.propertyA, assetType: "tv", name: "Intruso" } }));
    assert.equal(await prisma.asset.count({ where: { propertyId: A.propertyA } }), 1, "solo el activo de A");
  });
});

// ---------------------------------------------------------------------------
// allotment
// ---------------------------------------------------------------------------

describe("L2-08 · allotment: cupos con ámbito", () => {
  let allotmentId = "";

  it("(1) POST /properties/:id/allotments (manager) persiste el cupo en A y GET lo lista (recepción, channel_manager.read)", async () => {
    const created = await call("POST", `/properties/${A.propertyA}/allotments`, manager, {
      payload: { code: `TO-${RUN}`, name: `Cupo L2 ${RUN}`, roomTypeId: A.roomTypeA, validFrom: "2026-10-01", validTo: "2026-10-07", totalRooms: 2, releaseDays: 3 }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    allotmentId = created.body.id;
    const row = await prisma.allotment.findUnique({ where: { id: allotmentId } });
    assert.ok(row, "el cupo existe en Prisma");
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.roomTypeId, A.roomTypeA);

    const list = await call("GET", `/properties/${A.propertyA}/allotments`, reception);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.items.some((item: { id: string }) => item.id === allotmentId));
  });

  it("(2) 403 sin clave: recepción no crea ni borra cupos (channel_manager.manage)", async () => {
    expect403(await call("POST", `/properties/${A.propertyA}/allotments`, reception, { payload: { code: "X", name: "X", roomTypeId: A.roomTypeA, validFrom: "2026-10-01", validTo: "2026-10-02", totalRooms: 1 } }), "channel_manager.manage");
    expect403(await call("DELETE", `/allotments/${allotmentId}`, reception, { propertyId: A.propertyA }), "channel_manager.manage");
    assert.equal(await prisma.allotment.count({ where: { propertyId: A.propertyA } }), 1);
  });

  it("(3) 404 opaco: recepción de A sobre B, organización B sobre A y sobre el cupo por id", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/allotments`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/allotments`, ownerB));
    expect404(await call("GET", `/allotments/${allotmentId}`, ownerB), "Cupo no encontrado.");
  });
});

// ---------------------------------------------------------------------------
// fnb-inventory (server.ts: /properties/:id/inventory-items, stock-locations, stock-movements, stock-balances)
// ---------------------------------------------------------------------------

describe("L2-08 · fnb-inventory: almacenes, artículos, movimientos y saldos con ámbito", () => {
  let itemId = "";

  it("(1) contabilidad (inventory.manage) crea almacén, artículo y apertura de stock en A; los saldos y la lista los reflejan", async () => {
    const location = await call("POST", `/properties/${A.propertyA}/stock-locations`, accountant, { payload: { name: `Economato ${RUN}`, locationType: "store" } });
    assert.equal(location.status, 200, location.raw.slice(0, 300));
    const item = await call("POST", `/properties/${A.propertyA}/inventory-items`, accountant, { payload: { name: `Café en grano ${RUN}`, unit: "kg", category: "bebidas", minLevel: 2 } });
    assert.equal(item.status, 200, item.raw.slice(0, 300));
    itemId = item.body.id;
    const movement = await call("POST", `/properties/${A.propertyA}/stock-movements`, accountant, {
      payload: { inventoryItemId: itemId, stockLocationId: location.body.id, movementType: "opening_balance", quantity: 10, unitCost: 12.5 }
    });
    assert.equal(movement.status, 200, movement.raw.slice(0, 300));

    const [locationRow, itemRow, movementRow] = await Promise.all([
      prisma.stockLocation.findUnique({ where: { id: location.body.id } }),
      prisma.inventoryItem.findUnique({ where: { id: itemId } }),
      prisma.stockMovement.findUnique({ where: { id: movement.body.id } })
    ]);
    assert.equal(locationRow?.propertyId, A.propertyA);
    assert.equal(itemRow?.propertyId, A.propertyA);
    assert.equal(movementRow?.propertyId, A.propertyA);

    const balances = await call("GET", `/properties/${A.propertyA}/stock-balances`, accountant);
    assert.equal(balances.status, 200, balances.raw.slice(0, 300));
    const balance = balances.body.items.find((row: { inventoryItemId: string }) => row.inventoryItemId === itemId);
    assert.equal(balance?.onHand, 10);
    assert.equal(balance?.lowStock, false);
    const items = await call("GET", `/properties/${A.propertyA}/inventory-items`, owner);
    assert.equal(items.status, 200);
    assert.ok(items.body.items.some((row: { id: string }) => row.id === itemId));
  });

  it("(2) 403 sin clave: recepción no lee el inventario (inventory.read) y el owner no lo escribe (inventory.manage)", async () => {
    expect403(await call("GET", `/properties/${A.propertyA}/inventory-items`, reception), "inventory.read");
    expect403(await call("GET", `/properties/${A.propertyA}/stock-balances`, reception), "inventory.read");
    expect403(await call("POST", `/properties/${A.propertyA}/inventory-items`, owner, { payload: { name: "X", unit: "ud" } }), "inventory.manage");
  });

  it("(3) 404 opaco: recepción de A sobre B (antes que el 403 de inventario) y organización B sobre A", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/inventory-items`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/stock-balances`, ownerB));
    expect404(await call("POST", `/properties/${A.propertyA}/stock-locations`, ownerB, { payload: { name: "Intruso", locationType: "store" } }));
    assert.equal(await prisma.stockLocation.count({ where: { propertyId: A.propertyA } }), 1, "solo el almacén de A");
  });
});

// ---------------------------------------------------------------------------
// cancellation-policy
// ---------------------------------------------------------------------------

describe("L2-08 · cancellation-policy: políticas de cancelación con ámbito", () => {
  let policyId = "";

  it("(1) POST /properties/:id/cancellation-policies (recepción, pms.reservation.modify) persiste la política en A y GET la lista (owner)", async () => {
    const created = await call("POST", `/properties/${A.propertyA}/cancellation-policies`, reception, {
      payload: { code: `FLEX-${RUN}`, name: "Flexible 48 h", freeCancelHours: 48, penaltyType: "first_night" }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    policyId = created.body.id;
    const row = await prisma.cancellationPolicy.findUnique({ where: { id: policyId } });
    assert.ok(row, "la política existe en Prisma");
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.code, `FLEX-${RUN}`);

    const list = await call("GET", `/properties/${A.propertyA}/cancellation-policies`, owner);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.items.some((item: { id: string }) => item.id === policyId));
  });

  it("(2) 403 sin clave: contabilidad no crea ni borra políticas (pms.reservation.modify)", async () => {
    expect403(await call("POST", `/properties/${A.propertyA}/cancellation-policies`, accountant, { payload: { code: "X", name: "X" } }), "pms.reservation.modify");
    expect403(await call("DELETE", `/cancellation-policies/${policyId}`, accountant), "pms.reservation.modify");
    assert.equal(await prisma.cancellationPolicy.count({ where: { propertyId: A.propertyA } }), 1);
  });

  it("(3) 404 opaco: recepción de A sobre B, organización B sobre A y sobre la política por id", async () => {
    expect404(await call("GET", `/properties/${A.propertyB}/cancellation-policies`, reception));
    expect404(await call("GET", `/properties/${A.propertyA}/cancellation-policies`, ownerB));
    expect404(await call("GET", `/cancellation-policies/${policyId}`, ownerB), "Política de cancelación no encontrada.");
    // Recepción de B SÍ tiene pms.reservation.modify: el gate pasa y la tenencia de la entidad responde 404 opaco.
    expect404(await call("DELETE", `/cancellation-policies/${policyId}`, receptionB), "Política de cancelación no encontrada.");
    assert.equal(await prisma.cancellationPolicy.count({ where: { id: policyId } }), 1, "la organización B no borra");
  });
});

// ---------------------------------------------------------------------------
// mapper
// ---------------------------------------------------------------------------

describe("L2-08 · mapper: aplicar una propuesta de mapa de la propiedad con ámbito", () => {
  const proposal = (number: string) => ({
    source: "rules",
    modelVersion: "l2-08-test",
    buildings: [],
    floors: ["9"],
    zones: [],
    roomTypes: [{ name: `Suite L2 ${RUN}`, code: `SL2${RUN.slice(-3)}`, baseOccupancy: 2, maxOccupancy: 3 }],
    rooms: [{ number, floor: "9", roomTypeName: `Suite L2 ${RUN}` }],
    spaces: [],
    counts: { buildings: 0, floors: 1, zones: 0, roomTypes: 1, rooms: 1, spaces: 0 }
  });

  it("(1) POST /properties/:id/mapper/apply (manager, rooms.manage) crea el tipo y la habitación en A", async () => {
    const applied = await call("POST", `/properties/${A.propertyA}/mapper/apply`, manager, { payload: { proposal: proposal("901") } });
    assert.equal(applied.status, 200, applied.raw.slice(0, 300));
    assert.equal(applied.body.roomTypesCreated, 1);
    assert.equal(applied.body.roomsCreated, 1);
    const room = await prisma.room.findFirst({ where: { propertyId: A.propertyA, number: "901" } });
    assert.ok(room, "la habitación 901 existe en Prisma");
    const roomType = await prisma.roomType.findUnique({ where: { id: room.roomTypeId } });
    assert.equal(roomType?.name, `Suite L2 ${RUN}`);
    assert.equal(roomType?.propertyId, A.propertyA);
    assert.equal(await prisma.room.count({ where: { propertyId: A.propertyB, number: "901" } }), 0, "nada en B");
  });

  it("(2) 403 sin clave: recepción no aplica propuestas (rooms.manage)", async () => {
    expect403(await call("POST", `/properties/${A.propertyA}/mapper/apply`, reception, { payload: { proposal: proposal("902") } }), "rooms.manage");
    assert.equal(await prisma.room.count({ where: { propertyId: A.propertyA, number: "902" } }), 0);
  });

  it("(3) 404 opaco: recepción de A sobre B y organización B sobre A; no se crea nada", async () => {
    expect404(await call("POST", `/properties/${A.propertyB}/mapper/apply`, reception, { payload: { proposal: proposal("903") } }));
    expect404(await call("POST", `/properties/${A.propertyA}/mapper/apply`, ownerB, { payload: { proposal: proposal("903") } }));
    assert.equal(await prisma.room.count({ where: { propertyId: { in: [A.propertyA, A.propertyB] }, number: "903" } }), 0);
  });
});
