/**
 * Coste de personal importado · Tanda 6c · L3 — rutas HTTP REALES con app.inject
 * (buildApiServer en proceso, sin listen) contra el Postgres compartido y la
 * sesión demo (INTEGRATION_LOGIN_EMAIL / _PASSWORD, por defecto
 * reception@example.com en org_123). SOLO LECTURAS Y PREVISUALIZACIÓN: la
 * preview nunca escribe y ninguna ruta de escritura se ejecuta sobre un lote
 * real; Faranda y org_123 no cambian. Cifras sintéticas.
 *   · POST /payroll/cost-imports/preview con un CSV sintético de etiqueta desconocida → 200 con `unmappedCentres[0].label`;
 *   · cuerpo con clave extra → 400 VALIDATION_ERROR en español (nombra la clave);
 *   · GET /payroll/cost-report?from=2026-01&to=2026-03 → 200 con `months` de 3 y `centres` no vacío;
 *   · GET /payroll/cost-imports → 200 array; GET /payroll/cost-imports/no-existe → 404;
 *   · POST /payroll/cost-imports/no-existe/reverse → 404 opaco (sin eco del id);
 *   · sin token → 401 en preview (RBAC estricto); rango > 24 meses → 400.
 * FIX-1 · F10 (fichas de personal, tenant AISLADO `org_sp_<run>` creado aquí y borrado en `after`,
 * usuario real por /auth/login con payroll.read + payroll.manage y otro solo con payroll.read):
 *   · POST /payroll/staff-profiles → 201 con la persona y el departamento resueltos y auditoría
 *     STAFF_PROFILE_CREATED sin nombre ni correo; el mismo (userId, propertyId) → 409 STAFF_PROFILE_EXISTS;
 *   · userId de OTRA organización → 404 «Usuario no encontrado.»; departamento de otro centro → 400
 *     STAFF_PROFILE_DEPARTMENT_MISMATCH; clave extra / coste negativo → 400 VALIDATION_ERROR;
 *   · GET /payroll/staff-profiles?propertyId= → 200 con la ficha; centro ajeno → 404 opaco;
 *   · POST /payroll/contracts con el id nuevo → 200 (antes: 404 «Perfil de empleado no encontrado.»);
 *   · solo payroll.read → 403 en el alta; sin token → 401 (RBAC estricto).
 * Sin credenciales válidas los casos se saltan con aviso. Desde el repo:
 *   cd apps/api && node --import tsx --test "../../tests/integration/payroll-cost-routes.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Sin .env → valores por defecto de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED;

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { prisma, hashPassword } = await import("@hotelos/database");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Session = { token: string; headers: Headers };
type Profile = { organizationId: string; activePropertyId: string; isPlatformAdmin: boolean; grantedPermissions: string[] };
type ErrorBody = { message?: string; details?: { code?: string; issues?: Array<{ path: string; message: string }> } };
type Response<T> = { status: number; body: T | null; text: string };

const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" };

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  return run().finally(() => applyEnv(previous));
}

async function login(app: ApiApp, email: string, password: string): Promise<Session | null> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId: "integration-payroll-cost-routes" } });
  if (res.statusCode !== 200) return null;
  const token = (JSON.parse(res.body) as { token: string }).token;
  return { token, headers: { Authorization: `Bearer ${token}` } };
}

async function request<T>(app: ApiApp, method: "GET" | "POST", url: string, headers: Headers, payload?: unknown): Promise<Response<T>> {
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  let body: T | null = null;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body };
}

/** CSV sintético (dos filas, un mes) con una etiqueta de centro que no existe en ningún tenant. */
const UNKNOWN_CENTRE = "CASA RURAL SINTETICA ZZ";
const CSV_UNKNOWN = [
  "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados",
  `${UNKNOWN_CENTRE};2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3`,
  `${UNKNOWN_CENTRE};2026-02;operaciones;6 PISOS;4.000,00;1.200,00;5.200,00;4`
].join("\r\n") + "\r\n";

