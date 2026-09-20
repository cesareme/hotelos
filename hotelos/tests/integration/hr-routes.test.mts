/**
 * Tanda RRHH · RRHH-6 — rutas /hr/* y GET /payroll/incidences por HTTP (app.inject,
 * Postgres real, tenant AISLADO de helpers/l2-tenant.mts; modo estricto de RBAC sin
 * fallback demo). Dos organizaciones `org_l2_<run>` con usuarios ficticios; NIF
 * inventados con letra válida; en Faranda no se escribe nada; al terminar se borran.
 *
 *   · 401 sin token; 403 sin la clave (recepción sobre /hr/employees; payroll_hr sobre
 *     approve; dirección general sobre POST /hr/employees);
 *   · 400 VALIDATION_ERROR con una clave extra (cuerpo y consulta);
 *   · alta / listado / detalle: los listados NUNCA llevan NIF, NAF, correo, teléfono ni
 *     IBAN (ni el JSON los contiene); el detalle solo con `?pii=1` y clave (payroll_hr
 *     descifra; dirección general solo correo y teléfono);
 *   · 404 OPACO entre organizaciones (expediente, convenio y plan de la otra organización
 *     responden lo mismo que un id inexistente: mismo estado, mensaje y `details.code`);
 *   · convenios (POST + PUT rules + GET rules), estándares (reset-defaults 4★ → 9),
 *     plantilla máxima con SoD (quien la prepara no la aprueba → 409 APPROVAL_SELF_DECISION;
 *     dirección general sí → approved; segunda aprobación 409);
 *   · previsión: generate → GET labor-forecast devuelve la ventana con `degraded[]`;
 *     KPIs y alertas responden con la forma del DTO;
 *   · ausencias: alta por /workforce/absences, lista /hr/absences?status=, decisión con
 *     SoD (409 para el solicitante, 200 para otro gestor) y enmascarado de IT sin
 *     hr.employee.read;
 *   · incidencias del mes: JSON y CSV con la alta del mes y sin NIF; 403 sin
 *     workforce.payroll_export;
 *   · GET /payroll/periods lleva `mode` y `closedAt`.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/hr-routes.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Sin .env → valores de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
const configuredKey = process.env.HOTELOS_FIELD_KEY ?? process.env.ENCRYPTION_KEY ?? "";
if (Buffer.from(configuredKey, "base64").length !== 32) process.env.HOTELOS_FIELD_KEY = Buffer.alloc(32, 7).toString("base64");

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { HR_PII_FIELDS } = await import("@hotelos/shared");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { templateRoleMetadata } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { dayUtc, addDays, isoDate } = await import("../../apps/api/src/modules/revenue/actuals.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, unknown>;
type Reply = { status: number; body: Json; raw: string; headers: Record<string, unknown> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);
const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
/** NIF sintético con letra válida (nunca de una persona real). */
const nif = (digits: number): string => {
  const body = String(digits).padStart(8, "0");
  return `${body}${NIF_LETTERS[Number(body) % 23]}`;
};
const TODAY = dayUtc(new Date());
const key = (offset: number): string => isoDate(addDays(TODAY, offset));
const PERIOD = isoDate(TODAY).slice(0, 7);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH" | "PUT", url: string, session: Session | null, payload?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...(session?.headers ?? {}), ...extraHeaders }, ...(payload === undefined ? {} : { payload }) });
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, raw: res.body, headers: res.headers as Record<string, unknown> };
}

const detailsCode = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
/** Cuerpo de error sin el `correlationId` (único por petición): lo que debe coincidir entre un id ajeno y uno inexistente. */
const opaque = (reply: Reply): Json => {
  const { correlationId: _corr, ...rest } = reply.body;
  void _corr;
  return rest;
};
const ok = (reply: Reply, label: string, ...statuses: number[]): Json => {
  assert.ok((statuses.length ? statuses : [200]).includes(reply.status), `${label}: ${reply.status} ${reply.raw.slice(0, 400)}`);
  return reply.body;
};
const assertNoPii = (raw: string, label: string, secrets: string[]): void => {
  for (const field of HR_PII_FIELDS) assert.equal(new RegExp(`"${field}"\\s*:\\s*"`).test(raw), false, `${label}: campo ${field} con valor en la respuesta`);
  for (const secret of secrets) assert.equal(raw.includes(secret), false, `${label}: dato personal en la respuesta`);
};

