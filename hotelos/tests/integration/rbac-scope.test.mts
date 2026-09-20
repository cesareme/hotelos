/**
 * RBAC × property scope × module conflicts — REAL HTTP via app.inject
 * (Tanda 5 · L1c · fix:api). Boots the API in-process (buildApiServer, no
 * network listen) against the shared Postgres and exercises, with REAL
 * sessions, the fixes of the L1c api lot:
 *   · a receptionist of one property (user_property_roles) gets an opaque
 *     404 on the reservations / properties of a sister property of the same
 *     organization (lib/tenancy.ts grantPropertyAccess);
 *   · the receptionist template opens the module list, the invoices and the
 *     SES settings (modules.read / invoice.read / guest_register.read) and is
 *     refused on payroll, bank accounts and commissions (dedicated read keys
 *     instead of analytics.read);
 *   · enabling a module with missing dependencies is a 409 in Spanish (no
 *     state change), an empty or malformed PATCH body is a 400 in Spanish;
 *   · an unknown AI tool name is a 404, not a 500.
 *
 * The limited session comes from INTEGRATION_RECEPTION_EMAIL /
 * INTEGRATION_RECEPTION_PASSWORD (a user whose roles cover a strict subset
 * of its organization's properties, e.g. recepcion.tilos@faranda.test in the
 * demo DB); without them those cases skip loudly. The platform-admin session
 * is the demo super-user (INTEGRATION_LOGIN_EMAIL / _PASSWORD override).
 * Run with: corepack pnpm test:integration
 */
import "./helpers/load-env.mts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { buildApiServer } = await import("../../apps/api/src/server.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Session = { token: string; headers: Headers };
type Profile = {
  organizationId: string;
  activePropertyId: string;
  isPlatformAdmin: boolean;
  grantedPermissions: string[];
  properties: Array<{ id: string; organizationId: string }>;
};

async function login(app: ApiApp, email: string, password: string, deviceId: string): Promise<Session | null> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId } });
  if (res.statusCode !== 200) return null;
  const token = (JSON.parse(res.body) as { token: string }).token;
  return { token, headers: { Authorization: `Bearer ${token}` } };
}

async function getJson<T>(app: ApiApp, url: string, headers: Headers): Promise<{ status: number; body: T | null; text: string }> {
  const res = await app.inject({ method: "GET", url, headers });
  let body: T | null = null;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body };
}

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// The repo .env (HOTELOS_ALLOW_DEMO_AUTH=true, NODE_ENV=development) lands in
// this process and enables the dev/demo permission UNION (auth.service.ts
// unionPermissions: every real session also holds the demoStore baseline).
// The union is read per request, so the cases that prove REAL grants pin the
// strict setting for their duration; the union case pins demo mode.
// Tanda 8a (RBAC · L1): the union has its own switch (HOTELOS_DEMO_PERMISSION_UNION); NODE_ENV and the auth fallback flag no longer enable it.
const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production", HOTELOS_DEMO_PERMISSION_UNION: "false" };
const DEMO_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development", HOTELOS_DEMO_PERMISSION_UNION: "true" };
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  return run().finally(() => applyEnv(previous));
}

let app: ApiApp;
let admin: Session | null = null;
let reception: Session | null = null;
let receptionProfile: Profile | null = null;
let adminProfile: Profile | null = null;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  admin = await login(
    app,
    process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com",
    process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo",
    "integration-rbac-scope-admin"
  );
  if (admin) adminProfile = (await getJson<Profile>(app, "/users/me", admin.headers)).body;
  const email = process.env.INTEGRATION_RECEPTION_EMAIL;
  const password = process.env.INTEGRATION_RECEPTION_PASSWORD;
  if (email && password) {
    reception = await login(app, email, password, "integration-rbac-scope-reception");
    if (reception) receptionProfile = (await getJson<Profile>(app, "/users/me", reception.headers)).body;
  }
});

after(async () => {
  await app.close();
});

const NO_RECEPTION = "INTEGRATION_RECEPTION_EMAIL / _PASSWORD not set or login failed — limited-session cases not exercised";

