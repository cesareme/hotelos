// RBAC por departamento (Tanda 8a · L1) · asignaciones, roles, grupos de
// propiedades y usuarios por ámbito (design §4.1, §4.2, §4.7, §6.3).
//
// Reglas (fail-secure, todas auditadas):
//   · una asignación es plantilla × ámbito (property / property_group /
//     legal_entity / organization) escrita en user_role_assignments; la
//     revocación es un UPDATE (revokedAt, revokedByUserId, reason), nunca un
//     DELETE: la fila es la traza del acceso. Las filas legacy de
//     user_property_roles se listan (`legacy:<id>`) y se pueden retirar hasta
//     el corte de L6;
//   · ámbito ⊆ ámbito del llamante (propiedad cubierta; sociedad / organización
//     solo con orgScope) → 403 RBAC_SCOPE_EXCEEDED;
//   · nivel ≤ nivel del llamante en el ámbito destino (ROLE_LEVEL_RANK:
//     general_management solo desde rango ≥ 5, ownership solo desde ownership
//     o plataforma) → 403 RBAC_LEVEL_EXCEEDED;
//   · nadie se concede permisos a sí mismo → 403 RBAC_SELF_ASSIGNMENT;
//   · rol de otra organización, con clave de plataforma o plantilla
//     break_glass → 404 opaco (nunca un oráculo);
//   · separación de funciones estática: la unión de claves de las asignaciones
//     vivas del usuario que cubren la misma propiedad + el rol nuevo no puede
//     contener un par de SOD_STATIC_PAIRS → 409 RBAC_SOD_CONFLICT;
//   · una sesión de emergencia (break glass, §4.8) OPERA pero no concede
//     accesos permanentes → 403 RBAC_BREAK_GLASS_FORBIDDEN en toda escritura
//     de roles, asignaciones, umbrales, PIN y apertura de otra emergencia;
//   · cada escritura llama a bumpRbacVersion (las sesiones vivas releen su
//     ámbito en la siguiente petición).
//
// Este fichero también aloja los helpers que comparten los demás servicios del
// módulo (deps inyectables para los tests con BD falsa, permisos de un contexto
// en UNA propiedad, regla común de break glass).

import {
  PERMISSIONS,
  ROLE_LEVEL_RANK,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LEVEL,
  SOD_STATIC_PAIRS,
  isPlatformPermission,
  type PermissionKey,
  type PropertyGroupDto,
  type RbacUserRowDto,
  type RoleKey,
  type RoleLevel,
  type ScopeType,
  type SodStaticPair,
  type UserRoleAssignmentDto
} from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { createRoleFromTemplate as catalogCreateRoleFromTemplate } from "../../lib/rbac-catalog.js";
import {
  bumpRbacVersion,
  coversProperty,
  loadUserScope,
  maxRankOf,
  permissionsFor,
  rankOfAssignment,
  type RbacScopeDb,
  type UserScope
} from "../../lib/rbac-scope.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions, unionPermissions } from "../auth/auth.service.js";

// ---------------------------------------------------------------------------
// Shared helpers (used by approvals / thresholds / supervisor / break-glass)
// ---------------------------------------------------------------------------

/** Injectable collaborators: the Prisma client (or a fake), the audit writer and the clock. */
export type RbacDeps = {
  db: RbacScopeDb;
  audit: typeof recordAuditEvent;
  now: () => Date;
};

export const defaultRbacDeps: RbacDeps = { db: prisma, audit: recordAuditEvent, now: () => new Date() };

export function withDeps(deps?: Partial<RbacDeps>): RbacDeps {
  return { ...defaultRbacDeps, ...(deps ?? {}) };
}

export const USER_NOT_FOUND = "Usuario no encontrado.";
export const ROLE_NOT_FOUND = "Rol no encontrado.";
export const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
export const GROUP_NOT_FOUND = "Grupo de propiedades no encontrado.";
export const LEGAL_ENTITY_NOT_FOUND = "Sociedad no encontrada.";
export const ASSIGNMENT_NOT_FOUND = "Asignación no encontrada.";

/** True inside a break-glass session (§4.8). */
export function isBreakGlassContext(context: Pick<UserContext, "breakGlassSessionId">): boolean {
  return typeof context.breakGlassSessionId === "string" && context.breakGlassSessionId.length > 0;
}

/** REGLA COMÚN: an emergency session operates, it never grants permanent access. */
export function assertNotBreakGlass(context: Pick<UserContext, "breakGlassSessionId">): void {
  if (isBreakGlassContext(context)) {
    throw new RbacForbiddenError("Una sesión de emergencia no puede conceder accesos permanentes.", "RBAC_BREAK_GLASS_FORBIDDEN");
  }
}

/** The caller's scope (memoised reader of lib/rbac-scope.ts; the fake db of the tests bypasses the memo). */
export function scopeOfContext(context: Pick<UserContext, "userId" | "organizationId">, deps: RbacDeps = defaultRbacDeps): Promise<UserScope> {
  return loadUserScope(context.userId, context.organizationId, deps.db);
}

/**
 * Keys the context holds in ONE property (or for the organisation routes with
 * null), resolved from its assignments — never from `context.permissions`,
 * which the scope hook resolved for the property of the REQUEST (an approval
 * of a refund in B decided from a request without property must be checked
 * against B). Platform admins keep their home keys on properties they do not
 * cover; the demo union applies exactly like in the gate.
 */
