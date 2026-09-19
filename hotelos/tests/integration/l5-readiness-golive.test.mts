/**
 * Tanda L5 · lote L5-C · readiness recalculado en el GET, go-live que escribe
 * estado y completa el paso, bulk PATCH de habitaciones con vocabulario cerrado —
 * integración sobre Postgres real con una organización AISLADA
 * (helpers/l2-tenant.mts) y STRICT_ENV (auth real, sin unión de permisos de demo,
 * RBAC_STRICT=true). Faranda y org_123 solo se leen (invariantes).
 *
 * Usuarios (matriz RBAC T8a, packages/shared/src/permissions.ts):
 *   · generalManager (hotel A): property.go_live + property.configure +
 *     backoffice.access + property.map.manage → GET readiness, POST recalculate,
 *     POST go-live y PATCH rooms/bulk;
 *   · receptionist (hotel A): ninguna de las tres claves → 403;
 *   · owner (organización): solo backoffice.access → puede leer el readiness.
 *
 * Casos: GET sin filas → 17 comprobaciones calculadas y persistidas (sin auditar) ·
 * segundo GET dentro de la ventana → mismo computedAt y CERO upserts · POST recalculate
 * → audit PropertyReadinessRecalculated y computedAt nuevo · go-live bloqueado → no
 * escribe go_live_at ni completa el paso · completar las bloqueantes reales del tenant
 * (edificio, usuario asignado, impuestos provisionados) → go-live approved: go_live_at,
 * paso `go_live` completed, audit + evento PropertyGoLiveApproved · repetición →
 * alreadyLive sin evento nuevo · GET readiness / setup con goLiveAt · 403 de recepción ·
 * bulk PATCH: «foo» → 400 en español, «inspected» sobre sucia → 409 ROOM_NOT_CLEAN,
 * «dirty» sobre limpia → 200 + ROOM_STATE_CHANGED, «blocked» → 400 «orden de trabajo».
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l5-readiness-golive.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { ensurePropertyTaxes } = await import("../../apps/api/src/lib/tenant-hydration.js");
const { invalidateTaxCache } = await import("../../apps/api/src/modules/accounting/tax-rate.service.js");
const { READINESS_MAX_AGE_MS } = await import("../../apps/api/src/modules/backoffice/readiness-freshness.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `g${newRunId()}`;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const READINESS_CHECK_COUNT = 17;
const SETUP_STEP_COUNT = 15;

let app: ApiApp;
let A: IsolatedTenant;
/** Dirección general (general_manager) asignada al hotel A. */
let gm: Session;
/** Recepción del hotel A: sin backoffice.access, property.configure ni property.go_live. */
let reception: Session;
/** Propiedad (owner, organización): solo backoffice.access. */
let owner: Session;
let invariantsBefore: { invoices: number; verifactuSubmissions: number; reservations: number };
let room101 = "";
let room102 = "";
/** computedAt del primer GET, comparado por los casos siguientes. */
let firstComputedAt = "";
/** go_live_at escrito por la aprobación. */
let approvedGoLiveAt = "";

const base = () => `/backoffice/properties/${A.propertyA}`;

async function call(method: Method, url: string, session: Session | null, payload?: unknown): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), "x-property-id": A.propertyA },
      ...(payload !== undefined ? { payload } : {})
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

async function auditCount(action: string, entityId: string): Promise<number> {
  await flushAuditQueues();
  return prisma.auditEvent.count({ where: { action, entityId, propertyId: A.propertyA } });
}

async function domainCount(eventType: string, entityId: string): Promise<number> {
  await flushAuditQueues();
  return prisma.eventStream.count({ where: { eventType, entityId, propertyId: A.propertyA } });
}

async function goLiveAtInDb(): Promise<Date | null> {
  return (await prisma.property.findUniqueOrThrow({ where: { id: A.propertyA }, select: { goLiveAt: true } })).goLiveAt;
}