let app: ApiApp;
let session: Session | null = null;
let profile: Profile | null = null;

before(async () => {
  app = await buildApiServer();
  await app.ready();
  session = await login(app, process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo");
  if (session) profile = (await request<Profile>(app, "GET", "/users/me", session.headers)).body;
  // FIX-1 · F10: tenant aislado de las fichas de personal (se crea con el API ya levantado; un
  // segundo `before` de raíz no espera al primero en node:test).
  await spSetup();
});

after(async () => {
  try {
    await flushAuditQueues();
    await spCleanup();
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
});

const NO_SESSION = "INTEGRATION_LOGIN_EMAIL / _PASSWORD no configurados o login fallido — casos con sesión no ejercitados";

function needs(t: { skip: (reason: string) => void }, permission: string): Session | null {
  if (!session || !profile) {
    t.skip(NO_SESSION);
    return null;
  }
  if (!profile.grantedPermissions.includes(permission) && !profile.isPlatformAdmin) {
    t.skip(`la sesión de integración no tiene ${permission}: caso no ejercitado`);
    return null;
  }
  return session;
}

describe("L3 · POST /payroll/cost-imports/preview (nunca escribe)", () => {
  it("CSV sintético con etiqueta de centro desconocida → 200 con unmappedCentres[0].label y canPost false", async (t) => {
    const s = needs(t, "payroll.manage");
    if (!s) return;
    const res = await request<{ unmappedCentres: Array<{ label: string; rows: number; suggestions: unknown[] }>; canPost: boolean; rowCount: number; errors: unknown[]; contentHash: string; byCentreMonth: unknown[] }>(app, "POST", "/payroll/cost-imports/preview", s.headers, { format: "csv", content: CSV_UNKNOWN });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(res.body);
    assert.deepEqual(res.body.errors, []);
    assert.equal(res.body.rowCount, 2);
    assert.match(res.body.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(res.body.unmappedCentres.length, 1);
    assert.equal(res.body.unmappedCentres[0]?.label, UNKNOWN_CENTRE);
    assert.equal(res.body.unmappedCentres[0]?.rows, 2);
    assert.ok(Array.isArray(res.body.unmappedCentres[0]?.suggestions));
    assert.deepEqual(res.body.byCentreMonth, [], "sin centro mapeado no hay celdas");
    assert.equal(res.body.canPost, false);
  });

  it("cuerpo con clave desconocida → 400 VALIDATION_ERROR en español que nombra la clave", async (t) => {
    const s = needs(t, "payroll.manage");
    if (!s) return;
    const res = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/preview", s.headers, { format: "csv", content: CSV_UNKNOWN, fichero: "x.csv" });
    assert.equal(res.status, 400, res.text.slice(0, 300));
    assert.equal(res.body?.details?.code, "VALIDATION_ERROR");
    // parseOr400 reescribe la issue `unrecognized_keys` con zodErrorMapEs: nombra la clave en español.
    assert.match(res.body?.message ?? "", /^body no válido: clave no admitida: 'fichero'$/);
    assert.ok(res.body?.details?.issues?.some((issue) => issue.message.includes("'fichero'")), res.text.slice(0, 300));
    const badFormat = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/preview", s.headers, { format: "xlsx", content: CSV_UNKNOWN });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body?.details?.code, "VALIDATION_ERROR");
    assert.match(badFormat.body?.message ?? "", /^body no válido: format: valor no admitido 'xlsx'; valores válidos: csv \| json$/);
  });

  it("sin token → 401 con RBAC estricto (sin fallback demo)", async () => {
    await withEnv(STRICT_ENV, async () => {
      const res = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/preview", {}, { format: "csv", content: CSV_UNKNOWN });
      assert.equal(res.status, 401, res.text.slice(0, 200));
    });
  });
});

describe("L3 · GET /payroll/cost-report", () => {
  it("?from=2026-01&to=2026-03 → 200 con months de 3 y centres no vacío (celdas sin datos a cero, ratios null)", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const res = await request<{ organizationId: string; period: { from: string; to: string }; months: string[]; centres: Array<{ propertyId: string; cells: Array<{ periodCode: string; totalCost: string; laborPctLedger: string | null }> }>; byMonth: unknown[]; totals: { totalCost: string; headcountAverage: string | null }; imports: unknown[] }>(app, "GET", "/payroll/cost-report?from=2026-01&to=2026-03", s.headers);
    if (res.status === 404 && res.text.includes("ENTITY_SCOPE_REQUIRED")) return t.skip("la sesión no tiene ámbito de toda la sociedad (accounting.entity.read): caso no ejercitado");
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(res.body);
    assert.equal(res.body.organizationId, profile!.organizationId);
    assert.deepEqual(res.body.months, ["2026-01", "2026-02", "2026-03"]);
    assert.deepEqual(res.body.period, { from: "2026-01", to: "2026-03" });
    assert.ok(res.body.centres.length > 0, "la organización de la sesión tiene centros");
    assert.equal(res.body.byMonth.length, 3);
    for (const centre of res.body.centres) {
      assert.deepEqual(centre.cells.map((cell) => cell.periodCode), res.body!.months, `una celda por mes en ${centre.propertyId}`);
      for (const cell of centre.cells) assert.match(cell.totalCost, /^-?\d+\.\d{2}$/);
    }
    assert.match(res.body.totals.totalCost, /^-?\d+\.\d{2}$/);
    assert.ok(Array.isArray(res.body.imports));
  });

  it("rango > 24 meses → 400 VALIDATION_ERROR; to < from → 400; mes inválido → 400", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const tooLong = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2024-01&to=2026-01", s.headers);
    assert.equal(tooLong.status, 400, tooLong.text.slice(0, 300));
    assert.equal(tooLong.body?.details?.code, "VALIDATION_ERROR");
    assert.match(tooLong.body?.message ?? "", /El rango no puede superar 24 meses \(25 solicitados\)/);
    const inverted = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2026-03&to=2026-01", s.headers);
    assert.equal(inverted.status, 400);
    assert.match(inverted.body?.message ?? "", /to debe ser igual o posterior a from/);
    const badMonth = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2026-13&to=2026-12", s.headers);
    assert.equal(badMonth.status, 400);
    assert.match(badMonth.body?.message ?? "", /from debe ser un mes YYYY-MM/);
    const extra = await request<ErrorBody>(app, "GET", "/payroll/cost-report?from=2026-01&to=2026-03&format=csv", s.headers);
    assert.equal(extra.status, 400);
    assert.match(extra.body?.message ?? "", /^query no válido: clave no admitida: 'format'$/);
  });
});

describe("L3 · lotes: listado y 404 opacos", () => {
  it("GET /payroll/cost-imports → 200 array (solo lotes de la organización con todos sus centros en ámbito)", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const res = await request<Array<{ id: string; organizationId: string; status: string }>>(app, "GET", "/payroll/cost-imports", s.headers);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(Array.isArray(res.body));
    for (const row of res.body ?? []) {
      assert.equal(row.organizationId, profile!.organizationId);
      assert.ok(["draft", "posted", "reversed"].includes(row.status));
    }
    const badLimit = await request<ErrorBody>(app, "GET", "/payroll/cost-imports?limit=0", s.headers);
    assert.equal(badLimit.status, 400);
    assert.match(badLimit.body?.message ?? "", /limit debe ser un entero entre 1 y 200/);
  });

  it("GET /payroll/cost-imports/no-existe → 404 opaco", async (t) => {
    const s = needs(t, "payroll.read");
    if (!s) return;
    const res = await request<ErrorBody>(app, "GET", "/payroll/cost-imports/no-existe", s.headers);
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.message, "Importación de coste de personal no encontrada.");
  });

  it("POST /payroll/cost-imports/no-existe/reverse → 404 opaco (mismo mensaje, sin eco del id, nada escrito)", async (t) => {
    const s = needs(t, "payroll.manage");
    if (!s) return;
    const res = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/no-existe/reverse", s.headers, { reason: "prueba de integración (no existe)" });
    assert.equal(res.status, 404, res.text.slice(0, 300));
    assert.equal(res.body?.message, "Importación de coste de personal no encontrada.");
    assert.ok(!res.text.includes("no-existe"), "el 404 nunca repite el id");
    const post = await request<ErrorBody>(app, "POST", "/payroll/cost-imports/no-existe/post", s.headers, {});
    assert.equal(post.status, 404);
    assert.equal(post.body?.message, res.body?.message, "detalle, post y reverse comparten el mensaje neutro");
  });
});