describe("L1c · property scope inside the organization (lib/tenancy.ts)", () => {
  it("a receptionist with a role in ONE property gets an opaque 404 on a sister property of the same organization", async (t) => {
    if (!reception || !receptionProfile) return t.skip(NO_RECEPTION);
    if (!admin || !adminProfile?.isPlatformAdmin) return t.skip("platform-admin session unavailable to discover the sister property");
    const own = receptionProfile.activePropertyId;
    const assigned = new Set(receptionProfile.properties.map((property) => property.id));
    // Sister property: same organization, no role for the receptionist. Discovered through the admin (every property).
    const all = (await getJson<Array<{ id: string; organizationId: string }>>(app, "/properties", admin.headers)).body ?? [];
    const sister = all.find((property) => property.organizationId === receptionProfile!.organizationId && !assigned.has(property.id));
    if (!sister) return t.skip("the receptionist holds roles in every property of its organization — nothing to isolate");

    const ownList = await getJson<unknown>(app, `/properties/${own}/reservations`, reception.headers);
    assert.equal(ownList.status, 200, `own property must stay readable: ${ownList.text.slice(0, 160)}`);

    const foreignList = await getJson<{ message?: string }>(app, `/properties/${sister.id}/reservations`, reception.headers);
    assert.equal(foreignList.status, 404, `sister property must be an opaque 404: ${foreignList.text.slice(0, 160)}`);
    assert.equal(foreignList.body?.message, "Propiedad no encontrada.");
    assert.ok(!foreignList.text.includes(sister.id), "the 404 never echoes the property id");

    // By-id routes of rows hanging from the sister property: same opaque 404 as a missing id.
    const sisterReservations = (await getJson<Array<{ id: string }> | { items: Array<{ id: string }> }>(app, `/properties/${sister.id}/reservations`, admin.headers)).body;
    const rows = Array.isArray(sisterReservations) ? sisterReservations : (sisterReservations?.items ?? []);
    if (rows.length === 0) return t.diagnostic("sister property has no reservations — by-id half not exercised");
    const byId = await getJson<{ message?: string }>(app, `/reservations/${rows[0].id}`, reception.headers);
    assert.equal(byId.status, 404, byId.text.slice(0, 160));
    assert.equal(byId.body?.message, "Reserva no encontrada.");
    const missing = await getJson<{ message?: string }>(app, "/reservations/no-existe", reception.headers);
    assert.equal(missing.status, 404);
    assert.equal(missing.body?.message, byId.body?.message, "foreign and missing ids share the same neutral message");
  });

  it("a platform admin keeps its reach over every property (re-pointed organization, no property assignment needed)", async (t) => {
    if (!admin || !adminProfile?.isPlatformAdmin) return t.skip("platform-admin session unavailable");
    const all = (await getJson<Array<{ id: string }>>(app, "/properties", admin.headers)).body ?? [];
    assert.ok(all.length >= 1);
    for (const property of all.slice(0, 3)) {
      const res = await getJson<unknown>(app, `/properties/${property.id}/room-types`, admin.headers);
      assert.equal(res.status, 200, `${property.id}: ${res.text.slice(0, 120)}`);
    }
  });
});

describe("L1c · read keys of the receptionist template (modules, invoices, SES settings) and least privilege on finance", () => {
  it("opens the module list (modules.read), the invoices (invoice.read) and the SES settings (guest_register.read) with REAL grants only", async (t) => {
    if (!reception || !receptionProfile) return t.skip(NO_RECEPTION);
    const property = receptionProfile.activePropertyId;
    for (const key of ["modules.read", "invoice.read", "incidents.read", "events.read"]) {
      assert.ok(receptionProfile.grantedPermissions.includes(key), `${key} must be a REAL grant of the receptionist role (rbac:sync applied)`);
    }
    await withEnv(STRICT_ENV, async () => {
      for (const url of [
        `/backoffice/properties/${property}/modules`,
        `/properties/${property}/invoices`,
        `/compliance/spain/properties/${property}/guest-register/settings`,
        `/properties/${property}/event-spaces`
      ]) {
        const res = await getJson<unknown>(app, url, reception!.headers);
        assert.equal(res.status, 200, `${url}: ${res.text.slice(0, 160)}`);
      }
      const modules = (await getJson<Array<{ code: string; status: string }>>(app, `/backoffice/properties/${property}/modules`, reception!.headers)).body ?? [];
      assert.ok(modules.some((module) => module.code === "pms_core" && module.status === "enabled"), "the list carries the enabled modules the menu needs");
    });
  });

  it("is refused (403, Spanish) on payroll, bank accounts and commissions — no longer open through analytics.read", async (t) => {
    if (!reception || !receptionProfile) return t.skip(NO_RECEPTION);
    await withEnv(STRICT_ENV, async () => {
      for (const [url, key] of [
        ["/payroll/contracts", "payroll.read"],
        ["/banking/accounts", "banking.read"],
        ["/commissions/rules", "commissions.read"]
      ] as const) {
        const res = await getJson<{ message?: string }>(app, url, reception!.headers);
        assert.equal(res.status, 403, `${url}: ${res.text.slice(0, 160)}`);
        assert.match(res.body?.message ?? "", new RegExp(`requiere: ${key.replace(".", "\\.")}`));
      }
      // The fiscal calendar (accounting.read) stays readable: the compliance inbox warns about closing periods.
      const periods = await getJson<unknown>(app, `/accounting/fiscal-periods?propertyId=${receptionProfile!.activePropertyId}`, reception!.headers);
      assert.equal(periods.status, 200, periods.text.slice(0, 160));
    });
  });

  it("the demo union (dev/demo mode) never adds the platform key to a real session: a non-platform user is refused on /admin/tenants", async (t) => {
    if (!reception || !receptionProfile) return t.skip(NO_RECEPTION);
    assert.equal(receptionProfile.isPlatformAdmin, false);
    await withEnv(DEMO_ENV, async () => {
      // The union is active: an org key of the baseline the role lacks passes…
      const unioned = await getJson<unknown>(app, "/payroll/contracts", reception!.headers);
      assert.equal(unioned.status, 200, `union expected in demo mode: ${unioned.text.slice(0, 120)}`);
      // …but the platform key never does.
      const res = await getJson<{ message?: string }>(app, "/admin/tenants", reception!.headers);
      assert.equal(res.status, 403, res.text.slice(0, 160));
    });
  });
});

