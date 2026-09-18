// RBAC catalog sync + role templates (Tanda 1, extended in Tanda 4 with
// Role.templateKey).
//
// The permission catalog in Postgres (`permissions`) converges to PERMISSIONS
// from @hotelos/shared, and organization roles receive the permissions of a
// shared template (ROLE_PERMISSION_MAP). Entry points:
//
//   - syncPermissionCatalog(): createMany(skipDuplicates) for missing keys and
//     description refresh for changed ones. Keys present in the DB but absent
//     from the catalog are reported as `stale` and NEVER deleted unless
//     `prune: true` (which first removes their role_permissions — there is no
//     FK between the RBAC tables, so orphans would otherwise linger). Because
//     prune destroys those grants, the result (`staleGrants`) and the boot/CLI
//     warning say how many role_permissions rows would be lost. Procedure:
//     docs/runbooks/rbac-sync.md.
//   - applyRoleTemplate(roleId, templateKey): additive, idempotent grant of a
//     template to one Role row. Missing catalog keys are materialised first so
//     the call is self-sufficient inside createTenant's transaction. It also
//     persists `Role.templateKey` when the row has none yet (never rewrites a
//     different value: a role is stamped once).
//   - backfillTemplateRoles(): runs at boot. Every role that carries a
//     templateKey is topped up to its template on EVERY run (additive,
//     idempotent, +0 once converged) — this is what delivers a key added to
//     PERMISSIONS to the existing Owners instead of answering 403 to the hotel
//     owner until someone repairs the role by hand. Roles without templateKey
//     are adopted by name (resolveTemplateKeyForRoleName, Spanish aliases)
//     when they hold nothing outside that template; a role with grants that
//     matches no template, or that carries hand-picked keys beyond it, is a
//     custom role and is never touched. PLATFORM roles (HotelOS staff, see
//     isPlatformRoleName / the detection in backfillTemplateRoles) are topped
//     up to the FULL catalog (org + platform keys) and keep templateKey null:
//     in production the super admin held 83/212 grants and answered 403 on
//     345 manifest routes because the backfill skipped it.
//   - createRoleFromTemplate() / provisionDefaultTemplateRoles(): create an
//     organization role from a template (POST /backoffice/properties/:id/roles
//     and createTenant), so the invite role selector has real options. Since
//     Tanda 5 (L1b) a new tenant is born with the 10 templates of
//     ORGANIZATION_TEMPLATE_ROLE_KEYS (Spanish names, ROLE_TEMPLATE_LABELS_ES),
//     the same set apps/api/src/scripts/reseed-property-roles.ts materialises
//     in an existing organisation.
//   - ensureRoleHasPermissions(): guard used before assigning a role to a user
//     (invite / POST /users): a role with 0 grants gets its template applied,
//     or the caller receives a 409 — an invitee with an empty role would get
//     403 on every route in production (no demo permission union).
//   - Tanda 8a (L0 · RBAC por departamento y nivel, 2026-09-18): the templates
//     carry a VERSION (ROLE_TEMPLATE_VERSION, packages/shared) and a list of
//     the keys the version REMOVES (ROLE_TEMPLATE_REVOCATIONS). The boot
//     top-up stays additive; upgradeRoleTemplate() is the only writer that
//     revokes: managed roles behind the version lose exactly the revoked keys,
//     gain the missing ones, get level / department / templateVersion stamped
//     and an audit event ROLE_TEMPLATE_UPGRADED. backfillTemplateRoles({
//     upgrade: true }) runs it per managed template role (rbac:sync
//     --upgrade-templates, L3); without the flag it only REPORTS what an
//     upgrade would revoke (revocationsByRole). Roles with managed = false are
//     never touched. ensureBreakGlassRole() creates the «Emergencia» role of
//     an organisation (template break_glass = whole org scope, §4.8); it is
//     never provisioned by default nor creatable through createRoleFromTemplate.
//
// server.ts calls syncPermissionCatalog() + backfillTemplateRoles() at boot;
// apps/api/src/scripts/rbac-sync.ts exposes the same with --prune/--dry-run.
//
// Concurrency: every write is an upsert-like operation guarded by the unique
// keys (permissions.key, role_permissions[role_id, permission_id]) with
// skipDuplicates, so several API replicas can run it at once.

import {
  ORGANIZATION_TEMPLATE_ROLE_KEYS,
  ORG_PERMISSION_KEYS,
  PERMISSIONS,
  PLATFORM_PERMISSION_KEYS,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_DEPARTMENT_ES,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS_ES,
  ROLE_TEMPLATE_LEVEL,
  ROLE_TEMPLATE_REVOCATIONS,
  ROLE_TEMPLATE_VERSION,
  isPlatformPermission,
  type PermissionKey,
  type RoleKey
} from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";
import { BadRequestError, ConflictError, NotFoundError } from "./http-error.js";

/** Either the global client or a transaction client (createTenant / bootstrap run inside $transaction). */
export type RbacDb = Prisma.TransactionClient | typeof prisma;

/** Error code carried in `details` by the 409 of ensureRoleHasPermissions. */
export const ROLE_WITHOUT_PERMISSIONS_CODE = "ROLE_WITHOUT_PERMISSIONS";
/** Fixed user-facing message of that 409 (contract B, pinned by tests). */
export const ROLE_WITHOUT_PERMISSIONS_MESSAGE = "El rol no tiene permisos; asígnale una plantilla antes de invitar";

/** Max length of a role name created through createRoleFromTemplate. */
export const ROLE_NAME_MAX_LENGTH = 80;

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

/** True when `value` is one of the shared template keys (ROLE_PERMISSION_MAP). */
export function isRoleTemplateKey(value: string): value is RoleKey {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSION_MAP, value);
}