// ---------------------------------------------------------------------------
// FIX-1 · F10 · fichas de personal — tenant AISLADO (nunca org_123 ni Faranda)
// ---------------------------------------------------------------------------

const RUN = Date.now().toString(36);
const SP_ORG = `org_sp_${RUN}`;
const SP_ORG2 = `org_sp2_${RUN}`;
const SP_HA = `prop_sp_ha_${RUN}`;
const SP_HB = `prop_sp_hb_${RUN}`;
const SP_P2 = `prop_sp2_${RUN}`;
const SP_PASSWORD = `Sp-${RUN}-Secreta-123`;
const SP_RRHH_EMAIL = `rrhh.sp.${RUN}@example.com`;
const SP_READER_EMAIL = `lector.sp.${RUN}@example.com`;
const SP_PERSON_EMAIL = `persona.sp.${RUN}@example.com`;
const SP_FOREIGN_EMAIL = `ajena.sp.${RUN}@example.com`;
const spRoleIds: string[] = [];
const spUserIds: string[] = [];
let spRrhh: Headers | null = null;
let spReader: Headers | null = null;
let spPersonId = "";
let spForeignUserId = "";
let spDepartmentHa = "";
let spDepartmentHb = "";
let spProfileId = "";

type StaffProfileBody = { id: string; propertyId: string; userId: string; employeeCode: string | null; departmentId: string | null; departmentName: string | null; employmentType: string | null; hourlyCost: string | null; active: boolean; userFullName: string | null; userEmail: string | null };

