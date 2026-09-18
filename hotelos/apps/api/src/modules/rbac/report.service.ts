// RBAC por departamento (Tanda 8a · L1) · informe «roles y claves configurados»
// (patrón OPERA «Configured Roles and Tasks», design §6.3 / §6.6) y registro de
// accesos para la revisión trimestral (PCI DSS req. 7).
//
// `rbacReport`: roles de la organización con sus claves agrupadas por módulo
// (prefijo de la clave, §4.3), diferencia con su plantilla (extraKeys /
// missingKeys), asignaciones vivas por ámbito, conflictos SoD estáticos y roles
// con permisos idénticos; umbrales vigentes. `accessLog`: audit_events de la
// organización con action ∈ RBAC_AUDIT_ACTIONS (paginado); cada denegación
// lleva las claves que la ruta exige, recalculadas con la decisión pura
// (security/access-decision.ts). Solo lectura, audit.read, y SIEMPRE dentro
// del ámbito del llamante (corrector 8a · SEC-8A-03): el informe de roles es
// de organización (solo un titular de audit.read con asignación viva de
// sociedad / organización, o plataforma: 403 RBAC_SCOPE_EXCEEDED para una
// jefatura de hotel), y el registro de accesos se filtra por las propiedades
// cubiertas — un supervisor de un hotel nunca lee los eventos de otro ni los
// de organización (propertyId nulo).

import {
  RBAC_AUDIT_ACTIONS,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_VERSION,
  sodConflictsOf,
  type PermissionKey,
  type RbacReportDto,
  type RoleKey,
  type RoleLevel,
  type ScopeType
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, RbacForbiddenError } from "../../lib/http-error.js";
import { accessDecision } from "../../security/access-decision.js";
import { requirePermissions } from "../auth/auth.service.js";
import { defaultRbacDeps, scopeOfContext, type RbacDeps } from "./assignments.service.js";
import { getThresholds } from "./thresholds.service.js";

/** Organisation-wide readers: platform admins and holders of a live legal_entity / organization assignment (never «by holding audit.read in a hotel»). */
export async function requireOrganizationScope(context: UserContext, deps: RbacDeps): Promise<void> {
  if (context.isPlatformAdmin === true) return;
  const scope = await scopeOfContext(context, deps);
  if (!scope.orgScope) throw new RbacForbiddenError("Este informe es de toda la organización: exige una asignación de sociedad u organización.", "RBAC_SCOPE_EXCEEDED");
}

export type RbacReport = RbacReportDto & {
  /** Keys per module (prefix before the first dot, §4.3) for every role. */
  modules: Array<{ roleId: string; byModule: Array<{ module: string; keys: PermissionKey[] }> }>;
  /** Live assignments per scope type. */
  assignmentsByScope: Record<ScopeType, number>;
  /** Rows of user_property_roles still in dual-read (until the L6 cut-over). */
  legacyAssignments: number;
};

function toTemplateKey(value: string | null): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

function groupByModule(keys: readonly PermissionKey[]): Array<{ module: string; keys: PermissionKey[] }> {
  const groups = new Map<string, PermissionKey[]>();
  for (const key of keys) {
    const module = key.split(".")[0] ?? key;
    const list = groups.get(module) ?? [];
    list.push(key);
    groups.set(module, list);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, list]) => ({ module, keys: list.slice().sort() }));
}

