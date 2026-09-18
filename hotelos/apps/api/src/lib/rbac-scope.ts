// RBAC · ámbito de un usuario (Tanda 8a · L1, 2026-09-18).
//
// LECTOR ÚNICO de las asignaciones de un usuario durante la lectura dual
// (docs/design/RBAC-DEPARTAMENTOS.md §6.2, §6.5, §9): une la tabla legacy
// `user_property_roles` (ámbito property, un centro por fila) con la tabla
// nueva `user_role_assignments` (plantilla × ámbito: property, property_group,
// legal_entity, organization; con vigencia y revocación) y expande cada
// asignación a la lista de propiedades que cubre. Nada más en la API lee esas
// tablas para decidir permisos: auth.service (contexto de sesión), el hook de
// ámbito de server.ts, lib/tenancy.ts (entidad → propiedad) y los servicios de
// modules/rbac calculan TODO a partir del `UserScope` que devuelve este módulo.
//
// Semántica (fail-secure):
//   · `permissionsFor(scope, propertyId)` = unión de las claves de las
//     asignaciones que cubren ESA propiedad; una propiedad que ninguna cubre →
//     [] (403 en el gate, 404 opaco en la tenencia).
//   · `permissionsFor(scope, null)` (rutas de organización) = unión de las
//     asignaciones de ámbito legal_entity / organization; si el usuario no tiene
//     ninguna de esas pero sí asignaciones de propiedad (o de grupo) →
//     INTERSECCIÓN de sus conjuntos de claves: lo que puede hacer en TODAS sus
//     propiedades. Regla transitoria y documentada (docs/api-contracts.md): Carmen
//     (Owner ×8 en user_property_roles) conserva sus 222 claves en las rutas de
//     organización hasta que el integrador ejecute rbac:migrate-assignments;
//     «Recepción en A + Contabilidad en B» queda al mínimo común. Sin
//     asignaciones → [].
//   · `orgScope` = true solo con una asignación viva de ámbito organization o
//     legal_entity (nunca por «no tener asignaciones», que era el hueco H1/H2).
//   · Un rol de otra organización referenciado por una fila legacy se ignora.
//
// Memo: (userId, organizationId) durante ≤ 30 s, validado en cada lectura
// contra `organizations.rbac_version` y el recuento de filas de las dos tablas
// de asignación del usuario (tres consultas indexadas): cualquier escritura de
// roles o asignaciones llama a `bumpRbacVersion`, y los escritores legacy de
// user_property_roles (hasta L3) cambian el recuento, así que la siguiente
// petición vuelve a leer. Solo se memoriza con el cliente Prisma global (los
// tests con BD falsa leen siempre).

import {
  ROLE_LEVEL_RANK,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LEVEL,
  type PermissionKey,
  type RoleKey,
  type RoleLevel,
  type ScopeType,
  type UserScopeDto
} from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";

/** Either the global client or a transaction client. */
export type RbacScopeDb = Prisma.TransactionClient | typeof prisma;

export type ScopeAssignment = {
  /** `user_role_assignments.id`, or `legacy:<user_property_roles.id>` for the dual-read rows. */
  id: string;
  source: "assignment" | "legacy";
  roleId: string;
  roleName: string;
  /** Known template key of the role, or null (custom role / unknown key). */
  templateKey: RoleKey | null;
  level: RoleLevel | null;
  scopeType: ScopeType;
  /** Id of the property / group / legal entity / organisation the assignment points at. */
  ref: string;
  /** Properties the assignment expands to (deduplicated, stable order). */
  propertyIds: string[];
  /** Keys granted by the role (role_permissions), sorted. */
  permissions: PermissionKey[];
  validTo: Date | null;
};

export type UserScope = {
  userId: string;
  organizationId: string;
  rbacVersion: number;
  assignments: ScopeAssignment[];
  /** Properties covered by at least one live assignment (expansion included), stable order. */
  assignedPropertyIds: string[];
  /** True with a live organization / legal_entity assignment. */
  orgScope: boolean;
  scopes: UserScopeDto[];
  /** Union of every assignment (platform-admin detection, approval inbox filters). Never the demo union. */
  allPermissions: PermissionKey[];
};