export async function permissionsInProperty(context: UserContext, propertyId: string | null, deps: RbacDeps = defaultRbacDeps): Promise<PermissionKey[]> {
  const scope = await scopeOfContext(context, deps);
  const platformAdmin = context.isPlatformAdmin === true;
  const resolved = propertyId && platformAdmin && !coversProperty(scope, propertyId) ? permissionsFor(scope, null) : permissionsFor(scope, propertyId);
  return unionPermissions(resolved);
}

/** `requirePermissions` against the keys held in the property (403 PermissionDeniedError otherwise). */
export async function requireInProperty(context: UserContext, propertyId: string | null, required: PermissionKey[], deps: RbacDeps = defaultRbacDeps): Promise<void> {
  const permissions = await permissionsInProperty(context, propertyId, deps);
  requirePermissions({ ...context, permissions }, required);
}

/** ROLE_LEVEL_RANK the caller holds in the target scope (Infinity for platform admins). */
export async function callerRankFor(context: UserContext, propertyIds: readonly string[] | null, deps: RbacDeps = defaultRbacDeps): Promise<number> {
  if (context.isPlatformAdmin === true) return Number.POSITIVE_INFINITY;
  const scope = await scopeOfContext(context, deps);
  if (propertyIds === null) return maxRankOf(scope, null);
  if (propertyIds.length === 0) return maxRankOf(scope, null);
  return Math.min(...propertyIds.map((propertyId) => maxRankOf(scope, propertyId)));
}

// ---------------------------------------------------------------------------
// Rows → DTOs
// ---------------------------------------------------------------------------

type RoleRow = { id: string; organizationId: string; name: string; templateKey: string | null; level: RoleLevel | null; department: string | null; managed: boolean; templateVersion: number };
type AssignmentRow = {
  id: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  propertyId: string | null;
  propertyGroupId: string | null;
  legalEntityId: string | null;
  organizationId: string;
  validFrom: Date;
  validTo: Date | null;
  grantedByUserId: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  reason: string | null;
  createdAt: Date;
};

function toTemplateKey(value: string | null | undefined): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

function roleRank(role: Pick<RoleRow, "templateKey" | "level">): number {
  return rankOfAssignment({ templateKey: toTemplateKey(role.templateKey), level: role.level });
}

function levelOfRole(role: Pick<RoleRow, "templateKey" | "level">): RoleLevel | null {
  const template = toTemplateKey(role.templateKey);
  return template ? ROLE_TEMPLATE_LEVEL[template] : role.level;
}

function toAssignmentDto(row: AssignmentRow, role: Pick<RoleRow, "name" | "templateKey" | "level"> | undefined): UserRoleAssignmentDto {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    roleName: role?.name ?? "",
    templateKey: role ? toTemplateKey(role.templateKey) : null,
    level: role ? levelOfRole(role) : null,
    scopeType: row.scopeType,
    propertyId: row.propertyId,
    propertyGroupId: row.propertyGroupId,
    legalEntityId: row.legalEntityId,
    organizationId: row.organizationId,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    reason: row.reason,
    grantedByUserId: row.grantedByUserId
  };
}

function legacyToDto(row: { id: string; userId: string; propertyId: string; roleId: string }, role: Pick<RoleRow, "name" | "templateKey" | "level"> | undefined, organizationId: string): UserRoleAssignmentDto {
  return {
    id: `legacy:${row.id}`,
    userId: row.userId,
    roleId: row.roleId,
    roleName: role?.name ?? "",
    templateKey: role ? toTemplateKey(role.templateKey) : null,
    level: role ? levelOfRole(role) : null,
    scopeType: "property",
    propertyId: row.propertyId,
    propertyGroupId: null,
    legalEntityId: null,
    organizationId,
    validFrom: new Date(0).toISOString(),
    validTo: null,
    revokedAt: null,
    reason: null,
    grantedByUserId: null
  };
}

const ROLE_SELECT = { id: true, organizationId: true, name: true, templateKey: true, level: true, department: true, managed: true, templateVersion: true } as const;

async function rolesById(organizationId: string, roleIds: readonly string[], db: RbacScopeDb): Promise<Map<string, RoleRow>> {
  if (roleIds.length === 0) return new Map();
  const rows = await db.role.findMany({ where: { id: { in: [...new Set(roleIds)] }, organizationId }, select: ROLE_SELECT });
  return new Map(rows.map((row) => [row.id, row]));
}

async function permissionKeysOfRoles(roleIds: readonly string[], db: RbacScopeDb): Promise<Map<string, PermissionKey[]>> {
  const out = new Map<string, PermissionKey[]>();
  if (roleIds.length === 0) return out;
  const grants = await db.rolePermission.findMany({ where: { roleId: { in: [...new Set(roleIds)] } }, select: { roleId: true, permissionId: true } });
  const permissionIds = [...new Set(grants.map((grant) => grant.permissionId))];
  const permissions = permissionIds.length === 0 ? [] : await db.permission.findMany({ where: { id: { in: permissionIds } }, select: { id: true, key: true } });
  const keyById = new Map(permissions.map((row) => [row.id, row.key as PermissionKey]));
  for (const grant of grants) {
    const key = keyById.get(grant.permissionId);
    if (!key) continue;
    const list = out.get(grant.roleId) ?? [];
    list.push(key);
    out.set(grant.roleId, list);
  }
  for (const [roleId, keys] of out) out.set(roleId, [...new Set(keys)].sort());
  return out;
}