async function spLogin(email: string): Promise<Headers | null> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: SP_PASSWORD, deviceId: "integration-staff-profiles" } });
  if (res.statusCode !== 200) return null;
  return { Authorization: `Bearer ${(JSON.parse(res.body) as { token: string }).token}` };
}

/** Usuario real con un rol ad hoc (claves del catálogo) asignado a HA y HB; devuelve la cabecera de sesión o null. */
async function spCreateUser(email: string, fullName: string, keys: readonly string[]): Promise<{ id: string; headers: Headers | null }> {
  const user = await prisma.user.create({ data: { organizationId: SP_ORG, email, fullName, status: "active", passwordHash: hashPassword(SP_PASSWORD), passwordChangedAt: new Date(), mustChangePassword: false }, select: { id: true } });
  spUserIds.push(user.id);
  if (keys.length === 0) return { id: user.id, headers: null };
  const permissions = await prisma.permission.findMany({ where: { key: { in: [...keys] } }, select: { id: true } });
  if (permissions.length !== keys.length) return { id: user.id, headers: null };
  const role = await prisma.role.create({ data: { organizationId: SP_ORG, name: `${fullName} ${RUN}`, templateKey: null }, select: { id: true } });
  spRoleIds.push(role.id);
  await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })) });
  await prisma.userPropertyRole.createMany({ data: [SP_HA, SP_HB].map((propertyId) => ({ userId: user.id, propertyId, roleId: role.id })) });
  return { id: user.id, headers: await spLogin(email) };
}

