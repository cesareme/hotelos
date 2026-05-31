// Tenant administration service for the platform admin console.
//
// Multi-tenant management surface used by HotelOS staff (NOT individual hotel
// users) to provision new tenants (Organization + Property + owner User), list
// existing tenants with usage/health counts, inspect tenant detail and audit
// trail, regenerate temporary credentials, and toggle module entitlements.
//
// All mutating operations are gated by the `admin.tenants.manage` permission
// (cast to PermissionKey because the canonical union has not been widened yet;
// the permission is granted to platform admins via custom roles seeded outside
// the canonical RBAC catalog). Every successful action emits an AuditEvent so
// the platform admin console keeps a tamper-evident trail.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { prisma, hashPassword } from "@hotelos/database";
import type { PermissionKey } from "@hotelos/shared";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

// ────────────────────────────────────────────────────────────── permissions

// Platform-admin permission. Not part of the canonical PermissionKey union
// (tenant administration is a HotelOS-staff capability, not a hotel role), so
// we widen via cast at the single boundary where the guard is evaluated.
const TENANTS_MANAGE = ["admin.tenants.manage" as PermissionKey] as const;

function guard(context: UserContext): void {
  requirePermissions(context, [...TENANTS_MANAGE]);
}

// ────────────────────────────────────────────────────────────── types

export type TenantPlan = "starter" | "pro" | "enterprise";

export type TenantStatus = "active" | "suspended" | "trial" | "archived";

export type TenantSummary = {
  organizationId: string;
  name: string;
  legalName?: string;
  country: string;
  createdAt: string;
  status: TenantStatus;
  plan: TenantPlan;
  counts: {
    properties: number;
    users: number;
    modulesEnabled: number;
  };
  lastActivityAt?: string;
};

export type TenantPropertySummary = {
  id: string;
  name: string;
  legalName?: string;
  municipality?: string;
  province?: string;
  country: string;
  status: string;
  createdAt: string;
  modulesEnabled: number;
};

export type TenantUserSummary = {
  id: string;
  email: string;
  fullName: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt?: string;
  createdAt: string;
  roles: string[];
};

export type TenantDetail = {
  organizationId: string;
  name: string;
  legalName?: string;
  taxId?: string;
  country: string;
  createdAt: string;
  status: TenantStatus;
  plan: TenantPlan;
  properties: TenantPropertySummary[];
  users: TenantUserSummary[];
  modulesEnabled: string[];
  lastActivityAt?: string;
};

export type AuditEntry = {
  id: string;
  organizationId: string;
  propertyId?: string;
  actorUserId?: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId?: string;
  correlationId?: string;
  createdAt: string;
};

export type CreateTenantInput = {
  context: UserContext;
  organizationName: string;
  organizationCountry: string;
  property: {
    name: string;
    type: string;
    municipality?: string;
    province?: string;
  };
  ownerUser: {
    email: string;
    fullName: string;
    phone?: string;
  };
  modulesEnabled: string[];
  plan: TenantPlan;
};

export type CreateTenantResult = {
  organizationId: string;
  propertyId: string;
  ownerUserId: string;
  tempPassword: string;
  inviteLink: string;
};

// ─────────────────────────────────────────────── tenant metadata side-store
//
// The Organization model in the canonical schema has no `status`, `plan`, or
// `lastActivityAt` columns yet. Until a migration adds them, we keep a small
// in-memory side-store keyed by organizationId. This is intentional: the
// service has a stable shape today and the side-store is a clear seam to
// replace with real columns later without changing callers.

type TenantMetadata = {
  status: TenantStatus;
  plan: TenantPlan;
  modulesEnabled: Set<string>;
  lastActivityAt?: string;
};

const tenantMetadata = new Map<string, TenantMetadata>();

type TenantMetadataDefaults = {
  status?: TenantStatus;
  plan?: TenantPlan;
  modulesEnabled?: Iterable<string>;
  lastActivityAt?: string;
};

function ensureMetadata(organizationId: string, defaults?: TenantMetadataDefaults): TenantMetadata {
  let meta = tenantMetadata.get(organizationId);
  if (!meta) {
    meta = {
      status: defaults?.status ?? "active",
      plan: defaults?.plan ?? "starter",
      modulesEnabled: defaults?.modulesEnabled ? new Set<string>(defaults.modulesEnabled) : new Set<string>(),
      lastActivityAt: defaults?.lastActivityAt
    };
    tenantMetadata.set(organizationId, meta);
  }
  return meta;
}