/** Properties an assignment row expands to (same rule as lib/rbac-scope.ts). */
type Expansion = { orgProperties: Array<{ id: string; legalEntityId: string | null }>; members: Array<{ propertyGroupId: string; propertyId: string }> };

async function loadExpansion(organizationId: string, db: RbacScopeDb): Promise<Expansion> {
  const orgProperties = await db.property.findMany({ where: { organizationId }, select: { id: true, legalEntityId: true }, orderBy: { createdAt: "asc" } });
  const groups = await db.propertyGroup.findMany({ where: { organizationId }, select: { id: true } });
  const members = groups.length === 0 ? [] : await db.propertyGroupMember.findMany({ where: { propertyGroupId: { in: groups.map((group) => group.id) } }, select: { propertyGroupId: true, propertyId: true } });
  return { orgProperties, members };
}

function expandRow(row: Pick<AssignmentRow, "scopeType" | "propertyId" | "propertyGroupId" | "legalEntityId">, expansion: Expansion): string[] {
  const orgIds = new Set(expansion.orgProperties.map((property) => property.id));
  switch (row.scopeType) {
    case "property":
      return row.propertyId ? [row.propertyId] : [];
    case "property_group":
      return expansion.members.filter((member) => member.propertyGroupId === row.propertyGroupId && orgIds.has(member.propertyId)).map((member) => member.propertyId);
    case "legal_entity":
      return expansion.orgProperties.filter((property) => property.legalEntityId === row.legalEntityId).map((property) => property.id);
    case "organization":
      return expansion.orgProperties.map((property) => property.id);
    default:
      return [];
  }
}

/** True when the caller's scope contains the whole target scope (platform admins always). */
function callerCovers(context: UserContext, callerScope: UserScope, target: { scopeType: ScopeType; propertyIds: string[] }): boolean {
  if (context.isPlatformAdmin === true) return true;
  if (target.scopeType === "legal_entity" || target.scopeType === "organization") return callerScope.orgScope;
  if (callerScope.orgScope) return true;
  if (target.propertyIds.length === 0) return false;
  return target.propertyIds.every((propertyId) => coversProperty(callerScope, propertyId));
}

// ---------------------------------------------------------------------------
// listAssignments
// ---------------------------------------------------------------------------

export async function listAssignments(
  input: { context: UserContext; userId?: string; propertyId?: string; scopeType?: ScopeType; includeRevoked?: boolean },
  deps: RbacDeps = defaultRbacDeps
): Promise<UserRoleAssignmentDto[]> {
  const { context } = input;
  requirePermissions(context, ["users.read"]);
  const organizationId = context.organizationId;
  const callerScope = await scopeOfContext(context, deps);
  const expansion = await loadExpansion(organizationId, deps.db);
  const now = deps.now();
  const rows = await deps.db.userRoleAssignment.findMany({
    where: {
      organizationId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.scopeType ? { scopeType: input.scopeType } : {}),
      ...(input.includeRevoked ? {} : { revokedAt: null, OR: [{ validTo: null }, { validTo: { gt: now } }] })
    },
    orderBy: { createdAt: "asc" }
  });
  const legacy =
    input.scopeType && input.scopeType !== "property"
      ? []
      : await deps.db.userPropertyRole.findMany({ where: { ...(input.userId ? { userId: input.userId } : {}), ...(input.propertyId ? { propertyId: input.propertyId } : {}) }, select: { id: true, userId: true, propertyId: true, roleId: true }, orderBy: { id: "asc" } });
  const roles = await rolesById(organizationId, [...rows.map((row) => row.roleId), ...legacy.map((row) => row.roleId)], deps.db);
  const within = (target: { scopeType: ScopeType; propertyIds: string[] }) => callerCovers(context, callerScope, target);
  const out: UserRoleAssignmentDto[] = [];
  for (const row of rows) {
    const propertyIds = expandRow(row, expansion);
    if (input.propertyId && !propertyIds.includes(input.propertyId)) continue;
    if (!within({ scopeType: row.scopeType, propertyIds })) continue;
    out.push(toAssignmentDto(row, roles.get(row.roleId)));
  }
  for (const row of legacy) {
    const role = roles.get(row.roleId);
    if (!role) continue; // role of another organisation: never listed
    if (!within({ scopeType: "property", propertyIds: [row.propertyId] })) continue;
    out.push(legacyToDto(row, role, organizationId));
  }
  return out;
}

// ---------------------------------------------------------------------------
// createAssignment
// ---------------------------------------------------------------------------

export type CreateAssignmentInput = {
  context: UserContext;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  propertyId?: string;
  propertyGroupId?: string;
  legalEntityId?: string;
  reason?: string;
  validTo?: string | Date;
};