describe("L1c · module state PATCH: 409 on missing dependencies, 400 on empty or malformed bodies (Spanish)", () => {
  it("enabling a module whose dependencies are not active answers 409 with the module names and changes nothing", async (t) => {
    if (!admin || !adminProfile?.isPlatformAdmin) return t.skip("platform-admin session unavailable");
    const all = (await getJson<Array<{ id: string }>>(app, "/properties", admin.headers)).body ?? [];
    type ModuleRow = { code: string; status: string; dependencies: string[]; name: string };
    let target: { propertyId: string; module: ModuleRow; missing: string[] } | null = null;
    for (const property of all) {
      const modules = (await getJson<ModuleRow[]>(app, `/backoffice/properties/${property.id}/modules`, admin.headers)).body ?? [];
      const enabled = new Set(modules.filter((module) => module.status === "enabled").map((module) => module.code));
      const candidate = modules.find((module) => module.status !== "enabled" && module.dependencies.some((dependency) => !enabled.has(dependency)));
      if (candidate) {
        target = { propertyId: property.id, module: candidate, missing: candidate.dependencies.filter((dependency) => !enabled.has(dependency)) };
        break;
      }
    }
    if (!target) return t.skip("no property has a disabled module with a missing dependency");
    const url = `/backoffice/properties/${target.propertyId}/modules/${target.module.code}`;
    const res = await app.inject({ method: "PATCH", url, headers: admin.headers, payload: { action: "enable" } });
    assert.equal(res.statusCode, 409, res.body.slice(0, 200));
    const body = JSON.parse(res.body) as { message: string; details?: { code?: string; missingDependencies?: string[] } };
    assert.match(body.message, /^No se puede activar .+: falta activar .+\.$/);
    assert.equal(body.details?.code, "MODULE_DEPENDENCIES_MISSING");
    assert.deepEqual(body.details?.missingDependencies, target.missing);
    const after = (await getJson<ModuleRow[]>(app, `/backoffice/properties/${target.propertyId}/modules`, admin.headers)).body ?? [];
    assert.equal(after.find((module) => module.code === target!.module.code)?.status, target.module.status, "state unchanged after the 409");
  });

  it("an empty JSON body, a `{}` body and an unknown field are 400 in Spanish; a missing body too", async (t) => {
    if (!admin || !adminProfile) return t.skip("admin session unavailable");
    const property = adminProfile.activePropertyId;
    const url = `/backoffice/properties/${property}/modules/outlet_pos`;
    const emptyJson = await app.inject({ method: "PATCH", url, headers: { ...admin.headers, "content-type": "application/json" }, payload: "" });
    assert.equal(emptyJson.statusCode, 400, emptyJson.body);
    assert.equal(JSON.parse(emptyJson.body).message, "El cuerpo de la petición debe ser un objeto JSON.");
    const noBody = await app.inject({ method: "PATCH", url, headers: admin.headers });
    assert.equal(noBody.statusCode, 400, noBody.body);
    assert.equal(JSON.parse(noBody.body).message, "El cuerpo de la petición debe ser un objeto JSON.");
    const emptyObject = await app.inject({ method: "PATCH", url, headers: admin.headers, payload: {} });
    assert.equal(emptyObject.statusCode, 400, emptyObject.body);
    assert.match(JSON.parse(emptyObject.body).message, /^Sin cambios que aplicar/);
    const unknownField = await app.inject({ method: "PATCH", url, headers: admin.headers, payload: { action: "enable", extra: true } });
    assert.equal(unknownField.statusCode, 400, unknownField.body);
    const badAction = await app.inject({ method: "PATCH", url, headers: admin.headers, payload: { action: "toggle" } });
    assert.equal(badAction.statusCode, 400, badAction.body);
    assert.match(JSON.parse(badAction.body).message, /action debe ser enable o disable/);
    const invalidJson = await app.inject({ method: "PATCH", url, headers: { ...admin.headers, "content-type": "application/json" }, payload: "{not json" });
    assert.equal(invalidJson.statusCode, 400, invalidJson.body);
    assert.equal(JSON.parse(invalidJson.body).message, "El cuerpo de la petición no es JSON válido.");
  });
});

