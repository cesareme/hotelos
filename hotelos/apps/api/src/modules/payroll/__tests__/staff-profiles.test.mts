// Unit tests · FIX-1 · F10 — fichas de personal (staff-profiles.service.ts y
// el esquema zod de staff-profiles.routes.ts). Sin base de datos: fakes en
// memoria por `deps`; nombres y correos INVENTADOS. Desde apps/api:
//   node --import tsx --test src/modules/payroll/__tests__/staff-profiles.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { CreateStaffProfileSchema, StaffProfileListQuerySchema } from "../staff-profiles.routes.js";
import {
  STAFF_EMPLOYEE_CODE_MAX,
  STAFF_EMPLOYMENT_TYPES,
  STAFF_PROFILE_ERROR_CODES,
  createStaffProfile,
  listStaffProfiles,
  normaliseStaffProfileInput,
  type StaffProfileDeps
} from "../staff-profiles.service.js";

type Row = { id: string; userId: string; propertyId: string; employeeCode: string | null; departmentId: string | null; employmentType: string | null; hourlyCost: string | null; active: boolean; createdAt: Date };
type AuditCall = Parameters<StaffProfileDeps["audit"]>[0];

const ORG = "org_sp_test";
const OTHER_ORG = "org_sp_other";
const HA = "prop_sp_ha";
const HB = "prop_sp_hb";
const FOREIGN = "prop_sp_foreign";

const manager = { organizationId: ORG, propertyId: HA, userId: "usr_sp_rrhh", fullName: "RRHH Test", deviceId: "sp-test", permissions: ["payroll.manage", "payroll.read"], orgScope: true } as unknown as UserContext;
const reader = { ...manager, permissions: ["payroll.read"] } as unknown as UserContext;
const assignedToHa = { ...manager, assignedPropertyIds: [HA], orgScope: false } as unknown as UserContext;

/** Fakes mínimos que entienden SOLO las formas de `where` que usa el servicio. */
function fakeDeps(seed: { profiles?: Row[]; departmentsInDb?: Array<{ id: string; propertyId: string; name: string }>; demoDepartments?: Array<{ id: string; propertyId: string; name: string }> } = {}) {
  const profiles: Row[] = [...(seed.profiles ?? [])];
  const users = [
    { id: "usr_sp_a", organizationId: ORG, fullName: "Persona Alfa", email: "alfa@sp.test" },
    { id: "usr_sp_b", organizationId: ORG, fullName: "Persona Beta", email: "beta@sp.test" },
    { id: "usr_sp_x", organizationId: OTHER_ORG, fullName: "Persona Ajena", email: "ajena@sp.test" }
  ];
  const properties = [
    { id: HA, organizationId: ORG },
    { id: HB, organizationId: ORG },
    { id: FOREIGN, organizationId: OTHER_ORG }
  ];
  const departments = seed.departmentsInDb ?? [{ id: "dep_sp_rec", propertyId: HA, name: "Recepción" }, { id: "dep_sp_hb", propertyId: HB, name: "Pisos HB" }];
  const audits: AuditCall[] = [];
  let seq = 0;
  const deps: StaffProfileDeps = {
    db: {
      staffProfile: {
        findMany: async ({ where }) => profiles.filter((row) => (typeof where.propertyId === "string" ? row.propertyId === where.propertyId : where.propertyId.in.includes(row.propertyId))),
        findFirst: async ({ where }) => {
          const row = profiles.find((candidate) => candidate.userId === where.userId && candidate.propertyId === where.propertyId && candidate.active === where.active);
          return row ? { id: row.id } : null;
        },
        create: async ({ data }) => {
          const row: Row = { id: `sp_${++seq}`, createdAt: new Date("2026-09-19T10:00:00Z"), ...data };
          profiles.push(row);
          return row;
        }
      },
      user: {
        findFirst: async ({ where }) => users.find((user) => user.id === where.id && user.organizationId === where.organizationId) ?? null,
        findMany: async ({ where }) => users.filter((user) => where.id.in.includes(user.id))
      },
      property: {
        findFirst: async ({ where }) => properties.find((property) => property.id === where.id && property.organizationId === where.organizationId) ?? null,
        findMany: async ({ where }) => properties.filter((property) => property.organizationId === where.organizationId).map((property) => ({ id: property.id }))
      },
      department: {
        findFirst: async ({ where }) => departments.find((department) => department.id === where.id && department.propertyId === where.propertyId) ?? null,
        findMany: async ({ where }) => departments.filter((department) => where.id.in.includes(department.id))
      }
    },
    demoDepartments: () => seed.demoDepartments ?? [],
    audit: (input) => {
      audits.push(input);
      return { id: "aud_fake" } as unknown as ReturnType<StaffProfileDeps["audit"]>;
    }
  };
  return { deps, profiles, audits };
}

