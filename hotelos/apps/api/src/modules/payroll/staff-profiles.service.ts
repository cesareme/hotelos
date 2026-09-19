// Fichas de personal (StaffProfile) · FIX-1 · F10 (RRHH).
//
// Hasta este lote no existía alta de `staff_profiles` (schema.prisma
// `model StaffProfile`: userId, propertyId, employeeCode, departmentId,
// employmentType, hourlyCost, active): los dashboards solo las leían y
// `POST /payroll/contracts` exige un `staffProfileId` existente, así que el
// cajón «Nuevo contrato» terminaba en 404 «Perfil de empleado no encontrado.».
//
//   listStaffProfiles({ context, propertyId })   payroll.read   fichas de un centro
//     (o de todos los centros de la organización dentro del ámbito R11 cuando no
//     se indica), con `userFullName` / `userEmail` (prisma.user) y `departmentName`.
//   createStaffProfile({ context, body, correlationId })   payroll.manage
//     · la propiedad debe ser de la organización y estar en el ámbito del actor
//       (404 opaco «Propiedad no encontrada.»; la ruta ya pasó grantPropertyAccess);
//     · la persona debe existir en la organización (404 «Usuario no encontrado.»);
//     · el departamento, si viene, debe ser de la propiedad (400
//       STAFF_PROFILE_DEPARTMENT_MISMATCH; también los del seed en memoria);
//     · una ficha ACTIVA por (userId, propertyId): 409 STAFF_PROFILE_EXISTS;
//     · `hourlyCost` ≥ 0 con dos decimales (Decimal(12,2)); `employeeCode` ≤ 32;
//     · audita STAFF_PROFILE_CREATED con `afterJson` SIN datos personales
//       (identificadores y código de empleado; nunca nombre ni correo).
//
// Las reglas puras (`normaliseStaffProfileInput`) y las consultas van por
// `deps` inyectables para los tests unitarios con fakes en memoria
// (__tests__/staff-profiles.test.mts); la integración real vive en
// tests/integration/payroll-cost-routes.test.mts (tenant aislado).

import { prisma } from "@hotelos/database";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { assertFinanceReadScope, propertyWithinScope } from "../../lib/finance-scope.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";

export const STAFF_EMPLOYMENT_TYPES = ["indefinido", "temporal", "fijo_discontinuo", "practicas", "otro"] as const;
export type StaffEmploymentType = (typeof STAFF_EMPLOYMENT_TYPES)[number];

export const STAFF_EMPLOYEE_CODE_MAX = 32;
export const STAFF_PROFILE_ERROR_CODES = {
  invalid: "STAFF_PROFILE_INVALID",
  exists: "STAFF_PROFILE_EXISTS",
  departmentMismatch: "STAFF_PROFILE_DEPARTMENT_MISMATCH"
} as const;

const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
const USER_NOT_FOUND = "Usuario no encontrado.";
const STAFF_PROFILE_EXISTS = "Ya existe una ficha de personal activa para esta persona en la propiedad.";
const DEPARTMENT_MISMATCH = "El departamento no pertenece a la propiedad de la ficha.";

/** Ficha en el cable: importes como texto con dos decimales (patrón de los informes de Finanzas). */
export type StaffProfileDto = {
  id: string;
  propertyId: string;
  userId: string;
  employeeCode: string | null;
  departmentId: string | null;
  departmentName: string | null;
  employmentType: string | null;
  hourlyCost: string | null;
  active: boolean;
  createdAt: string;
  userFullName: string | null;
  userEmail: string | null;
};

export type StaffProfileInput = {
  propertyId: string;
  userId: string;
  employeeCode?: string | null;
  departmentId?: string | null;
  employmentType?: string | null;
  hourlyCost?: number | string | null;
};

export type NormalisedStaffProfileInput = {
  propertyId: string;
  userId: string;
  employeeCode: string | null;
  departmentId: string | null;
  employmentType: StaffEmploymentType | null;
  /** «12.50» (dos decimales) o null. */
  hourlyCost: string | null;
};

type StaffProfileRow = {
  id: string;
  userId: string;
  propertyId: string;
  employeeCode: string | null;
  departmentId: string | null;
  employmentType: string | null;
  hourlyCost: unknown;
  active: boolean;
  createdAt: Date;
};
type UserRow = { id: string; fullName: string | null; email: string | null };
type DepartmentRow = { id: string; propertyId: string; name: string };