describe("L1c · AI tool registry: unknown tool name is a 404, not a 500", () => {
  it("GET /ai-operations/tools/:toolName with an unknown name answers 404 «Herramienta no encontrada.»", async (t) => {
    if (!admin) return t.skip("admin session unavailable");
    const res = await getJson<{ message?: string }>(app, "/ai-operations/tools/no-existe", admin.headers);
    assert.equal(res.status, 404, res.text.slice(0, 160));
    assert.equal(res.body?.message, "Herramienta no encontrada.");
    assert.ok(!res.text.includes("no-existe"), "the message never echoes the requested name");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tanda 8a · L1 · motor de acceso: ámbito por petición, asignaciones,
// aprobaciones, break glass y auditoría — organización AISLADA `org_rbac_<run>`
// (sociedad + propiedades A y B, roles de plantilla, usuarios ficticios con
// contraseña y sesiones reales por POST /auth/login; limpieza en `after`).
// Sin variables de entorno: todo se siembra aquí. Run with:
//   cd apps/api && node --import tsx --test ../../tests/integration/rbac-scope.test.mts
// ═════════════════════════════════════════════════════════════════════════════
const { prisma } = await import("@hotelos/database");
const { hashPassword } = await import("@hotelos/database");
const { syncPermissionCatalog, provisionDefaultTemplateRoles, ensureBreakGlassRole } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const RBAC_ORG = `org_rbac_${RUN}`;
const RBAC_LE = `le_rbac_${RUN}`;
const RBAC_A = `prop_rbac_a_${RUN}`;
const RBAC_B = `prop_rbac_b_${RUN}`;
const RBAC_PASSWORD = "Rbac-Test-2026!";
const RBAC_USERS = {
  u1: { id: `usr_rbac_u1_${RUN}`, email: `recepcion.a.${RUN}@faranda.test`, fullName: "Recepción A" },
  u2: { id: `usr_rbac_u2_${RUN}`, email: `recepcion.contabilidad.${RUN}@faranda.test`, fullName: "Recepción A + Contabilidad B" },
  u3: { id: `usr_rbac_u3_${RUN}`, email: `sin.asignaciones.${RUN}@faranda.test`, fullName: "Sin asignaciones" },
  u4: { id: `usr_rbac_u4_${RUN}`, email: `direccion.a.${RUN}@faranda.test`, fullName: "Dirección de hotel A" },
  u5: { id: `usr_rbac_u5_${RUN}`, email: `direccion.general.${RUN}@faranda.test`, fullName: "Dirección general" },
  emergency: { id: `usr_rbac_bg_${RUN}`, email: `emergencia-1@rbac-${RUN}.test`, fullName: "Emergencia 1" }
} as const;
type RbacUserKey = keyof typeof RBAC_USERS;

const rbacRoles: Record<string, string> = {};
const rbacSessions: Partial<Record<RbacUserKey, Session>> = {};
let rbacReservationB = "";
let rbacSeeded = false;
let rbacSeedError: string | null = null;

type ErrorBody = { statusCode?: number; message?: string; details?: { code?: string; [k: string]: unknown } };

async function inject(method: "GET" | "POST" | "DELETE", url: string, session: Session, payload?: unknown, extraHeaders: Headers = {}): Promise<{ status: number; body: ErrorBody & Record<string, unknown>; text: string }> {
  const res = await app.inject({ method, url, headers: { ...session.headers, ...extraHeaders }, ...(payload !== undefined ? { payload } : {}) });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body: body as ErrorBody & Record<string, unknown>, text: res.body };
}

async function rbacCleanup(): Promise<void> {
  const userIds = Object.values(RBAC_USERS).map((user) => user.id);
  const roleIds = (await prisma.role.findMany({ where: { organizationId: RBAC_ORG }, select: { id: true } })).map((row) => row.id);
  await prisma.approvalRequest.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.supervisorAuthorization.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.breakGlassSession.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.userRoleAssignment.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.userPropertyRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.mfaChallenge.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { organizationId: RBAC_ORG } });
  if (roleIds.length > 0) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
  await prisma.roleThreshold.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.role.deleteMany({ where: { organizationId: RBAC_ORG } });
  const groups = await prisma.propertyGroup.findMany({ where: { organizationId: RBAC_ORG }, select: { id: true } });
  if (groups.length > 0) await prisma.propertyGroupMember.deleteMany({ where: { propertyGroupId: { in: groups.map((group) => group.id) } } });
  await prisma.propertyGroup.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.reservation.deleteMany({ where: { propertyId: { in: [RBAC_A, RBAC_B] } } });
  await prisma.property.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: RBAC_ORG } });
  await prisma.organization.deleteMany({ where: { id: RBAC_ORG } });
}