/** Where the property of the request came from (server.ts scope hook / lib/tenancy.ts). */
export type RbacRequestScope = {
  propertyId: string | null;
  resolvedFrom: "param" | "header" | "entity" | "none";
};

const WIDE_SCOPES: readonly ScopeType[] = ["legal_entity", "organization"];

function isWide(scopeType: ScopeType): boolean {
  return WIDE_SCOPES.includes(scopeType);
}

function toTemplateKey(value: string | null | undefined): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

function unique(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function unionOf(sets: ReadonlyArray<readonly PermissionKey[]>): PermissionKey[] {
  const out = new Set<PermissionKey>();
  for (const set of sets) for (const key of set) out.add(key);
  return Array.from(out).sort();
}

function intersectionOf(sets: ReadonlyArray<readonly PermissionKey[]>): PermissionKey[] {
  if (sets.length === 0) return [];
  let current = new Set<PermissionKey>(sets[0]);
  for (const set of sets.slice(1)) {
    const next = new Set<PermissionKey>();
    for (const key of set) if (current.has(key)) next.add(key);
    current = next;
    if (current.size === 0) break;
  }
  return Array.from(current).sort();
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

const SCOPE_MEMO_TTL_MS = 30_000;
type MemoEntry = { scope: UserScope; expiresAt: number; signature: string };
const scopeMemo = new Map<string, MemoEntry>();

function memoKey(userId: string, organizationId: string): string {
  return `${organizationId}|${userId}`;
}

/** Forget every memoised scope (of one organisation, or all). Called by bumpRbacVersion; exported for tests. */
export function invalidateRbacScopeCache(organizationId?: string): void {
  if (!organizationId) {
    scopeMemo.clear();
    return;
  }
  for (const key of Array.from(scopeMemo.keys())) {
    if (key.startsWith(`${organizationId}|`)) scopeMemo.delete(key);
  }
}

export function resetRbacScopeCacheForTests(): void {
  scopeMemo.clear();
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

type RoleRow = { id: string; organizationId: string; name: string; templateKey: string | null; level: RoleLevel | null };

/**
 * Live assignments of a user in an organisation, expanded to properties, with
 * the keys of every role. See the module comment for the semantics.
 */
export async function loadUserScope(userId: string, organizationId: string, db: RbacScopeDb = prisma): Promise<UserScope> {
  const cacheable = db === prisma;
  const now = new Date();
  const organization = await db.organization.findUnique({ where: { id: organizationId }, select: { rbacVersion: true } });
  const rbacVersion = organization?.rbacVersion ?? 0;
  // Memo signature: the organisation version PLUS the row counts of the user's
  // two assignment tables. Every write of the rbac module bumps the version;
  // the six legacy writers of user_property_roles (invitations, backoffice
  // invite, tenant-admin, provisioning, bootstrap — redirected in L3) and any
  // direct revocation change a count, so a hit never serves a stale scope.
  // Two indexed counts instead of the ~7 queries of a full reload.
  const [legacyCount, liveCount] = await Promise.all([
    db.userPropertyRole.count({ where: { userId } }),
    db.userRoleAssignment.count({ where: { userId, organizationId, revokedAt: null } })
  ]);
  const signature = `${rbacVersion}|${legacyCount}|${liveCount}`;
  if (cacheable) {
    const hit = scopeMemo.get(memoKey(userId, organizationId));
    if (hit && hit.expiresAt > now.getTime() && hit.signature === signature) return hit.scope;
  }

  const [legacyRows, assignmentRows] = await Promise.all([
    db.userPropertyRole.findMany({ where: { userId }, select: { id: true, propertyId: true, roleId: true }, orderBy: { id: "asc" } }),
    db.userRoleAssignment.findMany({
      where: {
        userId,
        organizationId,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }]
      },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const roleIds = unique([...legacyRows.map((row) => row.roleId), ...assignmentRows.map((row) => row.roleId)]);
  const roles: RoleRow[] =
    roleIds.length === 0
      ? []
      : await db.role.findMany({
          where: { id: { in: roleIds }, organizationId },
          select: { id: true, organizationId: true, name: true, templateKey: true, level: true }
        });
  const roleById = new Map(roles.map((role) => [role.id, role]));

  const grants = roleIds.length === 0 ? [] : await db.rolePermission.findMany({ where: { roleId: { in: roleIds } }, select: { roleId: true, permissionId: true } });
  const permissionIds = unique(grants.map((grant) => grant.permissionId));
  const permissionRows = permissionIds.length === 0 ? [] : await db.permission.findMany({ where: { id: { in: permissionIds } }, select: { id: true, key: true } });
  const keyById = new Map(permissionRows.map((row) => [row.id, row.key as PermissionKey]));
  const keysByRole = new Map<string, PermissionKey[]>();
  for (const grant of grants) {
    const key = keyById.get(grant.permissionId);
    if (!key) continue;
    const list = keysByRole.get(grant.roleId) ?? [];
    list.push(key);
    keysByRole.set(grant.roleId, list);
  }
  const permissionsOfRole = (roleId: string): PermissionKey[] => unionOf([keysByRole.get(roleId) ?? []]);

  // Expansion sources, loaded only when an assignment needs them.
  const needsOrgProperties = assignmentRows.some((row) => row.scopeType === "organization" || row.scopeType === "legal_entity" || row.scopeType === "property_group");
  const orgProperties = needsOrgProperties
    ? await db.property.findMany({ where: { organizationId }, select: { id: true, legalEntityId: true }, orderBy: { createdAt: "asc" } })
    : [];
  const orgPropertyIds = new Set(orgProperties.map((row) => row.id));
  const groupIds = unique(assignmentRows.filter((row) => row.scopeType === "property_group" && row.propertyGroupId).map((row) => row.propertyGroupId as string));
  const groupMembers = groupIds.length === 0 ? [] : await db.propertyGroupMember.findMany({ where: { propertyGroupId: { in: groupIds } }, select: { propertyGroupId: true, propertyId: true } });

  const assignments: ScopeAssignment[] = [];
  for (const row of legacyRows) {
    const role = roleById.get(row.roleId);
    if (!role) continue; // role of another organisation (or deleted): ignored, fail-secure
    assignments.push({
      id: `legacy:${row.id}`,
      source: "legacy",
      roleId: role.id,
      roleName: role.name,
      templateKey: toTemplateKey(role.templateKey),
      level: role.level,
      scopeType: "property",
      ref: row.propertyId,
      propertyIds: [row.propertyId],
      permissions: permissionsOfRole(role.id),
      validTo: null
    });
  }
  for (const row of assignmentRows) {
    const role = roleById.get(row.roleId);
    if (!role) continue;
    let ref: string;
    let propertyIds: string[];
    switch (row.scopeType) {
      case "property":
        if (!row.propertyId) continue;
        ref = row.propertyId;
        propertyIds = [row.propertyId];
        break;
      case "property_group":
        if (!row.propertyGroupId) continue;
        ref = row.propertyGroupId;
        propertyIds = groupMembers.filter((member) => member.propertyGroupId === row.propertyGroupId && orgPropertyIds.has(member.propertyId)).map((member) => member.propertyId);
        break;
      case "legal_entity":
        if (!row.legalEntityId) continue;
        ref = row.legalEntityId;
        propertyIds = orgProperties.filter((property) => property.legalEntityId === row.legalEntityId).map((property) => property.id);
        break;
      case "organization":
        ref = organizationId;
        propertyIds = orgProperties.map((property) => property.id);
        break;
      default:
        continue;
    }
    assignments.push({
      id: row.id,
      source: "assignment",
      roleId: role.id,
      roleName: role.name,
      templateKey: toTemplateKey(role.templateKey),
      level: role.level,
      scopeType: row.scopeType,
      ref,
      propertyIds: unique(propertyIds),
      permissions: permissionsOfRole(role.id),
      validTo: row.validTo
    });
  }

  const scope: UserScope = {
    userId,
    organizationId,
    rbacVersion,
    assignments,
    assignedPropertyIds: unique(assignments.flatMap((assignment) => assignment.propertyIds)),
    orgScope: assignments.some((assignment) => isWide(assignment.scopeType)),
    scopes: dedupeScopes(assignments.map((assignment) => ({ scopeType: assignment.scopeType, ref: assignment.ref, propertyIds: assignment.propertyIds }))),
    allPermissions: unionOf(assignments.map((assignment) => assignment.permissions))
  };
  if (cacheable) scopeMemo.set(memoKey(userId, organizationId), { scope, expiresAt: now.getTime() + SCOPE_MEMO_TTL_MS, signature });
  return scope;
}

function dedupeScopes(scopes: UserScopeDto[]): UserScopeDto[] {
  const seen = new Set<string>();
  const out: UserScopeDto[] = [];
  for (const scope of scopes) {
    const key = `${scope.scopeType}|${scope.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scopeType: scope.scopeType, ref: scope.ref, propertyIds: scope.propertyIds.slice() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure helpers over a loaded scope
// ---------------------------------------------------------------------------

/**
 * Assignments that decide a request: with a property, the ones covering it;
 * without one, the wide (legal_entity / organization) ones, or — transitional,
 * see the module comment — EVERY narrow assignment with `mode: "intersection"`.
 */
export function assignmentsFor(
  scope: Pick<UserScope, "assignments">,
  propertyId: string | null
): { mode: "union" | "intersection"; assignments: ScopeAssignment[] } {
  if (propertyId) {
    return { mode: "union", assignments: scope.assignments.filter((assignment) => assignment.propertyIds.includes(propertyId)) };
  }
  const wide = scope.assignments.filter((assignment) => isWide(assignment.scopeType));
  if (wide.length > 0) return { mode: "union", assignments: wide };
  return { mode: "intersection", assignments: scope.assignments.slice() };
}

/** Keys the user holds for the property (union) or for the organisation routes (wide union / narrow intersection). Sorted; [] without assignments. */
export function permissionsFor(scope: Pick<UserScope, "assignments">, propertyId: string | null): PermissionKey[] {
  const selected = assignmentsFor(scope, propertyId);
  if (selected.assignments.length === 0) return [];
  const sets = selected.assignments.map((assignment) => assignment.permissions);
  return selected.mode === "union" ? unionOf(sets) : intersectionOf(sets);
}

/** True when at least one live assignment covers the property. */
export function coversProperty(scope: Pick<UserScope, "assignedPropertyIds">, propertyId: string): boolean {
  return scope.assignedPropertyIds.includes(propertyId);
}

/** ROLE_LEVEL_RANK of one assignment: template level, else the custom role's level, else 1 (operative). */
export function rankOfAssignment(assignment: Pick<ScopeAssignment, "templateKey" | "level">): number {
  if (assignment.templateKey) return ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[assignment.templateKey]];
  if (assignment.level) return ROLE_LEVEL_RANK[assignment.level];
  return 1;
}

/**
 * Highest level the user holds in the scope (max rank of the assignments that
 * cover the property; wide assignments for null). Without wide assignments the
 * organisation value is the MINIMUM over the narrow ones (same conservative
 * rule as the permission intersection). 0 = no assignment at all.
 */
export function maxRankOf(scope: Pick<UserScope, "assignments">, propertyId: string | null): number {
  const selected = assignmentsFor(scope, propertyId);
  if (selected.assignments.length === 0) return 0;
  const ranks = selected.assignments.map(rankOfAssignment);
  return selected.mode === "union" ? Math.max(...ranks) : Math.min(...ranks);
}

/** Compact view of the assignments for UserContext.assignments (no permissions: the context carries the resolved ones). */
export function toContextAssignments(scope: Pick<UserScope, "assignments">): Array<{
  roleId: string;
  templateKey: RoleKey | null;
  level: RoleLevel | null;
  scopeType: ScopeType;
  propertyIds: string[];
}> {
  return scope.assignments.map((assignment) => ({
    roleId: assignment.roleId,
    templateKey: assignment.templateKey,
    level: assignment.level,
    scopeType: assignment.scopeType,
    propertyIds: assignment.propertyIds.slice()
  }));
}

/**
 * Increment `organizations.rbac_version` (every write of roles / assignments /
 * thresholds) so live sessions re-read their scope on the next request, and
 * drop the in-process memo of that organisation.
 */
export async function bumpRbacVersion(organizationId: string, db: RbacScopeDb = prisma): Promise<number> {
  const updated = await db.organization.update({ where: { id: organizationId }, data: { rbacVersion: { increment: 1 } }, select: { rbacVersion: true } });
  invalidateRbacScopeCache(organizationId);
  return updated.rbacVersion;
}