// ──────────────────────────────────────────── invite-token side-store
//
// No InviteToken Prisma model exists in the schema today. The spec says
// "usa o crea InviteToken model si existe" — since it does not, we keep
// hashed tokens in-process with a 72h TTL. Hash-only storage means a memory
// dump cannot replay live invites. Replace with a Prisma model when one
// lands; the public function signatures will not change.

type InviteRecord = {
  tokenHash: string;
  userId: string;
  organizationId: string;
  expiresAt: number;
  usedAt?: number;
  createdAt: number;
};

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const inviteTokens: InviteRecord[] = [];

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generateInviteToken(): string {
  // 32 random bytes → 64 hex chars: 256 bits of entropy, URL-safe.
  return randomBytes(32).toString("hex");
}

function createInviteRecord(input: { userId: string; organizationId: string }): { token: string; expiresAt: number } {
  const token = generateInviteToken();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  inviteTokens.push({
    tokenHash: hashToken(token),
    userId: input.userId,
    organizationId: input.organizationId,
    expiresAt,
    createdAt: Date.now()
  });
  return { token, expiresAt };
}

function buildInviteLink(token: string): string {
  const base = process.env.APP_BASE_URL?.trim() || "https://app.hotelos.local";
  return `${base.replace(/\/+$/, "")}/accept-invite?token=${token}`;
}

// ─────────────────────────────────────────────────────────── password gen

const PASSWORD_LENGTH = 16;
const PWD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I, O to avoid confusion
const PWD_LOWER = "abcdefghijkmnpqrstuvwxyz"; // omit l, o
const PWD_DIGIT = "23456789"; // omit 0, 1
const PWD_SPECIAL = "!@#$%^&*-_=+";

function pickChar(alphabet: string): string {
  return alphabet[randomInt(0, alphabet.length)] ?? alphabet[0]!;
}

function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// Generates a 16-character temporary password with at least one upper, lower,
// digit and special character — satisfies assertPasswordPolicy without relying
// on the caller to provide one.
function generateTempPassword(): string {
  const required = [pickChar(PWD_UPPER), pickChar(PWD_LOWER), pickChar(PWD_DIGIT), pickChar(PWD_SPECIAL)];
  const pool = PWD_UPPER + PWD_LOWER + PWD_DIGIT + PWD_SPECIAL;
  const rest: string[] = [];
  for (let i = required.length; i < PASSWORD_LENGTH; i += 1) {
    rest.push(pickChar(pool));
  }
  return shuffle([...required, ...rest]).join("");
}

// ───────────────────────────────────────────────────────────── helpers

function mapTenantSummary(input: {
  organization: { id: string; name: string; legalName: string | null; country: string; createdAt: Date };
  propertyCount: number;
  userCount: number;
  meta: TenantMetadata;
}): TenantSummary {
  return {
    organizationId: input.organization.id,
    name: input.organization.name,
    legalName: input.organization.legalName ?? undefined,
    country: input.organization.country,
    createdAt: input.organization.createdAt.toISOString(),
    status: input.meta.status,
    plan: input.meta.plan,
    counts: {
      properties: input.propertyCount,
      users: input.userCount,
      modulesEnabled: input.meta.modulesEnabled.size
    },
    lastActivityAt: input.meta.lastActivityAt
  };
}

async function computeLastActivity(organizationId: string): Promise<string | undefined> {
  // Prefer the most recent audit event for the organization; fall back to the
  // most recent user login if no audit rows exist yet.
  const lastAudit = await prisma.auditEvent.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });
  if (lastAudit) {
    return lastAudit.createdAt.toISOString();
  }
  const lastLogin = await prisma.user.findFirst({
    where: { organizationId, lastLoginAt: { not: null } },
    orderBy: { lastLoginAt: "desc" },
    select: { lastLoginAt: true }
  });
  return lastLogin?.lastLoginAt?.toISOString();
}

// ──────────────────────────────────────────────────────────── listTenants

