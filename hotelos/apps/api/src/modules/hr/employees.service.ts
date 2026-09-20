// Expediente de empleado (Employee) · Tanda RRHH · RRHH-2
// (docs/design/RRHH-PLANTILLA-NOMINA.md §4 «Employee», §9 «Privacidad»; recon-delta §3.1/§3.3).
//
// El expediente es la persona ante la sociedad (NIF, afiliación, IBAN…); la ficha de
// centro (StaffProfile, payroll/staff-profiles.service) sigue siendo la entidad de
// turnos, fichajes y contratos y apunta al expediente por `employeeId`.
//
//   listEmployees({ context, query })       hr.employee.read | hr.employee.manage
//     · DTO EmployeeSummaryDto SIN PII: la consulta hace `select` de las columnas en claro,
//       así que NIF, NAF, correo, teléfono e IBAN ni siquiera se descifran; filtros por
//       centro (primaryPropertyId), sociedad, estado, fijo discontinuo y búsqueda `search`
//       por nombre, apellidos o número de empleado (nunca por NIF); filas fuera del
//       ámbito del actor (centro no asignado) no aparecen.
//   getEmployee({ context, employeeId, pii })   hr.employee.read | hr.employee.manage
//     · 404 OPACO (HR_EMPLOYEE_NOT_FOUND) si no existe, es de otra organización o su
//       centro está fuera del ámbito; `piiFields` = lo que el actor puede pedir (taxId,
//       socialSecurityNumber e iban SOLO con hr.employee.manage; email y phone con read);
//       `pii` solo cuando se pide (`pii: true`) → auditoría HR_PII_READ con los NOMBRES de
//       los campos (nunca los valores); un valor todavía cifrado (clave ausente) → 503
//       HR_PII_KEY_MISSING, jamás el envelope.
//   createEmployee({ context, body })       hr.employee.manage
//     · NIF/NIE normalizado y con letra de control válida (400 HR_TAXID_INVALID); duplicado
//       por sociedad vía hash de búsqueda (409 HR_EMPLOYEE_TAXID_DUPLICATE); número de empleado
//       único por sociedad (409 HR_EMPLOYEE_NUMBER_DUPLICATE; se genera «0001»… si falta);
//       sociedad/usuario/centro de la organización; audita HR_EMPLOYEE_CREATED sin PII.
//   patchEmployee({ context, employeeId, body })   hr.employee.manage
//     · mismos controles; un expediente dado de baja no se edita (409 HR_EMPLOYEE_TERMINATED);
//       audita HR_EMPLOYEE_UPDATED con los nombres de los campos cambiados (valores solo de
//       los campos en claro).
//   terminateEmployee({ context, employeeId, terminatedAt, reason })   hr.employee.manage
//     · status inactive + terminatedAt + terminationReason; desactiva las fichas de centro y
//       cierra los contratos activos con payroll/contracts.service deactivateContract (que
//       revoca las asignaciones RBAC del usuario y audita); si el expediente tiene usuario
//       sin contrato, revoca igualmente; audita HR_EMPLOYEE_TERMINATED.
//
// Cifrado: el cliente Prisma (packages/database client.ts) cifra al escribir y descifra al
// leer los campos de PII_FIELDS.Employee y rellena `taxIdLookupHash`; este módulo solo
// decide QUÉ se lee (select) y QUÉ se devuelve. Las consultas van por `deps` inyectables
// (patrón payroll/staff-profiles.service) para los tests con fakes en memoria.

