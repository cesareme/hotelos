/**
 * RRHH · expediente, convenios y contratos ampliados (Tanda RRHH · RRHH-2) — integración
 * (Postgres, por SERVICIO: las rutas /hr llegan con RRHH-6) sobre un tenant AISLADO
 * (helpers/l2-tenant.mts, `org_l2_<run>`); nombres y NIF INVENTADOS (letra válida
 * calculada); en Faranda no se escribe nada.
 *
 *   · seedAgreementCatalog siembra los 4 convenios (21 reglas cada uno) y es idempotente;
 *     assignAgreementToProperty + resolveAgreementForProperty: contrato > centro > null;
 *   · alta de expediente: en la tabla `employees` el NIF, el correo y el IBAN quedan
 *     como envelope `v1.…` (SELECT crudo) con `tax_id_lookup_hash` HMAC; el DTO no
 *     lleva PII; el listado tampoco (ni la consulta los selecciona);
 *   · el mismo NIF (otro formato) en la sociedad → 409 HR_EMPLOYEE_TAXID_DUPLICATE; en
 *     otra sociedad de la organización se admite;
 *   · get: desde otra organización o con el centro fuera del ámbito → 404 OPACO
 *     (HR_EMPLOYEE_NOT_FOUND, sin distinguir «no existe» de «no es tuyo»); sin
 *     hr.employee.manage nunca NIF/NAF/IBAN; con manage y `pii` → descifrado y auditoría
 *     HR_PII_READ persistida SIN datos personales;
 *   · contrato: payCount por defecto = 12 + extra_pay_count (centro ES-15-HOST → 15;
 *     contrato ES-28-HOSP → 14); jornada, % de jornada, fijo discontinuo y grupo de
 *     cotización persistidos; convenio ajeno → 404;
 *   · baja en cascada: ficha inactiva, contrato cerrado (endDate/endReason), asignación
 *     RBAC del usuario terminada, HR_EMPLOYEE_TERMINATED; segunda baja → 409.
 *
 * Ejecutar desde apps/api:
 *   node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/hr-employees.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Sin .env → valores de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
// El cifrado de PII exige una clave base64 de 32 bytes: si el entorno no la trae válida,
// se fija una de prueba (HOTELOS_FIELD_KEY prevalece sobre ENCRYPTION_KEY en crypto-fields).
const configuredKey = process.env.HOTELOS_FIELD_KEY ?? process.env.ENCRYPTION_KEY ?? "";
if (Buffer.from(configuredKey, "base64").length !== 32) process.env.HOTELOS_FIELD_KEY = Buffer.alloc(32, 7).toString("base64");
delete process.env.STRUCTURE_ENABLED;

const { prisma } = await import("@hotelos/database");
const { HR_AGREEMENT_RULE_KEYS, HR_PII_FIELDS } = await import("@hotelos/shared");
const tenantHelpers = await import("./helpers/l2-tenant.mts");
const employees = await import("../../apps/api/src/modules/hr/employees.service.js");
const agreements = await import("../../apps/api/src/modules/hr/agreements.service.js");
const contracts = await import("../../apps/api/src/modules/payroll/contracts.service.js");
const { hrErrorCodeOf } = await import("../../apps/api/src/modules/hr/hr-errors.js");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

const { createIsolatedTenant, cleanupTenant, newRunId, cifFor } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;

const RUN = `hr2${newRunId()}`;
const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
/** NIF sintético (letra de control válida), nunca de una persona real. */
const nif = (digits: number) => {
  const body = String(digits).padStart(8, "0");
  return `${body}${NIF_LETTERS[Number(body) % 23]}`;
};

let tenant: IsolatedTenant;
let secondLegalEntityId: string;
let rrhh: UserContext;
let reader: UserContext;
let readerHbOnly: UserContext;
let stranger: UserContext;
let employeeId = "";
let staffProfileId = "";
let contractId = "";
let agreementIdByCode: Record<string, string> = {};