/** Template keys for a template, with the platform scope stripped as a hard guarantee. */
export function templatePermissionKeys(templateKey: string): PermissionKey[] {
  if (!isRoleTemplateKey(templateKey)) {
    throw new Error(`Unknown role template "${templateKey}". Known: ${ROLE_TEMPLATE_KEYS.join(", ")}.`);
  }
  const keys = ROLE_PERMISSION_MAP[templateKey].filter((key) => !isPlatformPermission(key));
  // Owner/admin are defined as ORG_PERMISSION_KEYS; keep the invariant explicit
  // for readers of the DB rows: a template can never exceed the org scope.
  const orgScope = new Set<string>(ORG_PERMISSION_KEYS);
  return Array.from(new Set(keys.filter((key) => orgScope.has(key))));
}

/**
 * Keys ROLE_TEMPLATE_VERSION removes from a template with respect to the
 * previous version (Tanda 8a): never a key the template still holds, never a
 * platform key. Empty for templates that lost nothing and for new templates.
 */
export function templateRevocationKeys(templateKey: string): PermissionKey[] {
  if (!isRoleTemplateKey(templateKey)) {
    throw new Error(`Unknown role template "${templateKey}". Known: ${ROLE_TEMPLATE_KEYS.join(", ")}.`);
  }
  const held = new Set<string>(ROLE_PERMISSION_MAP[templateKey]);
  return Array.from(new Set((ROLE_TEMPLATE_REVOCATIONS[templateKey] ?? []).filter((key) => !held.has(key) && !isPlatformPermission(key))));
}

/** Level, Spanish department, version and managed flag a Role row created from `templateKey` carries (Tanda 8a). */
export function templateRoleMetadata(templateKey: RoleKey): {
  level: (typeof ROLE_TEMPLATE_LEVEL)[RoleKey];
  department: string;
  templateVersion: number;
  managed: true;
} {
  return {
    level: ROLE_TEMPLATE_LEVEL[templateKey],
    department: ROLE_TEMPLATE_DEPARTMENT_ES[templateKey],
    templateVersion: ROLE_TEMPLATE_VERSION,
    managed: true
  };
}

export type ApplyRoleTemplateOptions = {
  db?: RbacDb;
  dryRun?: boolean;
};

export type ApplyRoleTemplateResult = {
  /** role_permissions rows created (or, in dry-run, that would be created). */
  granted: number;
  /** Role.templateKey was null and has been (or, in dry-run, would be) set to the template. */
  templateKeySet: boolean;
};

/**
 * Grant a role the permissions of a shared template (e.g. "owner"); additive
 * and idempotent. Also stamps Role.templateKey when the row has none yet, so
 * the boot-time backfill keeps topping the role up as the catalog grows.
 */
export async function applyRoleTemplate(
  roleId: string,
  templateKey: string,
  options: ApplyRoleTemplateOptions = {}
): Promise<ApplyRoleTemplateResult> {
  const keys = templatePermissionKeys(templateKey);
  const db = options.db ?? prisma;
  const grant = await grantKeysToRole(roleId, keys, options);
  const templateKeySet = grant.currentTemplateKey === null;
  if (templateKeySet && !options.dryRun) {
    // Only when still null: a role created from another template keeps its
    // own key (the caller escalated it on purpose; the stamp is not rewritten).
    await db.role.updateMany({ where: { id: roleId, templateKey: null }, data: { templateKey } });
  }
  return { granted: grant.granted, templateKeySet };
}

/**
 * Grant a PLATFORM role every catalog key (org + platform scope). Additive and
 * idempotent: nothing is ever removed. Only backfillTemplateRoles calls this,
 * after its conservative platform-role detection — never wire it to a tenant
 * endpoint, a platform key means cross-tenant access. Platform roles keep
 * templateKey null: "the full catalog" is not an organization template.
 */
export async function applyFullCatalog(roleId: string, options: ApplyRoleTemplateOptions = {}): Promise<{ granted: number }> {
  const grant = await grantKeysToRole(roleId, Object.keys(PERMISSIONS) as PermissionKey[], options);
  return { granted: grant.granted };
}

export type UpgradeRoleTemplateOptions = {
  db?: RbacDb;
  /** Compute the diff without writing (CLI --dry-run). */
  dryRun?: boolean;
  /** Who ran the upgrade (audit trail); null / undefined = system (boot, CLI). */
  actorUserId?: string | null;
  /** Skip the audit event (tests with an injected store). */
  audit?: boolean;
};

export type UpgradeRoleTemplateResult = {
  roleId: string;
  templateKey: RoleKey | null;
  /** Template keys the role lacked and received (dry-run: would receive). */
  added: PermissionKey[];
  /** Revoked keys the role held and lost (dry-run: would lose). */
  revoked: PermissionKey[];
  dryRun: boolean;
  /** false when nothing was (would be) done: see skippedReason. */
  upgraded: boolean;
  fromVersion: number;
  toVersion: number;
  skippedReason?: "custom" | "no_template" | "unknown_template" | "platform" | "up_to_date";
};

/**
 * Converge ONE managed template role to ROLE_TEMPLATE_VERSION (Tanda 8a · L0,
 * design §6.5): when `role.managed` and `role.templateKey` is a known template
 * and `role.templateVersion < ROLE_TEMPLATE_VERSION`, grant the template keys
 * it lacks, DELETE the role_permissions of ROLE_TEMPLATE_REVOCATIONS[template]
 * it still holds, stamp level / department / templateVersion and record
 * ROLE_TEMPLATE_UPGRADED (beforeJson = revoked keys, afterJson = added keys).
 * This is the ONLY writer that removes a grant from a template role; the boot
 * top-up never does. Custom roles (managed = false), roles without or with an
 * unknown template, platform roles (they hold a platform key) and roles
 * already at the version are left untouched and reported as skipped.
 */