import { computeLookupHash, isCiphertext, prisma } from "@hotelos/database";
import {
  EMPLOYEE_GENDERS,
  EMPLOYEE_STATUSES,
  HR_END_REASONS,
  HR_PII_FIELDS,
  HR_USALI_DEPARTMENTS,
  type EmployeeContractSummaryDto,
  type EmployeeDetailDto,
  type EmployeeGender,
  type EmployeeListQueryDto,
  type EmployeePiiDto,
  type EmployeeStatus,
  type EmployeeSummaryDto,
  type HrPiiField,
  type HrUsaliDepartment,
  type PermissionKey
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { propertyWithinScope } from "../../lib/finance-scope.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { deactivateContract, revokeAssignmentsOnLeave } from "../payroll/contracts.service.js";
import { dayUtc, isoDay, money } from "../treasury/money.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { hrBadRequest, hrConflict, hrNotFound, hrUnavailable } from "./hr-errors.js";

export const EMPLOYEE_READ_KEYS: PermissionKey[] = ["hr.employee.read", "hr.employee.manage"];
export const EMPLOYEE_WRITE_KEYS: PermissionKey[] = ["hr.employee.manage"];

/** Campos PII que hr.employee.read puede pedir; el resto (NIF, NAF, IBAN) exige hr.employee.manage. */
export const EMPLOYEE_PII_READ_FIELDS: readonly HrPiiField[] = ["email", "phone"];

export const EMPLOYEE_NAME_MAX = 120;
export const EMPLOYEE_NUMBER_MAX = 32;
export const EMPLOYEE_JOB_TITLE_MAX = 120;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// NIF / NIE (letra de control)
// ---------------------------------------------------------------------------

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const NIE_PREFIX: Record<string, string> = { X: "0", Y: "1", Z: "2" };

/** Mayúsculas y sin espacios, guiones ni puntos («12.345.678-z» → «12345678Z»). */
export function normaliseTaxId(raw: string): string {
  return raw.replace(/[\s\-.]/g, "").toUpperCase();
}

/**
 * NIF (8 dígitos + letra), NIE (X/Y/Z + 7 dígitos + letra) o NIF de persona física sin
 * DNI (K/L/M + 7 dígitos + letra) con la letra de control del módulo 23. Los CIF de
 * sociedades no son NIF de persona y se rechazan.
 */
export function isValidSpanishTaxId(raw: string): boolean {
  const value = normaliseTaxId(raw);
  const nif = /^(\d{8})([A-Z])$/.exec(value);
  if (nif) return NIF_LETTERS[Number(nif[1]) % 23] === nif[2];
  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(value);
  if (nie) return NIF_LETTERS[Number(`${NIE_PREFIX[nie[1]!]}${nie[2]}`) % 23] === nie[3];
  const special = /^([KLM])(\d{7})([A-Z])$/.exec(value);
  if (special) return NIF_LETTERS[Number(special[2]) % 23] === special[3];
  return false;
}

// ---------------------------------------------------------------------------
// Filas y dependencias
// ---------------------------------------------------------------------------

/** Columnas en claro del expediente (las que el listado selecciona). */
export type EmployeePublicRow = {
  id: string;
  organizationId: string;
  legalEntityId: string;
  employeeNumber: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  gender: string | null;
  primaryPropertyId: string | null;
  usaliDepartment: string | null;
  jobTitle: string | null;
  status: string;
  hiredAt: Date;
  terminatedAt: Date | null;
  terminationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Fila completa (el cliente ya la devuelve descifrada cuando hay clave). */
export type EmployeeRow = EmployeePublicRow & {
  taxId: string;
  taxIdLookupHash: string | null;
  socialSecurityNumber: string | null;
  email: string | null;
  phone: string | null;
  iban: string | null;
};

export const EMPLOYEE_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  legalEntityId: true,
  employeeNumber: true,
  userId: true,
  firstName: true,
  lastName: true,
  gender: true,
  primaryPropertyId: true,
  usaliDepartment: true,
  jobTitle: true,
  status: true,
  hiredAt: true,
  terminatedAt: true,
  terminationReason: true,
  createdAt: true,
  updatedAt: true
} as const;

type StaffProfileRow = { id: string; employeeId: string | null; propertyId: string; userId: string; active: boolean };
type ContractRow = {
  id: string;
  staffProfileId: string;
  propertyId: string | null;
  contractType: string;
  startDate: Date;
  endDate: Date | null;
  payCount: number;
  active: boolean;
  agreementId: string | null;
  weeklyHours: unknown;
  partTimePct: unknown;
  fixedDiscontinuous: boolean;
  contributionGroup: number | null;
};
type PropertyRow = { id: string; code: string | null; name: string };

export type EmployeeWhere = {
  organizationId: string;
  id?: string;
  legalEntityId?: string;
  status?: string;
  primaryPropertyId?: string;
  taxIdLookupHash?: string;
  taxId?: string;
  employeeNumber?: string;
  OR?: Array<Record<string, unknown>>;
};

export type EmployeeCreateData = {
  organizationId: string;
  legalEntityId: string;
  employeeNumber: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  taxId: string;
  socialSecurityNumber: string | null;
  email: string | null;
  phone: string | null;
  iban: string | null;
  gender: string | null;
  primaryPropertyId: string | null;
  usaliDepartment: string | null;
  jobTitle: string | null;
  status: string;
  hiredAt: Date;
};

export type EmployeeUpdateData = Partial<Omit<EmployeeCreateData, "organizationId" | "legalEntityId">> & { terminatedAt?: Date | null; terminationReason?: string | null };

/** Subconjunto del cliente Prisma que usa el módulo (los tests unitarios pasan fakes en memoria). */
export type EmployeeDeps = {
  db: {
    employee: {
      findMany: (args: { where: EmployeeWhere; select?: unknown; orderBy?: unknown }) => Promise<EmployeePublicRow[]>;
      findFirst: (args: { where: EmployeeWhere; select?: unknown }) => Promise<EmployeeRow | null>;
      count: (args: { where: EmployeeWhere }) => Promise<number>;
      create: (args: { data: EmployeeCreateData }) => Promise<EmployeeRow>;
      update: (args: { where: { id: string }; data: EmployeeUpdateData }) => Promise<EmployeeRow>;
    };
    legalEntity: { findFirst: (args: { where: { id: string; organizationId: string }; select?: unknown }) => Promise<{ id: string } | null> };
    user: { findFirst: (args: { where: { id: string; organizationId: string }; select?: unknown }) => Promise<{ id: string } | null> };
    property: {
      findFirst: (args: { where: { id: string; organizationId: string }; select?: unknown }) => Promise<PropertyRow | null>;
      findMany: (args: { where: { organizationId: string }; select?: unknown }) => Promise<PropertyRow[]>;
    };
    staffProfile: {
      findMany: (args: { where: { employeeId: string | { in: string[] } }; select?: unknown }) => Promise<StaffProfileRow[]>;
      updateMany: (args: { where: { id: { in: string[] } }; data: { active: boolean } }) => Promise<{ count: number }>;
    };
    employmentContract: {
      findMany: (args: { where: { staffProfileId: { in: string[] }; active?: boolean }; select?: unknown; orderBy?: unknown }) => Promise<ContractRow[]>;
    };
    collectiveAgreement: { findMany: (args: { where: { id: { in: string[] } }; select?: unknown }) => Promise<Array<{ id: string; code: string }>> };
  };
  /** Cierra el contrato (payroll.manage; revoca las asignaciones RBAC del usuario de la ficha). */
  deactivateContract: typeof deactivateContract;
  /** Revoca las asignaciones de un usuario con expediente pero sin contrato activo. */
  revokeAssignments: typeof revokeAssignmentsOnLeave;
  audit: typeof recordAuditEvent;
  /** HMAC determinista del NIF normalizado (null sin clave configurada: se busca en claro). */
  lookupHash: (plaintext: string) => string | null;
  now: () => Date;
  /**
   * Corrector RRHH (SEC-01): enlaza al expediente las fichas de centro (StaffProfile) del mismo usuario
   * en la organización que aún no tienen `employeeId` (alta o PATCH con `userId`); devuelve los ids
   * enlazados. Opcional: los fakes de los tests unitarios pueden omitirla.
   */
  linkStaffProfiles?: (input: { organizationId: string; userId: string; employeeId: string }) => Promise<string[]>;
};

async function linkStaffProfilesByUser(input: { organizationId: string; userId: string; employeeId: string }): Promise<string[]> {
  const properties = await prisma.property.findMany({ where: { organizationId: input.organizationId }, select: { id: true } });
  if (properties.length === 0) return [];
  const rows = await prisma.staffProfile.findMany({ where: { userId: input.userId, employeeId: null, propertyId: { in: properties.map((row) => row.id) } }, select: { id: true } });
  if (rows.length === 0) return [];
  await prisma.staffProfile.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { employeeId: input.employeeId } });
  return rows.map((row) => row.id);
}