/** HttpError del módulo o PermissionDeniedError de @hotelos/shared (statusCode 403, sin `details`). */
async function expectHttp<T>(promise: Promise<T>, statusCode: number, code?: string): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (statusCode === 403 && error instanceof Error && error.name === "PermissionDeniedError") {
      assert.equal((error as { statusCode?: number }).statusCode, 403);
      return error as HttpError;
    }
    assert.ok(error instanceof HttpError, `HttpError esperado, llegó ${String(error)}`);
    assert.equal(error.statusCode, statusCode, `status (${error.message})`);
    if (code) assert.equal((error.details as { code?: string } | undefined)?.code, code, `details.code (${error.message})`);
    return error;
  }
  assert.fail(`se esperaba ${statusCode}${code ? ` ${code}` : ""}`);
}

describe("F10 · normaliseStaffProfileInput (reglas puras)", () => {
  it("recorta, vacía a null y convierte el coste hora «12,5» → «12.50»", () => {
    const out = normaliseStaffProfileInput({ propertyId: ` ${HA} `, userId: " usr_sp_a ", employeeCode: "  ", departmentId: "", employmentType: "", hourlyCost: "12,5" });
    assert.deepEqual(out, { propertyId: HA, userId: "usr_sp_a", employeeCode: null, departmentId: null, employmentType: null, hourlyCost: "12.50" });
    assert.equal(normaliseStaffProfileInput({ propertyId: HA, userId: "u", hourlyCost: 9.999 }).hourlyCost, "10.00");
    assert.equal(normaliseStaffProfileInput({ propertyId: HA, userId: "u", hourlyCost: 0 }).hourlyCost, "0.00");
    assert.equal(normaliseStaffProfileInput({ propertyId: HA, userId: "u" }).hourlyCost, null);
    assert.equal(normaliseStaffProfileInput({ propertyId: HA, userId: "u", hourlyCost: "" }).hourlyCost, null);
  });

  it("rechaza hourlyCost negativo, no numérico o con más de dos decimales (400 STAFF_PROFILE_INVALID, field hourlyCost)", async () => {
    for (const bad of [-1, "-0,5", "abc", "12,345", Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await expectHttp(Promise.resolve().then(() => normaliseStaffProfileInput({ propertyId: HA, userId: "u", hourlyCost: bad as number })), 400, STAFF_PROFILE_ERROR_CODES.invalid);
      assert.equal((error.details as { field: string }).field, "hourlyCost", String(bad));
      assert.match(error.message, /hourlyCost/);
    }
  });

  it("rechaza employeeCode > 32, employmentType fuera del catálogo y los ids vacíos", async () => {
    const long = await expectHttp(Promise.resolve().then(() => normaliseStaffProfileInput({ propertyId: HA, userId: "u", employeeCode: "X".repeat(STAFF_EMPLOYEE_CODE_MAX + 1) })), 400, STAFF_PROFILE_ERROR_CODES.invalid);
    assert.match(long.message, /32 caracteres/);
    assert.equal(normaliseStaffProfileInput({ propertyId: HA, userId: "u", employeeCode: "X".repeat(STAFF_EMPLOYEE_CODE_MAX) }).employeeCode?.length, STAFF_EMPLOYEE_CODE_MAX);
    const type = await expectHttp(Promise.resolve().then(() => normaliseStaffProfileInput({ propertyId: HA, userId: "u", employmentType: "becario" })), 400, STAFF_PROFILE_ERROR_CODES.invalid);
    assert.match(type.message, new RegExp(STAFF_EMPLOYMENT_TYPES.join(", ").replace(/_/g, "_")));
    for (const type of STAFF_EMPLOYMENT_TYPES) assert.equal(normaliseStaffProfileInput({ propertyId: HA, userId: "u", employmentType: type }).employmentType, type);
    await expectHttp(Promise.resolve().then(() => normaliseStaffProfileInput({ propertyId: "", userId: "u" })), 400, STAFF_PROFILE_ERROR_CODES.invalid);
    await expectHttp(Promise.resolve().then(() => normaliseStaffProfileInput({ propertyId: HA, userId: " " })), 400, STAFF_PROFILE_ERROR_CODES.invalid);
  });
});

describe("F10 · esquemas zod de la frontera HTTP (mensajes en español, .strict())", () => {
  it("cuerpo mínimo válido; clave desconocida, hourlyCost negativo, employeeCode largo y employmentType fuera del catálogo → issues en español", () => {
    assert.equal(CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a" }).success, true);
    const full = CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a", employeeCode: "EMP-001", departmentId: "dep_sp_rec", employmentType: "temporal", hourlyCost: "12,50" });
    assert.equal(full.success, true);
    const unknown = CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a", nombre: "x" });
    assert.equal(unknown.success, false);
    assert.ok(unknown.error?.issues.some((issue) => issue.code === "unrecognized_keys"));
    const negative = CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a", hourlyCost: -3 });
    assert.equal(negative.success, false);
    assert.match(negative.error?.issues[0]?.message ?? "", /^hourlyCost debe ser un importe mayor o igual que 0/);
    const decimals = CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a", hourlyCost: "12,345" });
    assert.equal(decimals.success, false);
    const code = CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a", employeeCode: "X".repeat(33) });
    assert.equal(code.success, false);
    assert.match(code.error?.issues[0]?.message ?? "", /employeeCode no puede superar 32 caracteres\./);
    const type = CreateStaffProfileSchema.safeParse({ propertyId: HA, userId: "usr_sp_a", employmentType: "becario" });
    assert.equal(type.success, false);
    assert.match(type.error?.issues[0]?.message ?? "", /^employmentType debe ser uno de: indefinido, temporal, fijo_discontinuo, practicas, otro\.$/);
    const missing = CreateStaffProfileSchema.safeParse({ propertyId: HA });
    assert.equal(missing.success, false);
    assert.match(missing.error?.issues[0]?.message ?? "", /^userId es obligatorio\.$/);
  });

  it("la consulta admite solo propertyId (opcional)", () => {
    assert.equal(StaffProfileListQuerySchema.safeParse({}).success, true);
    assert.equal(StaffProfileListQuerySchema.safeParse({ propertyId: HA }).success, true);
    assert.equal(StaffProfileListQuerySchema.safeParse({ organizationId: ORG }).success, false);
  });
});

describe("F10 · createStaffProfile (fakes en memoria)", () => {
  it("crea la ficha, resuelve persona y departamento y audita STAFF_PROFILE_CREATED sin nombre ni correo", async () => {
    const { deps, profiles, audits } = fakeDeps();
    const created = await createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a", employeeCode: " EMP-001 ", departmentId: "dep_sp_rec", employmentType: "indefinido", hourlyCost: "12,5" }, correlationId: "corr_sp_1" }, deps);
    assert.equal(created.id, "sp_1");
    assert.equal(created.employeeCode, "EMP-001");
    assert.equal(created.departmentName, "Recepción");
    assert.equal(created.userFullName, "Persona Alfa");
    assert.equal(created.userEmail, "alfa@sp.test");
    assert.equal(created.hourlyCost, "12.50");
    assert.equal(created.active, true);
    assert.equal(profiles.length, 1);
    assert.equal(audits.length, 1);
    const audit = audits[0]!;
    assert.equal(audit.action, "STAFF_PROFILE_CREATED");
    assert.equal(audit.entityType, "staff_profile");
    assert.equal(audit.entityId, "sp_1");
    assert.equal(audit.propertyId, HA);
    assert.equal(audit.correlationId, "corr_sp_1");
    const after = JSON.stringify(audit.afterJson);
    assert.doesNotMatch(after, /Persona Alfa|alfa@sp\.test|12\.50/, "la auditoría no lleva datos personales ni el coste");
    assert.deepEqual(audit.afterJson, { id: "sp_1", propertyId: HA, userId: "usr_sp_a", departmentId: "dep_sp_rec", employeeCode: "EMP-001", employmentType: "indefinido" });
  });

  it("duplicado ACTIVO (userId, propertyId) → 409 STAFF_PROFILE_EXISTS con el id existente; una ficha inactiva no bloquea", async () => {
    const { deps, profiles } = fakeDeps({ profiles: [{ id: "sp_old", userId: "usr_sp_a", propertyId: HA, employeeCode: null, departmentId: null, employmentType: null, hourlyCost: null, active: true, createdAt: new Date("2026-01-01T00:00:00Z") }] });
    const error = await expectHttp(createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a" }, correlationId: "corr" }, deps), 409, STAFF_PROFILE_ERROR_CODES.exists);
    assert.equal((error.details as { staffProfileId: string }).staffProfileId, "sp_old");
    assert.equal(profiles.length, 1, "nada escrito");
    // Misma persona en OTRO centro: permitido.
    const other = await createStaffProfile({ context: manager, body: { propertyId: HB, userId: "usr_sp_a" }, correlationId: "corr" }, deps);
    assert.equal(other.propertyId, HB);
    profiles[0]!.active = false;
    const again = await createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a" }, correlationId: "corr" }, deps);
    assert.equal(again.propertyId, HA);
  });

  it("departamento de otra propiedad → 400 STAFF_PROFILE_DEPARTMENT_MISMATCH; el del seed en memoria de la misma propiedad vale", async () => {
    const { deps, profiles } = fakeDeps({ demoDepartments: [{ id: "dep_demo_ha", propertyId: HA, name: "Pisos (demo)" }] });
    const error = await expectHttp(createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a", departmentId: "dep_sp_hb" }, correlationId: "corr" }, deps), 400, STAFF_PROFILE_ERROR_CODES.departmentMismatch);
    assert.equal(error.message, "El departamento no pertenece a la propiedad de la ficha.");
    await expectHttp(createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a", departmentId: "dep_inexistente" }, correlationId: "corr" }, deps), 400, STAFF_PROFILE_ERROR_CODES.departmentMismatch);
    assert.equal(profiles.length, 0);
    const demo = await createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a", departmentId: "dep_demo_ha" }, correlationId: "corr" }, deps);
    assert.equal(demo.departmentName, "Pisos (demo)");
  });

  it("usuario de otra organización o inexistente → 404 «Usuario no encontrado.»; propiedad ajena o fuera del ámbito → 404 «Propiedad no encontrada.»", async () => {
    const { deps, profiles } = fakeDeps();
    const user = await expectHttp(createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_x" }, correlationId: "corr" }, deps), 404);
    assert.equal(user.message, "Usuario no encontrado.");
    await expectHttp(createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_nadie" }, correlationId: "corr" }, deps), 404);
    const foreign = await expectHttp(createStaffProfile({ context: manager, body: { propertyId: FOREIGN, userId: "usr_sp_a" }, correlationId: "corr" }, deps), 404);
    assert.equal(foreign.message, "Propiedad no encontrada.");
    const scope = await expectHttp(createStaffProfile({ context: assignedToHa, body: { propertyId: HB, userId: "usr_sp_a" }, correlationId: "corr" }, deps), 404);
    assert.equal(scope.message, "Propiedad no encontrada.");
    assert.equal(profiles.length, 0);
  });

  it("hourlyCost negativo → 400 antes de tocar la base de datos; sin payroll.manage → 403", async () => {
    const { deps, profiles, audits } = fakeDeps();
    await expectHttp(createStaffProfile({ context: manager, body: { propertyId: HA, userId: "usr_sp_a", hourlyCost: -1 }, correlationId: "corr" }, deps), 400, STAFF_PROFILE_ERROR_CODES.invalid);
    await expectHttp(createStaffProfile({ context: reader, body: { propertyId: HA, userId: "usr_sp_a" }, correlationId: "corr" }, deps), 403);
    assert.equal(profiles.length, 0);
    assert.equal(audits.length, 0);
  });
});

describe("F10 · listStaffProfiles (fakes en memoria)", () => {
  const seed: Row[] = [
    { id: "sp_ha_1", userId: "usr_sp_a", propertyId: HA, employeeCode: "EMP-002", departmentId: "dep_sp_rec", employmentType: "temporal", hourlyCost: "11.00", active: true, createdAt: new Date("2026-02-01T00:00:00Z") },
    { id: "sp_hb_1", userId: "usr_sp_b", propertyId: HB, employeeCode: null, departmentId: "dep_demo_hb", employmentType: null, hourlyCost: null, active: false, createdAt: new Date("2026-03-01T00:00:00Z") },
    { id: "sp_foreign", userId: "usr_sp_x", propertyId: FOREIGN, employeeCode: "AJENA", departmentId: null, employmentType: null, hourlyCost: null, active: true, createdAt: new Date("2026-03-01T00:00:00Z") }
  ];

  it("por centro: fichas del centro con persona y departamento (Prisma o seed en memoria); sin centro: todos los centros de la organización", async () => {
    const { deps } = fakeDeps({ profiles: seed, demoDepartments: [{ id: "dep_demo_hb", propertyId: HB, name: "Cocina (demo)" }] });
    const ha = await listStaffProfiles({ context: reader, propertyId: HA }, deps);
    assert.deepEqual(ha.map((row) => row.id), ["sp_ha_1"]);
    assert.equal(ha[0]?.userFullName, "Persona Alfa");
    assert.equal(ha[0]?.userEmail, "alfa@sp.test");
    assert.equal(ha[0]?.departmentName, "Recepción");
    assert.equal(ha[0]?.hourlyCost, "11.00");
    assert.equal(ha[0]?.createdAt, "2026-02-01T00:00:00.000Z");
    const all = await listStaffProfiles({ context: reader, propertyId: null }, deps);
    assert.deepEqual(all.map((row) => row.id).sort(), ["sp_ha_1", "sp_hb_1"], "nunca la ficha de la organización ajena");
    assert.equal(all.find((row) => row.id === "sp_hb_1")?.departmentName, "Cocina (demo)");
    assert.equal(all.find((row) => row.id === "sp_hb_1")?.userFullName, "Persona Beta");
  });

  it("ámbito R11: un contexto asignado solo a HA no ve HB (404 opaco por centro, filtrado sin centro); propiedad ajena → 404; sin payroll.read → 403", async () => {
    const { deps } = fakeDeps({ profiles: seed });
    const scoped = await listStaffProfiles({ context: assignedToHa, propertyId: null }, deps);
    assert.deepEqual(scoped.map((row) => row.id), ["sp_ha_1"]);
    const hb = await expectHttp(listStaffProfiles({ context: assignedToHa, propertyId: HB }, deps), 404);
    assert.equal(hb.message, "Propiedad no encontrada.");
    await expectHttp(listStaffProfiles({ context: reader, propertyId: FOREIGN }, deps), 404);
    await expectHttp(listStaffProfiles({ context: { ...reader, permissions: [] } as unknown as UserContext, propertyId: HA }, deps), 403);
  });
});