/** Subconjunto del cliente Prisma que usa el módulo (los tests unitarios pasan fakes en memoria). */
export type StaffProfileDeps = {
  db: {
    staffProfile: {
      findMany: (args: { where: { propertyId: string | { in: string[] } }; orderBy?: unknown }) => Promise<StaffProfileRow[]>;
      findFirst: (args: { where: { userId: string; propertyId: string; active: boolean }; select?: unknown }) => Promise<{ id: string } | null>;
      create: (args: { data: { userId: string; propertyId: string; employeeCode: string | null; departmentId: string | null; employmentType: string | null; hourlyCost: string | null; active: boolean } }) => Promise<StaffProfileRow>;
    };
    user: {
      findFirst: (args: { where: { id: string; organizationId: string }; select?: unknown }) => Promise<UserRow | null>;
      findMany: (args: { where: { id: { in: string[] } }; select?: unknown }) => Promise<UserRow[]>;
    };
    property: {
      findFirst: (args: { where: { id: string; organizationId: string }; select?: unknown }) => Promise<{ id: string } | null>;
      findMany: (args: { where: { organizationId: string }; select?: unknown }) => Promise<Array<{ id: string }>>;
    };
    department: {
      findFirst: (args: { where: { id: string; propertyId: string }; select?: unknown }) => Promise<DepartmentRow | null>;
      findMany: (args: { where: { id: { in: string[] } }; select?: unknown }) => Promise<DepartmentRow[]>;
    };
  };
  /** Departamentos del seed en memoria (hotel demo): mismo merge que listDepartments (backoffice.service). */
  demoDepartments: () => DepartmentRow[];
  audit: typeof recordAuditEvent;
};

export const defaultStaffProfileDeps: StaffProfileDeps = {
  db: prisma as unknown as StaffProfileDeps["db"],
  demoDepartments: () => demoStore.departments.map((department) => ({ id: department.id, propertyId: department.propertyId, name: department.name })),
  audit: recordAuditEvent
};

function invalid(message: string, field: string): BadRequestError {
  const error = new BadRequestError(message);
  error.details = { code: STAFF_PROFILE_ERROR_CODES.invalid, field };
  return error;
}

const HOURLY_COST = /^\d{1,10}([.,]\d{1,2})?$/;

/**
 * Reglas puras del alta (sin base de datos): identificadores obligatorios,
 * `employeeCode` recortado (vacío → null) y ≤ 32, `employmentType` del catálogo
 * (vacío → null), `hourlyCost` número o texto («12,5») finito ≥ 0 con hasta dos
 * decimales → «12.50». Lanza BadRequestError STAFF_PROFILE_INVALID con `field`.
 */
export function normaliseStaffProfileInput(body: StaffProfileInput): NormalisedStaffProfileInput {
  const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!propertyId) throw invalid("propertyId es obligatorio.", "propertyId");
  if (!userId) throw invalid("userId es obligatorio.", "userId");

  const employeeCode = typeof body.employeeCode === "string" ? body.employeeCode.trim() : "";
  if (employeeCode.length > STAFF_EMPLOYEE_CODE_MAX) throw invalid(`employeeCode no puede superar ${STAFF_EMPLOYEE_CODE_MAX} caracteres.`, "employeeCode");

  const departmentId = typeof body.departmentId === "string" ? body.departmentId.trim() : "";

  const employmentTypeRaw = typeof body.employmentType === "string" ? body.employmentType.trim() : "";
  if (employmentTypeRaw && !(STAFF_EMPLOYMENT_TYPES as readonly string[]).includes(employmentTypeRaw)) {
    throw invalid(`employmentType debe ser uno de: ${STAFF_EMPLOYMENT_TYPES.join(", ")}.`, "employmentType");
  }

  let hourlyCost: string | null = null;
  if (body.hourlyCost !== undefined && body.hourlyCost !== null && !(typeof body.hourlyCost === "string" && body.hourlyCost.trim() === "")) {
    const raw = typeof body.hourlyCost === "number" ? body.hourlyCost : Number(body.hourlyCost.trim().replace(",", "."));
    const wellFormed = typeof body.hourlyCost === "number" ? Number.isFinite(raw) : HOURLY_COST.test(body.hourlyCost.trim());
    if (!wellFormed || !Number.isFinite(raw) || raw < 0) throw invalid("hourlyCost debe ser un importe mayor o igual que 0 con dos decimales como máximo.", "hourlyCost");
    // Un número se redondea a dos decimales (Decimal(12,2)); un texto ya viene limitado por HOURLY_COST.
    hourlyCost = raw.toFixed(2);
  }

  return {
    propertyId,
    userId,
    employeeCode: employeeCode || null,
    departmentId: departmentId || null,
    employmentType: (employmentTypeRaw || null) as StaffEmploymentType | null,
    hourlyCost
  };
}

function decimalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const number = Number(typeof value === "object" && value !== null && "toString" in value ? String(value) : value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

function toDto(row: StaffProfileRow, user: UserRow | undefined, department: DepartmentRow | undefined): StaffProfileDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    userId: row.userId,
    employeeCode: row.employeeCode ?? null,
    departmentId: row.departmentId ?? null,
    departmentName: department?.name ?? null,
    employmentType: row.employmentType ?? null,
    hourlyCost: decimalText(row.hourlyCost),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    userFullName: user?.fullName ?? null,
    userEmail: user?.email ?? null
  };
}