async function spCleanup(): Promise<void> {
  await prisma.employmentContract.deleteMany({ where: { organizationId: SP_ORG } });
  await prisma.staffProfile.deleteMany({ where: { propertyId: { in: [SP_HA, SP_HB, SP_P2] } } });
  await prisma.department.deleteMany({ where: { propertyId: { in: [SP_HA, SP_HB, SP_P2] } } });
  if (spUserIds.length || spForeignUserId) {
    const ids = [...spUserIds, ...(spForeignUserId ? [spForeignUserId] : [])];
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.device.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userPropertyRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (spRoleIds.length) {
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: spRoleIds } } });
    await prisma.role.deleteMany({ where: { id: { in: spRoleIds } } });
  }
  await prisma.property.deleteMany({ where: { organizationId: { in: [SP_ORG, SP_ORG2] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [SP_ORG, SP_ORG2] } } });
}

async function spSetup(): Promise<void> {
  await prisma.organization.create({ data: { id: SP_ORG, name: "SP Fichas Test", country: "ES" } });
  await prisma.organization.create({ data: { id: SP_ORG2, name: "SP Otra Organización Test", country: "ES" } });
  await prisma.property.create({ data: { id: SP_HA, organizationId: SP_ORG, kind: "hotel", code: "SPA", name: "Hotel Fichas Alfa" } });
  await prisma.property.create({ data: { id: SP_HB, organizationId: SP_ORG, kind: "hotel", code: "SPB", name: "Hotel Fichas Beta" } });
  await prisma.property.create({ data: { id: SP_P2, organizationId: SP_ORG2, kind: "hotel", code: "SP2", name: "Hotel Ajeno" } });
  spDepartmentHa = (await prisma.department.create({ data: { propertyId: SP_HA, name: "Recepción", code: "REC" }, select: { id: true } })).id;
  spDepartmentHb = (await prisma.department.create({ data: { propertyId: SP_HB, name: "Pisos", code: "HK" }, select: { id: true } })).id;
  const rrhh = await spCreateUser(SP_RRHH_EMAIL, "RRHH SP", ["payroll.read", "payroll.manage"]);
  spRrhh = rrhh.headers;
  const reader = await spCreateUser(SP_READER_EMAIL, "Lector SP", ["payroll.read"]);
  spReader = reader.headers;
  spPersonId = (await spCreateUser(SP_PERSON_EMAIL, "Persona SP", [])).id;
  const foreign = await prisma.user.create({ data: { organizationId: SP_ORG2, email: SP_FOREIGN_EMAIL, fullName: "Persona Ajena SP", status: "active", passwordHash: hashPassword(SP_PASSWORD), passwordChangedAt: new Date(), mustChangePassword: false }, select: { id: true } });
  spForeignUserId = foreign.id;
}

const SP_NO_SESSION = "no se pudo crear la sesión real del tenant aislado (catálogo de permisos incompleto o login fallido): caso no ejercitado";
function spNeeds(t: { skip: (reason: string) => void }, headers: Headers | null): Headers | null {
  if (!headers) {
    t.skip(SP_NO_SESSION);
    return null;
  }
  return headers;
}