async function assign(userKey: RbacUserKey, templateKey: string, scope: { scopeType: "property" | "organization"; propertyId?: string }): Promise<void> {
  await prisma.userRoleAssignment.create({
    data: {
      userId: RBAC_USERS[userKey].id,
      roleId: rbacRoles[templateKey],
      scopeType: scope.scopeType,
      propertyId: scope.propertyId ?? null,
      organizationId: RBAC_ORG,
      reason: "seed rbac-scope test"
    }
  });
}

before(async () => {
  try {
    await syncPermissionCatalog();
    await prisma.organization.create({ data: { id: RBAC_ORG, name: `[rbac-scope test] ${RUN}`, country: "ES" } });
    await prisma.legalEntity.create({ data: { id: RBAC_LE, organizationId: RBAC_ORG, code: "RBT", legalName: `RBAC Test ${RUN} SL`, isDefault: true } });
    for (const [id, name] of [[RBAC_A, "Hotel RBAC A"], [RBAC_B, "Hotel RBAC B"]] as const) {
      await prisma.property.create({ data: { id, organizationId: RBAC_ORG, name: `${name} ${RUN}`, timezone: "Europe/Madrid", country: "ES", taxRegion: "ES_PENINSULA_BALEARES", legalEntityId: RBAC_LE, kind: "hotel" } });
    }
    for (const role of await provisionDefaultTemplateRoles(RBAC_ORG)) rbacRoles[role.templateKey] = role.id;
    rbacRoles.break_glass = (await ensureBreakGlassRole(RBAC_ORG)).id;
    for (const [key, user] of Object.entries(RBAC_USERS) as Array<[RbacUserKey, (typeof RBAC_USERS)[RbacUserKey]]>) {
      await prisma.user.create({
        data: { id: user.id, organizationId: RBAC_ORG, email: user.email, fullName: user.fullName, status: key === "emergency" ? "emergency" : "active", passwordHash: key === "emergency" ? null : hashPassword(RBAC_PASSWORD), mustChangePassword: false, passwordChangedAt: new Date() }
      });
    }
    await assign("u1", "receptionist", { scopeType: "property", propertyId: RBAC_A });
    await assign("u2", "receptionist", { scopeType: "property", propertyId: RBAC_A });
    await assign("u2", "accountant", { scopeType: "property", propertyId: RBAC_B });
    await assign("u4", "manager", { scopeType: "property", propertyId: RBAC_A });
    await assign("u5", "general_manager", { scopeType: "organization" });
    const reservation = await prisma.reservation.create({
      data: { propertyId: RBAC_B, code: `RBAC-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date("2031-05-04T00:00:00Z"), departureDate: new Date("2031-05-06T00:00:00Z") },
      select: { id: true }
    });
    rbacReservationB = reservation.id;
    resetRbacScopeCacheForTests();
    for (const key of ["u1", "u2", "u3", "u4", "u5"] as const) {
      const session = await login(app, RBAC_USERS[key].email, RBAC_PASSWORD, `integration-rbac-${key}`);
      if (!session) throw new Error(`login failed for ${key}`);
      rbacSessions[key] = session;
    }
    rbacSeeded = true;
  } catch (error) {
    rbacSeedError = error instanceof Error ? error.message : String(error);
    console.error(`[rbac-scope test] seeding the isolated organisation failed, Tanda 8a cases will fail: ${rbacSeedError}`);
  }
});

after(async () => {
  try {
    await flushAuditQueues();
    await rbacCleanup();
  } finally {
    await prisma.$disconnect();
  }
});

const s = (key: RbacUserKey): Session => {
  const session = rbacSessions[key];
  assert.ok(session, `session of ${key} unavailable${rbacSeedError ? ` (${rbacSeedError})` : ""}`);
  return session;
};

describe("Tanda 8a · L1 · ámbito por petición (org_rbac aislada)", () => {
  it("U1 receptionist in A: 200 in A, opaque 404 in B, x-property-id=B → 404 + ACCESS_DENIED out_of_scope, /users/me lists A with its real grants", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u1 = s("u1");
    const own = await inject("GET", `/properties/${RBAC_A}/reservations`, u1);
    assert.equal(own.status, 200, own.text.slice(0, 200));
    const sister = await inject("GET", `/properties/${RBAC_B}/reservations`, u1);
    assert.equal(sister.status, 404, sister.text.slice(0, 200));
    assert.equal(sister.body.message, "Propiedad no encontrada.");
    assert.ok(!sister.text.includes(RBAC_B), "the 404 never echoes the property id");
    const header = await inject("GET", "/users/me/properties", u1, undefined, { "x-property-id": RBAC_B });
    assert.equal(header.status, 404, header.text.slice(0, 200));
    assert.equal(header.body.message, "Propiedad no encontrada.");
    await flushAuditQueues();
    const denied = await prisma.auditEvent.findMany({ where: { organizationId: RBAC_ORG, action: "ACCESS_DENIED", actorUserId: RBAC_USERS.u1.id } });
    const outOfScope = denied.filter((row) => (row.afterJson as { reason?: string } | null)?.reason === "out_of_scope");
    // One row per route: the param 404 on B and the header 404 on the switcher.
    assert.deepEqual(outOfScope.map((row) => row.entityId).sort(), ["GET /properties/:propertyId/reservations", "GET /users/me/properties"]);
    assert.ok(outOfScope.every((row) => (row.afterJson as { resolvedFrom?: string }).resolvedFrom !== undefined && row.ipAddress));
    const me = await inject("GET", "/users/me", u1);
    assert.equal(me.status, 200, me.text.slice(0, 200));
    const profile = me.body as unknown as { properties: Array<{ id: string; grantedPermissions: string[]; templateKeys: string[] }>; scopes: Array<{ scopeType: string; ref: string }>; orgScope: boolean; grantedPermissions: string[] };
    assert.deepEqual(profile.properties.map((property) => property.id), [RBAC_A]);
    assert.deepEqual(profile.properties[0].templateKeys, ["receptionist"]);
    assert.ok(profile.properties[0].grantedPermissions.includes("pms.reservation.read"));
    assert.equal(profile.properties[0].grantedPermissions.includes("accounting.journal.post"), false);
    assert.deepEqual(profile.scopes, [{ scopeType: "property", ref: RBAC_A, propertyIds: [RBAC_A] }]);
    assert.equal(profile.orgScope, false);
    const switcher = await inject("GET", "/users/me/properties", u1);
    assert.deepEqual((switcher.body as unknown as Array<{ id: string }>).map((property) => property.id), [RBAC_A], "the switcher only lists covered properties");
  });

  it("U2 receptionist in A + accountant in B: reads payables in B, cannot create reservations in B, can in A; an entity of B with header A is evaluated with the keys of B", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u2 = s("u2");
    const bills = await inject("GET", `/properties/${RBAC_B}/payables/supplier-bills`, u2);
    assert.equal(bills.status, 200, bills.text.slice(0, 200));
    const createInB = await inject("POST", `/properties/${RBAC_B}/reservations`, u2, { arrivalDate: "2031-06-01", departureDate: "2031-06-03" });
    assert.equal(createInB.status, 403, createInB.text.slice(0, 200));
    assert.match(createInB.body.message ?? "", /pms\.reservation\.create/);
    const createInA = await inject("POST", `/properties/${RBAC_A}/reservations`, u2, { arrivalDate: "2031-06-01", departureDate: "2031-06-03" });
    assert.ok(![401, 403, 404].includes(createInA.status), `the gate must pass in A (got ${createInA.status}: ${createInA.text.slice(0, 160)})`);
    // The gate evaluated the receptionist keys of A (header), the entity hangs from B: the service sees the accountant keys of B → 403.
    const cancel = await inject("POST", `/reservations/${rbacReservationB}/cancel`, u2, { reason: "prueba" }, { "x-property-id": RBAC_A });
    assert.equal(cancel.status, 403, cancel.text.slice(0, 200));
    assert.match(cancel.body.message ?? "", /pms\.reservation\.modify/);
    const still = await prisma.reservation.findUnique({ where: { id: rbacReservationB }, select: { status: true } });
    assert.equal(still?.status, "confirmed", "nothing was cancelled");
    const me = await inject("GET", "/users/me", u2);
    const profile = me.body as unknown as { properties: Array<{ id: string; templateKeys: string[] }> };
    assert.deepEqual(profile.properties.map((property) => [property.id, property.templateKeys.join(",")]).sort(), [[RBAC_A, "receptionist"], [RBAC_B, "accountant"]].sort());
  });

  it("U3 without assignments: opaque 404 on every property, /users/me with properties = [] and an empty switcher", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u3 = s("u3");
    for (const property of [RBAC_A, RBAC_B]) {
      const res = await inject("GET", `/properties/${property}/reservations`, u3);
      assert.equal(res.status, 404, res.text.slice(0, 200));
      assert.equal(res.body.message, "Propiedad no encontrada.");
    }
    const me = await inject("GET", "/users/me", u3);
    assert.equal(me.status, 200, me.text.slice(0, 200));
    assert.deepEqual((me.body as unknown as { properties: unknown[] }).properties, []);
    assert.deepEqual((me.body as unknown as { grantedPermissions: string[] }).grantedPermissions, []);
    const switcher = await inject("GET", "/users/me/properties", u3);
    assert.deepEqual(switcher.body, []);
  });
});

describe("Tanda 8a · L1 · aprobaciones, asignaciones, break glass y auditoría de denegaciones", () => {
  it("two-step approval: U1 requests a 400 € refund (pending, T3), cannot approve it (409 APPROVAL_SELF_DECISION); U4 (hotel director of A) approves", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u1 = s("u1");
    const u4 = s("u4");
    const created = await inject("POST", "/approvals", u1, { kind: "refund", entityType: "payment", entityId: `pay_${RUN}`, propertyId: RBAC_A, amount: "400.00", reasonCode: "guest_complaint" });
    assert.equal(created.status, 201, created.text.slice(0, 200));
    assert.equal(created.body.status, "pending");
    assert.equal(created.body.thresholdTier, "T3");
    const id = created.body.id as string;
    const self = await inject("POST", `/approvals/${id}/approve`, u1, {});
    assert.equal(self.status, 409, self.text.slice(0, 200));
    assert.equal(self.body.details?.code, "APPROVAL_SELF_DECISION");
    const inbox = await inject("GET", "/approvals?status=pending", u4);
    assert.ok((inbox.body as unknown as Array<{ id: string }>).some((row) => row.id === id), "the director sees the pending request of A");
    const approved = await inject("POST", `/approvals/${id}/approve`, u4, { note: "ok" });
    assert.equal(approved.status, 200, approved.text.slice(0, 200));
    assert.equal(approved.body.status, "approved");
    assert.equal(approved.body.decidedByUserId, RBAC_USERS.u4.id);
  });

  it("assignments by U4 (manager in A): a higher level → 403 RBAC_LEVEL_EXCEEDED, another property → 403 RBAC_SCOPE_EXCEEDED, break_glass → 404, a SoD combination → 409, a valid one → 201", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u4 = s("u4");
    const level = await inject("POST", "/rbac/assignments", u4, { userId: RBAC_USERS.u3.id, roleId: rbacRoles.controller, scopeType: "property", scopeRef: RBAC_A });
    assert.equal(level.status, 403, level.text.slice(0, 200));
    assert.equal(level.body.details?.code, "RBAC_LEVEL_EXCEEDED");
    const scope = await inject("POST", "/rbac/assignments", u4, { userId: RBAC_USERS.u1.id, roleId: rbacRoles.receptionist, scopeType: "property", scopeRef: RBAC_B });
    assert.equal(scope.status, 403, scope.text.slice(0, 200));
    assert.equal(scope.body.details?.code, "RBAC_SCOPE_EXCEEDED");
    const emergency = await inject("POST", "/rbac/assignments", u4, { userId: RBAC_USERS.u3.id, roleId: rbacRoles.break_glass, scopeType: "property", scopeRef: RBAC_A });
    assert.equal(emergency.status, 404, emergency.text.slice(0, 200));
    assert.ok(!emergency.text.includes("break_glass"), "the emergency template never leaks");
    // receptionist (payment.capture) + front_office_manager (payments.refund_approve) in the same property.
    const sod = await inject("POST", "/rbac/assignments", u4, { userId: RBAC_USERS.u1.id, roleId: rbacRoles.front_office_manager, scopeType: "property", scopeRef: RBAC_A });
    assert.equal(sod.status, 409, sod.text.slice(0, 200));
    assert.equal(sod.body.details?.code, "RBAC_SOD_CONFLICT");
    const ok = await inject("POST", "/rbac/assignments", u4, { userId: RBAC_USERS.u3.id, roleId: rbacRoles.housekeeper, scopeType: "property", scopeRef: RBAC_A, reason: "alta de pisos" });
    assert.equal(ok.status, 201, ok.text.slice(0, 200));
    assert.equal(ok.body.templateKey, "housekeeper");
    await flushAuditQueues();
    const assigned = await prisma.auditEvent.findFirst({ where: { organizationId: RBAC_ORG, action: "ROLE_ASSIGNED", entityId: ok.body.id as string } });
    assert.ok(assigned, "ROLE_ASSIGNED audited");
    // U3 now reaches A on the next request (rbac_version bumped → scope re-read).
    const u3 = s("u3");
    const board = await inject("GET", `/properties/${RBAC_A}/reservations`, u3);
    assert.notEqual(board.status, 404, board.text.slice(0, 200));
    const revoked = await inject("DELETE", `/rbac/assignments/${ok.body.id as string}?reason=fin%20de%20prueba`, u4);
    assert.equal(revoked.status, 200, revoked.text.slice(0, 200));
    assert.ok(revoked.body.revokedAt);
    const afterRevoke = await inject("GET", `/properties/${RBAC_A}/reservations`, u3);
    assert.equal(afterRevoke.status, 404, "the revocation applies on the next request");
  });

  it("break glass: open without password → 403 BREAK_GLASS_REAUTH_REQUIRED; with password → session with every organisation key; that session cannot assign; listed; closed → 401", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u5 = s("u5");
    const refused = await inject("POST", "/rbac/break-glass", u5, { reason: "Caída del PMS", confirmHighRisk: true });
    assert.equal(refused.status, 403, refused.text.slice(0, 200));
    assert.equal(refused.body.details?.code, "BREAK_GLASS_REAUTH_REQUIRED");
    const opened = await inject("POST", "/rbac/break-glass", u5, { reason: "Caída del PMS", ticket: `INC-${RUN}`, password: RBAC_PASSWORD, confirmHighRisk: true });
    assert.equal(opened.status, 201, opened.text.slice(0, 300));
    const session = opened.body.session as { id: string; accountUserId: string; closesAt: string };
    assert.equal(session.accountUserId, RBAC_USERS.emergency.id);
    const emergency: Session = { token: opened.body.token as string, headers: { Authorization: `Bearer ${opened.body.token as string}` } };
    const me = await inject("GET", "/users/me", emergency);
    assert.equal(me.status, 200, me.text.slice(0, 200));
    const profile = me.body as unknown as { grantedPermissions: string[]; breakGlassSessionId: string | null; orgScope: boolean };
    assert.ok(profile.grantedPermissions.length >= 200, `the emergency session holds every organisation key (got ${profile.grantedPermissions.length})`);
    assert.equal(profile.grantedPermissions.includes("admin.tenants.manage"), false, "never a platform key");
    assert.equal(profile.breakGlassSessionId, session.id);
    assert.equal(profile.orgScope, true);
    const forbidden = await inject("POST", "/rbac/assignments", emergency, { userId: RBAC_USERS.u3.id, roleId: rbacRoles.receptionist, scopeType: "property", scopeRef: RBAC_A });
    assert.equal(forbidden.status, 403, forbidden.text.slice(0, 200));
    assert.equal(forbidden.body.details?.code, "RBAC_BREAK_GLASS_FORBIDDEN");
    const listed = await inject("GET", "/rbac/break-glass", u5);
    assert.equal(listed.status, 200, listed.text.slice(0, 200));
    assert.ok((listed.body as unknown as Array<{ id: string }>).some((row) => row.id === session.id));
    const closed = await inject("POST", `/rbac/break-glass/${session.id}/close`, u5, {});
    assert.equal(closed.status, 200, closed.text.slice(0, 200));
    assert.ok(closed.body.closedAt);
    const dead = await inject("GET", "/users/me", emergency);
    assert.equal(dead.status, 401, dead.text.slice(0, 200));
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: RBAC_ORG, entityType: "break_glass_session", entityId: session.id }, select: { action: true } });
    assert.deepEqual(events.map((event) => event.action).sort(), ["BREAK_GLASS_CLOSED", "BREAK_GLASS_OPENED"]);
  });

  it("a provoked 403 leaves ONE ACCESS_DENIED row per user, route and minute, with the missing keys", async () => {
    assert.ok(rbacSeeded, rbacSeedError ?? "seed failed");
    const u1 = s("u1");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await inject("POST", "/rbac/assignments", u1, { userId: RBAC_USERS.u3.id, roleId: rbacRoles.receptionist, scopeType: "property", scopeRef: RBAC_A });
      assert.equal(res.status, 403, res.text.slice(0, 200));
    }
    await flushAuditQueues();
    const denied = await prisma.auditEvent.findMany({ where: { organizationId: RBAC_ORG, action: "ACCESS_DENIED", actorUserId: RBAC_USERS.u1.id, entityId: "POST /rbac/assignments" } });
    assert.equal(denied.length, 1, `one row per minute expected, got ${denied.length}`);
    const after = denied[0].afterJson as { missing?: string[]; riskLevel?: string; scopeType?: string | null };
    assert.deepEqual(after.missing, ["users.assign"]);
    assert.equal(after.riskLevel, "high");
    assert.ok(denied[0].ipAddress, "the IP is recorded");
    const log = await inject("GET", "/rbac/access-log?action=ACCESS_DENIED", s("u5"));
    assert.equal(log.status, 200, log.text.slice(0, 200));
    const items = (log.body as unknown as { items: Array<{ entityId: string | null; required?: string[] }> }).items;
    const row = items.find((item) => item.entityId === "POST /rbac/assignments");
    assert.ok(row, "the access log serves the denial");
    assert.deepEqual(row.required, ["users.assign"], "the decision is recomputed for the route");
  });
});