async function resolveDepartment(deps: StaffProfileDeps, departmentId: string, propertyId: string): Promise<DepartmentRow | null> {
  const row = await deps.db.department.findFirst({ where: { id: departmentId, propertyId }, select: { id: true, propertyId: true, name: true } });
  if (row) return row;
  return deps.demoDepartments().find((department) => department.id === departmentId && department.propertyId === propertyId) ?? null;
}

/** Fichas de un centro (o de los centros en ámbito de la organización) con la persona y el departamento resueltos. */
export async function listStaffProfiles(
  input: { context: UserContext; propertyId?: string | null },
  deps: StaffProfileDeps = defaultStaffProfileDeps
): Promise<StaffProfileDto[]> {
  requirePermissions(input.context, ["payroll.read"]);
  const organizationId = input.context.organizationId;

  let propertyIds: string[];
  if (input.propertyId) {
    assertFinanceReadScope(input.context, input.propertyId);
    const property = await deps.db.property.findFirst({ where: { id: input.propertyId, organizationId }, select: { id: true } });
    if (!property) throw new NotFoundError(PROPERTY_NOT_FOUND);
    propertyIds = [property.id];
  } else {
    const properties = await deps.db.property.findMany({ where: { organizationId }, select: { id: true } });
    propertyIds = properties.map((property) => property.id).filter((id) => propertyWithinScope(input.context, id));
    if (propertyIds.length === 0) return [];
  }

  const rows = await deps.db.staffProfile.findMany({
    where: propertyIds.length === 1 ? { propertyId: propertyIds[0]! } : { propertyId: { in: propertyIds } },
    orderBy: [{ active: "desc" }, { employeeCode: "asc" }, { createdAt: "asc" }]
  });
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((row) => row.userId))];
  const departmentIds = [...new Set(rows.map((row) => row.departmentId).filter((id): id is string => Boolean(id)))];
  const [users, departments] = await Promise.all([
    deps.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }),
    departmentIds.length > 0 ? deps.db.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, propertyId: true, name: true } }) : Promise.resolve([] as DepartmentRow[])
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const departmentsById = new Map(departments.map((department) => [department.id, department]));
  for (const department of deps.demoDepartments()) if (!departmentsById.has(department.id) && departmentIds.includes(department.id)) departmentsById.set(department.id, department);

  return rows.map((row) => toDto(row, usersById.get(row.userId), row.departmentId ? departmentsById.get(row.departmentId) : undefined));
}

/** Alta de una ficha de personal (ver cabecera). Devuelve la ficha creada con la persona y el departamento resueltos. */
export async function createStaffProfile(
  input: { context: UserContext; body: StaffProfileInput; correlationId: string },
  deps: StaffProfileDeps = defaultStaffProfileDeps
): Promise<StaffProfileDto> {
  requirePermissions(input.context, ["payroll.manage"]);
  const body = normaliseStaffProfileInput(input.body);
  const organizationId = input.context.organizationId;

  // Propiedad de la organización y dentro del ámbito del actor (mismo 404 opaco para ambas cosas).
  const property = await deps.db.property.findFirst({ where: { id: body.propertyId, organizationId }, select: { id: true } });
  if (!property || !propertyWithinScope(input.context, body.propertyId)) throw new NotFoundError(PROPERTY_NOT_FOUND);

  const user = await deps.db.user.findFirst({ where: { id: body.userId, organizationId }, select: { id: true, fullName: true, email: true } });
  if (!user) throw new NotFoundError(USER_NOT_FOUND);

  let department: DepartmentRow | null = null;
  if (body.departmentId) {
    department = await resolveDepartment(deps, body.departmentId, body.propertyId);
    if (!department) {
      const mismatch = new BadRequestError(DEPARTMENT_MISMATCH);
      mismatch.details = { code: STAFF_PROFILE_ERROR_CODES.departmentMismatch };
      throw mismatch;
    }
  }

  const duplicate = await deps.db.staffProfile.findFirst({ where: { userId: body.userId, propertyId: body.propertyId, active: true }, select: { id: true } });
  if (duplicate) throw new ConflictError(STAFF_PROFILE_EXISTS, { code: STAFF_PROFILE_ERROR_CODES.exists, staffProfileId: duplicate.id });

  const created = await deps.db.staffProfile.create({
    data: {
      userId: body.userId,
      propertyId: body.propertyId,
      employeeCode: body.employeeCode,
      departmentId: body.departmentId,
      employmentType: body.employmentType,
      hourlyCost: body.hourlyCost,
      active: true
    }
  });

  deps.audit({
    organizationId,
    propertyId: body.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "STAFF_PROFILE_CREATED",
    entityType: "staff_profile",
    entityId: created.id,
    // Sin datos personales: identificadores y código de empleado (nunca nombre, correo ni coste).
    afterJson: { id: created.id, propertyId: body.propertyId, userId: body.userId, departmentId: body.departmentId, employeeCode: body.employeeCode, employmentType: body.employmentType },
    correlationId: input.correlationId
  });

  return toDto(created, user, department ?? undefined);
}
