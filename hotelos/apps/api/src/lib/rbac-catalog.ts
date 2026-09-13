// RBAC catalog sync + role templates (Tanda 1).
//
// The permission catalog in Postgres (`permissions`) converges to PERMISSIONS
// from @hotelos/shared, and organization roles receive the permissions of a
// shared template (ROLE_PERMISSION_MAP). Three entry points:
//
//   - syncPermissionCatalog(): createMany(skipDuplicates) for missing keys and
//     description refresh for changed ones. Keys present in the DB but absent
//     from the catalog are reported as `stale` and NEVER deleted unless
//     `prune: true` (which first removes their role_permissions — there is no
//     FK between the RBAC tables, so orphans would otherwise linger). Because
//     prune destroys those grants (today: 4 pms.reservation.* rows of the
//     super-admin role), the result (`staleGrants`) and the boot/CLI warning
//     say how many role_permissions rows would be lost.
//   - applyRoleTemplate(roleId, templateKey): additive, idempotent grant of a
//     template to one Role row. Missing catalog keys are materialised first so
//     the call is self-sufficient inside createTenant's transaction.
//   - backfillTemplateRoles(): one-off repair for roles created before Tanda 1
//     (e.g. the Faranda "Owner" with 0 role_permissions): every Role whose
//     name matches a template (case/accent-insensitive, with Spanish synonyms)
//     and that still has ZERO permissions gets the template. A role with at
//     least one grant is considered custom and is never touched — except the
//     PLATFORM roles (HotelOS staff, see isPlatformRoleName / the detection in
//     backfillTemplateRoles), which are topped up to the FULL catalog (org +
//     platform keys) on every run, additively: in production the super admin
//     held 83/212 grants and answered 403 on 345 manifest routes because the
//     backfill skipped it.
//
// server.ts calls syncPermissionCatalog() + backfillTemplateRoles() at boot;
// apps/api/src/scripts/rbac-sync.ts exposes the same with --prune/--dry-run.
//
// Concurrency: every write is an upsert-like operation guarded by the unique
// keys (permissions.key, role_permissions[role_id, permission_id]) with
// skipDuplicates, so several API replicas can run it at once.

import {
  ORG_PERMISSION_KEYS,
  PERMISSIONS,
  PLATFORM_PERMISSION_KEYS,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_KEYS,
  isPlatformPermission,
  type PermissionKey,
  type RoleKey
} from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";
import { NotFoundError } from "./http-error.js";

/** Either the global client or a transaction client (createTenant / bootstrap run inside $transaction). */
export type RbacDb = Prisma.TransactionClient | typeof prisma;

export type CatalogSyncResult = {
  created: number;
  updated: number;
  stale: string[];
  /** role_permissions rows that still point at a stale key — what `prune` would delete. */
  staleGrants?: number;
  /** Distinct roles holding at least one stale grant. */
  staleGrantRoles?: number;
  /** Stale keys actually deleted (only with `prune: true`). */
  pruned?: number;
  /** role_permissions rows actually deleted (only with `prune: true`). */
  prunedGrants?: number;
};

export type CatalogSyncOptions = {
  prune?: boolean;
  /** Compute the diff without writing (CLI --dry-run). */
  dryRun?: boolean;
  db?: RbacDb;
};