/** SoD pairs violated by the union of the holders (each holder = one assignment / the new role) — `except` only shields a pair held INSIDE one excepted template. */
export function sodConflictsAmong(holders: ReadonlyArray<{ templateKey: RoleKey | null; permissions: readonly PermissionKey[] }>): SodStaticPair[] {
  const conflicts: SodStaticPair[] = [];
  for (const pair of SOD_STATIC_PAIRS) {
    const holdersA = holders.filter((holder) => holder.permissions.includes(pair.a));
    const holdersB = holders.filter((holder) => holder.permissions.includes(pair.b));
    if (holdersA.length === 0 || holdersB.length === 0) continue;
    const shielded = holdersA.every((a) => holdersB.every((b) => a === b && a.templateKey !== null && pair.except?.includes(a.templateKey) === true));
    if (!shielded) conflicts.push(pair);
  }
  return conflicts;
}

export async function createAssignment(input: CreateAssignmentInput, deps: RbacDeps = defaultRbacDeps): Promise<UserRoleAssignmentDto> {
  const { context } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["users.assign"]);
  if (input.userId === context.userId) {
    throw new RbacForbiddenError("Nadie puede concederse permisos a sí mismo.", "RBAC_SELF_ASSIGNMENT");
  }
  const organizationId = context.organizationId;
  const db = deps.db;

  // Role: same organisation, never a platform role, never the emergency template (opaque 404).
  const role = await db.role.findFirst({ where: { id: input.roleId, organizationId }, select: ROLE_SELECT });
  if (!role) throw new NotFoundError(ROLE_NOT_FOUND);
  if (role.templateKey === "break_glass") throw new NotFoundError(ROLE_NOT_FOUND);
  const keysByRole = await permissionKeysOfRoles([role.id], db);
  const roleKeys = keysByRole.get(role.id) ?? [];
  if (roleKeys.some((key) => isPlatformPermission(key))) throw new NotFoundError(ROLE_NOT_FOUND);

  // Target scope ⊆ caller scope (403 RBAC_SCOPE_EXCEEDED before any existence check: no oracle).
  const callerScope = await scopeOfContext(context, deps);
  const expansion = await loadExpansion(organizationId, db);
  let ref: string;
  let propertyIds: string[];
  const scopeExceeded = () => new RbacForbiddenError("No puedes asignar roles fuera de tu ámbito.", "RBAC_SCOPE_EXCEEDED");
  switch (input.scopeType) {
    case "property": {
      if (!input.propertyId) throw new BadRequestError("El ámbito property exige propertyId.");
      if (!callerCovers(context, callerScope, { scopeType: "property", propertyIds: [input.propertyId] })) throw scopeExceeded();
      const property = expansion.orgProperties.find((row) => row.id === input.propertyId);
      if (!property) throw new NotFoundError(PROPERTY_NOT_FOUND);
      ref = property.id;
      propertyIds = [property.id];
      break;
    }
    case "property_group": {
      if (!input.propertyGroupId) throw new BadRequestError("El ámbito property_group exige propertyGroupId.");
      const group = await db.propertyGroup.findFirst({ where: { id: input.propertyGroupId, organizationId }, select: { id: true } });
      const members = group ? expandRow({ scopeType: "property_group", propertyId: null, propertyGroupId: group.id, legalEntityId: null }, expansion) : [];
      if (!callerCovers(context, callerScope, { scopeType: "property_group", propertyIds: members })) throw scopeExceeded();
      if (!group) throw new NotFoundError(GROUP_NOT_FOUND);
      ref = group.id;
      propertyIds = members;
      break;
    }
    case "legal_entity": {
      if (!input.legalEntityId) throw new BadRequestError("El ámbito legal_entity exige legalEntityId.");
      if (!callerCovers(context, callerScope, { scopeType: "legal_entity", propertyIds: [] })) throw scopeExceeded();
      const entity = await db.legalEntity.findFirst({ where: { id: input.legalEntityId, organizationId }, select: { id: true } });
      if (!entity) throw new NotFoundError(LEGAL_ENTITY_NOT_FOUND);
      ref = entity.id;
      propertyIds = expandRow({ scopeType: "legal_entity", propertyId: null, propertyGroupId: null, legalEntityId: entity.id }, expansion);
      break;
    }
    case "organization": {
      if (!callerCovers(context, callerScope, { scopeType: "organization", propertyIds: [] })) throw scopeExceeded();
      ref = organizationId;
      propertyIds = expansion.orgProperties.map((row) => row.id);
      break;
    }
    default:
      throw new BadRequestError("Ámbito no válido.");
  }
  // Level ≤ own level in the target scope.
  const targetRank = roleRank(role);
  const callerRank = await callerRankFor(context, input.scopeType === "legal_entity" || input.scopeType === "organization" ? null : propertyIds, deps);
  if (targetRank > callerRank) {
    throw new RbacForbiddenError("No puedes asignar un rol de nivel superior al tuyo.", "RBAC_LEVEL_EXCEEDED", { targetLevel: levelOfRole(role), targetRank, callerRank: Number.isFinite(callerRank) ? callerRank : null });
  }
  // Target user: same organisation, never an emergency account (opaque 404).
  const user = await db.user.findFirst({ where: { id: input.userId, organizationId }, select: { id: true, status: true } });
  if (!user || user.status === "emergency") throw new NotFoundError(USER_NOT_FOUND);

  // Static SoD over the union of the target user's live assignments covering the same properties + the new role.
  const targetScope = await loadUserScope(user.id, organizationId, db);
  const overlapping = targetScope.assignments.filter((assignment) => propertyIds.length === 0 || assignment.propertyIds.some((propertyId) => propertyIds.includes(propertyId)));
  const newTemplate = toTemplateKey(role.templateKey);
  const conflicts = sodConflictsAmong([...overlapping.map((assignment) => ({ templateKey: assignment.templateKey, permissions: assignment.permissions })), { templateKey: newTemplate, permissions: roleKeys }]);
  if (conflicts.length > 0) {
    const pair = conflicts[0];
    const templates = [...new Set([...overlapping.map((assignment) => assignment.templateKey ?? assignment.roleName), newTemplate ?? role.name])];
    throw new ConflictError("La combinación de roles viola la separación de funciones.", { code: "RBAC_SOD_CONFLICT", pair: { a: pair.a, b: pair.b }, templates, conflicts: conflicts.map((conflict) => ({ a: conflict.a, b: conflict.b })) });
  }

  // Idempotent on the live tuple (the unique index treats NULLs as distinct, so the service enforces it).
  const validTo = input.validTo ? new Date(input.validTo) : null;
  if (validTo && Number.isNaN(validTo.getTime())) throw new BadRequestError("validTo no es una fecha válida.");
  const tuple = {
    userId: user.id,
    roleId: role.id,
    scopeType: input.scopeType,
    propertyId: input.scopeType === "property" ? ref : null,
    propertyGroupId: input.scopeType === "property_group" ? ref : null,
    legalEntityId: input.scopeType === "legal_entity" ? ref : null
  };
  const existing = await db.userRoleAssignment.findFirst({ where: { ...tuple, organizationId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  const now = deps.now();
  if (existing && (!existing.validTo || existing.validTo > now)) {
    return toAssignmentDto(existing, role);
  }
  const created = await db.userRoleAssignment.create({
    data: { ...tuple, organizationId, validFrom: now, validTo, grantedByUserId: context.userId, reason: input.reason ?? null }
  });
  deps.audit({
    organizationId,
    propertyId: input.scopeType === "property" ? ref : undefined,
    actorUserId: context.userId,
    actorType: "user",
    action: "ROLE_ASSIGNED",
    entityType: "user_role_assignment",
    entityId: created.id,
    afterJson: { userId: user.id, roleId: role.id, templateKey: newTemplate, scopeType: input.scopeType, ref, propertyIds, validTo: validTo?.toISOString() ?? null, reason: input.reason ?? null },
    deviceId: context.deviceId
  });
  await bumpRbacVersion(organizationId, db);
  return toAssignmentDto(created, role);
}

// ---------------------------------------------------------------------------
// revokeAssignment
// ---------------------------------------------------------------------------

export async function revokeAssignment(input: { context: UserContext; id: string; reason?: string }, deps: RbacDeps = defaultRbacDeps): Promise<UserRoleAssignmentDto> {
  const { context } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["users.assign"]);
  const organizationId = context.organizationId;
  const db = deps.db;
  const callerScope = await scopeOfContext(context, deps);
  const expansion = await loadExpansion(organizationId, db);

  if (input.id.startsWith("legacy:")) {
    const legacyId = input.id.slice("legacy:".length);
    const row = await db.userPropertyRole.findFirst({ where: { id: legacyId }, select: { id: true, userId: true, propertyId: true, roleId: true } });
    const role = row ? (await rolesById(organizationId, [row.roleId], db)).get(row.roleId) : undefined;
    if (!row || !role) throw new NotFoundError(ASSIGNMENT_NOT_FOUND);
    if (!callerCovers(context, callerScope, { scopeType: "property", propertyIds: [row.propertyId] })) throw new NotFoundError(ASSIGNMENT_NOT_FOUND);
    if (roleRank(role) > (await callerRankFor(context, [row.propertyId], deps))) {
      throw new RbacForbiddenError("No puedes retirar un rol de nivel superior al tuyo.", "RBAC_LEVEL_EXCEEDED");
    }
    await db.userPropertyRole.deleteMany({ where: { id: row.id } });
    const dto = { ...legacyToDto(row, role, organizationId), revokedAt: deps.now().toISOString(), reason: input.reason ?? null };
    deps.audit({
      organizationId,
      propertyId: row.propertyId,
      actorUserId: context.userId,
      actorType: "user",
      action: "ROLE_REVOKED",
      entityType: "user_property_role",
      entityId: row.id,
      beforeJson: { userId: row.userId, roleId: row.roleId, propertyId: row.propertyId, legacy: true },
      afterJson: { reason: input.reason ?? null },
      deviceId: context.deviceId
    });
    await bumpRbacVersion(organizationId, db);
    return dto;
  }

  const row = await db.userRoleAssignment.findFirst({ where: { id: input.id, organizationId } });
  if (!row) throw new NotFoundError(ASSIGNMENT_NOT_FOUND);
  const role = (await rolesById(organizationId, [row.roleId], db)).get(row.roleId);
  const propertyIds = expandRow(row, expansion);
  if (!callerCovers(context, callerScope, { scopeType: row.scopeType, propertyIds })) throw new NotFoundError(ASSIGNMENT_NOT_FOUND);
  if (role && roleRank(role) > (await callerRankFor(context, row.scopeType === "legal_entity" || row.scopeType === "organization" ? null : propertyIds, deps))) {
    throw new RbacForbiddenError("No puedes retirar un rol de nivel superior al tuyo.", "RBAC_LEVEL_EXCEEDED");
  }
  if (row.revokedAt) return toAssignmentDto(row, role);
  const updated = await db.userRoleAssignment.update({ where: { id: row.id }, data: { revokedAt: deps.now(), revokedByUserId: context.userId, reason: input.reason ?? row.reason ?? null } });
  deps.audit({
    organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: context.userId,
    actorType: "user",
    action: "ROLE_REVOKED",
    entityType: "user_role_assignment",
    entityId: row.id,
    beforeJson: { userId: row.userId, roleId: row.roleId, scopeType: row.scopeType, propertyIds },
    afterJson: { reason: input.reason ?? null, revokedAt: updated.revokedAt?.toISOString() ?? null },
    deviceId: context.deviceId
  });
  await bumpRbacVersion(organizationId, db);
  return toAssignmentDto(updated, role);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type RbacRoleSummary = {
  id: string;
  name: string;
  templateKey: RoleKey | null;
  level: RoleLevel | null;
  department: string | null;
  managed: boolean;
  templateVersion: number;
  permissionCount: number;
  permissions: PermissionKey[];
};

/** Roles of the organisation the caller may assign: never the emergency role nor a platform role. */
export async function listRoles(input: { context: UserContext }, deps: RbacDeps = defaultRbacDeps): Promise<RbacRoleSummary[]> {
  requirePermissions(input.context, ["roles.manage"]);
  const rows = await deps.db.role.findMany({ where: { organizationId: input.context.organizationId }, select: ROLE_SELECT, orderBy: { name: "asc" } });
  const keys = await permissionKeysOfRoles(rows.map((row) => row.id), deps.db);
  return rows
    .filter((row) => row.templateKey !== "break_glass")
    .filter((row) => !(keys.get(row.id) ?? []).some((key) => isPlatformPermission(key)))
    .map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: toTemplateKey(row.templateKey),
      level: levelOfRole(row),
      department: row.department,
      managed: row.managed,
      templateVersion: row.templateVersion,
      permissionCount: (keys.get(row.id) ?? []).length,
      permissions: keys.get(row.id) ?? []
    }));
}