export async function listTenants(input: { context: UserContext }): Promise<TenantSummary[]> {
  const { context } = input;
  if (context) {
    guard(context);
  }
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "desc" }
  });
  if (organizations.length === 0) return [];

  const orgIds = organizations.map((org) => org.id);
  const [propertyGroups, userGroups] = await Promise.all([
    prisma.property.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds } },
      _count: { _all: true }
    }),
    prisma.user.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds } },
      _count: { _all: true }
    })
  ]);

  const propertyCountById = new Map<string, number>();
  for (const row of propertyGroups) {
    propertyCountById.set(row.organizationId, row._count._all);
  }
  const userCountById = new Map<string, number>();
  for (const row of userGroups) {
    userCountById.set(row.organizationId, row._count._all);
  }

  // Hydrate lastActivityAt in parallel so the list view shows freshness data.
  const lastActivities = await Promise.all(organizations.map((org) => computeLastActivity(org.id)));

  return organizations.map((org, index) => {
    const meta = ensureMetadata(org.id);
    if (lastActivities[index]) {
      meta.lastActivityAt = lastActivities[index];
    }
    return mapTenantSummary({
      organization: org,
      propertyCount: propertyCountById.get(org.id) ?? 0,
      userCount: userCountById.get(org.id) ?? 0,
      meta
    });
  });
}

// ────────────────────────────────────────────────────────── getTenantDetail

export async function getTenantDetail(input: { context: UserContext; orgId: string }): Promise<TenantDetail> {
  const { context, orgId } = input;
  if (context) {
    guard(context);
  }
  const organization = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!organization) {
    throw new NotFoundError(`Tenant not found: ${orgId}`);
  }

  const [properties, users] = await Promise.all([
    prisma.property.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } }),
    prisma.user.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } })
  ]);

  // The Prisma schema doesn't declare explicit relations on the join models
  // (PropertyModule, UserPropertyRole), so we issue scoped follow-up queries
  // using the property ids we already loaded.
  const propertyIds = properties.map((p) => p.id);
  const [propertyModules, userPropertyRoles] = await Promise.all([
    propertyIds.length === 0
      ? Promise.resolve([] as Array<{ propertyId: string; moduleId: string; status: string }>)
      : prisma.propertyModule.findMany({
          where: { propertyId: { in: propertyIds }, status: "enabled" },
          select: { propertyId: true, moduleId: true, status: true }
        }),
    propertyIds.length === 0
      ? Promise.resolve([] as Array<{ userId: string; roleId: string; propertyId: string }>)
      : prisma.userPropertyRole.findMany({
          where: { propertyId: { in: propertyIds } },
          select: { userId: true, roleId: true, propertyId: true }
        })
  ]);

  const moduleIds = Array.from(new Set(propertyModules.map((pm) => pm.moduleId)));
  const roleIds = Array.from(new Set(userPropertyRoles.map((upr) => upr.roleId)));
  const [moduleRows, roleRows] = await Promise.all([
    moduleIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; code: string }>)
      : prisma.module.findMany({ where: { id: { in: moduleIds } }, select: { id: true, code: true } }),
    roleIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; name: string }>)
      : prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } })
  ]);
  const moduleCodeById = new Map(moduleRows.map((m) => [m.id, m.code]));
  const roleNameById = new Map(roleRows.map((r) => [r.id, r.name]));

  const modulesByProperty = new Map<string, number>();
  const enabledModuleCodes = new Set<string>();
  for (const pm of propertyModules) {
    modulesByProperty.set(pm.propertyId, (modulesByProperty.get(pm.propertyId) ?? 0) + 1);
    const code = moduleCodeById.get(pm.moduleId);
    if (code) enabledModuleCodes.add(code);
  }

  const rolesByUser = new Map<string, Set<string>>();
  for (const upr of userPropertyRoles) {
    const set = rolesByUser.get(upr.userId) ?? new Set<string>();
    const name = roleNameById.get(upr.roleId);
    if (name) set.add(name);
    rolesByUser.set(upr.userId, set);
  }

  const meta = ensureMetadata(orgId);
  // Side-store modules win if present (set explicitly via toggleTenantModule),
  // otherwise hydrate from the persisted PropertyModule rows so the detail is
  // accurate even when the in-memory state is fresh.
  if (meta.modulesEnabled.size === 0 && enabledModuleCodes.size > 0) {
    for (const code of enabledModuleCodes) meta.modulesEnabled.add(code);
  }
  const lastActivityAt = await computeLastActivity(orgId);
  if (lastActivityAt) meta.lastActivityAt = lastActivityAt;

  return {
    organizationId: organization.id,
    name: organization.name,
    legalName: organization.legalName ?? undefined,
    taxId: organization.taxId ?? undefined,
    country: organization.country,
    createdAt: organization.createdAt.toISOString(),
    status: meta.status,
    plan: meta.plan,
    properties: properties.map((property) => ({
      id: property.id,
      name: property.name,
      legalName: property.legalName ?? undefined,
      municipality: property.municipality ?? undefined,
      province: property.province ?? undefined,
      country: property.country,
      status: property.status,
      createdAt: property.createdAt.toISOString(),
      modulesEnabled: modulesByProperty.get(property.id) ?? 0
    })),
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      lastLoginAt: user.lastLoginAt?.toISOString(),
      createdAt: user.createdAt.toISOString(),
      roles: Array.from(rolesByUser.get(user.id) ?? new Set<string>())
    })),
    modulesEnabled: Array.from(meta.modulesEnabled),
    lastActivityAt: meta.lastActivityAt
  };
}

