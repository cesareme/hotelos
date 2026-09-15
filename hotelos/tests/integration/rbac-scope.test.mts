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
const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" };
const DEMO_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "true", NODE_ENV: "development" };
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