export async function createRoleFromTemplate(input: { context: UserContext; name: string; templateKey: string }, deps: RbacDeps = defaultRbacDeps): Promise<RbacRoleSummary> {
  const { context } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["roles.manage"]);
  if (input.templateKey === "break_glass" || !(ROLE_TEMPLATE_KEYS as readonly string[]).includes(input.templateKey)) {
    throw new NotFoundError("Plantilla de rol no disponible.");
  }
  const created = await catalogCreateRoleFromTemplate(
    { organizationId: context.organizationId, name: input.name, templateKey: input.templateKey, actorUserId: context.userId },
    { db: deps.db, audit: deps.audit === recordAuditEvent }
  );
  await bumpRbacVersion(context.organizationId, deps.db);
  const row = await deps.db.role.findFirst({ where: { id: created.id }, select: ROLE_SELECT });
  const keys = await permissionKeysOfRoles([created.id], deps.db);
  return {
    id: created.id,
    name: created.name,
    templateKey: toTemplateKey(created.templateKey),
    level: row ? levelOfRole(row) : null,
    department: row?.department ?? null,
    managed: row?.managed ?? true,
    templateVersion: row?.templateVersion ?? 0,
    permissionCount: created.permissionsCount,
    permissions: keys.get(created.id) ?? []
  };
}

