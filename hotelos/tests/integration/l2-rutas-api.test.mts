/**
 * Tanda L2 · L2-02 — rutas API: retirada de 82 rutas (motor en memoria sin
 * consumidor, duplicados, backoffice en memoria), canónicas, espejos de eventos
 * e IA sobre Prisma, listas del motor paginadas, lease de schedulers y
 * GET /admin/worker/job-runs (app.inject, Postgres real).
 *
 * Dos organizaciones aisladas (helpers/l2-tenant.mts): A escribe y lee; B
 * comprueba que no ve nada. RBAC_STRICT=true, auth real, sin unión de permisos
 * de demo; el bloque de rutas retiradas se repite con RBAC_STRICT=false (guard
 * is404: un 404 nunca se convierte en 403 del manifiesto). Al terminar borra
 * las dos organizaciones y el lease de prueba; las cifras de Faranda no cambian.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-rutas-api.test.mts
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { holdsSchedulerLease } = await import("../../apps/api/src/lib/scheduler-leader.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; headers: Record<string, unknown>; raw: string };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);
const lenient = <T>(run: () => Promise<T>): Promise<T> => withEnv({ ...STRICT_ENV, RBAC_STRICT: "false" }, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH", url: string, session: Session, propertyId: string, payload?: unknown): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...session.headers, "x-property-id": propertyId }, ...(payload === undefined ? {} : { payload }) });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, unknown>, raw: res.body };
}

const asArray = (reply: Reply): Json[] => (Array.isArray(JSON.parse(reply.raw)) ? (JSON.parse(reply.raw) as Json[]) : []);
const items = (reply: Reply): Json[] => (Array.isArray(reply.body.items) ? (reply.body.items as Json[]) : []);

/** Una ruta retirada por familia (A: motor sin consumidor · B: duplicados · C: backoffice en memoria). */
const RETIRED = (propertyId: string): Array<{ method: "GET" | "POST"; url: string }> => [
  { method: "GET", url: `/advanced/properties/${propertyId}/modules/workforce_labor/health` },
  { method: "GET", url: `/revenue/properties/${propertyId}/dashboard` },
  { method: "GET", url: `/revenue/properties/${propertyId}/automation-rules` },
  { method: "GET", url: "/crm/profiles" },
  { method: "GET", url: `/inventory/properties/${propertyId}/items` },
  { method: "POST", url: "/guest-portal/session/tok_l2/check-in" },
  { method: "GET", url: `/analytics/properties/${propertyId}/dashboard` },
  { method: "GET", url: "/developer/webhooks" },
  { method: "GET", url: "/ai-governance/policies" },
  { method: "POST", url: "/revenue/recommendations/rec_l2/approve" },
  { method: "GET", url: `/properties/${propertyId}/ses-hospedajes/submissions` },
  { method: "GET", url: `/backoffice/properties/${propertyId}/qr-codes` }
];

/** Usuario extra con plantilla `manager` (revenue.apply_recommendations); cuelga de la organización → cleanupTenant lo barre. */
async function addManager(tenant: IsolatedTenant): Promise<{ id: string; email: string }> {
  const id = `usr_l2r_manager_${tenant.run}`;
  const email = `manager.l2r.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2R manager ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles.manager;
  if (!roleId) throw new Error(`Sin rol de plantilla «manager» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId: tenant.propertyA, organizationId: tenant.organizationId, reason: `l2-rutas manager` } });
  resetRbacScopeCacheForTests();
  return { id, email };
}