export const defaultEmployeeDeps: EmployeeDeps = {
  db: prisma as unknown as EmployeeDeps["db"],
  deactivateContract,
  revokeAssignments: revokeAssignmentsOnLeave,
  audit: recordAuditEvent,
  lookupHash: (plaintext) => computeLookupHash(plaintext),
  now: () => new Date(),
  linkStaffProfiles: linkStaffProfilesByUser
};

// ---------------------------------------------------------------------------
// HR_PII_READ: una auditoría por minuto, usuario, expediente y ámbito (D §9; corrector RRHH · RF-12)
// ---------------------------------------------------------------------------

export const HR_PII_READ_AUDIT_WINDOW_MS = 60_000;
const piiReadStamps = new Map<string, number>();

/** true si toca emitir HR_PII_READ (primera lectura de la ventana); false si ya se auditó la misma pareja hace < 60 s. */
export function shouldAuditPiiRead(key: { organizationId: string; actorUserId: string; employeeId: string; scope: string }, now: Date): boolean {
  const id = `${key.organizationId}|${key.actorUserId}|${key.employeeId}|${key.scope}`;
  const at = now.getTime();
  const last = piiReadStamps.get(id);
  if (last !== undefined && at - last < HR_PII_READ_AUDIT_WINDOW_MS) return false;
  piiReadStamps.set(id, at);
  // Poda perezosa: las parejas caducadas no crecen sin límite.
  if (piiReadStamps.size > 5_000) for (const [candidate, stamp] of piiReadStamps) if (at - stamp >= HR_PII_READ_AUDIT_WINDOW_MS) piiReadStamps.delete(candidate);
  return true;
}

export function resetPiiReadAuditWindowForTests(): void {
  piiReadStamps.clear();
}

// ---------------------------------------------------------------------------
// Ámbito y PII
// ---------------------------------------------------------------------------

/** Un expediente sin centro principal es de la sociedad: solo lo ven actores con ámbito de organización. */
function rowWithinScope(context: UserContext, row: Pick<EmployeePublicRow, "primaryPropertyId">): boolean {
  if (row.primaryPropertyId) return propertyWithinScope(context, row.primaryPropertyId);
  if (context.isPlatformAdmin) return true;
  if (context.assignedPropertyIds === undefined) return context.orgScope !== false;
  return context.orgScope === true;
}

export function allowedPiiFields(context: UserContext): HrPiiField[] {
  const held = new Set(context.permissions ?? []);
  if (held.has("hr.employee.manage")) return [...HR_PII_FIELDS];
  if (held.has("hr.employee.read")) return [...EMPLOYEE_PII_READ_FIELDS];
  return [];
}

// ---------------------------------------------------------------------------
// Validación (reglas puras)
// ---------------------------------------------------------------------------