const context = (overrides: Record<string, unknown>): UserContext =>
  ({
    organizationId: tenant.organizationId,
    propertyId: tenant.propertyA,
    userId: tenant.users.owner.id,
    fullName: "RRHH L2",
    deviceId: "hr-employees-test",
    permissions: ["hr.employee.read", "hr.employee.manage", "hr.config.manage", "payroll.manage", "payroll.read"],
    orgScope: true,
    ...overrides
  }) as unknown as UserContext;

async function rejects(promise: Promise<unknown>): Promise<InstanceType<typeof HttpError>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `HttpError esperado, llegó ${String(error)}`);
    return error;
  }
  throw new Error("no lanzó");
}

describe("RRHH-2 · expediente, convenios y contratos (tenant aislado)", () => {
  before(async () => {
    tenant = await createIsolatedTenant(RUN);
    rrhh = context({});
    reader = context({ permissions: ["hr.employee.read"] });
    readerHbOnly = context({ permissions: ["hr.employee.read"], assignedPropertyIds: [tenant.propertyB], orgScope: false });
    stranger = context({ organizationId: `org_l2_ajena_${RUN}` });
    secondLegalEntityId = `le_l2_2_${RUN}`;
    await prisma.legalEntity.create({
      data: { id: secondLegalEntityId, organizationId: tenant.organizationId, code: "L2B", legalName: `L2 Test ${RUN} Dos SL`, taxId: cifFor("A", RUN.length * 7919 + 13), fiscalAddress: "Calle Real 2", fiscalPostalCode: "15001", isDefault: false }
    });
  });

  after(async () => {
    await flushAuditQueues();
    if (tenant) await cleanupTenant(tenant.organizationId);
    await prisma.$disconnect();
  });

  it("siembra el catálogo de convenios (4 × 21 reglas), es idempotente y resuelve contrato > centro > null", async () => {
    const first = await agreements.seedAgreementCatalog({ organizationId: tenant.organizationId, actorUserId: rrhh.userId, correlationId: `corr_${RUN}` });
    assert.deepEqual(first.created.map((row) => row.code), ["ES-15-HOST", "ES-33-HOST", "ES-39-HOST", "ES-28-HOSP"]);
    assert.equal(await prisma.collectiveAgreement.count({ where: { organizationId: tenant.organizationId } }), 4);
    assert.equal(await prisma.agreementRule.count({ where: { agreementId: { in: first.created.map((row) => row.id) } } }), 4 * HR_AGREEMENT_RULE_KEYS.length);
    const second = await agreements.seedAgreementCatalog({ organizationId: tenant.organizationId });
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 4);
    agreementIdByCode = Object.fromEntries(first.created.map((row) => [row.code, row.id]));

    await agreements.assignAgreementToProperty({ context: rrhh, propertyId: tenant.propertyA, agreementId: agreementIdByCode["ES-15-HOST"]!, correlationId: `corr_${RUN}` });
    const byProperty = await agreements.resolveAgreementForProperty({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, asOf: "2026-08-01" });
    assert.equal(byProperty.source, "property");
    assert.equal(byProperty.agreement?.code, "ES-15-HOST");
    assert.equal(byProperty.rules.annual_hours, 1792);
    assert.equal(byProperty.rules.extra_pay_count, 3);
    const byContract = await agreements.resolveAgreementForProperty({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, contractAgreementId: agreementIdByCode["ES-28-HOSP"] });
    assert.equal(byContract.source, "contract");
    assert.equal(byContract.rules.annual_hours, 1800);
    const none = await agreements.resolveAgreementForProperty({ organizationId: tenant.organizationId, propertyId: tenant.propertyB });
    assert.deepEqual(none, { agreement: null, rules: {}, source: null });

    const listed = await agreements.listAgreements({ context: reader });
    assert.deepEqual(listed.find((row) => row.code === "ES-15-HOST")?.propertyIds, [tenant.propertyA]);
    // Versión futura de una regla: vigente solo desde su validFrom.
    await agreements.putAgreementRules({ context: rrhh, agreementId: agreementIdByCode["ES-15-HOST"]!, rules: [{ key: "annual_hours", value: 1780, validFrom: "2027-01-01" }], correlationId: `corr_${RUN}` });
    assert.equal((await agreements.resolveAgreementForProperty({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, asOf: "2026-12-31" })).rules.annual_hours, 1792);
    assert.equal((await agreements.resolveAgreementForProperty({ organizationId: tenant.organizationId, propertyId: tenant.propertyA, asOf: "2027-01-01" })).rules.annual_hours, 1780);
  });

  it("alta: la fila queda cifrada en SELECT (envelope v1. + hash de búsqueda) y el DTO no lleva PII", async () => {
    const created = await employees.createEmployee({
      context: rrhh,
      body: {
        legalEntityId: tenant.legalEntityId,
        firstName: "Persona",
        lastName: "Alfa Prueba",
        taxId: " 12.345.678-z ",
        email: "Alfa@hr.test",
        phone: "600 000 001",
        iban: "ES91 2100 0418 4502 0005 1332",
        socialSecurityNumber: "28/1234567890",
        gender: "female",
        hiredAt: "2026-02-01",
        primaryPropertyId: tenant.propertyA,
        usaliDepartment: "rooms",
        jobTitle: "Camarera de pisos"
      },
      correlationId: `corr_${RUN}`
    });
    employeeId = created.id;
    assert.equal(created.employeeNumber, "0001");
    assert.equal(created.pii, null);
    assert.deepEqual(created.piiFields, [...HR_PII_FIELDS]);
    assert.equal(created.propertyCode, "L2A");
    const serialised = JSON.stringify(created);
    for (const value of ["12345678Z", "alfa@hr.test", "600 000 001", "ES9121000418450200051332", "281234567890"]) assert.ok(!serialised.includes(value), `PII en el DTO: ${value}`);

    const raw = await prisma.$queryRaw<Array<{ tax_id: string; tax_id_lookup_hash: string | null; email: string | null; iban: string | null; first_name: string }>>`
      SELECT tax_id, tax_id_lookup_hash, email, iban, first_name FROM employees WHERE id = ${employeeId}`;
    assert.equal(raw.length, 1);
    assert.match(raw[0]!.tax_id, /^v1\.[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/, "NIF cifrado en reposo");
    assert.ok(!raw[0]!.tax_id.includes("12345678"));
    assert.match(raw[0]!.tax_id_lookup_hash ?? "", /^[0-9a-f]{64}$/, "hash HMAC del NIF");
    assert.match(raw[0]!.email ?? "", /^v1\./);
    assert.match(raw[0]!.iban ?? "", /^v1\./);
    assert.equal(raw[0]!.first_name, "Persona", "el nombre queda en claro para listados");

    // El listado no lleva PII y no la selecciona.
    const listed = await employees.listEmployees({ context: reader, query: { propertyId: tenant.propertyA, search: "alfa" } });
    assert.equal(listed.length, 1);
    for (const field of HR_PII_FIELDS) assert.ok(!(field in listed[0]!), `campo PII ${field} en el listado`);
    assert.ok(!JSON.stringify(listed).includes("12345678Z"));
    assert.deepEqual(await employees.listEmployees({ context: reader, query: { status: "leave" } }), []);

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: tenant.organizationId, action: "HR_EMPLOYEE_CREATED", entityId: employeeId } });
    assert.ok(audit, "HR_EMPLOYEE_CREATED persistido");
    const afterJson = JSON.stringify(audit.afterJson);
    for (const value of ["12345678Z", "alfa@hr.test", "ES91", "281234567890"]) assert.ok(!afterJson.includes(value), `PII en auditoría: ${value}`);
  });

  it("duplicado por NIF (otro formato) en la sociedad → 409; en otra sociedad de la organización se admite", async () => {
    const duplicate = await rejects(
      employees.createEmployee({ context: rrhh, body: { legalEntityId: tenant.legalEntityId, firstName: "Otra", lastName: "Persona", taxId: "12345678z", hiredAt: "2026-03-01" }, correlationId: `corr_${RUN}` })
    );
    assert.equal(duplicate.statusCode, 409);
    assert.equal(hrErrorCodeOf(duplicate), "HR_EMPLOYEE_TAXID_DUPLICATE");
    assert.equal((duplicate.details as { employeeId: string }).employeeId, employeeId);
    const other = await employees.createEmployee({ context: rrhh, body: { legalEntityId: secondLegalEntityId, firstName: "Persona", lastName: "Beta Prueba", taxId: "12345678Z", hiredAt: "2026-03-01" }, correlationId: `corr_${RUN}` });
    assert.equal(other.legalEntityId, secondLegalEntityId);
    assert.equal(other.employeeNumber, "0001", "numeración por sociedad");
    assert.equal(await prisma.employee.count({ where: { organizationId: tenant.organizationId } }), 2);
    const invalid = await rejects(employees.createEmployee({ context: rrhh, body: { legalEntityId: tenant.legalEntityId, firstName: "X", lastName: "Y", taxId: "12345678A", hiredAt: "2026-03-01" }, correlationId: `corr_${RUN}` }));
    assert.equal(hrErrorCodeOf(invalid), "HR_TAXID_INVALID");
  });

  it("get: fuera de la organización o del ámbito → 404 opaco; sin hr.employee.manage nunca NIF/IBAN; con manage y pii → descifrado + HR_PII_READ sin datos", async () => {
    const foreign = await rejects(employees.getEmployee({ context: stranger, employeeId, pii: true }));
    assert.equal(foreign.statusCode, 404);
    assert.equal(hrErrorCodeOf(foreign), "HR_EMPLOYEE_NOT_FOUND");
    const missing = await rejects(employees.getEmployee({ context: rrhh, employeeId: `emp_inexistente_${RUN}` }));
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.message, foreign.message, "misma respuesta opaca");
    assert.equal(hrErrorCodeOf(await rejects(employees.getEmployee({ context: readerHbOnly, employeeId, pii: true }))), "HR_EMPLOYEE_NOT_FOUND");

    const partial = await employees.getEmployee({ context: reader, employeeId, pii: true, correlationId: `corr_${RUN}_read` });
    assert.deepEqual(partial.piiFields, ["email", "phone"]);
    assert.deepEqual(partial.pii, { taxId: null, socialSecurityNumber: null, email: "alfa@hr.test", phone: "600 000 001", iban: null });

    const plain = await employees.getEmployee({ context: rrhh, employeeId });
    assert.equal(plain.pii, null, "sin `pii` no se descifra nada");

    const full = await employees.getEmployee({ context: rrhh, employeeId, pii: true, correlationId: `corr_${RUN}_manage` });
    assert.equal(full.pii?.taxId, "12345678Z");
    assert.equal(full.pii?.iban, "ES9121000418450200051332");
    assert.equal(full.pii?.socialSecurityNumber, "281234567890");
    assert.equal(full.gender, "female");

    await flushAuditQueues();
    const reads = await prisma.auditEvent.findMany({ where: { organizationId: tenant.organizationId, action: "HR_PII_READ", entityId: employeeId }, orderBy: { createdAt: "asc" } });
    assert.equal(reads.length, 2, "una lectura auditada por cada petición con pii");
    const serialised = JSON.stringify(reads.map((row) => row.afterJson));
    for (const value of ["12345678Z", "alfa@hr.test", "600 000 001", "ES9121000418450200051332", "281234567890"]) assert.ok(!serialised.includes(value), `PII en HR_PII_READ: ${value}`);
    assert.deepEqual((reads[0]!.afterJson as { fields: string[] }).fields, ["email", "phone"]);
    assert.deepEqual((reads[1]!.afterJson as { fields: string[] }).fields, [...HR_PII_FIELDS]);
  });

  it("contrato: payCount = 12 + extra_pay_count del convenio (centro ES-15-HOST → 15; contrato ES-28-HOSP → 14) y campos nuevos persistidos", async () => {
    const profile = await prisma.staffProfile.create({
      data: { userId: tenant.users.receptionist.id, propertyId: tenant.propertyA, employeeCode: `HR2-${RUN}`, employeeId, usaliDepartment: "rooms", jobTitle: "Camarera de pisos", active: true },
      select: { id: true }
    });
    staffProfileId = profile.id;
    const contract = await contracts.createContract({
      context: rrhh,
      staffProfileId,
      propertyId: tenant.propertyA,
      contractType: "indefinido",
      startDate: "2026-02-01",
      grossSalary: 1800,
      irpfRatePct: 15,
      weeklyHours: 40,
      partTimePct: 100,
      contributionGroup: 7,
      correlationId: `corr_${RUN}`
    });
    contractId = contract.id;
    assert.equal(contract.payCount, 15, "12 + 3 pagas extra de Hostelería A Coruña");
    assert.equal(contract.agreementId, undefined, "el convenio del centro no se copia al contrato");
    assert.equal(contract.weeklyHours, 40);
    assert.equal(contract.partTimePct, 100);
    assert.equal(contract.contributionGroup, 7);
    assert.equal(contract.fixedDiscontinuous, false);
    const stored = await prisma.employmentContract.findUnique({ where: { id: contractId } });
    assert.equal(stored?.payCount, 15);
    assert.equal(stored?.weeklyHours?.toFixed(2), "40.00");
    assert.equal(stored?.partTimePct?.toFixed(2), "100.00");
    assert.equal(stored?.contributionGroup, 7);

    const madrid = await contracts.createContract({
      context: rrhh,
      staffProfileId,
      propertyId: tenant.propertyA,
      contractType: "fijo_discontinuo",
      startDate: "2026-04-01",
      endDate: "2026-10-31",
      grossSalary: 1500,
      agreementId: agreementIdByCode["ES-28-HOSP"],
      partTimePct: 50,
      correlationId: `corr_${RUN}`
    });
    assert.equal(madrid.payCount, 14, "12 + 2 pagas del convenio del contrato (prevalece sobre el centro)");
    assert.equal(madrid.agreementId, agreementIdByCode["ES-28-HOSP"]);
    assert.equal(madrid.fixedDiscontinuous, true, "fijo_discontinuo marca el flag por defecto");
    assert.equal(madrid.partTimePct, 50);
    await contracts.deactivateContract({ context: rrhh, contractId: madrid.id, correlationId: `corr_${RUN}`, endDate: "2026-06-30", endReason: "end_of_term" });
    const closed = await prisma.employmentContract.findUnique({ where: { id: madrid.id } });
    assert.equal(closed?.active, false);
    assert.equal(closed?.endDate?.toISOString().slice(0, 10), "2026-06-30");
    assert.equal(closed?.endReason, "end_of_term");

    const foreignAgreement = await rejects(
      contracts.createContract({ context: rrhh, staffProfileId, propertyId: tenant.propertyA, contractType: "temporal", startDate: "2026-05-01", grossSalary: 1200, agreementId: `agr_ajeno_${RUN}`, correlationId: `corr_${RUN}` })
    );
    assert.equal(foreignAgreement.statusCode, 404);
    assert.equal(hrErrorCodeOf(foreignAgreement), "HR_AGREEMENT_NOT_FOUND");
    assert.equal((await rejects(contracts.createContract({ context: rrhh, staffProfileId, propertyId: tenant.propertyA, contractType: "temporal", startDate: "2026-05-01", grossSalary: 1200, weeklyHours: 80, correlationId: `corr_${RUN}` }))).statusCode, 400);

    const detail = await employees.getEmployee({ context: reader, employeeId });
    assert.deepEqual(detail.staffProfileIds, [staffProfileId]);
    assert.equal(detail.contract?.id, contractId);
    assert.equal(detail.contract?.agreementCode, null);
    assert.equal(detail.contracts.length, 2);
    assert.equal(detail.contracts[1]!.agreementCode, "ES-28-HOSP");
    assert.equal(detail.contracts[1]!.fixedDiscontinuous, true);
    assert.deepEqual((await employees.listEmployees({ context: reader, query: { fixedDiscontinuous: true } })).map((row) => row.id), [], "el fijo discontinuo ya no es el contrato vigente");
  });

  it("baja en cascada: ficha inactiva, contrato cerrado con fecha y causa, acceso revocado, HR_EMPLOYEE_TERMINATED; segunda baja → 409", async () => {
    // deactivateContract (Tanda 8a «baja inmediata») ya terminó la asignación de la recepcionista al
    // cerrar el contrato fijo discontinuo del caso anterior: se le da una nueva para verificar la cascada.
    await prisma.userRoleAssignment.create({
      data: { userId: tenant.users.receptionist.id, roleId: tenant.roles[tenant.users.receptionist.templateKey]!, scopeType: "property", propertyId: tenant.propertyA, organizationId: tenant.organizationId, reason: `hr2 baja ${RUN}` }
    });
    const liveBefore = await prisma.userRoleAssignment.count({ where: { userId: tenant.users.receptionist.id, organizationId: tenant.organizationId, revokedAt: null, validTo: null } });
    assert.ok(liveBefore >= 1, "la recepcionista tiene asignación viva antes de la baja");

    const result = await employees.terminateEmployee({ context: rrhh, employeeId, terminatedAt: "2026-09-30", reason: "resignation", correlationId: `corr_${RUN}_baja` });
    assert.equal(result.employee.status, "inactive");
    assert.equal(result.employee.terminatedAt, "2026-09-30");
    assert.equal(result.employee.terminationReason, "resignation");
    assert.deepEqual(result.deactivatedStaffProfileIds, [staffProfileId]);
    assert.deepEqual(result.deactivatedContractIds, [contractId]);

    const profile = await prisma.staffProfile.findUnique({ where: { id: staffProfileId } });
    assert.equal(profile?.active, false);
    const contract = await prisma.employmentContract.findUnique({ where: { id: contractId } });
    assert.equal(contract?.active, false);
    assert.equal(contract?.endDate?.toISOString().slice(0, 10), "2026-09-30");
    assert.equal(contract?.endReason, "resignation");
    const stored = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true, terminatedAt: true, terminationReason: true } });
    assert.equal(stored?.status, "inactive");
    assert.equal(stored?.terminatedAt?.toISOString().slice(0, 10), "2026-09-30");
    const liveAfter = await prisma.userRoleAssignment.count({ where: { userId: tenant.users.receptionist.id, organizationId: tenant.organizationId, revokedAt: null, validTo: null } });
    assert.equal(liveAfter, 0, "deactivateContract termina las asignaciones del usuario de la ficha");

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: tenant.organizationId, action: "HR_EMPLOYEE_TERMINATED", entityId: employeeId } });
    assert.ok(audit);
    assert.deepEqual((audit.afterJson as { deactivatedContractIds: string[] }).deactivatedContractIds, [contractId]);
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenant.organizationId, action: "EMPLOYMENT_CONTRACT_DEACTIVATED", entityId: contractId } }), 1);

    const again = await rejects(employees.terminateEmployee({ context: rrhh, employeeId, correlationId: `corr_${RUN}` }));
    assert.equal(again.statusCode, 409);
    assert.equal(hrErrorCodeOf(again), "HR_EMPLOYEE_TERMINATED");
    assert.equal(hrErrorCodeOf(await rejects(employees.patchEmployee({ context: rrhh, employeeId, body: { jobTitle: "x" }, correlationId: `corr_${RUN}` }))), "HR_EMPLOYEE_TERMINATED");
    assert.deepEqual((await employees.listEmployees({ context: reader, query: { status: "inactive" } })).map((row) => row.id), [employeeId]);
  });
});