// ──────────────────────────────────────────────────────────── createTenant

export async function createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
  guard(input.context);

  const organizationName = input.organizationName?.trim();
  if (!organizationName) {
    throw new BadRequestError("organizationName is required.");
  }
  const propertyName = input.property?.name?.trim();
  if (!propertyName) {
    throw new BadRequestError("property.name is required.");
  }
  const ownerEmail = input.ownerUser?.email?.toLowerCase().trim();
  if (!ownerEmail || !ownerEmail.includes("@")) {
    throw new BadRequestError("ownerUser.email is required and must be valid.");
  }
  const ownerFullName = input.ownerUser?.fullName?.trim();
  if (!ownerFullName) {
    throw new BadRequestError("ownerUser.fullName is required.");
  }

  const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (existingUser) {
    throw new ConflictError(`A user with email ${ownerEmail} already exists.`);
  }

  const tempPassword = generateTempPassword();
  const passwordHash = hashPassword(tempPassword);
  const country = input.organizationCountry?.trim() || "ES";

  const persisted = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: organizationName,
        country
      }
    });

    const property = await tx.property.create({
      data: {
        organizationId: organization.id,
        name: propertyName,
        municipality: input.property.municipality?.trim() || null,
        province: input.property.province?.trim() || null,
        country
      }
    });

    // Owner role per organization; permissions are seeded via the bootstrap /
    // role-management surface — here we ensure the role exists so the owner
    // user has a stable role assignment.
    const ownerRole = await tx.role.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: "Owner" } },
      update: {},
      create: { organizationId: organization.id, name: "Owner" }
    });

    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: ownerEmail,
        fullName: ownerFullName,
        phone: input.ownerUser.phone?.trim() || null,
        passwordHash,
        // Force-change on next login: leave passwordChangedAt null so a
        // session middleware can detect "temp password, must rotate".
        passwordChangedAt: null,
        status: "active"
      }
    });

    await tx.userPropertyRole.create({
      data: {
        userId: user.id,
        propertyId: property.id,
        roleId: ownerRole.id
      }
    });

    // Default department + assignment so the owner is on the org chart.
    const department = await tx.department.upsert({
      where: { propertyId_code: { propertyId: property.id, code: "MGMT" } },
      update: {},
      create: { propertyId: property.id, code: "MGMT", name: "Management" }
    });
    await tx.userDepartment.upsert({
      where: { userId_departmentId: { userId: user.id, departmentId: department.id } },
      update: { roleLabel: "owner", active: true },
      create: { userId: user.id, departmentId: department.id, roleLabel: "owner", active: true }
    });

    return { organization, property, user };
  });

  // Seed module entitlements (best-effort: any unknown moduleCode is skipped
  // rather than failing the entire creation flow).
  for (const moduleCode of input.modulesEnabled) {
    const moduleRow = await prisma.module.findUnique({ where: { code: moduleCode } });
    if (!moduleRow) continue;
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId: persisted.property.id, moduleId: moduleRow.id } },
      update: { status: "enabled", enabledAt: new Date(), disabledAt: null },
      create: {
        propertyId: persisted.property.id,
        moduleId: moduleRow.id,
        status: "enabled",
        enabledAt: new Date()
      }
    });
  }

  // Seed tenant metadata.
  const meta = ensureMetadata(persisted.organization.id, {
    status: "active",
    plan: input.plan,
    modulesEnabled: input.modulesEnabled
  });
  meta.plan = input.plan;
  for (const code of input.modulesEnabled) meta.modulesEnabled.add(code);
  meta.lastActivityAt = new Date().toISOString();

  // Mint a single-use invite link (72h TTL, hash-only storage).
  const invite = createInviteRecord({ userId: persisted.user.id, organizationId: persisted.organization.id });
  const inviteLink = buildInviteLink(invite.token);

  recordAuditEvent({
    organizationId: persisted.organization.id,
    propertyId: persisted.property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "TENANT_CREATED",
    entityType: "organization",
    entityId: persisted.organization.id,
    afterJson: {
      organizationName,
      propertyName,
      propertyType: input.property.type,
      ownerEmail,
      plan: input.plan,
      modulesEnabled: input.modulesEnabled,
      inviteExpiresAt: new Date(invite.expiresAt).toISOString()
    }
  });

  return {
    organizationId: persisted.organization.id,
    propertyId: persisted.property.id,
    ownerUserId: persisted.user.id,
    tempPassword,
    inviteLink
  };
}