async function goLiveStep(): Promise<{ status: string; completedAt: Date | null; completedBy: string | null } | null> {
  const row = await prisma.propertySetupStep.findUnique({
    where: { propertyId_stepCode: { propertyId: A.propertyA, stepCode: "go_live" } },
    select: { status: true, completedAt: true, completedBy: true }
  });
  return row;
}

/** Cuenta los upserts de property_readiness_checks que provoca `run` (misma técnica que l2-robustez countPrismaOps). */
async function countReadinessUpserts<T>(run: () => Promise<T>): Promise<{ result: T; upserts: number }> {
  const delegate = prisma.propertyReadinessCheck as unknown as Record<string, unknown>;
  const original = delegate.upsert as (...args: unknown[]) => unknown;
  let upserts = 0;
  delegate.upsert = function (this: unknown, ...args: unknown[]) {
    upserts += 1;
    return original.apply(this, args);
  };
  try {
    const result = await run();
    return { result, upserts };
  } finally {
    delegate.upsert = original;
  }
}

async function roomState(roomId: string): Promise<{ status: string; housekeepingStatus: string; maintenanceStatus: string }> {
  const row = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, select: { status: true, housekeepingStatus: true, maintenanceStatus: true } });
  return { status: String(row.status), housekeepingStatus: row.housekeepingStatus, maintenanceStatus: row.maintenanceStatus };
}

