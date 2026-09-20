// Unit tests · Tanda RRHH · RRHH-2 — expediente de empleado (hr/employees.service.ts).
// Sin base de datos: fakes en memoria por `deps`; nombres y NIF INVENTADOS (letra válida
// calculada, nunca de una persona real). Desde apps/api:
//   node --import tsx --test src/modules/hr/__tests__/employees.test.mts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { HR_PII_FIELDS, PermissionDeniedError } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { hrErrorCodeOf } from "../hr-errors.js";
import {
  EMPLOYEE_PUBLIC_SELECT,
  HR_PII_READ_AUDIT_WINDOW_MS,
  createEmployee,
  getEmployee,
  resetPiiReadAuditWindowForTests,
  shouldAuditPiiRead,
  isValidSpanishTaxId,
  listEmployees,
  normaliseTaxId,
  patchEmployee,
  terminateEmployee,
  type EmployeeDeps,
  type EmployeeRow
} from "../employees.service.js";

type AuditCall = Parameters<EmployeeDeps["audit"]>[0];

const ORG = "org_hr_test";
const OTHER_ORG = "org_hr_other";
const LE = "le_hr_test";
const LE2 = "le_hr_test_2";
const HA = "prop_hr_ha";
const HB = "prop_hr_hb";
const FOREIGN = "prop_hr_foreign";
const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** NIF sintético con letra de control válida (nunca de una persona real). */
function nif(digits: number): string {
  const body = String(digits).padStart(8, "0");
  return `${body}${NIF_LETTERS[Number(body) % 23]}`;
}

const manager = {
  organizationId: ORG,
  propertyId: HA,
  userId: "usr_hr_rrhh",
  fullName: "RRHH Test",
  deviceId: "hr-test",
  permissions: ["hr.employee.read", "hr.employee.manage", "payroll.manage"],
  orgScope: true
} as unknown as UserContext;
const reader = { ...manager, permissions: ["hr.employee.read"] } as unknown as UserContext;
const readerHaOnly = { ...reader, assignedPropertyIds: [HA], orgScope: false } as unknown as UserContext;
const stranger = { ...manager, organizationId: OTHER_ORG } as unknown as UserContext;
const nobody = { ...manager, permissions: ["payroll.read"] } as unknown as UserContext;

const fakeHash = (plaintext: string) => createHmac("sha256", "hr-test-key").update(plaintext.trim().toLowerCase()).digest("hex");