describe("FIX-1 · F10 · POST /payroll/staff-profiles (tenant aislado)", () => {
  it("alta → 201 con persona y departamento resueltos, coste «12,5» → «12.50» y auditoría STAFF_PROFILE_CREATED sin datos personales", async (t) => {
    const s = spNeeds(t, spRrhh);
    if (!s) return;
    const res = await request<StaffProfileBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spPersonId, employeeCode: "EMP-SP-001", departmentId: spDepartmentHa, employmentType: "indefinido", hourlyCost: "12,5" });
    assert.equal(res.status, 201, res.text.slice(0, 400));
    assert.ok(res.body);
    spProfileId = res.body.id;
    assert.equal(res.body.propertyId, SP_HA);
    assert.equal(res.body.userId, spPersonId);
    assert.equal(res.body.employeeCode, "EMP-SP-001");
    assert.equal(res.body.departmentId, spDepartmentHa);
    assert.equal(res.body.departmentName, "Recepción");
    assert.equal(res.body.employmentType, "indefinido");
    assert.equal(res.body.hourlyCost, "12.50");
    assert.equal(res.body.active, true);
    assert.equal(res.body.userFullName, "Persona SP");
    assert.equal(res.body.userEmail, SP_PERSON_EMAIL);
    const row = await prisma.staffProfile.findUnique({ where: { id: spProfileId } });
    assert.ok(row, "fila en staff_profiles");
    assert.equal(String(row.hourlyCost), "12.5");
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: SP_ORG, action: "STAFF_PROFILE_CREATED", entityId: spProfileId }, orderBy: { createdAt: "desc" } });
    assert.ok(audit, "evento STAFF_PROFILE_CREATED persistido");
    assert.equal(audit.propertyId, SP_HA);
    const after = JSON.stringify(audit.afterJson);
    assert.match(after, /EMP-SP-001/);
    assert.doesNotMatch(after, /Persona SP|persona\.sp\.|12\.50/, "afterJson sin nombre, correo ni coste");
  });

  it("mismo (userId, propertyId) activo → 409 STAFF_PROFILE_EXISTS; otro centro de la misma organización → 201", async (t) => {
    const s = spNeeds(t, spRrhh);
    if (!s || !spProfileId) return t.skip("sin ficha creada en el caso anterior");
    const dup = await request<ErrorBody & { details?: { staffProfileId?: string } }>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spPersonId });
    assert.equal(dup.status, 409, dup.text.slice(0, 300));
    assert.equal(dup.body?.details?.code, "STAFF_PROFILE_EXISTS");
    assert.equal(dup.body?.details?.staffProfileId, spProfileId);
    assert.equal(await prisma.staffProfile.count({ where: { propertyId: SP_HA } }), 1);
    const other = await request<StaffProfileBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HB, userId: spPersonId, employeeCode: "EMP-SP-002" });
    assert.equal(other.status, 201, other.text.slice(0, 300));
    assert.equal(other.body?.propertyId, SP_HB);
  });

  it("userId de OTRA organización → 404 «Usuario no encontrado.»; departamento de otro centro → 400 STAFF_PROFILE_DEPARTMENT_MISMATCH; clave extra / coste negativo → 400 VALIDATION_ERROR; centro ajeno → 404 opaco", async (t) => {
    const s = spNeeds(t, spRrhh);
    if (!s) return;
    const foreignUser = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spForeignUserId });
    assert.equal(foreignUser.status, 404, foreignUser.text.slice(0, 300));
    assert.equal(foreignUser.body?.message, "Usuario no encontrado.");
    const dept = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spUserIds[1], departmentId: spDepartmentHb });
    assert.equal(dept.status, 400, dept.text.slice(0, 300));
    assert.equal(dept.body?.details?.code, "STAFF_PROFILE_DEPARTMENT_MISMATCH");
    const extra = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spUserIds[1], nombre: "x" });
    assert.equal(extra.status, 400);
    assert.equal(extra.body?.details?.code, "VALIDATION_ERROR");
    assert.match(extra.body?.message ?? "", /^body no válido: clave no admitida: 'nombre'$/);
    const negative = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spUserIds[1], hourlyCost: -1 });
    assert.equal(negative.status, 400);
    assert.match(negative.body?.message ?? "", /hourlyCost debe ser un importe mayor o igual que 0/);
    const foreignProperty = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_P2, userId: spUserIds[1] });
    assert.equal(foreignProperty.status, 404, foreignProperty.text.slice(0, 300));
    assert.equal(foreignProperty.body?.message, "Propiedad no encontrada.");
    assert.ok(!foreignProperty.text.includes(SP_P2), "el 404 nunca repite el id");
    assert.equal(await prisma.staffProfile.count({ where: { propertyId: { in: [SP_HA, SP_P2] } } }), 1, "nada escrito por los rechazos");
  });

  it("solo payroll.read → 403 en el alta y 200 en la lectura; sin token → 401 (RBAC estricto)", async (t) => {
    const s = spNeeds(t, spReader);
    if (!s) return;
    const forbidden = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", s, { propertyId: SP_HA, userId: spUserIds[1] });
    assert.equal(forbidden.status, 403, forbidden.text.slice(0, 300));
    const list = await request<StaffProfileBody[]>(app, "GET", `/payroll/staff-profiles?propertyId=${SP_HA}`, s);
    assert.equal(list.status, 200, list.text.slice(0, 300));
    await withEnv(STRICT_ENV, async () => {
      const res = await request<ErrorBody>(app, "POST", "/payroll/staff-profiles", {}, { propertyId: SP_HA, userId: spUserIds[1] });
      assert.equal(res.status, 401, res.text.slice(0, 200));
    });
  });
});