/** Upsert every catalog key (idempotent, multi-replica safe); never prunes unless asked. */
export async function syncPermissionCatalog(options: CatalogSyncOptions = {}): Promise<CatalogSyncResult> {
  const db = options.db ?? prisma;
  const catalog = PERMISSIONS as Record<string, string>;
  const catalogKeys = Object.keys(catalog);

  const existing = await db.permission.findMany({ select: { id: true, key: true, description: true } });
  const existingByKey = new Map(existing.map((row) => [row.key, row]));

  const missing = catalogKeys.filter((key) => !existingByKey.has(key));
  const changed = catalogKeys.filter((key) => {
    const row = existingByKey.get(key);
    return row !== undefined && row.description !== catalog[key];
  });
  const staleRows = existing.filter((row) => !(row.key in catalog));
  const stale = staleRows.map((row) => row.key).sort();
  const staleIds = staleRows.map((row) => row.id);

  // Grants that still point at stale keys are exactly what `prune` destroys,
  // so the dry-run result and the warning below count them (rows and roles).
  const staleGrantRows =
    staleIds.length > 0
      ? await db.rolePermission.groupBy({
          by: ["roleId"],
          where: { permissionId: { in: staleIds } },
          _count: { _all: true }
        })
      : [];
  const staleGrants = staleGrantRows.reduce((sum, row) => sum + row._count._all, 0);
  const staleGrantRoles = staleGrantRows.length;

  if (options.dryRun) {
    return {
      created: missing.length,
      updated: changed.length,
      stale,
      staleGrants,
      staleGrantRoles,
      pruned: options.prune ? stale.length : 0,
      prunedGrants: options.prune ? staleGrants : 0
    };
  }

  let created = 0;
  if (missing.length > 0) {
    const result = await db.permission.createMany({
      data: missing.map((key) => ({ key, description: catalog[key] })),
      skipDuplicates: true
    });
    created = result.count;
  }

  let updated = 0;
  for (const key of changed) {
    // updateMany (not update) so a concurrent prune on another replica cannot
    // turn this into a P2025 crash; the NOT filter keeps it idempotent.
    const result = await db.permission.updateMany({
      where: { key, NOT: { description: catalog[key] } },
      data: { description: catalog[key] }
    });
    updated += result.count;
  }

  let pruned = 0;
  let prunedGrants = 0;
  if (stale.length > 0) {
    if (options.prune) {
      // No FK between role_permissions and permissions: drop the grants first,
      // otherwise orphan rows would linger behind a permission id that no
      // longer exists. This is the destructive half of --prune.
      const droppedGrants = await db.rolePermission.deleteMany({ where: { permissionId: { in: staleIds } } });
      prunedGrants = droppedGrants.count;
      const result = await db.permission.deleteMany({ where: { id: { in: staleIds } } });
      pruned = result.count;
      console.warn(
        `[rbac] pruned ${pruned} stale permission key(s) and ${prunedGrants} role_permissions row(s) on ${staleGrantRoles} role(s): ${stale.join(", ")}`
      );
    } else {
      console.warn(
        `[rbac] ${stale.length} stale permission key(s) in DB not in catalog (kept): ${stale.join(", ")} — ` +
          `${staleGrants} role_permissions row(s) on ${staleGrantRoles} role(s) still use them and WOULD BE DELETED by rbac:sync --prune (optional, destructive)`
      );
    }
  }

  return { created, updated, stale, staleGrants, staleGrantRoles, pruned, prunedGrants };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function isRoleKey(value: string): value is RoleKey {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSION_MAP, value);
}

/** Template keys for a template, with the platform scope stripped as a hard guarantee. */
export function templatePermissionKeys(templateKey: string): PermissionKey[] {
  if (!isRoleKey(templateKey)) {
    throw new Error(`Unknown role template "${templateKey}". Known: ${ROLE_TEMPLATE_KEYS.join(", ")}.`);
  }
  const keys = ROLE_PERMISSION_MAP[templateKey].filter((key) => !isPlatformPermission(key));
  // Owner/admin are defined as ORG_PERMISSION_KEYS; keep the invariant explicit
  // for readers of the DB rows: a template can never exceed the org scope.
  const orgScope = new Set<string>(ORG_PERMISSION_KEYS);
  return Array.from(new Set(keys.filter((key) => orgScope.has(key))));
}

export type ApplyRoleTemplateOptions = {
  db?: RbacDb;
  dryRun?: boolean;
};

/** Grant a role the permissions of a shared template (e.g. "owner"); additive and idempotent. */
export async function applyRoleTemplate(
  roleId: string,
  templateKey: string,
  options: ApplyRoleTemplateOptions = {}
): Promise<{ granted: number }> {
  return grantKeysToRole(roleId, templatePermissionKeys(templateKey), options);
}

/**
 * Grant a PLATFORM role every catalog key (org + platform scope). Additive and
 * idempotent: nothing is ever removed. Only backfillTemplateRoles calls this,
 * after its conservative platform-role detection — never wire it to a tenant
 * endpoint, a platform key means cross-tenant access.
 */
export async function applyFullCatalog(roleId: string, options: ApplyRoleTemplateOptions = {}): Promise<{ granted: number }> {
  return grantKeysToRole(roleId, Object.keys(PERMISSIONS) as PermissionKey[], options);
}