/** Evalúa un `where` de Prisma con los operadores que usa el servicio (igualdad, in, contains, OR, not). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const op = cond as Record<string, unknown>;
      if ("in" in op) {
        if (!(op.in as unknown[]).includes(value)) return false;
        continue;
      }
      if ("contains" in op) {
        const hay = String(value ?? "");
        const needle = String(op.contains);
        if (!(op.mode === "insensitive" ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle))) return false;
        continue;
      }
      if ("not" in op) {
        if (value === op.not) return false;
        continue;
      }
      throw new Error(`fake: operador no soportado en ${key}`);
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

type Profile = { id: string; employeeId: string | null; propertyId: string; userId: string; active: boolean };
type Contract = {
  id: string;
  staffProfileId: string;
  propertyId: string | null;
  contractType: string;
  startDate: Date;
  endDate: Date | null;
  payCount: number;
  active: boolean;
  agreementId: string | null;
  weeklyHours: string | null;
  partTimePct: string | null;
  fixedDiscontinuous: boolean;
  contributionGroup: number | null;
  endReason?: string | null;
};

function fakeDeps(seed: { employees?: EmployeeRow[]; profiles?: Profile[]; contracts?: Contract[]; assignments?: Record<string, string[]>; withKey?: boolean } = {}) {
  const employees: EmployeeRow[] = [...(seed.employees ?? [])];
  const profiles: Profile[] = [...(seed.profiles ?? [])];
  const contracts: Contract[] = [...(seed.contracts ?? [])];
  const assignments = new Map(Object.entries(seed.assignments ?? {}));
  const withKey = seed.withKey ?? true;
  const audits: AuditCall[] = [];
  const selects: unknown[] = [];
  const deactivations: Array<{ contractId: string; endDate?: string; endReason?: string }> = [];
  const revocations: string[] = [];
  let seq = 0;
  const now = new Date("2026-09-20T10:00:00Z");
  const stamp = (row: Partial<EmployeeRow> & { taxId: string }) => {
    // Simula la extensión Prisma: hash de búsqueda del NIF (el cifrado se comprueba en integración).
    row.taxIdLookupHash = withKey ? fakeHash(row.taxId) : null;
  };
  const deps: EmployeeDeps = {
    db: {
      employee: {
        findMany: async ({ where, select }) => {
          selects.push(select);
          return employees.filter((row) => matches(row as unknown as Record<string, unknown>, where as Record<string, unknown>)).map((row) => ({ ...row }));
        },
        findFirst: async ({ where }) => {
          const row = employees.find((candidate) => matches(candidate as unknown as Record<string, unknown>, where as Record<string, unknown>));
          return row ? { ...row } : null;
        },
        count: async ({ where }) => employees.filter((row) => matches(row as unknown as Record<string, unknown>, where as Record<string, unknown>)).length,
        create: async ({ data }) => {
          const row = { id: `emp_${++seq}`, createdAt: now, updatedAt: now, terminatedAt: null, terminationReason: null, taxIdLookupHash: null, ...data } as EmployeeRow;
          stamp(row);
          employees.push(row);
          return { ...row };
        },
        update: async ({ where, data }) => {
          const row = employees.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error("fake: employee not found");
          Object.assign(row, data, { updatedAt: new Date(now.getTime() + 1000) });
          if (data.taxId !== undefined) stamp(row);
          return { ...row };
        }
      },
      legalEntity: { findFirst: async ({ where }) => ([LE, LE2].includes(where.id) && where.organizationId === ORG ? { id: where.id } : null) },
      user: { findFirst: async ({ where }) => (["usr_hr_a", "usr_hr_b"].includes(where.id) && where.organizationId === ORG ? { id: where.id } : null) },
      property: {
        findFirst: async ({ where }) => {
          const all = [
            { id: HA, organizationId: ORG, code: "HA", name: "Hotel Alfa" },
            { id: HB, organizationId: ORG, code: "HB", name: "Hotel Beta" },
            { id: FOREIGN, organizationId: OTHER_ORG, code: "FX", name: "Hotel Ajeno" }
          ];
          const row = all.find((property) => property.id === where.id && property.organizationId === where.organizationId);
          return row ? { id: row.id, code: row.code, name: row.name } : null;
        },
        findMany: async ({ where }) => (where.organizationId === ORG ? [{ id: HA, code: "HA", name: "Hotel Alfa" }, { id: HB, code: "HB", name: "Hotel Beta" }] : [])
      },
      staffProfile: {
        findMany: async ({ where }) => profiles.filter((row) => (typeof where.employeeId === "string" ? row.employeeId === where.employeeId : where.employeeId.in.includes(row.employeeId ?? ""))).map((row) => ({ ...row })),
        updateMany: async ({ where, data }) => {
          let count = 0;
          for (const row of profiles) if (where.id.in.includes(row.id)) {
            row.active = data.active;
            count += 1;
          }
          return { count };
        }
      },
      employmentContract: {
        findMany: async ({ where }) => contracts.filter((row) => where.staffProfileId.in.includes(row.staffProfileId) && (where.active === undefined || row.active === where.active)).map((row) => ({ ...row }))
      },
      collectiveAgreement: { findMany: async ({ where }) => [{ id: "agr_15", code: "ES-15-HOST" }].filter((row) => where.id.in.includes(row.id)) }
    },
    deactivateContract: (async (input: { contractId: string; endDate?: string; endReason?: string }) => {
      const row = contracts.find((candidate) => candidate.id === input.contractId);
      if (!row) throw new Error("fake: contract not found");
      deactivations.push({ contractId: input.contractId, endDate: input.endDate, endReason: input.endReason });
      row.active = false;
      if (input.endDate) row.endDate = new Date(`${input.endDate}T00:00:00.000Z`);
      if (input.endReason) row.endReason = input.endReason;
      const profile = profiles.find((candidate) => candidate.id === row.staffProfileId);
      if (profile) {
        revocations.push(...(assignments.get(profile.userId) ?? []));
        assignments.delete(profile.userId);
      }
      return { id: row.id, staffProfileId: row.staffProfileId, organizationId: ORG, contractType: row.contractType, startDate: "2026-01-01", grossSalary: 1800, payFrequency: "monthly", payCount: row.payCount, active: false, createdAt: "", updatedAt: "", fixedDiscontinuous: row.fixedDiscontinuous };
    }) as unknown as EmployeeDeps["deactivateContract"],
    revokeAssignments: (async (input: { userId: string }) => {
      const ids = assignments.get(input.userId) ?? [];
      assignments.delete(input.userId);
      revocations.push(...ids);
      return ids;
    }) as unknown as EmployeeDeps["revokeAssignments"],
    audit: (input) => {
      audits.push(input);
      return input as never;
    },
    lookupHash: (plaintext) => (withKey ? fakeHash(plaintext) : null),
    now: () => now
  };
  return { deps, employees, profiles, contracts, audits, selects, deactivations, revocations };
}

function employeeRow(overrides: Partial<EmployeeRow> & { id: string; taxId: string }): EmployeeRow {
  const now = new Date("2026-01-10T09:00:00Z");
  const row: EmployeeRow = {
    organizationId: ORG,
    legalEntityId: LE,
    employeeNumber: overrides.id.toUpperCase(),
    userId: null,
    firstName: "Persona",
    lastName: "Prueba",
    taxIdLookupHash: null,
    socialSecurityNumber: null,
    email: null,
    phone: null,
    iban: null,
    gender: null,
    primaryPropertyId: HA,
    usaliDepartment: "rooms",
    jobTitle: "Camarera de pisos",
    status: "active",
    hiredAt: new Date("2026-01-15T00:00:00Z"),
    terminatedAt: null,
    terminationReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  row.taxIdLookupHash = overrides.taxIdLookupHash ?? fakeHash(row.taxId);
  return row;
}

const baseBody = () => ({
  legalEntityId: LE,
  firstName: "Persona",
  lastName: "Alfa Prueba",
  taxId: nif(12345678),
  email: "Alfa@hr.test",
  phone: "600 000 001",
  iban: "ES91 2100 0418 4502 0005 1332",
  socialSecurityNumber: "28/1234567890",
  hiredAt: "2026-02-01",
  primaryPropertyId: HA,
  usaliDepartment: "rooms" as const,
  jobTitle: "Recepcionista"
});

async function rejects(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `HttpError esperado, llegó ${String(error)}`);
    return error;
  }
  throw new Error("no lanzó");
}

describe("NIF / NIE · letra de control", () => {
  it("acepta NIF, NIE y NIF K/L/M con letra válida y normaliza el formato", () => {
    assert.equal(nif(12345678), "12345678Z");
    assert.equal(isValidSpanishTaxId("12345678Z"), true);
    assert.equal(isValidSpanishTaxId(" 12.345.678-z "), true);
    assert.equal(normaliseTaxId(" 12.345.678-z "), "12345678Z");
    assert.equal(isValidSpanishTaxId("X1234567L"), true);
    assert.equal(isValidSpanishTaxId("Y0000000Z"), true);
    assert.equal(isValidSpanishTaxId("K1234567L"), true);
  });

  it("rechaza letra incorrecta, CIF de sociedad, vacío y formatos ajenos", () => {
    assert.equal(isValidSpanishTaxId("12345678A"), false);
    assert.equal(isValidSpanishTaxId("X1234567A"), false);
    assert.equal(isValidSpanishTaxId("B12345674"), false);
    assert.equal(isValidSpanishTaxId(""), false);
    assert.equal(isValidSpanishTaxId("1234567Z"), false);
  });
});

describe("listEmployees · listado sin PII", () => {
  it("el DTO nunca lleva NIF, NAF, correo, teléfono ni IBAN y la consulta ni siquiera los selecciona", async () => {
    const seeded = employeeRow({ id: "emp_a", taxId: nif(1), email: "a@hr.test", phone: "600", iban: "ES0000", socialSecurityNumber: "281" });
    const { deps, selects } = fakeDeps({ employees: [seeded] });
    const rows = await listEmployees({ context: reader }, deps);
    assert.equal(rows.length, 1);
    const keys = Object.keys(rows[0]!);
    for (const field of HR_PII_FIELDS) assert.ok(!keys.includes(field), `campo PII ${field} en el listado`);
    assert.ok(!JSON.stringify(rows).includes(nif(1)));
    assert.ok(!JSON.stringify(rows).includes("a@hr.test"));
    assert.equal(rows[0]!.fullName, "Persona Prueba");
    assert.equal(rows[0]!.propertyCode, "HA");
    assert.equal(rows[0]!.contract, null);
    const select = selects[0] as Record<string, unknown>;
    assert.deepEqual(select, EMPLOYEE_PUBLIC_SELECT);
    for (const field of HR_PII_FIELDS) assert.ok(!(field in select), `select con ${field}`);
  });

  it("filtra por centro (404 opaco fuera de la organización o del ámbito), estado, búsqueda y fijo discontinuo; respeta el ámbito del actor", async () => {
    const a = employeeRow({ id: "emp_a", taxId: nif(1), lastName: "Alfa", primaryPropertyId: HA });
    const b = employeeRow({ id: "emp_b", taxId: nif(2), lastName: "Beta", primaryPropertyId: HB, status: "leave" });
    const c = employeeRow({ id: "emp_c", taxId: nif(3), lastName: "Gamma", primaryPropertyId: null });
    const profiles: Profile[] = [{ id: "sp_a", employeeId: "emp_a", propertyId: HA, userId: "usr_hr_a", active: true }];
    const contracts: Contract[] = [
      { id: "ct_a", staffProfileId: "sp_a", propertyId: HA, contractType: "fijo_discontinuo", startDate: new Date("2026-03-01T00:00:00Z"), endDate: new Date("2026-10-31T00:00:00Z"), payCount: 15, active: true, agreementId: "agr_15", weeklyHours: "40.00", partTimePct: "100.00", fixedDiscontinuous: true, contributionGroup: 7 }
    ];
    const { deps } = fakeDeps({ employees: [a, b, c], profiles, contracts });

    const all = await listEmployees({ context: manager }, deps);
    assert.deepEqual(all.map((row) => row.lastName), ["Alfa", "Beta", "Gamma"]);
    assert.equal(all[0]!.contract?.agreementCode, "ES-15-HOST");
    assert.equal(all[0]!.contract?.fixedDiscontinuous, true);
    assert.equal(all[0]!.contractEndsAt, "2026-10-31");
    assert.deepEqual(all[0]!.staffProfileIds, ["sp_a"]);

    assert.deepEqual((await listEmployees({ context: manager, query: { propertyId: HB } }, deps)).map((row) => row.id), ["emp_b"]);
    assert.deepEqual((await listEmployees({ context: manager, query: { status: "leave" } }, deps)).map((row) => row.id), ["emp_b"]);
    assert.deepEqual((await listEmployees({ context: manager, query: { search: "gam" } }, deps)).map((row) => row.id), ["emp_c"]);
    assert.deepEqual((await listEmployees({ context: manager, query: { fixedDiscontinuous: true } }, deps)).map((row) => row.id), ["emp_a"]);
    assert.deepEqual((await listEmployees({ context: manager, query: { fixedDiscontinuous: false } }, deps)).map((row) => row.id), ["emp_b", "emp_c"]);

    // Solo HA asignado: ni HB ni el expediente de sociedad (sin centro).
    assert.deepEqual((await listEmployees({ context: readerHaOnly }, deps)).map((row) => row.id), ["emp_a"]);
    assert.equal(hrErrorCodeOf(await rejects(listEmployees({ context: readerHaOnly, query: { propertyId: HB } }, deps))), "PROPERTY_NOT_FOUND");
    assert.equal(hrErrorCodeOf(await rejects(listEmployees({ context: manager, query: { propertyId: FOREIGN } }, deps))), "PROPERTY_NOT_FOUND");
    assert.deepEqual(await listEmployees({ context: stranger }, deps), []);
    await assert.rejects(listEmployees({ context: nobody }, deps), PermissionDeniedError);
  });
});

describe("getEmployee · detalle y PII bajo demanda", () => {
  const seeded = () => employeeRow({ id: "emp_a", taxId: nif(1), email: "a@hr.test", phone: "600000000", iban: "ES9121000418450200051332", socialSecurityNumber: "281234567890" });

  it("sin `pii` no descifra nada ni audita; con lectura solo correo y teléfono; con gestión todo, y HR_PII_READ lleva nombres de campo, nunca valores", async () => {
    resetPiiReadAuditWindowForTests();
    const { deps, audits } = fakeDeps({ employees: [seeded()] });
    const plain = await getEmployee({ context: reader, employeeId: "emp_a" }, deps);
    assert.equal(plain.pii, null);
    assert.deepEqual(plain.piiFields, ["email", "phone"]);
    assert.equal(audits.length, 0);

    const partial = await getEmployee({ context: reader, employeeId: "emp_a", pii: true, correlationId: "corr_1" }, deps);
    assert.deepEqual(partial.pii, { taxId: null, socialSecurityNumber: null, email: "a@hr.test", phone: "600000000", iban: null });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, "HR_PII_READ");
    assert.deepEqual((audits[0]!.afterJson as { fields: string[] }).fields, ["email", "phone"]);

    const full = await getEmployee({ context: manager, employeeId: "emp_a", pii: true, correlationId: "corr_2" }, deps);
    assert.deepEqual(full.piiFields, [...HR_PII_FIELDS]);
    assert.equal(full.pii?.taxId, nif(1));
    assert.equal(full.pii?.iban, "ES9121000418450200051332");
    assert.equal(audits.length, 2);
    const serialised = JSON.stringify(audits.map((audit) => audit.afterJson));
    for (const value of [nif(1), "a@hr.test", "600000000", "ES9121000418450200051332", "281234567890"]) assert.ok(!serialised.includes(value), `valor PII en auditoría: ${value}`);
    assert.equal((audits[1]!.afterJson as { scope: string }).scope, "manage");
  });

  it("HR_PII_READ se agrega por minuto, usuario, expediente y ámbito (D §9; RF-12): cuatro lecturas seguidas → una auditoría; otro ámbito, otro actor u otro expediente → otra; pasado el minuto, otra", async () => {
    resetPiiReadAuditWindowForTests();
    const { deps, audits } = fakeDeps({ employees: [seeded(), employeeRow({ id: "emp_b", taxId: nif(2) })] });
    for (let i = 0; i < 4; i += 1) await getEmployee({ context: manager, employeeId: "emp_a", pii: true, correlationId: `corr_${i}` }, deps);
    assert.equal(audits.length, 1, "una sola HR_PII_READ dentro de la ventana");
    assert.equal((audits[0]!.afterJson as { windowMs: number }).windowMs, HR_PII_READ_AUDIT_WINDOW_MS);
    await getEmployee({ context: reader, employeeId: "emp_a", pii: true, correlationId: "corr_r" }, deps);
    assert.equal(audits.length, 2, "otro ámbito (read) es otra auditoría");
    await getEmployee({ context: manager, employeeId: "emp_b", pii: true, correlationId: "corr_b" }, deps);
    assert.equal(audits.length, 3, "otro expediente es otra auditoría");
    const later = new Date("2026-09-20T10:00:00Z");
    const key = { organizationId: ORG, actorUserId: manager.userId, employeeId: "emp_a", scope: "manage" };
    assert.equal(shouldAuditPiiRead(key, later), false, "misma pareja dentro del minuto");
    assert.equal(shouldAuditPiiRead(key, new Date(later.getTime() + HR_PII_READ_AUDIT_WINDOW_MS)), true, "pasado el minuto vuelve a auditarse");
    assert.equal(shouldAuditPiiRead({ ...key, actorUserId: "usr_otro" }, later), true, "otro actor es otra pareja");
    resetPiiReadAuditWindowForTests();
  });

  it("404 opaco desde otra organización o fuera del ámbito; 503 HR_PII_KEY_MISSING si el valor sigue cifrado", async () => {
    const { deps } = fakeDeps({ employees: [seeded(), employeeRow({ id: "emp_b", taxId: nif(2), primaryPropertyId: HB })] });
    assert.equal(hrErrorCodeOf(await rejects(getEmployee({ context: stranger, employeeId: "emp_a" }, deps))), "HR_EMPLOYEE_NOT_FOUND");
    assert.equal((await rejects(getEmployee({ context: stranger, employeeId: "emp_a" }, deps))).statusCode, 404);
    assert.equal(hrErrorCodeOf(await rejects(getEmployee({ context: readerHaOnly, employeeId: "emp_b" }, deps))), "HR_EMPLOYEE_NOT_FOUND");
    assert.equal(hrErrorCodeOf(await rejects(getEmployee({ context: manager, employeeId: "emp_zzz" }, deps))), "HR_EMPLOYEE_NOT_FOUND");
    await assert.rejects(getEmployee({ context: nobody, employeeId: "emp_a" }, deps), PermissionDeniedError);

    const encrypted = fakeDeps({ employees: [employeeRow({ id: "emp_x", taxId: "v1.00ff.aa.bb" })] });
    const error = await rejects(getEmployee({ context: manager, employeeId: "emp_x", pii: true }, encrypted.deps));
    assert.equal(error.statusCode, 503);
    assert.equal(hrErrorCodeOf(error), "HR_PII_KEY_MISSING");
    assert.ok(!error.message.includes("v1."));
  });
});

describe("createEmployee · alta con NIF único por sociedad", () => {
  it("normaliza el NIF, genera el número de empleado, devuelve el detalle sin PII y audita sin datos personales", async () => {
    const { deps, employees, audits } = fakeDeps();
    const created = await createEmployee({ context: manager, body: { ...baseBody(), taxId: " 12.345.678-z " }, correlationId: "corr_c" }, deps);
    assert.equal(created.employeeNumber, "0001");
    assert.equal(created.pii, null);
    assert.equal(created.status, "active");
    assert.equal(created.hiredAt, "2026-02-01");
    assert.ok(!JSON.stringify(created).includes("12345678Z"));
    assert.equal(employees[0]!.taxId, "12345678Z");
    assert.equal(employees[0]!.email, "alfa@hr.test");
    assert.equal(employees[0]!.iban, "ES9121000418450200051332");
    assert.equal(employees[0]!.socialSecurityNumber, "281234567890");
    assert.equal(employees[0]!.taxIdLookupHash, fakeHash("12345678Z"));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, "HR_EMPLOYEE_CREATED");
    const after = JSON.stringify(audits[0]!.afterJson);
    for (const value of ["12345678Z", "alfa@hr.test", "600 000 001", "ES91", "281234567890"]) assert.ok(!after.includes(value), `PII en auditoría: ${value}`);
    assert.deepEqual((audits[0]!.afterJson as { piiFieldsSet: string[] }).piiFieldsSet, ["taxId", "socialSecurityNumber", "email", "phone", "iban"]);
    const second = await createEmployee({ context: manager, body: { ...baseBody(), taxId: nif(2) }, correlationId: "corr_d" }, deps);
    assert.equal(second.employeeNumber, "0002");
  });

  it("mismo NIF en la sociedad → 409 HR_EMPLOYEE_TAXID_DUPLICATE (por hash, con otro formato); en otra sociedad se admite; número repetido → 409", async () => {
    const { deps } = fakeDeps({ employees: [employeeRow({ id: "emp_a", taxId: nif(12345678), employeeNumber: "E-1" })] });
    const duplicate = await rejects(createEmployee({ context: manager, body: { ...baseBody(), taxId: "12345678-z" }, correlationId: "c" }, deps));
    assert.equal(duplicate.statusCode, 409);
    assert.equal(hrErrorCodeOf(duplicate), "HR_EMPLOYEE_TAXID_DUPLICATE");
    assert.equal((duplicate.details as { employeeId: string }).employeeId, "emp_a");
    const other = await createEmployee({ context: manager, body: { ...baseBody(), legalEntityId: LE2, primaryPropertyId: null }, correlationId: "c" }, deps);
    assert.equal(other.legalEntityId, LE2);
    const number = await rejects(createEmployee({ context: manager, body: { ...baseBody(), taxId: nif(7), employeeNumber: "E-1" }, correlationId: "c" }, deps));
    assert.equal(hrErrorCodeOf(number), "HR_EMPLOYEE_NUMBER_DUPLICATE");
  });

  it("sin clave de búsqueda configurada el duplicado se detecta en claro", async () => {
    const { deps } = fakeDeps({ withKey: false });
    await createEmployee({ context: manager, body: baseBody(), correlationId: "c" }, deps);
    assert.equal(hrErrorCodeOf(await rejects(createEmployee({ context: manager, body: baseBody(), correlationId: "c" }, deps))), "HR_EMPLOYEE_TAXID_DUPLICATE");
  });

  it("valida NIF (400 HR_TAXID_INVALID), sociedad, usuario, catálogos, fechas, centro fuera del ámbito (404) y permiso", async () => {
    const { deps } = fakeDeps();
    const bad = await rejects(createEmployee({ context: manager, body: { ...baseBody(), taxId: "12345678A" }, correlationId: "c" }, deps));
    assert.equal(bad.statusCode, 400);
    assert.equal(hrErrorCodeOf(bad), "HR_TAXID_INVALID");
    const entity = await rejects(createEmployee({ context: manager, body: { ...baseBody(), legalEntityId: "le_other" }, correlationId: "c" }, deps));
    assert.equal(hrErrorCodeOf(entity), "VALIDATION_ERROR");
    assert.equal((entity.details as { field: string }).field, "legalEntityId");
    assert.equal((await rejects(createEmployee({ context: manager, body: { ...baseBody(), userId: "usr_hr_x" }, correlationId: "c" }, deps))).statusCode, 400);
    assert.equal((await rejects(createEmployee({ context: manager, body: { ...baseBody(), usaliDepartment: "spa" as never }, correlationId: "c" }, deps))).statusCode, 400);
    assert.equal((await rejects(createEmployee({ context: manager, body: { ...baseBody(), status: "inactive" as never }, correlationId: "c" }, deps))).statusCode, 400);
    assert.equal((await rejects(createEmployee({ context: manager, body: { ...baseBody(), hiredAt: "01/02/2026" }, correlationId: "c" }, deps))).statusCode, 400);
    assert.equal((await rejects(createEmployee({ context: manager, body: { ...baseBody(), email: "no-es-correo" }, correlationId: "c" }, deps))).statusCode, 400);
    assert.equal(hrErrorCodeOf(await rejects(createEmployee({ context: manager, body: { ...baseBody(), primaryPropertyId: FOREIGN }, correlationId: "c" }, deps))), "PROPERTY_NOT_FOUND");
    const scoped = { ...manager, assignedPropertyIds: [HA], orgScope: false } as unknown as UserContext;
    assert.equal(hrErrorCodeOf(await rejects(createEmployee({ context: scoped, body: { ...baseBody(), primaryPropertyId: HB }, correlationId: "c" }, deps))), "PROPERTY_NOT_FOUND");
    await assert.rejects(createEmployee({ context: reader, body: baseBody(), correlationId: "c" }, deps), PermissionDeniedError);
  });
});

describe("patchEmployee", () => {
  it("cambia campos en claro y PII, audita los nombres de los campos cambiados y controla duplicados y bajas", async () => {
    const { deps, employees, audits } = fakeDeps({ employees: [employeeRow({ id: "emp_a", taxId: nif(1) }), employeeRow({ id: "emp_b", taxId: nif(2) }), employeeRow({ id: "emp_t", taxId: nif(3), status: "inactive", terminatedAt: new Date("2026-06-30T00:00:00Z") })] });
    const updated = await patchEmployee({ context: manager, employeeId: "emp_a", body: { jobTitle: "Gobernanta", email: "Nueva@hr.test", status: "leave" }, correlationId: "p" }, deps);
    assert.equal(updated.jobTitle, "Gobernanta");
    assert.equal(updated.status, "leave");
    assert.equal(updated.pii, null);
    assert.equal(employees[0]!.email, "nueva@hr.test");
    assert.equal(audits[0]!.action, "HR_EMPLOYEE_UPDATED");
    const after = audits[0]!.afterJson as { changedFields: string[]; changedPiiFields: string[] };
    assert.deepEqual(after.changedFields, ["email", "jobTitle", "status"]);
    assert.deepEqual(after.changedPiiFields, ["email"]);
    assert.ok(!JSON.stringify(audits[0]!.afterJson).includes("nueva@hr.test"));

    assert.equal(hrErrorCodeOf(await rejects(patchEmployee({ context: manager, employeeId: "emp_a", body: { taxId: nif(2) }, correlationId: "p" }, deps))), "HR_EMPLOYEE_TAXID_DUPLICATE");
    assert.equal(hrErrorCodeOf(await rejects(patchEmployee({ context: manager, employeeId: "emp_a", body: { employeeNumber: "EMP_B" }, correlationId: "p" }, deps))), "HR_EMPLOYEE_NUMBER_DUPLICATE");
    assert.equal(hrErrorCodeOf(await rejects(patchEmployee({ context: manager, employeeId: "emp_t", body: { jobTitle: "x" }, correlationId: "p" }, deps))), "HR_EMPLOYEE_TERMINATED");
    assert.equal(hrErrorCodeOf(await rejects(patchEmployee({ context: manager, employeeId: "emp_a", body: {}, correlationId: "p" }, deps))), "VALIDATION_ERROR");
    assert.equal(hrErrorCodeOf(await rejects(patchEmployee({ context: stranger, employeeId: "emp_a", body: { jobTitle: "x" }, correlationId: "p" }, deps))), "HR_EMPLOYEE_NOT_FOUND");
    await assert.rejects(patchEmployee({ context: reader, employeeId: "emp_a", body: { jobTitle: "x" }, correlationId: "p" }, deps), PermissionDeniedError);
  });
});

describe("terminateEmployee · baja en cascada", () => {
  it("desactiva fichas y contratos (deactivateContract con fecha y causa), revoca el acceso del usuario sin contrato y audita; segunda baja → 409", async () => {
    const profiles: Profile[] = [
      { id: "sp_1", employeeId: "emp_a", propertyId: HA, userId: "usr_hr_a", active: true },
      { id: "sp_2", employeeId: "emp_a", propertyId: HB, userId: "usr_hr_a", active: true },
      { id: "sp_other", employeeId: "emp_b", propertyId: HA, userId: "usr_hr_b", active: true }
    ];
    const contracts: Contract[] = [
      { id: "ct_1", staffProfileId: "sp_1", propertyId: HA, contractType: "indefinido", startDate: new Date("2026-01-01T00:00:00Z"), endDate: null, payCount: 15, active: true, agreementId: null, weeklyHours: null, partTimePct: null, fixedDiscontinuous: false, contributionGroup: null },
      { id: "ct_old", staffProfileId: "sp_1", propertyId: HA, contractType: "temporal", startDate: new Date("2025-01-01T00:00:00Z"), endDate: new Date("2025-12-31T00:00:00Z"), payCount: 14, active: false, agreementId: null, weeklyHours: null, partTimePct: null, fixedDiscontinuous: false, contributionGroup: null },
      { id: "ct_b", staffProfileId: "sp_other", propertyId: HA, contractType: "indefinido", startDate: new Date("2026-01-01T00:00:00Z"), endDate: null, payCount: 14, active: true, agreementId: null, weeklyHours: null, partTimePct: null, fixedDiscontinuous: false, contributionGroup: null }
    ];
    const { deps, employees, audits, deactivations, revocations } = fakeDeps({
      employees: [employeeRow({ id: "emp_a", taxId: nif(1), userId: "usr_hr_a" }), employeeRow({ id: "emp_b", taxId: nif(2), userId: "usr_hr_b" })],
      profiles,
      contracts,
      assignments: { usr_hr_a: ["ra_a1", "ra_a2"], usr_hr_b: ["ra_b"] }
    });
    const result = await terminateEmployee({ context: manager, employeeId: "emp_a", terminatedAt: "2026-09-30", reason: "resignation", correlationId: "t" }, deps);
    assert.equal(result.employee.status, "inactive");
    assert.equal(result.employee.terminatedAt, "2026-09-30");
    assert.equal(result.employee.terminationReason, "resignation");
    assert.deepEqual(result.deactivatedStaffProfileIds, ["sp_1", "sp_2"]);
    assert.deepEqual(result.deactivatedContractIds, ["ct_1"]);
    assert.deepEqual(deactivations, [{ contractId: "ct_1", endDate: "2026-09-30", endReason: "resignation" }]);
    assert.deepEqual(revocations, ["ra_a1", "ra_a2"]);
    assert.equal(profiles.find((row) => row.id === "sp_1")!.active, false);
    assert.equal(profiles.find((row) => row.id === "sp_2")!.active, false);
    assert.equal(profiles.find((row) => row.id === "sp_other")!.active, true, "la ficha de otro expediente no se toca");
    assert.equal(contracts.find((row) => row.id === "ct_b")!.active, true);
    assert.equal(employees[0]!.status, "inactive");
    assert.equal(result.employee.contracts.length, 2);
    assert.equal(result.employee.contracts[0]!.endDate, "2026-09-30");
    const terminated = audits.find((audit) => audit.action === "HR_EMPLOYEE_TERMINATED");
    assert.ok(terminated);
    assert.deepEqual((terminated.afterJson as { deactivatedContractIds: string[] }).deactivatedContractIds, ["ct_1"]);

    const again = await rejects(terminateEmployee({ context: manager, employeeId: "emp_a", correlationId: "t" }, deps));
    assert.equal(again.statusCode, 409);
    assert.equal(hrErrorCodeOf(again), "HR_EMPLOYEE_TERMINATED");
  });

  it("sin contrato ni ficha revoca el acceso del usuario del expediente; fecha anterior al alta o causa desconocida → 400; sin permiso → 403", async () => {
    const { deps, revocations } = fakeDeps({ employees: [employeeRow({ id: "emp_a", taxId: nif(1), userId: "usr_hr_a" })], assignments: { usr_hr_a: ["ra_a1"] } });
    assert.equal((await rejects(terminateEmployee({ context: manager, employeeId: "emp_a", terminatedAt: "2025-12-31", correlationId: "t" }, deps))).statusCode, 400);
    assert.equal((await rejects(terminateEmployee({ context: manager, employeeId: "emp_a", reason: "fired" as never, correlationId: "t" }, deps))).statusCode, 400);
    await assert.rejects(terminateEmployee({ context: reader, employeeId: "emp_a", correlationId: "t" }, deps), PermissionDeniedError);
    const result = await terminateEmployee({ context: manager, employeeId: "emp_a", correlationId: "t" }, deps);
    assert.equal(result.employee.terminatedAt, "2026-09-20", "fecha por defecto = hoy (deps.now)");
    assert.equal(result.employee.terminationReason, "other");
    assert.deepEqual(result.revokedAssignmentIds, ["ra_a1"]);
    assert.deepEqual(revocations, ["ra_a1"]);
  });
});