/** Only REMOVES keys (OPERA template pattern: never add outside the template); the role becomes custom (managed = false). */
export async function editRolePermissions(input: { context: UserContext; roleId: string; remove: string[] }, deps: RbacDeps = defaultRbacDeps): Promise<RbacRoleSummary> {
  const { context } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["permissions.manage"]);
  const db = deps.db;
  const role = await db.role.findFirst({ where: { id: input.roleId, organizationId: context.organizationId }, select: ROLE_SELECT });
  if (!role || role.templateKey === "break_glass") throw new NotFoundError(ROLE_NOT_FOUND);
  const keys = (await permissionKeysOfRoles([role.id], db)).get(role.id) ?? [];
  if (keys.some((key) => isPlatformPermission(key))) throw new NotFoundError(ROLE_NOT_FOUND);
  const unknown = input.remove.filter((key) => !(key in PERMISSIONS));
  if (unknown.length > 0) throw new BadRequestError(`Claves desconocidas: ${unknown.join(", ")}.`);
  const removable = [...new Set(input.remove)].filter((key) => keys.includes(key as PermissionKey));
  if (removable.length > 0) {
    const permissionRows = await db.permission.findMany({ where: { key: { in: removable } }, select: { id: true, key: true } });
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { in: permissionRows.map((row) => row.id) } } });
  }
  await db.role.update({ where: { id: role.id }, data: { managed: false } });
  deps.audit({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    actorType: "user",
    action: "ROLE_PERMISSIONS_EDITED",
    entityType: "role",
    entityId: role.id,
    beforeJson: { permissionCount: keys.length, managed: role.managed },
    afterJson: { removed: removable, permissionCount: keys.length - removable.length, managed: false },
    deviceId: context.deviceId
  });
  await bumpRbacVersion(context.organizationId, db);
  const remaining = keys.filter((key) => !removable.includes(key));
  return { id: role.id, name: role.name, templateKey: toTemplateKey(role.templateKey), level: levelOfRole(role), department: role.department, managed: false, templateVersion: role.templateVersion, permissionCount: remaining.length, permissions: remaining };
}