// ───────────────────────────────────────────────────── regenerateTempPassword

export async function regenerateTempPassword(input: {
  context: UserContext;
  userId: string;
}): Promise<{ newPassword: string }> {
  const { context, userId } = input;
  if (context) {
    guard(context);
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError(`User not found: ${userId}`);
  }
  const newPassword = generateTempPassword();
  const passwordHash = hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      // Null passwordChangedAt forces a change-on-next-login: any session
      // middleware that inspects this field knows the temp credential is
      // not a long-lived password.
      passwordChangedAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null
    }
  });

  recordAuditEvent({
    organizationId: user.organizationId,
    actorUserId: context?.userId,
    actorType: context ? "user" : "system",
    action: "TENANT_USER_TEMP_PASSWORD_REGENERATED",
    entityType: "user",
    entityId: user.id,
    afterJson: { forcedChangeOnNextLogin: true }
  });

  return { newPassword };
}

// ──────────────────────────────────────────────────────── toggleTenantModule

export async function toggleTenantModule(input: {
  context: UserContext;
  orgId: string;
  moduleCode: string;
  enabled: boolean;
}): Promise<{ ok: true }> {
  const { context, orgId, moduleCode, enabled } = input;
  if (context) {
    guard(context);
  }
  const organization = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!organization) {
    throw new NotFoundError(`Tenant not found: ${orgId}`);
  }
  const moduleRow = await prisma.module.findUnique({ where: { code: moduleCode } });
  if (!moduleRow) {
    throw new NotFoundError(`Module not found: ${moduleCode}`);
  }
  const properties = await prisma.property.findMany({
    where: { organizationId: orgId },
    select: { id: true }
  });

  // Apply the toggle to every property under the tenant. Module enablement at
  // the organization level is the platform-admin view; per-property overrides
  // are reserved for the in-tenant module management UI.
  const now = new Date();
  for (const property of properties) {
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId: property.id, moduleId: moduleRow.id } },
      update: enabled
        ? { status: "enabled", enabledAt: now, disabledAt: null }
        : { status: "disabled", disabledAt: now },
      create: {
        propertyId: property.id,
        moduleId: moduleRow.id,
        status: enabled ? "enabled" : "disabled",
        enabledAt: enabled ? now : null,
        disabledAt: enabled ? null : now
      }
    });
  }

  const meta = ensureMetadata(orgId);
  if (enabled) {
    meta.modulesEnabled.add(moduleCode);
  } else {
    meta.modulesEnabled.delete(moduleCode);
  }
  meta.lastActivityAt = now.toISOString();

  recordAuditEvent({
    organizationId: orgId,
    actorUserId: context?.userId,
    actorType: context ? "user" : "system",
    action: enabled ? "TENANT_MODULE_ENABLED" : "TENANT_MODULE_DISABLED",
    entityType: "organization",
    entityId: orgId,
    afterJson: { moduleCode, enabled, propertiesAffected: properties.length }
  });

  return { ok: true };
}

// ────────────────────────────────────────────────────────── getTenantAuditLog

export async function getTenantAuditLog(input: {
  context: UserContext;
  orgId: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const { context, orgId } = input;
  const limit = input.limit ?? 50;
  if (context) {
    guard(context);
  }
  const organization = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!organization) {
    throw new NotFoundError(`Tenant not found: ${orgId}`);
  }
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = await prisma.auditEvent.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: safeLimit
  });
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: row.actorUserId ?? undefined,
    actorType: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    createdAt: row.createdAt.toISOString()
  }));
}