describe("L2-02 · rutas API: retiradas, canónicas, espejos Prisma, lease y job-runs", () => {
  let app: ApiApp;
  let A: IsolatedTenant;
  let B: IsolatedTenant;
  let owner: Session; // organización A (audit.read, guest_register.read, workforce.read)
  let ownerB: Session; // organización B
  let manager: Session; // plantilla manager en A (revenue.apply_recommendations)
  let receptionist: Session; // solo A (workforce.timeclock.use)
  /** Tanda RRHH (RRHH-4): los fichajes exigen ficha (StaffProfile) — la de la recepcionista en A.propertyA; cuelga de la propiedad → cleanupTenant la barre. */
  let receptionistProfileId = "";
  let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
  const leaseKey = `l2-test-${newRunId()}`;

  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    A = await createIsolatedTenant(`r${newRunId()}`);
    B = await createIsolatedTenant(`s${newRunId()}`);
    await enableModules(A.propertyA, ["workforce_labor", "revenue_profit_engine"]);
    receptionistProfileId = `sp_l2r_rec_${A.run}`;
    await prisma.staffProfile.create({ data: { id: receptionistProfileId, userId: A.users.receptionist.id, propertyId: A.propertyA, employeeCode: "REC-001", active: true } });
    const managerUser = await addManager(A);
    await strict(async () => {
      owner = await loginOrThrow(app, A.users.owner.email, A.password);
      ownerB = await loginOrThrow(app, B.users.owner.email, B.password);
      manager = await loginOrThrow(app, managerUser.email, A.password);
      receptionist = await loginOrThrow(app, A.users.receptionist.email, A.password);
    });
  });

  after(async () => {
    try {
      await prisma.schedulerLease.deleteMany({ where: { key: leaseKey } });
      if (A) await cleanupTenant(A.organizationId);
      if (B) await cleanupTenant(B.organizationId);
    } finally {
      await app?.close();
    }
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
    assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
    assert.equal(await prisma.schedulerLease.count({ where: { key: leaseKey } }), 0, "sin lease residual de esta suite");
  });

  it("las 82 rutas retiradas responden 404 «Not Found» (una por familia) con RBAC_STRICT=true y false", async () => {
    for (const [label, env] of [["strict", strict], ["lenient", lenient]] as const) {
      await env(async () => {
        for (const route of RETIRED(A.propertyA)) {
          const reply = await call(app, route.method, route.url, owner, A.propertyA, route.method === "POST" ? {} : undefined);
          assert.equal(reply.status, 404, `${label} ${route.method} ${route.url} → ${reply.status} ${reply.raw.slice(0, 200)}`);
          assert.equal(reply.body.error, "Not Found", `${label} ${route.method} ${route.url}: ${reply.raw.slice(0, 200)}`);
        }
      });
    }
  });

  it("las canónicas siguen: reject de recomendación con ámbito por path (404 opaco) y GET /properties/:id/ses/submissions 200", async () => {
    await strict(async () => {
      const reject = await call(app, "POST", `/revenue/properties/${A.propertyA}/recommendations/rec_l2_missing/reject`, manager, A.propertyA, {});
      assert.ok([200, 404].includes(reject.status), `reject → ${reject.status} ${reject.raw.slice(0, 200)}`);
      if (reject.status === 404) assert.doesNotMatch(String(reject.body.message), /rec_l2_missing/, "el 404 no revela el id");
      const ses = await call(app, "GET", `/properties/${A.propertyA}/ses/submissions`, owner, A.propertyA);
      assert.equal(ses.status, 200, `ses/submissions → ${ses.status} ${ses.raw.slice(0, 200)}`);
      assert.ok(Array.isArray(JSON.parse(ses.raw)), "array pelado por defecto");
      assert.equal(ses.headers["x-total-count"], "0");
    });
  });

  it("GET /ai/tool-calls lee ai_tool_calls de la organización del llamante: filas de A, [] para B, envelope con nextCursor", async () => {
    const created = await Promise.all(
      [1, 2].map((n) =>
        prisma.aiToolCall.create({
          data: { organizationId: A.organizationId, propertyId: A.propertyA, userId: A.users.owner.id, toolName: `l2.tool.${n}`, inputJson: { n }, status: "executed", createdAt: new Date(Date.now() - (3 - n) * 1000) },
          select: { id: true }
        })
      )
    );
    await strict(async () => {
      const list = await call(app, "GET", "/ai/tool-calls", owner, A.propertyA);
      assert.equal(list.status, 200, list.raw.slice(0, 200));
      const rows = asArray(list);
      assert.deepEqual(rows.map((row) => row.id), [created[1]!.id, created[0]!.id], "createdAt desc, solo la organización A");
      assert.equal(typeof rows[0]!.createdAt, "string", "Date → ISO");
      assert.equal(list.headers["x-total-count"], "2");

      const page1 = await call(app, "GET", "/ai/tool-calls?envelope=1&limit=1", owner, A.propertyA);
      assert.equal(page1.status, 200, page1.raw.slice(0, 200));
      assert.equal(items(page1).length, 1);
      assert.equal(page1.body.total, 2);
      assert.equal(typeof page1.body.nextCursor, "string", "nextCursor con más filas");
      const page2 = await call(app, "GET", `/ai/tool-calls?limit=1&cursor=${encodeURIComponent(String(page1.body.nextCursor))}`, owner, A.propertyA);
      assert.equal(page2.status, 200, page2.raw.slice(0, 200));
      assert.deepEqual(items(page2).map((row) => row.id), [created[0]!.id]);
      assert.equal(page2.body.nextCursor, null);

      const scoped = await call(app, "GET", `/ai/tool-calls?propertyId=${A.propertyA}`, owner, A.propertyA);
      assert.equal(asArray(scoped).length, 2, "filtro por propiedad en ámbito");
      const foreign = await call(app, "GET", `/ai/tool-calls?propertyId=${B.propertyA}`, owner, A.propertyA);
      assert.equal(foreign.status, 404, `propiedad de otra organización → 404 opaco (${foreign.status} ${foreign.raw.slice(0, 120)})`);

      const other = await call(app, "GET", "/ai/tool-calls", ownerB, B.propertyA);
      assert.equal(other.status, 200, other.raw.slice(0, 200));
      assert.deepEqual(asArray(other), [], "la organización B no ve las filas de A");
    });
  });

  it("GET /events lee event_stream (keyset createdAt + eventId, id = eventId): filas de A, [] para B, envelope con nextCursor", async () => {
    const created = await Promise.all(
      [1, 2].map((n) =>
        prisma.eventStream.create({
          data: {
            organizationId: A.organizationId,
            propertyId: A.propertyA,
            entityType: "l2_test",
            entityId: `ent_${n}`,
            eventType: "L2TestEvent",
            payload: { n },
            actorType: "system",
            correlationId: `corr_l2_${A.run}`,
            currentHash: `hash_l2_${A.run}_${n}`,
            createdAt: new Date(Date.now() - (3 - n) * 1000)
          },
          select: { eventId: true }
        })
      )
    );
    await strict(async () => {
      const list = await call(app, "GET", "/events", owner, A.propertyA);
      assert.equal(list.status, 200, list.raw.slice(0, 200));
      const rows = asArray(list);
      assert.deepEqual(rows.map((row) => row.eventId), [created[1]!.eventId, created[0]!.eventId]);
      assert.deepEqual(rows.map((row) => row.id), rows.map((row) => row.eventId), "id = eventId");
      assert.equal(list.headers["x-total-count"], "2");

      const page1 = await call(app, "GET", "/events?envelope=1&limit=1", owner, A.propertyA);
      assert.equal(items(page1).length, 1);
      assert.equal(typeof page1.body.nextCursor, "string");
      const page2 = await call(app, "GET", `/events?limit=1&cursor=${encodeURIComponent(String(page1.body.nextCursor))}`, owner, A.propertyA);
      assert.deepEqual(items(page2).map((row) => row.eventId), [created[0]!.eventId]);
      assert.equal(page2.body.nextCursor, null);

      const malformed = await call(app, "GET", "/events?cursor=not-a-cursor", owner, A.propertyA);
      assert.equal(malformed.status, 400);

      const other = await call(app, "GET", "/events", ownerB, B.propertyA);
      assert.equal(other.status, 200, other.raw.slice(0, 200));
      assert.deepEqual(asArray(other), [], "la organización B no ve los eventos de A");
    });
  });

  it("una lista del motor con ?limit=1 devuelve el envelope con items de 1 y un nextCursor válido", async () => {
    await strict(async () => {
      for (const n of [1, 2]) {
        const clockIn = await call(app, "POST", "/workforce/time-clock/clock-in", receptionist, A.propertyA, {
          propertyId: A.propertyA,
          staffProfileId: receptionistProfileId,
          action: "in",
          at: new Date(Date.now() - (3 - n) * 1000).toISOString()
        });
        assert.ok([200, 201].includes(clockIn.status), `clock-in ${n} → ${clockIn.status} ${clockIn.raw.slice(0, 200)}`);
      }
      const page1 = await call(app, "GET", `/workforce/properties/${A.propertyA}/time-clock?limit=1`, owner, A.propertyA);
      assert.equal(page1.status, 200, page1.raw.slice(0, 200));
      assert.equal(page1.body.propertyId, A.propertyA);
      assert.equal(page1.body.moduleCode, "workforce_labor");
      assert.equal(page1.body.recordType, "time_clock_entries");
      assert.equal(items(page1).length, 1);
      assert.equal(page1.body.total, 2);
      assert.equal(typeof page1.body.nextCursor, "string");
      assert.equal(page1.headers["x-total-count"], "2");
      assert.equal(page1.headers["x-next-cursor"], page1.body.nextCursor);
      const page2 = await call(app, "GET", `/workforce/properties/${A.propertyA}/time-clock?limit=1&cursor=${encodeURIComponent(String(page1.body.nextCursor))}`, owner, A.propertyA);
      assert.equal(page2.status, 200, page2.raw.slice(0, 200));
      assert.equal(items(page2).length, 1);
      assert.notEqual(items(page2)[0]!.id, items(page1)[0]!.id, "la segunda página no repite la primera");
      assert.equal(page2.body.nextCursor, null);
    });
  });

  it("holdsSchedulerLease: con dos holderId solo uno la tiene; el otro la toma al expirar el ttl", async () => {
    const ttlMs = 300;
    assert.equal(await holdsSchedulerLease(leaseKey, ttlMs, "l2-holder-1"), true, "el primero adquiere");
    assert.equal(await holdsSchedulerLease(leaseKey, ttlMs, "l2-holder-2"), false, "el segundo no mientras vive el lease");
    assert.equal(await holdsSchedulerLease(leaseKey, ttlMs, "l2-holder-1"), true, "el titular renueva");
    await sleep(ttlMs + 150);
    assert.equal(await holdsSchedulerLease(leaseKey, ttlMs, "l2-holder-2"), true, "expirado → el segundo adquiere");
    assert.equal(await holdsSchedulerLease(leaseKey, ttlMs, "l2-holder-1"), false, "y el primero deja de tenerlo");
    const row = await prisma.schedulerLease.findUnique({ where: { key: leaseKey } });
    assert.equal(row?.holderId, "l2-holder-2");
  });

  it("GET /admin/worker/job-runs es solo de plataforma: 403 para un usuario de organización", async () => {
    await strict(async () => {
      const reply = await call(app, "GET", "/admin/worker/job-runs", owner, A.propertyA);
      assert.equal(reply.status, 403, `${reply.status} ${reply.raw.slice(0, 200)}`);
      const gm = await call(app, "GET", "/admin/worker/job-runs?limit=5", ownerB, B.propertyA);
      assert.equal(gm.status, 403);
    });
  });
});