/** Usuario extra con una plantilla o con un rol a medida (claves explícitas); cuelga de la organización → cleanupTenant lo barre. */
async function addUser(tenant: IsolatedTenant, local: string, spec: { templateKey: string } | { customKeys: string[] }, scope: { scopeType: "organization" | "property"; propertyId?: string }): Promise<{ id: string; email: string; fullName: string }> {
  const id = `usr_hr6_${local}_${tenant.run}`;
  const email = `${local}.hr6.${tenant.run}@faranda.test`;
  const fullName = `HR6 ${local} ${tenant.run}`;
  await prisma.user.create({ data: { id, organizationId: tenant.organizationId, email, fullName, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() } });
  let roleId: string;
  if ("templateKey" in spec) {
    roleId = tenant.roles[spec.templateKey]!;
    assert.ok(roleId, `Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  } else {
    const role = await prisma.role.create({ data: { organizationId: tenant.organizationId, name: `HR6 a medida ${local}`, ...templateRoleMetadata("payroll_hr"), templateKey: null }, select: { id: true } });
    roleId = role.id;
    const permissions = await prisma.permission.findMany({ where: { key: { in: spec.customKeys } }, select: { id: true, key: true } });
    assert.equal(permissions.length, spec.customKeys.length, `claves sin fila en permissions: ${spec.customKeys.filter((k) => !permissions.some((p) => p.key === k)).join(", ")}`);
    await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permissionId: permission.id })), skipDuplicates: true });
  }
  await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: scope.scopeType, propertyId: scope.propertyId ?? null, organizationId: tenant.organizationId, reason: `hr-routes ${local}` } });
  resetRbacScopeCacheForTests();
  return { id, email, fullName };
}

describe("RRHH-6 · rutas /hr/* y GET /payroll/incidences por HTTP", () => {
  let app: ApiApp;
  let A: IsolatedTenant;
  let B: IsolatedTenant;
  let rrhh: Session; // payroll_hr (organización)
  let direccion: Session; // general_manager (A.propertyA y A.propertyB)
  let recepcion: Session; // receptionist: sin claves hr.*
  let preparadorAprobador: Session; // rol a medida hr.standards.manage + hr.staffing.approve (SoD dinámica)
  let gestor: Session; // manager en A.propertyA: workforce.schedule.manage + hr.employee.read (decide ausencias)
  let pisos: Session; // housekeeper en A.propertyA: workforce.read + workforce.timeclock.use, sin payroll.read (SEC-02)
  let rrhhB: Session; // payroll_hr de la organización B
  let rrhhUserId = "";
  let employeeId = "";
  let employeeNumber = "";
  let employeeIdB = "";
  let agreementId = "";
  let agreementIdB = "";
  let planId = "";
  let planIdB = "";
  let absenceId = "";
  let healthAbsenceId = "";
  let staffProfileId = "";
  let linkedProfileId = "";
  let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
  const TAX_ID = nif(31_415_926);
  const IBAN = "ES9121000418450200051332";

  before(async () => {
    invariantsBefore = await farandaInvariants();
    app = await buildApiServer();
    A = await createIsolatedTenant(`h6a${newRunId()}`);
    B = await createIsolatedTenant(`h6b${newRunId()}`);
    await enableModules(A.propertyA, ["workforce_labor"]);
    await prisma.property.update({ where: { id: A.propertyA }, data: { starRating: 4 } });
    const rrhhUser = await addUser(A, "rrhh", { templateKey: "payroll_hr" }, { scopeType: "organization" });
    rrhhUserId = rrhhUser.id;
    const dualUser = await addUser(A, "dual", { customKeys: ["hr.standards.manage", "hr.staffing.approve", "workforce.read"] }, { scopeType: "property", propertyId: A.propertyA });
    const gestorUser = await addUser(A, "gestor", { templateKey: "manager" }, { scopeType: "property", propertyId: A.propertyA });
    const pisosUser = await addUser(A, "pisos", { templateKey: "housekeeper" }, { scopeType: "property", propertyId: A.propertyA });
    const rrhhUserB = await addUser(B, "rrhh", { templateKey: "payroll_hr" }, { scopeType: "organization" });
    await strict(async () => {
      rrhh = await loginOrThrow(app, rrhhUser.email, A.password);
      direccion = await loginOrThrow(app, A.users.generalManager.email, A.password);
      recepcion = await loginOrThrow(app, A.users.receptionist.email, A.password);
      preparadorAprobador = await loginOrThrow(app, dualUser.email, A.password);
      gestor = await loginOrThrow(app, gestorUser.email, A.password);
      pisos = await loginOrThrow(app, pisosUser.email, A.password);
      rrhhB = await loginOrThrow(app, rrhhUserB.email, B.password);
    });
    // Ficha de personal de la recepcionista en A.propertyA (ausencias por ficha).
    staffProfileId = `sp_hr6_${A.run}`;
    await prisma.staffProfile.create({ data: { id: staffProfileId, userId: A.users.receptionist.id, propertyId: A.propertyA, employeeCode: "HR6-001", active: true } });
    // Datos de la organización B: expediente, convenio y plan (solo para el 404 opaco cruzado).
    await strict(async () => {
      const emp = ok(await call(app, "POST", "/hr/employees", rrhhB, { legalEntityId: B.legalEntityId, firstName: "Ajena", lastName: "Organización", taxId: nif(27_182_818), hiredAt: key(-30), primaryPropertyId: B.propertyA }), "alta B", 201);
      employeeIdB = emp.id as string;
      const agr = ok(await call(app, "POST", "/hr/agreements", rrhhB, { code: "B-TEST", name: "Convenio B", validFrom: "2026-01-01" }), "convenio B", 201);
      agreementIdB = agr.id as string;
      const plan = ok(await call(app, "POST", `/hr/properties/${B.propertyA}/staffing-plans`, rrhhB, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: "3.00" }] }), "plan B", 201);
      planIdB = plan.id as string;
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
    assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organización residual de esta suite");
  });

  it("401 sin token; 403 sin la clave del manifiesto (recepción, dirección general sin manage, payroll_hr sin approve)", async () =>
    strict(async () => {
      assert.equal((await call(app, "GET", "/hr/employees", null)).status, 401);
      assert.equal((await call(app, "GET", `/hr/properties/${A.propertyA}/labor-forecast?from=${key(0)}&to=${key(1)}`, null)).status, 401);
      assert.equal((await call(app, "GET", "/hr/employees", recepcion)).status, 403);
      assert.equal((await call(app, "GET", "/hr/agreements", recepcion)).status, 403);
      assert.equal((await call(app, "GET", `/payroll/incidences?period=${PERIOD}`, recepcion)).status, 403);
      assert.equal((await call(app, "POST", "/hr/employees", direccion, { legalEntityId: A.legalEntityId, firstName: "X", lastName: "Y", taxId: nif(1), hiredAt: key(0) })).status, 403);
      assert.equal((await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans/no_importa/approve`, rrhh, {})).status, 403);
      assert.equal((await call(app, "GET", `/payroll/incidences?period=${PERIOD}`, direccion)).status, 403, "dirección general no exporta la nómina");
    }));

  it("400 VALIDATION_ERROR: clave extra en el cuerpo y en la consulta, vocabulario y formato", async () =>
    strict(async () => {
      const body = await call(app, "POST", "/hr/employees", rrhh, { legalEntityId: A.legalEntityId, firstName: "X", lastName: "Y", taxId: nif(1), hiredAt: key(0), salario: 1000 });
      assert.equal(body.status, 400, body.raw);
      assert.equal(detailsCode(body), "VALIDATION_ERROR");
      assert.match(String(body.body.message), /salario/);
      const query = await call(app, "GET", "/hr/employees?nif=x", rrhh);
      assert.equal(query.status, 400);
      assert.equal(detailsCode(query), "VALIDATION_ERROR");
      const badNif = await call(app, "POST", "/hr/employees", rrhh, { legalEntityId: A.legalEntityId, firstName: "X", lastName: "Y", taxId: "12345678A", hiredAt: key(0) });
      assert.equal(badNif.status, 400);
      assert.equal(detailsCode(badNif), "HR_TAXID_INVALID");
      const period = await call(app, "GET", "/payroll/incidences?period=2026-9", rrhh);
      assert.equal(period.status, 400);
      const window = await call(app, "GET", `/hr/properties/${A.propertyA}/labor-forecast?from=${key(0)}&to=${key(120)}`, rrhh);
      assert.equal(window.status, 400, window.raw);
      assert.equal(detailsCode(window), "VALIDATION_ERROR");
    }));

  it("alta, listado y detalle: la PII no sale en el listado ni en el alta; el detalle la descifra solo con ?pii=1 y según el ámbito; 409 con el mismo NIF", async () =>
    strict(async () => {
      const created = await call(app, "POST", "/hr/employees", rrhh, { legalEntityId: A.legalEntityId, firstName: "Prueba", lastName: "Expediente", taxId: TAX_ID, iban: IBAN, email: "prueba.expediente@faranda.test", phone: "600000001", hiredAt: key(-3), primaryPropertyId: A.propertyA, usaliDepartment: "rooms", jobTitle: "Recepción" });
      const body = ok(created, "alta", 201);
      employeeId = body.id as string;
      employeeNumber = body.employeeNumber as string;
      assert.equal(body.pii, null);
      assert.ok(Array.isArray(body.piiFields));
      assertNoPii(created.raw, "alta", [TAX_ID, IBAN, "600000001", "prueba.expediente@"]);

      const duplicate = await call(app, "POST", "/hr/employees", rrhh, { legalEntityId: A.legalEntityId, firstName: "Otra", lastName: "Persona", taxId: TAX_ID.toLowerCase(), hiredAt: key(0) });
      assert.equal(duplicate.status, 409);
      assert.equal(detailsCode(duplicate), "HR_EMPLOYEE_TAXID_DUPLICATE");

      const list = await call(app, "GET", `/hr/employees?propertyId=${A.propertyA}`, rrhh);
      const rows = ok(list, "listado") as unknown as Json[];
      assert.ok(Array.isArray(rows) && rows.some((row) => row.id === employeeId));
      assertNoPii(list.raw, "listado", [TAX_ID, IBAN, "600000001", "prueba.expediente@"]);
      for (const row of rows) for (const field of HR_PII_FIELDS) assert.equal(field in row, false, `listado: clave ${field}`);
      const search = ok(await call(app, "GET", `/hr/employees?search=${employeeNumber}`, rrhh), "búsqueda") as unknown as Json[];
      assert.equal(search.length, 1);
      // Dirección general (hr.employee.read) también lista, sin PII.
      const listGm = await call(app, "GET", "/hr/employees", direccion);
      ok(listGm, "listado dirección");
      assertNoPii(listGm.raw, "listado dirección", [TAX_ID, IBAN]);

      const plain = await call(app, "GET", `/hr/employees/${employeeId}`, rrhh);
      assert.equal(ok(plain, "detalle sin pii").pii, null);
      assertNoPii(plain.raw, "detalle sin pii", [TAX_ID, IBAN]);
      const withPii = ok(await call(app, "GET", `/hr/employees/${employeeId}?pii=1`, rrhh), "detalle pii");
      const pii = withPii.pii as Record<string, string | null>;
      assert.equal(pii.taxId, TAX_ID);
      assert.equal(pii.iban, IBAN);
      assert.equal(pii.email, "prueba.expediente@faranda.test");
      const gmPii = ok(await call(app, "GET", `/hr/employees/${employeeId}?pii=1`, direccion), "detalle pii dirección");
      const gm = gmPii.pii as Record<string, string | null>;
      assert.equal(gm.taxId, null, "dirección general no ve el NIF");
      assert.equal(gm.iban, null);
      assert.equal(gm.email, "prueba.expediente@faranda.test");
      await flushAuditQueues();
      const audits = await prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, action: "HR_PII_READ", entityId: employeeId } });
      assert.equal(audits.length, 2);
      assert.doesNotMatch(JSON.stringify(audits), new RegExp(TAX_ID));

      const patched = ok(await call(app, "PATCH", `/hr/employees/${employeeId}`, rrhh, { jobTitle: "Recepción · turno de tarde" }), "patch");
      assert.equal(patched.jobTitle, "Recepción · turno de tarde");
    }));

  it("404 opaco entre organizaciones: expediente, convenio y plan de B responden como un id inexistente (estado, mensaje y código)", async () =>
    strict(async () => {
      const foreign = await call(app, "GET", `/hr/employees/${employeeIdB}`, rrhh);
      const missing = await call(app, "GET", "/hr/employees/emp_no_existe", rrhh);
      assert.equal(foreign.status, 404, foreign.raw);
      assert.equal(missing.status, 404);
      assert.deepEqual(opaque(foreign), opaque(missing));
      assert.equal(detailsCode(foreign), "HR_EMPLOYEE_NOT_FOUND");
      assert.equal((await call(app, "PATCH", `/hr/employees/${employeeIdB}`, rrhh, { jobTitle: "x" })).status, 404);
      assert.equal((await call(app, "POST", `/hr/employees/${employeeIdB}/terminate`, rrhh, {})).status, 404);
      const foreignRules = await call(app, "GET", `/hr/agreements/${agreementIdB}/rules`, rrhh);
      const missingRules = await call(app, "GET", "/hr/agreements/agr_no_existe/rules", rrhh);
      assert.equal(foreignRules.status, 404);
      assert.deepEqual(opaque(foreignRules), opaque(missingRules));
      assert.equal(detailsCode(foreignRules), "HR_AGREEMENT_NOT_FOUND");
      // Plan de B por el centro de B (centro ajeno → 404 del hook de tenencia) y por el centro de A (plan ajeno → 404 del servicio).
      assert.equal((await call(app, "POST", `/hr/properties/${B.propertyA}/staffing-plans/${planIdB}/approve`, direccion, {})).status, 404);
      const crossed = await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans/${planIdB}/approve`, direccion, {});
      assert.equal(crossed.status, 404, crossed.raw);
      assert.equal(detailsCode(crossed), "HR_STAFFING_PLAN_NOT_FOUND");
      // La organización B sigue viendo lo suyo.
      assert.equal((await call(app, "GET", `/hr/employees/${employeeIdB}`, rrhhB)).status, 200);
      // Listado de A no incluye el expediente de B.
      const list = ok(await call(app, "GET", "/hr/employees", rrhh), "listado A") as unknown as Json[];
      assert.equal(list.some((row) => row.id === employeeIdB), false);
    }));

  it("convenios: alta con reglas, PUT rules versiona, GET rules resuelve por fecha; código duplicado 409; clave de regla desconocida 400", async () =>
    strict(async () => {
      const created = ok(await call(app, "POST", "/hr/agreements", rrhh, { code: "hr6-test", name: "Convenio de prueba RRHH-6", validFrom: "2026-01-01", rules: { annual_hours: 1792, extra_pay_count: 3, vacation_days: 30 } }), "convenio", 201);
      agreementId = created.id as string;
      assert.equal(created.code, "HR6-TEST");
      assert.equal(created.rulesCount, 3);
      const dup = await call(app, "POST", "/hr/agreements", rrhh, { code: "HR6-TEST", name: "Otro", validFrom: "2026-01-01" });
      assert.equal(dup.status, 409);
      assert.equal(detailsCode(dup), "HR_AGREEMENT_CODE_DUPLICATE");
      const badRule = await call(app, "PUT", `/hr/agreements/${agreementId}/rules`, rrhh, { rules: [{ key: "vacation_days", value: "treinta", validFrom: "2027-01-01" }] });
      assert.equal(badRule.status, 400, badRule.raw);
      assert.equal(detailsCode(badRule), "HR_AGREEMENT_RULE_INVALID");
      const put = ok(await call(app, "PUT", `/hr/agreements/${agreementId}/rules`, rrhh, { rules: [{ key: "vacation_days", value: 32, validFrom: "2027-01-01" }] }), "put rules") as unknown as Json[];
      assert.equal(put.length, 1);
      const now = ok(await call(app, "GET", `/hr/agreements/${agreementId}/rules?asOf=2026-06-01`, direccion), "rules 2026") as unknown as Json[];
      assert.equal(now.find((rule) => rule.key === "vacation_days")?.value, 30);
      const later = ok(await call(app, "GET", `/hr/agreements/${agreementId}/rules?asOf=2027-06-01`, direccion), "rules 2027") as unknown as Json[];
      assert.equal(later.find((rule) => rule.key === "vacation_days")?.value, 32);
      const list = ok(await call(app, "GET", "/hr/agreements", direccion), "lista convenios") as unknown as Json[];
      assert.ok(list.some((row) => row.id === agreementId));
      assert.equal(list.some((row) => row.id === agreementIdB), false, "los convenios de B no se ven desde A");
      assert.equal((await call(app, "PUT", `/hr/agreements/${agreementId}/rules`, direccion, { rules: [{ key: "vacation_days", value: 31, validFrom: "2028-01-01" }] })).status, 403);
    }));

  it("estándares: reset-defaults 4★ siembra 9 (solo hr.standards.manage); GET por fecha; PUT con estándar inválido 400", async () =>
    strict(async () => {
      assert.equal((await call(app, "POST", `/hr/properties/${A.propertyA}/standards/reset-defaults`, direccion, {})).status, 403);
      const reset = ok(await call(app, "POST", `/hr/properties/${A.propertyA}/standards/reset-defaults`, rrhh, { validFrom: key(-60) }), "reset");
      assert.equal(reset.starBand, 4);
      assert.equal(reset.written, 9);
      const list = ok(await call(app, "GET", `/hr/properties/${A.propertyA}/standards`, direccion), "standards");
      assert.equal((list.standards as unknown[]).length, 9);
      const bad = await call(app, "PUT", `/hr/properties/${A.propertyA}/standards`, rrhh, { standards: [{ usaliDepartment: "rooms", driver: "rooms_inventory", unit: "minutes_per_unit", value: 1 }] });
      assert.equal(bad.status, 400, bad.raw);
      assert.equal(detailsCode(bad), "HR_STANDARD_INVALID");
      // Centro de otra organización: 404 opaco del hook de tenencia.
      assert.equal((await call(app, "GET", `/hr/properties/${B.propertyA}/standards`, rrhh)).status, 404);
    }));

  it("plantilla máxima: borrador por RRHH, aprobación con SoD (409 quien la preparó; dirección general 200; segunda 409); GET lista", async () =>
    strict(async () => {
      const plan = ok(await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans`, preparadorAprobador, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: "4.50", maxHeadcount: 6 }, { usaliDepartment: "fnb", maxFte: "2.00" }] }), "plan", 201);
      planId = plan.id as string;
      assert.equal(plan.status, "draft");
      assert.equal(plan.totalMaxFte, "6.50");
      const self = await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans/${planId}/approve`, preparadorAprobador, {});
      assert.equal(self.status, 409, self.raw);
      assert.equal(detailsCode(self), "APPROVAL_SELF_DECISION");
      const approved = ok(await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans/${planId}/approve`, direccion, {}), "approve");
      assert.equal(approved.status, "approved");
      assert.equal(approved.approvedBy, direccion.userId);
      const again = await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans/${planId}/approve`, direccion, {});
      assert.equal(again.status, 409);
      assert.equal(detailsCode(again), "HR_STAFFING_PLAN_ALREADY_APPROVED");
      const rewrite = await call(app, "POST", `/hr/properties/${A.propertyA}/staffing-plans`, rrhh, { year: 2026, season: "high", fromMonth: 5, toMonth: 10, lines: [{ usaliDepartment: "rooms", maxFte: "9.00" }] });
      assert.equal(rewrite.status, 409);
      const list = ok(await call(app, "GET", `/hr/properties/${A.propertyA}/staffing-plans?year=2026`, direccion), "plans");
      assert.equal((list.plans as Json[]).length, 1);
    }));

  it("previsión: generate escribe la ventana y GET labor-forecast la devuelve con degraded[]; KPIs y alertas con la forma del DTO", async () =>
    strict(async () => {
      // Reservas OTB sintéticas para que algún día tenga driver real.
      await prisma.reservation.create({ data: { propertyId: A.propertyA, code: `HR6-OTB-${A.run}`, channel: "direct", arrivalDate: addDays(TODAY, 0), departureDate: addDays(TODAY, 3), status: "confirmed", adults: 2, children: 0, roomsCount: 2, boardType: "BB", totalAmount: "400.00" } as never });
      assert.equal((await call(app, "POST", `/hr/properties/${A.propertyA}/labor-forecast/generate`, direccion, { from: key(0), to: key(6) })).status, 403, "dirección general no genera (workforce.schedule.manage)");
      const generated = ok(await call(app, "POST", `/hr/properties/${A.propertyA}/labor-forecast/generate`, rrhh, { from: key(0), to: key(6) }), "generate");
      assert.equal(generated.days, 7);
      assert.ok((generated.written as number) > 0, "escribe filas");
      assert.ok(Array.isArray(generated.degraded));
      const forecast = ok(await call(app, "GET", `/hr/properties/${A.propertyA}/labor-forecast?from=${key(0)}&to=${key(6)}`, direccion), "forecast");
      const rows = forecast.rows as Json[];
      assert.equal(rows.length, generated.written);
      assert.ok(rows.every((row) => typeof row.date === "string" && typeof row.usaliDepartment === "string" && "requiredFte" in row && "approvedFte" in row && "source" in row));
      assert.ok(rows.some((row) => row.usaliDepartment === "rooms" && row.approvedFte === "4.50"), "el máximo aprobado del plan llega a la previsión");
      assert.ok(Array.isArray(forecast.degraded));
      assert.equal(await prisma.laborForecast.count({ where: { propertyId: A.propertyA } }), rows.length);
      const kpis = ok(await call(app, "GET", `/hr/kpis?propertyId=${A.propertyA}&period=${PERIOD}`, direccion), "kpis");
      assert.equal(kpis.propertyId, A.propertyA);
      assert.equal(kpis.periodCode, PERIOD);
      assert.equal(typeof kpis.activeHeadcount, "number");
      assert.ok(Array.isArray(kpis.degraded));
      assert.equal((await call(app, "GET", `/hr/kpis?propertyId=${A.propertyA}`, recepcion)).status, 403);
      const alerts = ok(await call(app, "GET", `/hr/alerts?propertyId=${A.propertyA}`, direccion), "alerts");
      assert.ok(Array.isArray(alerts.alerts));
      assert.equal(alerts.propertyId, A.propertyA);
    }));

  it("ausencias: alta por /workforce/absences, lista /hr/absences?status, decisión con SoD y enmascarado de IT sin hr.employee.read", async () =>
    strict(async () => {
      const created = ok(await call(app, "POST", "/workforce/absences", gestor, { staffProfileId, absenceType: "vacation", startDate: `${key(10)}T00:00:00.000Z`, endDate: `${key(12)}T00:00:00.000Z`, reason: "Vacaciones de prueba" }, { "x-property-id": A.propertyA }), "alta ausencia", 200, 201);
      absenceId = created.id as string;
      const health = ok(await call(app, "POST", "/workforce/absences", gestor, { staffProfileId, absenceType: "it_common", startDate: `${key(20)}T00:00:00.000Z`, endDate: `${key(21)}T00:00:00.000Z`, reason: "Parte de baja" }, { "x-property-id": A.propertyA }), "alta IT", 200, 201);
      healthAbsenceId = health.id as string;

      const pending = await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}&status=pending`, gestor);
      const page = ok(pending, "lista pending");
      assert.equal(page.total, 2);
      assert.equal(pending.headers["x-total-count"], "2");
      assert.ok((page.items as Json[]).every((item) => (item.payload as Json).requestedBy === gestor.userId));
      // Quien la solicitó no la decide (409); otro gestor sí (200 y decidedAt).
      const self = await call(app, "POST", `/hr/absences/${absenceId}/decide`, gestor, { status: "approved" });
      assert.equal(self.status, 409, self.raw);
      assert.equal(detailsCode(self), "APPROVAL_SELF_DECISION");
      assert.equal((await call(app, "POST", `/hr/absences/${absenceId}/decide`, direccion, { status: "approved" })).status, 403, "sin workforce.schedule.manage");
      const decided = ok(await call(app, "POST", `/hr/absences/${absenceId}/decide`, rrhh, { status: "approved", note: "OK" }), "decide");
      assert.equal(decided.status, "approved");
      assert.equal((decided.payload as Json).approvedBy, rrhhUserId);
      assert.ok((decided.payload as Json).decidedAt);
      const approved = ok(await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}&status=approved`, gestor), "lista approved");
      assert.equal(approved.total, 1);
      // Tipo de salud: visible con hr.employee.read (manager la tiene), enmascarado para quien planifica el centro sin ella
      // (RF-03: con solo workforce.read la lista se ciñe a las fichas propias, así que el lector lleva workforce.schedule.manage).
      const hk = await addUser(A, "hk", { customKeys: ["workforce.read", "workforce.schedule.manage"] }, { scopeType: "property", propertyId: A.propertyA });
      const lector = await loginOrThrow(app, hk.email, A.password);
      const maskedReply = await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}&status=pending`, lector);
      const masked = ok(maskedReply, "lista lector");
      const maskedItem = (masked.items as Json[]).find((item) => item.id === healthAbsenceId)!;
      assert.equal((maskedItem.payload as Json).absenceType, null);
      assert.equal((maskedItem.payload as Json).restricted, true);
      assert.doesNotMatch(maskedReply.raw, /it_common|Parte de baja/);
      const visible = ok(await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}&status=pending`, gestor), "lista gestor");
      assert.equal(((visible.items as Json[]).find((item) => item.id === healthAbsenceId)!.payload as Json).absenceType, "it_common");
      assert.equal((await call(app, "GET", `/hr/absences?propertyId=${A.propertyA}&status=aprobada`, gestor)).status, 400);
    }));

  it("incidencias del mes: la alta del mes en JSON y en CSV (sin NIF); ámbito de centro y de sociedad", async () =>
    strict(async () => {
      const json = ok(await call(app, "GET", `/payroll/incidences?period=${PERIOD}&propertyId=${A.propertyA}`, rrhh), "incidencias json");
      assert.equal(json.periodCode, PERIOD);
      const rows = json.rows as Json[];
      const hire = rows.find((row) => row.employeeId === employeeId && row.kind === "hire");
      assert.ok(hire, "la alta del mes figura");
      assert.equal(hire!.employeeNumber, employeeNumber);
      assert.equal(hire!.code, "sin_contrato");
      const csv = await call(app, "GET", `/payroll/incidences?period=${PERIOD}&propertyId=${A.propertyA}&format=csv`, rrhh);
      const body = ok(csv, "incidencias csv");
      assert.equal(body.contentType, "text/csv");
      assert.match(String(body.filename), /^incidencias-\d{4}-\d{2}-l2a\.csv$/);
      assert.match(String(body.text), /^﻿centro;numero_empleado;empleado;tipo;codigo;desde;hasta;dias;horas;detalle\n/);
      assert.match(String(body.text), new RegExp(`\\nL2A;${employeeNumber};Prueba Expediente;hire;sin_contrato;`));
      assertNoPii(csv.raw, "incidencias csv", [TAX_ID, IBAN, "600000001", "prueba.expediente@"]);
      const entity = ok(await call(app, "GET", `/payroll/incidences?period=${PERIOD}`, rrhh), "incidencias sociedad");
      assert.equal(entity.propertyId, null);
      assert.ok((entity.rows as Json[]).some((row) => row.employeeId === employeeId));
      await flushAuditQueues();
      const audits = await prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, action: "PAYROLL_INCIDENCES_EXPORTED" } });
      assert.equal(audits.length, 3);
      assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${TAX_ID}|${employeeNumber}|Expediente`));
    }));

  it("SEC-01 · ficha enlazada al expediente por HTTP (POST /payroll/staff-profiles { employeeId }); RF-05 · POST /payroll/contracts avisa HR_STAFFING_EXCEEDED sobre el plan aprobado y RF-07 · del segundo contrato activo; SEC-02 · GET /workforce/properties/:p/staff-profiles con workforce.read sin coste ni correo", async () =>
    strict(async () => {
      // Expediente de OTRA organización → 404 opaco; nada escrito.
      const foreign = await call(app, "POST", "/payroll/staff-profiles", rrhh, { propertyId: A.propertyA, userId: A.users.generalManager.id, employeeId: employeeIdB });
      assert.equal(foreign.status, 404, foreign.raw);
      const profile = ok(await call(app, "POST", "/payroll/staff-profiles", rrhh, { propertyId: A.propertyA, userId: A.users.generalManager.id, employeeId, employeeCode: "HR6-EMP" }), "ficha enlazada", 201);
      linkedProfileId = profile.id as string;
      assert.equal(profile.employeeId, employeeId);
      const stored = await prisma.staffProfile.findUnique({ where: { id: linkedProfileId }, select: { employeeId: true, usaliDepartment: true, jobTitle: true } });
      assert.equal(stored?.employeeId, employeeId, "SELECT: employee_id persistido");
      assert.equal(stored?.usaliDepartment, "rooms", "hereda el departamento USALI del expediente");
      const detail = ok(await call(app, "GET", `/hr/employees/${employeeId}`, rrhh), "detalle con ficha");
      assert.ok((detail.staffProfileIds as string[]).includes(linkedProfileId), "el expediente ve su ficha");

      // Position control: plan aprobado rooms 4,50 FTE; cinco contratos a jornada completa sobre la ficha → el 5.º avisa (nunca bloquea).
      const warningsBy: string[][] = [];
      for (let n = 1; n <= 5; n += 1) {
        const contract = ok(await call(app, "POST", "/payroll/contracts", rrhh, { staffProfileId: linkedProfileId, propertyId: A.propertyA, contractType: "indefinido", startDate: key(-1), grossSalary: 1500, partTimePct: 100 }), `contrato ${n}`, 200, 201);
        warningsBy.push((contract.warnings as string[] | undefined) ?? []);
      }
      assert.deepEqual(warningsBy[0], [], "el primer contrato no avisa");
      assert.ok(warningsBy[1]!.some((warning) => /otro contrato activo/.test(warning)), "RF-07: segundo contrato activo sobre la misma ficha");
      assert.equal(warningsBy[3]!.some((warning) => /plantilla máxima aprobada/.test(warning)), false, "4 FTE ≤ 4,50: sin aviso de position control");
      assert.ok(warningsBy[4]!.some((warning) => /plantilla máxima aprobada/.test(warning) && /5\.00 FTE frente a 4\.50 aprobados/.test(warning)), `RF-05: ${JSON.stringify(warningsBy[4])}`);
      const withContracts = ok(await call(app, "GET", `/hr/employees/${employeeId}`, rrhh), "detalle con contratos");
      assert.equal((withContracts.contracts as Json[]).length, 5);
      assert.ok(withContracts.contract, "contrato vigente en el resumen");
      const kpis = ok(await call(app, "GET", `/hr/kpis?propertyId=${A.propertyA}&period=${PERIOD}`, direccion), "kpis tras los contratos");
      assert.equal(kpis.activeHeadcount, 1, "RF-07: cinco contratos, una persona");
      assert.equal(kpis.activeFte, "5.00");

      // SEC-02: la lista de fichas para fichar (workforce.read) sin coste hora ni correo; otra organización → 404.
      const workforceList = await call(app, "GET", `/workforce/properties/${A.propertyA}/staff-profiles`, pisos);
      const fichas = ok(workforceList, "fichas del centro") as unknown as Json[];
      assert.ok(fichas.some((row) => row.id === staffProfileId) && fichas.some((row) => row.id === linkedProfileId));
      assert.doesNotMatch(workforceList.raw, /hourlyCost|userEmail/);
      assert.ok(fichas.every((row) => "employeeId" in row && "userFullName" in row));
      assert.equal((await call(app, "GET", `/workforce/properties/${A.propertyA}/staff-profiles`, rrhhB)).status, 404);
      assert.equal((await call(app, "GET", `/workforce/properties/${A.propertyA}/staff-profiles`, recepcion)).status, 403, "recepción no tiene workforce.read (no ve Personal y turnos)");
      assert.equal((await call(app, "GET", `/payroll/staff-profiles?propertyId=${A.propertyA}`, pisos)).status, 403, "la lista de nómina sigue exigiendo payroll.read");
    }));

  it("baja del expediente (critical): 200 con contratos y fichas; segunda baja 409; GET /payroll/periods lleva mode y closedAt", async () =>
    strict(async () => {
      const terminated = ok(await call(app, "POST", `/hr/employees/${employeeId}/terminate`, rrhh, { reason: "resignation", terminatedAt: key(0) }), "terminate");
      assert.equal((terminated.employee as Json).status, "inactive");
      assert.ok(Array.isArray(terminated.deactivatedContractIds));
      // SEC-01: la ficha enlazada por HTTP cae con el expediente y sus contratos se cierran.
      assert.equal((terminated.deactivatedContractIds as string[]).length, 5, "los cinco contratos de la ficha enlazada se cierran");
      assert.ok((terminated.deactivatedStaffProfileIds as string[]).includes(linkedProfileId));
      assert.equal((await prisma.staffProfile.findUnique({ where: { id: linkedProfileId }, select: { active: true } }))?.active, false);
      assert.equal(await prisma.employmentContract.count({ where: { staffProfileId: linkedProfileId, active: true } }), 0);
      const again = await call(app, "POST", `/hr/employees/${employeeId}/terminate`, rrhh, {});
      assert.equal(again.status, 409);
      assert.equal(detailsCode(again), "HR_EMPLOYEE_TERMINATED");
      const inc = ok(await call(app, "GET", `/payroll/incidences?period=${PERIOD}&propertyId=${A.propertyA}`, rrhh), "incidencias tras baja");
      assert.ok((inc.rows as Json[]).some((row) => row.employeeId === employeeId && row.kind === "termination" && row.code === "resignation"));

      const created = ok(await call(app, "POST", "/payroll/periods", rrhh, { periodCode: "2026-08" }), "periodo", 200, 201);
      assert.equal(created.mode, "external");
      assert.equal(created.closedAt, null);
      const periods = ok(await call(app, "GET", "/payroll/periods", rrhh), "periodos") as unknown as Json[];
      const mine = periods.find((row) => row.id === created.id)!;
      assert.equal(mine.mode, "external");
      assert.equal(mine.closedAt, null);
    }));
});
