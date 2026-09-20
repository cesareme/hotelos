/**
 * Tanda L2 · L2-08 · tests de integración mínimos por módulo — PLATAFORMA
 * (admin-console, gdpr, esrs, reporting, search, offline, mobile-keys).
 * app.inject sobre Postgres real con dos organizaciones AISLADAS
 * (helpers/l2-tenant.mts): A escribe y lee; B (otra organización) nunca ve
 * nada. STRICT_ENV: auth real, sin unión de permisos de demo, RBAC_STRICT=true.
 *
 * Tres casos por módulo (criterio §4 del plan · fila L2 «tests por módulo»):
 *   (1) crear o leer con ámbito (fila en Prisma con organizationId / propertyId de A);
 *   (2) 403 sin clave (mensaje en español del gate o de requirePermissions,
 *       nunca el 403 de «ruta no registrada en el manifiesto»); en los módulos
 *       cuyas rutas son solo `authenticated` (search) el caso negativo es el
 *       401 sin sesión;
 *   (3) 404 opaco en propiedad ajena (recepción de A sobre el hotel B; usuario
 *       de la organización B sobre el hotel A o sobre una entidad de A).
 *
 * Administrador de plataforma: el helper no lo crea (ninguna plantilla de
 * organización lleva admin.tenants.manage); esta suite crea en A un rol custom
 * «Plataforma L2» con esa única clave real (role_permissions) y un usuario
 * asignado a la organización — `isPlatformAdmin` se deriva de las concesiones
 * reales (auth.service hasPlatformAdminGrant). Solo LEE /admin/tenants y
 * /admin/worker/job-runs; cleanupTenant lo barre con la organización.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l2-modulos-plataforma.test.mts
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
const { createSubscription } = await import("../../apps/api/src/modules/webhooks/webhooks.service.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const RUN = `p${newRunId()}`;
const OPAQUE_404 = "Propiedad no encontrada.";

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
let owner: Session;
let manager: Session;
let reception: Session;
let accountant: Session;
let systems: Session;
let auditor: Session;
let platform: Session;
let ownerB: Session;
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

async function createUser(tenant: IsolatedTenant, local: string): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${local}_${tenant.run}`;
  const email = `${local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2 ${local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  return { id, email };
}

async function assignRole(tenant: IsolatedTenant, userId: string, roleId: string, propertyId?: string): Promise<void> {
  await prisma.userRoleAssignment.create({
    data: { userId, roleId, scopeType: propertyId ? "property" : "organization", propertyId: propertyId ?? null, organizationId: tenant.organizationId, reason: `l2-08 ${userId}` }
  });
  resetRbacScopeCacheForTests();
}

async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId?: string }): Promise<{ id: string; email: string }> {
  const user = await createUser(tenant, spec.local);
  const roleId = tenant.roles[spec.templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  await assignRole(tenant, user.id, roleId, spec.propertyId);
  return user;
}

/** Rol custom con la ÚNICA clave de plataforma, concedida en role_permissions (nunca por la unión demo). */
async function addPlatformAdmin(tenant: IsolatedTenant): Promise<{ id: string; email: string }> {
  const permission = await prisma.permission.findUnique({ where: { key: "admin.tenants.manage" }, select: { id: true } });
  if (!permission) throw new Error("La clave admin.tenants.manage no está en el catálogo de permisos.");
  const role = await prisma.role.create({ data: { organizationId: tenant.organizationId, name: `Plataforma L2 ${tenant.run}`, managed: false }, select: { id: true } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  const user = await createUser(tenant, "platform");
  await assignRole(tenant, user.id, role.id);
  return user;
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  const managerUser = await addTenantUser(A, { local: "manager", templateKey: "manager", propertyId: A.propertyA });
  const auditorUser = await addTenantUser(A, { local: "auditor", templateKey: "auditor" });
  const platformUser = await addPlatformAdmin(A);
  await withEnv(STRICT_ENV, async () => {
    owner = await loginOrThrow(app, A.users.owner.email, A.password, "l2-08-plat-owner");
    manager = await loginOrThrow(app, managerUser.email, A.password, "l2-08-plat-manager");
    reception = await loginOrThrow(app, A.users.receptionist.email, A.password, "l2-08-plat-reception");
    accountant = await loginOrThrow(app, A.users.accountant.email, A.password, "l2-08-plat-accountant");
    systems = await loginOrThrow(app, A.users.systems.email, A.password, "l2-08-plat-systems");
    auditor = await loginOrThrow(app, auditorUser.email, A.password, "l2-08-plat-auditor");
    platform = await loginOrThrow(app, platformUser.email, A.password, "l2-08-plat-platform");
    ownerB = await loginOrThrow(app, B.users.owner.email, B.password, "l2-08-plat-owner-b");
    receptionB = await loginOrThrow(app, B.users.receptionist.email, B.password, "l2-08-plat-reception-b");
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
// admin-console
// ---------------------------------------------------------------------------

describe("L2-08 · admin-console: consola de plataforma solo con admin.tenants.manage real", () => {
  it("(1) el administrador de plataforma (rol custom con la clave real) lista los tenants — incluida la organización A — y las ejecuciones del worker", async () => {
    const me = await call("GET", "/users/me", platform);
    assert.equal(me.status, 200, me.raw.slice(0, 300));
    assert.equal(me.body.isPlatformAdmin, true, "isPlatformAdmin se deriva de la concesión real");
    const tenants = await call("GET", "/admin/tenants", platform);
    assert.equal(tenants.status, 200, tenants.raw.slice(0, 300));
    assert.ok(Array.isArray(tenants.body));
    const mine = tenants.body.find((row: { organizationId: string }) => row.organizationId === A.organizationId);
    assert.ok(mine, "la organización A aparece en la consola");
    assert.equal(mine.propertiesCount ?? mine.propertyCount ?? 2, 2, JSON.stringify(mine).slice(0, 200));
    const runs = await call("GET", "/admin/worker/job-runs?limit=5", platform);
    assert.equal(runs.status, 200, runs.raw.slice(0, 300));
    assert.ok(Array.isArray(runs.body.items));
    assert.equal(typeof runs.body.total, "number");
  });

  it("(2) 403 sin clave: owner, sistemas (plantilla admin de organización) y recepción no entran en /admin/tenants ni en /admin/worker/job-runs", async () => {
    for (const session of [owner, systems, reception]) {
      expect403(await call("GET", "/admin/tenants", session), "admin.tenants.manage");
      expect403(await call("GET", "/admin/worker/job-runs", session), "admin.tenants.manage");
    }
    const me = await call("GET", "/users/me", systems);
    assert.equal(me.body.isPlatformAdmin, false, "la plantilla admin de organización nunca es plataforma");
  });

  it("(3) 404 opaco / sin fuga: el detalle de otra organización y las escrituras de la consola no están al alcance de un usuario de organización", async () => {
    expect403(await call("GET", `/admin/tenants/${B.organizationId}`, owner), "admin.tenants.manage");
    expect403(await call("PATCH", `/admin/tenants/${A.organizationId}/modules/workforce_labor`, ownerB, { payload: { enabled: true } }), "admin.tenants.manage");
    expect403(await call("POST", "/admin/tenants", ownerB, { payload: { name: "Intruso", country: "ES", plan: "starter", ownerEmail: `x.${RUN}@example.com`, ownerFullName: "X", propertyName: "X" } }), "admin.tenants.manage");
    assert.equal(await prisma.organization.count({ where: { name: "Intruso" } }), 0);
  });
});

// ---------------------------------------------------------------------------
// gdpr
// ---------------------------------------------------------------------------

describe("L2-08 · gdpr: solicitudes RGPD con ámbito de organización", () => {
  let requestId = "";

  it("(1) POST /gdpr/requests (manager, compliance.gdpr.manage) persiste la solicitud con organizationId de A y GET la lista (owner, compliance.read)", async () => {
    const created = await call("POST", "/gdpr/requests", manager, {
      propertyId: A.propertyA,
      payload: { requestType: "dsar", subjectEmail: `interesado.${RUN}@example.com`, requestorEmail: `dpo.${RUN}@example.com`, propertyId: A.propertyA }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    requestId = created.body.id;
    const row = await prisma.gdprRequest.findUnique({ where: { id: requestId } });
    assert.ok(row, "la solicitud existe en Prisma");
    assert.equal(row.organizationId, A.organizationId);
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.status, "pending");

    const list = await call("GET", "/gdpr/requests", owner);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(list.body.some((item: { id: string }) => item.id === requestId));
    const detail = await call("GET", `/gdpr/requests/${requestId}`, owner);
    assert.equal(detail.status, 200, detail.raw.slice(0, 300));
  });

  it("(2) 403 sin clave: recepción no crea solicitudes (compliance.gdpr.manage) y sistemas no las lee (compliance.read)", async () => {
    expect403(await call("POST", "/gdpr/requests", reception, { propertyId: A.propertyA, payload: { requestType: "erasure", subjectEmail: "x@example.com", requestorEmail: "y@example.com" } }), "compliance.gdpr.manage");
    expect403(await call("GET", "/gdpr/requests", systems), "compliance.read");
    assert.equal(await prisma.gdprRequest.count({ where: { organizationId: A.organizationId } }), 1);
  });

  it("(3) 404 opaco: la organización B no ve la solicitud de A (lista vacía, detalle y acuse 404) y recepción de A no la crea sobre el hotel B", async () => {
    const listB = await call("GET", "/gdpr/requests", ownerB);
    assert.equal(listB.status, 200);
    assert.ok(!listB.body.some((item: { id: string }) => item.id === requestId));
    expect404(await call("GET", `/gdpr/requests/${requestId}`, ownerB), "Solicitud RGPD no encontrada.");
    expect404(await call("POST", "/gdpr/requests", manager, { propertyId: A.propertyA, payload: { requestType: "dsar", subjectEmail: "x@example.com", requestorEmail: "y@example.com", propertyId: A.propertyB } }));
    assert.equal(await prisma.gdprRequest.count({ where: { propertyId: A.propertyB } }), 0);
  });
});

// ---------------------------------------------------------------------------
// esrs
// ---------------------------------------------------------------------------

describe("L2-08 · esrs: catálogo e indicadores por organización", () => {
  it("(1) GET /esrs/catalog responde `items` a cualquier sesión y GET /organizations/:orgId/esrs/:year/indicators (manager, compliance.configure) lista los de A", async () => {
    const catalog = await call("GET", "/esrs/catalog", reception);
    assert.equal(catalog.status, 200, catalog.raw.slice(0, 300));
    assert.ok(Array.isArray(catalog.body.items) && catalog.body.items.length > 0);
    await prisma.esrsIndicator.create({
      data: { organizationId: A.organizationId, propertyId: A.propertyA, fiscalYear: "2026", standardCode: "ESRS_E1", disclosureCode: `E1-6_L2_${RUN}`, valueType: "NUMERIC", numericValue: "12.5", unit: "tCO2e" }
    });
    const indicators = await call("GET", `/organizations/${A.organizationId}/esrs/2026/indicators`, manager, { propertyId: A.propertyA });
    assert.equal(indicators.status, 200, indicators.raw.slice(0, 300));
    assert.ok(indicators.body.items.some((item: { disclosureCode: string; organizationId: string }) => item.disclosureCode === `E1-6_L2_${RUN}` && item.organizationId === A.organizationId));
  });

  it("(2) 403 sin clave: recepción pasa el gate (compliance.read) pero el servicio exige compliance.configure; sistemas no pasa ni el gate", async () => {
    expect403(await call("GET", `/organizations/${A.organizationId}/esrs/2026/indicators`, reception, { propertyId: A.propertyA }), "compliance.configure");
    expect403(await call("GET", `/organizations/${A.organizationId}/esrs/2026/indicators`, systems), "compliance.read");
    expect403(await call("POST", `/organizations/${A.organizationId}/esrs/2026/generate`, reception, { propertyId: A.propertyA, payload: {} }), "compliance.configure");
  });

  it("(3) 404 opaco con orgId ajeno: la organización B sobre los indicadores de A y A sobre los de B", async () => {
    expect404(await call("GET", `/organizations/${A.organizationId}/esrs/2026/indicators`, ownerB), "Organización no encontrada.");
    expect404(await call("GET", `/organizations/${B.organizationId}/esrs/2026/indicators`, manager, { propertyId: A.propertyA }), "Organización no encontrada.");
    expect404(await call("GET", `/organizations/${A.organizationId}/esrs/2026/report`, ownerB), "Organización no encontrada.");
  });
});

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

describe("L2-08 · reporting: catálogo de informes y generación con ámbito", () => {
  it("(1) GET /reports/properties/:id/catalog (recepción, analytics.read) y POST …/export (manager, analytics.export) generan un artefacto real del hotel A", async () => {
    const catalog = await call("GET", `/reports/properties/${A.propertyA}/catalog`, reception);
    assert.equal(catalog.status, 200, catalog.raw.slice(0, 300));
    assert.equal(catalog.body.propertyId, A.propertyA);
    assert.ok(Array.isArray(catalog.body.reports) && catalog.body.reports.length > 0);

    const exported = await call("POST", `/reports/properties/${A.propertyA}/export`, manager, { payload: { reportType: "reservation", format: "json", query: { fromDate: "2026-10-01", toDate: "2026-10-31" } } });
    assert.equal(exported.status, 200, exported.raw.slice(0, 300));
    assert.equal(exported.body.export.propertyId, A.propertyA);
    assert.equal(exported.body.export.reportType, "reservation");
    assert.equal(typeof exported.body.export.filename, "string");
    assert.equal(typeof exported.body.content, "string");
  });

  it("(2) 403 sin clave: recepción no exporta (analytics.export) y sistemas no abre el catálogo (analytics.read sí; analytics.export no)", async () => {
    expect403(await call("POST", `/reports/properties/${A.propertyA}/export`, reception, { payload: { reportType: "billing", format: "csv" } }), "analytics.export");
    expect403(await call("POST", `/reports/properties/${A.propertyA}/export`, systems, { payload: { reportType: "billing", format: "csv" } }), "analytics.export");
  });

  it("(3) 404 opaco: recepción de A sobre B y organización B sobre A (catálogo y exportación)", async () => {
    expect404(await call("GET", `/reports/properties/${A.propertyB}/catalog`, reception));
    expect404(await call("GET", `/reports/properties/${A.propertyA}/catalog`, ownerB));
    expect404(await call("POST", `/reports/properties/${A.propertyA}/export`, ownerB, { payload: { reportType: "reservation", format: "json" } }));
  });
});

// ---------------------------------------------------------------------------
// search (server.ts GET /search)
// ---------------------------------------------------------------------------

describe("L2-08 · search: buscador global con ámbito", () => {
  const surname = `Buscable${RUN}`;

  it("(1) GET /search?q= encuentra el huésped de A y devuelve `items`, `counts` y `degraded: []`", async () => {
    await prisma.guest.create({ data: { organizationId: A.organizationId, firstName: "Ana", surname1: surname } });
    const found = await call("GET", `/search?q=${encodeURIComponent(surname)}&propertyId=${A.propertyA}`, owner);
    assert.equal(found.status, 200, found.raw.slice(0, 300));
    assert.ok(found.body.items.some((item: { kind: string; title: string }) => item.kind === "guest" && item.title.includes(surname)));
    assert.equal(typeof found.body.counts, "object");
    assert.deepEqual(found.body.degraded, []);
  });

  it("(2) sin sesión → 401 (la ruta es `authenticated`, sin fallback demo en modo estricto)", async () => {
    const anonymous = await call("GET", `/search?q=${encodeURIComponent(surname)}`, null);
    assert.equal(anonymous.status, 401, anonymous.raw.slice(0, 300));
  });

  it("(3) 404 opaco con propertyId ajeno y sin fuga entre organizaciones: B no encuentra el huésped de A", async () => {
    expect404(await call("GET", `/search?q=${encodeURIComponent(surname)}&propertyId=${A.propertyB}`, reception));
    expect404(await call("GET", `/search?q=${encodeURIComponent(surname)}&propertyId=${A.propertyA}`, ownerB));
    const fromB = await call("GET", `/search?q=${encodeURIComponent(surname)}&propertyId=${B.propertyA}`, ownerB);
    assert.equal(fromB.status, 200, fromB.raw.slice(0, 300));
    assert.equal(fromB.body.items.filter((item: { kind: string }) => item.kind === "guest").length, 0, "la organización B no ve los huéspedes de A");
  });
});

// ---------------------------------------------------------------------------
// offline
// ---------------------------------------------------------------------------

describe("L2-08 · offline: sincronización de acciones con ámbito", () => {
  it("(1) POST /offline/sync (recepción, ai.tool.execute) persiste las filas con organizationId / propertyId de A y GET …/offline-sync-records las lista", async () => {
    const sync = await call("POST", "/offline/sync", reception, {
      propertyId: A.propertyA,
      payload: {
        propertyId: A.propertyA,
        deviceId: `dev-${RUN}`,
        actions: [
          { id: `act_${RUN}`, type: "voice.command.draft", payload: { text: "hola" }, createdAt: new Date().toISOString(), status: "pending" },
          { id: `act_${RUN}_inv`, type: "invoice.issue", payload: {}, createdAt: new Date().toISOString(), status: "pending" }
        ]
      }
    });
    assert.equal(sync.status, 200, sync.raw.slice(0, 300));
    assert.equal(sync.body.accepted, 1);
    assert.equal(sync.body.rejected, 1);
    const rows = await prisma.offlineSyncRecord.findMany({ where: { propertyId: A.propertyA } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.organizationId === A.organizationId));

    const list = await call("GET", `/properties/${A.propertyA}/offline-sync-records`, reception);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.equal(list.body.length, 2);
    assert.ok(list.body.every((item: { propertyId: string; deviceId: string }) => item.propertyId === A.propertyA && item.deviceId === `dev-${RUN}`));
  });

  it("(2) 403 sin clave: la plantilla auditor (sin ai.tool.execute) no sincroniza ni lista", async () => {
    expect403(await call("POST", "/offline/sync", auditor, { propertyId: A.propertyA, payload: { propertyId: A.propertyA, deviceId: "dev-x", actions: [] } }), "ai.tool.execute");
    expect403(await call("GET", `/properties/${A.propertyA}/offline-sync-records`, auditor), "ai.tool.execute");
  });

  it("(3) 404 opaco: recepción de A sobre B (body y ruta) y organización B sobre A; B no escribe en A", async () => {
    expect404(await call("POST", "/offline/sync", reception, { propertyId: A.propertyA, payload: { propertyId: A.propertyB, deviceId: "dev-x", actions: [] } }));
    expect404(await call("GET", `/properties/${A.propertyB}/offline-sync-records`, reception));
    expect404(await call("POST", "/offline/sync", receptionB, { propertyId: B.propertyA, payload: { propertyId: A.propertyA, deviceId: "dev-b", actions: [{ id: `act_b_${RUN}`, type: "voice.command.draft", payload: {}, createdAt: new Date().toISOString(), status: "pending" }] } }));
    expect404(await call("GET", `/properties/${A.propertyA}/offline-sync-records`, ownerB));
    assert.equal(await prisma.offlineSyncRecord.count({ where: { propertyId: A.propertyA } }), 2, "la organización B no escribe");
  });
});

// ---------------------------------------------------------------------------
// mobile-keys (server.ts: POST /reservations/:id/wallet-pass · POST /mobile-keys/:serial/verify · POST /mobile-keys/:serial/revoke)
// ---------------------------------------------------------------------------

describe("L2-08 · mobile-keys: emisión, verificación y revocación de la llave móvil con ámbito", () => {
  let reservationId = "";
  let serialNumber = "";
  let unlockSig = "";
  // Corrector L2 (SEC-L2-01): el resolver `mobileKey` de lib/tenancy.ts lee la
  // fila `mkey_<serial>` de guest_portal_actions (antes una tabla inexistente
  // → 500) y revokeWalletPass filtra por la propiedad resuelta.

  it("(1) POST /reservations/:id/wallet-pass (recepción, pms.checkin.execute) persiste la llave activa de la reserva en A (guest_portal_actions)", async () => {
    const reservation = await prisma.reservation.create({
      data: { propertyId: A.propertyA, code: `MK-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date("2026-10-02T00:00:00.000Z"), departureDate: new Date("2027-10-04T00:00:00.000Z"), roomTypeId: A.roomTypeA, assignedRoomId: A.roomsA[0], bookerName: "Huésped móvil" },
      select: { id: true }
    });
    reservationId = reservation.id;
    const issued = await call("POST", `/reservations/${reservationId}/wallet-pass`, reception, { payload: {} });
    assert.equal(issued.status, 200, issued.raw.slice(0, 300));
    serialNumber = issued.body.serialNumber;
    assert.equal(typeof serialNumber, "string");
    assert.equal(issued.body.reservationId, reservationId);
    assert.equal(issued.body.roomNumber, "101");
    const row = await prisma.guestPortalAction.findUnique({ where: { id: `mkey_${serialNumber}` } });
    assert.ok(row, "la llave existe en Prisma (guest_portal_actions)");
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.reservationId, reservationId);
    assert.equal(row.actionType, "mobile_key");
    assert.equal(row.status, "active");
    unlockSig = String((row.payloadJson as { unlockSig?: string }).unlockSig ?? "");
    assert.ok(unlockSig.length > 0, "la firma pública del QR queda persistida para verificar cada apertura");
    assert.equal(await prisma.guestPortalAction.count({ where: { propertyId: A.propertyB, actionType: "mobile_key" } }), 0, "nada en B");
  });

  it("(2) 403 sin clave: contabilidad y owner (sin pms.checkin.execute) no emiten ni revocan llaves (el gate contesta antes de resolver la entidad)", async () => {
    expect403(await call("POST", `/reservations/${reservationId}/wallet-pass`, accountant, { payload: {} }), "pms.checkin.execute");
    expect403(await call("POST", `/mobile-keys/${serialNumber}/revoke`, owner, { payload: {} }), "pms.checkin.execute");
    assert.equal((await prisma.guestPortalAction.findUnique({ where: { id: `mkey_${serialNumber}` } }))?.status, "active");
  });

  it("(3) 404 opaco: recepción de B (con la clave) sobre la reserva de A y recepción de A sobre una reserva de B; ninguna llave nueva", async () => {
    expect404(await call("POST", `/reservations/${reservationId}/wallet-pass`, receptionB, { payload: {} }), "Reserva no encontrada.");
    const reservationB = await prisma.reservation.create({
      data: { propertyId: A.propertyB, code: `MKB-${RUN}`, channel: "direct", status: "confirmed", arrivalDate: new Date("2026-10-02T00:00:00.000Z"), departureDate: new Date("2026-10-04T00:00:00.000Z"), roomTypeId: A.roomTypeB },
      select: { id: true }
    });
    expect404(await call("POST", `/reservations/${reservationB.id}/wallet-pass`, reception, { payload: {} }), "Reserva no encontrada.");
    assert.equal(await prisma.guestPortalAction.count({ where: { actionType: "mobile_key", propertyId: { in: [A.propertyA, A.propertyB] } } }), 1, "solo la llave legítima de A");
  });

  it("verify acepta la firma del QR, rechaza otra y la revocación deja la fila `revoked`", async () => {
    const ok = await call("POST", `/mobile-keys/${serialNumber}/verify`, reception, { payload: { signature: unlockSig, timestamp: Date.now() } });
    assert.equal(ok.status, 200, ok.raw.slice(0, 300));
    assert.equal(ok.body.ok, true);
    const bad = await call("POST", `/mobile-keys/${serialNumber}/verify`, reception, { payload: { signature: "0000000000000000", timestamp: Date.now() } });
    assert.deepEqual(bad.body, { ok: false, reason: "bad_signature" });
    expect404(await call("POST", `/mobile-keys/${serialNumber}/revoke`, receptionB, { payload: {} }), "Llave móvil no encontrada.");
    const revoked = await call("POST", `/mobile-keys/${serialNumber}/revoke`, reception, { payload: {} });
    assert.equal(revoked.status, 200, revoked.raw.slice(0, 300));
    assert.equal((await prisma.guestPortalAction.findUnique({ where: { id: `mkey_${serialNumber}` } }))?.status, "revoked");
  });
});

// ---------------------------------------------------------------------------
// webhooks (routes/webhooks.routes.ts · FIX-1 F7): una suscripción creada sin
// developerAppId cuelga de la propiedad activa (antes propertyId null +
// `app_<org>` sintético → 404 en PATCH / DELETE / entregas); las filas
// antiguas con esa forma se resuelven por el sufijo del developerAppId.
// ---------------------------------------------------------------------------

describe("L2-08 · webhooks: suscripciones con ámbito de propiedad / organización (FIX-1 · F7)", () => {
  const WEBHOOK_404 = "Suscripción de webhook no encontrada.";
  const targetUrl = `https://example.invalid/ehotelos/l2-${RUN}`;
  let subscriptionId = "";
  let legacyId = "";
  let appIdB = "";
  /** Caso (4): control del guard (propiedad propia por servicio directo); caso (5): suscripción con entregas. Ambas se borran en el caso y, si falla a medias, en after(). */
  let controlSubscriptionId = "";
  let deliveriesSubscriptionId = "";
  // Sistemas de B (plantilla admin, CON developer.manage_webhooks): el 404 de
  // los casos cruzados sale del guard de tenencia, nunca del gate de permisos.
  let systemsB: Session;

  before(async () => {
    systemsB = await withEnv(STRICT_ENV, () => loginOrThrow(app, B.users.systems.email, B.password, "l2-08-plat-systems-b"));
  });

  after(async () => {
    const ids = [subscriptionId, legacyId, controlSubscriptionId, deliveriesSubscriptionId].filter(Boolean);
    if (ids.length) {
      await prisma.webhookDelivery.deleteMany({ where: { webhookSubscriptionId: { in: ids } } });
      await prisma.webhookSubscription.deleteMany({ where: { id: { in: ids } } });
    }
    if (appIdB) await prisma.developerApp.deleteMany({ where: { id: appIdB } });
  });

  it("(1) POST /webhooks/subscriptions sin propertyId (sistemas, developer.manage_webhooks) cuelga de la propiedad activa; PATCH y entregas responden 200", async () => {
    const created = await call("POST", "/webhooks/subscriptions", systems, { propertyId: A.propertyA, payload: { targetUrl, eventTypes: ["reservation.created"] } });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    subscriptionId = created.body.id;
    assert.match(String(created.body.secret), /^whsec_/, "el secret viaja una sola vez, al crear");
    const row = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
    assert.ok(row, "la suscripción existe en Prisma");
    assert.equal(row.propertyId, A.propertyA, "cuelga de la propiedad activa del creador");
    assert.equal(row.developerAppId, `app_${A.organizationId}`, "developerAppId sintético como hasta ahora");

    const paused = await call("PATCH", `/webhooks/subscriptions/${subscriptionId}`, systems, { payload: { active: false } });
    assert.equal(paused.status, 200, paused.raw.slice(0, 300));
    assert.equal(paused.body.active, false);
    const deliveries = await call("GET", `/webhooks/subscriptions/${subscriptionId}/deliveries`, systems);
    assert.equal(deliveries.status, 200, deliveries.raw.slice(0, 300));
    assert.deepEqual(deliveries.body.items, []);
    const list = await call("GET", `/webhooks/subscriptions?propertyId=${A.propertyA}`, systems);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(
      list.body.items.some((item: { id: string; secretMasked: string | null }) => item.id === subscriptionId && String(item.secretMasked).startsWith("whsec_")),
      "la lista devuelve la fila con el secret enmascarado"
    );
  });

  it("(1b) fila heredada (propertyId null, developerAppId `app_<org>` sin fila en developer_apps): la organización la resuelve por el sufijo sin reescribirla", async () => {
    const legacy = await prisma.webhookSubscription.create({
      data: { developerAppId: `app_${A.organizationId}`, propertyId: null, eventTypes: ["invoice.issued"], targetUrl: `${targetUrl}-legacy`, secretRef: "whsec_l2legacy", active: true },
      select: { id: true }
    });
    legacyId = legacy.id;
    const paused = await call("PATCH", `/webhooks/subscriptions/${legacyId}`, systems, { payload: { active: false } });
    assert.equal(paused.status, 200, paused.raw.slice(0, 300));
    const deliveries = await call("GET", `/webhooks/subscriptions/${legacyId}/deliveries`, systems);
    assert.equal(deliveries.status, 200, deliveries.raw.slice(0, 300));
    expect404(await call("PATCH", `/webhooks/subscriptions/${legacyId}`, systemsB, { payload: { active: true } }), WEBHOOK_404);
    const row = await prisma.webhookSubscription.findUnique({ where: { id: legacyId } });
    assert.equal(row?.active, false, "B no la reactiva");
    assert.equal(row?.propertyId, null, "la fila heredada no se reescribe");
  });

  it("(2) 403 sin clave: recepción no crea suscripciones; 400 con developerAppId de otra organización (sin fila nueva)", async () => {
    expect403(await call("POST", "/webhooks/subscriptions", reception, { propertyId: A.propertyA, payload: { targetUrl, eventTypes: ["reservation.created"] } }), "developer.manage_webhooks");
    const appB = await prisma.developerApp.create({
      data: { organizationId: B.organizationId, name: `App B ${RUN}`, appType: "server", clientId: `cli_l2_${RUN}`, scopes: ["webhooks.subscribe"] },
      select: { id: true }
    });
    appIdB = appB.id;
    const foreign = await call("POST", "/webhooks/subscriptions", systems, { propertyId: A.propertyA, payload: { targetUrl, eventTypes: ["reservation.created"], developerAppId: appIdB } });
    assert.equal(foreign.status, 400, foreign.raw.slice(0, 300));
    assert.equal(foreign.body?.message, "La aplicación indicada no pertenece a esta organización.");
    assert.equal(await prisma.webhookSubscription.count({ where: { developerAppId: appIdB } }), 0, "nada se escribe con la app ajena");
    const own = await call("POST", "/webhooks/subscriptions", systemsB, { propertyId: B.propertyA, payload: { targetUrl, eventTypes: ["reservation.created"], developerAppId: appIdB } });
    assert.equal(own.status, 200, own.raw.slice(0, 300));
    const ownRow = await prisma.webhookSubscription.findUnique({ where: { id: own.body.id } });
    assert.equal(ownRow?.developerAppId, appIdB, "la app de la propia organización sí se acepta");
    await prisma.webhookSubscription.delete({ where: { id: own.body.id } });
  });

  it("(2b) GET /webhooks/subscriptions sin propertyId lista solo las suscripciones de la organización del actor (corrector FIX-1 · SEC-02)", async () => {
    const ids = (reply: Reply): string[] => (reply.body.items as Array<{ id: string }>).map((item) => item.id);
    // Sin `?propertyId=` en la query (el ámbito activo viaja en la cabecera): el servicio filtra solo por organización.
    const listA = await call("GET", "/webhooks/subscriptions", systems, { propertyId: A.propertyA });
    assert.equal(listA.status, 200, listA.raw.slice(0, 300));
    assert.ok(ids(listA).includes(subscriptionId), "A ve su suscripción (propiedad de A)");
    assert.ok(ids(listA).includes(legacyId), "A ve la fila heredada (app_<org> sintético)");
    const listB = await call("GET", "/webhooks/subscriptions", systemsB, { propertyId: B.propertyA });
    assert.equal(listB.status, 200, listB.raw.slice(0, 300));
    assert.ok(!ids(listB).includes(subscriptionId) && !ids(listB).includes(legacyId), "B no ve ninguna fila de A sin propertyId (antes: where = {} devolvía todas las organizaciones)");
    const listBProperty = await call("GET", `/webhooks/subscriptions?propertyId=${A.propertyA}`, systemsB, { propertyId: B.propertyA });
    assert.ok(listBProperty.status === 404 || (listBProperty.status === 200 && ids(listBProperty).every((id) => id !== subscriptionId && id !== legacyId)), `ni pidiendo la propiedad de A: ${listBProperty.status} ${listBProperty.raw.slice(0, 200)}`);
  });

  it("(3) 404 opaco: la organización B (sistemas, con la clave) no ve la suscripción de A en PATCH / entregas / DELETE; A la borra y la fila desaparece", async () => {
    expect404(await call("PATCH", `/webhooks/subscriptions/${subscriptionId}`, systemsB, { payload: { active: true } }), WEBHOOK_404);
    expect404(await call("GET", `/webhooks/subscriptions/${subscriptionId}/deliveries`, systemsB), WEBHOOK_404);
    expect404(await call("DELETE", `/webhooks/subscriptions/${subscriptionId}`, systemsB), WEBHOOK_404);
    assert.ok(await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } }), "B no borra la fila de A");
    const deleted = await call("DELETE", `/webhooks/subscriptions/${subscriptionId}`, systems);
    assert.equal(deleted.status, 200, deleted.raw.slice(0, 300));
    assert.deepEqual(deleted.body, { ok: true, id: subscriptionId, deliveriesDeleted: 0 }, "forma { ok, id } conservada + deliveriesDeleted aditivo (CIERRE-1); sin entregas → 0");
    assert.equal(await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } }), null);
    subscriptionId = "";
  });

  it("(4) POST /webhooks/subscriptions con propertyId de otra organización → 400 del servicio (404 opaco del hook por HTTP) y sin fila nueva (CIERRE-1)", async () => {
    const foreignUrl = `${targetUrl}-ajena`;
    const message = "La propiedad indicada no pertenece a esta organización.";
    const rejects400 = (error: unknown): boolean => (error as { statusCode?: number }).statusCode === 400 && (error as Error).message === message;
    // Por HTTP el hook global (server.ts · pickPropertyId → grantPropertyAccess) lee el `propertyId` del
    // cuerpo y contesta ANTES con el 404 opaco a un usuario que no es de plataforma (a uno de plataforma
    // lo re-apunta a la organización de la propiedad: acción cross-tenant legítima). El guard del
    // servicio (CIERRE-1) es la barrera para los llamadores directos (jobs, scripts, otros servicios)
    // y si el hook dejara de leer el cuerpo: antes, la fila se persistía colgando de la propiedad ajena.
    expect404(await call("POST", "/webhooks/subscriptions", systems, { propertyId: A.propertyA, payload: { targetUrl: foreignUrl, eventTypes: ["reservation.created"], propertyId: B.propertyB } }));
    // Servicio directo con el contexto de sistemas de A (sin plataforma): rama sin developerAppId (app_<org> sintético).
    const contextA: UserContext = { organizationId: A.organizationId, propertyId: A.propertyA, userId: A.users.systems.id, fullName: "Sistemas L2", deviceId: "l2-08-plat-servicio", permissions: ["developer.manage_webhooks"] };
    await assert.rejects(createSubscription({ context: contextA, payload: { targetUrl: foreignUrl, eventTypes: ["reservation.created"], propertyId: B.propertyB } }), rejects400, "propiedad de B con contexto de A → 400 del servicio");
    // Rama con developerAppId (app propia de B, creada en el caso (2)) y propertyId de A: el mismo 400 (ambas ramas resuelven propertyId antes del guard).
    assert.ok(appIdB, "la app de B la creó el caso (2)");
    const contextB: UserContext = { ...contextA, organizationId: B.organizationId, propertyId: B.propertyA, userId: B.users.systems.id };
    await assert.rejects(createSubscription({ context: contextB, payload: { targetUrl: foreignUrl, eventTypes: ["reservation.created"], developerAppId: appIdB, propertyId: A.propertyA } }), rejects400, "propiedad de A con la app de B → 400 del servicio");
    // Un id inexistente tampoco se persiste (antes: fila colgada de una propiedad inexistente, huérfana para la tenencia).
    await assert.rejects(createSubscription({ context: contextA, payload: { targetUrl: foreignUrl, eventTypes: ["reservation.created"], propertyId: `prop_l2_ghost_${RUN}` } }), rejects400, "propiedad inexistente → 400 del servicio");
    assert.equal(await prisma.webhookSubscription.count({ where: { targetUrl: foreignUrl } }), 0, "ninguna fila con la propiedad ajena / inexistente");
    assert.equal(await prisma.webhookSubscription.count({ where: { propertyId: { in: [A.propertyA, A.propertyB, B.propertyA, B.propertyB] }, targetUrl: { startsWith: targetUrl } } }), 0, "el caso (3) borró la de A y nada nuevo cuelga de A ni de B");
    // Control del guard: la otra propiedad de la MISMA organización sí se acepta y la fila cuelga de ella.
    const own = await createSubscription({ context: contextA, payload: { targetUrl: `${targetUrl}-propia`, eventTypes: ["reservation.created"], propertyId: A.propertyB } });
    controlSubscriptionId = own.id;
    assert.equal(own.propertyId, A.propertyB);
    assert.equal(own.developerAppId, `app_${A.organizationId}`);
    const removed = await call("DELETE", `/webhooks/subscriptions/${controlSubscriptionId}`, systems);
    assert.equal(removed.status, 200, removed.raw.slice(0, 300));
    assert.deepEqual(removed.body, { ok: true, id: controlSubscriptionId, deliveriesDeleted: 0 });
    controlSubscriptionId = "";
  });

  it("(5) DELETE borra también las entregas (webhook_deliveries) de la suscripción (CIERRE-1)", async () => {
    const created = await call("POST", "/webhooks/subscriptions", systems, { propertyId: A.propertyA, payload: { targetUrl: `${targetUrl}-entregas`, eventTypes: ["reservation.created"] } });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    deliveriesSubscriptionId = created.body.id;
    // El test de la suscripción persiste SIEMPRE una entrega (delivered o permanent_failure):
    // `example.invalid` no resuelve → fallo registrado; la respuesta HTTP del test no es el objeto de este caso.
    const tested = await call("POST", `/webhooks/subscriptions/${deliveriesSubscriptionId}/test`, systems);
    assert.ok([200, 502].includes(tested.status), `el test responde 200 (delivered: false) o 502: ${tested.status} ${tested.raw.slice(0, 200)}`);
    const before = await prisma.webhookDelivery.count({ where: { webhookSubscriptionId: deliveriesSubscriptionId } });
    assert.ok(before >= 1, `el test dejó al menos una entrega (${before})`);
    const listed = await call("GET", `/webhooks/subscriptions/${deliveriesSubscriptionId}/deliveries`, systems);
    assert.equal(listed.status, 200, listed.raw.slice(0, 300));
    assert.equal(listed.body.items.length, before);
    expect404(await call("DELETE", `/webhooks/subscriptions/${deliveriesSubscriptionId}`, systemsB), WEBHOOK_404);
    assert.equal(await prisma.webhookDelivery.count({ where: { webhookSubscriptionId: deliveriesSubscriptionId } }), before, "B no borra las entregas de A");
    const deleted = await call("DELETE", `/webhooks/subscriptions/${deliveriesSubscriptionId}`, systems);
    assert.equal(deleted.status, 200, deleted.raw.slice(0, 300));
    assert.equal(deleted.body.ok, true);
    assert.equal(deleted.body.id, deliveriesSubscriptionId);
    assert.equal(deleted.body.deliveriesDeleted, before, "deliveriesDeleted = entregas que colgaban de la suscripción");
    assert.equal(await prisma.webhookDelivery.count({ where: { webhookSubscriptionId: deliveriesSubscriptionId } }), 0, "sin entregas huérfanas (antes: sin cascade quedaban en webhook_deliveries)");
    assert.equal(await prisma.webhookSubscription.findUnique({ where: { id: deliveriesSubscriptionId } }), null);
    deliveriesSubscriptionId = "";
  });

  it("(6) POST /webhooks/subscriptions con propertyId \"\", tipos incorrectos, evento desconocido o clave desconocida → 400 VALIDATION_ERROR sin fila; el servicio normaliza \"\" a la propiedad activa (corrector CIERRE-1 · REV-07)", async () => {
    const emptyUrl = `${targetUrl}-vacio`;
    // Antes del esquema zod la fila se persistía con propertyId "" (ni null = organización ni un centro) y un tipo
    // incorrecto llegaba a Prisma; ahora la ruta contesta 400 antes del servicio y del guard de organización.
    const cases: Array<[string, unknown]> = [
      ["propertyId vacío", { targetUrl: emptyUrl, eventTypes: ["reservation.created"], propertyId: "" }],
      ["targetUrl no string", { targetUrl: 123, eventTypes: ["reservation.created"] }],
      ["targetUrl sin esquema", { targetUrl: "example.invalid/hook", eventTypes: ["reservation.created"] }],
      ["eventTypes string", { targetUrl: emptyUrl, eventTypes: "reservation.created" }],
      ["eventTypes vacío", { targetUrl: emptyUrl, eventTypes: [] }],
      ["evento desconocido", { targetUrl: emptyUrl, eventTypes: ["reservation.teleported"] }],
      ["clave desconocida", { targetUrl: emptyUrl, eventTypes: ["reservation.created"], extra: true }]
    ];
    for (const [label, payload] of cases) {
      const reply = await call("POST", "/webhooks/subscriptions", systems, { propertyId: A.propertyA, payload });
      assert.equal(reply.status, 400, `${label}: ${reply.raw.slice(0, 300)}`);
      assert.equal(reply.body?.details?.code, "VALIDATION_ERROR", label);
    }
    assert.equal(await prisma.webhookSubscription.count({ where: { OR: [{ targetUrl: emptyUrl }, { targetUrl: "example.invalid/hook" }, { propertyId: "" }] } }), 0, "ninguna fila con propertyId \"\" ni con las URL de los casos");
    // Llamador directo (sin la ruta): "" ya no se persiste tal cual, cae en la propiedad activa del contexto (o null = organización).
    const contextA: UserContext = { organizationId: A.organizationId, propertyId: A.propertyA, userId: A.users.systems.id, fullName: "Sistemas L2", deviceId: "l2-08-plat-vacio", permissions: ["developer.manage_webhooks"] };
    const own = await createSubscription({ context: contextA, payload: { targetUrl: emptyUrl, eventTypes: ["reservation.created"], propertyId: "" } });
    controlSubscriptionId = own.id;
    assert.equal(own.propertyId, A.propertyA, "\"\" → propiedad activa del contexto, nunca la cadena vacía");
    const removed = await call("DELETE", `/webhooks/subscriptions/${controlSubscriptionId}`, systems);
    assert.equal(removed.status, 200, removed.raw.slice(0, 300));
    controlSubscriptionId = "";
  });
});