describe("FIX-1 · F10 · GET /payroll/staff-profiles y POST /payroll/contracts con la ficha nueva", () => {
  it("GET ?propertyId= → 200 con la ficha (persona y departamento); sin propertyId → los dos centros; centro ajeno → 404 opaco; clave extra → 400", async (t) => {
    const s = spNeeds(t, spRrhh);
    if (!s || !spProfileId) return t.skip("sin ficha creada");
    const ha = await request<StaffProfileBody[]>(app, "GET", `/payroll/staff-profiles?propertyId=${SP_HA}`, s);
    assert.equal(ha.status, 200, ha.text.slice(0, 300));
    assert.ok(Array.isArray(ha.body));
    assert.deepEqual(ha.body?.map((row) => row.id), [spProfileId]);
    assert.equal(ha.body?.[0]?.userFullName, "Persona SP");
    assert.equal(ha.body?.[0]?.departmentName, "Recepción");
    const all = await request<StaffProfileBody[]>(app, "GET", "/payroll/staff-profiles", s);
    assert.equal(all.status, 200, all.text.slice(0, 300));
    assert.deepEqual(all.body?.map((row) => row.propertyId).sort(), [SP_HA, SP_HB].sort());
    const foreign = await request<ErrorBody>(app, "GET", `/payroll/staff-profiles?propertyId=${SP_P2}`, s);
    assert.equal(foreign.status, 404, foreign.text.slice(0, 300));
    const extra = await request<ErrorBody>(app, "GET", `/payroll/staff-profiles?propertyId=${SP_HA}&organizationId=${SP_ORG}`, s);
    assert.equal(extra.status, 400);
    assert.match(extra.body?.message ?? "", /^query no válido: clave no admitida: 'organizationId'$/);
  });

  it("POST /payroll/contracts con el staffProfileId nuevo → 200 (antes 404 «Perfil de empleado no encontrado.»); id inexistente → 404", async (t) => {
    const s = spNeeds(t, spRrhh);
    if (!s || !spProfileId) return t.skip("sin ficha creada");
    const res = await request<{ id: string; staffProfileId: string; propertyId?: string; organizationId: string; active: boolean; grossSalary: number }>(app, "POST", "/payroll/contracts", s, { staffProfileId: spProfileId, contractType: "indefinido", startDate: "2026-09-01", grossSalary: "1800", payCount: 14, irpfRatePct: 15 });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.equal(res.body?.staffProfileId, spProfileId);
    assert.equal(res.body?.propertyId, SP_HA);
    assert.equal(res.body?.organizationId, SP_ORG);
    assert.equal(res.body?.active, true);
    assert.equal(res.body?.grossSalary, 1800);
    const missing = await request<ErrorBody>(app, "POST", "/payroll/contracts", s, { staffProfileId: "sp_no_existe", contractType: "indefinido", startDate: "2026-09-01", grossSalary: "1800" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body?.message, "Perfil de empleado no encontrado.");
  });
});