before(async () => {
  const all = await farandaInvariants();
  invariantsBefore = { invoices: all.invoices, verifactuSubmissions: all.verifactuSubmissions, reservations: all.reservations };
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  // El helper siembra maintenanceStatus "operational" (anterior al vocabulario cerrado).
  await prisma.room.updateMany({ where: { propertyId: A.propertyA }, data: { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true } });
  const rooms = await prisma.room.findMany({ where: { propertyId: A.propertyA }, select: { id: true, number: true }, orderBy: { number: "asc" } });
  room101 = rooms.find((r) => r.number === "101")?.id ?? "";
  room102 = rooms.find((r) => r.number === "102")?.id ?? "";
  assert.ok(room101 && room102, "habitaciones 101 y 102 del hotel A");
  await withEnv(STRICT_ENV, async () => {
    gm = await loginOrThrow(app, A.users.generalManager.email, A.password, "l5-c-gm");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l5-c-reception");
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l5-c-owner");
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
// readiness en el GET
// ---------------------------------------------------------------------------

describe("GET /backoffice/properties/:id/readiness calcula en vivo", () => {
  it("sin filas → 17 comprobaciones calculadas, persistidas y sin auditar; computedAt ISO; goLiveAt null", async () => {
    assert.equal(await prisma.propertyReadinessCheck.count({ where: { propertyId: A.propertyA } }), 0, "sin filas antes del primer GET");
    const reply = await call("GET", `${base()}/readiness`, gm);
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.propertyId, A.propertyA);
    assert.equal(reply.body.checks.length, READINESS_CHECK_COUNT);
    assert.equal(reply.body.status, "blocked", "un hotel recién creado tiene comprobaciones bloqueantes");
    assert.ok(reply.body.blockingCount > 0, JSON.stringify(reply.body.checks.map((c: any) => [c.checkCode, c.status])));
    assert.match(String(reply.body.computedAt), ISO_RE);
    assert.equal(reply.body.goLiveAt, null);
    firstComputedAt = reply.body.computedAt;
    assert.equal(await prisma.propertyReadinessCheck.count({ where: { propertyId: A.propertyA } }), READINESS_CHECK_COUNT, "las 17 filas quedan persistidas");
    assert.equal(await auditCount("PropertyReadinessRecalculated", A.propertyA), 0, "el GET no audita");
    const codes = new Set(reply.body.checks.map((c: any) => c.checkCode));
    for (const code of ["issuer_legal_name_set", "issuer_tax_id_valid", "default_building_exists", "admin_user_exists", "tax_region_configured", "platform_certificate_notice"]) {
      assert.ok(codes.has(code), `falta la comprobación ${code}`);
    }
  });

  it("segundo GET dentro de la ventana → mismo computedAt y cero upserts (owner solo con backoffice.access)", async () => {
    const { result, upserts } = await countReadinessUpserts(() => call("GET", `${base()}/readiness`, owner));
    assert.equal(result.status, 200, result.raw.slice(0, 400));
    assert.equal(result.body.computedAt, firstComputedAt, "dentro de la ventana no se recalcula");
    assert.equal(upserts, 0, "sin upserts en property_readiness_checks");
    assert.equal(result.body.checks.length, READINESS_CHECK_COUNT);
    assert.ok(READINESS_MAX_AGE_MS >= 60_000, "la ventana cubre de sobra los dos GET de esta suite");
  });

  it("POST …/readiness/recalculate → audita PropertyReadinessRecalculated y cambia computedAt", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = await call("POST", `${base()}/readiness/recalculate`, gm, {});
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.checks.length, READINESS_CHECK_COUNT);
    assert.match(String(reply.body.computedAt), ISO_RE);
    assert.ok(new Date(reply.body.computedAt).getTime() > new Date(firstComputedAt).getTime(), `computedAt nuevo: ${reply.body.computedAt} > ${firstComputedAt}`);
    assert.equal(await auditCount("PropertyReadinessRecalculated", A.propertyA), 1);
    assert.equal(await prisma.propertyReadinessCheck.count({ where: { propertyId: A.propertyA } }), READINESS_CHECK_COUNT, "sigue habiendo 17 filas (upsert, no duplicados)");
  });

  it("recepción → 403 en readiness, recalculate y go-live", async () => {
    expect403(await call("GET", `${base()}/readiness`, reception), "backoffice.access");
    expect403(await call("POST", `${base()}/readiness/recalculate`, reception, {}), "property.configure");
    expect403(await call("POST", `${base()}/go-live`, reception, {}), "property.go_live");
    assert.equal(await goLiveAtInDb(), null);
  });

  it("owner (sin property.go_live) → 403 en go-live", async () => {
    expect403(await call("POST", `${base()}/go-live`, owner, {}), "property.go_live");
  });
});

// ---------------------------------------------------------------------------
// go-live
// ---------------------------------------------------------------------------

describe("POST /backoffice/properties/:id/go-live", () => {
  it("bloqueado → status blocked, no escribe go_live_at ni completa el paso, sin evento PropertyGoLiveApproved", async () => {
    const reply = await call("POST", `${base()}/go-live`, gm, {});
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.status, "blocked");
    assert.ok(Array.isArray(reply.body.blockers) && reply.body.blockers.length > 0);
    assert.equal(reply.body.goLiveAt, null);
    assert.equal(await goLiveAtInDb(), null);
    assert.equal(await auditCount("PropertyGoLiveApproved", A.propertyA), 0);
    assert.equal(await domainCount("PropertyGoLiveApproved", A.propertyA), 0);
    // La decisión se toma sobre comprobaciones recién calculadas y auditadas.
    assert.equal(await auditCount("PropertyReadinessRecalculated", A.propertyA), 2);

    const setup = await call("GET", `${base()}/setup`, gm);
    assert.equal(setup.status, 200, setup.raw.slice(0, 300));
    assert.equal(setup.body.total, SETUP_STEP_COUNT);
    assert.equal(setup.body.live, false);
    assert.equal(setup.body.goLiveAt, null);
    assert.equal(setup.body.steps.find((step: any) => step.stepCode === "go_live")?.status, "not_started");
    assert.equal((await goLiveStep())?.status, "not_started");
  });

  it("completar las comprobaciones bloqueantes reales → approved: go_live_at, paso go_live completed, audit + evento", async () => {
    // Bloqueantes de un hotel del helper: edificio activo, usuario asignado al
    // establecimiento (espejo user_property_roles que escribe writeRoleAssignment
    // en el flujo real) e impuestos provisionados en la base de datos.
    await prisma.building.create({ data: { propertyId: A.propertyA, name: "Edificio principal", code: "PRINCIPAL", active: true } });
    await prisma.userPropertyRole.create({ data: { userId: A.users.generalManager.id, propertyId: A.propertyA, roleId: A.roles.general_manager } });
    await ensurePropertyTaxes({ propertyId: A.propertyA });
    invalidateTaxCache(A.propertyA);

    const recalculated = await call("POST", `${base()}/readiness/recalculate`, gm, {});
    assert.equal(recalculated.status, 200, recalculated.raw.slice(0, 400));
    const remaining = recalculated.body.checks.filter((c: any) => c.severity === "blocking" && c.status !== "pass");
    assert.deepEqual(
      remaining.map((c: any) => `${c.checkCode}: ${c.message}`),
      [],
      "no queda ninguna comprobación bloqueante"
    );
    assert.equal(recalculated.body.status, "ready");

    const reply = await call("POST", `${base()}/go-live`, gm, {});
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.status, "approved");
    assert.equal(reply.body.alreadyLive, false);
    assert.equal(reply.body.propertyId, A.propertyA);
    assert.match(String(reply.body.goLiveAt), ISO_RE);
    assert.equal(reply.body.approvedAt, reply.body.goLiveAt);
    assert.equal(reply.body.step?.stepCode, "go_live");
    assert.equal(reply.body.step?.status, "completed");
    assert.equal(reply.body.step?.completedBy, gm.userId);
    approvedGoLiveAt = reply.body.goLiveAt;

    const inDb = await goLiveAtInDb();
    assert.ok(inDb, "properties.go_live_at escrito");
    assert.equal(inDb.toISOString(), approvedGoLiveAt);
    const step = await goLiveStep();
    assert.equal(step?.status, "completed");
    assert.equal(step?.completedAt?.toISOString(), approvedGoLiveAt);
    assert.equal(step?.completedBy, gm.userId);

    assert.equal(await auditCount("PropertyGoLiveApproved", A.propertyA), 1);
    const audit = await prisma.auditEvent.findFirst({ where: { action: "PropertyGoLiveApproved", entityId: A.propertyA, propertyId: A.propertyA }, select: { afterJson: true, actorUserId: true } });
    assert.equal((audit?.afterJson as any)?.goLiveAt, approvedGoLiveAt, "afterJson.goLiveAt");
    assert.equal(audit?.actorUserId, gm.userId);
    assert.equal(await domainCount("PropertyGoLiveApproved", A.propertyA), 1);
  });

  it("segundo POST → alreadyLive con la misma fecha y sin evento nuevo", async () => {
    const reply = await call("POST", `${base()}/go-live`, gm, {});
    assert.equal(reply.status, 200, reply.raw.slice(0, 400));
    assert.equal(reply.body.status, "approved");
    assert.equal(reply.body.alreadyLive, true);
    assert.equal(reply.body.goLiveAt, approvedGoLiveAt);
    assert.equal(reply.body.approvedAt, approvedGoLiveAt);
    assert.equal(reply.body.step?.status, "completed");
    assert.equal((await goLiveAtInDb())?.toISOString(), approvedGoLiveAt, "go_live_at no se reescribe");
    assert.equal(await auditCount("PropertyGoLiveApproved", A.propertyA), 1, "sin segundo evento de auditoría");
    assert.equal(await domainCount("PropertyGoLiveApproved", A.propertyA), 1, "sin segundo evento de dominio");
  });

  it("GET readiness y GET setup informan goLiveAt / live", async () => {
    const readiness = await call("GET", `${base()}/readiness`, gm);
    assert.equal(readiness.status, 200, readiness.raw.slice(0, 300));
    assert.equal(readiness.body.goLiveAt, approvedGoLiveAt);
    assert.equal(readiness.body.status, "ready");
    const setup = await call("GET", `${base()}/setup`, gm);
    assert.equal(setup.status, 200, setup.raw.slice(0, 300));
    assert.equal(setup.body.live, true);
    assert.equal(setup.body.goLiveAt, approvedGoLiveAt);
    assert.equal(setup.body.total, SETUP_STEP_COUNT);
    assert.ok(setup.body.completed >= 1);
    assert.equal(setup.body.steps.find((step: any) => step.stepCode === "go_live")?.status, "completed");
  });
});