// ---------------------------------------------------------------------------
// Property groups
// ---------------------------------------------------------------------------

async function groupDtos(organizationId: string, ids: readonly string[] | null, db: RbacScopeDb): Promise<PropertyGroupDto[]> {
  const groups = await db.propertyGroup.findMany({ where: { organizationId, ...(ids ? { id: { in: [...ids] } } : {}) }, select: { id: true, organizationId: true, code: true, name: true }, orderBy: { code: "asc" } });
  const members = groups.length === 0 ? [] : await db.propertyGroupMember.findMany({ where: { propertyGroupId: { in: groups.map((group) => group.id) } }, select: { propertyGroupId: true, propertyId: true } });
  return groups.map((group) => ({ id: group.id, organizationId: group.organizationId, code: group.code, name: group.name, propertyIds: members.filter((member) => member.propertyGroupId === group.id).map((member) => member.propertyId).sort() }));
}

export async function listPropertyGroups(input: { context: UserContext }, deps: RbacDeps = defaultRbacDeps): Promise<PropertyGroupDto[]> {
  requirePermissions(input.context, ["organization.structure.manage"]);
  return groupDtos(input.context.organizationId, null, deps.db);
}

async function assertMembersOfOrganization(organizationId: string, propertyIds: readonly string[], db: RbacScopeDb): Promise<string[]> {
  const unique = [...new Set(propertyIds)];
  if (unique.length === 0) return [];
  const rows = await db.property.findMany({ where: { id: { in: unique }, organizationId }, select: { id: true } });
  if (rows.length !== unique.length) throw new BadRequestError("Todas las propiedades del grupo deben pertenecer a la organización.");
  return unique;
}

export async function createPropertyGroup(input: { context: UserContext; code: string; name: string; propertyIds: string[] }, deps: RbacDeps = defaultRbacDeps): Promise<PropertyGroupDto> {
  const { context } = input;
  // Recomposing a group widens every property_group assignment for good: a permanent grant (§10.2, FSOD-08).
  assertNotBreakGlass(context);
  requirePermissions(context, ["organization.structure.manage"]);
  const organizationId = context.organizationId;
  const members = await assertMembersOfOrganization(organizationId, input.propertyIds, deps.db);
  const duplicate = await deps.db.propertyGroup.findFirst({ where: { organizationId, code: input.code }, select: { id: true } });
  if (duplicate) throw new ConflictError("Ya existe un grupo con ese código en la organización.", { code: "PROPERTY_GROUP_CODE_CONFLICT" });
  const created = await deps.db.propertyGroup.create({ data: { organizationId, code: input.code, name: input.name }, select: { id: true } });
  if (members.length > 0) await deps.db.propertyGroupMember.createMany({ data: members.map((propertyId) => ({ propertyGroupId: created.id, propertyId })), skipDuplicates: true });
  deps.audit({ organizationId, actorUserId: context.userId, actorType: "user", action: "PROPERTY_GROUP_CREATED", entityType: "property_group", entityId: created.id, afterJson: { code: input.code, name: input.name, propertyIds: members }, deviceId: context.deviceId });
  await bumpRbacVersion(organizationId, deps.db);
  return (await groupDtos(organizationId, [created.id], deps.db))[0];
}

export async function updatePropertyGroup(input: { context: UserContext; id: string; code?: string; name?: string; propertyIds?: string[] }, deps: RbacDeps = defaultRbacDeps): Promise<PropertyGroupDto> {
  const { context } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["organization.structure.manage"]);
  const organizationId = context.organizationId;
  const group = await deps.db.propertyGroup.findFirst({ where: { id: input.id, organizationId }, select: { id: true, code: true, name: true } });
  if (!group) throw new NotFoundError(GROUP_NOT_FOUND);
  const before = (await groupDtos(organizationId, [group.id], deps.db))[0];
  if (input.code && input.code !== group.code) {
    const duplicate = await deps.db.propertyGroup.findFirst({ where: { organizationId, code: input.code, id: { not: group.id } }, select: { id: true } });
    if (duplicate) throw new ConflictError("Ya existe un grupo con ese código en la organización.", { code: "PROPERTY_GROUP_CODE_CONFLICT" });
  }
  if (input.code !== undefined || input.name !== undefined) {
    await deps.db.propertyGroup.update({ where: { id: group.id }, data: { ...(input.code !== undefined ? { code: input.code } : {}), ...(input.name !== undefined ? { name: input.name } : {}) } });
  }
  if (input.propertyIds !== undefined) {
    const members = await assertMembersOfOrganization(organizationId, input.propertyIds, deps.db);
    await deps.db.propertyGroupMember.deleteMany({ where: { propertyGroupId: group.id } });
    if (members.length > 0) await deps.db.propertyGroupMember.createMany({ data: members.map((propertyId) => ({ propertyGroupId: group.id, propertyId })), skipDuplicates: true });
  }
  const after = (await groupDtos(organizationId, [group.id], deps.db))[0];
  deps.audit({ organizationId, actorUserId: context.userId, actorType: "user", action: "PROPERTY_GROUP_UPDATED", entityType: "property_group", entityId: group.id, beforeJson: before, afterJson: after, deviceId: context.deviceId });
  await bumpRbacVersion(organizationId, deps.db);
  return after;
}