function invalid(field: string, message: string) {
  return hrBadRequest("VALIDATION_ERROR", { field, message });
}

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw invalid(field, `${field} es obligatorio.`);
    return null;
  }
  if (typeof value !== "string") throw invalid(field, `${field} debe ser un texto.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw invalid(field, `${field} es obligatorio.`);
    return null;
  }
  if (trimmed.length > max) throw invalid(field, `${field} no puede superar ${max} caracteres.`);
  return trimmed;
}

function oneOf<T extends string>(value: unknown, field: string, catalog: readonly T[], required: boolean): T | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(field, `${field} es obligatorio.`);
    return null;
  }
  if (typeof value !== "string" || !(catalog as readonly string[]).includes(value)) throw invalid(field, `${field} debe ser uno de: ${catalog.join(", ")}.`);
  return value as T;
}

function parseDay(value: unknown, field: string, required: boolean): Date | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(field, `${field} es obligatoria (YYYY-MM-DD).`);
    return null;
  }
  if (typeof value !== "string" || !ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw invalid(field, `${field} debe ser una fecha YYYY-MM-DD.`);
  return dayUtc(value);
}

function taxIdInput(value: unknown): string {
  const raw = text(value, "taxId", 20, true)!;
  if (!isValidSpanishTaxId(raw)) throw hrBadRequest("HR_TAXID_INVALID", { field: "taxId" });
  return normaliseTaxId(raw);
}

function ibanInput(value: unknown): string | null {
  const raw = text(value, "iban", 40, false);
  if (raw === null) return null;
  const normalised = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalised)) throw invalid("iban", "iban no tiene un formato válido.");
  return normalised;
}

function emailInput(value: unknown): string | null {
  const raw = text(value, "email", 160, false);
  if (raw === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw invalid("email", "email no es una dirección válida.");
  return raw.toLowerCase();
}

export type EmployeeInput = {
  legalEntityId: string;
  employeeNumber?: string | null;
  userId?: string | null;
  firstName: string;
  lastName: string;
  taxId: string;
  socialSecurityNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  iban?: string | null;
  gender?: EmployeeGender | null;
  primaryPropertyId?: string | null;
  usaliDepartment?: HrUsaliDepartment | null;
  jobTitle?: string | null;
  /** active (por defecto) o leave; la baja va por terminateEmployee. */
  status?: Exclude<EmployeeStatus, "inactive"> | null;
  hiredAt: string;
};

export type EmployeePatchInput = Partial<Omit<EmployeeInput, "legalEntityId">>;

type NormalisedEmployeeInput = Omit<EmployeeCreateData, "organizationId" | "employeeNumber"> & { employeeNumber: string | null };

/** Reglas puras del alta (sin base de datos): normaliza, valida NIF/NIE, catálogos y fechas. */
export function normaliseEmployeeInput(body: EmployeeInput): NormalisedEmployeeInput {
  if (typeof body !== "object" || body === null) throw invalid("body", "Cuerpo de la petición no válido.");
  const status = oneOf(body.status ?? "active", "status", EMPLOYEE_STATUSES.filter((value) => value !== "inactive"), true)!;
  return {
    legalEntityId: text(body.legalEntityId, "legalEntityId", 64, true)!,
    employeeNumber: text(body.employeeNumber, "employeeNumber", EMPLOYEE_NUMBER_MAX, false),
    userId: text(body.userId, "userId", 64, false),
    firstName: text(body.firstName, "firstName", EMPLOYEE_NAME_MAX, true)!,
    lastName: text(body.lastName, "lastName", EMPLOYEE_NAME_MAX, true)!,
    taxId: taxIdInput(body.taxId),
    socialSecurityNumber: text(body.socialSecurityNumber, "socialSecurityNumber", 20, false)?.replace(/[\s\-/]/g, "") ?? null,
    email: emailInput(body.email),
    phone: text(body.phone, "phone", 32, false),
    iban: ibanInput(body.iban),
    gender: oneOf(body.gender, "gender", EMPLOYEE_GENDERS, false),
    primaryPropertyId: text(body.primaryPropertyId, "primaryPropertyId", 64, false),
    usaliDepartment: oneOf(body.usaliDepartment, "usaliDepartment", HR_USALI_DEPARTMENTS, false),
    jobTitle: text(body.jobTitle, "jobTitle", EMPLOYEE_JOB_TITLE_MAX, false),
    status,
    hiredAt: parseDay(body.hiredAt, "hiredAt", true)!
  };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function ratio(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return money(value as string);
}

function toContractSummary(row: ContractRow, agreementCodes: Map<string, string>): EmployeeContractSummaryDto {
  return {
    id: row.id,
    staffProfileId: row.staffProfileId,
    propertyId: row.propertyId,
    contractType: row.contractType,
    startDate: isoDay(row.startDate),
    endDate: row.endDate ? isoDay(row.endDate) : null,
    weeklyHours: ratio(row.weeklyHours),
    partTimePct: ratio(row.partTimePct),
    fixedDiscontinuous: row.fixedDiscontinuous,
    contributionGroup: row.contributionGroup,
    agreementId: row.agreementId,
    agreementCode: row.agreementId ? (agreementCodes.get(row.agreementId) ?? null) : null,
    payCount: row.payCount,
    active: row.active
  };
}

type EmployeeGraph = {
  properties: Map<string, PropertyRow>;
  profilesByEmployee: Map<string, StaffProfileRow[]>;
  contractsByProfile: Map<string, ContractRow[]>;
  agreementCodes: Map<string, string>;
};

function contractsOf(employeeId: string, graph: EmployeeGraph): EmployeeContractSummaryDto[] {
  const profiles = graph.profilesByEmployee.get(employeeId) ?? [];
  const rows = profiles.flatMap((profile) => graph.contractsByProfile.get(profile.id) ?? []);
  rows.sort((a, b) => Number(b.active) - Number(a.active) || b.startDate.getTime() - a.startDate.getTime());
  return rows.map((row) => toContractSummary(row, graph.agreementCodes));
}

function toSummary(row: EmployeePublicRow, graph: EmployeeGraph): EmployeeSummaryDto {
  const property = row.primaryPropertyId ? graph.properties.get(row.primaryPropertyId) : undefined;
  const contracts = contractsOf(row.id, graph);
  const current = contracts.find((contract) => contract.active) ?? null;
  return {
    id: row.id,
    employeeNumber: row.employeeNumber,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    legalEntityId: row.legalEntityId,
    primaryPropertyId: row.primaryPropertyId,
    propertyCode: property?.code ?? null,
    propertyName: property?.name ?? null,
    usaliDepartment: (row.usaliDepartment as HrUsaliDepartment | null) ?? null,
    jobTitle: row.jobTitle,
    status: (EMPLOYEE_STATUSES as readonly string[]).includes(row.status) ? (row.status as EmployeeStatus) : "active",
    hiredAt: isoDay(row.hiredAt),
    terminatedAt: row.terminatedAt ? isoDay(row.terminatedAt) : null,
    userId: row.userId,
    staffProfileIds: (graph.profilesByEmployee.get(row.id) ?? []).map((profile) => profile.id),
    contract: current,
    contractEndsAt: current?.endDate ?? null
  };
}

async function loadGraph(deps: EmployeeDeps, organizationId: string, employeeIds: string[]): Promise<EmployeeGraph> {
  const properties = await deps.db.property.findMany({ where: { organizationId }, select: { id: true, code: true, name: true } });
  const profiles = employeeIds.length > 0 ? await deps.db.staffProfile.findMany({ where: { employeeId: { in: employeeIds } }, select: { id: true, employeeId: true, propertyId: true, userId: true, active: true } }) : [];
  const contracts =
    profiles.length > 0
      ? await deps.db.employmentContract.findMany({
          where: { staffProfileId: { in: profiles.map((profile) => profile.id) } },
          select: { id: true, staffProfileId: true, propertyId: true, contractType: true, startDate: true, endDate: true, payCount: true, active: true, agreementId: true, weeklyHours: true, partTimePct: true, fixedDiscontinuous: true, contributionGroup: true },
          orderBy: { startDate: "desc" }
        })
      : [];
  const agreementIds = [...new Set(contracts.map((contract) => contract.agreementId).filter((id): id is string => typeof id === "string"))];
  const agreements = agreementIds.length > 0 ? await deps.db.collectiveAgreement.findMany({ where: { id: { in: agreementIds } }, select: { id: true, code: true } }) : [];
  const profilesByEmployee = new Map<string, StaffProfileRow[]>();
  for (const profile of profiles) {
    if (!profile.employeeId) continue;
    const list = profilesByEmployee.get(profile.employeeId) ?? [];
    list.push(profile);
    profilesByEmployee.set(profile.employeeId, list);
  }
  const contractsByProfile = new Map<string, ContractRow[]>();
  for (const contract of contracts) {
    const list = contractsByProfile.get(contract.staffProfileId) ?? [];
    list.push(contract);
    contractsByProfile.set(contract.staffProfileId, list);
  }
  return {
    properties: new Map(properties.map((property) => [property.id, property])),
    profilesByEmployee,
    contractsByProfile,
    agreementCodes: new Map(agreements.map((agreement) => [agreement.id, agreement.code]))
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function listEmployees(input: { context: UserContext; query?: EmployeeListQueryDto | null }, deps: EmployeeDeps = defaultEmployeeDeps): Promise<EmployeeSummaryDto[]> {
  requireAnyPermission(input.context, EMPLOYEE_READ_KEYS);
  const organizationId = input.context.organizationId;
  const query = input.query ?? {};
  const where: EmployeeWhere = { organizationId };
  if (query.propertyId) {
    const property = await deps.db.property.findFirst({ where: { id: query.propertyId, organizationId }, select: { id: true, code: true, name: true } });
    if (!property || !propertyWithinScope(input.context, query.propertyId)) throw hrNotFound("PROPERTY_NOT_FOUND");
    where.primaryPropertyId = query.propertyId;
  }
  if (query.legalEntityId) where.legalEntityId = text(query.legalEntityId, "legalEntityId", 64, true)!;
  if (query.status) where.status = oneOf(query.status, "status", EMPLOYEE_STATUSES, true)!;
  const search = typeof query.search === "string" ? query.search.trim() : "";
  if (search.length > 0) {
    where.OR = [
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { employeeNumber: { contains: search, mode: "insensitive" } }
    ];
  }
  const rows = (await deps.db.employee.findMany({ where, select: EMPLOYEE_PUBLIC_SELECT, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] })).filter((row) => rowWithinScope(input.context, row));
  const graph = await loadGraph(deps, organizationId, rows.map((row) => row.id));
  let summaries = rows.map((row) => toSummary(row, graph));
  if (query.fixedDiscontinuous === true) summaries = summaries.filter((row) => row.contract?.fixedDiscontinuous === true);
  else if (query.fixedDiscontinuous === false) summaries = summaries.filter((row) => row.contract?.fixedDiscontinuous !== true);
  summaries.sort((a, b) => a.lastName.localeCompare(b.lastName, "es") || a.firstName.localeCompare(b.firstName, "es"));
  return summaries;
}

async function requireEmployee(deps: EmployeeDeps, context: UserContext, employeeId: string): Promise<EmployeeRow> {
  const row = await deps.db.employee.findFirst({ where: { organizationId: context.organizationId, id: employeeId } });
  if (!row || !rowWithinScope(context, row)) throw hrNotFound("HR_EMPLOYEE_NOT_FOUND");
  return row;
}

function piiOf(row: EmployeeRow, fields: readonly HrPiiField[]): EmployeePiiDto {
  const pii: EmployeePiiDto = { taxId: null, socialSecurityNumber: null, email: null, phone: null, iban: null };
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    // Sin clave de cifrado el cliente devuelve el envelope tal cual: nunca sale del API.
    if (isCiphertext(value)) throw hrUnavailable("HR_PII_KEY_MISSING");
    pii[field] = value;
  }
  return pii;
}

async function toDetail(deps: EmployeeDeps, row: EmployeeRow, piiFields: HrPiiField[], pii: EmployeePiiDto | null): Promise<EmployeeDetailDto> {
  const graph = await loadGraph(deps, row.organizationId, [row.id]);
  return {
    ...toSummary(row, graph),
    gender: (row.gender as EmployeeGender | null) ?? null,
    terminationReason: row.terminationReason,
    contracts: contractsOf(row.id, graph),
    piiFields,
    pii,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function getEmployee(input: { context: UserContext; employeeId: string; pii?: boolean; correlationId?: string }, deps: EmployeeDeps = defaultEmployeeDeps): Promise<EmployeeDetailDto> {
  requireAnyPermission(input.context, EMPLOYEE_READ_KEYS);
  const row = await requireEmployee(deps, input.context, input.employeeId);
  const piiFields = allowedPiiFields(input.context);
  let pii: EmployeePiiDto | null = null;
  if (input.pii === true && piiFields.length > 0) {
    pii = piiOf(row, piiFields);
    const scope = piiFields.length === HR_PII_FIELDS.length ? "manage" : "read";
    if (shouldAuditPiiRead({ organizationId: row.organizationId, actorUserId: input.context.userId, employeeId: row.id, scope }, deps.now())) deps.audit({
      organizationId: row.organizationId,
      propertyId: row.primaryPropertyId ?? undefined,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "HR_PII_READ",
      entityType: "employee",
      entityId: row.id,
      // Solo los NOMBRES de los campos descifrados: nunca NIF, NAF, correo, teléfono ni IBAN.
      afterJson: { employeeId: row.id, fields: piiFields.filter((field) => pii![field] !== null), scope, windowMs: HR_PII_READ_AUDIT_WINDOW_MS },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }
  return toDetail(deps, row, piiFields, pii);
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

function auditSnapshot(row: EmployeePublicRow): Record<string, unknown> {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    employeeNumber: row.employeeNumber,
    userId: row.userId,
    primaryPropertyId: row.primaryPropertyId,
    usaliDepartment: row.usaliDepartment,
    jobTitle: row.jobTitle,
    status: row.status,
    hiredAt: isoDay(row.hiredAt),
    terminatedAt: row.terminatedAt ? isoDay(row.terminatedAt) : null,
    terminationReason: row.terminationReason
  };
}

async function assertReferences(deps: EmployeeDeps, context: UserContext, body: { legalEntityId?: string; userId?: string | null; primaryPropertyId?: string | null }): Promise<void> {
  const organizationId = context.organizationId;
  if (body.legalEntityId !== undefined) {
    const entity = await deps.db.legalEntity.findFirst({ where: { id: body.legalEntityId, organizationId }, select: { id: true } });
    if (!entity) throw invalid("legalEntityId", "Sociedad no encontrada en la organización.");
  }
  if (body.primaryPropertyId) {
    const property = await deps.db.property.findFirst({ where: { id: body.primaryPropertyId, organizationId }, select: { id: true, code: true, name: true } });
    if (!property || !propertyWithinScope(context, body.primaryPropertyId)) throw hrNotFound("PROPERTY_NOT_FOUND");
  }
  if (body.userId) {
    const user = await deps.db.user.findFirst({ where: { id: body.userId, organizationId }, select: { id: true } });
    if (!user) throw invalid("userId", "Usuario no encontrado en la organización.");
  }
}

/** Duplicado de NIF por sociedad: por hash de búsqueda (HMAC) o, sin clave configurada, en claro. */
async function findTaxIdDuplicate(deps: EmployeeDeps, organizationId: string, legalEntityId: string, taxId: string): Promise<EmployeeRow | null> {
  const hash = deps.lookupHash(taxId);
  return deps.db.employee.findFirst({ where: hash ? { organizationId, legalEntityId, taxIdLookupHash: hash } : { organizationId, legalEntityId, taxId } });
}

async function nextEmployeeNumber(deps: EmployeeDeps, organizationId: string, legalEntityId: string): Promise<string> {
  const count = await deps.db.employee.count({ where: { organizationId, legalEntityId } });
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const candidate = String(count + attempt).padStart(4, "0");
    const taken = await deps.db.employee.findFirst({ where: { organizationId, legalEntityId, employeeNumber: candidate } });
    if (!taken) return candidate;
  }
  throw hrConflict("HR_EMPLOYEE_NUMBER_DUPLICATE", { message: "No se pudo generar un número de empleado libre." });
}

function isUniqueViolation(error: unknown): { target: string } | null {
  const candidate = error as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!candidate || candidate.code !== "P2002") return null;
  const target = candidate.meta?.target;
  return { target: Array.isArray(target) ? target.join(",") : String(target ?? "") };
}

export async function createEmployee(input: { context: UserContext; body: EmployeeInput; correlationId: string }, deps: EmployeeDeps = defaultEmployeeDeps): Promise<EmployeeDetailDto> {
  requireAnyPermission(input.context, EMPLOYEE_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const body = normaliseEmployeeInput(input.body);
  await assertReferences(deps, input.context, body);

  const duplicate = await findTaxIdDuplicate(deps, organizationId, body.legalEntityId, body.taxId);
  if (duplicate) throw hrConflict("HR_EMPLOYEE_TAXID_DUPLICATE", { employeeId: duplicate.id });
  if (body.employeeNumber) {
    const taken = await deps.db.employee.findFirst({ where: { organizationId, legalEntityId: body.legalEntityId, employeeNumber: body.employeeNumber } });
    if (taken) throw hrConflict("HR_EMPLOYEE_NUMBER_DUPLICATE", { employeeId: taken.id, employeeNumber: body.employeeNumber });
  }
  const employeeNumber = body.employeeNumber ?? (await nextEmployeeNumber(deps, organizationId, body.legalEntityId));

  let created: EmployeeRow;
  try {
    created = await deps.db.employee.create({ data: { ...body, organizationId, employeeNumber } });
  } catch (error) {
    const unique = isUniqueViolation(error);
    if (unique) throw hrConflict(unique.target.includes("tax_id") ? "HR_EMPLOYEE_TAXID_DUPLICATE" : "HR_EMPLOYEE_NUMBER_DUPLICATE");
    throw error;
  }

  // SEC-01: las fichas de centro del mismo usuario quedan enlazadas al expediente (baja en cascada, contratos en Plantilla).
  const linkedStaffProfileIds = created.userId && deps.linkStaffProfiles ? await deps.linkStaffProfiles({ organizationId, userId: created.userId, employeeId: created.id }) : [];

  deps.audit({
    organizationId,
    propertyId: created.primaryPropertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_EMPLOYEE_CREATED",
    entityType: "employee",
    entityId: created.id,
    // Sin datos personales: identificadores, número de empleado y qué campos PII se cifraron.
    afterJson: { ...auditSnapshot(created), piiFieldsSet: HR_PII_FIELDS.filter((field) => created[field] !== null && created[field] !== undefined), linkedStaffProfileIds },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return toDetail(deps, created, allowedPiiFields(input.context), null);
}

const PATCHABLE_PII: readonly HrPiiField[] = HR_PII_FIELDS;

export async function patchEmployee(input: { context: UserContext; employeeId: string; body: EmployeePatchInput; correlationId: string }, deps: EmployeeDeps = defaultEmployeeDeps): Promise<EmployeeDetailDto> {
  requireAnyPermission(input.context, EMPLOYEE_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const existing = await requireEmployee(deps, input.context, input.employeeId);
  if (existing.status === "inactive" || existing.terminatedAt) throw hrConflict("HR_EMPLOYEE_TERMINATED", { employeeId: existing.id });
  const body = input.body ?? {};
  if (typeof body !== "object" || body === null) throw invalid("body", "Cuerpo de la petición no válido.");

  const data: EmployeeUpdateData = {};
  if (body.firstName !== undefined) data.firstName = text(body.firstName, "firstName", EMPLOYEE_NAME_MAX, true)!;
  if (body.lastName !== undefined) data.lastName = text(body.lastName, "lastName", EMPLOYEE_NAME_MAX, true)!;
  if (body.employeeNumber !== undefined) data.employeeNumber = text(body.employeeNumber, "employeeNumber", EMPLOYEE_NUMBER_MAX, true)!;
  if (body.userId !== undefined) data.userId = text(body.userId, "userId", 64, false);
  if (body.taxId !== undefined) data.taxId = taxIdInput(body.taxId);
  if (body.socialSecurityNumber !== undefined) data.socialSecurityNumber = text(body.socialSecurityNumber, "socialSecurityNumber", 20, false)?.replace(/[\s\-/]/g, "") ?? null;
  if (body.email !== undefined) data.email = emailInput(body.email);
  if (body.phone !== undefined) data.phone = text(body.phone, "phone", 32, false);
  if (body.iban !== undefined) data.iban = ibanInput(body.iban);
  if (body.gender !== undefined) data.gender = oneOf(body.gender, "gender", EMPLOYEE_GENDERS, false);
  if (body.primaryPropertyId !== undefined) data.primaryPropertyId = text(body.primaryPropertyId, "primaryPropertyId", 64, false);
  if (body.usaliDepartment !== undefined) data.usaliDepartment = oneOf(body.usaliDepartment, "usaliDepartment", HR_USALI_DEPARTMENTS, false);
  if (body.jobTitle !== undefined) data.jobTitle = text(body.jobTitle, "jobTitle", EMPLOYEE_JOB_TITLE_MAX, false);
  if (body.status !== undefined) data.status = oneOf(body.status, "status", EMPLOYEE_STATUSES.filter((value) => value !== "inactive"), true)!;
  if (body.hiredAt !== undefined) data.hiredAt = parseDay(body.hiredAt, "hiredAt", true)!;
  if (Object.keys(data).length === 0) throw invalid("body", "No hay cambios que aplicar.");

  await assertReferences(deps, input.context, { userId: data.userId, primaryPropertyId: data.primaryPropertyId });
  if (data.taxId !== undefined && data.taxId !== normaliseTaxId(existing.taxId ?? "")) {
    const duplicate = await findTaxIdDuplicate(deps, organizationId, existing.legalEntityId, data.taxId);
    if (duplicate && duplicate.id !== existing.id) throw hrConflict("HR_EMPLOYEE_TAXID_DUPLICATE", { employeeId: duplicate.id });
  }
  if (data.employeeNumber !== undefined && data.employeeNumber !== existing.employeeNumber) {
    const taken = await deps.db.employee.findFirst({ where: { organizationId, legalEntityId: existing.legalEntityId, employeeNumber: data.employeeNumber } });
    if (taken && taken.id !== existing.id) throw hrConflict("HR_EMPLOYEE_NUMBER_DUPLICATE", { employeeId: taken.id, employeeNumber: data.employeeNumber });
  }

  let updated: EmployeeRow;
  try {
    updated = await deps.db.employee.update({ where: { id: existing.id }, data });
  } catch (error) {
    const unique = isUniqueViolation(error);
    if (unique) throw hrConflict(unique.target.includes("tax_id") ? "HR_EMPLOYEE_TAXID_DUPLICATE" : "HR_EMPLOYEE_NUMBER_DUPLICATE");
    throw error;
  }

  const changedFields = Object.keys(data).sort();
  const changedPii = changedFields.filter((field) => (PATCHABLE_PII as readonly string[]).includes(field));
  const linkedStaffProfileIds = data.userId && deps.linkStaffProfiles ? await deps.linkStaffProfiles({ organizationId, userId: data.userId, employeeId: updated.id }) : [];
  deps.audit({
    organizationId,
    propertyId: updated.primaryPropertyId ?? existing.primaryPropertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_EMPLOYEE_UPDATED",
    entityType: "employee",
    entityId: updated.id,
    beforeJson: auditSnapshot(existing),
    // Valores solo de los campos en claro; de la PII, únicamente el nombre del campo cambiado.
    afterJson: { ...auditSnapshot(updated), changedFields, changedPiiFields: changedPii, linkedStaffProfileIds },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return toDetail(deps, updated, allowedPiiFields(input.context), null);
}

export type TerminateEmployeeResult = {
  employee: EmployeeDetailDto;
  deactivatedStaffProfileIds: string[];
  deactivatedContractIds: string[];
  revokedAssignmentIds: string[];
};

/**
 * Baja del expediente: status inactive, fecha y causa; fichas de centro desactivadas;
 * contratos activos cerrados por deactivateContract (endDate = fecha de baja, endReason =
 * causa; revoca las asignaciones RBAC del usuario de la ficha y audita); un expediente con
 * usuario y sin contrato activo también pierde el acceso. Un segundo terminate → 409.
 */
export async function terminateEmployee(
  input: { context: UserContext; employeeId: string; terminatedAt?: string | null; reason?: string | null; correlationId: string },
  deps: EmployeeDeps = defaultEmployeeDeps
): Promise<TerminateEmployeeResult> {
  requireAnyPermission(input.context, EMPLOYEE_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const existing = await requireEmployee(deps, input.context, input.employeeId);
  if (existing.status === "inactive" || existing.terminatedAt) throw hrConflict("HR_EMPLOYEE_TERMINATED", { employeeId: existing.id });
  const terminatedAt = parseDay(input.terminatedAt ?? null, "terminatedAt", false) ?? dayUtc(deps.now());
  if (terminatedAt.getTime() < existing.hiredAt.getTime()) throw invalid("terminatedAt", "terminatedAt debe ser igual o posterior a hiredAt.");
  const reason = oneOf(input.reason ?? "other", "reason", HR_END_REASONS, true)!;
  const terminatedAtIso = isoDay(terminatedAt);

  const profiles = await deps.db.staffProfile.findMany({ where: { employeeId: existing.id }, select: { id: true, employeeId: true, propertyId: true, userId: true, active: true } });
  const activeContracts = profiles.length > 0 ? await deps.db.employmentContract.findMany({ where: { staffProfileId: { in: profiles.map((profile) => profile.id) }, active: true } }) : [];

  const deactivatedContractIds: string[] = [];
  const revokedAssignmentIds: string[] = [];
  for (const contract of activeContracts) {
    const closed = await deps.deactivateContract({ context: input.context, contractId: contract.id, correlationId: input.correlationId, endDate: terminatedAtIso, endReason: reason });
    deactivatedContractIds.push(closed.id);
  }
  const activeProfileIds = profiles.filter((profile) => profile.active).map((profile) => profile.id);
  if (activeProfileIds.length > 0) await deps.db.staffProfile.updateMany({ where: { id: { in: activeProfileIds } }, data: { active: false } });

  // Acceso: deactivateContract ya revocó las asignaciones del usuario de cada ficha; el
  // usuario del expediente (o de una ficha sin contrato) se revoca aquí, idempotente.
  const coveredUserIds = new Set(activeContracts.map((contract) => profiles.find((profile) => profile.id === contract.staffProfileId)?.userId).filter((id): id is string => typeof id === "string"));
  const remainingUserIds = new Set<string>();
  if (existing.userId) remainingUserIds.add(existing.userId);
  for (const profile of profiles) remainingUserIds.add(profile.userId);
  for (const userId of remainingUserIds) {
    if (coveredUserIds.has(userId)) continue;
    revokedAssignmentIds.push(...(await deps.revokeAssignments({ context: input.context, organizationId, userId, contractId: deactivatedContractIds[0] ?? `employee:${existing.id}`, correlationId: input.correlationId })));
  }

  const updated = await deps.db.employee.update({ where: { id: existing.id }, data: { status: "inactive", terminatedAt, terminationReason: reason } });

  deps.audit({
    organizationId,
    propertyId: updated.primaryPropertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_EMPLOYEE_TERMINATED",
    entityType: "employee",
    entityId: updated.id,
    beforeJson: auditSnapshot(existing),
    afterJson: { ...auditSnapshot(updated), deactivatedStaffProfileIds: activeProfileIds, deactivatedContractIds, revokedAssignmentIds },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return { employee: await toDetail(deps, updated, allowedPiiFields(input.context), null), deactivatedStaffProfileIds: activeProfileIds, deactivatedContractIds, revokedAssignmentIds };
}