/** Shared grant primitive: materialise missing catalog keys, then createMany(skipDuplicates) the diff. */
async function grantKeysToRole(
  roleId: string,
  keys: PermissionKey[],
  options: ApplyRoleTemplateOptions
): Promise<{ granted: number }> {
  const db = options.db ?? prisma;

  const role = await db.role.findUnique({ where: { id: roleId }, select: { id: true } });
  if (!role) {
    throw new NotFoundError("Rol no encontrado.");
  }

  let permissions = await db.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
  const known = new Set(permissions.map((row) => row.key));
  const missingKeys = keys.filter((key) => !known.has(key));
  if (missingKeys.length > 0 && !options.dryRun) {
    // Catalog not synced yet (fresh DB, boot sync disabled): materialise the
    // template's keys so no grant is silently dropped.
    await db.permission.createMany({
      data: missingKeys.map((key) => ({ key, description: PERMISSIONS[key] })),
      skipDuplicates: true
    });
    permissions = await db.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
  }

  const alreadyGranted = new Set(
    (await db.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } })).map((row) => row.permissionId)
  );
  const toGrant = permissions.filter((row) => !alreadyGranted.has(row.id));
  if (options.dryRun) {
    // Keys not yet in the catalog would be created and granted by a real run.
    return { granted: toGrant.length + missingKeys.length };
  }
  if (toGrant.length === 0) {
    return { granted: 0 };
  }
  // RolePermission.id defaults to cuid() in the schema; the unique
  // [roleId, permissionId] + skipDuplicates makes concurrent runs converge.
  const result = await db.rolePermission.createMany({
    data: toGrant.map((row) => ({ roleId, permissionId: row.id })),
    skipDuplicates: true
  });
  return { granted: result.count };
}

// ---------------------------------------------------------------------------
// Backfill by role name
// ---------------------------------------------------------------------------

/** Lower-case, accent-stripped, single-spaced. */
function normalizeRoleName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whole-word aliases (already normalized). Order = ROLE_TEMPLATE_KEYS priority.
const ROLE_TEMPLATE_ALIASES: Record<RoleKey, readonly string[]> = {
  owner: ["owner", "owners", "propietario", "propietaria", "propietarios", "dueno", "duena", "titular"],
  admin: ["admin", "administrator", "administrador", "administradora", "superadmin", "super admin"],
  manager: [
    "manager",
    "general manager",
    "gm",
    "gestor",
    "gestora",
    "gestion",
    "director",
    "directora",
    "direccion",
    "gerente",
    "gerencia",
    "management"
  ],
  receptionist: [
    "receptionist",
    "reception",
    "recepcion",
    "recepcionista",
    "front desk",
    "frontdesk",
    "front office",
    "jefe de recepcion"
  ],
  housekeeper: ["housekeeper", "housekeeping", "pisos", "limpieza", "gobernanta", "camarera de pisos"],
  maintenance: ["maintenance", "mantenimiento", "tecnico", "tecnica", "sat"],
  accountant: ["accountant", "accounting", "contable", "contabilidad", "finanzas", "finance", "administracion"],
  compliance: ["compliance", "cumplimiento", "legal", "rgpd", "gdpr"],
  revenue: ["revenue", "revenue manager", "yield", "pricing", "distribucion", "distribution"]
};