export async function upgradeRoleTemplate(roleId: string, options: UpgradeRoleTemplateOptions = {}): Promise<UpgradeRoleTemplateResult> {
  const db = options.db ?? prisma;
  const dryRun = options.dryRun === true;
  const role = await db.role.findUnique({
    where: { id: roleId },
    select: { id: true, name: true, organizationId: true, templateKey: true, managed: true, templateVersion: true }
  });
  if (!role) {
    throw new NotFoundError("Rol no encontrado.");
  }
  const fromVersion = role.templateVersion ?? 0;
  const base = { roleId, dryRun, added: [] as PermissionKey[], revoked: [] as PermissionKey[], upgraded: false, fromVersion, toVersion: ROLE_TEMPLATE_VERSION };
  if (role.managed === false) return { ...base, templateKey: null, skippedReason: "custom" };
  if (role.templateKey === null) return { ...base, templateKey: null, skippedReason: "no_template" };
  if (!isRoleTemplateKey(role.templateKey)) return { ...base, templateKey: null, skippedReason: "unknown_template" };
  const templateKey: RoleKey = role.templateKey;
  if (fromVersion >= ROLE_TEMPLATE_VERSION) return { ...base, templateKey, skippedReason: "up_to_date" };

  const grants = await db.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } });
  const permissionIds = grants.map((row) => row.permissionId);
  const rows = permissionIds.length > 0 ? await db.permission.findMany({ where: { id: { in: permissionIds } }, select: { id: true, key: true } }) : [];
  const held = new Set(rows.map((row) => row.key));
  if (rows.some((row) => isPlatformPermission(row.key))) {
    // A platform role is never a managed template role: a revocation there would
    // strip cross-tenant access the platform detection of the backfill relies on.
    return { ...base, templateKey, skippedReason: "platform" };
  }
  const templateKeys = templatePermissionKeys(templateKey);
  const added = templateKeys.filter((key) => !held.has(key));
  const revokedSet = new Set<string>(templateRevocationKeys(templateKey));
  const revoked = rows.filter((row) => revokedSet.has(row.key)).map((row) => row.key as PermissionKey).sort();
  const revokedIds = rows.filter((row) => revokedSet.has(row.key)).map((row) => row.id);

  if (!dryRun) {
    const metadata = templateRoleMetadata(templateKey);
    await runInTransaction(db, async (tx) => {
      if (added.length > 0) await grantKeysToRole(roleId, templateKeys, { db: tx });
      if (revokedIds.length > 0) await tx.rolePermission.deleteMany({ where: { roleId, permissionId: { in: revokedIds } } });
      await tx.role.updateMany({
        where: { id: roleId },
        data: { templateVersion: metadata.templateVersion, level: metadata.level, department: metadata.department }
      });
    });
    if (options.audit !== false) {
      try {
        // Dynamic import (see createRoleFromTemplate): audit.service must not be a static dependency of lib/.
        const { recordAuditEvent } = await import("../modules/audit/audit.service.js");
        recordAuditEvent({
          organizationId: role.organizationId,
          actorUserId: options.actorUserId ?? undefined,
          actorType: options.actorUserId ? "user" : "system",
          action: "ROLE_TEMPLATE_UPGRADED",
          entityType: "role",
          entityId: roleId,
          beforeJson: { name: role.name, templateKey, templateVersion: fromVersion, revoked },
          afterJson: { name: role.name, templateKey, templateVersion: ROLE_TEMPLATE_VERSION, added }
        });
      } catch (error) {
        console.warn("[rbac] audit event for upgradeRoleTemplate failed", { roleId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { ...base, templateKey, added, revoked, upgraded: true };
}

/** Shared grant primitive: materialise missing catalog keys, then createMany(skipDuplicates) the diff. */
async function grantKeysToRole(
  roleId: string,
  keys: PermissionKey[],
  options: ApplyRoleTemplateOptions
): Promise<{ granted: number; currentTemplateKey: string | null }> {
  const db = options.db ?? prisma;

  const role = await db.role.findUnique({ where: { id: roleId }, select: { id: true, templateKey: true } });
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
    return { granted: toGrant.length + missingKeys.length, currentTemplateKey: role.templateKey };
  }
  if (toGrant.length === 0) {
    return { granted: 0, currentTemplateKey: role.templateKey };
  }
  // RolePermission.id defaults to cuid() in the schema; the unique
  // [roleId, permissionId] + skipDuplicates makes concurrent runs converge.
  const result = await db.rolePermission.createMany({
    data: toGrant.map((row) => ({ roleId, permissionId: row.id })),
    skipDuplicates: true
  });
  return { granted: result.count, currentTemplateKey: role.templateKey };
}

// ---------------------------------------------------------------------------
// Role creation from a template
// ---------------------------------------------------------------------------

/** Run `fn` inside a transaction when `db` is the root client; reuse it when it already is a transaction client. */
async function runInTransaction<T>(db: RbacDb, fn: (tx: RbacDb) => Promise<T>): Promise<T> {
  const client = db as { $transaction?: (callback: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };
  if (typeof client.$transaction === "function") {
    return client.$transaction((tx) => fn(tx));
  }
  return fn(db);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export type CreateRoleFromTemplateInput = {
  organizationId: string;
  name: string;
  templateKey: string;
  /** Who created it (audit trail); null for system provisioning. */
  actorUserId: string | null;
};

export type CreateRoleFromTemplateResult = {
  id: string;
  name: string;
  templateKey: string;
  permissionsCount: number;
};

export type CreateRoleFromTemplateOptions = {
  db?: RbacDb;
  /** Skip the audit event (tests with an injected store). */
  audit?: boolean;
};

/**
 * Create an organization role from a shared template (contract B):
 * 400 when the template does not exist or the name is empty, 409 when the
 * organization already has a role with that name (case-insensitive: "Manager"
 * and "manager" would confuse the invite selector), otherwise the Role row is
 * created with templateKey and the template applied in the same transaction.
 * Permission gating (roles.manage) belongs to the route, not here.
 */
export async function createRoleFromTemplate(
  input: CreateRoleFromTemplateInput,
  options: CreateRoleFromTemplateOptions = {}
): Promise<CreateRoleFromTemplateResult> {
  const name = (input.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("El nombre del rol es obligatorio.");
  }
  if (name.length > ROLE_NAME_MAX_LENGTH) {
    throw new BadRequestError(`El nombre del rol no puede superar ${ROLE_NAME_MAX_LENGTH} caracteres.`);
  }
  if (typeof input.templateKey !== "string" || !isRoleTemplateKey(input.templateKey)) {
    throw new BadRequestError(
      `Plantilla de rol desconocida: "${String(input.templateKey)}". Disponibles: ${ROLE_TEMPLATE_KEYS.join(", ")}.`
    );
  }
  const templateKey: RoleKey = input.templateKey;
  if (templateKey === "break_glass") {
    // §4.8: the emergency role is created only by ensureBreakGlassRole and is
    // never offered by the role selector; opaque 404 so the template does not
    // leak through the error message.
    throw new NotFoundError("Plantilla de rol no disponible.");
  }
  const db = options.db ?? prisma;

  const duplicate = await db.role.findFirst({
    where: { organizationId: input.organizationId, name: { equals: name, mode: "insensitive" } },
    select: { id: true }
  });
  if (duplicate) {
    throw new ConflictError("Ya existe un rol con ese nombre en la organización.");
  }

  const created = await runInTransaction(db, async (tx) => {
    let role: { id: string; name: string; templateKey: string | null };
    try {
      role = await tx.role.create({
        data: { organizationId: input.organizationId, name, templateKey, ...templateRoleMetadata(templateKey) },
        select: { id: true, name: true, templateKey: true }
      });
    } catch (error) {
      // Lost the race against a concurrent create with the same name: same 409
      // as the pre-check instead of an opaque P2002.
      if (isUniqueViolation(error)) {
        throw new ConflictError("Ya existe un rol con ese nombre en la organización.");
      }
      throw error;
    }
    const applied = await applyRoleTemplate(role.id, templateKey, { db: tx });
    return { role, granted: applied.granted };
  });

  const permissionsCount = await db.rolePermission.count({ where: { roleId: created.role.id } });

  if (options.audit !== false) {
    // Dynamic import: audit.service pulls the accounting/invoicing graph, which
    // must not become a static dependency of lib/ (module cycle at boot).
    try {
      const { recordAuditEvent } = await import("../modules/audit/audit.service.js");
      recordAuditEvent({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? undefined,
        actorType: input.actorUserId ? "user" : "system",
        action: "ROLE_CREATED_FROM_TEMPLATE",
        entityType: "role",
        entityId: created.role.id,
        afterJson: { name, templateKey, permissionsCount }
      });
    } catch (error) {
      // The role exists and is usable; a missing audit row must not undo it.
      console.warn("[rbac] audit event for createRoleFromTemplate failed", {
        roleId: created.role.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { id: created.role.id, name: created.role.name, templateKey, permissionsCount };
}

/**
 * Template roles every new tenant gets: one Role row per template of
 * ORGANIZATION_TEMPLATE_ROLE_KEYS, named after ROLE_TEMPLATE_LABELS_ES
 * (Tanda 5 · L1b materialised the 10 templates the navigation tree binds its
 * tokens to; Tanda 8a · L0 raises them to the 22 templates of design §4.2 —
 * every template but `admin` and `break_glass`). The owner entry is matched by
 * templateKey against the "Owner" row createTenant creates first, so a tenant
 * never gets a second owner role. Names are what the hotel sees; each one also
 * resolves through resolveTemplateKeyForRoleName, so a row that lost its
 * templateKey would be adopted again by the boot backfill.
 */
export const DEFAULT_TENANT_ROLE_TEMPLATES: ReadonlyArray<{ name: string; templateKey: RoleKey }> =
  ORGANIZATION_TEMPLATE_ROLE_KEYS.map((templateKey) => ({ name: ROLE_TEMPLATE_LABELS_ES[templateKey], templateKey }));

export type ProvisionedTemplateRole = {
  id: string;
  name: string;
  templateKey: string;
  permissionsCount: number;
  /** false when the role already existed (its template was still topped up). */
  created: boolean;
  /**
   * Set when the template's Spanish name is already taken by a role that
   * follows ANOTHER template: that row is left untouched and no second role
   * is created (same "conflict" rule as reseed-property-roles).
   */
  conflict?: string;
};

/**
 * Idempotently create the DEFAULT_TENANT_ROLE_TEMPLATES roles of an
 * organization and apply their templates (createTenant; also safe to re-run on
 * an existing tenant). Per template, in order: a role already stamped with the
 * template (createTenant's "Owner", a role the hotel renamed) is topped up;
 * else a role carrying the template's Spanish name is adopted (applyRoleTemplate
 * stamps templateKey when it is null) unless it follows another template
 * (conflict, untouched); else the row is created. Runs on the given client —
 * pass the transaction client from createTenant so a failure rolls the whole
 * tenant back.
 */
export async function provisionDefaultTemplateRoles(
  organizationId: string,
  options: { db?: RbacDb } = {}
): Promise<ProvisionedTemplateRole[]> {
  const db = options.db ?? prisma;
  const provisioned: ProvisionedTemplateRole[] = [];
  for (const template of DEFAULT_TENANT_ROLE_TEMPLATES) {
    const stamped = await db.role.findFirst({
      where: { organizationId, templateKey: template.templateKey },
      orderBy: { id: "asc" },
      select: { id: true, name: true, templateKey: true }
    });
    const byName =
      stamped ??
      (await db.role.findUnique({
        where: { organizationId_name: { organizationId, name: template.name } },
        select: { id: true, name: true, templateKey: true }
      }));
    if (byName && byName.templateKey !== null && byName.templateKey !== template.templateKey) {
      const permissionsCount = await db.rolePermission.count({ where: { roleId: byName.id } });
      provisioned.push({
        id: byName.id,
        name: byName.name,
        templateKey: byName.templateKey,
        permissionsCount,
        created: false,
        conflict: `«${byName.name}» sigue la plantilla "${byName.templateKey}"; no se crea «${template.name}» (${template.templateKey})`
      });
      continue;
    }
    const existing = byName;
    const role =
      existing ??
      (await db.role.create({
        data: { organizationId, name: template.name, templateKey: template.templateKey, ...templateRoleMetadata(template.templateKey) },
        select: { id: true, name: true, templateKey: true }
      }));
    await applyRoleTemplate(role.id, template.templateKey, { db });
    if (existing) {
      // Rows that predate Tanda 8a carry no level / department: fill them (never
      // the version — that is upgradeRoleTemplate's job, with the revocations).
      const metadata = templateRoleMetadata(template.templateKey);
      await db.role.updateMany({ where: { id: role.id, level: null }, data: { level: metadata.level } });
      await db.role.updateMany({ where: { id: role.id, department: null }, data: { department: metadata.department } });
    }
    const permissionsCount = await db.rolePermission.count({ where: { roleId: role.id } });
    provisioned.push({
      id: role.id,
      name: role.name,
      templateKey: role.templateKey ?? template.templateKey,
      permissionsCount,
      created: existing === null
    });
  }
  return provisioned;
}

export type EnsureBreakGlassRoleResult = {
  id: string;
  name: string;
  permissionsCount: number;
  /** false when the organisation already had its emergency role (still topped up). */
  created: boolean;
};

/**
 * Idempotently create the «Emergencia» role of an organisation (Tanda 8a,
 * design §4.8): templateKey `break_glass`, managed, level general_management,
 * every org-scope key (never a platform key). Only the break-glass service
 * (L1), the backfill / seeds (L3, L5) call it: the template is excluded from
 * ORGANIZATION_TEMPLATE_ROLE_KEYS, from createRoleFromTemplate and from the
 * invite selector, so no hotel user can create or receive it by accident. A
 * role already stamped `break_glass` is topped up; a row named «Emergencia»
 * without template is adopted; one that follows ANOTHER template is a 409.
 */
export async function ensureBreakGlassRole(organizationId: string, options: { db?: RbacDb } = {}): Promise<EnsureBreakGlassRoleResult> {
  const db = options.db ?? prisma;
  const templateKey: RoleKey = "break_glass";
  const name = ROLE_TEMPLATE_LABELS_ES[templateKey];
  const stamped = await db.role.findFirst({
    where: { organizationId, templateKey },
    orderBy: { id: "asc" },
    select: { id: true, name: true, templateKey: true }
  });
  const byName =
    stamped ??
    (await db.role.findUnique({
      where: { organizationId_name: { organizationId, name } },
      select: { id: true, name: true, templateKey: true }
    }));
  if (byName && byName.templateKey !== null && byName.templateKey !== templateKey) {
    throw new ConflictError(`«${byName.name}» sigue la plantilla "${byName.templateKey}"; no se puede crear el rol de emergencia con ese nombre.`);
  }
  const metadata = templateRoleMetadata(templateKey);
  let role = byName;
  if (!role) {
    try {
      role = await db.role.create({
        data: { organizationId, name, templateKey, ...metadata },
        select: { id: true, name: true, templateKey: true }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost the race against a concurrent ensureBreakGlassRole: reuse the winner's row.
      role = await db.role.findUnique({ where: { organizationId_name: { organizationId, name } }, select: { id: true, name: true, templateKey: true } });
      if (!role) throw error;
    }
  }
  await applyRoleTemplate(role.id, templateKey, { db });
  await db.role.updateMany({
    where: { id: role.id },
    data: { level: metadata.level, department: metadata.department, templateVersion: metadata.templateVersion, managed: true }
  });
  const permissionsCount = await db.rolePermission.count({ where: { roleId: role.id } });
  return { id: role.id, name: role.name, permissionsCount, created: byName === null };
}

export type EnsureRoleHasPermissionsResult = {
  /** true when the template had to be applied in this call. */
  applied: boolean;
  permissionsCount: number;
  /** Template the role follows (stored or resolved by name); null for a custom role with grants. */
  templateKey: string | null;
};

/**
 * Guard before assigning a role to a user (contract B). A role with at least
 * one grant is returned as is. A role with ZERO grants gets its template
 * (Role.templateKey, else the name-resolved template) applied on the spot;
 * when no template can be determined the caller gets a 409 — assigning it
 * would create a user who is 403 everywhere in production.
 */
export async function ensureRoleHasPermissions(
  roleId: string,
  options: { db?: RbacDb } = {}
): Promise<EnsureRoleHasPermissionsResult> {
  const db = options.db ?? prisma;
  const role = await db.role.findUnique({ where: { id: roleId }, select: { id: true, name: true, templateKey: true } });
  if (!role) {
    throw new NotFoundError("Rol no encontrado.");
  }
  const current = await db.rolePermission.count({ where: { roleId } });
  if (current > 0) {
    return { applied: false, permissionsCount: current, templateKey: role.templateKey };
  }
  const templateKey =
    role.templateKey && isRoleTemplateKey(role.templateKey) ? role.templateKey : resolveTemplateKeyForRoleName(role.name);
  if (!templateKey) {
    throw roleWithoutPermissionsError(role.id, role.name);
  }
  await applyRoleTemplate(roleId, templateKey, { db });
  const permissionsCount = await db.rolePermission.count({ where: { roleId } });
  if (permissionsCount === 0) {
    // Template with no org-scoped key (cannot happen with the shared map, but
    // stay honest: never report a filled role that is still empty).
    throw roleWithoutPermissionsError(role.id, role.name);
  }
  return { applied: true, permissionsCount, templateKey };
}

function roleWithoutPermissionsError(roleId: string, roleName: string): ConflictError {
  const error = new ConflictError(ROLE_WITHOUT_PERMISSIONS_MESSAGE);
  error.details = { code: ROLE_WITHOUT_PERMISSIONS_CODE, roleId, roleName, templates: ROLE_TEMPLATE_KEYS };
  return error;
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

// Whole-word aliases (already normalized). Order = ROLE_TEMPLATE_KEYS priority
// (most specific first: the Tanda 8a templates before manager / accountant, so
// «Director general», «Dirección financiera» or «Administración de hotel» never
// fall through to the generic «director» / «administracion» aliases). Every
// label of ROLE_TEMPLATE_LABELS_ES, normalized, is ALSO an exact alias of its
// template (resolveTemplateKeyForRoleName checks the labels first).
const ROLE_TEMPLATE_ALIASES: Record<RoleKey, readonly string[]> = {
  general_manager: ["general manager", "gm", "director general", "directora general", "direccion general", "ceo"],
  operations_director: ["director de operaciones", "directora de operaciones", "direccion de operaciones", "operaciones", "coo"],
  front_office_manager: ["jefe de recepcion", "jefa de recepcion", "jefatura de recepcion", "front office manager"],
  housekeeping_manager: ["gobernanta", "gobernante", "housekeeping manager"],
  maintenance_manager: ["encargado de mantenimiento", "encargada de mantenimiento", "jefe de mantenimiento", "jefa de mantenimiento"],
  fnb_manager: ["jefatura de a b", "jefe de sala", "jefa de sala", "jefe de cocina", "jefa de cocina", "maitre"],
  night_auditor: ["auditoria nocturna", "auditor nocturno", "auditora nocturna", "night audit", "night auditor"],
  admin_clerk: ["administracion de hotel", "administrativo", "administrativa"],
  controller: ["direccion financiera", "controller", "director financiero", "directora financiera", "cfo"],
  payroll_hr: ["rrhh y nominas", "rrhh", "nominas", "recursos humanos", "laboral"],
  asset_manager: ["gestion del activo", "activos", "patrimonio", "asset manager"],
  auditor: ["auditoria interna", "auditor", "auditora", "auditoria"],
  break_glass: ["emergencia", "break glass"],
  owner: ["owner", "owners", "propietario", "propietaria", "propietarios", "propiedad", "dueno", "duena", "titular"],
  admin: ["administracion de sistema", "sistemas", "admin", "administrator", "administrador", "administradora", "superadmin", "super admin"],
  manager: [
    "direccion de hotel",
    "director de hotel",
    "directora de hotel",
    "manager",
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
  receptionist: ["receptionist", "reception", "recepcion", "recepcionista", "front desk", "frontdesk", "front office"],
  housekeeper: ["housekeeper", "housekeeping", "pisos", "limpieza", "camarera de pisos", "camarero de pisos"],
  maintenance: ["maintenance", "mantenimiento", "tecnico", "tecnica", "sat"],
  accountant: ["accountant", "accounting", "contable", "contabilidad", "finanzas", "finance", "administracion"],
  compliance: ["compliance", "cumplimiento", "legal", "rgpd", "gdpr"],
  revenue: ["revenue corporativo", "revenue", "revenue manager", "yield", "pricing", "distribucion", "distribution"],
  // Tanda 5 (L1a · rbac): Comercial/Ventas and Punto de venta / F&B. Names
  // match ROLE_TEMPLATE_LABELS_ES (packages/shared) so a row created by
  // reseed-property-roles that lost its template_key is adopted again.
  sales: ["sales", "comercial", "ventas", "sales manager", "marketing", "grupos y eventos", "eventos"],
  fnb: ["fnb", "f b", "punto de venta", "tpv", "pos", "restauracion", "restaurante", "bar", "cocina"]
};

/** Template key for a Role.name, or undefined when the name matches no template (custom role). */
export function resolveTemplateKeyForRoleName(name: string): RoleKey | undefined {
  const normalized = normalizeRoleName(name);
  if (!normalized) return undefined;
  // 1) exact match: the Spanish label of the template, then its aliases
  for (const key of ROLE_TEMPLATE_KEYS) {
    if (normalizeRoleName(ROLE_TEMPLATE_LABELS_ES[key]) === normalized) return key;
  }
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
  /**
   * Tanda 8a: also run upgradeRoleTemplate on every managed template role
   * behind ROLE_TEMPLATE_VERSION (revocations + version stamp + audit).
   * Default false = the boot behaviour (additive top-up only); the CLI
   * `rbac:sync --upgrade-templates` is the only caller that sets it.
   */
  upgrade?: boolean;
  /** Who ran the upgrade (audit trail); undefined = system. */
  actorUserId?: string | null;
  /** Skip the ROLE_TEMPLATE_UPGRADED audit events (tests with an injected store). */
  audit?: boolean;
};

export type BackfillTemplateRolesResult = {
  /** Template roles that received at least one new grant in this run (adopted or topped up). */
  rolesFilled: number;
  /** "<name> (<organizationId>) ← <template>: +<granted>" per role in rolesFilled. */
  roles: string[];
  /** EMPTY roles whose name matches no template (0 permissions, left untouched — the dangerous case). */
  unmatched?: string[];
  /** Org roles following a template after this run (stored templateKey or adopted by name). */
  templateRoles?: number;
  /** Subset of templateRoles that gained grants in this run (0 once converged). */
  templateRolesToppedUp?: number;
  /** Roles whose templateKey was null and has been (dry-run: would be) stamped from the name. */
  templateKeysAssigned?: number;
  /** "<name> (<organizationId>) → <template>" per stamped role. */
  templateKeysAssignedRoles?: string[];
  /** Roles with grants and no template (name unmatched, or keys beyond the template): never touched. */
  customRoles?: string[];
  /** Platform roles that received at least one new grant in this run (0 once converged). */
  platformRolesToppedUp?: number;
  /** "<name> (<organizationId>) ← full catalog: +<granted>" per detected platform role. */
  platformRoles?: string[];
  /**
   * Tanda 8a: "<name> (<organizationId>) ← <template> v<from>→v<to>: +<added> −<revoked>" per managed
   * template role upgraded in this run (with `upgrade: true`; in dry-run, the ones that would be).
   */
  upgraded?: string[];
  /**
   * Tanda 8a: keys an upgrade WOULD revoke (or, with `upgrade`, revoked), by role id, for every
   * managed template role behind ROLE_TEMPLATE_VERSION that still holds a revoked key — filled with
   * and without `upgrade`, in dry-run too, so the boot log and `rbac:sync --dry-run` can list them.
   */
  revocationsByRole?: Record<string, PermissionKey[]>;
  /** Managed template roles still behind ROLE_TEMPLATE_VERSION after this run. */
  templateRolesBehindVersion?: number;
};

/**
 * Boot-time convergence of organization roles to their templates:
 *   1. roles with Role.templateKey → applyRoleTemplate on EVERY run (additive
 *      top-up, +0 once converged) so catalog growth reaches existing tenants;
 *   2. roles without templateKey whose name resolves to a template and that
 *      hold nothing outside it → adopted: templateKey stamped + topped up
 *      (the Faranda "Owner" rows created before the column existed);
 *   3. roles with grants that match no template, or that carry keys beyond
 *      the template their name suggests → custom, never touched;
 *   4. empty roles matching no template → reported in `unmatched` (a user
 *      assigned to one is 403 everywhere; ensureRoleHasPermissions blocks it);
 *   5. platform roles → full catalog (see below), templateKey stays null.
 *
 * Platform-role detection is deliberately conservative, because a platform key
 * (admin.tenants.manage) grants cross-tenant access:
 *   (a) the role already holds a platform key (admin.* / platform.*), or
 *   (b) its name is a platform role name AND it lives in an organization that
 *       already owns a platform-granted role (the HotelOS org) — never in a
 *       tenant org, so a hotel creating a "Super Admin" role keeps getting the
 *       org-scoped `admin` template and cannot escalate.
 * Every write is additive and idempotent: a converged role reports +0.
 */
export async function backfillTemplateRoles(options: BackfillTemplateRolesOptions = {}): Promise<BackfillTemplateRolesResult> {
  const db = options.db ?? prisma;
  const dryRun = options.dryRun === true;
  const upgrade = options.upgrade === true;
  const roles = await db.role.findMany({
    select: { id: true, name: true, organizationId: true, templateKey: true, managed: true, templateVersion: true },
    orderBy: { id: "asc" }
  });
  if (roles.length === 0) {
    return {
      rolesFilled: 0,
      roles: [],
      unmatched: [],
      templateRoles: 0,
      templateRolesToppedUp: 0,
      templateKeysAssigned: 0,
      templateKeysAssignedRoles: [],
      customRoles: [],
      platformRolesToppedUp: 0,
      platformRoles: [],
      upgraded: [],
      revocationsByRole: {},
      templateRolesBehindVersion: 0
    };
  }

  // One pass over role_permissions + permissions: the keys each role holds.
  const permissions = await db.permission.findMany({ select: { id: true, key: true } });
  const keyById = new Map(permissions.map((row) => [row.id, row.key]));
  const grants = await db.rolePermission.findMany({ select: { roleId: true, permissionId: true } });
  const keysByRole = new Map<string, Set<string>>();
  for (const grant of grants) {
    const key = keyById.get(grant.permissionId);
    let set = keysByRole.get(grant.roleId);
    if (!set) {
      set = new Set<string>();
      keysByRole.set(grant.roleId, set);
    }
    // A grant pointing at a deleted permission row still counts as "has grants"
    // (the role is not empty) but contributes no key.
    if (key !== undefined) set.add(key);
  }
  const grantCountByRole = new Map<string, number>();
  for (const grant of grants) {
    grantCountByRole.set(grant.roleId, (grantCountByRole.get(grant.roleId) ?? 0) + 1);
  }

  // (a) roles holding a platform key today; (b) the organizations they live in.
  const rolesWithPlatformGrant = new Set<string>();
  for (const [roleId, keys] of keysByRole) {
    for (const key of keys) {
      if (isPlatformPermission(key)) {
        rolesWithPlatformGrant.add(roleId);
        break;
      }
    }
  }
  const platformOrganizations = new Set(
    roles.filter((role) => rolesWithPlatformGrant.has(role.id)).map((role) => role.organizationId)
  );
  const isPlatformRole = (role: { id: string; name: string; organizationId: string }): boolean =>
    rolesWithPlatformGrant.has(role.id) || (isPlatformRoleName(role.name) && platformOrganizations.has(role.organizationId));

  const filled: string[] = [];
  const unmatched: string[] = [];
  const customRoles: string[] = [];
  const templateKeysAssignedRoles: string[] = [];
  const platformRoles: string[] = [];
  const upgraded: string[] = [];
  const revocationsByRole: Record<string, PermissionKey[]> = {};
  let templateRoles = 0;
  let templateRolesToppedUp = 0;
  let platformRolesToppedUp = 0;
  let templateRolesBehindVersion = 0;

  for (const role of roles) {
    const label = `${role.name} (${role.organizationId})`;
    if (isPlatformRole(role)) {
      const result = await applyFullCatalog(role.id, { db, dryRun });
      platformRoles.push(`${label} ← full catalog: +${result.granted}`);
      if (result.granted > 0) platformRolesToppedUp += 1;
      continue;
    }
    if (role.managed === false) {
      // Tanda 8a: a role the hotel edited by hand (PATCH /rbac/roles/:id/permissions
      // or created as custom) is never topped up nor upgraded, whatever its name.
      customRoles.push(`${label} [managed=false]`);
      continue;
    }

    const grantCount = grantCountByRole.get(role.id) ?? 0;
    const heldKeys = keysByRole.get(role.id) ?? new Set<string>();
    let templateKey: RoleKey | undefined;
    let adoptedByName = false;

    if (role.templateKey !== null) {
      if (!isRoleTemplateKey(role.templateKey)) {
        // A hand-edited template_key no template knows: do not abort the boot
        // over one row, but say it loudly — the role will never be topped up.
        console.warn(`[rbac] role ${label} carries unknown template_key "${role.templateKey}" — skipped (fix the row or set it to NULL)`);
        (grantCount > 0 ? customRoles : unmatched).push(`${label} [template_key "${role.templateKey}" unknown]`);
        continue;
      }
      templateKey = role.templateKey;
    } else {
      const byName = resolveTemplateKeyForRoleName(role.name);
      if (!byName) {
        (grantCount > 0 ? customRoles : unmatched).push(label);
        continue;
      }
      if (grantCount > 0) {
        // Provisioned before the column existed (e.g. the 4 Owners) or a custom
        // role that happens to carry a template-like name: adopt only when it
        // holds nothing outside the template — extra keys mean hand-crafted.
        // Tanda 8a: the envelope is the template PLUS the keys the current
        // version revoked, so a role converged to the previous version (the
        // 222-key Owners of v1) is still recognised; the revoked keys stay
        // until `rbac:sync --upgrade-templates` (the boot top-up never revokes).
        const template = new Set<string>([...templatePermissionKeys(byName), ...templateRevocationKeys(byName)]);
        const extra = Array.from(heldKeys).filter((key) => !template.has(key));
        if (extra.length > 0) {
          customRoles.push(`${label} [${extra.length} key(s) outside "${byName}"]`);
          continue;
        }
      }
      templateKey = byName;
      adoptedByName = true;
    }

    const result = await applyRoleTemplate(role.id, templateKey, { db, dryRun });
    templateRoles += 1;
    if (adoptedByName && result.templateKeySet) {
      templateKeysAssignedRoles.push(`${label} → ${templateKey}`);
    }
    if (result.granted > 0) {
      templateRolesToppedUp += 1;
      filled.push(`${label} ← ${templateKey}: +${result.granted}`);
    }

    // Tanda 8a: version convergence. Report what the version revokes from this
    // role; apply it only with `upgrade` (and never in dry-run).
    const fromVersion = role.templateVersion ?? 0;
    if (fromVersion < ROLE_TEMPLATE_VERSION) {
      const revocable = new Set<string>(templateRevocationKeys(templateKey));
      const wouldRevoke = Array.from(heldKeys).filter((key) => revocable.has(key)).sort() as PermissionKey[];
      if (wouldRevoke.length > 0) revocationsByRole[role.id] = wouldRevoke;
      if (upgrade) {
        if (dryRun) {
          const wouldAdd = templatePermissionKeys(templateKey).filter((key) => !heldKeys.has(key)).length;
          upgraded.push(`${label} ← ${templateKey} v${fromVersion}→v${ROLE_TEMPLATE_VERSION}: +${wouldAdd} −${wouldRevoke.length} [dry-run]`);
        } else {
          // applyRoleTemplate stamped templateKey on adopted roles, so the upgrade
          // finds the template on the row; it re-reads the grants after the top-up.
          const up = await upgradeRoleTemplate(role.id, { db, actorUserId: options.actorUserId ?? null, audit: options.audit });
          if (up.upgraded) {
            upgraded.push(`${label} ← ${templateKey} v${up.fromVersion}→v${up.toVersion}: +${up.added.length} −${up.revoked.length}`);
            revocationsByRole[role.id] = up.revoked;
            if (up.revoked.length === 0) delete revocationsByRole[role.id];
          } else {
            templateRolesBehindVersion += 1;
          }
        }
      } else {
        templateRolesBehindVersion += 1;
      }
    }
  }

  const suffix = dryRun ? " [dry-run]" : "";
  console.log(
    `[rbac] template roles: ${templateRoles} following a template (${templateRolesToppedUp} topped up${suffix}), ` +
      `${templateKeysAssignedRoles.length} template_key stamped by name, ${customRoles.length} custom (untouched), ` +
      `${unmatched.length} EMPTY without template` +
      (templateKeysAssignedRoles.length > 0 ? ` (stamped: ${templateKeysAssignedRoles.join(", ")})` : "")
  );
  const pendingRevocations = Object.keys(revocationsByRole).length;
  if (upgraded.length > 0) {
    console.log(`[rbac] template roles upgraded to v${ROLE_TEMPLATE_VERSION}${suffix}: ${upgraded.join(", ")}`);
  }
  if (!upgrade && (pendingRevocations > 0 || templateRolesBehindVersion > 0)) {
    console.warn(
      `[rbac] ${templateRolesBehindVersion} template role(s) behind template version ${ROLE_TEMPLATE_VERSION} ` +
        `(${pendingRevocations} still hold keys the version revokes; the boot top-up never revokes) — ` +
        `run rbac:sync --upgrade-templates after --dry-run and a backup (docs/runbooks/rbac-sync.md)`
    );
  }
  if (unmatched.length > 0) {
    console.warn(
      `[rbac] ${unmatched.length} role(s) hold 0 permissions and match no template — a user assigned to them is 403 everywhere: ${unmatched.join(" · ")}`
    );
  }
  if (platformRoles.length > 0) {
    console.log(
      `[rbac] platform roles topped up: ${platformRolesToppedUp} of ${platformRoles.length} platform role(s)${suffix} (${platformRoles.join(", ")})`
    );
  }
  return {
    rolesFilled: filled.length,
    roles: filled,
    unmatched,
    templateRoles,
    templateRolesToppedUp,
    templateKeysAssigned: templateKeysAssignedRoles.length,
    templateKeysAssignedRoles,
    customRoles,
    platformRolesToppedUp,
    platformRoles,
    upgraded,
    revocationsByRole,
    templateRolesBehindVersion
  };
}

/** Sanity check exposed for tests/CLI: no template (nor revocation list) may carry a platform key; every template is listed. */
export function assertTemplatesExcludePlatformKeys(): void {
  const platform = new Set<string>(PLATFORM_PERMISSION_KEYS);
  const listed = new Set<string>(ROLE_TEMPLATE_KEYS);
  for (const key of Object.keys(ROLE_PERMISSION_MAP)) {
    if (!listed.has(key)) throw new Error(`Role template "${key}" is missing from ROLE_TEMPLATE_KEYS`);
  }
  for (const key of ROLE_TEMPLATE_KEYS) {
    const leaked = [...ROLE_PERMISSION_MAP[key], ...(ROLE_TEMPLATE_REVOCATIONS[key] ?? [])].filter(
      (permission) => platform.has(permission) || isPlatformPermission(permission)
    );
    if (leaked.length > 0) {
      throw new Error(`Role template "${key}" carries platform permission(s): ${leaked.join(", ")}`);
    }
  }
}