// ---------------------------------------------------------------------------
// Users in scope
// ---------------------------------------------------------------------------

/**
 * Users of the organisation whose live assignments touch the scope (and the
 * caller's own scope): one row per user with its assignments. Emergency
 * accounts only for holders of audit.read.
 */
export async function listUsersInScope(input: { context: UserContext; scopeType?: ScopeType; ref?: string }, deps: RbacDeps = defaultRbacDeps): Promise<RbacUserRowDto[]> {
  const { context } = input;
  requirePermissions(context, ["users.read"]);
  const organizationId = context.organizationId;
  const db = deps.db;
  const callerScope = await scopeOfContext(context, deps);
  const expansion = await loadExpansion(organizationId, db);
  const seesEmergency = context.permissions.includes("audit.read");
  const users = await db.user.findMany({
    where: { organizationId, ...(seesEmergency ? {} : { status: { not: "emergency" } }) },
    select: { id: true, email: true, fullName: true, status: true, mfaEnabled: true, lastLoginAt: true },
    orderBy: { email: "asc" }
  });
  const now = deps.now();
  const rows = await db.userRoleAssignment.findMany({ where: { organizationId, revokedAt: null, OR: [{ validTo: null }, { validTo: { gt: now } }] }, orderBy: { createdAt: "asc" } });
  const legacy = await db.userPropertyRole.findMany({ where: { userId: { in: users.map((user) => user.id) } }, select: { id: true, userId: true, propertyId: true, roleId: true }, orderBy: { id: "asc" } });
  const roles = await rolesById(organizationId, [...rows.map((row) => row.roleId), ...legacy.map((row) => row.roleId)], db);

  let targetProperties: string[] | null = null;
  let targetWideRef: { scopeType: "legal_entity" | "organization"; ref: string } | null = null;
  if (input.scopeType) {
    switch (input.scopeType) {
      case "property":
        if (!input.ref) throw new BadRequestError("El ámbito property exige ref.");
        targetProperties = [input.ref];
        break;
      case "property_group":
        if (!input.ref) throw new BadRequestError("El ámbito property_group exige ref.");
        targetProperties = expandRow({ scopeType: "property_group", propertyId: null, propertyGroupId: input.ref, legalEntityId: null }, expansion);
        break;
      case "legal_entity":
        if (!input.ref) throw new BadRequestError("El ámbito legal_entity exige ref.");
        targetProperties = expandRow({ scopeType: "legal_entity", propertyId: null, propertyGroupId: null, legalEntityId: input.ref }, expansion);
        targetWideRef = { scopeType: "legal_entity", ref: input.ref };
        break;
      case "organization":
        // «Sociedad» tab (design C11): the organisation lists EVERY user with a
        // live assignment in it, whatever its scope (property, group, sociedad
        // or organisation) — not only the organisation-scoped ones (FSOD-02).
        targetWideRef = { scopeType: "organization", ref: organizationId };
        targetProperties = expansion.orgProperties.map((property) => property.id);
        break;
      default:
        break;
    }
  }
  const wholeOrganization = input.scopeType === "organization";

  const out: RbacUserRowDto[] = [];
  for (const user of users) {
    const dtos: UserRoleAssignmentDto[] = [];
    const touched: string[][] = [];
    let touchesTarget = input.scopeType === undefined;
    for (const row of rows.filter((candidate) => candidate.userId === user.id)) {
      const propertyIds = expandRow(row, expansion);
      if (!callerCovers(context, callerScope, { scopeType: row.scopeType, propertyIds })) continue;
      dtos.push(toAssignmentDto(row, roles.get(row.roleId)));
      touched.push(propertyIds);
      if (wholeOrganization) touchesTarget = true;
      if (targetWideRef && row.scopeType === targetWideRef.scopeType && (row.scopeType === "organization" || row.legalEntityId === targetWideRef.ref)) touchesTarget = true;
      if (targetProperties && propertyIds.some((propertyId) => targetProperties!.includes(propertyId))) touchesTarget = true;
    }
    for (const row of legacy.filter((candidate) => candidate.userId === user.id)) {
      const role = roles.get(row.roleId);
      if (!role) continue;
      if (!callerCovers(context, callerScope, { scopeType: "property", propertyIds: [row.propertyId] })) continue;
      dtos.push(legacyToDto(row, role, organizationId));
      touched.push([row.propertyId]);
      if (wholeOrganization) touchesTarget = true;
      if (targetProperties && targetProperties.includes(row.propertyId)) touchesTarget = true;
    }
    if (dtos.length === 0 && !(context.isPlatformAdmin === true || callerScope.orgScope)) continue;
    if (!touchesTarget) continue;
    out.push({ userId: user.id, email: user.email, fullName: user.fullName, status: user.status, mfaEnabled: user.mfaEnabled, lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null, assignments: dtos });
  }
  return out;
}

/** Highest level (rank) a role carries — exported for the thresholds / approvals services. */
export function rankOfRole(role: Pick<RoleRow, "templateKey" | "level">): number {
  return roleRank(role);
}

export { ROLE_LEVEL_RANK };