/** Template key for a Role.name, or undefined when the name matches no template (custom role). */
export function resolveTemplateKeyForRoleName(name: string): RoleKey | undefined {
  const normalized = normalizeRoleName(name);
  if (!normalized) return undefined;
  // 1) exact alias match
  for (const key of ROLE_TEMPLATE_KEYS) {
    if (ROLE_TEMPLATE_ALIASES[key].includes(normalized)) return key;
  }
  // 2) alias appearing as whole word(s) inside a longer name ("Director General")
  const padded = ` ${normalized} `;
  for (const key of ROLE_TEMPLATE_KEYS) {
    if (ROLE_TEMPLATE_ALIASES[key].some((alias) => padded.includes(` ${alias} `))) return key;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Platform roles (HotelOS staff)
// ---------------------------------------------------------------------------

// Normalized names that denote a platform role. Matched case/accent-insensitively
// through normalizeRoleName, so "Local Super Admin", "SUPER-ADMIN" or
// "Platform admin" all qualify.
const PLATFORM_ROLE_NAMES: readonly string[] = [
  "local super admin",
  "super admin",
  "superadmin",
  "platform admin",
  "platform administrator"
];

/** True when Role.name is one of the platform role names (see PLATFORM_ROLE_NAMES). */
export function isPlatformRoleName(name: string): boolean {
  return PLATFORM_ROLE_NAMES.includes(normalizeRoleName(name));
}

export type BackfillTemplateRolesOptions = {
  db?: RbacDb;
  dryRun?: boolean;
};

export type BackfillTemplateRolesResult = {
  rolesFilled: number;
  /** "<name> (<organizationId>) ← <template>: +<granted>" per filled role. */
  roles: string[];
  /** Empty roles whose name matches no template (left untouched). */
  unmatched?: string[];
  /** Platform roles that received at least one new grant in this run (0 once converged). */
  platformRolesToppedUp?: number;
  /** "<name> (<organizationId>) ← full catalog: +<granted>" per detected platform role. */
  platformRoles?: string[];
};

/**
 * Fill template-named org roles that still have zero permissions (one-off
 * repair for tenants created before Tanda 1) and top up the platform roles to
 * the full catalog.
 *
 * Platform-role detection is deliberately conservative, because a platform key
 * (admin.tenants.manage) grants cross-tenant access:
 *   (a) the role already holds a platform key (admin.* / platform.*), or
 *   (b) its name is a platform role name AND it lives in an organization that
 *       already owns a platform-granted role (the HotelOS org) — never in a
 *       tenant org, so a hotel creating a "Super Admin" role keeps getting the
 *       org-scoped `admin` template and cannot escalate.
 * The top-up is additive and idempotent: a converged role reports +0.
 */
export async function backfillTemplateRoles(options: BackfillTemplateRolesOptions = {}): Promise<BackfillTemplateRolesResult> {
  const db = options.db ?? prisma;
  const roles = await db.role.findMany({ select: { id: true, name: true, organizationId: true }, orderBy: { id: "asc" } });
  if (roles.length === 0) {
    return { rolesFilled: 0, roles: [], unmatched: [], platformRolesToppedUp: 0, platformRoles: [] };
  }
  const granted = await db.rolePermission.groupBy({ by: ["roleId"], _count: { _all: true } });
  const rolesWithGrants = new Set(granted.map((row) => row.roleId));

  // (a) roles holding a platform key today; (b) the organizations they live in.
  const platformPermissions = await db.permission.findMany({ select: { id: true, key: true } });
  const platformPermissionIds = platformPermissions.filter((row) => isPlatformPermission(row.key)).map((row) => row.id);
  const platformGrantRows =
    platformPermissionIds.length > 0
      ? await db.rolePermission.findMany({ where: { permissionId: { in: platformPermissionIds } }, select: { roleId: true } })
      : [];
  const rolesWithPlatformGrant = new Set(platformGrantRows.map((row) => row.roleId));
  const platformOrganizations = new Set(
    roles.filter((role) => rolesWithPlatformGrant.has(role.id)).map((role) => role.organizationId)
  );
  const isPlatformRole = (role: { id: string; name: string; organizationId: string }): boolean =>
    rolesWithPlatformGrant.has(role.id) || (isPlatformRoleName(role.name) && platformOrganizations.has(role.organizationId));

  const filled: string[] = [];
  const unmatched: string[] = [];
  const platformRoles: string[] = [];
  let platformRolesToppedUp = 0;
  for (const role of roles) {
    if (isPlatformRole(role)) {
      const result = await applyFullCatalog(role.id, { db, dryRun: options.dryRun });
      platformRoles.push(`${role.name} (${role.organizationId}) ← full catalog: +${result.granted}`);
      if (result.granted > 0) platformRolesToppedUp += 1;
      continue;
    }
    if (rolesWithGrants.has(role.id)) continue; // custom or already provisioned: never touched
    const templateKey = resolveTemplateKeyForRoleName(role.name);
    if (!templateKey) {
      unmatched.push(`${role.name} (${role.organizationId})`);
      continue;
    }
    const result = await applyRoleTemplate(role.id, templateKey, { db, dryRun: options.dryRun });
    if (result.granted > 0) {
      filled.push(`${role.name} (${role.organizationId}) ← ${templateKey}: +${result.granted}`);
    }
  }
  if (platformRoles.length > 0) {
    console.log(
      `[rbac] platform roles topped up: ${platformRolesToppedUp} of ${platformRoles.length} platform role(s)${options.dryRun ? " [dry-run]" : ""} (${platformRoles.join(", ")})`
    );
  }
  return { rolesFilled: filled.length, roles: filled, unmatched, platformRolesToppedUp, platformRoles };
}

/** Sanity check exposed for tests/CLI: no template may carry a platform key. */
export function assertTemplatesExcludePlatformKeys(): void {
  const platform = new Set<string>(PLATFORM_PERMISSION_KEYS);
  for (const key of ROLE_TEMPLATE_KEYS) {
    const leaked = ROLE_PERMISSION_MAP[key].filter((permission) => platform.has(permission) || isPlatformPermission(permission));
    if (leaked.length > 0) {
      throw new Error(`Role template "${key}" carries platform permission(s): ${leaked.join(", ")}`);
    }
  }
}