// ---------------------------------------------------------------------------
// bulk PATCH de habitaciones (encargo de L5-A en backoffice.service.ts)
// ---------------------------------------------------------------------------

describe("PATCH /backoffice/properties/:id/rooms/bulk · estado con vocabulario cerrado", () => {
  it("housekeepingStatus «foo» → 400 en español y sin escribir", async () => {
    const reply = await call("PATCH", `${base()}/rooms/bulk`, gm, { roomIds: [room101], patch: { housekeepingStatus: "foo" } });
    assert.equal(reply.status, 400, reply.raw.slice(0, 300));
    assert.match(String(reply.body?.message), /Estado de limpieza no válido: usa dirty, clean, inspected/);
    assert.deepEqual(await roomState(room101), { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok" });
  });

  it("housekeepingStatus «dirty» sobre una limpia → 200 por la transición unificada y audita ROOM_STATE_CHANGED", async () => {
    const reply = await call("PATCH", `${base()}/rooms/bulk`, gm, { roomIds: [room101], patch: { housekeepingStatus: "dirty" } });
    assert.equal(reply.status, 200, reply.raw.slice(0, 300));
    assert.equal(reply.body.updatedCount, 1);
    assert.equal(reply.body.rooms[0].housekeepingStatus, "dirty");
    assert.deepEqual(await roomState(room101), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok" });
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { action: "ROOM_STATE_CHANGED", entityType: "room", entityId: room101 }, select: { afterJson: true } });
    assert.equal(events.length, 1, "un ROOM_STATE_CHANGED por la transición");
    assert.equal((events[0].afterJson as any)?.event, "mark_dirty");
    assert.equal(await prisma.auditEvent.count({ where: { action: "RoomBulkUpdated", propertyId: A.propertyA } }), 1);
  });

  it("housekeepingStatus «inspected» sobre una sucia → 409 ROOM_NOT_CLEAN sin escribir", async () => {
    const reply = await call("PATCH", `${base()}/rooms/bulk`, gm, { roomIds: [room101, room102], patch: { housekeepingStatus: "inspected" } });
    assert.equal(reply.status, 409, reply.raw.slice(0, 300));
    assert.equal(reply.body?.details?.code, "ROOM_NOT_CLEAN");
    assert.deepEqual(reply.body?.details?.roomIds, [room101]);
    assert.deepEqual(await roomState(room101), { status: "dirty", housekeepingStatus: "dirty", maintenanceStatus: "ok" });
    assert.deepEqual(await roomState(room102), { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok" }, "la limpia del lote no se toca cuando el lote falla");
  });

  it("maintenanceStatus «blocked» → 400 «usa una orden de trabajo»; «bar» → 400; «needs_attention» → 200", async () => {
    const blocked = await call("PATCH", `${base()}/rooms/bulk`, gm, { roomIds: [room102], patch: { maintenanceStatus: "blocked" } });
    assert.equal(blocked.status, 400, blocked.raw.slice(0, 300));
    assert.match(String(blocked.body?.message), /usa una orden de trabajo/);
    const bar = await call("PATCH", `${base()}/rooms/bulk`, gm, { roomIds: [room102], patch: { maintenanceStatus: "bar" } });
    assert.equal(bar.status, 400, bar.raw.slice(0, 300));
    assert.match(String(bar.body?.message), /Estado de mantenimiento no válido: usa ok o needs_attention/);
    const attention = await call("PATCH", `${base()}/rooms/bulk`, gm, { roomIds: [room102], patch: { maintenanceStatus: "needs_attention" } });
    assert.equal(attention.status, 200, attention.raw.slice(0, 300));
    assert.deepEqual(await roomState(room102), { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "needs_attention" });
  });

  it("recepción (sin property.map.manage) → 403", async () => {
    expect403(await call("PATCH", `${base()}/rooms/bulk`, reception, { roomIds: [room102], patch: { housekeepingStatus: "clean" } }), "property.map.manage");
  });
});