export async function rbacReport(input: { context: UserContext }, deps: RbacDeps = defaultRbacDeps): Promise<RbacReport> {
  const { context } = input;
  requirePermissions(context, ["audit.read"]);
  await requireOrganizationScope(context, deps);
  const organizationId = context.organizationId;
  const db = deps.db;
  const now = deps.now();
  const roles = await db.role.findMany({ where: { organizationId }, select: { id: true, name: true, templateKey: true, level: true, department: true, managed: true, templateVersion: true }, orderBy: { name: "asc" } });
  const roleIds = roles.map((role) => role.id);
  const grants = roleIds.length === 0 ? [] : await db.rolePermission.findMany({ where: { roleId: { in: roleIds } }, select: { roleId: true, permissionId: true } });
  const permissionIds = [...new Set(grants.map((grant) => grant.permissionId))];
  const permissions = permissionIds.length === 0 ? [] : await db.permission.findMany({ where: { id: { in: permissionIds } }, select: { id: true, key: true } });
  const keyById = new Map(permissions.map((row) => [row.id, row.key as PermissionKey]));
  const keysByRole = new Map<string, PermissionKey[]>();
  for (const grant of grants) {
    const key = keyById.get(grant.permissionId);
    if (!key) continue;
    const list = keysByRole.get(grant.roleId) ?? [];
    list.push(key);
    keysByRole.set(grant.roleId, list);
  }
  const assignments = await db.userRoleAssignment.findMany({ where: { organizationId, revokedAt: null, OR: [{ validTo: null }, { validTo: { gt: now } }] }, select: { roleId: true, scopeType: true } });
  const legacy = roleIds.length === 0 ? [] : await db.userPropertyRole.findMany({ where: { roleId: { in: roleIds } }, select: { roleId: true } });
  const assignmentCount = new Map<string, number>();
  for (const row of [...assignments, ...legacy]) assignmentCount.set(row.roleId, (assignmentCount.get(row.roleId) ?? 0) + 1);
  const assignmentsByScope: Record<ScopeType, number> = { property: legacy.length, property_group: 0, legal_entity: 0, organization: 0 };
  for (const row of assignments) assignmentsByScope[row.scopeType] += 1;

  const reportRoles: RbacReportDto["roles"] = roles.map((role) => {
    const keys = [...new Set(keysByRole.get(role.id) ?? [])].sort();
    const templateKey = toTemplateKey(role.templateKey);
    const templateKeys = templateKey ? new Set<PermissionKey>(ROLE_PERMISSION_MAP[templateKey]) : null;
    return {
      roleId: role.id,
      name: role.name,
      templateKey,
      level: role.level as RoleLevel | null,
      department: role.department,
      managed: role.managed,
      templateVersion: role.templateVersion,
      permissionCount: keys.length,
      permissions: keys,
      extraKeys: templateKeys ? keys.filter((key) => !templateKeys.has(key)) : [],
      missingKeys: templateKeys ? Array.from(templateKeys).filter((key) => !keys.includes(key)).sort() : [],
      assignmentCount: assignmentCount.get(role.id) ?? 0,
      sodConflicts: sodConflictsOf(keys, templateKey)
    };
  });
  const bySignature = new Map<string, string[]>();
  for (const role of reportRoles) {
    const signature = role.permissions.join("|");
    const list = bySignature.get(signature) ?? [];
    list.push(role.roleId);
    bySignature.set(signature, list);
  }
  const identicalRoles = Array.from(bySignature.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([signature, roleIds]) => ({ roleIds, permissionCount: signature === "" ? 0 : signature.split("|").length }));
  const thresholds = await getThresholds(organizationId, deps);
  return {
    organizationId,
    generatedAt: now.toISOString(),
    templateVersion: ROLE_TEMPLATE_VERSION,
    roles: reportRoles,
    identicalRoles,
    thresholds: thresholds.rows,
    modules: reportRoles.map((role) => ({ roleId: role.roleId, byModule: groupByModule(role.permissions) })),
    assignmentsByScope,
    legacyAssignments: legacy.length
  };
}

export type AccessLogEntry = {
  id: string;
  action: string;
  actorUserId: string | null;
  propertyId: string | null;
  entityType: string;
  entityId: string | null;
  afterJson: unknown;
  ipAddress: string | null;
  deviceId: string | null;
  correlationId: string | null;
  createdAt: string;
  /** For ACCESS_DENIED rows: the keys the route requires today (pure decision over the manifest). */
  required?: PermissionKey[];
};

export type AccessLogPage = { items: AccessLogEntry[]; total: number; limit: number; offset: number };

export async function accessLog(input: { context: UserContext; from?: string; to?: string; userId?: string; action?: string; limit?: number; offset?: number }, deps: RbacDeps = defaultRbacDeps): Promise<AccessLogPage> {
  const { context } = input;
  requirePermissions(context, ["audit.read"]);
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const offset = Math.max(0, input.offset ?? 0);
  const from = input.from ? new Date(input.from) : null;
  const to = input.to ? new Date(input.to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw new BadRequestError("Rango de fechas no válido.");
  const actions = input.action ? [input.action] : [...RBAC_AUDIT_ACTIONS];
  if (input.action && !(RBAC_AUDIT_ACTIONS as readonly string[]).includes(input.action)) throw new BadRequestError("Acción desconocida para el registro de accesos.");
  // Scope filter (SEC-8A-03): organisation-wide readers see everything; a
  // property-scoped holder of audit.read sees only the events of the
  // properties it covers (never the organisation-level rows, propertyId null).
  const scope = context.isPlatformAdmin === true ? null : await scopeOfContext(context, deps);
  const propertyFilter = scope === null || scope.orgScope ? {} : { propertyId: { in: scope.assignedPropertyIds.length === 0 ? ["__none__"] : scope.assignedPropertyIds } };
  const where = {
    organizationId: context.organizationId,
    action: { in: actions },
    ...propertyFilter,
    ...(input.userId ? { actorUserId: input.userId } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {})
  };
  const [total, rows] = await Promise.all([
    deps.db.auditEvent.count({ where }),
    deps.db.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit, select: { id: true, action: true, actorUserId: true, propertyId: true, entityType: true, entityId: true, afterJson: true, ipAddress: true, deviceId: true, correlationId: true, createdAt: true } })
  ]);
  const items: AccessLogEntry[] = rows.map((row) => {
    const entry: AccessLogEntry = {
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      propertyId: row.propertyId,
      entityType: row.entityType,
      entityId: row.entityId,
      afterJson: row.afterJson,
      ipAddress: row.ipAddress,
      deviceId: row.deviceId,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString()
    };
    if (row.action === "ACCESS_DENIED" && row.entityType === "route" && typeof row.entityId === "string") {
      const [method, ...rest] = row.entityId.split(" ");
      const path = rest.join(" ");
      if (method && path) {
        const decision = accessDecision({ method, path, permissions: [], authenticated: true, propertyId: row.propertyId, scopeType: row.propertyId ? "property" : null });
        entry.required = decision.required;
      }
    }
    return entry;
  });
  return { items, total, limit, offset };
}
